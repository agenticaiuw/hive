//! hive-ask, the direct channel's command (src/bin/hive-ask.rs), against a stand-in for Hive: a
//! request socket that answers as Hive's does, and a live file written as Hive's shell writes it.

use hive_app::live::Live;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const RECEIPT: &str = "fedcba9876543210fedcba9876543210";

/// Answers one request with `reply`, then (if it was accepted) writes `events` to its live file,
/// a little apart. What was sent is kept.
fn fake_hive(
    state: &Path,
    reply: Value,
    events: Vec<(&'static str, &'static str)>,
) -> Arc<Mutex<Option<Value>>> {
    let control = state.join("control");
    std::fs::create_dir_all(&control).unwrap();
    let listener = UnixListener::bind(control.join("request.sock")).unwrap();
    let sent = Arc::new(Mutex::new(None));
    let seen = sent.clone();
    let live = Live::at(control.join("live"));
    thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).unwrap();
        *seen.lock().unwrap() = serde_json::from_str(line.trim()).ok();
        let mut stream = stream;
        stream.write_all(format!("{reply}\n").as_bytes()).unwrap();
        drop(stream);
        for (kind, text) in events {
            thread::sleep(Duration::from_millis(150));
            live.event(RECEIPT, kind, text).unwrap();
        }
    });
    sent
}

fn hive_ask(state: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hive-ask"))
        .args(args)
        .env("AGENT_STATE_DIR", state)
        .output()
        .unwrap()
}

#[test]
fn it_sends_the_request_and_prints_what_hive_does_until_it_ends() {
    let state = tempfile::tempdir().unwrap();
    let sent = fake_hive(
        state.path(),
        json!({"ok": true, "receiptId": RECEIPT, "status": "accepted"}),
        vec![
            ("started", "Check the cart"),
            ("action", "click: Opening My Courses."),
            ("paused", "The user took the mouse and keyboard."),
            ("resumed", "The mouse and keyboard are back with Hive."),
            ("say", "The cart has seven courses."),
            ("done", "Seven courses, 19 credits."),
        ],
    );
    let out = hive_ask(state.path(), &["Check", "the", "cart"]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let sent = sent.lock().unwrap().clone().unwrap();
    assert_eq!(sent["text"], "Check the cart");
    assert!(sent["sourceId"].as_str().unwrap().starts_with("hive-ask-"));
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(
        lines,
        [
            &format!("Sent to Hive (receipt {RECEIPT}).") as &str,
            "▶️  Started: Check the cart",
            "→ click: Opening My Courses.",
            "⏸  The user took the mouse and keyboard.",
            "▶️  The mouse and keyboard are back with Hive.",
            "💬 The cart has seven courses.",
            "✅ Done.",
            "Seven courses, 19 credits.",
        ]
    );
}

#[test]
fn a_task_that_needs_you_exits_3_and_can_be_followed_again() {
    let state = tempfile::tempdir().unwrap();
    fake_hive(
        state.path(),
        json!({"ok": true, "receiptId": RECEIPT, "status": "accepted"}),
        vec![
            ("started", "Post it"),
            ("needs_you", "I won't post without your words."),
        ],
    );
    let out = hive_ask(state.path(), &["--json", "Post it"]);
    assert_eq!(out.status.code(), Some(3));
    let followed = hive_ask(state.path(), &["--follow", "latest"]);
    assert_eq!(followed.status.code(), Some(3));
    assert!(
        String::from_utf8_lossy(&followed.stdout).contains("✋ I won't post without your words.")
    );
}

#[test]
fn a_request_hive_turns_down_exits_5() {
    let state = tempfile::tempdir().unwrap();
    fake_hive(
        state.path(),
        json!({"ok": false, "error": "The personal-agent is already working."}),
        vec![],
    );
    let out = hive_ask(state.path(), &["Open Safari"]);
    assert_eq!(out.status.code(), Some(5));
    assert!(String::from_utf8_lossy(&out.stderr).contains("already working"));
}

#[test]
fn without_hive_it_says_so() {
    let state = tempfile::tempdir().unwrap();
    let out = hive_ask(state.path(), &["Open Safari"]);
    assert_eq!(out.status.code(), Some(5));
    assert!(String::from_utf8_lossy(&out.stderr).contains("Hive isn't taking requests"));
    assert_eq!(hive_ask(state.path(), &[]).status.code(), Some(64));
}
