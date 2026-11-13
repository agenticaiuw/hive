//! The memory store that memory_search reads (tests/test_rust_memory_store.py), called in-process
//! through hive-core as hive-app will: one shared private database, records deduplicated
//! and trimmed, nothing created by a list, and a bad database never replaced.

mod common;

use hive_knowledge::memory_search;
use hive_core::memory::execute;
use serde_json::{json, Value};

fn rows(answer: &Value) -> Vec<Value> {
    serde_json::from_str(answer["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[test]
fn records_are_shared_and_deduplicated() {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path();
    execute(
        state,
        &json!({"op": "add", "statement": "  Café task  ", "source": " photo ", "kind": "fact"}),
    )
    .unwrap();
    execute(
        state,
        &json!({"op": "add", "statement": "Café task", "source": "photo", "kind": "fact"}),
    )
    .unwrap();
    execute(
        state,
        &json!({"op": "add", "statement": "Next", "source": "notes", "kind": "question"}),
    )
    .unwrap();
    let listed = rows(&execute(state, &json!({"op": "list"})).unwrap());
    let statements: Vec<&str> = listed.iter().map(|r| r[1].as_str().unwrap()).collect();
    assert_eq!(statements, ["Next", "Café task"]);
    assert_eq!(common::mode(&state.join("memory")), 0o700);
    let database = state.join("memory/personal-memory.sqlite3");
    assert_eq!(common::mode(&database), 0o600);
    // The search reads the same database.
    let found = memory_search::search("café task", &database);
    assert_eq!(found["results"][0]["statement"], json!("Café task"));
    assert_eq!(found["results"][0]["source"], json!("photo"));
}

#[test]
fn a_list_of_nothing_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let answer = execute(dir.path(), &json!({"op": "list"})).unwrap();
    assert!(answer["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("No memories"));
    assert!(!dir.path().join("memory").exists());
}

#[test]
fn a_bad_record_is_refused_before_anything_is_made() {
    let dir = tempfile::tempdir().unwrap();
    assert!(execute(
        dir.path(),
        &json!({"op": "add", "statement": "x", "source": "s", "kind": "secret"})
    )
    .is_err());
    assert!(execute(dir.path(), &json!({"op": "remove"})).is_err());
    assert!(!dir.path().join("memory").exists());
}

#[test]
fn a_failed_read_rolls_back_the_new_record() {
    let dir = tempfile::tempdir().unwrap();
    let directory = dir.path().join("memory");
    std::fs::create_dir(&directory).unwrap();
    let database = directory.join("personal-memory.sqlite3");
    rusqlite::Connection::open(&database)
        .unwrap()
        .execute(
            "CREATE TABLE memories(id INTEGER PRIMARY KEY, statement TEXT, source TEXT, kind TEXT)",
            [],
        )
        .unwrap();
    assert!(execute(
        dir.path(),
        &json!({"op": "add", "statement": "new", "source": "notes", "kind": "fact"})
    )
    .is_err());
    let count: i64 = rusqlite::Connection::open(&database)
        .unwrap()
        .query_row("SELECT count(*) FROM memories", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn a_bad_database_fails_without_exposing_or_replacing_it() {
    let dir = tempfile::tempdir().unwrap();
    let directory = dir.path().join("memory");
    std::fs::create_dir(&directory).unwrap();
    let database = directory.join("personal-memory.sqlite3");
    std::fs::write(&database, b"broken").unwrap();
    let error = execute(dir.path(), &json!({"op": "list"})).unwrap_err();
    assert!(!error.contains("broken"));
    assert_eq!(std::fs::read(&database).unwrap(), b"broken");
    assert_eq!(
        memory_search::search("anything", &database)["status"],
        json!("unavailable")
    );
}
