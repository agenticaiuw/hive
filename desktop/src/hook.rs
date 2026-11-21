//! `hive hook`: Claude Code's hook for UserPromptSubmit and PostToolUse. Every prompt goes to Hive's orchestrator first; the
//! session gets back what Hive made of it (its tasks, the rules for this folder) and, between tool calls, messages for it.
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
    if event == "UserPromptSubmit" {
        let body = json!({ "text": e["prompt"], "node": crate::os::KIND, "agent": format!("claude:{session}"), "context": { "folder": e["cwd"] } });
        if let Ok((200, r)) = hive_protocol::call(&c, "POST", "/api/requests?wait=1", Some(&body), 180) {
            out += &format!("Hive (the owner's orchestrator) saved this prompt as request #{}. It says: {}\n", r["id"], r["reply"].as_str().unwrap_or(""));
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

/// `hive end <task> done <outcome>` | `hive end <task> needs <why> <need>`
pub fn end(args: &[String]) -> Result<(), String> {
    let c = hive_protocol::load("node").ok_or("This computer isn't paired with Hive.")?;
    let body = match (args.first(), args.get(1).map(|s| s.as_str())) {
        (Some(_), Some("done")) => json!({ "done": true, "outcome": args[2..].join(" ") }),
        (Some(_), Some("needs")) if args.len() >= 4 => json!({ "done": false, "why": args[2], "need": args[3..].join(" ") }),
        _ => return Err("usage: hive end <task> done <outcome> | hive end <task> needs <why> <need>".into()),
    };
    match hive_protocol::call(&c, "POST", &format!("/api/tasks/{}/end", args[0]), Some(&body), 30)? {
        (200, _) => Ok(()),
        (_, v) => Err(v["error"].as_str().unwrap_or("Hive refused").to_string()),
    }
}
