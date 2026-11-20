//! The context viewer (ContextTest in tests/test_resumption.py): exact payloads kept, screenshots
//! shown, untrusted text escaped, everything private.

mod common;

use hive_knowledge::agent_context::{render_payload, ContextLog};
use serde_json::{json, Value};

#[test]
fn full_payload_and_screenshot_survive_viewer_restart() {
    let env = common::Env::new(&[("AGENT_STATE_DIR", "")]);
    let payload = json!({"input": [{"type": "text", "text": "long ".repeat(2000)},
                                   {"type": "image", "url": "data:image/png;base64,QUJD"}]});
    let log = ContextLog::new();
    assert_eq!(log.directory, env.path().join("context"));
    log.record("turn/start input", &payload, None, Some("thread-123"))
        .unwrap();
    ContextLog::new()
        .record(
            "tool input",
            &json!({"arguments": {"text": "next"}}),
            None,
            None,
        )
        .unwrap();
    let mut records: Vec<_> = std::fs::read_dir(&log.directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    records.sort();
    let first: Value =
        serde_json::from_str(&std::fs::read_to_string(&records[0]).unwrap()).unwrap();
    assert_eq!(first["payload"], payload);
    assert_eq!(first["threadId"], json!("thread-123"));
    let index = std::fs::read_to_string(&log.index).unwrap();
    assert!(index.contains("turn/start input"));
    assert!(index.contains("tool input"));
    assert!(index.contains("thread-123"));
    let pages: Vec<String> = std::fs::read_dir(&log.directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            name.starts_with(|c: char| c.is_ascii_digit()) && name.ends_with(".html")
        })
        .map(|p| std::fs::read_to_string(p).unwrap())
        .collect();
    assert_eq!(pages.len(), 2);
    assert!(pages
        .iter()
        .any(|p| p.contains("src=\"data:image/png;base64,QUJD\"")));
    for entry in std::fs::read_dir(&log.directory).unwrap() {
        assert_eq!(common::mode(&entry.unwrap().path()), 0o600);
    }
    assert_eq!(common::mode(&log.directory), 0o700);
}

#[test]
fn untrusted_payload_is_escaped_and_cannot_load_remote_images() {
    let body = render_payload(
        &json!({"text": "<script>alert(\"x\")</script>", "url": "https://example.com/x.png"}),
    );
    assert!(!body.contains("<script>"));
    assert!(body.contains("&lt;script&gt;"));
    assert!(!body.contains("<img"));
}

#[test]
fn mcp_and_claude_screenshots_render() {
    for image in [
        json!({"type": "image", "mimeType": "image/jpeg", "data": "QUJD"}),
        json!({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "QUJD"}}),
    ] {
        assert!(render_payload(&image).contains("src=\"data:image/jpeg;base64,QUJD\""));
    }
}

#[test]
fn a_resumed_thread_points_to_codex_for_its_history_instead_of_copying_every_turn() {
    let env = common::Env::new(&[("AGENT_STATE_DIR", "")]);
    let turn = json!({"id": "t1", "items": [{"type": "agentMessage", "text": "big ".repeat(5000)}]});
    let resumed = json!({"thread": {"id": "th-1", "path": "/codex/sessions/rollout-th-1.jsonl",
                                    "preview": "Use the device the request is about", "turns": [turn.clone(), turn]}});
    let log = ContextLog::new();
    log.record("thread/resume output", &resumed, None, Some("th-1")).unwrap();
    let record = std::fs::read_dir(&log.directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .unwrap();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&record).unwrap()).unwrap();
    let turns = saved["payload"]["thread"]["turns"].as_str().unwrap();
    assert!(turns.starts_with("2 earlier turns, not copied here"), "{turns}");
    assert!(turns.contains("/codex/sessions/rollout-th-1.jsonl"));
    assert_eq!(saved["payload"]["thread"]["preview"], json!("Use the device the request is about"));
    assert!(std::fs::metadata(&record).unwrap().len() < 2_000);
    drop(env);

    // Anything else, and a thread with no turns yet, is kept exactly.
    let fresh = json!({"thread": {"id": "th-2", "turns": []}});
    assert_eq!(hive_knowledge::agent_context::without_thread_history(&fresh), fresh);
    let other = json!({"input": [{"type": "text", "text": "hi"}]});
    assert_eq!(hive_knowledge::agent_context::without_thread_history(&other), other);
}

#[test]
fn the_index_lists_the_newest_records_without_reading_every_label() {
    let env = common::Env::new(&[("AGENT_STATE_DIR", "")]);
    let log = ContextLog::new();
    std::fs::create_dir_all(&log.directory).unwrap();
    let total = hive_knowledge::agent_context::INDEXED + 100;
    for n in 0..total {
        let stem = format!("{:020}-old", 1_000 + n);
        std::fs::write(log.directory.join(format!("{stem}.html")), "x").unwrap();
        std::fs::write(log.directory.join(format!("{stem}.title")), format!("old record {n}")).unwrap();
    }
    log.record("tool input", &json!({"n": 1}), None, None).unwrap();
    log.record("tool output", &json!({"n": 2}), None, None).unwrap();
    let index = std::fs::read_to_string(&log.index).unwrap();
    assert_eq!(index.matches("<li>").count(), hive_knowledge::agent_context::INDEXED);
    let (output, input) = (index.find("· tool output<").unwrap(), index.find("· tool input<").unwrap());
    assert!(output < input, "newest first");
    assert!(index.contains(&format!("old record {}<", total - 1)));
    assert!(!index.contains("old record 0<")); // past the newest 500: still on disk, not listed
    assert!(log.directory.join(format!("{:020}-old.html", 1_000)).exists());
    drop(env);
}
