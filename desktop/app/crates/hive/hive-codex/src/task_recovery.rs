//! Durable, bounded ownership of a single primary conversation request (python/task_recovery.py),
//! on `personal_agent_core::task_recovery` (what Python reached through libagent-core.dylib).
//!
//! `<state>/task-recovery.json` holds the request's id, device, thread, status and how many
//! startup and blocked continuations were admitted; never the request's text. Errors: a state
//! file that can't be read or written is `AgentError::Os` ("State unavailable"); an invalid one is
//! `AgentError::Value`.

use crate::util::{random_hex, AgentError};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::path::Path;

fn apply(dir: &Path, request: Value) -> Result<Value, AgentError> {
    personal_agent_core::task_recovery::apply(dir, &request).map_err(|message| {
        if message == "State unavailable" {
            AgentError::Os(message)
        } else {
            AgentError::Value(message)
        }
    })
}

/// Records a new request as the one to recover (it replaces any earlier one). Returns its id.
/// (Python's `begin(task, ...)` took the request's text and didn't save it; it isn't taken here.)
pub fn begin(
    dir: &Path,
    device: &str,
    thread: &str,
    receipt_id: Option<&str>,
) -> Result<String, AgentError> {
    let id = random_hex()?;
    let result = apply(
        dir,
        json!({"op": "begin", "id": id, "device": device, "thread": thread,
                                   "receiptId": receipt_id}),
    )?;
    Ok(result.as_str().map(str::to_owned).unwrap_or(id))
}

/// The saved record, if there is one.
pub fn current(dir: &Path) -> Result<Option<Value>, AgentError> {
    Ok(Some(apply(dir, json!({"op": "current"}))?).filter(|v| !v.is_null()))
}

/// Sets the record's status ("finished", "stopped", "paused", "active") if it is still `identity`'s.
pub fn finish(dir: &Path, identity: &str, status: &str) -> Result<bool, AgentError> {
    Ok(apply(
        dir,
        json!({"op": "finish", "identity": identity, "status": status}),
    )?
    .as_bool()
        == Some(true))
}

/// Admits one `kind` ("startup" or "blocked") continuation of the active record (of `identity`,
/// if given): the record, or None if it isn't active or one was admitted already.
pub fn reserve(
    dir: &Path,
    kind: &str,
    identity: Option<&str>,
) -> Result<Option<Value>, AgentError> {
    if kind != "startup" && kind != "blocked" {
        return Err(AgentError::Value("invalid recovery kind".into()));
    }
    Ok(Some(apply(
        dir,
        json!({"op": "reserve", "kind": kind, "identity": identity}),
    )?)
    .filter(|v| !v.is_null()))
}

/// The lock that makes this process the one that may continue saved work
/// (`<state>/task-recovery-owner.lock`). Released when dropped or closed.
pub struct OwnerLock(File);

impl OwnerLock {
    pub fn close(self) {}
}

impl Drop for OwnerLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

/// Takes the owner lock, or None if another process (or task) holds it.
pub fn acquire_owner(dir: &Path) -> Result<Option<OwnerLock>, AgentError> {
    use std::os::fd::AsRawFd;
    make_private_dir(dir)?;
    let file = OpenOptions::new()
        .append(true)
        .read(true)
        .create(true)
        .open(dir.join("task-recovery-owner.lock"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Ok(None);
        }
        return Err(error.into());
    }
    Ok(Some(OwnerLock(file)))
}

/// What to continue when the app starts (voice_agent.py's `startup_recovery_record`): a saved
/// request waiting for provider access (every start, while it waits), else the one startup
/// continuation of an active saved request. Never one whose provider wait was resolved: its
/// continuation may have been sent before a crash.
pub fn startup_recovery_record(dir: &Path) -> Result<Option<Value>, AgentError> {
    let saved = current(dir)?;
    let provider_state = match saved
        .as_ref()
        .and_then(|s| s.get("id"))
        .and_then(Value::as_str)
    {
        Some(id) => crate::provider_wait::status(dir, id)?,
        None => None,
    };
    if let Some(saved) = &saved {
        if saved.get("status").and_then(Value::as_str) == Some("active")
            && provider_state == Some("waiting")
        {
            return Ok(Some(saved.clone())); // The process owner lock serializes harmless waiting across restarts.
        }
    }
    if provider_state == Some("resolved") {
        return Ok(None); // Dispatch may have happened before a crash; do not repeat it.
    }
    reserve(dir, "startup", None)
}

