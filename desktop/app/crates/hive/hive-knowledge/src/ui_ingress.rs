//! Durable UI request admissions in the shared private ingress ledger (python/ui_ingress.py,
//! calling hive-core's request ledger directly).
//!
//! The ledger lives in `<state>/control`.

use crate::pyjson;
use crate::util;
use hive_core::request_ledger;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// What agent-request-ledger accepted on stdin, at most.
const MAX_INPUT: usize = 1024 * 1024;

/// `<state>/control`.
pub fn control_dir() -> PathBuf {
    hive_common::paths::state_dir().join("control")
}

/// Admits a request typed or spoken in the UI (`channel`: where it came from). Returns its
/// receipt id. A duplicate or an empty request is an error, as is an unwritable ledger.
pub fn admit(text: &str, channel: &str) -> Result<String, String> {
    admit_in(&control_dir(), text, channel)
}

/// [`admit`] into a given ledger folder.
pub fn admit_in(directory: &Path, text: &str, channel: &str) -> Result<String, String> {
    let source = format!("ui:{channel}:{}", util::uuid_hex());
    if pyjson::dumps_utf8(&json!({"sourceId": source, "text": text})).len() > MAX_INPUT {
        return Err("Request ledger unavailable".into());
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("Request ledger unavailable".into());
    }
    let receipt = request_ledger::admit(directory, Some(&source), text, None)?;
    if receipt.duplicate {
        return Err("Request admission was not confirmed".into());
    }
    Ok(receipt.id)
}

/// Marks a receipt finished with `status`. Returns `{"ok": true}`.
pub fn finish(receipt: &str, status: &str) -> Result<Value, String> {
    finish_in(&control_dir(), receipt, status)
}

/// [`finish`] in a given ledger folder.
pub fn finish_in(directory: &Path, receipt: &str, status: &str) -> Result<Value, String> {
    request_ledger::finish(directory, receipt, status)?;
    Ok(json!({"ok": true}))
}
