//! Claude Code and Codex sessions on this Mac, live on the owner's board (live.rs).

use hive_tasks::live::{steps_of, tool_step, Live};
use serde_json::{json, Value};
use std::io::Write;

fn line(v: Value) -> String {
    format!("{v}\n")
}

#[test]
fn claude_code_lines_become_steps() {
    let asked = line(json!({"type": "user", "turnOrigin": "human", "timestamp": "2026-11-16T20:00:00Z",
        "message": {"role": "user", "content": "fix the agents count"}}));
    let said = line(json!({"type": "assistant", "timestamp": "2026-11-16T20:00:05Z",
        "message": {"content": [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "Looking at **the count**."}]}}));
    let did = line(json!({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Bash", "input": {"command": "git status\ngit log", "description": "x"}},
        {"type": "tool_use", "name": "Read", "input": {"file_path": "/tmp/a.rs"}},
        {"type": "tool_use", "name": "mcp__Claude_Browser__navigate", "input": {"url": "https://example.com"}}]}}));
    let failed = line(json!({"type": "user", "message": {"content": [
        {"type": "tool_result", "is_error": true, "content": "\nExit code 1\nmore"}]}}));
    let side = line(json!({"type": "assistant", "isSidechain": true, "message": {"content": [{"type": "text", "text": "x"}]}}));

    let a = steps_of("claude", &asked);
    assert_eq!(a.len(), 1);
    assert_eq!((a[0].1.as_str(), a[0].2.as_str()), ("asked", "fix the agents count"));
    let s = steps_of("claude", &said);
    assert_eq!(s.len(), 1);
    assert_eq!((s[0].1.as_str(), s[0].2.as_str()), ("say", "Looking at **the count**."));
    let d: Vec<String> = steps_of("claude", &did).into_iter().map(|s| s.2).collect();
    assert_eq!(d, ["$ git status …", "Read /tmp/a.rs", "navigate: https://example.com"]);
    let f = steps_of("claude", &failed);
    assert_eq!((f[0].1.as_str(), f[0].2.as_str()), ("failed", "Exit code 1"));
    assert!(steps_of("claude", &side).is_empty());
}

#[test]
fn codex_lines_become_steps() {
    let call = line(json!({"type": "response_item", "timestamp": "2026-11-16T20:00:00Z", "payload": {
        "type": "function_call", "name": "exec_command", "arguments": "{\"cmd\":\"cargo test\"}"}}));
    let mac = line(json!({"type": "response_item", "payload": {
        "type": "function_call", "namespace": "mac", "name": "click", "arguments": "{\"x\":3,\"y\":4}"}}));
    let patch = line(json!({"type": "response_item", "payload": {"type": "custom_tool_call", "name": "apply_patch",
        "input": "*** Begin Patch\n*** Update File: src/a.rs\n@@\n*** Add File: src/b.rs\n*** End Patch"}}));
    let said = line(json!({"type": "response_item", "payload": {"type": "message", "role": "assistant",
        "content": [{"type": "output_text", "text": "Done: the tests pass."}]}}));
    let thought = line(json!({"type": "response_item", "payload": {"type": "reasoning",
        "summary": [{"type": "summary_text", "text": "**Checking the hooks**"}]}}));
    let asked = line(json!({"type": "event_msg", "payload": {"type": "user_message", "message": "stream it"}}));
    let noise = line(json!({"type": "response_item", "payload": {"type": "message", "role": "user",
        "content": [{"type": "input_text", "text": "# AGENTS.md"}]}}));

    let texts = |l: &str| steps_of("codex", l).into_iter().map(|s| (s.1, s.2)).collect::<Vec<_>>();
    assert_eq!(texts(&call), [("action".into(), "$ cargo test".into())]);
    assert_eq!(texts(&mac), [("action".into(), "mac.click: x=3, y=4".into())]);
    assert_eq!(texts(&patch), [("action".into(), "Edit src/a.rs, src/b.rs".into())]);
    assert_eq!(texts(&said), [("say".into(), "Done: the tests pass.".into())]);
    assert_eq!(texts(&thought), [("think".into(), "**Checking the hooks**".into())]);
    assert_eq!(texts(&asked), [("asked".into(), "stream it".into())]);
    assert!(texts(&noise).is_empty());
    assert_eq!(tool_step("Grep", &json!({"pattern": "fn note", "path": "src"})), "Search for \"fn note\" in src");
}

