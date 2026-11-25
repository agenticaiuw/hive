//! `hive hook`: Claude Code's hook for UserPromptSubmit and PostToolUse. Every prompt goes to Hive's orchestrator first; the
//! session gets back the rules for this folder, its tasks and, between tool calls, messages for it. The session writes the
//! prompt's tasks and rules itself, with Hive's MCP tools (`hive mcp`, mcp.rs): it has the context the orchestrator lacks.
//! The hook sees every prompt, which an MCP server can't. If Hive can't be reached, the prompt goes ahead untouched.
use crate::mcp::{call, rules};
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
        let body = request(&e);
        if let Ok(r) = call("POST", "/api/requests?wait=1", Some(&body), 180) {
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

/// The transcript belongs to this hook's session, not whichever project Hive last handled.
fn request(event: &Value) -> Value {
    let mut context = json!({ "folder": event["cwd"], "session": event["session_id"] });
    match std::fs::read_to_string(event["transcript_path"].as_str().unwrap_or("")) {
        Ok(raw) => { context["conversation"] = conversation(&raw); }
        Err(_) => { context["conversation_unavailable"] = json!(true); }
    }
    json!({ "text": event["prompt"], "node": crate::os::KIND,
        "agent": format!("claude:{}", event["session_id"].as_str().unwrap_or("")), "context": context })
}

fn conversation(raw: &str) -> Value {
    let mut messages = Vec::new();
    for line in raw.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        // A compact boundary replaces the preceding conversation with Claude's saved summary.
        if row["type"] == "system" && row["subtype"] == "compact_boundary" { messages.clear(); }
        if matches!(row["type"].as_str(), Some("user" | "assistant")) && row["message"].is_object() {
            messages.push(row["message"].clone());
        }
    }
    json!(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_conversation_keeps_references_tools_and_compaction() {
        let raw = [
            json!({"type":"user","message":{"role":"user","content":"old"}}),
            json!({"type":"system","subtype":"compact_boundary"}),
            json!({"type":"user","message":{"role":"user","content":"Summary: cancel Workspace for the club"}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Cancellation needs approval"}]}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"plan details"}]}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let messages = conversation(&(raw + "\ninvalid partial line"));
        assert_eq!(messages.as_array().unwrap().len(), 3);
        assert!(messages.to_string().contains("cancel Workspace"));
        assert!(messages.to_string().contains("plan details"));
        assert!(!messages.to_string().contains("old"));
        let r = request(&json!({"session_id":"source","cwd":"/club","prompt":"help me cancel it"}));
        assert_eq!(r["agent"], "claude:source");
        assert_eq!(r["text"], "help me cancel it");
        assert_eq!(r["context"]["conversation_unavailable"], true);
    }
}
