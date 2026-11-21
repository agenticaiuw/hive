//! Hive's HTTP API: the dashboard, nodes, the extension, Claude Code and made-on-demand sites all come through here.
use crate::args;
use crate::db::now;
use crate::hive::Hive;
use crate::http::{Req, Res};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const DASHBOARD: &str = include_str!("../dashboard.html");

fn s(v: &Value) -> String { v.as_str().map(String::from).unwrap_or_default() }
pub fn hash(t: &str) -> String { Sha256::digest(t.as_bytes()).iter().map(|b| format!("{b:02x}")).collect() }
pub fn random(n: usize) -> String {
    let mut b = vec![0u8; n];
    use std::io::Read;
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).ok();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn token(req: &Req) -> String {
    req.headers.get("authorization").and_then(|a| a.strip_prefix("Bearer ")).map(String::from)
        .or_else(|| req.cookie("hive")).unwrap_or_else(|| req.q("key").to_string())
}

fn authed(hive: &Hive, req: &Req) -> bool {
    let t = token(req);
    !t.is_empty() && (t == hive.owner_key || hive.db.get("select 1 from tokens where hash=? and node!='code'", args!(hash(&t))).is_some())
}

/// A new device token for a pairing code or the owner key; None if neither matches.
fn pair(hive: &Hive, secret: &str, node: &str) -> Option<String> {
    let secret = secret.trim();
    let code_ok = secret.len() >= 6 && hive.db.get("select 1 from tokens where hash=? and node='code' and at > ?", args!(hash(&format!("code:{secret}")), now() - 600_000)).is_some();
    if !(code_ok || (!secret.is_empty() && secret == hive.owner_key)) { return None; }
    if code_ok { hive.db.run("delete from tokens where hash=?", args!(hash(&format!("code:{secret}")))); }
    let t = random(24);
    hive.db.run("insert into tokens(hash, node, at) values(?,?,?)", args!(hash(&t), node, now()));
    Some(t)
}

pub fn new_code(db: &crate::db::Db) -> String {
    let n = u32::from_str_radix(&random(4)[..7], 16).unwrap_or(0) % 100_000_000;
    let code = format!("{n:08}");
    db.run("insert into tokens(hash, node, at) values(?, 'code', ?)", args!(hash(&format!("code:{code}")), now()));
    code
}

pub fn handle(hive: &Arc<Hive>, req: Req) -> Res {
    let parts: Vec<&str> = req.path.trim_matches('/').split('/').collect();
    let m = req.method.as_str();
    match (m, parts.as_slice()) {
        ("GET", [""]) => return Res::new(200, "text/html; charset=utf-8", DASHBOARD),
        ("GET", ["health"]) => return Res::json(&json!({ "ok": true, "version": hive.version })),
        ("POST", ["api", "login"]) => {
            return match pair(hive, &s(&req.json()["secret"]), "dashboard") {
                Some(t) => Res::json(&json!({ "ok": true })).header("Set-Cookie", &format!("hive={t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000")),
                None => Res::err(401, "That key or code isn't right (codes last 10 minutes)."),
            };
        }
        ("POST", ["api", "pair"]) => {
            let b = req.json();
            return match pair(hive, &s(&b["code"]), &format!("{}:{}", s(&b["kind"]), s(&b["name"]))) {
                Some(t) => Res::json(&json!({ "token": t })),
                None => Res::err(401, "That pairing code isn't right or has expired."),
            };
        }
        _ => {}
    }
    if !authed(hive, &req) { return Res::err(401, "Sign in to Hive first."); }
    let b = req.json();
    let id = |i: usize| parts.get(i).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    match (m, parts.as_slice()) {
        ("GET", ["api", "me"]) => Res::json(&json!({ "ok": true, "version": hive.version })),
        ("POST", ["api", "pair", "code"]) => Res::json(&json!({ "code": new_code(&hive.db) })),
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
            let tasks = hive.db.all("select id, title, quote, status from tasks where request_id=?", args!(rid));
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
            "log": hive.db.all("select * from log where task_id=? and id > ? order by id limit 2000", args!(id(2), req.q("after").parse::<i64>().unwrap_or(0))),
        })),
        ("POST", ["api", "tasks", _, "message"]) => match hive.message_task(id(2), &s(&b["text"]), "owner") {
            Ok(()) => Res::json(&json!({ "ok": true })),
            Err(e) => Res::err(409, &e),
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
        ("POST", ["api", "rules"]) => {
            let rid = hive.db.run("insert into rules(text, quote, scope, at) values(?,?,?,?)", args!(s(&b["text"]), s(&b["quote"]), s(&b["scope"]), now()));
            hive.bump();
            Res::json(&json!({ "id": rid }))
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
        ("GET", ["api", "tools"]) => Res::json(&json!(["vm", "mac", "browser", "phone", "hive"].iter()
            .map(|n| json!({ "node": n, "tools": crate::tools::for_node(n) })).chain([json!({ "node": "every agent", "tools": crate::tools::common() })]).collect::<Vec<_>>())),
        ("GET", ["api", "vm", "screen"]) => match crate::vm::screen() {
            Some(png) => Res::new(200, "image/png", png),
            None => Res::err(404, "The VM's screen isn't running."),
        },
        ("POST", ["api", "node", "hello"]) => {
            let nid = s(&b["id"]);
            hive.db.run("insert into nodes(id, kind, name, tools, seen, version) values(?,?,?,?,?,?) on conflict(id) do update set kind=excluded.kind, \
                name=excluded.name, tools=excluded.tools, seen=excluded.seen, version=excluded.version",
                args!(nid, s(&b["kind"]), s(&b["name"]), b["tools"].clone(), now(), s(&b["version"])));
            hive.bump();
            Res::json(&json!({ "ok": true, "version": hive.version }))
        }
        ("GET", ["api", "node", "next"]) => {
            let nid = req.q("id").to_string();
            hive.db.run("update nodes set seen=? where id=?", args!(now(), nid));
            let call = hive.wait_until(25_000, || {
                let c = hive.db.get("select id, tool, args from calls where node=? and status='queued' order by id limit 1", args!(nid))?;
                hive.db.run("update calls set status='sent' where id=?", args!(c["id"].clone()));
                Some(c)
            });
            hive.db.run("update nodes set seen=? where id=?", args!(now(), nid));
            match call {
                Some(c) => Res::json(&json!({ "id": c["id"], "tool": c["tool"], "args": serde_json::from_str::<Value>(&s(&c["args"])).unwrap_or(json!({})) })),
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
        ("POST", ["api", "reinstall"]) => match crate::vm::reinstall(&hive.repo) { Ok(v) => Res::json(&v), Err(e) => Res::err(500, &e) },
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
