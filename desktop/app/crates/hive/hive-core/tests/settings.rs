//! The .env parser and the settings-reader binary (ported from tests/test_rust_settings.py).
//! The expected values were recorded from python/settings.py's own parser on the same fixture.
use hive_core::settings::{parse, read};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::process::Command;

const READER: &str = env!("CARGO_BIN_EXE_hive-settings-reader");
const FIXTURE: &str = "# comment\nexport KEY=first\nKEY=second # note\nQUOTED=' value # kept '\nDOUBLE=\"x=y\"\nEMPTY=\nNOEQUAL\nUNICODE=你好\u{2028}NEXT=ok\n";

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn parser_matches_the_recorded_python_results() {
    // python/settings.py set these, in this order, when loading FIXTURE.
    let expected = pairs(&[
        ("KEY", "first"),
        ("KEY", "second"),
        ("QUOTED", " value # kept "),
        ("DOUBLE", "x=y"),
        ("UNICODE", "你好"),
        ("NEXT", "ok"),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("env");
    std::fs::write(&path, FIXTURE).unwrap();
    assert_eq!(parse(FIXTURE), expected);
    let found = read(&path).unwrap();
    assert_eq!(found, expected);

    // Applied in order, as a load does, they leave Python's environment.
    let environment: BTreeMap<_, _> = found.into_iter().collect();
    let python: BTreeMap<_, _> = pairs(&[
        ("KEY", "second"),
        ("QUOTED", " value # kept "),
        ("DOUBLE", "x=y"),
        ("UNICODE", "你好"),
        ("NEXT", "ok"),
    ])
    .into_iter()
    .collect();
    assert_eq!(environment, python);
    assert!(!environment.contains_key("EMPTY") && !environment.contains_key("NOEQUAL"));

    let output = Command::new(READER).arg(&path).output().unwrap();
    assert!(output.status.success());
    let printed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        printed,
        json!([
            ["KEY", "first"],
            ["KEY", "second"],
            ["QUOTED", " value # kept "],
            ["DOUBLE", "x=y"],
            ["UNICODE", "你好"],
            ["NEXT", "ok"]
        ])
    );
}

/// Python's load ran the reader even for a missing file; it must print no settings, not fail.
#[test]
fn unavailable_file_reads_as_no_settings() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing-settings-file");
    assert_eq!(read(&missing).unwrap(), Vec::new());
    let output = Command::new(READER).arg(&missing).output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"[]");
    assert!(!missing.exists());
}
