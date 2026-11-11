//! The Agent Context panel's data (tests/test_context_panel.py), from a journal and context
//! records in a temporary folder: no app, Codex or screen.

mod common;

use hive_knowledge::agent_context::ContextLog;
use hive_knowledge::context_panel::{self, Builder};
use hive_knowledge::session_journal::{self, SessionJournal};
use serde_json::{json, Map, Value};
use std::sync::Arc;

fn png() -> String {
    format!("data:image/png;base64,{}", "iVBORw0KGgo".repeat(50))
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

/// A session of its own in a temporary state folder, as this process's current session.
struct Panel {
    journal: Arc<SessionJournal>,
    _env: common::Env,
}

impl Panel {
    fn new() -> Panel {
        let env = common::Env::new(&[("AGENT_STATE_DIR", ""), ("CODEX_HOME", "")]);
        let journal =
            Arc::new(SessionJournal::new(fields(json!({"backend": "test"})), None).unwrap());
        session_journal::set_current(Some(journal.clone()));
        Panel { journal, _env: env }
    }

    fn request(&self, text: &str) {
        let j = &self.journal;
        j.add("you said", text, fields(json!({"outcome": "request"})));
        j.add("request", text, fields(json!({"device": "mac"})));
        let log = ContextLog::new();
        let record = |kind: &str, payload: Value| {
            log.record(kind, &payload, Some(text), Some("t1")).unwrap()
        };
        record(
            "turn/start input",
            json!({"threadId": "t1", "input": [{"type": "text", "text": format!("The user just asked: {text}")},
                                               {"type": "image", "url": png()}]}),
        );
        record(
            "tool input",
            json!({"namespace": "mac", "tool": "click", "arguments": {"x": 1, "y": 2}}),
        );
        record(
            "tool output",
            json!({"callId": "c", "result": {"success": true, "contentItems": [
                {"type": "inputText", "text": "Clicked."}, {"type": "inputImage", "imageUrl": png()}]}}),
        );
        record(
            "thread/tokenUsage/updated",
            json!({"tokenUsage": {"last": {"inputTokens": 41000, "outputTokens": 200}, "modelContextWindow": 272000}}),
        );
        j.add(
            "say",
            "Done that.",
            fields(json!({"device": "mac", "request": text, "thread": "t1"})),
        );
        j.add(
            "done",
            "Done that.",
            fields(json!({"device": "mac", "request": text, "thread": "t1"})),
        );
    }

    fn build(&self) -> Value {
        Builder::new(self.journal.dir.clone(), None)
            .build()
            .unwrap()
    }
}

impl Drop for Panel {
    fn drop(&mut self) {
        session_journal::set_current(None);
    }
}

#[test]
fn requests_are_grouped_with_what_went_to_the_model() {
    let panel = Panel::new();
    panel.request("Open Safari");
    panel.request("Search for the weather");
    let feed = panel.build();
    let groups = feed["groups"].as_array().unwrap();
    let requests: Vec<&Value> = groups
        .iter()
        .filter(|g| g["kind"] == json!("request"))
        .collect();
    let titles: Vec<&str> = requests
        .iter()
        .map(|g| g["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, ["Open Safari", "Search for the weather"]);
    let first = requests[0];
    assert_eq!(first["status"], json!("done"));
    assert_eq!(first["inputs"], json!(3)); // the prompt, the tool call, its result
    let labels: Vec<&str> = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["label"].as_str().unwrap())
        .collect();
    assert!(labels.contains(&"You said"));
    assert!(labels.contains(&"Agent said"));
    assert!(labels.contains(&"Tool call · mac.click"));
    assert!(labels.contains(&"Tool result · 1 screenshot"));
    let sent = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == json!("turn/start input"))
        .unwrap();
    assert!(sent["detail"]
        .as_str()
        .unwrap()
        .contains("The user just asked: Open Safari"));
    assert_eq!(sent["images"], json!(1));
    assert!(sent["record"].as_str().unwrap().ends_with(".html"));
    assert!(sent.get("task").is_none());
    assert!(!feed.to_string().contains("iVBORw0KGgo")); // screenshots are counted, not copied
    assert_eq!(feed["model_context"]["tokens"], json!(41200));
    assert!(feed["notice"]
        .as_str()
        .unwrap()
        .contains("not the model's exact current context"));
    let note = feed["model_context"]["note"].as_str().unwrap();
    assert!(note.contains("41,200"));
    assert!(note.starts_with("Codex last reported 41,200 tokens in the model's context (of 272,000); it compacts past about 150,000."));
    assert!(note.ends_with("Codex's own full record of the thread: (not found)"));
    assert_eq!(groups[0]["title"], json!("Session started"));
    let keys: Vec<&String> = feed.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "version",
            "session",
            "started",
            "updated",
            "ended",
            "code",
            "backend",
            "notice",
            "model_context",
            "groups",
            "journal",
            "context_index"
        ]
    );
    let model: Vec<&String> = feed["model_context"].as_object().unwrap().keys().collect();
    assert_eq!(
        model,
        [
            "tokens",
            "window",
            "measured_at",
            "compacted_at",
            "compact_at",
            "threads",
            "note"
        ]
    );
}