pub(crate) fn make_private_dir(dir: &Path) -> Result<(), AgentError> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    // tests/test_task_recovery.py

    #[test]
    fn reservations_and_stop_survive_reload() {
        let d = dir();
        let identity = begin(d.path(), "mac", "thread-1", None).unwrap();
        assert_eq!(
            reserve(d.path(), "startup", None).unwrap().unwrap()["id"],
            identity.as_str()
        );
        assert!(reserve(d.path(), "startup", None).unwrap().is_none());
        assert_eq!(
            reserve(d.path(), "blocked", Some(&identity))
                .unwrap()
                .unwrap()["id"],
            identity.as_str()
        );
        assert!(reserve(d.path(), "blocked", Some(&identity))
            .unwrap()
            .is_none());
        finish(d.path(), &identity, "stopped").unwrap();
        assert!(reserve(d.path(), "startup", None).unwrap().is_none());
        assert!(reserve(d.path(), "blocked", Some(&identity))
            .unwrap()
            .is_none());
    }

    #[test]
    fn old_owner_cannot_stop_new_request() {
        let d = dir();
        let old = begin(d.path(), "mac", "thread-1", None).unwrap();
        let new = begin(d.path(), "mac", "thread-1", None).unwrap();
        assert!(!finish(d.path(), &old, "stopped").unwrap());
        assert_eq!(
            reserve(d.path(), "startup", None).unwrap().unwrap()["id"],
            new.as_str()
        );
    }

    #[test]
    fn owner_lock_prevents_second_process_owner() {
        let d = dir();
        let owner = acquire_owner(d.path()).unwrap();
        assert!(owner.is_some());
        assert!(acquire_owner(d.path()).unwrap().is_none());
        owner.unwrap().close();
        let second = acquire_owner(d.path()).unwrap();
        assert!(second.is_some());
    }

    #[test]
    fn invalid_record_fails_closed() {
        let d = dir();
        std::fs::write(d.path().join("task-recovery.json"), "{}").unwrap();
        assert!(matches!(
            reserve(d.path(), "startup", None),
            Err(AgentError::Value(_))
        ));
    }

    #[test]
    fn request_text_is_never_saved_and_legacy_records_are_scrubbed() {
        let d = dir();
        let secret = "unlabeled sensitive request text";
        let identity = begin(d.path(), "mac", "thread-1", None).unwrap();
        let path = d.path().join("task-recovery.json");
        assert!(!std::fs::read_to_string(&path).unwrap().contains(secret));
        let mut legacy = current(d.path()).unwrap().unwrap();
        legacy["task"] = json!(secret);
        std::fs::write(&path, legacy.to_string()).unwrap();
        assert_eq!(
            reserve(d.path(), "startup", None).unwrap().unwrap()["id"],
            identity.as_str()
        );
        assert!(!std::fs::read_to_string(&path).unwrap().contains(secret));
        assert!(current(d.path()).unwrap().unwrap().get("task").is_none());
    }

    #[test]
    fn recovery_links_to_the_ingress_receipt_without_request_text() {
        let d = dir();
        let receipt = "a".repeat(32);
        let identity = begin(d.path(), "mac", "thread-1", Some(&receipt)).unwrap();
        let record = current(d.path()).unwrap().unwrap();
        assert_eq!(
            (
                record["id"].as_str().unwrap(),
                record["receiptId"].as_str().unwrap()
            ),
            (identity.as_str(), receipt.as_str())
        );
    }

    /// tests/test_ledger_control.py: a receipt ID that isn't one (say, text that slipped in) is
    /// refused, and the saved record keeps the one it had.
    #[test]
    fn native_recovery_record_keeps_only_valid_receipt_id() {
        let d = dir();
        let receipt = "a".repeat(32);
        begin(d.path(), "mac", "thread-1", Some(&receipt)).unwrap();
        let saved = current(d.path()).unwrap().unwrap();
        assert!(begin(d.path(), "mac", "thread-1", Some("secret-like text")).is_err());
        let after = current(d.path()).unwrap().unwrap();
        assert_eq!(after["receiptId"], receipt.as_str());
        assert_eq!(after, saved);
    }

    // tests/test_rust_task_recovery.py

    #[test]
    fn transitions_give_the_expected_results() {
        // (Python compared its own implementation with the native one; there is only one here.)
        let d = dir();
        let ident = begin(d.path(), "mac", "thread-1", None).unwrap();
        let initial = current(d.path()).unwrap().unwrap();
        assert_eq!(
            initial,
            json!({"version": 1, "id": ident, "device": "mac", "thread": "thread-1",
                                   "status": "active", "startup_attempts": 0, "blocked_attempts": 0})
        );
        let startup = reserve(d.path(), "startup", Some(&ident)).unwrap().unwrap();
        assert_eq!(startup["startup_attempts"], 1);
        assert!(reserve(d.path(), "startup", Some(&ident))
            .unwrap()
            .is_none());
        assert!(!finish(d.path(), "other", "stopped").unwrap());
        assert!(finish(d.path(), &ident, "stopped").unwrap());
        assert!(reserve(d.path(), "blocked", Some(&ident))
            .unwrap()
            .is_none());
        assert_eq!(current(d.path()).unwrap().unwrap()["status"], "stopped");
    }

    #[test]
    fn concurrent_reservations_admit_only_one() {
        // Python ran six processes; each call here opens and locks the state file on its own.
        let d = dir();
        begin(d.path(), "mac", "thread-1", None).unwrap();
        let path = d.path().to_path_buf();
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || reserve(&path, "startup", None).unwrap())
            })
            .collect();
        let admitted = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(Option::is_some)
            .count();
        assert_eq!(admitted, 1);
        assert_eq!(current(d.path()).unwrap().unwrap()["startup_attempts"], 1);
    }

    // tests/test_provider_wait.py (voice_agent's startup_recovery_record)

    #[test]
    fn wait_survives_restarts_but_resolved_dispatch_is_not_repeated() {
        let d = dir();
        let identity = begin(d.path(), "mac", "thread", None).unwrap();
        crate::provider_wait::reserve(d.path(), &identity, Some(100.0), true).unwrap();
        for _ in 0..2 {
            assert_eq!(
                startup_recovery_record(d.path()).unwrap().unwrap()["id"],
                identity.as_str()
            );
        }
        assert_eq!(current(d.path()).unwrap().unwrap()["startup_attempts"], 0);
        crate::provider_wait::resolve(d.path(), &identity).unwrap();
        assert!(startup_recovery_record(d.path()).unwrap().is_none());
    }

    #[test]
    fn stopped_wait_is_not_recovered_after_restart() {
        let d = dir();
        let identity = begin(d.path(), "mac", "thread", None).unwrap();
        crate::provider_wait::reserve(d.path(), &identity, Some(100.0), true).unwrap();
        finish(d.path(), &identity, "stopped").unwrap();
        assert!(startup_recovery_record(d.path()).unwrap().is_none());
    }

    #[test]
    fn startup_admits_one_continuation_without_a_provider_wait() {
        let d = dir();
        let identity = begin(d.path(), "mac", "thread", None).unwrap();
        assert_eq!(
            startup_recovery_record(d.path()).unwrap().unwrap()["id"],
            identity.as_str()
        );
        assert!(startup_recovery_record(d.path()).unwrap().is_none());
    }

    #[test]
    fn oversized_invalid_state_is_not_replaced() {
        let d = dir();
        let path = d.path().join("task-recovery.json");
        std::fs::write(&path, "x".repeat(512 * 1024 + 1)).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(matches!(
            begin(d.path(), "mac", "thread-1", None),
            Err(AgentError::Value(_))
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
