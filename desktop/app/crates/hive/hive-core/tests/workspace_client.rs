#![cfg(unix)]
use hive_core::workspace_client::request;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::thread;
use std::time::Duration;

#[test]
fn rejects_incomplete_response_without_retrying() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("workspace.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let worker = thread::spawn(move || {
        let (mut peer, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(&peer).read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line).unwrap(),
            json!({"name": "click"})
        );
        peer.write_all(b"{\"ok\":true}").unwrap(); // no newline
    });
    let error = request(&socket, &json!({"name": "click"}), Duration::from_secs(1)).unwrap_err();
    assert_eq!(error, "Workspace connection closed before replying");
    worker.join().unwrap();
}

#[test]
fn read_timeout_returns_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("workspace.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let worker = thread::spawn(move || {
        let (_peer, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_millis(150));
    });
    assert!(request(&socket, &json!({}), Duration::from_millis(25)).is_err());
    worker.join().unwrap();
}
