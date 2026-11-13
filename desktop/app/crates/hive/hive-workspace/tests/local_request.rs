//! The request socket: protocol, admission ledger, refusal and crash behavior. All state and
//! sockets are temporary.

use hive_workspace::local_request::{channel, LocalRequest, LocalRequests};
use hive_core::request_ledger;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Fixture {
    _temp: tempfile::TempDir,
    directory: PathBuf,
    server: LocalRequests,
    events: Receiver<LocalRequest>,
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("control");
    let (sender, events) = channel();
    let server = LocalRequests::start(&directory, sender).unwrap();
    Fixture {
        _temp: temp,
        directory,
        server,
        events,
    }
}

fn send_raw(path: &Path, raw: &[u8]) -> std::io::Result<Value> {
    let mut client = UnixStream::connect(path)?;
    client.set_read_timeout(Some(Duration::from_secs(8)))?;
    client.write_all(raw)?;
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    while !data.contains(&b'\n') {
        let count = client.read(&mut buffer)?;
        if count == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "closed",
            ));
        }
        data.extend_from_slice(&buffer[..count]);
    }
    Ok(serde_json::from_slice(data.split(|b| *b == b'\n').next().unwrap()).unwrap())
}

fn call(path: &Path, request: Value) -> Value {
    send_raw(path, format!("{request}\n").as_bytes()).unwrap()
}

fn rows(directory: &Path) -> Vec<Value> {
    request_ledger::list(directory)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

fn background(path: &Path, request: Value) -> std::thread::JoinHandle<Value> {
    let path = path.to_path_buf();
    std::thread::spawn(move || call(&path, request))
}

#[test]
fn private_socket_delivers_and_removes_only_its_own_path() {
    let f = fixture();
    let mode = std::fs::metadata(f.server.path())
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
    let client = background(f.server.path(), json!({"text": "plan"}));
    let request = f.events.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(request.text, "plan");
    assert!(request.deadline > Instant::now());
    request.reply(json!({"ok": true}));
    assert_eq!(client.join().unwrap()["ok"], true);
    f.server.close();
    assert!(!f.server.path().exists());
}

#[test]
fn existing_non_socket_is_not_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("control");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("request.sock"), "keep").unwrap();
    let (sender, _events) = channel();
    assert!(LocalRequests::start(&folder, sender).is_err());
    assert_eq!(
        std::fs::read_to_string(folder.join("request.sock")).unwrap(),
        "keep"
    );
}

#[test]
fn invalid_input_does_not_reach_host() {
    let f = fixture();
    for raw in [
        &br#"{"text":" "}"#[..],
        br#"{"text":"hello","resume_goal":1}"#,
        br#"{"text":"hello","goal_objective":"goal"}"#,
    ] {
        let line = [raw, b"\n"].concat();
        assert_eq!(send_raw(f.server.path(), &line).unwrap()["ok"], false);
    }
    let mut oversized = vec![b'x'; 16385];
    oversized.push(b'\n');
    // The server can close while the oversized client is still writing.
    if let Ok(reply) = send_raw(f.server.path(), &oversized) {
        assert_eq!(reply["ok"], false);
    }
    assert!(f.events.try_recv().is_err());
}

