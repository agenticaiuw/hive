//! What Agent.app and Codex talk to: `hive-agent`'s stdin lines and help, the ⏱ timing line, and
//! `hive-auth-mcp` (python/authentication_mcp.py). The binaries run only where they do nothing
//! (help, and the MCP server's handshake): `hive-agent` itself would start Codex.

mod support;

use hive_app::app::{app_line, menu_stop, TASK_USAGE, USAGE};
use hive_app::{describe_timing, Event, Timing};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use support::{lock, FakeTask, Isolated};

fn kind(event: Option<Event>) -> Option<String> {
    event.map(|e| match e {
        Event::Ingest(path) => format!("ingest {path}"),
        Event::Input(mode) => format!("input {mode}"),
        Event::Speak(on) => format!("speak {on}"),
        Event::Window(on) => format!("window {on}"),
        other => other.kind().to_owned(),
    })
}

#[test]
fn the_apps_menu_lines() {
    assert_eq!(kind(app_line("toggle\n")).as_deref(), Some("toggle"));
    assert_eq!(
        kind(app_line("ingest /tmp/a b.txt")).as_deref(),
        Some("ingest /tmp/a b.txt")
    );
    assert_eq!(kind(app_line("input lips")).as_deref(), Some("input lips"));
    assert_eq!(
        kind(app_line("input voice")).as_deref(),
        Some("input voice")
    );
    assert_eq!(kind(app_line("speak off")).as_deref(), Some("speak false"));
    assert_eq!(kind(app_line("speak on\n")).as_deref(), Some("speak true"));
    assert_eq!(
        kind(app_line("window off")).as_deref(),
        Some("window false")
    );
    assert_eq!(kind(app_line("window on")).as_deref(), Some("window true"));
    assert_eq!(kind(app_line("speak loudly")), None);
    assert_eq!(kind(app_line("")), None);
    assert_eq!(kind(app_line("quit now")), None);
    // Quit Agent and Restart Agent are said in the log and the journal before it stops
    assert_eq!(menu_stop("quit\n"), Some("quit from the menu"));
    assert_eq!(menu_stop("restart"), Some("restart from the menu"));
    assert_eq!(menu_stop("quit now"), None);
}

/// A task with Codex's times (seconds after it began). The times are picked so no rounding is a tie.
fn timed(ahead: bool, times: &[(&str, f64)]) -> std::sync::Arc<FakeTask> {
    let task = FakeTask::new("Open Calculator", "mac");
    task.looked_ahead.store(ahead, Ordering::SeqCst);
    *lock(&task.times) = times.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    task
}

fn heard(task: &FakeTask, stopped: f64, decided: f64, written: f64) -> BTreeMap<String, f64> {
    let b = task.began;
    [
        ("stopped", b - stopped),
        ("decided", b - decided),
        ("written", b - written),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect()
}

#[test]
fn where_the_time_went() {
    let task = timed(true, &[("look", 0.25), ("codex", 0.625), ("words", 2.1875)]);
    let mut timing = Timing::new(task.as_task(), Some(&heard(&task, 1.0, 0.1875, 0.0625)));
    timing.queued = true;
    timing.spoken = true;
    timing.answered = Some(task.began + 2.625);
    assert_eq!(
        describe_timing(&timing),
        "⏱  3.6 s from when you stopped talking to hearing its reply: 0.8 s to be sure you'd finished, 0.1 s \
         writing it down, screenshot ready (taken as you talked), 0.4 s for Codex to start, 1.6 s for Codex's \
         first words (1 model call), 0.4 s for the voice to start"
    );
}

#[test]
fn where_the_time_went_when_the_reply_was_shown() {
    // its screenshot taken after you'd finished; the reply shown, not said
    let task = timed(false, &[("look", 0.4375), ("words", 1.5)]);
    let timing = Timing::new(task.as_task(), Some(&heard(&task, 1.5625, 0.75, 0.3125)));
    assert_eq!(
        describe_timing(&timing),
        "⏱  3.1 s from when you stopped talking to seeing its reply: 0.8 s to be sure you'd finished, 0.4 s \
         writing it down, 0.3 s before the task started, 0.4 s for the screenshot, 1.1 s for Codex's first words \
         (1 model call)"
    );
}

#[test]
fn a_typed_request_is_timed_from_when_it_began() {
    let task = timed(false, &[("codex", 0.0625), ("words", 0.8125)]);
    let timing = Timing::new(task.as_task(), None);
    assert_eq!(
        describe_timing(&timing),
        "⏱  0.8 s from when you stopped talking to seeing its reply: 0.8 s for Codex's first words (1 model call)"
    );
}

// -- hive-auth-mcp --

#[test]
fn the_authentication_tools_in_order() {
    let names: Vec<Value> = hive_app::auth_mcp::tools()
        .into_iter()
        .map(|t| t["name"].clone())
        .collect();
    assert_eq!(
        names,
        [
            json!("authenticate_mac"),
            json!("authenticate_phone"),
            json!("read_selected_text")
        ]
    );
}

#[test]
fn an_unknown_authentication_tool() {
    let reply = hive_app::auth_mcp::call("authenticate_watch", &json!({})).unwrap();
    assert_eq!(reply["isError"], true);
    assert_eq!(reply["content"][0]["text"], "Unknown authentication tool.");
}

#[test]
fn hive_auth_mcp_serves_its_tools_over_stdio() {
    let env = Isolated::new();
    let mut server = Command::new(env!("CARGO_BIN_EXE_hive-auth-mcp"))
        .env("AGENT_ENV_FILE", "/dev/null")
        .env("AGENT_STATE_DIR", env.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("hive-auth-mcp starts");
    let mut stdin = server.stdin.take().unwrap();
    for message in [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
    ] {
        writeln!(stdin, "{message}").unwrap();
    }
    drop(stdin); // Codex is done with it
    let replies: Vec<Value> = BufReader::new(server.stdout.take().unwrap())
        .lines()
        .map(|l| serde_json::from_str(&l.unwrap()).unwrap())
        .collect();
    assert!(server.wait().unwrap().success());
    assert_eq!(replies.len(), 2, "{replies:?}");
    assert_eq!(
        replies[0]["result"]["serverInfo"]["name"],
        "agent-authentication"
    );
    let names: Vec<&Value> = replies[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| &t["name"])
        .collect();
    assert_eq!(
        names,
        [
            &json!("authenticate_mac"),
            &json!("authenticate_phone"),
            &json!("read_selected_text")
        ]
    );
}

// -- hive-agent's help (anything else starts Codex) --

fn hive_agent(args: &[&str]) -> (bool, String) {
    let env = Isolated::new();
    let out = Command::new(env!("CARGO_BIN_EXE_hive-agent"))
        .args(args)
        .env("AGENT_ENV_FILE", "/dev/null")
        .env("AGENT_STATE_DIR", env.path())
        .stdin(Stdio::null())
        .output()
        .expect("hive-agent runs");
    (out.status.success(), String::from_utf8(out.stdout).unwrap())
}

#[test]
fn hive_agent_help() {
    assert_eq!(hive_agent(&["--help"]), (true, USAGE.to_owned()));
    assert_eq!(hive_agent(&["--no-speak", "-h"]), (true, USAGE.to_owned()));
    assert!(USAGE.contains("hive-agent --task \"make a new note in Notes that says buy milk\""));
}

#[test]
fn hive_agent_task_help() {
    assert_eq!(
        hive_agent(&["--task", "--help"]),
        (true, TASK_USAGE.to_owned())
    );
    assert_eq!(hive_agent(&["--task"]), (true, TASK_USAGE.to_owned())); // no task: how to give one
}
