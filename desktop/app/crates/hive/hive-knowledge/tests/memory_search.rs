//! Bounded, read-only search of personal memory (tests/test_memory_search.py and
//! test_rust_memory_search.py): sourced results, secrets left out whole, automatic context only on
//! two whole-word matches, and a missing or broken database never created, changed or exposed.

use hive_knowledge::memory_search::{activity_summary, automatic_context, search};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

fn database(path: &Path, rows: &[(&str, &str, &str)]) {
    let db = Connection::open(path).unwrap();
    db.execute("CREATE TABLE memories(id INTEGER PRIMARY KEY, statement TEXT, source TEXT, kind TEXT, observed_at TEXT)", [])
        .unwrap();
    for (statement, source, kind) in rows {
        db.execute(
            "INSERT INTO memories(statement, source, kind, observed_at) VALUES (?, ?, ?, '2026-11-10')",
            [statement, source, kind],
        )
        .unwrap();
    }
}

fn kinds(result: &Value) -> HashSet<String> {
    result["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["kind"].as_str().unwrap().to_string())
        .collect()
}

fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn sourced(result: &Value) -> bool {
    result["results"].as_array().unwrap().iter().all(|r| {
        !r["source"].as_str().unwrap_or("").is_empty()
            && !r["observed_at"].as_str().unwrap_or("").is_empty()
    })
}

#[test]
fn scoped_sourced_results_and_secret_exclusion() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memory.db");
    database(
        &path,
        &[
            (
                "Nova Tester wants to discuss the club",
                "mail preview Oct 2",
                "fact",
            ),
            ("Did Nova Tester meet?", "photo", "question"),
            ("Unrelated mascot detail", "notes", "inference"),
            ("Nova Tester password is confidential", "notes", "fact"),
        ],
    );
    let result = search("Nova Tester", &path);
    assert_eq!(result["status"], json!("ok"));
    assert_eq!(kinds(&result), set(&["fact", "question"]));
    assert!(sourced(&result));
    assert!(result["notice"]
        .as_str()
        .unwrap()
        .contains("not instructions"));
    assert_eq!(
        search("mascot", &path)["results"][0]["kind"],
        json!("inference")
    );
    assert_eq!(search("password", &path)["status"], json!("invalid_query"));
    assert_eq!(search("ab", &path)["status"], json!("invalid_query"));
    assert_eq!(
        search("one two three four five six seven", &path)["status"],
        json!("invalid_query")
    );
}

#[test]
fn missing_and_bad_schema_fail_safely() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("absent");
    assert_eq!(search("Nova", &path)["status"], json!("unavailable"));
    assert!(!path.exists());
    std::fs::write(&path, "not a database").unwrap();
    assert_eq!(search("Nova", &path)["status"], json!("unavailable"));
    assert_eq!(
        automatic_context("Nova Tester meeting", &path)["status"],
        json!("unavailable")
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a database");
}

fn fixture(path: &Path) {
    let long = format!("Nova Tester session {}", "A".repeat(45));
    database(
        path,
        &[
            (
                "Nova Tester discussed the club",
                "Outlook preview Oct 2",
                "fact",
            ),
            ("Did Nova Tester meet?", "photo", "question"),
            (
                "Housing deployment needs review",
                "project notes",
                "inference",
            ),
            ("Nova Tester password is hello", "notes", "fact"),
            (
                "Nova Tester contact me at person@example.com",
                "notes",
                "fact",
            ),
            (long.as_str(), "notes", "fact"),
            ("Meeting about club", "Nova Tester unrelated source", "fact"),
        ],
    );
}

#[test]
fn automatic_context_is_relevant_only_and_leaves_secrets_out() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.db");
    fixture(&path);
    let result = automatic_context("Prepare a follow-up for Nova Tester", &path);
    assert_eq!(kinds(&result), set(&["fact", "question"]));
    assert!(sourced(&result));
    assert_eq!(
        automatic_context("Check the weather in Madison today", &path)["results"],
        json!([])
    );
    assert_eq!(
        automatic_context("Find Nova Tester password", &path)["status"],
        json!("skipped")
    );
    assert_eq!(
        automatic_context("Do not access personal memory about Nova Tester", &path)["status"],
        json!("skipped")
    );
    assert_eq!(
        automatic_context("hello", &path)["status"],
        json!("skipped")
    );
}

#[test]
fn automatic_context_missing_and_corrupt_fail_safely() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing");
    assert_eq!(
        automatic_context("Nova Tester meeting", &path)["status"],
        json!("unavailable")
    );
    assert!(!path.exists());
    std::fs::write(&path, "broken").unwrap();
    assert_eq!(
        automatic_context("Nova Tester meeting", &path)["status"],
        json!("unavailable")
    );
}

