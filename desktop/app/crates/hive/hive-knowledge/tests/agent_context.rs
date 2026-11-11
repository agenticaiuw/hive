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
