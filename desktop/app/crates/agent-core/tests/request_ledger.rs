//! Listing the private request ledger, in-process and through the `request-ledger` binary that
//! README.md tells users to run as build/agent-request-ledger (ported from
//! tests/test_ledger_control.py).
#![cfg(unix)]
use personal_agent_core::request_ledger::{admit, finish, list_page};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const LEDGER: &str = env!("CARGO_BIN_EXE_request-ledger");
const DB: &str = "request-ledger.sqlite3";
const KEY: &str = "request-ledger.key";
const LOCK: &str = "request-ledger.key.lock";

fn control() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let directory = tmp.path().join("control");
    (tmp, directory)
}

/// `request-ledger <directory> [mode]` with `input` on stdin.
fn invoke(directory: &Path, mode: Option<&str>, input: &Value) -> Output {
    let mut command = Command::new(LEDGER);
    command.arg(directory).args(mode);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // `list` reads no input and may exit before the write; that's fine.
    let _ = child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes());
    child.wait_with_output().unwrap()
}

fn list_page_bin(directory: &Path, input: Value) -> Value {
    let output = invoke(directory, Some("list-page"), &input);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn ids(rows: &Value) -> Vec<String> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|row| row["receiptId"].as_str().unwrap().to_owned())
        .collect()
}

/// Fails both in-process and through the binary.
fn assert_listing_fails(directory: &Path) {
    assert!(list_page(directory, None, 100).is_err());
    assert!(
        !invoke(directory, Some("list-page"), &json!({"cursor": null}))
            .status
            .success()
    );
    assert!(!invoke(directory, None, &json!(null)).status.success());
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

type Snapshot = BTreeMap<String, (Vec<u8>, i64, i64, u32)>;
fn snapshot(directory: &Path) -> Snapshot {
    names(directory)
        .into_iter()
        .map(|name| {
            let path = directory.join(&name);
            let meta = fs::metadata(&path).unwrap();
            let state = (
                fs::read(&path).unwrap(),
                meta.mtime(),
                meta.mtime_nsec(),
                meta.mode() & 0o7777,
            );
            (name, state)
        })
        .collect()
}

fn dir_mode(directory: &Path) -> u32 {
    fs::metadata(directory).unwrap().permissions().mode() & 0o7777
}

#[test]
fn cursor_pagination_and_rescan_for_mutations() {
    let (_tmp, directory) = control();
    let ids_in_order: Vec<String> = (0..5)
        .map(|i| {
            let source = format!("voice:{i}");
            admit(&directory, Some(&source), &format!("task {i}"), None)
                .unwrap()
                .id
        })
        .collect();
    let newest_first: Vec<String> = ids_in_order.iter().rev().cloned().collect();

    let (first, mut cursor) = list_page(&directory, None, 2).unwrap();
    assert_eq!(ids(&first), newest_first[..2]);
    assert!(cursor.is_some());

    // Changes to rows already read show up only in a fresh scan.
    finish(&directory, &ids_in_order[4], "accepted").unwrap();
    let new = admit(&directory, Some("voice:new"), "new task", None)
        .unwrap()
        .id;
    let mut collected = first.as_array().unwrap().clone();
    while let Some(before) = cursor {
        let (page, next) = list_page(&directory, Some(before), 2).unwrap();
        collected.extend(page.as_array().unwrap().iter().cloned());
        cursor = next;
    }
    assert_eq!(ids(&Value::Array(collected.clone())), newest_first);
    assert_eq!(collected[0]["status"], "dispatching");
    let (refreshed, _) = list_page(&directory, None, 2).unwrap();
    assert_eq!(ids(&refreshed), [new.clone(), ids_in_order[4].clone()]);
    assert_eq!(refreshed[1]["status"], "accepted");
    assert_eq!(refreshed[0]["text"], "new task");

    // The same walk through the binary, whose cursors are opaque strings.
    let mut all = newest_first.clone();
    all.insert(0, new);
    let mut page = list_page_bin(&directory, json!({"cursor": null, "limit": 2}));
    let mut walked = ids(&page["receipts"]);
    assert_eq!(walked, all[..2]);
    assert_eq!(page["receipts"][1]["status"], "accepted");
    while let Some(next) = page["nextCursor"].as_str().map(str::to_owned) {
        page = list_page_bin(&directory, json!({"cursor": next, "limit": 2}));
        walked.extend(ids(&page["receipts"]));
    }
    assert_eq!(page["nextCursor"], Value::Null);
    assert_eq!(walked, all);

    // With no mode it lists, as README.md shows.
    let default = invoke(&directory, None, &json!(null));
    assert!(default.status.success());
    let listed: Value = serde_json::from_slice(&default.stdout).unwrap();
    assert!(listed.is_array());
    assert_eq!(ids(&listed), all);

    for bad in [
        json!({"cursor": "bad"}),
        json!({"limit": 101}),
        json!({"limit": 0}),
        json!({"cursor": "r:0"}),
    ] {
        assert!(
            !invoke(&directory, Some("list-page"), &bad).status.success(),
            "{bad}"
        );
    }
    assert!(list_page(&directory, None, 101).is_err());
    assert!(list_page(&directory, None, 0).is_err());
    assert!(list_page(&directory, Some(0), 2).is_err());
}

#[test]
fn list_page_never_mutates_or_creates_ledger_files() {
    let (_tmp, directory) = control();
    admit(
        &directory,
        Some("voice:readonly"),
        "Review the project",
        None,
    )
    .unwrap();
    fs::remove_file(directory.join(LOCK)).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o750)).unwrap();
    let before = snapshot(&directory);
    let mode = dir_mode(&directory);

    let (rows, next) = list_page(&directory, None, 100).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(next, None);
    let page = list_page_bin(&directory, json!({"cursor": null}));
    assert_eq!(page["receipts"].as_array().unwrap().len(), 1);
    assert!(invoke(&directory, None, &json!(null)).status.success());

    assert_eq!(snapshot(&directory), before);
    assert_eq!(dir_mode(&directory), mode);
}

