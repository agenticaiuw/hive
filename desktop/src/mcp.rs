//! `hive mcp`: Hive as an MCP server over stdio, for any agent on this computer (Claude Code, Codex, Cursor, Claude
//! Desktop, …), so the work the owner gives them is saved as their Hive tasks wherever they run. Its tools call the Hive
//! Server's own API with this computer's token, through the app's door (tailnet.rs); the server decides what's allowed.
//! Claude Code's hook (hook.rs) uses the same calls.
use hive_protocol::{n, s, tool};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const INSTRUCTIONS: &str = "Hive is the owner's own agent system: every piece of work they give you is saved as one of their Hive \
    tasks, whichever app you run in. When the owner asks for new work, call add_task with their exact words before you start; \
    when it ends, call end_task. When they give a standing instruction (always, never, from now on, a preference), call add_rule. \
    Call get_rules when you start in a folder and follow every rule it gives. Use memory (search/get/save_profile/save_contact/save_playbook) \
    to read or update the owner's shared profile, contacts, and verified site playbooks (never secrets). Work for Hive's own agents (on another of the owner's \
    devices, or that should outlast this session) goes to hand_off. When asked to message Hive agents, use hand_off; for follow-ups include task. Read replies with task_status(request) and task_status(task). Share explicit context only, never raw transcripts.";

/// One call to the Hive Server through this computer's door: its answer, or why it didn't come.
pub fn call(method: &str, path: &str, body: Option<&Value>, secs: u64) -> Result<Value, String> {
    let c = crate::tailnet::load().ok_or("This computer hasn't joined a Hive yet: open the Hive app.")?;
    match hive_protocol::call(&c, method, path, body, secs).map_err(|e| format!("Couldn't reach Hive (is the Hive app open?): {e}"))? {
        (200, v) => Ok(v),
        (_, v) => Err(v["error"].as_str().unwrap_or("Hive refused").to_string()),
    }
}