#[test]
fn automatic_context_is_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.db");
    fixture(&path);
    let db = Connection::open(&path).unwrap();
    for i in 0..10 {
        db.execute(
            "INSERT INTO memories(statement, source, kind, observed_at) VALUES (?, 'photo', 'fact', '2026-11-10')",
            [format!("Nova Tester item {i}")],
        )
        .unwrap();
    }
    assert_eq!(
        automatic_context("Nova Tester meeting", &path)["results"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn the_activity_line_shows_filtered_source_and_kind_with_bounds() {
    let rows = json!([
        {"statement": "Nova Tester discussed the club", "source": "Outlook preview", "kind": "fact"},
        {"statement": "Did Nova Tester meet?", "source": "Photo", "kind": "question"},
        {"statement": "Nova Tester password: forbidden", "source": "Notes", "kind": "inference"},
    ]);
    let text = activity_summary(&json!({"status": "ok", "results": rows})).unwrap();
    assert!(text.contains("[fact] Nova Tester"));
    assert!(text.contains("source: Outlook preview"));
    assert!(text.contains("[question]"));
    assert!(!text.contains("forbidden"));
    let long = activity_summary(&json!({"status": "ok", "results": [
        {"statement": "a ".repeat(300), "source": "b ".repeat(300), "kind": "inference"}]}))
    .unwrap();
    assert!(long.chars().count() < 300);
}

#[test]
fn no_results_and_unavailable_are_distinct() {
    assert_eq!(
        activity_summary(&json!({"status": "ok", "results": []})),
        None
    );
    assert_eq!(
        activity_summary(&json!({"status": "skipped", "results": []})),
        None
    );
    assert!(
        activity_summary(&json!({"status": "unavailable", "results": []}))
            .unwrap()
            .contains("unavailable")
    );
}

#[test]
fn end_to_end_activity_excludes_unrelated_and_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.db");
    fixture(&path);
    let text = activity_summary(&automatic_context("Nova Tester meeting", &path)).unwrap();
    assert!(text.contains("[fact]"));
    assert!(text.contains("[question]"));
    assert!(!text.contains("Housing"));
    assert!(!text.contains("password"));
    assert!(!text.contains("example.com"));
}

/// test_rust_memory_search.py: the reader's candidates and the disclosure filters together.
#[test]
fn the_reader_escapes_patterns_and_skips_odd_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memory.sqlite3");
    let db = Connection::open(&path).unwrap();
    db.execute(
        "CREATE TABLE memories(id INTEGER PRIMARY KEY, statement, source, kind, observed_at)",
        [],
    )
    .unwrap();
    let rows: [(i64, &str, &dyn rusqlite::ToSql, &str, &str); 6] = [
        (
            1,
            "Nova Tester discussed club",
            &"message",
            "fact",
            "2026-01-01",
        ),
        (
            2,
            "Nova Tester password secret",
            &"message",
            "fact",
            "2026-01-02",
        ),
        (
            3,
            "Nova_Tester meeting",
            &"document",
            "question",
            "2026-01-03",
        ),
        (
            4,
            "Nova Tester wrote",
            &"hello@example.com",
            "fact",
            "2026-01-04",
        ),
        (5, "Nova Tester thing", &"notes", "untrusted", "2026-01-05"),
        (
            6,
            "Nova Tester thing",
            &b"blob".to_vec(),
            "fact",
            "2026-01-06",
        ),
    ];
    for (id, statement, source, kind, observed) in rows {
        db.execute(
            "INSERT INTO memories VALUES(?,?,?,?,?)",
            rusqlite::params![id, statement, source, kind, observed],
        )
        .unwrap();
    }
    drop(db);
    let plain = search("Nova Tester", &path);
    let underscore = search("Nova_Tester", &path);
    let automatic = automatic_context("Nova Tester club", &path);
    let statements = |r: &Value| -> Vec<String> {
        r["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["statement"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(statements(&underscore), ["Nova_Tester meeting"]);
    assert_eq!(
        statements(&plain),
        [
            "Nova Tester wrote",
            "Nova_Tester meeting",
            "Nova Tester discussed club"
        ]
    );
    assert!(automatic["results"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| !r["source"].as_str().unwrap().contains('@')));
    assert_eq!(
        statements(&automatic),
        ["Nova Tester discussed club", "Nova_Tester meeting"]
    );
}