#[test]
fn a_session_streams_as_one_run_working_then_done() {
    let dir = tempfile::tempdir().unwrap();
    let transcript = dir.path().join("s1.jsonl");
    std::fs::write(&transcript, line(json!({"type": "user", "turnOrigin": "human",
        "message": {"role": "user", "content": "the earlier ask"}})) + &line(json!({"type": "assistant",
        "message": {"content": [{"type": "text", "text": "old history"}]}}))).unwrap();
    let live = Live::open(&dir.path().join("live.sqlite3")).unwrap();
    let hook = |event: &str, extra: Value| {
        let mut input = json!({"session_id": "s1", "hook_event_name": event, "cwd": dir.path(),
            "transcript_path": transcript});
        for (k, v) in extra.as_object().unwrap() {
            input[k] = v.clone();
        }
        input
    };
    let mut posts: Vec<Value> = vec![];

    // First seen mid-turn: named by what the owner asked last, with none of its history.
    let mut other = hook("PreToolUse", json!({"tool_name": "Bash"}));
    other["session_id"] = json!("s0");
    assert!(live.note("claude", &other).unwrap());
    live.send("studio-mac", &mut |b| { posts.push(b.clone()); Ok(()) }).unwrap();
    assert_eq!((posts[0]["run"].as_str(), posts[0]["title"].as_str()), (Some("claude:s0"), Some("the earlier ask")));
    assert_eq!(posts[0]["steps"], json!([]));
    posts.clear();

    // The owner's message: a run, working, under their words; what came before is skipped.
    assert!(live.note("claude", &hook("UserPromptSubmit", json!({"prompt": "make it live"}))).unwrap());
    live.send("studio-mac", &mut |b| { posts.push(b.clone()); Ok(()) }).unwrap();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0]["run"], "claude:s1");
    assert_eq!(posts[0]["agent"], "claude");
    assert_eq!(posts[0]["machine"], "studio-mac");
    assert_eq!(posts[0]["title"], "make it live");
    assert_eq!(posts[0]["status"], "working");
    assert_eq!(posts[0]["steps"], json!([]));

    // What the agent writes to its transcript lands as numbered steps at the next hook.
    let mut f = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
    f.write_all(line(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "On it."},
        {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]}})).as_bytes()).unwrap();
    f.write_all(b"{\"type\": \"assistant\", \"partial").unwrap(); // still being written
    assert!(live.note("claude", &hook("PreToolUse", json!({"tool_name": "Bash"}))).unwrap());
    // Nothing new: nothing to send.
    assert!(!live.note("claude", &hook("PostToolUse", json!({"tool_name": "Bash"}))).unwrap());

    // The board is away: the steps wait for the next post.
    assert!(live.send("studio-mac", &mut |_| Err("away".into())).is_err());
    live.send("studio-mac", &mut |b| { posts.push(b.clone()); Ok(()) }).unwrap();
    assert_eq!(posts.len(), 2);
    let steps = posts[1]["steps"].as_array().unwrap();
    assert_eq!(steps.iter().map(|s| s["n"].as_i64().unwrap()).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(steps[0]["kind"], "say");
    assert_eq!(steps[1]["text"], "$ ls");

    // The rest of the line lands; the turn ends: done.
    f.write_all(b"}\n").unwrap();
    f.write_all(line(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "All set."}]}})).as_bytes()).unwrap();
    assert!(live.note("claude", &hook("Stop", json!({}))).unwrap());
    live.send("studio-mac", &mut |b| { posts.push(b.clone()); Ok(()) }).unwrap();
    assert_eq!(posts.len(), 3);
    assert_eq!(posts[2]["status"], "done");
    assert_eq!(posts[2]["title"], "make it live");
    assert_eq!(posts[2]["steps"].as_array().unwrap().iter().map(|s| s["n"].as_i64().unwrap()).collect::<Vec<_>>(), [3]);
    // Everything's sent.
    live.send("studio-mac", &mut |b| { posts.push(b.clone()); Ok(()) }).unwrap();
    assert_eq!(posts.len(), 3);

    // A notice the harness submits as a prompt isn't the owner's: the title stays.
    live.note("claude", &hook("UserPromptSubmit", json!({"prompt": "<task-notification>done</task-notification>"}))).unwrap();
    live.send("studio-mac", &mut |b| { posts.push(b.clone()); Ok(()) }).unwrap();
    assert_eq!(posts[3]["title"], "make it live");
    assert_eq!(posts[3]["status"], "working");
}
