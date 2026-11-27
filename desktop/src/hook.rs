//! `hive hook`: deterministic lifecycle hook (SessionStart, UserPromptSubmit, PostToolUse, PreCompact) for Claude Code
//! and compatible external harnesses. Shares Hive's scoped rules, Tier 1–2 memory pointer, tasks, and inbox without
//! cross-injecting raw chat transcripts. If Hive can't be reached, the session proceeds untouched.
use crate::mcp::{call, rules, Hive};
use serde_json::{json, Value};
use std::io::Read;

pub fn run() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).ok();
    let e: Value = serde_json::from_str(&input).unwrap_or(Value::Null);
    let hive = |method: &str, path: &str, body: Option<&Value>| call(method, path, body, if path.ends_with("wait=1") { 180 } else { 15 });
    if let Some(reply) = handle(&e, &hive) {
        println!("{reply}");
    }
}

fn urlencode(v: &str) -> String {
    v.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub fn handle(e: &Value, hive: Hive) -> Option<Value> {
    let session = e["session_id"].as_str().or(e["sessionId"].as_str()).unwrap_or("");
    let event = e["hook_event_name"].as_str().or(e["event"].as_str()).unwrap_or("");
    let folder = e["cwd"].as_str().or(e["workspace"].as_str()).unwrap_or("");
    let mut out = String::new();

    if event == "SessionStart" {
        if let Ok(r) = hive("GET", &format!("/api/rules?folder={}&node={}", urlencode(folder), crate::os::KIND), None) {
            let rs = rules(&r);
            if !rs.is_empty() { out += &format!("The owner's Hive rules here (follow every one):\n{rs}\n"); }
        }
        if let Ok(m) = hive("GET", "/api/memory?tier=profile", None) {
            let keys: Vec<&str> = m["profile"].as_array().into_iter().flatten()
                .filter_map(|row| row["key"].as_str()).take(25).collect();
            if !keys.is_empty() {
                out += &format!("Hive Tier 1 profile keys available via `memory` MCP tool: {}.\n", keys.join(", "));
            }
        }
    } else if event == "PreCompact" {
        out += "Before compaction: save any newly confirmed owner preferences as a rule (`add_rule`) and confirmed personal facts/contacts/site playbooks via `memory` (never secrets). Keep raw transcripts local to this session.\n";
    } else {
        // Claude Code also delivers its own events (a background job finished, another session wrote) as prompts: those
        // aren't the owner's words, so they don't go to the orchestrator.
        let prompt = e["prompt"].as_str().unwrap_or("").trim_start();
        let from_owner = !["<task-notification>", "<side-sessions-event>", "<ci-monitor-event>", "<cross-session-message"].iter().any(|t| prompt.starts_with(t));
        if event == "UserPromptSubmit" && from_owner {
            let body = request(e);
            if let Ok(r) = hive("POST", "/api/requests?wait=1", Some(&body)) {
                out += &format!("Hive (the owner's orchestrator) saved this prompt as request #{id}. It says: {}\n\
                    You write this prompt's tasks and rules, not Hive, with Hive's MCP tools. New work: add_task with request {id}, a short \
                    title and the owner's exact words; none when it continues one of your tasks. A standing instruction (always, never, \
                    from now on, a preference): add_rule with scope \"folder:{folder}\", or \"\" only when they clearly mean everything \
                    they do. Use `memory` for shared profile/contacts/playbooks.\n", r["reply"].as_str().unwrap_or(""), id = r["id"]);
                let rules = rules(&r["rules"]);
                if !rules.is_empty() { out += &format!("The owner's rules here (follow every one):\n{rules}\n"); }
            }
        }
        if !session.is_empty() {
            if let Ok(r) = hive("GET", &format!("/api/inbox?session={session}"), None) {
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
        }
    }
    if out.is_empty() { None }
    else { Some(json!({ "hookSpecificOutput": { "hookEventName": event, "additionalContext": out.trim_end() } })) }
}

/// The transcript belongs to this hook's session, not whichever project Hive last handled.
fn request(event: &Value) -> Value {
    let session = event["session_id"].as_str().or(event["sessionId"].as_str()).unwrap_or("");
    let folder = event["cwd"].as_str().or(event["workspace"].as_str()).unwrap_or("");
    let mut context = json!({ "folder": folder, "session": session });
    match std::fs::read_to_string(event["transcript_path"].as_str().unwrap_or("")) {
        Ok(raw) => { context["conversation"] = conversation(&raw); }
        Err(_) => { context["conversation_unavailable"] = json!(true); }
    }
    json!({ "text": event["prompt"], "node": crate::os::KIND,
        "agent": format!("claude:{session}"), "context": context })
}

/// What of the session goes with a prompt: its newest messages, up to CONTEXT_CHARS in all, each cut to MESSAGE_CHARS (a
/// big tool result), so a long session never outgrows what the orchestrator can read (about a million characters).
const CONTEXT_CHARS: usize = 200_000;
const MESSAGE_CHARS: usize = 20_000;

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
    let (mut kept, mut used) = (Vec::new(), 0);
    for m in messages.iter().rev() {
        let text = m.to_string();
        let m = if text.len() <= MESSAGE_CHARS { m.clone() } else {
            let mut end = MESSAGE_CHARS;
            while !text.is_char_boundary(end) { end -= 1; }
            json!({ "role": m["role"], "content": format!("{}… (cut)", &text[..end]) })
        };
        used += text.len().min(MESSAGE_CHARS);
        if used > CONTEXT_CHARS { break; }
        kept.push(m);
    }
    if kept.len() < messages.len() { kept.push(json!({ "role": "user", "content": format!("({} earlier messages left out)", messages.len() - kept.len()) })); }
    kept.reverse();
    json!(kept)
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
    #[test]
    fn a_long_session_sends_only_its_newest_messages() {
        let row = |i: usize, n: usize| json!({"type":"user","message":{"role":"user","content":format!("{i} {}", "é".repeat(n))}}).to_string();
        let raw: Vec<String> = (0..100).map(|i| row(i, 4_000)).chain([row(100, 60_000)]).collect();
        let m = conversation(&raw.join("\n"));
        let text = m.to_string();
        assert!(text.len() < CONTEXT_CHARS + 2_000, "{}", text.len());
        let m = m.as_array().unwrap();
        assert!(m[0]["content"].as_str().unwrap().ends_with("earlier messages left out)"));
        assert!(m.last().unwrap()["content"].as_str().unwrap().ends_with("… (cut)"));
        assert!(m[m.len() - 2]["content"].as_str().unwrap().starts_with("99 "));
    }
    #[test]
    fn session_start_and_pre_compact_inject_rules_and_memory_guidance() {
        let hive = |_m: &str, path: &str, _b: Option<&Value>| -> Result<Value, String> {
            Ok(match path {
                p if p.starts_with("/api/rules?") => json!([{ "id": 7, "text": "Keep diffs lean", "code": null }]),
                "/api/memory?tier=profile" => json!({ "profile": [{ "key": "school", "value": "UW" }] }),
                _ => json!({}),
            })
        };
        let start = handle(&json!({"hook_event_name":"SessionStart","cwd":"/repo/hive","session_id":"s1"}), &hive).unwrap();
        let ctx = start["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
        assert!(ctx.contains("R7 Keep diffs lean") && ctx.contains("school"), "{ctx}");

        let compact = handle(&json!({"hook_event_name":"PreCompact","session_id":"s1"}), &hive).unwrap();
        let cctx = compact["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
        assert!(cctx.contains("Before compaction") && cctx.contains("memory"), "{cctx}");
    }
}
