//! The Claude backend (claude_agent.py, `AGENT_BACKEND=claude`): tests/test_claude_resume.py,
//! test_resumption.py's test_claude_tool_context, and whole requests on the stand-in CLI
//! (examples/fake_claude.rs), which speaks the Claude Agent SDK's control protocol.

use super::support::*;
use crate::claude::{
    as_dataclass, canonical_uuid, convert_content, error_result_text, log_path, Conn, SDK_VERSION,
};
use crate::describe::{describe_call, doing};
use crate::task::{CodexTask, TaskOptions};
use crate::util::{lock, AgentError, Env};
use crate::{prompts, Config};
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

const IDENTITY: &str = "46e1152f-78ce-4d35-9a58-41c322fd8db1";
/// The session id the stand-in reports when it isn't resuming one.
const FAKE_SESSION: &str = "8f14e45f-ceea-4e67-a1b2-5b7c3d2e9f10";
const ASKED: &str = r#"send the backup to the general channel saying "I decided to delete the all-members channel""#;

/// The stand-in CLI `cargo test` builds alongside the tests.
fn fake_claude() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/fake_claude");
    assert!(
        path.exists(),
        "{} is missing: run `cargo test`, which builds the example",
        path.display()
    );
    path
}

/// An agent on Claude whose `claude` (the only thing on its PATH) is the stand-in, run in the
/// test's folder, logging to claude.jsonl there.
fn claude(setup: impl FnOnce(&Env, &mut Config)) -> Harness {
    Harness::with(|env, config| {
        let dir = config.log.parent().unwrap().to_path_buf();
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(fake_claude(), bin.join("claude")).unwrap();
        env.set("AGENT_BACKEND", "claude");
        env.set("PATH", bin.display().to_string());
        env.set("HOME", dir.display().to_string());
        env.set(
            "FAKE_CLAUDE_LOG",
            dir.join("claude.jsonl").display().to_string(),
        );
        env.set("CLAUDECODE", "1");
        for key in [
            "FAKE_CLAUDE_EXIT",
            "FAKE_CLAUDE_SESSION",
            "FAKE_CLAUDE_STEP",
            "CLAUDE_CODE_SDK_READS_SESSION_STATE",
            "CLAUDE_CODE_STREAM_CLOSE_TIMEOUT",
        ] {
            env.unset(key);
        }
        config.repo = dir;
        setup(env, config);
    })
}