/// The owner's rules (the server's rows) as a list for an agent; rules with code are enforced by Hive itself.
pub fn rules(rows: &Value) -> String {
    rows.as_array().into_iter().flatten().filter(|x| x["code"].is_null())
        .map(|x| format!("- R{} {}", x["id"], x["text"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n")
}

/// Gives Hive's orchestrator a request, as the hook, `add_task` and `hand_off` all do. `agent` names the session outside Hive
/// it comes from (which then writes its tasks itself); without one, Hive's own agents take it. `wait` waits for the
/// orchestrator's answer: `{id, reply, tasks, rules}`.
pub fn ask(hive: Hive, text: &str, folder: &str, agent: Option<&str>, wait: bool) -> Result<Value, String> {
    let mut body = json!({ "text": text, "node": crate::os::KIND, "context": { "folder": folder } });
    if let Some(a) = agent { body["agent"] = json!(a); }
    hive("POST", if wait { "/api/requests?wait=1" } else { "/api/requests" }, Some(&body))
}

fn tools() -> Vec<Value> {
    vec![
        tool("add_task", "Save the work the owner just gave you as a task in their Hive; you work on it yourself. Call it once per new \
            piece of work, before you start, not when they continue one of your tasks. Returns the task's id.",
            json!({ "title": s("A short title"), "quote": s("The owner's exact words that asked for it"),
                "request": n("The request id Hive's hook gave you for this prompt, if it gave one") }), &["title", "quote"]),
        tool("hand_off", "Hand work to the owner's Hive, for Hive's own agents to do instead of you: work on another of the owner's \
            devices (their phone, browser, another computer), work that should keep going after this session ends, or work the owner \
            asked you to pass to Hive. For work you do yourself, use add_task instead. Waits for Hive's orchestrator, then returns \
            its reply, the request's id and the tasks it made; follow them with task_status.",
            json!({ "request": s("What should be done: the owner's exact words when it's their ask, otherwise yours, said fully"),
                "task": n("Optional existing Hive task to message through its orchestrator"),
                "context": s("What Hive's agents need to know that the request doesn't say (files, links, what's done so far)") }), &["request"]),
        tool("end_task", "Say how one of your Hive tasks ended: done with the outcome, or not done with exactly why you stopped and \
            exactly what the owner must do. Stop only when you truly need the owner.",
            json!({ "task": n("The task's id"), "done": { "type": "boolean", "description": "Everything the owner asked for is done" },
                "outcome": s("When done: what was done"), "why": s("When not done: exactly why you stopped"),
                "need": s("When not done: exactly what the owner must do") }), &["task", "done"]),
        tool("task_status", "See a Hive task: its status, outcome or what it needs, and its latest log (including the owner's messages \
            to it). With a request (from hand_off) instead, returns its reply and all routed task outcomes, including completed tasks; with neither, all of the owner's open tasks.",
            json!({ "task": n("The task's id"), "request": n("A request's id, from hand_off") }), &[]),
        tool("add_rule", "Save a standing instruction from the owner (always, never, from now on, a preference) as a Hive rule, which \
            every agent then follows. Scope it as far as they meant: project:<slug> or folder:<path> for a project, \"\" only when they clearly mean \
            everything they do (also node:<kind>, site:<host>, app:<name>).",
            json!({ "scope": s("project:<slug>, folder:<path>, node:<kind>, site:<host>, app:<name>, or \"\" for everywhere"),
                "rule": s("The rule, said plainly"), "quote": s("The owner's exact words") }), &["scope", "rule", "quote"]),
        tool("get_rules", "The owner's rules for a folder/project (and this computer): follow every one.",
            json!({ "folder": s("The folder you work in; this session's folder when left out") }), &[]),
        tool("memory", "Read or update Hive's shared 3-tier memory (Tier 1: owner profile & contacts; Tier 2: verified site playbooks; \
            never passwords, tokens, or cards). Actions: search (query, optional tier), get (optional tier/key/host/id), \
            save_profile (key, value), save_contact (name, relation, email, phone, org, notes), save_playbook (host, title, steps, selectors), \
            report_playbook (id, ok), delete (tier, key/id/name).",
            json!({ "action": s("search | get | save_profile | save_contact | save_playbook | report_playbook | delete"),
                "tier": s("profile | contact | playbook | empty"), "query": s("BM25 search query"),
                "key": s("Profile key or contact name filter"), "value": s("Profile value"), "id": n("Numeric id"),
                "name": s("Contact name"), "relation": s("Relation"), "email": s("Email"), "phone": s("Phone"),
                "org": s("Organization"), "notes": s("Notes"), "host": s("Site host"), "title": s("Playbook title"),
                "steps": s("Verified steps"), "selectors": s("Stable selectors"),
                "ok": { "type": "boolean", "description": "Whether a playbook succeeded" } }), &["action"]),
    ]
}

/// This MCP session, as Hive knows it: `<client>:<id>`, the agent its own requests come from.
pub struct Session { pub name: String, pub folder: String }

impl Session {
    fn new(client: &str, folder: String) -> Session {
        let client: String = client.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        Session { name: format!("{}:{}-{at}", if client.is_empty() { "agent" } else { &client }, std::process::id()), folder }
    }
}

pub type Hive<'a> = &'a dyn Fn(&str, &str, Option<&Value>) -> Result<Value, String>;

/// One tool call: what the agent reads back.
fn run(name: &str, a: &Value, me: &Session, hive: Hive) -> Result<String, String> {
    let id = |k: &str| a[k].as_i64().ok_or(format!("give {k} as a number"));
    let text = |k: &str| a[k].as_str().unwrap_or("").to_string();
    match name {
        "add_task" => {
            let request = match a["request"].as_i64() {
                Some(r) => r,
                // No hook gave one: the owner's words go to the orchestrator first, as a request from this session.
                None => ask(hive, &text("quote"), &me.folder, Some(&me.name), false)?["id"].as_i64().ok_or("Hive didn't save the request")?,
            };
            let t = hive("POST", "/api/tasks", Some(&json!({ "request": request, "title": text("title"), "quote": text("quote"), "nodes": [crate::os::KIND] })))?;
            Ok(format!("Task #{} is saved in Hive, and it's yours. When it ends, call end_task.", t["id"]))
        }
        "hand_off" => {
            let context = text("context");
            let words = if context.trim().is_empty() { text("request") } else { format!("{}\n\nContext: {context}", text("request")) };
            if words.trim().is_empty() { return Err("Say what Hive should do.".into()); }
            let target = match a.get("task") {
                Some(v) => format!("Message Hive task #{}: ", v.as_i64().filter(|n| *n > 0).ok_or("give task as a positive number")?),
                None => String::new(),
            };
            let body = json!({"text": format!("External agent {} sends on the owner's behalf: {target}{words}", me.name),
                "node": crate::os::KIND, "context": {"folder": me.folder, "external_agent": me.name, "target_task": a["task"]}});
            let r = hive("POST", "/api/requests?wait=1", Some(&body))?;
            let tasks: Vec<String> = r["tasks"].as_array().into_iter().flatten()
                .map(|t| format!("- #{} [{}] {}", t["id"], t["status"].as_str().unwrap_or(""), t["title"].as_str().unwrap_or(""))).collect();
            let mut out = format!("Hive has it as request #{}. Its orchestrator says: {}", r["id"], r["reply"].as_str().unwrap_or("(still planning)"));
            if !tasks.is_empty() { out += &format!("\nTasks:\n{}", tasks.join("\n")); }
            Ok(out + &format!("\nFollow it with task_status (request {}, or a task's id).", r["id"]))
        }
        "end_task" => {
            let body = json!({ "done": a["done"] == true, "outcome": text("outcome"), "why": text("why"), "need": text("need") });
            hive("POST", &format!("/api/tasks/{}/end", id("task")?), Some(&body))?;
            Ok("Recorded in Hive.".into())
        }
        "task_status" => {
            let line = |t: &Value| format!("#{} [{}] {}", t["id"], t["status"].as_str().unwrap_or(""), t["title"].as_str().unwrap_or(""));
            let Some(task) = a["task"].as_i64() else {
                if let Some(request) = a["request"].as_i64() {
                    return Ok(hive("GET", &format!("/api/requests/{request}"), None)?.to_string());
                }
                let request = None::<i64>;
                let open: Vec<String> = hive("GET", "/api/state", None)?["tasks"].as_array().into_iter().flatten()
                    .filter(|t| request.is_none() || t["request_id"].as_i64() == request).map(line).collect();
                return Ok(match (open.is_empty(), request) {
                    (false, _) => open.join("\n"),
                    (true, Some(r)) => format!("Request #{r} has no open tasks: they're done, or Hive answered it without one."),
                    (true, None) => "The owner has no open tasks.".into(),
                });
            };
            let r = hive("GET", &format!("/api/tasks/{task}"), None)?;
            let t = &r["task"];
            if t.is_null() { return Err(format!("There's no task #{task}.")) }
            let mut out = line(t);
            for (k, label) in [("outcome", "Outcome"), ("why", "Why it stopped"), ("need", "Needs from the owner")] {
                if let Some(v) = t[k].as_str().filter(|v| !v.is_empty()) { out += &format!("\n{label}: {v}"); }
            }
            let log = r["log"].as_array().cloned().unwrap_or_default();
            for l in &log[log.len().saturating_sub(10)..] {
                let words: String = l["text"].as_str().unwrap_or("").chars().take(500).collect();
                out += &format!("\n{}: {words}", l["who"].as_str().unwrap_or(""));
            }
            Ok(out)
        }
        "add_rule" => {
            let r = hive("POST", "/api/rules", Some(&json!({ "scope": text("scope"), "text": text("rule"), "quote": text("quote") })))?;
            Ok(format!("Rule R{} is saved; every agent follows it now.", r["id"]))
        }
        "get_rules" => {
            let folder = Some(text("folder")).filter(|f| !f.is_empty()).unwrap_or(me.folder.clone());
            let q = |v: &str| v.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
            let r = rules(&hive("GET", &format!("/api/rules?folder={}&node={}", q(&folder), crate::os::KIND), None)?);
            Ok(if r.is_empty() { "The owner has no rules for here.".into() } else { format!("The owner's rules here (follow every one):\n{r}") })
        }
        "memory" => {
            let r = hive("POST", "/api/memory", Some(a))?;
            Ok(serde_json::to_string(&r).unwrap_or_default())
        }
        _ => Err(format!("Hive has no tool {name}")),
    }
}

/// One MCP message, answered; the first names the session after its client.
pub fn handle(m: &Value, me: &mut Option<Session>, folder: &str, hive: Hive) -> Option<Value> {
    if me.is_none() {
        let client = m["params"]["clientInfo"]["name"].as_str().or(m["params"]["_meta"]["io.modelcontextprotocol/clientInfo"]["name"].as_str());
        if client.is_some() || m["method"] == "tools/call" { *me = Some(Session::new(client.unwrap_or(""), folder.into())); }
    }
    hive_protocol::mcp::answer(m, INSTRUCTIONS, tools, |name, a| {
        match run(name, a, me.as_ref().expect("named above"), hive) { Ok(t) => (true, t, vec![]), Err(e) => (false, e, vec![]) }
    })
}

/// Serve MCP on stdin and stdout, one JSON-RPC message per line, until the agent closes stdin.
pub fn serve() {
    let folder = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    // Waiting for the orchestrator (hand_off) takes up to three minutes; everything else is quick.
    let hive = |method: &str, path: &str, body: Option<&Value>| call(method, path, body, if path.ends_with("wait=1") { 180 } else { 30 });
    let mut me = None;
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(m) => handle(&m, &mut me, &folder, &hive),
            Err(e) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": format!("not JSON: {e}") } })),
        };
        if let Some(r) = reply { if writeln!(out, "{r}").and_then(|_| out.flush()).is_err() { return } }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn followups_route_to_orchestrator_and_replies_survive_session_restart() {
        let first = Session::new("Gemini", "/work".into());
        let hive = |method: &str, path: &str, body: Option<&Value>| {
            assert_eq!((method, path), ("POST", "/api/requests?wait=1"));
            let b = body.unwrap();
            assert_eq!(b["context"]["target_task"], 42);
            assert!(b["agent"].is_null());
            assert!(b["text"].as_str().unwrap().contains("Message Hive task #42: Confirm USB-C power"));
            Ok(json!({"id":9,"reply":"Sent for verification","tasks":[{"id":42,"status":"working"}]}))
        };
        assert!(run("hand_off", &json!({"task":42,"request":"Confirm USB-C power"}), &first, &hive).unwrap().contains("request #9"));
        assert!(run("hand_off", &json!({"task":-1,"request":"Check"}), &first, &hive).is_err());
        let restarted = Session::new("Gemini", "/work".into());
        let read = |method: &str, path: &str, _: Option<&Value>| {
            assert_eq!((method,path), ("GET","/api/requests/9"));
            Ok(json!({"request":{"reply":"Sent"},"tasks":[{"id":42,"status":"done","outcome":"Supports 100W USB-C PD"}]}))
        };
        assert!(run("task_status", &json!({"request":9}), &restarted, &read).unwrap().contains("100W USB-C PD"));
    }

    #[test]
    fn tools_call_the_servers_api() {
        let calls = RefCell::new(Vec::new());
        let hive = |method: &str, path: &str, body: Option<&Value>| -> Result<Value, String> {
            calls.borrow_mut().push((format!("{method} {path}"), body.cloned().unwrap_or(Value::Null)));
            Ok(match path {
                "/api/requests" => json!({ "id": 7 }),
                "/api/requests?wait=1" => json!({ "id": 8, "reply": "Your phone will do it.", "tasks": [{ "id": 13, "status": "working", "title": "Book it" }] }),
                "/api/requests/8" => json!({"request":{"id":8,"reply":"Your phone will do it."},"tasks":[{"id":13,"status":"done","outcome":"Booked"}]}),
                "/api/state" => json!({ "tasks": [{ "id": 13, "request_id": 8, "status": "working", "title": "Book it" }, { "id": 12, "request_id": 7, "status": "needs", "title": "Fix it" }] }),
                "/api/tasks" => json!({ "id": 12 }),
                "/api/tasks/12" => json!({ "task": { "id": 12, "status": "needs", "title": "Fix it", "why": "no key", "need": "add one" },
                    "log": [{ "who": "owner", "text": "use the old one" }] }),
                p if p.starts_with("/api/rules?") => json!([{ "id": 3, "text": "Use tabs", "code": null }, { "id": 4, "text": "x", "code": "js" }]),
                "/api/tasks/12/end" => json!({ "ok": true }),
                "/api/memory" => json!({ "results": [{ "tier": "profile", "key": "school", "value": "UW Madison" }] }),
                _ => return Err("Hive refused".into()),
            })
        };
        let mut me = None;
        let mut send = |m: Value| handle(&m, &mut me, "/work/my app", &hive).unwrap();
        let init = send(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": "Codex MCP" } } }));
        assert!(init["result"]["instructions"].as_str().unwrap().contains("add_task"));
        let names: Vec<Value> = send(json!({ "id": 2, "method": "tools/list" }))["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].clone()).collect();
        assert_eq!(names, ["add_task", "hand_off", "end_task", "task_status", "add_rule", "get_rules", "memory"]);
        let tool = |send: &mut dyn FnMut(Value) -> Value, name: &str, a: Value| {
            let r = send(json!({ "id": 3, "method": "tools/call", "params": { "name": name, "arguments": a } }));
            (r["result"]["isError"] == true, r["result"]["content"][0]["text"].as_str().unwrap().to_string())
        };
        // Without a hook's request, the owner's words go to the orchestrator first, from this session.
        assert_eq!(tool(&mut send, "add_task", json!({ "title": "Fix it", "quote": "fix the build" })), (false, "Task #12 is saved in Hive, and it's yours. When it ends, call end_task.".into()));
        // With one, the task joins it.
        tool(&mut send, "add_task", json!({ "title": "Fix it", "quote": "fix the build", "request": 5 }));
        let status = tool(&mut send, "task_status", json!({ "task": 12 })).1;
        assert_eq!(status, "#12 [needs] Fix it\nWhy it stopped: no key\nNeeds from the owner: add one\nowner: use the old one");
        assert_eq!(tool(&mut send, "end_task", json!({ "task": 12, "done": true, "outcome": "fixed" })), (false, "Recorded in Hive.".into()));
        assert!(tool(&mut send, "end_task", json!({ "done": true })).0, "a task id is needed");
        assert_eq!(tool(&mut send, "get_rules", json!({})).1, "The owner's rules here (follow every one):\n- R3 Use tabs");
        // Handed off: Hive's own agents take it (no agent on the request), and the answer says how to follow it.
        assert_eq!(tool(&mut send, "hand_off", json!({ "request": "book the table on my phone", "context": "for 4 at 7pm" })),
            (false, "Hive has it as request #8. Its orchestrator says: Your phone will do it.\nTasks:\n- #13 [working] Book it\n\
                Follow it with task_status (request 8, or a task's id).".into()));
        assert!(tool(&mut send, "task_status", json!({ "request": 8 })).1.contains("Booked"));
        assert_eq!(tool(&mut send, "add_rule", json!({ "scope": "", "rule": "r", "quote": "q" })), (true, "Hive refused".into()));
        assert!(tool(&mut send, "memory", json!({ "action": "search", "query": "Madison" })).1.contains("UW Madison"));
        let calls = calls.into_inner();
        let session = calls[0].1["agent"].as_str().unwrap();
        assert!(session.starts_with("codex-mcp:"), "{session}");
        assert_eq!((calls[0].0.as_str(), &calls[0].1["context"]["folder"]), ("POST /api/requests", &json!("/work/my app")));
        assert_eq!(calls[1].1["request"], 7);
        assert_eq!((calls[2].0.as_str(), &calls[2].1["request"]), ("POST /api/tasks", &json!(5)));
        assert_eq!((calls[4].0.as_str(), &calls[4].1), ("POST /api/tasks/12/end", &json!({ "done": true, "outcome": "fixed", "why": "", "need": "" })));
        assert_eq!(calls[5].0, format!("GET /api/rules?folder=/work/my%20app&node={}", crate::os::KIND));
        assert_eq!(calls[6].0, "POST /api/requests?wait=1");
        assert!(calls[6].1["text"].as_str().unwrap().contains("sends on the owner's behalf"));
        assert_eq!(calls[6].1["context"]["external_agent"], session);
        assert!(calls[6].1["agent"].is_null(), "Hive's orchestrator must execute the handoff");
    }
}
