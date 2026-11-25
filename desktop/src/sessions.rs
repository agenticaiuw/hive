//! Incrementally mirror local provider transcripts; acknowledgements advance the cursor.
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Seek, SeekFrom}, path::{Path, PathBuf}, time::Duration};

pub fn start(c: hive_protocol::Conf) {
    std::thread::spawn(move || run(c));
}
pub fn run(c: hive_protocol::Conf) {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    let roots = [("claude", PathBuf::from(&home).join(".claude/projects")),
        ("codex", std::env::var("CODEX_HOME").map(PathBuf::from).unwrap_or(PathBuf::from(&home).join(".codex")).join("sessions"))];
    let mut cursors = HashMap::<PathBuf, (u64, String, String)>::new();
    loop {
        for (provider, root) in &roots {
            let mut files = Vec::new(); collect(root, &mut files);
            // Live sessions first, then history.
            files.sort_by_key(|p| std::cmp::Reverse(fs::metadata(p).and_then(|m| m.modified()).ok()));
            for path in files {
                let state = cursors.entry(path.clone()).or_default();
                let Ok(file) = fs::File::open(&path) else { continue };
                if file.metadata().map(|m| m.len()<state.0).unwrap_or(false) { *state = Default::default(); }
                let mut reader = BufReader::new(file); if reader.seek(SeekFrom::Start(state.0)).is_err() { continue }
                let mut offset = state.0; let mut events = Vec::new();
                for _ in 0..500 {
                    let mut line = String::new(); let Ok(n) = reader.read_line(&mut line) else { break };
                    if n == 0 || !line.ends_with('\n') { break }
                    let key = offset; offset += n as u64;
                    let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                    if *provider == "claude" {
                        if let Some(id) = v["sessionId"].as_str() { state.1 = format!("claude:{id}"); }
                        if let Some(cwd) = v["cwd"].as_str() { state.2 = cwd.into(); }
                    } else if v["type"] == "session_meta" {
                        state.1 = format!("codex:{}", v["payload"]["id"].as_str().unwrap_or(""));
                        state.2 = v["payload"]["cwd"].as_str().unwrap_or("").into();
                    }
                    if let Some(mut e) = event(&v, provider) { e["key"] = json!(key); events.push(e); }
                }
                if state.1.is_empty() || events.is_empty() { state.0 = offset; continue }
                let body = json!({"session":state.1,"folder":state.2,"source":path.to_string_lossy(),"events":events});
                if matches!(hive_protocol::call(&c,"POST","/api/sessions/stream",Some(&body),30), Ok((200,_))) { state.0=offset; }
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}
fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p=e.path();
        // Subagents have their parent's session ID; never mix their conversations.
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { if e.file_name() != "subagents" { collect(&p,out); } }
        else if p.extension().is_some_and(|x| x=="jsonl") { out.push(p); }
    }
}
fn content(v: &Value) -> String {
    if let Some(s)=v.as_str() { return s.into() }
    v.as_array().into_iter().flatten().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")
}
fn event(v: &Value, provider: &str) -> Option<Value> {
    let mut who=""; let mut text=String::new(); let mut status="working";
    if provider=="claude" {
        let m=&v["message"];
        if v["type"]=="assistant" || v["type"]=="user" {
            who=if v["type"]=="assistant" {"agent"} else {"owner"}; text=content(&m["content"]);
            for b in m["content"].as_array().into_iter().flatten() {
                if b["type"]=="tool_use" { who="tool"; text+=&format!("\n{} {}",b["name"].as_str().unwrap_or("tool"),b["input"]); }
                if b["type"]=="tool_result" { who="tool result"; text+=&content(&b["content"]); }
            }
            if m["stop_reason"]=="end_turn" { status="idle"; }
        } else if v["type"]=="system" && v["subtype"]=="turn_duration" { status="idle"; }
        else { return None }
    } else {
        let p=&v["payload"];
        if v["type"]=="response_item" {
            match p["type"].as_str().unwrap_or("") {
                "message" => { who=match p["role"].as_str()? {"user"=>"owner","assistant"=>"agent",_=>return None}; text=content(&p["content"]); },
                "function_call"|"custom_tool_call" => {who="tool";text=format!("{} {}",p["name"].as_str().unwrap_or("tool"),p["arguments"].as_str().or(p["input"].as_str()).unwrap_or(""));},
                "function_call_output"|"custom_tool_call_output"=>{who="tool result";text=content(&p["output"]);},
                _=>return None
            }
        } else if v["type"]=="event_msg" {
            match p["type"].as_str().unwrap_or("") { "task_complete"|"turn_aborted"=>status="idle","task_started"=>{},_=>return None }
        } else { return None }
    }
    if text.len()>32_000 { let mut end=32_000; while !text.is_char_boundary(end) { end-=1; } text.truncate(end); text.push_str("\n[output truncated]"); }
    Some(json!({"who":who,"text":text,"status":status,"timestamp":v["timestamp"]}))
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn provider_events_and_private_reasoning() {
        assert!(event(&json!({"type":"response_item","payload":{"type":"reasoning","text":"private"}}),"codex").is_none());
        assert_eq!(event(&json!({"type":"event_msg","payload":{"type":"task_complete"}}),"codex").unwrap()["status"],"idle");
        assert_eq!(event(&json!({"type":"assistant","message":{"content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn"}}),"claude").unwrap()["text"],"hello");
    }
}
