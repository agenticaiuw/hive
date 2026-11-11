//! UI admissions in the real request ledger (test_real_ledger_receipt_is_durable_and_private in
//! tests/test_ui_ingress.py), in a temporary state folder. The voice-agent wiring tests stay with
//! voice_agent.py's port.

mod common;

use hive_knowledge::ui_ingress;
use personal_agent_core::request_ledger;
use serde_json::{json, Value};

fn listing(control: &std::path::Path) -> Value {
    request_ledger::list(control).unwrap()
}

#[test]
fn real_ledger_receipt_is_durable_and_private() {
    let env = common::Env::new(&[("AGENT_STATE_DIR", "")]);
    let control = env.path().join("control");
    assert_eq!(ui_ingress::control_dir(), control);
    let receipt = ui_ingress::admit("Make the project plan", "voice").unwrap();
    let first = &listing(&control)[0];
    assert_eq!(
        (&first["receiptId"], &first["status"]),
        (&json!(receipt), &json!("dispatching"))
    );
    let bytes = std::fs::read(control.join("request-ledger.sqlite3")).unwrap();
    assert!(!bytes.windows(21).any(|w| w == b"Make the project plan"));
    assert_eq!(
        ui_ingress::finish(&receipt, "accepted").unwrap(),
        json!({"ok": true})
    );
    assert_eq!(listing(&control)[0]["status"], json!("accepted"));
}

#[test]
fn each_admission_is_its_own_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let one = ui_ingress::admit_in(dir.path(), "  Open Safari  ", "typed").unwrap();
    let two = ui_ingress::admit_in(dir.path(), "Open Safari", "typed").unwrap();
    assert_ne!(one, two);
    assert_eq!(listing(dir.path()).as_array().unwrap().len(), 2);
}

#[test]
fn nothing_to_admit_or_a_bad_status_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        ui_ingress::admit_in(dir.path(), "   ", "voice").unwrap_err(),
        "Request ledger unavailable"
    );
    assert!(ui_ingress::admit_in(dir.path(), &"x".repeat(1024 * 1024), "voice").is_err());
    let receipt = ui_ingress::admit_in(dir.path(), "Open Notes", "voice").unwrap();
    assert!(ui_ingress::finish_in(dir.path(), &receipt, "done").is_err());
}
