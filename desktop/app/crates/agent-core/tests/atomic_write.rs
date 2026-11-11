//! `thread_identity::atomic_write_standard`, the private state writer the hive crates share
//! (ported from tests/test_rust_atomic_write.py, which reached it through `agent_atomic_write`).
#![cfg(unix)]
use personal_agent_core::thread_identity::{atomic_write_standard, IdentityError};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Barrier;
use std::thread;
use std::time::{Duration, Instant};

const SIZE: usize = 1_000_000;

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

#[test]
fn utf8_empty_replacement_and_private_modes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("界.json");
    atomic_write_standard(&path, "a\0界😀".as_bytes()).unwrap();
    assert_eq!(fs::read(&path).unwrap(), "a\0界😀".as_bytes());
    assert_eq!(mode(&path), 0o600);
    assert_eq!(mode(path.parent().unwrap()), 0o700);
    atomic_write_standard(&path, b"").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"");
    assert_eq!(mode(&path), 0o600);
    // A committed write leaves no pending temporary file behind.
    let names: Vec<_> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, ["界.json"]);
}

#[test]
fn competing_writers_never_mix_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state");
    let values: Vec<String> = (0..10).map(|n| n.to_string().repeat(10_000)).collect();
    let start = Barrier::new(values.len());
    thread::scope(|scope| {
        for value in &values {
            let (path, start) = (&path, &start);
            scope.spawn(move || {
                start.wait();
                atomic_write_standard(path, value.as_bytes()).unwrap();
            });
        }
    });
    let written = fs::read_to_string(&path).unwrap();
    assert!(
        values.contains(&written),
        "mixed payload of {} bytes",
        written.len()
    );
}

/// Runs only as the child of `killed_writer_never_leaves_a_partial_committed_file`.
#[test]
fn child_atomic_writer() {
    let Some(path) = std::env::var_os("AGENT_TEST_ATOMIC_WRITE_FILE") else {
        return;
    };
    let marker = std::env::var_os("AGENT_TEST_ATOMIC_WRITE_STARTED").expect("marker required");
    let path = Path::new(&path);
    let (a, b) = (vec![b'a'; SIZE], vec![b'b'; SIZE]);
    atomic_write_standard(path, &b).unwrap();
    fs::write(marker, b"").unwrap();
    loop {
        atomic_write_standard(path, &a).unwrap();
        atomic_write_standard(path, &b).unwrap();
    }
}

#[test]
fn killed_writer_never_leaves_a_partial_committed_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state");
    let marker = dir.path().join("started");
    atomic_write_standard(&path, &vec![b'a'; SIZE]).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_atomic_writer", "--nocapture"])
        .env("AGENT_TEST_ATOMIC_WRITE_FILE", &path)
        .env("AGENT_TEST_ATOMIC_WRITE_STARTED", &marker)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() && child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let started = marker.exists();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(started, "child did not start writing");
    let first = fs::read(&path).unwrap();
    assert!(
        first == vec![b'a'; SIZE] || first == vec![b'b'; SIZE],
        "partial file of {} bytes",
        first.len()
    );
    thread::sleep(Duration::from_millis(50));
    assert_eq!(fs::read(&path).unwrap(), first);
}

#[test]
fn failed_replace_does_not_delete_existing_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("directory");
    fs::create_dir(&path).unwrap();
    match atomic_write_standard(&path, b"data") {
        Err(IdentityError::Io { source, .. }) => assert!(source.raw_os_error().is_some()),
        other => panic!("expected an OS error, got {other:?}"),
    }
    assert!(path.is_dir());
}