#[test]
fn missing_corrupt_or_missing_key_fails_closed_without_creation() {
    let (_tmp, directory) = control();
    assert_listing_fails(&directory);
    assert!(!directory.exists());

    fs::create_dir(&directory).unwrap();
    let path = directory.join(DB);
    fs::write(&path, b"not sqlite").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_listing_fails(&directory);
    assert_eq!(fs::read(&path).unwrap(), b"not sqlite");
    assert_eq!(names(&directory), [DB]);

    fs::remove_file(&path).unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute("CREATE TABLE unrelated (id INTEGER)", [])
        .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let unrelated = fs::read(&path).unwrap();
    assert_listing_fails(&directory);
    assert_eq!(fs::read(&path).unwrap(), unrelated);
    assert_eq!(names(&directory), [DB]);

    fs::remove_file(&path).unwrap();
    admit(&directory, Some("voice:missing-key"), "Valid task", None).unwrap();
    fs::remove_file(directory.join(KEY)).unwrap();
    let before = snapshot(&directory);
    assert_listing_fails(&directory);
    assert_eq!(snapshot(&directory), before);
}

#[test]
fn empty_ledger_requires_its_existing_key() {
    let (_tmp, directory) = control();
    admit(&directory, Some("voice:empty"), "Valid task", None).unwrap();
    rusqlite::Connection::open(directory.join(DB))
        .unwrap()
        .execute("DELETE FROM receipts", [])
        .unwrap();
    assert_eq!(list_page(&directory, None, 100).unwrap(), (json!([]), None));
    assert_eq!(
        list_page_bin(&directory, json!({"cursor": null})),
        json!({"receipts": [], "nextCursor": null})
    );

    fs::remove_file(directory.join(KEY)).unwrap();
    assert_listing_fails(&directory);
    assert!(!directory.join(KEY).exists());
}

#[test]
fn bad_input_is_rejected_without_echo() {
    let (_tmp, directory) = control();
    let text = "password never print this";
    let output = invoke(
        &directory,
        Some("admit"),
        &json!({"text": text, "sourceId": "bad id"}),
    );
    assert!(!output.status.success());
    let printed = [output.stdout, output.stderr].concat();
    assert!(!String::from_utf8_lossy(&printed).contains("password"));

    let error = admit(&directory, Some("bad id"), text, None).err().unwrap();
    assert!(!error.contains("password"), "{error}");
    assert!(!directory.exists());
}
