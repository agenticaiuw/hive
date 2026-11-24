//! Hive's HTTP API: the dashboard, nodes, the extension, Claude Code and made-on-demand sites all come through here.
use crate::args;
use crate::db::now;
use crate::hive::Hive;
use crate::http::{Req, Res};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const DASHBOARD: &str = include_str!("../../dashboard/index.html");
const ICON: &[u8] = include_bytes!("../../dashboard/icon.png");
/// Lets a phone keep the dashboard on its home screen as the Hive app.
const MANIFEST: &str = r##"{"name":"Hive","short_name":"Hive","start_url":"./","display":"standalone","background_color":"#161412","theme_color":"#161412","icons":[{"src":"icon.png","sizes":"180x180","type":"image/png"}]}"##;

fn s(v: &Value) -> String { v.as_str().map(String::from).unwrap_or_default() }
pub fn hash(t: &str) -> String { Sha256::digest(t.as_bytes()).iter().map(|b| format!("{b:02x}")).collect() }
pub fn random(n: usize) -> String {
    let mut b = vec![0u8; n];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut b).ok();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn token(req: &Req) -> String {
    req.headers.get("authorization").and_then(|a| a.strip_prefix("Bearer ")).map(String::from)
        .or_else(|| req.cookie("hive")).unwrap_or_else(|| req.q("key").to_string())
}

fn valid(hive: &Hive, t: &str) -> bool {
    !t.is_empty() && hive.db.get("select 1 from tokens where hash=?", args!(hash(t))).is_some()
}
fn authed(hive: &Hive, req: &Req) -> bool { valid(hive, &token(req)) }

/// Whether a request is the owner's own: from one of their devices on their Tailscale account (the tailnet helper, on this
/// computer, says so and drops any such header a device sends), or from a browser on this computer itself. Either way it
/// must name this Hive Server, so a web page whose own name was pointed here (DNS rebinding) is never signed in.
fn owners(hive: &Hive, req: &Req) -> bool {
    let host = req.headers.get("host").map(String::as_str).unwrap_or("");
    let (name, port) = match host.strip_prefix('[') {
        Some(v6) => v6.split_once(']').map(|(n, p)| (n, p.trim_start_matches(':'))).unwrap_or((v6, "")),
        None => host.split_once(':').unwrap_or((host, "")),
    };
    let name = name.to_ascii_lowercase();
    if !req.peer.starts_with("127.0.0.1") { return false }
    if req.headers.contains_key("x-forwarded-for") {
        // Through the helper: this server's MagicDNS name, or its tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48).
        let ours = crate::tailnet::address(&hive.state).is_some_and(|a| a.trim_start_matches("http://").trim_end_matches('/').eq_ignore_ascii_case(&name))
            || name.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1]))
            || name.parse::<std::net::Ipv6Addr>().is_ok_and(|ip| ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0]);
        ours && (port.is_empty() || port == "80") && req.headers.get("x-hive-tailnet-owner").is_some_and(|v| v == "1")
    } else {
        // Made on this computer, at this Hive's own local address.
        ["127.0.0.1", "localhost", "::1"].contains(&name.as_str()) && hive.local.rsplit(':').next() == Some(port)
    }
}

fn new_token(hive: &Hive, node: &str) -> String {
    let t = random(24);
    hive.db.run("insert into tokens(hash, node, at) values(?,?,?)", args!(hash(&t), node, now()));
    t
}

/// Hive Phone's link to this Hive Server: its WebSocket address and the phone's key (made once).
fn phone_pairing(hive: &Arc<Hive>) -> Result<(String, String), Res> {
    let address = crate::tailnet::address(&hive.state).ok_or_else(|| Res::err(409, "Hive Server has no address yet; try again in a minute."))?;
    let file = hive.state.join("phone-token");
    let key = std::fs::read_to_string(&file).ok().filter(|k| k.len() >= 40).unwrap_or_else(|| { let k = random(32); crate::private(&file, &k); k });
    hive.start_phone();
    Ok((format!("{}/phone/device", address.replacen("http://", "ws://", 1)), key))
}

