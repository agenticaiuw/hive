//! The session journal (tests/test_journal.py), in a temporary folder: no app, mic or audio.

mod common;

use hive_knowledge::session_journal::{self, SessionJournal};
use serde_json::{json, Map, Value};

fn env() -> common::Env {
    common::Env::new(&[("AGENT_STATE_DIR", ""), ("CODEX_HOME", "")])
}

fn about() -> Map<String, Value> {
    json!({"backend": "test"}).as_object().unwrap().clone()
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[test]
fn each_line_is_on_disk_as_soon_as_it_happens() {
    let _env = env();
    let journal = SessionJournal::new(about(), None).unwrap();
    journal.add(
        "you said",
        "Open Safari.",
        fields(json!({"outcome": "request"})),
    );
    let path = journal.dir.join("journal.jsonl");
    let text = std::fs::read_to_string(&path).unwrap(); // before end(): a crash keeps it
    let last: Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
    assert_eq!(last["text"], json!("Open Safari."));
    assert_eq!(common::mode(&path), 0o600);
    assert_eq!(common::mode(&journal.dir), 0o700);
    let first: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(
        (&first["kind"], &first["backend"]),
        (&json!("session started"), &json!("test"))
    );
    journal.end();
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(journal.dir.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["session"], json!(journal.id));
    assert_eq!(manifest["backend"], json!("test"));
    assert!(manifest["ended"].is_f64());
    assert_eq!(common::mode(&journal.dir.join("manifest.json")), 0o600);
    assert_eq!(journal.error(), None);
}

#[test]
fn a_line_cut_off_by_a_crash_is_skipped() {
    let _env = env();
    let journal = SessionJournal::new(Map::new(), None).unwrap();
    journal.add("you said", "one", Map::new());
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(journal.dir.join("journal.jsonl"))
        .unwrap();
    file.write_all(br#"{"time": 1, "kind": "you sa"#).unwrap();
    let entries = session_journal::read(&journal.dir).unwrap();
    assert_eq!(entries.last().unwrap()["text"], json!("one"));
}

#[test]
fn threads_point_to_codexs_full_context() {
    let env = env();
    let rollout = env
        .path()
        .join("sessions/2026/11/08/rollout-2026-11-08T21-18-56-abc123.jsonl");
    std::fs::create_dir_all(rollout.parent().unwrap()).unwrap();
    std::fs::write(&rollout, "{}\n").unwrap();
    let journal = SessionJournal::new(Map::new(), None).unwrap();
    journal.add("done", "ok", fields(json!({"thread": "abc123"})));
    journal.add("done", "again", fields(json!({"thread": "abc123"})));
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(journal.dir.join("manifest.json")).unwrap())
            .unwrap();
    assert_eq!(
        manifest["threads"],
        json!([{"thread": "abc123", "rollout": rollout.to_string_lossy()}])
    );
    let page = std::fs::read_to_string(journal.dir.join("index.html")).unwrap();
    assert!(page.contains("Codex thread <code>abc123</code>"));
}

#[test]
fn a_journal_that_cant_be_written_doesnt_stop_the_agent() {
    let _env = env();
    let journal = SessionJournal::new(Map::new(), None).unwrap();
    journal.end();
    let entry = journal.add("you said", "still fine", fields(json!({"device": null}))); // no panic
    assert_eq!(entry["text"], json!("still fine"));
    assert!(entry.get("device").is_none());
    assert!(journal.error().unwrap().contains("closed"));
}

#[test]
fn reading_it() {
    let env = env();
    let journal = SessionJournal::new(about(), None).unwrap();
    journal.add(
        "you said",
        "What time is it?",
        fields(json!({"outcome": "request"})),
    );
    journal.add("say", "It's 9:30.", fields(json!({"device": "mac"})));
    journal.end();
    let short = journal.id[..8].to_string();
    for command in [
        vec!["list"],
        vec!["show"],
        vec!["show", short.as_str()],
        vec!["paths"],
    ] {
        let mut out = Vec::new();
        let argv: Vec<String> = command.iter().map(|s| s.to_string()).collect();
        assert_eq!(session_journal::main(&argv, &mut out), 0, "{command:?}");
        assert!(!out.is_empty());
    }
    let mut out = Vec::new();
    session_journal::main(&["show".to_string()], &mut out);
    let shown = String::from_utf8(out).unwrap();
    assert!(
        shown.contains("🗣 you said: What time is it?  {\"outcome\": \"request\"}"),
        "{shown}"
    );
    assert!(shown.contains("It's 9:30."));
    let mut out = Vec::new();
    session_journal::main(&["list".to_string()], &mut out);
    assert_eq!(
        String::from_utf8(out).unwrap(),
        format!("{}  1 things you said, 4 entries\n", journal.id)
    );
    let sessions = std::fs::read_to_string(env.path().join("sessions/index.html")).unwrap();
    assert!(sessions.contains(&journal.id));
    assert!(sessions.contains(" · test</li>"));
    assert!(!std::fs::read_to_string(journal.dir.join("index.html"))
        .unwrap()
        .contains("<script"));
    let latest = std::fs::read_link(env.path().join("sessions/latest")).unwrap();
    assert_eq!(latest.to_string_lossy(), journal.id);
    let mut out = Vec::new();
    assert_eq!(
        session_journal::main(&["show".into(), "nothing-like-it".into()], &mut out),
        1
    );
    let mut out = Vec::new();
    assert_eq!(session_journal::main(&["help".into()], &mut out), 2);
    assert!(String::from_utf8(out)
        .unwrap()
        .starts_with(session_journal::USAGE));
}

#[test]
fn html_is_escaped() {
    let _env = env();
    let journal = SessionJournal::new(Map::new(), None).unwrap();
    journal.add("you said", "<script>alert(1)</script>", Map::new());
    let page = std::fs::read_to_string(journal.dir.join("index.html")).unwrap();
    assert!(!page.contains("<script>alert"));
    assert!(page.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
}

#[test]
fn lines_read_like_the_journal_reader() {
    let entry = json!({"time": 0, "kind": "action", "text": "go", "ok": true, "args": {"x": 1, "y": [2, "é"]}});
    let line = session_journal::line(&entry).unwrap();
    assert!(
        line.ends_with("  → action: go  {\"ok\": true, \"args\": {\"x\": 1, \"y\": [2, \"é\"]}}"),
        "{line}"
    );
    assert!(session_journal::line(&json!({"kind": "error"})).is_err());
}
