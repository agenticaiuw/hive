//! `hive hook`: Claude Code's hook for UserPromptSubmit and PostToolUse. Every prompt goes to Hive's orchestrator first; the
//! session gets back the rules for this folder, its tasks and, between tool calls, messages for it. The session writes the
//! prompt's tasks and rules itself, with Hive's MCP tools (`hive mcp`, mcp.rs): it has the context the orchestrator lacks.
//! The hook sees every prompt, which an MCP server can't. If Hive can't be reached, the prompt goes ahead untouched.
use crate::mcp::{ask, call, rules};
use serde_json::{json, Value};
use std::io::Read;

pub fn run() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).ok();
    let e: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let session = e["session_id"].as_str().unwrap_or("");
    let event = e["hook_event_name"].as_str().unwrap_or("");
    let mut out = String::new();
    // Claude Code also delivers its own events (a background job finished, another session wrote) as prompts: those
    // aren't the owner's words, so they don't go to the orchestrator.
    let prompt = e["prompt"].as_str().unwrap_or("").trim_start();
    let from_owner = !["<task-notification>", "<side-sessions-event>", "<ci-monitor-event>", "<cross-session-message"].iter().any(|t| prompt.starts_with(t));
    if event == "UserPromptSubmit" && from_owner {
        let hive = |method: &str, path: &str, body: Option<&Value>| call(method, path, body, 180);
        if let Ok(r) = ask(&hive, prompt, e["cwd"].as_str().unwrap_or(""), Some(&format!("claude:{session}")), true) {
            out += &format!("Hive (the owner's orchestrator) saved this prompt as request #{id}. It says: {}\n\
                You write this prompt's tasks and rules, not Hive, with Hive's MCP tools. New work: add_task with request {id}, a short \
                title and the owner's exact words; none when it continues one of your tasks. A standing instruction (always, never, \
                from now on, a preference): add_rule with scope \"folder:{folder}\", or \"\" only when they clearly mean everything \
                they do.\n", r["reply"].as_str().unwrap_or(""), id = r["id"], folder = e["cwd"].as_str().unwrap_or(""));
            let rules = rules(&r["rules"]);
            if !rules.is_empty() { out += &format!("The owner's rules here (follow every one):\n{rules}\n"); }
        }
    }
    if let Ok(r) = call("GET", &format!("/api/inbox?session={session}"), None, 10) {
        for m in r["messages"].as_array().into_iter().flatten() { out += &format!("Message: {}\n", m["text"].as_str().unwrap_or("")); }
        if event == "UserPromptSubmit" {
            let tasks: Vec<String> = r["tasks"].as_array().into_iter().flatten()
                .map(|t| format!("- #{} [{}] {}", t["id"], t["status"].as_str().unwrap_or(""), t["title"].as_str().unwrap_or(""))).collect();
            if !tasks.is_empty() {
                out += &format!("Your tasks in Hive:\n{}\nWhen one ends, call end_task: done with the outcome, or not done with exactly \
                    why you stopped and exactly what the owner must do.\n", tasks.join("\n"));
            }
        }
    }
    if !out.is_empty() {
        println!("{}", json!({ "hookSpecificOutput": { "hookEventName": event, "additionalContext": out.trim_end() } }));
    }
}
