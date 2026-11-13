//! Decide whether an update can safely replace the workspace engine.
//!
//! Doctor output is untrusted, transient data. Unknown, inconsistent, invalid,
//! oversized or timed-out reports fail closed, preserving the running engine.

use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

pub const DOCTOR_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_DOCTOR_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineChoice {
    New,
    Preserve,
    Unsafe,
}
impl EngineChoice {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Preserve => "preserve",
            Self::Unsafe => "unsafe",
        }
    }
}

/// Require the two observations to refer to the same running daemon.
pub fn decision(candidate: &Value, installed: &Value) -> EngineChoice {
    let Some(new) = candidate.get("daemon").and_then(Value::as_object) else {
        return EngineChoice::Unsafe;
    };
    let Some(old) = installed.get("daemon").and_then(Value::as_object) else {
        return EngineChoice::Unsafe;
    };
    let (Some(new_running), Some(old_running)) = (
        new.get("running").and_then(Value::as_bool),
        old.get("running").and_then(Value::as_bool),
    ) else {
        return EngineChoice::Unsafe;
    };
    if new_running != old_running {
        return EngineChoice::Unsafe;
    }
    if !new_running {
        return EngineChoice::New;
    }
    // A daemon identity is a string in the real protocol. Reject malformed
    // identities even if two malformed reports happen to compare equal.
    let Some(instance) = new
        .get("instanceID")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return EngineChoice::Unsafe;
    };
    if old.get("instanceID").and_then(Value::as_str) != Some(instance) {
        return EngineChoice::Unsafe;
    }
    if new.get("matchesCLI").and_then(Value::as_bool) == Some(true) {
        return EngineChoice::New;
    }
    if old.get("matchesCLI").and_then(Value::as_bool) == Some(true) {
        return EngineChoice::Preserve;
    }
    EngineChoice::Unsafe
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        // Reap even on a read/timeout error; do not leave a diagnostic running.
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

/// Run `doctor --json` with a hard deadline. Never expose its output to logs.
/// A non-zero process exit is allowed when it still emits a valid report, as
/// `doctor` can report a legitimate readiness problem through its exit status.
pub fn doctor(path: &Path, timeout: Duration) -> Value {
    fn capture(path: &Path, timeout: Duration) -> Option<Value> {
        // A private temporary file avoids a filled pipe and bounds memory use.
        let mut output = tempfile::tempfile().ok()?;
        let stdout: File = output.try_clone().ok()?;
        let child = Command::new(path)
            .args(["doctor", "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut child = ChildGuard(child);
        let deadline = Instant::now().checked_add(timeout)?;
        loop {
            match child.0.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(_) => return None,
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            thread::sleep(remaining.min(Duration::from_millis(20)));
        }
        if output.metadata().ok()?.len() > MAX_DOCTOR_BYTES {
            return None;
        }
        output.seek(SeekFrom::Start(0)).ok()?;
        let mut bytes = Vec::new();
        output
            .take(MAX_DOCTOR_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_DOCTOR_BYTES {
            return None;
        }
        let parsed: Value = serde_json::from_slice(&bytes).ok()?;
        parsed.is_object().then_some(parsed)
    }
    capture(path, timeout).unwrap_or_else(|| json!({}))
}

pub fn compare_engines(candidate: &Path, installed: &Path, timeout: Duration) -> EngineChoice {
    decision(&doctor(candidate, timeout), &doctor(installed, timeout))
}