fn developer_identity(hive: &Hive, device: &str) -> Res {
    match hive_phone::bootstrap::load(&hive.state, device) {
        Ok(Some(bytes)) => Res::new(200, "application/x-plist", bytes).header("Cache-Control", "no-store"),
        Ok(None) => Res::err(404, "No saved pairing identity for this iPhone."),
        Err(e) => Res::err(400, e),
    }
}

pub fn handle(hive: &Arc<Hive>, req: Req) -> Res {
    let parts: Vec<&str> = req.path.trim_matches('/').split('/').collect();
    let m = req.method.as_str();
    match (m, parts.as_slice()) {
        ("GET", [""]) => return Res::new(200, "text/html; charset=utf-8", DASHBOARD),
        ("GET", ["icon.png"]) => return Res::new(200, "image/png", ICON),
        ("GET", ["manifest.json"]) => return Res::new(200, "application/manifest+json", MANIFEST),
        ("GET", ["health"]) => return Res::json(&json!({ "ok": true, "version": hive.version })),
        // The dashboard signs in the owner's own devices and this computer by itself. Hive is plain HTTP (WireGuard encrypts
        // it inside the tailnet), so the cookie isn't Secure.
        ("POST", ["api", "login"]) => {
            if !owners(hive, &req) { return Res::err(403, "Open your dashboard on a device signed in to your Tailscale account, or on your Hive Server itself."); }
            let t = new_token(hive, "dashboard");
            return Res::json(&json!({ "ok": true })).header("Set-Cookie", &format!("hive={t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"));
        }
        // A phone can restore its Apple pairing identity using its own Hive key.
        ("GET", ["phone", "bootstrap", device]) => {
            let key = std::fs::read_to_string(hive.state.join("phone-token")).unwrap_or_default();
            if key.is_empty() || token(&req) != key { return Res::err(401, "This isn't the iPhone's key: Hive on the iPhone joins again through Tailscale."); }
            return developer_identity(hive, device);
        }
        // Hive Phone's WebSocket (phone/), with the phone's own key.
        ("GET", ["phone", "device"]) => {
            let key = std::fs::read_to_string(hive.state.join("phone-token")).unwrap_or_default();
            if key.is_empty() || token(&req) != key { return Res::err(401, "This isn't the iPhone's key: Hive on the iPhone joins again through Tailscale."); }
            let accept = hive_phone::accept(req.headers.get("sec-websocket-key").map(String::as_str).unwrap_or(""));
            let mut res = Res::new(101, "", "").header("Upgrade", "websocket").header("Connection", "Upgrade").header("Sec-WebSocket-Accept", &accept);
            let version = req.headers.get("x-hive-version").cloned().unwrap_or_default();
            res.upgrade = Some(Box::new(move |conn| hive_phone::device(conn, version)));
            return res;
        }
        // A Claude Code agent's tools (claude.rs), over MCP: the secret in the path is the agent's own, so it signs it in.
        ("POST", ["mcp", t]) => return match hive.mcp(t, &req.json()) {
            Err(e) => Res::err(404, &e),
            Ok(Some(v)) => Res::json(&v),
            Ok(None) => Res::new(202, "application/json", ""),
        },
        // Hive opens no event streams, which MCP asks a server to say this way.
        ("GET" | "DELETE", ["mcp", _]) => return Res::new(405, "application/json", "").header("Allow", "POST"),
        // The owner's own devices join through Tailscale: signed in to the same Tailscale account as this Hive Server.
        ("POST", ["api", "pair", "tailnet"] | ["api", "phone", "tailnet"]) => {
            if !owners(hive, &req) { return Res::err(403, "Only your own devices, signed in to the same Tailscale account as your Hive Server, can join it."); }
            if parts[1] == "phone" { return phone_pairing(hive).map(|(url, token)| Res::json(&json!({ "url": url, "token": token }))).unwrap_or_else(|e| e) }
            let b = req.json();
            return Res::json(&json!({ "token": new_token(hive, &format!("{}:{}", s(&b["kind"]), s(&b["name"]))) }));
        }
        _ => {}
    }
    if !authed(hive, &req) { return Res::err(401, "Sign in to Hive first."); }
    let b = req.json();
    let id = |i: usize| parts.get(i).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    match (m, parts.as_slice()) {
        ("GET", ["api", "me"]) => Res::json(&json!({ "ok": true, "version": hive.version })),
        ("POST", ["api", "requests"]) => {
            let text = s(&b["text"]);
            if text.trim().is_empty() { return Res::err(400, "Say what you want."); }
            let rid = hive.db.run("insert into requests(at, node, agent, text, context) values(?,?,?,?,?)",
                args!(now(), s(&b["node"]), s(&b["agent"]), text, b["context"].clone()));
            hive.log(0, 0, rid, &format!("owner via {}", s(&b["node"])), &text);
            hive.bump();
            if req.q("wait") != "1" { return Res::json(&json!({ "id": rid })); }
            hive.wait_until(170_000, || hive.db.get("select * from requests where id=? and status not in ('new','planning')", args!(rid)));
            let r = hive.db.get("select * from requests where id=?", args!(rid)).unwrap_or(json!({}));
            // The tasks it went to: new ones, and open ones whose agent got it as a message.
            let tasks = hive.db.all("select id, title, quote, status from tasks where request_id=?1
                or id in (select task_id from log where request_id=?1 and task_id>0 and who='owner')", args!(rid));
            let ctx = &b["context"];
            let rules = rules_for(hive, &[s(&b["node"])], &s(&ctx["site"]), &s(&ctx["app"]), &s(&ctx["folder"]));
            Res::json(&json!({ "id": rid, "status": r["status"], "reply": r["reply"], "tasks": tasks, "rules": rules }))
        }
        ("GET", ["api", "state"]) => Res::json(&json!({
            "version": hive.version,
            "tasks": hive.db.all("select * from tasks where status in ('open','working','needs') order by id desc", &[]),
            "agents": hive.db.all("select a.*, t.title from agents a left join tasks t on t.id=a.task_id where a.status in ('working','idle') and t.status in ('working','needs') order by a.id desc", &[]),
            "nodes": hive.db.all("select id, kind, name, seen, version from nodes order by seen desc", &[]),
            "requests": hive.db.all("select * from requests order by id desc limit 30", &[]),
            "locks": hive.locks(),
            "now": now(),
        })),
        ("GET", ["api", "tasks"]) => {
            let st = if req.q("status").is_empty() { "done" } else { req.q("status") };
            Res::json(&json!(hive.db.all("select * from tasks where status=? order by updated desc limit 200", args!(st))))
        }
        ("GET", ["api", "tasks", _]) => Res::json(&json!({
            "task": hive.db.get("select * from tasks where id=?", args!(id(2))),
            "log": hive.db.all("select * from log where (task_id=?1 or (task_id=0 and request_id=(select request_id from tasks where id=?1) and request_id>0)) and id > ?2 order by id limit 2000", args!(id(2), req.q("after").parse::<i64>().unwrap_or(0))),
        })),
        ("POST", ["api", "tasks"]) => Res::json(&json!({ "id": hive.add_task(b["request"].as_i64().unwrap_or(0), &b) })),
        ("POST", ["api", "tasks", _, "message"]) => match hive.message_task(id(2), 0, &s(&b["text"]), "owner") {
            Ok(()) => Res::json(&json!({ "ok": true })),
            Err(e) => Res::err(409, &e),
        },
        ("POST", ["api", "tasks", _, "end"]) => match hive.end_task(id(2), &b) {
            Ok(()) => Res::json(&json!({ "ok": true })),
            Err(e) => Res::err(400, &e),
        },
        ("POST", ["api", "tasks", _, "drop"]) => { hive.drop_task(id(2)); Res::json(&json!({ "ok": true })) }
        ("GET", ["api", "log"]) => Res::json(&json!(hive.db.all(
            "select * from log where id > ? and (?=0 or request_id=?) order by id desc limit ?",
            args!(req.q("after").parse::<i64>().unwrap_or(0), id_q(&req, "request"), id_q(&req, "request"), req.q("limit").parse::<i64>().unwrap_or(300))))),
        ("GET", ["api", "rules"]) => {
            if req.q("site").is_empty() && req.q("folder").is_empty() && req.q("app").is_empty() && req.q("node").is_empty() {
                Res::json(&json!(hive.db.all("select * from rules where active=1 order by id", &[])))
            } else {
                Res::json(&json!(rules_for(hive, &[req.q("node").to_string()], req.q("site"), req.q("app"), req.q("folder"))))
            }
        }
        ("GET", ["api", "phone", "bootstrap", device]) => developer_identity(hive, device),
        ("POST", ["api", "phone", "bootstrap", device]) => {
            match hive_phone::bootstrap::save(&hive.state, device, &req.body) {
                Ok(()) => match phone_pairing(hive) {
                    Ok((url, token)) => Res::json(&json!({ "url": url, "token": token, "developerDevice": device })).header("Cache-Control", "no-store"),
                    Err(e) => e,
                },
                Err(e) => Res::err(409, e),
            }
        }
        ("GET", ["api", "phone"]) => Res::json(&hive_phone::status(&hive.state)),
        ("POST", ["api", "phone", "passcode"]) => match hive_phone::save_passcode(&hive.state, &s(&b["passcode"])) {
            Ok(()) => Res::json(&hive_phone::status(&hive.state)),
            Err(e) => Res::err(409, &e),
        },
        ("POST", ["api", "rules"]) => match hive.add_rule(&s(&b["text"]), &s(&b["quote"]), &s(&b["scope"])) {
            Ok(rid) => Res::json(&json!({ "id": rid })),
            Err(e) => Res::err(400, &e),
        },
        ("DELETE", ["api", "nodes", node]) => {
            hive.db.run("delete from tokens where node=?", args!(node));
            hive.db.run("delete from nodes where id=?", args!(node));
            hive.bump();
            Res::json(&json!({ "ok": true }))
        }
        ("DELETE", ["api", "rules", _]) => { hive.db.run("update rules set active=0 where id=?", args!(id(2))); hive.bump(); Res::json(&json!({ "ok": true })) }
        ("GET", ["api", "info"]) => Res::json(&json!(hive.db.all("select * from info order by key", &[]))),
        ("POST", ["api", "info"]) => {
            hive.db.run("insert into info(key, value, updated) values(?,?,?) on conflict(key) do update set value=excluded.value, updated=excluded.updated", args!(s(&b["key"]), s(&b["value"]), now()));
            Res::json(&json!({ "ok": true }))
        }
        ("GET", ["api", "files"]) => Res::json(&json!(hive.db.all("select * from files order by id desc limit 500", &[]))),
        ("POST", ["api", "files"]) => {
            let name = if req.q("name").is_empty() { "upload" } else { req.q("name") };
            let path = hive.save_file(name, &req.body, if req.q("node").is_empty() { "dashboard" } else { req.q("node") });
            Res::json(&json!({ "path": path.to_string_lossy() }))
        }
        ("GET", ["api", "files", _]) => match hive.db.get("select * from files where id=?", args!(id(2))) {
            Some(f) => match std::fs::read(hive.state.join("files").join(format!("{}-{}", id(2), s(&f["name"])))) {
                Ok(data) => Res::new(200, mime(&s(&f["name"])), data).header("Content-Disposition", &format!("inline; filename=\"{}\"", s(&f["name"]))),
                Err(_) => Res::err(404, "that file is gone"),
            },
            None => Res::err(404, "no such file"),
        },
        ("GET", ["api", "db"]) => Res::json(&json!(hive.db.tables().iter().map(|t| {
            let n = hive.db.get(&format!("select count(*) n from {t}"), &[]).map(|r| r["n"].clone()).unwrap_or(json!(0));
            json!({ "table": t, "rows": n })
        }).collect::<Vec<_>>())),
        ("GET", ["api", "db", table]) => {
            if !hive.db.tables().iter().any(|t| t == table) || *table == "tokens" { return Res::err(404, "no such table"); }
            Res::json(&json!(hive.db.all(&format!("select * from {table} order by rowid desc limit ? offset ?"),
                args!(req.q("limit").parse::<i64>().unwrap_or(100), req.q("offset").parse::<i64>().unwrap_or(0)))))
        }
        ("GET", ["api", "tools"]) => Res::json(&json!([json!({ "node": "cloud", "tools": crate::tools::cloud(&["hive".into()]) })].into_iter()
            .chain(hive.db.all("select id, kind, name, tools from nodes order by kind", &[]).into_iter()
                .map(|n| json!({ "node": format!("{} ({})", s(&n["kind"]), s(&n["name"])), "tools": serde_json::from_str::<Value>(&s(&n["tools"])).unwrap_or(json!([])) })))
            .collect::<Vec<_>>())),
        ("GET", ["api", "vm", "screen"]) => match crate::vm::screen() {
            Some(png) => Res::new(200, "image/png", png),
            None => Res::err(404, "The VM's screen isn't running."),
        },
        ("POST", ["api", "node", "hello"]) => {
            let nid = s(&b["id"]);
            // The same device under an id it no longer uses (it joined again) goes once it's been quiet for an hour.
            hive.db.run("delete from nodes where kind=? and name=? and id!=? and seen < ?", args!(s(&b["kind"]), s(&b["name"]), nid.clone(), now() - 3_600_000));
            hive.db.run("insert into nodes(id, kind, name, notes, tools, seen, version) values(?,?,?,?,?,?,?) on conflict(id) do update set \
                kind=excluded.kind, name=excluded.name, notes=excluded.notes, tools=excluded.tools, seen=excluded.seen, version=excluded.version",
                args!(nid, s(&b["kind"]), s(&b["name"]), s(&b["notes"]), b["tools"].clone(), now(), s(&b["version"])));
            // Bind a device token to its own node before allowing it to receive credentials.
            let th = hash(&token(&req));
            let label = format!("{}:{}", s(&b["kind"]), s(&b["name"]));
            if hive.db.get("select 1 from tokens where hash=? and node=?", args!(th.clone(), label)).is_some() {
                hive.db.run("insert into node_tokens(node, hash) values(?,?) on conflict(node) do update set hash=excluded.hash", args!(nid, th));
            }
            hive.bump();
            Res::json(&json!({ "ok": true, "version": hive_protocol::DEVICES }))
        }
        ("GET", ["api", "node", "next"]) => {
            let nid = req.q("id").to_string();
            hive.db.run("update nodes set seen=? where id=?", args!(now(), nid));
            let call = hive.wait_until(25_000, || {
                let c = hive.db.get("select c.id, c.tool, c.args, t.id as task, t.title from calls c left join agents a on a.id=c.agent_id \
                    left join tasks t on t.id=a.task_id where c.node=? and c.status='queued' order by c.id limit 1", args!(nid))?;
                hive.db.run("update calls set status='sent' where id=?", args!(c["id"].clone()));
                Some(c)
            });
            hive.db.run("update nodes set seen=? where id=?", args!(now(), nid));
            match call {
                Some(c) => {
                    let mut a = serde_json::from_str::<Value>(&s(&c["args"])).unwrap_or(json!({}));
                    let tool = s(&c["tool"]);
                    // The owner sees which task is asking for their Mac, and follows its log while it has it.
                    if tool.ends_with("_take_over") { a["task"] = json!({ "id": c["task"], "title": c["title"] }); }
                    if matches!(tool.as_str(), "browser_type_password" | "mac_type_password" | "windows_type_password") {
                        // The database holds only the site and username. Resolve the secret at delivery,
                        // and only for the device token that registered this node.
                        let authorized = hive.db.get("select 1 from node_tokens where node=? and hash=?", args!(nid, hash(&token(&req)))).is_some();
                        let login = if authorized { crate::cred::pick(&s(&a["site"]), &s(&a["username"])) }
                            else { Err("This device token is not bound to the requested node.".into()) };
                        match login {
                            Ok(login) => a["password"] = login["password"].clone(),
                            Err(e) => a["credential_error"] = json!(e),
                        }
                    }
                    Res::json(&json!({ "id": c["id"], "tool": c["tool"], "args": a }))
                },
                None => Res::new(204, "application/json", ""),
            }
        }
        ("POST", ["api", "node", "result"]) => {
            hive.db.run("update calls set status='done', result=? where id=?", args!(b["result"].to_string(), b["id"].as_i64().unwrap_or(0)));
            hive.bump();
            Res::json(&json!({ "ok": true }))
        }
        ("GET", ["api", "inbox"]) => {
            let agent = hive.db.get("select id from agents where kind='claude' and name=?", args!(format!("claude:{}", req.q("session")))).and_then(|r| r["id"].as_i64()).unwrap_or(0);
            let rows = hive.db.all("select * from inbox where agent_id=? and seen=0 order by id", args!(agent));
            hive.db.run("update inbox set seen=1 where agent_id=?", args!(agent));
            let tasks = hive.db.all("select id, title, status from tasks where agent_id=? and status in ('working','needs')", args!(agent));
            Res::json(&json!({ "messages": rows, "tasks": tasks }))
        }
        ("POST", ["api", "reinstall"]) => match hive.repo.as_ref().ok_or("Hive isn't on a VM here".to_string()).and_then(|r| crate::vm::reinstall(r)) { Ok(v) => Res::json(&v), Err(e) => Res::err(500, &e) },
        ("GET", ["api", "sites", name, "data"]) => Res::new(200, "application/json",
            std::fs::read(hive.state.join("sites").join(clean(name)).join("data.json")).unwrap_or(b"{}".to_vec())),
        ("PUT", ["api", "sites", name, "data"]) => {
            let dir = hive.state.join("sites").join(clean(name));
            std::fs::create_dir_all(&dir).ok();
            std::fs::write(dir.join("data.json"), &req.body).ok();
            Res::json(&json!({ "ok": true }))
        }
        ("GET", ["sites", name, rest @ ..]) => {
            let mut path = hive.state.join("sites").join(clean(name));
            for p in rest { if !p.is_empty() && *p != ".." { path.push(p); } }
            if path.is_dir() { path.push("index.html"); }
            match std::fs::read(&path) { Ok(d) => Res::new(200, mime(&path.to_string_lossy()), d), Err(_) => Res::err(404, "not found") }
        }
        _ => Res::err(404, "no such route"),
    }
}

fn id_q(req: &Req, k: &str) -> i64 { req.q(k).parse().unwrap_or(0) }
fn clean(name: &str) -> String { name.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect() }

fn rules_for(hive: &Hive, nodes: &[String], site: &str, app: &str, folder: &str) -> Vec<Value> {
    hive.db.all("select id, text, scope, code from rules where active=1 order by id", &[]).into_iter()
        .filter(|r| crate::db::scope_applies(r["scope"].as_str().unwrap_or(""), nodes, site, app, folder)).collect()
}

fn mime(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8", "js" => "text/javascript", "css" => "text/css", "json" => "application/json",
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "svg" => "image/svg+xml", "webp" => "image/webp",
        "mp4" => "video/mp4", "mov" => "video/quicktime", "webm" => "video/webm", "mp3" => "audio/mpeg", "wav" => "audio/wav",
        "pdf" => "application/pdf", "txt" | "md" | "log" => "text/plain; charset=utf-8", _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn developer_identity_requires_the_phones_or_a_devices_key() {
        let state = std::env::temp_dir().join(format!("hive-bootstrap-api-test-{}", std::process::id()));
        std::fs::create_dir_all(&state).unwrap();
        crate::private(&state.join("phone-token"), "phone-test-key");
        let hive = Hive::new(crate::db::Db::open(":memory:"), state.clone(), None, crate::hive::Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), String::new());
        let request = |path: &str, key: &str| Req { method: "GET".into(), path: path.into(), query: Default::default(),
            headers: [("authorization".into(), format!("Bearer {key}"))].into_iter().collect(), body: vec![], peer: "192.0.2.10".into() };
        let device = new_token(&hive, "mac:Mac");
        let path = "/phone/bootstrap/00008110-001A2B3C00000000";
        assert_eq!(handle(&hive, request(path, "wrong")).status, 401);
        assert_eq!(handle(&hive, request(path, "phone-test-key")).status, 404);
        assert_eq!(handle(&hive, request("/phone/bootstrap/..", "phone-test-key")).status, 400);
        let path = "/api/phone/bootstrap/00008110-001A2B3C00000000";
        assert_eq!(handle(&hive, request(path, "wrong")).status, 401);
        assert_eq!(handle(&hive, request(path, &device)).status, 404);
        std::fs::remove_dir_all(state).unwrap();
    }
    #[test]
    fn only_the_owners_own_devices_and_this_computer_sign_in() {
        let state = std::env::temp_dir().join(format!("hive-owners-test-{}", std::process::id()));
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("tailnet.json"), r#"{"address":"http://hive.tail1234.ts.net"}"#).unwrap();
        let hive = Hive::new(crate::db::Db::open(":memory:"), state.clone(), None, crate::hive::Engine::Codex { cmd: String::new(), env: vec![] }, String::new(), "http://127.0.0.1:8790".into());
        let request = |path: &str, peer: &str, headers: &[(&str, &str)]| Req { method: "POST".into(), path: path.into(), query: Default::default(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body: br#"{"kind":"mac","name":"Mac"}"#.to_vec(), peer: peer.into() };
        let owner = [("host", "hive.tail1234.ts.net"), ("x-forwarded-for", "100.64.0.2"), ("x-hive-tailnet-owner", "1")];
        let shared = [("host", "hive.tail1234.ts.net"), ("x-forwarded-for", "100.64.0.3")];
        let via = |host: &'static str| [("host", host), ("x-forwarded-for", "100.64.0.2"), ("x-hive-tailnet-owner", "1")];
        for path in ["/api/login", "/api/pair/tailnet"] {
            for ok in [via("hive.tail1234.ts.net"), via("HIVE.tail1234.ts.net:80"), via("100.101.1.2"), via("[fd7a:115c:a1e0::1]")] {
                assert_eq!(handle(&hive, request(path, "127.0.0.1", &ok)).status, 200, "{path} {ok:?}");
            }
            for here in ["127.0.0.1:8790", "localhost:8790", "[::1]:8790"] {
                assert_eq!(handle(&hive, request(path, "127.0.0.1", &[("host", here)])).status, 200, "{path} {here}");
            }
            assert_eq!(handle(&hive, request(path, "127.0.0.1", &shared)).status, 403, "a tailnet device that isn't the owner's");
            // DNS rebinding: a foreign name pointed at this computer or at the server's tailnet address.
            assert_eq!(handle(&hive, request(path, "127.0.0.1", &via("evil.example"))).status, 403, "{path}");
            assert_eq!(handle(&hive, request(path, "127.0.0.1", &via("hive.other.ts.net"))).status, 403, "{path}");
            assert_eq!(handle(&hive, request(path, "127.0.0.1", &[("host", "elsewhere.example:8790")])).status, 403, "{path}");
            assert_eq!(handle(&hive, request(path, "127.0.0.1", &[("host", "127.0.0.1:9999")])).status, 403, "another port here");
            assert_eq!(handle(&hive, request(path, "192.0.2.1", &owner[2..])).status, 403, "the header from anywhere but the helper");
        }
        let login = handle(&hive, request("/api/login", "127.0.0.1", &owner));
        let cookie = &login.headers.iter().find(|(k, _)| k == "Set-Cookie").unwrap().1;
        let t = cookie.trim_start_matches("hive=").split(';').next().unwrap();
        assert!(valid(&hive, t) && !valid(&hive, "nope") && !valid(&hive, ""));
        std::fs::remove_dir_all(state).ok();
    }
}