#[test]
fn other_sessions_records_are_left_out() {
    let panel = Panel::new();
    panel.request("Open Safari");
    session_journal::set_current(None);
    ContextLog::new()
        .record(
            "turn/start input",
            &json!({"input": [{"type": "text", "text": "someone else's"}]}),
            Some("x"),
            None,
        )
        .unwrap();
    let feed = panel.build();
    assert!(!feed.to_string().contains("someone else's"));
}

#[test]
fn compaction_and_ingestion_show() {
    let panel = Panel::new();
    panel.request("Open Safari");
    ContextLog::new()
        .record(
            "item/started",
            &json!({"item": {"type": "contextCompaction"}}),
            Some("Open Safari"),
            None,
        )
        .unwrap();
    panel.journal.add(
        "ingest started",
        "Meeting",
        fields(json!({"chars": 50000, "tokens_estimated": 12500, "parts": 5, "mode": "in the conversation", "id": "x"})),
    );
    panel.journal.add(
        "ingest done",
        "Meeting: in the conversation, verified",
        fields(json!({"id": "x", "status": "verified"})),
    );
    let feed = panel.build();
    assert!(feed["model_context"]["compacted_at"].is_f64());
    assert!(feed["model_context"]["note"]
        .as_str()
        .unwrap()
        .contains("compacted"));
    let ingest = feed["groups"].as_array().unwrap().last().unwrap();
    assert_eq!(ingest["kind"], json!("ingest"));
    assert_eq!(ingest["status"], json!("verified"));
    assert_eq!(ingest["title"], json!("Added: Meeting"));
    let summary = ingest["items"][0]["summary"].as_str().unwrap();
    assert!(summary.contains("12,500 tokens (estimated)"), "{summary}");
    assert_eq!(summary, "“Meeting”: 50,000 characters, about 12,500 tokens (estimated), 5 parts, in the conversation");
}

#[test]
fn the_journal_keeps_panel_json_current_and_private() {
    let panel = Panel::new();
    panel.request("Open Safari");
    let path = panel.journal.panel_path();
    assert!(
        common::wait_for(5.0, || path.exists()),
        "{:?}",
        panel.journal.panel_error()
    );
    assert_eq!(common::mode(&path), 0o600);
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(written["session"], json!(panel.journal.id));
}

#[test]
fn long_details_say_how_much_more_there_is() {
    assert!(
        context_panel::detail(&"x".repeat(context_panel::DETAIL + 5000))
            .contains("5,000 more characters")
    );
    assert_eq!(context_panel::short("  a\n b  ", 240), "a b");
    assert_eq!(context_panel::short("abcdef", 4), "abc…");
}

#[test]
fn pending_words_fold_into_their_request() {
    let panel = Panel::new();
    panel.journal.add(
        "you said",
        "Open Notes",
        fields(json!({"outcome": "request"})),
    );
    panel
        .journal
        .add("request", "Open Notes", fields(json!({"device": "mac"})));
    panel
        .journal
        .add("you said", "stop", fields(json!({"outcome": "stop"})));
    let feed = panel.build();
    let groups = feed["groups"].as_array().unwrap();
    assert!(groups.iter().all(|g| g["kind"] != json!("pending")));
    let request = groups
        .iter()
        .find(|g| g["kind"] == json!("request"))
        .unwrap();
    let labels: Vec<&str> = request["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["You said", "You said (stop)"]);
    assert_eq!(request["status"], json!("running"));
}