#[test]
fn fragmented_request_waits_for_complete_line() {
    let f = fixture();
    let path = f.server.path().to_path_buf();
    let client = std::thread::spawn(move || {
        let mut connection = UnixStream::connect(path).unwrap();
        connection
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        connection.write_all(br#"{"text":"#).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        connection.write_all(b"\"fragmented\"}\n").unwrap();
        let mut buffer = [0u8; 1024];
        let count = connection.read(&mut buffer).unwrap();
        serde_json::from_slice::<Value>(&buffer[..count]).unwrap()
    });
    let request = f.events.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(request.text, "fragmented");
    request.reply(json!({"ok": true}));
    assert_eq!(client.join().unwrap()["ok"], true);
}

#[test]
fn concurrent_requests_keep_replies_with_their_clients() {
    let f = fixture();
    let clients: Vec<_> = (0..4)
        .map(|i| background(f.server.path(), json!({"text": i.to_string()})))
        .collect();
    let mut receipts = std::collections::HashMap::new();
    for _ in 0..4 {
        let request = f.events.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(request.deadline > Instant::now());
        assert!(!request.resume_goal);
        assert!(request.goal_objective.is_none());
        receipts.insert(request.text.clone(), request.receipt_id.clone().unwrap());
        request.reply(json!({"ok": true, "text": request.text}));
    }
    for client in clients {
        let result = client.join().unwrap();
        let text = result["text"].as_str().unwrap().to_string();
        assert_eq!(result["receiptId"], receipts[&text]);
    }
    assert_eq!(receipts.len(), 4);
}

#[test]
fn resume_fields_and_active_socket_refusal() {
    let f = fixture();
    let (sender, _other) = channel();
    assert!(LocalRequests::start(&f.directory, sender).is_err());
    let client = background(
        f.server.path(),
        json!({"text": " go ", "resume_goal": true, "goal_objective": " goal "}),
    );
    let request = f.events.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(request.text, "go");
    assert!(request.resume_goal);
    assert_eq!(request.goal_objective.as_deref(), Some(" goal "));
    request.reply(json!({"ok": true}));
    assert_eq!(client.join().unwrap()["ok"], true);
}

#[test]
fn crashed_server_socket_is_reclaimed() {
    // A socket file left by a dead listener (here: bound, then forgotten without unlinking).
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("control");
    std::fs::create_dir(&folder).unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
    drop(std::os::unix::net::UnixListener::bind(folder.join("request.sock")).unwrap());
    assert!(folder.join("request.sock").exists());
    let (sender, events) = channel();
    let replacement = LocalRequests::start(&folder, sender).unwrap();
    let client = background(replacement.path(), json!({"text": "hello"}));
    events
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .reply(json!({"ok": true}));
    assert_eq!(client.join().unwrap()["ok"], true);
}

#[test]
fn close_does_not_unlink_replacement() {
    let f = fixture();
    std::fs::remove_file(f.server.path()).unwrap();
    std::fs::write(f.server.path(), "preserve").unwrap();
    f.server.close();
    assert_eq!(
        std::fs::read_to_string(f.server.path()).unwrap(),
        "preserve"
    );
}

// ---- request ingress ledger

#[test]
fn persisted_before_dispatch_and_duplicates_never_dispatch() {
    let f = fixture();
    let text = "Prepare the project outline";
    let source = "mesh:pc1:nmsg_abc";
    let client = background(f.server.path(), json!({"text": text, "sourceId": source}));
    let request = f.events.recv_timeout(Duration::from_secs(5)).unwrap();
    let listing = rows(&f.directory);
    assert_eq!(
        (listing[0]["status"].as_str(), listing[0]["text"].as_str()),
        (Some("dispatching"), Some(text))
    );
    assert_eq!(
        request.receipt_id.as_deref(),
        listing[0]["receiptId"].as_str()
    );
    let database = std::fs::read(f.directory.join("request-ledger.sqlite3")).unwrap();
    assert!(!database.windows(text.len()).any(|w| w == text.as_bytes()));
    for name in ["request-ledger.key", "request-ledger.sqlite3"] {
        assert_eq!(
            std::fs::metadata(f.directory.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    request.reply(json!({"ok": true}));
    let first = client.join().unwrap();
    assert_eq!(first["status"], "accepted");
    assert_eq!(rows(&f.directory)[0]["status"], "accepted");
    let duplicate = call(
        f.server.path(),
        json!({"text": "other text", "sourceId": source}),
    );
    assert_eq!(duplicate["ok"], false);
    assert_eq!(duplicate["status"], "accepted");
    assert_eq!(duplicate["receiptId"], first["receiptId"]);
    assert!(f.events.try_recv().is_err());
}

#[test]
fn simultaneous_same_source_dispatches_once() {
    let f = fixture();
    let source = "mesh:pc1:nmsg_concurrent";
    let clients: Vec<_> = (0..8)
        .map(|_| {
            background(
                f.server.path(),
                json!({"text": "Work on the plan", "sourceId": source}),
            )
        })
        .collect();
    f.events
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .reply(json!({"ok": true}));
    let results: Vec<Value> = clients.into_iter().map(|c| c.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r["ok"] == true).count(), 1);
    let receipts: std::collections::HashSet<_> =
        results.iter().map(|r| r["receiptId"].to_string()).collect();
    assert_eq!(receipts.len(), 1);
    assert!(f.events.try_recv().is_err());
    assert_eq!(rows(&f.directory).len(), 1);
}

#[test]
fn crash_after_dispatch_leaves_unknown_without_replay() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("control");
    // The host takes the request and never answers, as a crashed host would.
    let taken: Arc<Mutex<Vec<LocalRequest>>> = Arc::default();
    let sink = taken.clone();
    let server = LocalRequests::start_with(
        &directory,
        Arc::new(move |request| sink.lock().unwrap().push(request)),
    )
    .unwrap();
    let source = "mesh:pc1:nmsg_crash";
    let path = server.path().to_path_buf();
    let _lost = std::thread::spawn(move || {
        send_raw(
            &path,
            format!(
                "{}\n",
                json!({"text": "Review the budget", "sourceId": source})
            )
            .as_bytes(),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while taken.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    server.close();
    let (sender, events) = channel();
    let second = LocalRequests::start(&directory, sender).unwrap();
    let duplicate = call(
        second.path(),
        json!({"text": "Review the budget", "sourceId": source}),
    );
    assert_eq!(duplicate["ok"], false);
    assert_eq!(duplicate["status"], "dispatching");
    assert_eq!(rows(&directory)[0]["text"], "Review the budget");
    assert!(events.try_recv().is_err());
}

#[test]
fn credential_pattern_omits_content_but_preserves_admission() {
    let f = fixture();
    let secret = "password is never-save-this";
    let client = background(f.server.path(), json!({"text": secret}));
    let request = f.events.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(request.text, secret);
    request.reply(json!({"ok": true}));
    client.join().unwrap();
    let row = &rows(&f.directory)[0];
    assert!(row["text"].is_null());
    assert_eq!(row["textOmitted"], true);
    for entry in std::fs::read_dir(&f.directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            let bytes = std::fs::read(&path).unwrap();
            assert!(
                !bytes.windows(secret.len()).any(|w| w == secret.as_bytes()),
                "{path:?}"
            );
        }
    }
}

#[test]
fn only_explicit_pre_start_refusals_are_rejected() {
    let f = fixture();
    for (error, expected) in [
        ("Request not accepted; check agent availability.", "unknown"),
        ("Unexpected failure after dispatch", "unknown"),
        ("The request expired before it could start.", "rejected"),
        ("The personal-agent is already working.", "rejected"),
    ] {
        let client = background(f.server.path(), json!({"text": "Review the plan"}));
        f.events
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .reply(json!({"ok": false, "error": error}));
        assert_eq!(client.join().unwrap()["status"], expected, "{error}");
        assert_eq!(rows(&f.directory)[0]["status"], expected, "{error}");
    }
}

#[test]
fn objective_is_saved_encrypted_or_omitted_as_one_unit() {
    let f = fixture();
    let client = background(
        f.server.path(),
        json!({"text": "Continue", "resume_goal": true, "goal_objective": "Finish the report"}),
    );
    let request = f.events.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(request.goal_objective.as_deref(), Some("Finish the report"));
    request.reply(json!({"ok": true}));
    client.join().unwrap();
    assert_eq!(rows(&f.directory)[0]["goalObjective"], "Finish the report");
    let client = background(
        f.server.path(),
        json!({"text": "Continue", "resume_goal": true, "goal_objective": "password is private"}),
    );
    f.events
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .reply(json!({"ok": true}));
    client.join().unwrap();
    let row = &rows(&f.directory)[0];
    assert!(row["text"].is_null() && row["goalObjective"].is_null());
    assert_eq!(row["textOmitted"], true);
}

#[test]
fn lost_key_is_not_regenerated_over_existing_receipts() {
    let f = fixture();
    let client = background(f.server.path(), json!({"text": "Retain the notes"}));
    f.events
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .reply(json!({"ok": true}));
    client.join().unwrap();
    std::fs::remove_file(f.directory.join("request-ledger.key")).unwrap();
    let clients: Vec<_> = (0..6)
        .map(|_| background(f.server.path(), json!({"text": "Another task"})))
        .collect();
    for client in clients {
        assert_eq!(client.join().unwrap()["ok"], false);
    }
    assert!(!f.directory.join("request-ledger.key").exists());
    assert!(f.events.try_recv().is_err());
}

#[test]
fn invalid_source_and_unreadable_key_never_dispatch() {
    let f = fixture();
    assert_eq!(
        call(
            f.server.path(),
            json!({"text": "valid task", "sourceId": "not valid whitespace"})
        )["ok"],
        false
    );
    assert!(f.events.try_recv().is_err());
    let key = f.directory.join("request-ledger.key");
    std::fs::write(&key, b"bad").unwrap();
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        call(
            f.server.path(),
            json!({"text": "valid task", "sourceId": "mesh:pc1:nmsg_bad"})
        )["ok"],
        false
    );
    assert!(f.events.try_recv().is_err());
}

#[test]
fn socket_event_includes_same_receipt_as_reply() {
    let f = fixture();
    let client = background(
        f.server.path(),
        json!({"text": "request", "sourceId": "typed:123"}),
    );
    let request = f.events.recv_timeout(Duration::from_secs(5)).unwrap();
    let receipt = request.receipt_id.clone().unwrap();
    request.reply(json!({"ok": true}));
    let reply = client.join().unwrap();
    assert_eq!(
        (reply["receiptId"].as_str(), reply["status"].as_str()),
        (Some(receipt.as_str()), Some("accepted"))
    );
}
