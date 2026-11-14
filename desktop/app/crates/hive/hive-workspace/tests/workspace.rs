//! The creation fence, startup recovery, update decision, memory and workspace routing, and the
//! `workspace-tool` command. Nothing touches a display, daemon or the real journal.

use hive_workspace::fence;
use hive_workspace::recovery::{recover_if_latched, Output};
use hive_workspace::tool_cli;
use hive_workspace::tools;
use hive_workspace::update::{decision, EngineChoice};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::Duration;

// ------------------------------------------------------------------------------------ fence

#[test]
fn absence_and_corruption_never_authorize_creation() {
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path();
    assert_eq!(fence::policy(root), "unconfigured");
    assert!(fence::create_once(root, || panic!("created")).is_err());
    std::fs::write(root.join(fence::FILE), "{broken").unwrap();
    assert_eq!(fence::policy(root), "closed");
    assert!(fence::create_once(root, || panic!("created")).is_err());
}

#[test]
fn closed_state_survives_new_reader_and_process() {
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path();
    fence::set_policy(root, "closed").unwrap();
    let written: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join(fence::FILE)).unwrap()).unwrap();
    assert_eq!(written["mode"], "closed");
    assert_eq!(
        std::fs::read_to_string(root.join(fence::FILE)).unwrap(),
        "{\"version\": 1, \"mode\": \"closed\"}\n"
    );
    assert_eq!(fence::policy(root), "closed");
    let output = Command::new(env!("CARGO_BIN_EXE_workspace-fence"))
        .arg("status")
        .env("AGENT_STATE_DIR", root)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "closed");
}

#[test]
fn fence_command_records_without_touching_a_display() {
    let folder = tempfile::tempdir().unwrap();
    let run = |action: &str| {
        Command::new(env!("CARGO_BIN_EXE_workspace-fence"))
            .arg(action)
            .env("AGENT_STATE_DIR", folder.path())
            .output()
            .unwrap()
    };
    let output = run("allow-once");
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "Workspace creation policy recorded; no display was changed.\n"
    );
    assert_eq!(fence::policy(folder.path()), "allow-once");
    assert_eq!(run("bogus").status.code(), Some(2));
}

#[test]
fn concurrent_one_time_permit_creates_at_most_once() {
    let folder = tempfile::tempdir().unwrap();
    let root = Arc::new(folder.path().to_path_buf());
    fence::set_policy(&root, "allow-once").unwrap();
    let created = Arc::new(AtomicUsize::new(0));
    let start = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let (root, created, start) = (root.clone(), created.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                fence::create_once(&root, || created.fetch_add(1, Ordering::SeqCst)).is_ok()
            })
        })
        .collect();
    let wins = workers
        .into_iter()
        .map(|w| w.join().unwrap())
        .filter(|won| *won)
        .count();
    assert_eq!(wins, 1);
    assert_eq!(created.load(Ordering::SeqCst), 1);
    assert_eq!(fence::policy(&root), "existing-only");
}

#[test]
fn close_is_serialized_against_an_inflight_creation() {
    let folder = tempfile::tempdir().unwrap();
    let root = Arc::new(folder.path().to_path_buf());
    fence::set_policy(&root, "allow-once").unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let worker = {
        let root = root.clone();
        std::thread::spawn(move || {
            fence::create_once(&root, || {
                entered_tx.send(()).unwrap();
                let _ = release_rx.recv_timeout(Duration::from_secs(2));
            })
        })
    };
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let (closed_tx, closed_rx) = std::sync::mpsc::channel();
    let closer = {
        let root = root.clone();
        std::thread::spawn(move || {
            fence::set_policy(&root, "closed").unwrap();
            closed_tx.send(()).unwrap();
        })
    };
    assert!(closed_rx.recv_timeout(Duration::from_millis(50)).is_err());
    release_tx.send(()).unwrap();
    worker.join().unwrap().unwrap();
    closer.join().unwrap();
    assert!(closed_rx.try_recv().is_ok());
    assert_eq!(fence::policy(&root), "closed");
    assert!(fence::create_once(&root, || panic!("created again")).is_err());
}

