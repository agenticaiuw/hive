//! `hive hook`: Claude Code's hook for UserPromptSubmit and PostToolUse. Every prompt goes to Hive's orchestrator first; the
//! session gets back the rules for this folder, its tasks and, between tool calls, messages for it. The session writes the
//! prompt's tasks and rules itself (`hive task`, `hive rule`): it has the context the orchestrator lacks.
//! If Hive can't be reached, the prompt goes ahead untouched.
use serde_json::{json, Value};
use std::io::Read;

pub fn run() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).ok();
    let e: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let Some(c) = hive_protocol::load("node") else { return };
    let session = e["session_id"].as_str().unwrap_or("");
    let event = e["hook_event_name"].as_str().unwrap_or("");
    let mut out = String::new();
    // Claude Code also delivers its own events (a background job finished, another session wrote) as prompts: those
    // aren't the owner's words, so they don't go to the orchestrator.
    let prompt = e["prompt"].as_str().unwrap_or("").trim_start();
    let from_owner = !["<task-notification>", "<side-sessions-event>", "<ci-monitor-event>", "<cross-session-message"].iter().any(|t| prompt.starts_with(t));
    if event == "UserPromptSubmit" && from_owner {
        let body = json!({ "text": e["prompt"], "node": crate::os::KIND, "agent": format!("claude:{session}"), "context": { "folder": e["cwd"] } });
        if let Ok((200, r)) = hive_protocol::call(&c, "POST", "/api/requests?wait=1", Some(&body), 180) {
            out += &format!("Hive (the owner's orchestrator) saved this prompt as request #{id}. It says: {}\n\
                You write this prompt's tasks and rules, not Hive. New work: `hive task {id} \"<short title>\" \"<the owner's exact words>\"` \
                (prints its id); none when it continues one of your tasks. A standing instruction (always, never, from now on, a \
                preference): `hive rule \"folder:{folder}\" \"<the rule>\" \"<the owner's exact words>\"`, or \"\" for the scope only \
                when they clearly mean everything they do.\n", r["reply"].as_str().unwrap_or(""), id = r["id"], folder = e["cwd"].as_str().unwrap_or(""));
            let rules: Vec<String> = r["rules"].as_array().into_iter().flatten().filter(|x| x["code"].is_null())
                .map(|x| format!("- R{} {}", x["id"], x["text"].as_str().unwrap_or(""))).collect();
            if !rules.is_empty() { out += &format!("The owner's rules here (follow every one):\n{}\n", rules.join("\n")); }
        }
    }
    if let Ok((200, r)) = hive_protocol::call(&c, "GET", &format!("/api/inbox?session={session}"), None, 10) {
        for m in r["messages"].as_array().into_iter().flatten() { out += &format!("Message: {}\n", m["text"].as_str().unwrap_or("")); }
        if event == "UserPromptSubmit" {
            let tasks: Vec<String> = r["tasks"].as_array().into_iter().flatten()
                .map(|t| format!("- #{} [{}] {}", t["id"], t["status"].as_str().unwrap_or(""), t["title"].as_str().unwrap_or(""))).collect();
            if !tasks.is_empty() {
                out += &format!("Your tasks in Hive:\n{}\nWhen one ends, run `hive end <id> done \"<outcome>\"`, or `hive end <id> needs \"<exactly why you \
                    stopped>\" \"<exactly what the owner must do>\"`.\n", tasks.join("\n"));
            }
        }
    }
    if !out.is_empty() {
        println!("{}", json!({ "hookSpecificOutput": { "hookEventName": event, "additionalContext": out.trim_end() } }));
    }
}

/// `hive task <request> <title> <quote>`: a task this session works on itself.
pub fn task(args: &[String]) -> Result<(), String> {
    let [request, title, quote] = args else { return Err("usage: hive task <request> <title> <owner's exact words>".into()) };
    let body = json!({ "request": request.parse::<i64>().map_err(|_| "the request is a number")?, "title": title, "quote": quote, "nodes": [crate::os::KIND] });
    println!("Task #{}", post("/api/tasks", &body)?["id"]);
    Ok(())
}

/// `hive rule <scope> <rule> <quote>`
pub fn rule(args: &[String]) -> Result<(), String> {
    let [scope, text, quote] = args else { return Err("usage: hive rule <scope> <rule> <owner's exact words>".into()) };
    println!("Rule R{}", post("/api/rules", &json!({ "scope": scope, "text": text, "quote": quote }))?["id"]);
    Ok(())
}

fn post(path: &str, body: &Value) -> Result<Value, String> {
    let c = hive_protocol::load("node").ok_or("This computer isn't paired with Hive.")?;
    match hive_protocol::call(&c, "POST", path, Some(body), 30)? {
        (200, v) => Ok(v),
        (_, v) => Err(v["error"].as_str().unwrap_or("Hive refused").to_string()),
    }
}

/// `hive end <task> done <outcome>` | `hive end <task> needs <why> <need>`
pub fn end(args: &[String]) -> Result<(), String> {
    let body = match (args.first(), args.get(1).map(|s| s.as_str())) {
        (Some(_), Some("done")) => json!({ "done": true, "outcome": args[2..].join(" ") }),
        (Some(_), Some("needs")) if args.len() >= 4 => json!({ "done": false, "why": args[2], "need": args[3..].join(" ") }),
        _ => return Err("usage: hive end <task> done <outcome> | hive end <task> needs <why> <need>".into()),
    };
    post(&format!("/api/tasks/{}/end", args[0]), &body).map(|_| ())
}