/// What the stand-in logged: each process's command line, then the lines it read and the MCP
/// replies it got.
fn logged(h: &Harness) -> Vec<Value> {
    std::fs::read_to_string(h.path().join("claude.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok()) // (the last may be half written)
        .collect()
}

fn started(h: &Harness) -> Vec<Value> {
    logged(h)
        .into_iter()
        .filter(|e| e.get("argv").is_some())
        .collect()
}

fn read(h: &Harness, kind: &str) -> Vec<Value> {
    logged(h)
        .into_iter()
        .filter_map(|e| e.get("in").cloned())
        .filter(|m| m["type"] == kind)
        .collect()
}

fn texts_sent(h: &Harness) -> Vec<String> {
    read(h, "user")
        .iter()
        .map(|m| {
            m["message"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

fn request(h: &Harness, text: &str) -> (Arc<CodexTask>, Events) {
    let events = Events::default();
    let task = CodexTask::new(
        &h.agent,
        text,
        TaskOptions {
            on_event: Some(events.on_event()),
            device: Some("mac".into()),
            ..TaskOptions::default()
        },
    );
    (task, events)
}

/// Runs a request to its end.
fn ask(h: &Harness, text: &str) -> (Arc<CodexTask>, Events) {
    let (task, events) = request(h, text);
    task.start(false);
    assert!(task.wait_done(20.0), "the request didn't end");
    ended(&events);
    (task, events)
}

/// Waits for the end's event (sent just after the task is done).
fn ended(events: &Events) {
    until(5.0, || {
        events
            .last()
            .is_some_and(|(kind, _)| kind == "done" || kind == "failed")
    });
}

fn said(events: &Events) -> Vec<String> {
    events
        .all()
        .into_iter()
        .filter(|(kind, _)| kind == "say")
        .map(|(_, text)| text)
        .collect()
}

/// Ends the conversation's process (the stand-in exits when its input closes).
fn finish(h: &Harness) {
    if let Some(session) = h.agent.claude_session() {
        session.close();
    }
}

fn args_for(h: &Harness, persistent: bool) -> Vec<String> {
    Conn::unconnected(&h.agent, persistent)
        .unwrap()
        .arguments(&h.agent)
        .unwrap()
}

fn system_prompt(h: &Harness) -> String {
    format!("{}\n\n{}", h.agent.instructions().unwrap(), prompts::RULES)
}

fn flag<'a>(args: &'a [String], name: &str) -> &'a str {
    let at = args.iter().position(|a| a == name).unwrap();
    &args[at + 1]
}

// -- the command line ----------------------------------------------------------------------------

#[test]
fn the_command_line_is_the_sdks() {
    let h = claude(|_, _| {});
    let tools = "Read,Edit,Write,Bash,Glob,Grep";
    let expected: Vec<String> = [
        "--output-format",
        "stream-json",
        "--verbose",
        "--system-prompt",
        &system_prompt(&h),
        "--tools",
        tools,
        "--allowedTools",
        &format!("{tools},mcp__mac__batch,mcp__mac__wait,mcp__phone__tap,mcp__phone__wait"),
        "--model",
        "claude-opus-5-5",
        "--mcp-config",
        r#"{"mcpServers": {"mac": {"type": "sdk", "name": "mac"}, "phone": {"type": "sdk", "name": "phone"}}}"#,
        "--include-partial-messages",
        "--strict-mcp-config",
        "--setting-sources=",
        "--effort",
        "low",
        "--input-format",
        "stream-json",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(args_for(&h, true), expected);
    // The tools were only listed.
    assert_eq!(h.mac.closed.load(Ordering::SeqCst), 1);
    assert!(lock(&h.mac.calls).is_empty());

    // A process of its own neither resumes nor saves the conversation.
    std::fs::write(h.path().join("claude-session-id"), format!("{IDENTITY}\n")).unwrap();
    let own = args_for(&h, false);
    assert_eq!(own[own.len() - 5], "--no-session-persistence");
    assert!(!own.iter().any(|a| a.starts_with("--resume")));

    h.agent.env.set("AGENT_FAST", "1");
    h.agent.env.set("AGENT_MODEL", "claude-haiku-5-5");
    h.agent.env.set("AGENT_EFFORT", "high");
    let args = args_for(&h, true);
    assert_eq!(flag(&args, "--model"), "claude-haiku-5-5");
    assert_eq!(flag(&args, "--effort"), "high");
    assert_eq!(flag(&args, "--settings"), r#"{"fastMode": true}"#);
    let resume = args
        .iter()
        .position(|a| a == &format!("--resume={IDENTITY}"));
    assert_eq!(resume, Some(11), "{args:?}");

    h.agent.env.set("AGENT_MODEL", "gpt-6.1-terra"); // not a Claude model
    assert_eq!(flag(&args_for(&h, true), "--model"), "claude-opus-5-5");
}

/// test_workspace_backend_is_configured_without_physical_display_fallback
#[test]
fn workspace_is_a_stdio_server_with_its_rules() {
    let h = claude(|env, _| env.set("AGENT_WORKSPACE_ENGINE", "/tmp/engine"));
    let args = args_for(&h, true);
    let config: Value = serde_json::from_str(flag(&args, "--mcp-config")).unwrap();
    let bridge = h.path().join("build/workspace-mcp-bridge");
    assert_eq!(
        config["mcpServers"]["workspace"],
        json!({"type": "stdio", "command": bridge.display().to_string(), "args": ["/tmp/engine"]})
    );
    assert!(flag(&args, "--allowedTools").ends_with(",mcp__workspace__*"));
    // (The Python test's "Do not silently fall back" is no longer in VIRTUAL_WORKSPACE_RULES.)
    let system = flag(&args, "--system-prompt");
    assert_eq!(
        system,
        format!("{}{}", system_prompt(&h), prompts::VIRTUAL_WORKSPACE_RULES)
    );
}

// -- the conversation's identity -----------------------------------------------------------------

#[test]
fn saved_identity_is_reloaded_and_not_replaced() {
    let h = claude(|_, _| {});
    let first = Conn::unconnected(&h.agent, true).unwrap();
    first.remember_session(Some(&json!(IDENTITY))).unwrap();
    let resumed = Conn::unconnected(&h.agent, true).unwrap();
    assert_eq!(resumed.session_id().as_deref(), Some(IDENTITY));
    assert!(resumed
        .arguments(&h.agent)
        .unwrap()
        .contains(&format!("--resume={IDENTITY}")));
    let changed = resumed.remember_session(Some(&json!("6fe43f03-0b88-43c0-8d17-f452fc2d8ea1")));
    assert!(
        matches!(&changed, Err(AgentError::Resume(m)) if m == "Claude session ID changed; refusing to replace the conversation"),
        "{changed:?}"
    );
    resumed
        .remember_session(Some(&json!(IDENTITY.to_uppercase())))
        .unwrap(); // the same one
    let path = h.path().join("claude-session-id");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        format!("{IDENTITY}\n")
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn invalid_saved_identity_fails_closed() {
    let h = claude(|_, _| {});
    std::fs::write(h.path().join("claude-session-id"), "invalid").unwrap();
    let error = Conn::unconnected(&h.agent, true).err();
    assert!(
        matches!(&error, Some(AgentError::Resume(m)) if m == "Invalid saved Claude session ID; refusing to replace the conversation")
    );
    // A request then fails, and the saved conversation is left alone.
    let (task, events) = ask(&h, "Open Notes");
    let log = h.path().join("claude.log");
    assert_eq!(
        events.last(),
        Some((
            "failed".into(),
            format!(
                "Claude: Invalid saved Claude session ID; refusing to replace the conversation (see {})",
                log.display()
            )
        ))
    );
    assert!(!task.running());
    assert!(started(&h).is_empty());
    assert_eq!(
        std::fs::read_to_string(h.path().join("claude-session-id")).unwrap(),
        "invalid"
    );
}

#[test]
fn an_invalid_returned_identity_is_refused() {
    let h = claude(|_, _| {});
    let conn = Conn::unconnected(&h.agent, true).unwrap();
    for value in [json!("not-a-uuid"), json!(7), Value::Null] {
        let error = conn.remember_session(Some(&value));
        assert!(
            matches!(&error, Err(AgentError::Resume(m)) if m == "Claude returned an invalid session ID")
        );
    }
    assert!(conn.remember_session(None).is_err());
    assert!(!h.path().join("claude-session-id").exists());
}

#[test]
fn secondary_session_does_not_replace_primary() {
    let h = claude(|_, _| {});
    let secondary = Conn::unconnected(&h.agent, false).unwrap();
    secondary.remember_session(Some(&json!(IDENTITY))).unwrap();
    secondary.remember_session(Some(&json!("junk"))).unwrap(); // not checked: nothing is saved
    assert!(!h.path().join("claude-session-id").exists());
}

#[test]
fn identities_are_canonical_uuids() {
    assert_eq!(canonical_uuid(IDENTITY).as_deref(), Some(IDENTITY));
    let braced = format!("{{{}}}", IDENTITY.to_uppercase());
    assert_eq!(canonical_uuid(&braced).as_deref(), Some(IDENTITY));
    let urn = format!("urn:uuid:{}", IDENTITY.replace('-', ""));
    assert_eq!(canonical_uuid(&urn).as_deref(), Some(IDENTITY));
    for bad in [
        "",
        "invalid",
        "46e1152f-78ce-4d35-9a58-41c322fd8db",
        "g6e1152f78ce4d359a5841c322fd8db1",
    ] {
        assert_eq!(canonical_uuid(bad), None, "{bad}");
    }
}

// -- tools ---------------------------------------------------------------------------------------

/// test_resumption.py's test_claude_tool_context
#[test]
fn claude_tool_context() {
    let h = claude(|_, _| {});
    let (task, _) = h.task("test");
    let result = json!({"content": [{"type": "image", "mimeType": "image/png", "data": "QUJD"}]});
    *lock(&h.mac.result) = Some(Ok(result.clone()));
    lock(&task.tools).insert("mac".into(), h.mac.clone());
    assert_eq!(
        crate::claude::call_tool(&task, "mac", "screenshot", &json!({})),
        result
    );
    let kinds: Vec<String> = h.context.all().into_iter().map(|r| r.kind).collect();
    assert_eq!(kinds, ["Claude tool input", "Claude tool output"]);
    assert_eq!(
        h.context.all()[0].payload,
        json!({"namespace": "mac", "tool": "screenshot", "arguments": {}})
    );

    let text = |v: Value| v["content"][0]["text"].as_str().unwrap().to_owned();
    *lock(&h.mac.result) = Some(Err("no screen".into()));
    let failed = crate::claude::call_tool(&task, "mac", "screenshot", &json!({}));
    assert_eq!(text(failed.clone()), "Failed: no screen");
    assert_eq!(failed["isError"], json!(true));
    assert_eq!(
        text(crate::claude::call_tool(&task, "phone", "tap", &json!({}))),
        "There are no phone tools."
    );
    task.st().stopped = true;
    assert_eq!(
        text(crate::claude::call_tool(&task, "mac", "batch", &json!({}))),
        "Stopped by the user."
    );
}

#[test]
fn the_in_process_mcp_servers_answer_as_the_sdks() {
    let h = claude(|_, _| {});
    let conn = Conn::unconnected(&h.agent, false).unwrap();
    let reply = |request: Value| conn.control_reply(&request);
    let mcp = |server: &str, message: Value| {
        reply(json!({"subtype": "mcp_message", "server_name": server, "message": message})).unwrap()
            ["mcp_response"]
            .clone()
    };
    assert_eq!(
        reply(json!({"subtype": "can_use_tool"})),
        Err("canUseTool callback is not provided".into())
    );
    assert_eq!(
        reply(json!({"subtype": "hook_callback", "callback_id": "hook_0"})),
        Err("No hook callback found for ID: hook_0".into())
    );
    assert_eq!(
        reply(json!({"subtype": "mcp_message", "message": {"method": "ping"}})),
        Err("Missing server_name or message for MCP request".into())
    );
    assert_eq!(
        reply(json!({"subtype": "rewind"})),
        Err("Unsupported control request subtype: rewind".into())
    );
    assert_eq!(
        mcp(
            "mac",
            json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                          "params": {"protocolVersion": "1999-01-01"}})
        ),
        json!({"jsonrpc": "2.0", "id": 0, "result": {"protocolVersion": "2025-11-25",
               "capabilities": {"tools": {"listChanged": false}}, "serverInfo": {"name": "mac", "version": "1.0.0"}}})
    );
    assert_eq!(
        mcp(
            "phone",
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
        ),
        json!({"jsonrpc": "2.0", "result": {}})
    );
    assert_eq!(
        mcp(
            "phone",
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        ),
        json!({"jsonrpc": "2.0", "id": 1, "result": {}})
    );
    assert_eq!(
        mcp(
            "phone",
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        )["result"]["tools"],
        json!([{"name": "tap", "description": "tap.", "inputSchema": {"type": "object"}},
               {"name": "wait", "description": "wait.", "inputSchema": {"type": "object"}}])
    );
    assert_eq!(
        mcp(
            "phone",
            json!({"jsonrpc": "2.0", "id": 3, "method": "resources/list"})
        ),
        json!({"jsonrpc": "2.0", "id": 3, "error": {"code": -32601, "message": "Method not found"}})
    );
    assert_eq!(
        mcp(
            "workspace",
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/list"})
        ),
        json!({"jsonrpc": "2.0", "id": 4, "error": {"code": -32601, "message": "Server 'workspace' not found"}})
    );
    let call = |name: &str| {
        mcp(
            "mac",
            json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                          "params": {"name": name, "arguments": {}}}),
        )["result"]
            .clone()
    };
    assert_eq!(
        call("zap"),
        json!({"content": [{"type": "text", "text": "Tool 'zap' not found"}], "isError": true})
    );
    assert_eq!(
        call("batch"),
        json!({"content": [{"type": "text", "text": "No task."}], "isError": true})
    );
}

#[test]
fn tool_results_become_mcp_content() {
    let content = json!([
        {"type": "text", "text": "hi", "annotations": {}},
        {"type": "image", "mimeType": "image/png", "data": "QUJD"},
        {"type": "resource_link", "name": "notes", "uri": "file:///notes", "description": ""},
        {"type": "resource_link"},
        {"type": "resource", "resource": {"uri": "file:///a", "text": "body"}},
        {"type": "resource", "resource": {"uri": "file:///b", "blob": "QUJD"}},
        {"type": "audio", "data": "QUJD"}
    ]);
    assert_eq!(
        convert_content(Some(&content)),
        json!([{"type": "text", "text": "hi"},
               {"type": "image", "data": "QUJD", "mimeType": "image/png"},
               {"type": "text", "text": "notes\nfile:///notes"},
               {"type": "text", "text": "Resource link"},
               {"type": "text", "text": "body"}])
    );
    assert_eq!(convert_content(None), json!([]));
}

#[test]
fn error_results_say_why() {
    let text = |m: Value| error_result_text(&m);
    assert_eq!(
        text(json!({"errors": ["a", " ", "b"], "result": "r"})),
        "a; b"
    );
    assert_eq!(text(json!({"errors": [], "result": "  r  "})), "r");
    assert_eq!(
        text(json!({"subtype": "error_max_turns"})),
        "error_max_turns"
    );
    assert_eq!(
        text(json!({"subtype": "success", "api_error_status": 529})),
        "API error (HTTP 529)"
    );
    assert_eq!(text(json!({"subtype": "success"})), "unknown error");
}

#[test]
fn messages_are_recorded_as_the_sdks_dataclasses() {
    let (name, fields) = as_dataclass(&json!({"type": "assistant", "session_id": "s", "uuid": "u",
        "message": {"id": "msg_1", "model": "m", "content": [{"type": "text", "text": "Hi"},
                    {"type": "tool_use", "id": "t", "name": "Bash", "input": {}}, {"type": "mystery"}]}}))
    .unwrap();
    assert_eq!(name, "AssistantMessage");
    assert_eq!(
        fields,
        json!({"content": [{"text": "Hi"}, {"id": "t", "name": "Bash", "input": {}}], "model": "m",
               "parent_tool_use_id": null, "error": null, "usage": null, "message_id": "msg_1",
               "stop_reason": null, "session_id": "s", "uuid": "u"})
    );
    let (name, fields) =
        as_dataclass(&json!({"type": "system", "subtype": "init", "session_id": "s"})).unwrap();
    assert_eq!(name, "SystemMessage");
    assert_eq!(
        fields,
        json!({"subtype": "init", "data": {"type": "system", "subtype": "init", "session_id": "s"}})
    );
    let (name, fields) = as_dataclass(&json!({"type": "result", "subtype": "success", "is_error": false,
                                               "usage": {"output_tokens": 3}, "modelUsage": {"m": {}}}))
    .unwrap();
    assert_eq!(name, "ResultMessage");
    assert_eq!(fields["model_usage"], json!({"m": {}}));
    assert_eq!(fields["usage"], json!({"output_tokens": 3}));
    assert!(as_dataclass(&json!({"type": "stream_event"})).is_none());
    assert!(as_dataclass(&json!({"type": "keep_alive"})).is_none());
}

// -- requests on the stand-in CLI ----------------------------------------------------------------

#[test]
fn a_request_runs_its_tools_and_says_each_sentence() {
    let h = claude(|_, _| {});
    let (task, events) = ask(&h, "Open Notes");
    finish(&h);

    assert_eq!(
        events.last(),
        Some(("done".into(), "Done. It is open now.".into()))
    );
    assert_eq!(task.final_text().as_deref(), Some("Done. It is open now."));
    assert_eq!(
        said(&events),
        ["Opening it now.", "Done.", "It is open now."]
    );
    let input = json!({"steps": [{"tool": "open_app", "name": "Notes"}], "step": "Opening Notes."});
    let batch = json!({"tool": "batch", "namespace": "mac", "arguments": input});
    let shell = json!({"tool": "Bash", "namespace": "", "arguments": {"command": "ls", "description": "List files"}});
    let knowledge = TestKnowledge;
    assert!(events.has("action", &describe_call(&batch, &knowledge)));
    assert!(events.has("action", &describe_call(&shell, &knowledge)));
    assert!(events.has("doing", "Opening Notes.")); // the agent's own step
    assert!(events.has("doing", &doing(&json!({"tool": "batch", "arguments": {}}))));
    assert!(events.has("error", "ls: boom"));
    assert!(!events.all().iter().any(|(kind, _)| kind == "announce"));
    assert_eq!(events.all()[0], ("doing".into(), "Thinking".into()));

    // The Mac's tools ran the batch, knowing what the user said; the shell let go of the mouse.
    assert_eq!(*lock(&h.mac.calls), [("batch".to_owned(), input)]);
    assert_eq!(*lock(&h.mac.words), "Open Notes");
    until(5.0, || h.mac.let_go.load(Ordering::SeqCst) == 1);
    until(5.0, || h.mac.closed.load(Ordering::SeqCst) >= 2); // listed, then closed after the task

    {
        let s = task.st();
        assert_eq!(s.wrote, 42);
        assert_eq!(s.model_calls, 2); // not the subagent's
        assert!(s.on_thread);
    }
    assert_eq!(task.calls_to_words(), 2); // its first words were in the first call
    assert_eq!(
        std::fs::read_to_string(h.path().join("claude-session-id")).unwrap(),
        format!("{FAKE_SESSION}\n")
    );

    // The context inspector got the request and each message as the SDK's dataclasses.
    let records = h.context.all();
    let kinds: Vec<&str> = records
        .iter()
        .map(|r| r.kind.as_str())
        .filter(|k| !k.starts_with("Claude tool"))
        .collect();
    assert_eq!(
        kinds,
        [
            "Claude request",
            "SystemMessage",
            "AssistantMessage",
            "UserMessage",
            "AssistantMessage",
            "RateLimitEvent",
            "ResultMessage"
        ]
    );
    let tool_records: Vec<&str> = records
        .iter()
        .map(|r| r.kind.as_str())
        .filter(|k| k.starts_with("Claude tool"))
        .collect();
    assert_eq!(tool_records, ["Claude tool input", "Claude tool output"]);
    let request = &records[0].payload;
    assert_eq!(request["system_prompt"], json!(system_prompt(&h)));
    let text = request["content"][0]["text"].as_str().unwrap();
    let prompt = task.st().prompt.clone();
    assert!(text.starts_with(&prompt));
    assert!(text.ends_with(prompts::STEP_HINT));
    assert_eq!(texts_sent(&h), [text]);
    let rate = records.iter().find(|r| r.kind == "RateLimitEvent").unwrap();
    assert_eq!(
        rate.payload["rate_limit_info"]["rate_limit_type"],
        "five_hour"
    );

    // How it was started.
    let start = &started(&h)[0];
    assert_eq!(
        start["argv"],
        json!(args_for(&h, false)
            .iter()
            .filter(|a| *a != "--no-session-persistence")
            .collect::<Vec<_>>())
    );
    assert_eq!(
        start["env"],
        json!({"CLAUDE_CODE_ENTRYPOINT": "sdk-py", "CLAUDE_AGENT_SDK_VERSION": SDK_VERSION, "CLAUDECODE": null,
               "CLAUDE_CODE_SDK_READS_SESSION_STATE": "1", "PWD": h.path().display().to_string()})
    );
    let cwd = Path::new(start["cwd"].as_str().unwrap())
        .canonicalize()
        .unwrap();
    assert_eq!(cwd, h.path().canonicalize().unwrap());

    // The protocol: initialize first, then the user message.
    let controls = read(&h, "control_request");
    assert_eq!(
        controls[0]["request"],
        json!({"subtype": "initialize", "hooks": null, "skills": []})
    );
    let id = controls[0]["request_id"].as_str().unwrap();
    assert!(id.starts_with("req_1_") && id.len() == 14, "{id}");
    let user = &read(&h, "user")[0];
    assert_eq!(user["parent_tool_use_id"], Value::Null);
    assert_eq!(user["session_id"], "default");
    assert_eq!(user["message"]["role"], "user");
    let replies: Vec<Value> = logged(&h)
        .into_iter()
        .filter_map(|e| e.get("mcp").cloned())
        .collect();
    assert_eq!(replies.len(), 4);
    assert_eq!(
        replies[0]["response"]["result"]["protocolVersion"],
        "2025-06-18"
    );
    assert_eq!(
        replies[1]["response"],
        json!({"jsonrpc": "2.0", "result": {}})
    );
    assert_eq!(
        replies[3]["response"],
        json!({"jsonrpc": "2.0", "id": 2, "result": {"content": [{"type": "text", "text": "Done."}], "isError": false}})
    );

    // The Claude log beside Codex's.
    let log = std::fs::read_to_string(h.path().join("claude.log")).unwrap();
    assert!(log.starts_with(
        "\n=== mac: Open Notes  (claude-opus-5-5, low effort, on your Claude subscription)\n"
    ));
    assert!(log.contains("say: Opening it now.\n"));
    assert!(log.contains("done: Done. It is open now.\n"));
}

#[test]
fn the_conversation_keeps_its_process() {
    let h = claude(|_, _| {});
    ask(&h, "Open Notes");
    let (second, events) = ask(&h, "Close it");
    finish(&h);
    assert_eq!(
        events.last(),
        Some(("done".into(), "Done. It is open now.".into()))
    );
    assert!(second.on_thread());
    assert_eq!(started(&h).len(), 1);
    let texts = texts_sent(&h);
    assert_eq!(texts.len(), 2);
    assert!(!texts[1].contains("Also said")); // it saw the first
    assert_eq!(read(&h, "control_request").len(), 1);
}

#[test]
fn a_new_agent_resumes_the_saved_conversation() {
    let h = claude(|_, _| {});
    ask(&h, "Open Notes");
    finish(&h);
    let again = h.again(|env, config| {
        env.set("AGENT_BACKEND", "claude");
        env.set("PATH", h.path().join("bin").display().to_string());
        env.set(
            "FAKE_CLAUDE_LOG",
            h.path().join("claude.jsonl").display().to_string(),
        );
        config.repo = h.path().to_path_buf();
    });
    let (_, events) = ask(&again, "Close it");
    finish(&again);
    assert_eq!(events.last().unwrap().0, "done");
    let starts = started(&h);
    assert_eq!(starts.len(), 2);
    assert!(starts[1]["argv"]
        .as_array()
        .unwrap()
        .contains(&json!(format!("--resume={FAKE_SESSION}"))));
}

#[test]
fn a_changed_identity_fails_the_request() {
    let h = claude(|_, _| {});
    std::fs::write(h.path().join("claude-session-id"), format!("{IDENTITY}\n")).unwrap();
    h.agent.env.set("FAKE_CLAUDE_SESSION", FAKE_SESSION);
    let (_, events) = ask(&h, "Open Notes");
    finish(&h);
    assert_eq!(
        events.last(),
        Some((
            "failed".into(),
            format!(
                "Claude: Claude session ID changed; refusing to replace the conversation (see {})",
                h.path().join("claude.log").display()
            )
        ))
    );
    assert_eq!(
        std::fs::read_to_string(h.path().join("claude-session-id")).unwrap(),
        format!("{IDENTITY}\n")
    );
}

#[test]
fn stop_interrupts_the_turn() {
    let h = claude(|_, _| {});
    let (task, events) = request(&h, "SLOW: open Notes");
    task.start(false);
    until(10.0, || events.has("say", "Working on it."));
    task.stop();
    assert_eq!(events.last(), Some(("failed".into(), "stopped".into())));
    assert_eq!(task.final_text(), None);
    until(10.0, || {
        read(&h, "control_request")
            .iter()
            .any(|m| m["request"] == json!({"subtype": "interrupt"}))
    });
    // The next request waits for the stopped turn to end, then has the process.
    let (next, events) = ask(&h, "Open Notes");
    finish(&h);
    assert_eq!(
        events.last(),
        Some(("done".into(), "Done. It is open now.".into()))
    );
    assert!(next.on_thread());
    assert_eq!(started(&h).len(), 1);
    let events = events.all();
    assert_eq!(events.iter().filter(|(k, _)| k == "done").count(), 1);
}

#[test]
fn a_stop_before_the_turn_sends_nothing() {
    let h = claude(|_, _| {});
    let (task, events) = request(&h, "Open Notes");
    task.stop();
    assert_eq!(events.last(), Some(("failed".into(), "stopped".into())));
    assert!(read(&h, "control_request").is_empty());
}

#[test]
fn said_before_tells_a_process_what_it_has_not_seen() {
    let h = claude(|_, _| {});
    let session = h.agent.claude_session().unwrap();
    let make = |text: &str| {
        let task = CodexTask::new(&h.agent, text, TaskOptions::default());
        crate::session::TaskSession::add(session.as_ref(), &task);
        task
    };
    let first = make("first");
    first.st().final_ = Some("Did it.".into());
    first.set_on_thread(true);
    first.finish("done", "Did it.", None);
    let second = make("second \"quoted\"");
    second.finish("failed", "stopped", None);
    let third = make("third");
    let everything = format!(
        "{}  They asked: \"first\"\n  You: \"Did it.\"\n  They asked: \"second \\\"quoted\\\"\"\n  You: (stopped before finishing)\n\n",
        prompts::SAID_BEFORE
    );
    assert_eq!(session.said_before(&third, true), everything);
    assert!(!second.told());
    let unseen = format!(
        "{}  They asked: \"second \\\"quoted\\\"\"\n  You: (stopped before finishing)\n\n",
        prompts::SAID_BEFORE
    );
    assert_eq!(session.said_before(&third, false), unseen);
    assert!(second.told());
    assert_eq!(session.said_before(&third, false), "");
    assert_eq!(session.said_before(&first, true), "");
    let stranger = CodexTask::new(&h.agent, "elsewhere", TaskOptions::default());
    assert_eq!(session.said_before(&stranger, true), "");
}

#[test]
fn a_request_during_another_gets_its_own_process() {
    let h = claude(|_, _| {});
    let (slow, _) = request(&h, "SLOW: open Notes");
    slow.start(false);
    until(10.0, || texts_sent(&h).len() == 1);
    let (other, events) = ask(&h, "What's on the phone?");
    assert_eq!(
        events.last(),
        Some(("done".into(), "Done. It is open now.".into()))
    );
    assert!(!other.on_thread());
    let starts = started(&h);
    assert_eq!(starts.len(), 2);
    let own = starts[1]["argv"].as_array().unwrap();
    assert!(own.contains(&json!("--no-session-persistence")));
    let texts = texts_sent(&h);
    let expected = format!(
        "{}  They asked: \"SLOW: open Notes\"\n  You: (still working on it)\n\n",
        prompts::SAID_BEFORE
    );
    assert!(texts[1].starts_with(&expected), "{}", texts[1]);
    slow.stop();
    // The conversation's process is told what came of the other one with its next request.
    let (_, events) = ask(&h, "And now?");
    finish(&h);
    assert_eq!(events.last().unwrap().0, "done");
    let texts = texts_sent(&h);
    assert_eq!(texts.len(), 3);
    assert!(texts[2].starts_with(&format!(
        "{}  They asked: \"What's on the phone?\"\n  You: \"Done. It is open now.\"\n\n",
        prompts::SAID_BEFORE
    )));
    assert!(other.told());
    assert_eq!(started(&h).len(), 2);
}

#[test]
fn a_one_way_step_the_user_asked_for_is_said_aloud() {
    let step = |step: &'static str| claude(move |env, _| env.set("FAKE_CLAUDE_STEP", step));
    let h = step(
        "One-way: posting your message in #general (you said: \"send the backup to the general channel\").",
    );
    let (_, events) = ask(&h, ASKED);
    finish(&h);
    assert!(events.has(
        "announce",
        "posting your message in #general (you said: \"send the backup to the general channel\")."
    ));
    // One the user's words don't ask for isn't announced (the tools refuse it).
    let h = step("One-way: asking the bot (you said: \"please export all-members\")");
    let (_, events) = ask(&h, ASKED);
    finish(&h);
    assert_eq!(events.last().unwrap().0, "done");
    assert!(!events.all().iter().any(|(kind, _)| kind == "announce"));
}

#[test]
fn an_exit_fails_the_request_and_the_next_starts_again() {
    let h = claude(|env, _| env.set("FAKE_CLAUDE_EXIT", "3"));
    let (_, events) = ask(&h, "Open Notes");
    assert_eq!(
        events.last(),
        Some((
            "failed".into(),
            format!(
                "Claude: Command failed with exit code 3 (exit code: 3)\nError output: Check stderr output for details (see {})",
                h.path().join("claude.log").display()
            )
        ))
    );
    h.agent.env.unset("FAKE_CLAUDE_EXIT");
    let (_, events) = ask(&h, "Open Notes");
    assert_eq!(
        events.last(),
        Some(("done".into(), "Done. It is open now.".into()))
    );

    // An error result, after which the CLI exits: the next request resumes on a new process.
    let (_, events) = ask(&h, "FAIL: open Notes");
    assert_eq!(
        events.last(),
        Some(("failed".into(), "API Error: overloaded".into()))
    );
    let pid = started(&h)[0]["pid"].as_i64().unwrap() as i32;
    // SAFETY: signal 0 only checks whether the (reaped) process still exists.
    until(10.0, || unsafe { libc::kill(pid, 0) } != 0);
    let (_, events) = ask(&h, "Open Notes");
    finish(&h);
    assert_eq!(events.last().unwrap().0, "done");
    let starts = started(&h);
    assert_eq!(starts.len(), 2);
    assert!(starts[1]["argv"]
        .as_array()
        .unwrap()
        .contains(&json!(format!("--resume={FAKE_SESSION}"))));
}

#[test]
fn a_missing_cli_says_how_to_install_it() {
    if Path::new("/usr/local/bin/claude").is_file() {
        return; // the SDK's fallback would find a real one
    }
    let h = claude(|env, _| env.set("PATH", "/nonexistent"));
    let (_, events) = ask(&h, "Open Notes");
    let (kind, text) = events.last().unwrap();
    assert_eq!(kind, "failed");
    assert!(
        text.starts_with("Claude: Claude Code not found. Install with:\n  npm install -g @anthropic-ai/claude-code\n"),
        "{text}"
    );
}

// -- the switch ----------------------------------------------------------------------------------

#[test]
fn agent_backend_chooses_claude() {
    let codex = Harness::new();
    assert_eq!(codex.agent.backend(), "codex");
    assert!(codex.agent.claude_session().is_none());
    assert_eq!(codex.agent.describe_model(), "gpt-6.1-terra, low effort");
    let (task, _) = request(&codex, "Open Notes");
    assert!(task.session().claude().is_none());

    let h = claude(|env, _| env.set("AGENT_BACKEND", "Claude"));
    assert_eq!(h.agent.backend(), "claude");
    assert_eq!(
        h.agent.describe_model(),
        "claude-opus-5-5, low effort, on your Claude subscription"
    );
    h.agent.env.set("AGENT_FAST", "1");
    h.agent.env.set("AGENT_MODEL", "claude-haiku-5-5");
    h.agent.env.set("AGENT_EFFORT", "medium");
    assert_eq!(
        h.agent.describe_model(),
        "claude-haiku-5-5, medium effort, fast mode, on your Claude subscription"
    );
    for key in ["AGENT_FAST", "AGENT_MODEL", "AGENT_EFFORT"] {
        h.agent.env.unset(key);
    }
    let (task, _) = request(&h, "Open Notes");
    let session = h.agent.claude_session().unwrap();
    assert!(Arc::ptr_eq(&task.session().claude().unwrap(), &session));
    assert_eq!(
        log_path(Path::new("/tmp/x/agent-vhid-codex.log")),
        Path::new("/tmp/x/agent-vhid-claude.log")
    );

    // Listening starts the process; Codex is never started.
    assert!(h.agent.new_session());
    until(10.0, || started(&h).len() == 1);
    h.agent.warm_up();
    assert!(h.agent.running_server().is_none());
    let (slow, _) = request(&h, "SLOW: open Notes");
    slow.start(false);
    until(10.0, || texts_sent(&h).len() == 1);
    assert!(!h.agent.new_session()); // busy
    slow.stop();
    assert!(h.agent.new_session());
    h.agent.stop_server();
    finish(&h);
    assert_eq!(started(&h).len(), 1);
}

// -- the real CLI --------------------------------------------------------------------------------

/// One request on the real `claude` (logged in), with fake devices: `HIVE_LIVE_CLAUDE=1 cargo test
/// -p hive-codex live_claude -- --ignored --nocapture`.
#[test]
#[ignore]
fn live_claude_replies() {
    if std::env::var("HIVE_LIVE_CLAUDE").as_deref() != Ok("1") {
        return;
    }
    let h = Harness::with(|env, config| {
        env.set("AGENT_BACKEND", "claude");
        env.set("AGENT_MODEL", "claude-haiku-5-5");
        config.repo = config.log.parent().unwrap().to_path_buf();
    });
    let (task, events) = request(&h, "Reply with just OK");
    task.set_prompt("Reply with just OK");
    task.start(false);
    let finished = task.wait_done(180.0);
    if finished {
        ended(&events);
    }
    finish(&h);
    for (kind, text) in events.all() {
        println!("{kind}: {text}");
    }
    println!("{}", task.describe_times());
    assert!(finished);
    assert_eq!(events.last().unwrap().0, "done");
    assert!(lock(&h.mac.calls).is_empty() && lock(&h.phone.calls).is_empty());
}