// ------------------------------------------------------------------------------------ recovery

type Calls = Arc<Mutex<Vec<Vec<String>>>>;

fn engine(report: Value, clear: Output) -> (impl Fn(&[&str], u64) -> Output, Calls) {
    let calls: Calls = Arc::default();
    let record = calls.clone();
    let run = move |command: &[&str], _timeout: u64| -> Output {
        let rest: Vec<String> = command[1..].iter().map(|s| s.to_string()).collect();
        record.lock().unwrap().push(rest.clone());
        let rest: Vec<&str> = rest.iter().map(String::as_str).collect();
        match rest.as_slice() {
            ["doctor", "--json"] => (
                1,
                report
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| report.to_string()),
                "progress".into(),
            ),
            ["daemon", "stop"] => (0, String::new(), String::new()),
            ["safety", "clear-host-health", "--operator"] => clear.clone(),
            other => panic!("{other:?}"),
        }
    };
    (run, calls)
}

fn sequence(calls: &Calls) -> Vec<Vec<String>> {
    calls.lock().unwrap().clone()
}

#[test]
fn healthy_engine_is_left_alone() {
    let (run, calls) = engine(
        json!({"displaySafety": {"state": "ready"}, "displays": {"workspace": [4]}}),
        (0, "cleared".into(), String::new()),
    );
    assert_eq!(
        recover_if_latched("workspace", &run),
        ("not-latched".into(), String::new())
    );
    assert_eq!(sequence(&calls), [["doctor", "--json"]]);
}

#[test]
fn idle_host_health_latch_is_cleared_with_the_engine_command() {
    let (run, calls) = engine(
        json!({"displaySafety": {"state": "blocked", "reason": "host health: swap_activity"}, "displays": {"workspace": []}}),
        (0, "cleared".into(), String::new()),
    );
    assert_eq!(
        recover_if_latched("workspace", &run),
        ("cleared".into(), "host health: swap_activity".into())
    );
    assert_eq!(
        sequence(&calls),
        [
            vec!["doctor", "--json"],
            vec!["daemon", "stop"],
            vec!["safety", "clear-host-health", "--operator"]
        ]
    );
}

#[test]
fn engine_refusal_is_reported_not_retried() {
    let (run, calls) = engine(
        json!({"displaySafety": {"state": "blocked", "reason": "host health: host_health_unknown (colorsync_launchd_unreadable)"}}),
        (
            1,
            String::new(),
            "error: host health is not ready: swap_activity\n".into(),
        ),
    );
    let (outcome, detail) = recover_if_latched("workspace", &run);
    assert_eq!(outcome, "refused");
    assert!(detail.contains("swap_activity"));
    assert_eq!(
        sequence(&calls).iter().filter(|c| c[0] == "safety").count(),
        1
    );
}

#[test]
fn online_display_other_failures_and_unreadable_reports_change_nothing() {
    for report in [
        json!({"displaySafety": {"state": "blocked", "reason": "host health: memory_pressure"}, "displays": {"workspace": [4]}}),
        json!({"displaySafety": {"state": "blocked", "reason": "unfinished display mutation"}}),
        json!({"displaySafety": {"state": "unknown"}}),
        json!("not json"),
    ] {
        let (run, calls) = engine(report.clone(), (0, "cleared".into(), String::new()));
        let (outcome, _) = recover_if_latched("workspace", &run);
        assert_eq!(outcome, "skipped", "{report}");
        assert_eq!(sequence(&calls), [["doctor", "--json"]]);
    }
}

// ------------------------------------------------------------------------------------ update

fn report(running: bool, matches: Option<bool>, instance: &str) -> Value {
    json!({"daemon": {"running": running, "matchesCLI": matches, "instanceID": instance}})
}

#[test]
fn update_decisions() {
    use EngineChoice::*;
    assert_eq!(
        decision(&report(false, None, "one"), &report(false, None, "one")),
        New
    );
    assert_eq!(
        decision(
            &report(true, Some(true), "one"),
            &report(true, Some(true), "one")
        ),
        New
    );
    assert_eq!(
        decision(
            &report(true, Some(false), "one"),
            &report(true, Some(true), "one")
        ),
        Preserve
    );
    assert_eq!(
        decision(&json!({}), &report(true, Some(true), "one")),
        Unsafe
    );
    assert_eq!(
        decision(
            &report(true, Some(false), "one"),
            &report(true, Some(true), "other")
        ),
        Unsafe
    );
    assert_eq!(
        decision(
            &report(true, Some(false), "one"),
            &report(false, None, "one")
        ),
        Unsafe
    );
}

#[test]
fn update_command_usage() {
    let output = Command::new(env!("CARGO_BIN_EXE_workspace-update"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
}

// ------------------------------------------------------------------------------------ memory

#[test]
fn memory_records_are_private_sourced_and_deduplicated() {
    let folder = tempfile::tempdir().unwrap();
    let state = folder.path();
    let value = json!({"op": "add", "statement": "A task was listed", "source": "photo-1.jpg", "kind": "fact"});
    tools::memory(state, &value).unwrap();
    tools::memory(state, &value).unwrap();
    let result = tools::memory(state, &json!({"op": "list"})).unwrap();
    let rows: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0][1], "A task was listed");
    assert_eq!(rows[0][2], "photo-1.jpg");
    assert_eq!(rows[0][3], "fact");
    let mode = std::fs::metadata(state.join("memory/personal-memory.sqlite3"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn unsourced_memory_is_rejected() {
    let folder = tempfile::tempdir().unwrap();
    assert!(tools::memory(
        folder.path(),
        &json!({"op": "add", "statement": "x", "kind": "fact"})
    )
    .is_err());
    assert!(!folder.path().join("memory").exists());
    for bad in [
        json!({"op": "forget"}),
        json!({"op": "add", "statement": "x", "source": "s", "kind": "rumor"}),
        json!({"op": "add", "statement": "x".repeat(2001), "source": "s", "kind": "fact"}),
    ] {
        assert!(tools::memory(folder.path(), &bad).is_err(), "{bad}");
    }
}

// ------------------------------------------------------------------------------------ the socket

/// Serves `replies` (one per connection) on `<state>/control/workspace.sock`, recording what it was
/// sent. `None` closes the connection without replying.
struct FakeWorkspace {
    _folder: tempfile::TempDir,
    state: PathBuf,
    seen: Arc<Mutex<Vec<Value>>>,
    connections: Arc<AtomicUsize>,
    worker: Option<std::thread::JoinHandle<()>>,
}

fn serve(replies: Vec<Option<Vec<u8>>>) -> FakeWorkspace {
    let folder = tempfile::tempdir().unwrap();
    let state = folder.path().to_path_buf();
    std::fs::create_dir(state.join("control")).unwrap();
    let listener = UnixListener::bind(state.join("control/workspace.sock")).unwrap();
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let connections = Arc::new(AtomicUsize::new(0));
    let (log, count) = (seen.clone(), connections.clone());
    let worker = std::thread::spawn(move || {
        for reply in replies {
            let (mut peer, _) = listener.accept().unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            let mut line = String::new();
            BufReader::new(peer.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            log.lock()
                .unwrap()
                .push(serde_json::from_str(&line).unwrap());
            if let Some(reply) = reply {
                peer.write_all(&reply).unwrap();
            }
        }
    });
    FakeWorkspace {
        _folder: folder,
        state,
        seen,
        connections,
        worker: Some(worker),
    }
}

fn line(value: Value) -> Option<Vec<u8>> {
    Some(format!("{}\n", hive_workspace::pydump::dumps(&value, false)).into_bytes())
}

impl FakeWorkspace {
    fn finish(mut self) -> Vec<Value> {
        self.worker.take().unwrap().join().unwrap();
        self.seen.lock().unwrap().clone()
    }
}

#[test]
fn workspace_results_and_errors_use_the_documented_shapes() {
    let click = json!({"name": "click", "arguments": {"x": 42, "text": "你好"}});
    let responses = vec![
        json!({"ok": true, "result": {"content": [{"type": "text", "text": "你好"}]}}),
        json!({"ok": true, "result": {"tools": [{"name": "type", "description": "你好"}]}}),
        json!({"ok": false, "error": "unavailable"}),
        json!({"ok": false}),
    ];
    let fake = serve(responses.iter().cloned().map(line).collect());
    let results: Vec<_> = (0..4)
        .map(|_| tools::workspace(&fake.state, &click).unwrap())
        .collect();
    assert_eq!(
        results[0],
        json!({"content": [{"type": "text", "text": "你好"}]})
    );
    assert_eq!(results[1]["content"][0]["type"], "text");
    let listed: Value =
        serde_json::from_str(results[1]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(listed, json!([{"name": "type", "description": "你好"}]));
    assert_eq!(
        results[2],
        json!({"isError": true, "content": [{"type": "text", "text": "unavailable"}]})
    );
    assert_eq!(results[3]["content"][0]["text"], "Workspace unavailable");
    assert!(fake.finish().iter().all(|seen| *seen == click));
}

#[test]
fn failed_transport_never_retries_a_possible_side_effect() {
    let fake = serve(vec![None]);
    let error = tools::workspace(&fake.state, &json!({"name": "click"})).unwrap_err();
    assert_eq!(error, "Workspace request failed; check agent availability");
    let connections = fake.connections.clone();
    fake.finish();
    assert_eq!(connections.load(Ordering::SeqCst), 1);
}

#[test]
fn memory_and_workspace_prefixes_route_only_mac_text_calls() {
    let fake = serve(vec![line(
        json!({"ok": true, "result": {"content": [{"type": "text", "text": "workspace ready"}]}}),
    )]);
    let routed = tools::route(
        &fake.state,
        "mac",
        "read_ingested",
        &json!({"id": "workspace:{\"name\":\"workspace_session_list\"}"}),
    );
    assert_eq!(
        routed.unwrap().unwrap()["content"][0]["text"],
        "workspace ready"
    );
    assert_eq!(fake.finish(), vec![json!({"name": "workspace_session_list"})]);
    let fake = serve(vec![line(json!({"ok": true, "result": {"content": []}}))]);
    assert!(tools::route(
        &fake.state,
        "mac",
        "type_text",
        &json!({"text": "workspace:{\"method\":\"list\"}"})
    )
    .unwrap()
    .is_ok());
    assert_eq!(fake.finish(), vec![json!({"method": "list"})]);
    let state = tempfile::tempdir().unwrap();
    assert!(tools::route(state.path(), "mac", "click", &json!({"x": 1})).is_none());
    assert!(tools::route(state.path(), "mac", "type_text", &json!({"text": "hello"})).is_none());
    assert!(tools::route(
        state.path(),
        "phone",
        "type_text",
        &json!({"text": "workspace:{}"})
    )
    .is_none());
    assert!(tools::route(
        state.path(),
        "mac",
        "type_text",
        &json!({"text": "workspace:[]"})
    )
    .unwrap()
    .is_err());
    assert!(tools::route(
        state.path(),
        "mac",
        "type_text",
        &json!({"text": "workspace:{bad"})
    )
    .unwrap()
    .is_err());
}

// ------------------------------------------------------------------------------------ workspace-tool

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

#[test]
fn tool_cli_sends_the_documented_requests_and_reports_success() {
    let reply = json!({"ok": true, "result": {"content": [{"type": "text", "text": "ok"}]}});
    let fake = serve(vec![
        line(reply.clone()),
        line(reply.clone()),
        line(reply.clone()),
    ]);
    for args in [
        &["status"][..],
        &["list"],
        &["call", "workspace_click", "{\"x\": 1}"],
    ] {
        let (result, code) = tool_cli::run(&fake.state, &strings(args)).unwrap();
        assert_eq!((result, code), (reply.clone(), 0));
    }
    assert_eq!(
        fake.finish(),
        vec![
            json!({"method": "status"}),
            json!({"method": "list"}),
            json!({"name": "workspace_click", "arguments": {"x": 1}})
        ]
    );
}

#[test]
fn tool_cli_exit_code_follows_ok_and_is_error() {
    let fake = serve(vec![
        line(json!({"ok": false, "error": "nope"})),
        line(json!({"ok": true, "result": {"isError": true, "content": []}})),
    ]);
    assert_eq!(
        tool_cli::run(&fake.state, &strings(&["list"])).unwrap().1,
        1
    );
    assert_eq!(
        tool_cli::run(&fake.state, &strings(&["list"])).unwrap().1,
        1
    );
    fake.finish();
}

#[test]
fn tool_cli_rejects_bad_usage_and_unreachable_workspace() {
    let folder = tempfile::tempdir().unwrap();
    for args in [
        &[][..],
        &["bogus"],
        &["call", "only-name"],
        &["status", "extra"],
    ] {
        let error = tool_cli::run(folder.path(), &strings(args)).unwrap_err();
        assert_eq!(
            error,
            "Use: workspace-tool status | list | call TOOL '{JSON arguments}'"
        );
    }
    assert!(tool_cli::run(folder.path(), &strings(&["call", "t", "{bad"])).is_err());
    assert!(tool_cli::run(folder.path(), &strings(&["list"])).is_err());
}

#[test]
fn tool_cli_connection_closed_before_reply_is_reported() {
    let fake = serve(vec![None]);
    let error = tool_cli::run(&fake.state, &strings(&["list"])).unwrap_err();
    assert_eq!(error, "Workspace connection closed before replying");
    fake.finish();
}

#[test]
fn tool_cli_saves_images_privately_and_never_prints_their_bytes() {
    use base64::Engine as _;
    let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG fixture");
    let jpg = base64::engine::general_purpose::STANDARD.encode(b"jpeg fixture");
    let fake = serve(vec![line(json!({"ok": true, "result": {"content": [
        {"type": "image", "mimeType": "image/png", "data": png},
        {"type": "text", "text": "kept"},
        {"type": "image", "mimeType": "image/jpeg", "data": jpg},
    ]}}))]);
    let (result, code) =
        tool_cli::run(&fake.state, &strings(&["call", "workspace_screenshot", "{}"])).unwrap();
    assert_eq!(code, 0);
    let content = result["result"]["content"].as_array().unwrap();
    let saved = |item: &Value| -> PathBuf {
        PathBuf::from(
            item["text"]
                .as_str()
                .unwrap()
                .strip_prefix("Workspace image saved at ")
                .unwrap(),
        )
    };
    assert!(content
        .iter()
        .all(|c| c["type"] == "text" && c.get("data").is_none()));
    let (first, second) = (saved(&content[0]), saved(&content[2]));
    assert_eq!(std::fs::read(&first).unwrap(), b"\x89PNG fixture");
    assert_eq!(std::fs::read(&second).unwrap(), b"jpeg fixture");
    assert!(first.extension().unwrap() == "png" && second.extension().unwrap() == "jpg");
    assert!(first
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("workspace-"));
    assert_eq!(first.parent().unwrap(), fake.state.join("captures"));
    assert_eq!(
        std::fs::metadata(fake.state.join("captures"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    fake.finish();
}

#[test]
fn tool_cli_refuses_unknown_image_formats_and_invalid_base64() {
    let folder = tempfile::tempdir().unwrap();
    let mut gif = json!({"result": {"content": [{"type": "image", "mimeType": "image/gif", "data": "AAAA"}]}});
    assert_eq!(
        tool_cli::materialize_images(folder.path(), &mut gif).unwrap_err(),
        "Unexpected workspace image format"
    );
    let mut bad = json!({"result": {"content": [{"type": "image", "mimeType": "image/png", "data": "not base64!"}]}});
    assert!(tool_cli::materialize_images(folder.path(), &mut bad).is_err());
    let mut none = json!({"ok": false});
    tool_cli::materialize_images(folder.path(), &mut none).unwrap();
}

#[test]
fn tool_cli_binary_prints_errors_as_json_and_exits_one() {
    let folder = tempfile::tempdir().unwrap();
    // HOME points at an empty folder, so there is no workspace socket to reach.
    let output = Command::new(env!("CARGO_BIN_EXE_workspace-tool"))
        .arg("list")
        .env("HOME", folder.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let printed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(printed["ok"], false);
    assert!(printed["error"].is_string());
}
