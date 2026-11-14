//! Small pieces the driver shares: Python's `threading.Event`, the errors agent.py caught by
//! class, and the environment the agent reads its settings from.

use std::collections::HashMap;
use std::fmt;
use std::process::Command;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Locks a mutex, carrying on after a panic elsewhere poisoned it (the state stays usable).
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Python's `threading.Event`.
#[derive(Default)]
pub struct Event {
    flag: Mutex<bool>,
    changed: Condvar,
}

impl Event {
    pub fn new(set: bool) -> Self {
        Self {
            flag: Mutex::new(set),
            changed: Condvar::new(),
        }
    }
    pub fn set(&self) {
        *lock(&self.flag) = true;
        self.changed.notify_all();
    }
    pub fn clear(&self) {
        *lock(&self.flag) = false;
    }
    pub fn is_set(&self) -> bool {
        *lock(&self.flag)
    }
    /// Waits until it is set, or `seconds` pass (None: forever). True if it is set.
    pub fn wait(&self, seconds: Option<f64>) -> bool {
        let mut flag = lock(&self.flag);
        let deadline = seconds.map(|s| Instant::now() + Duration::from_secs_f64(s.max(0.0)));
        while !*flag {
            match deadline {
                None => flag = self.changed.wait(flag).unwrap_or_else(|e| e.into_inner()),
                Some(deadline) => {
                    let now = Instant::now();
                    if now >= deadline {
                        return false;
                    }
                    flag = self
                        .changed
                        .wait_timeout(flag, deadline - now)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            }
        }
        true
    }
}

/// The errors agent.py told apart by class: `CodexError` (the app-server), `ResumeError` (the
/// saved conversation), `OSError`, `ValueError` (a state file) and `SystemExit` (no Codex).
/// Each displays as its message, as `str(error)` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentError {
    Codex(String),
    Resume(String),
    Os(String),
    Value(String),
    Exit(String),
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Codex(m) | Self::Resume(m) | Self::Os(m) | Self::Value(m) | Self::Exit(m) => {
                f.write_str(m)
            }
        }
    }
}

impl std::error::Error for AgentError {}

impl From<std::io::Error> for AgentError {
    fn from(e: std::io::Error) -> Self {
        Self::Os(e.to_string())
    }
}

/// The environment the agent reads its settings from (CODEX_BIN, AGENT_MODEL, AGENT_STATE_DIR,
/// AGENT_WORKSPACE_ENGINE, ...): the process's own, with overrides on top. The tests give each
/// agent its own overrides instead of changing the process's environment, and the app-server is
/// started with them.
#[derive(Default)]
pub struct Env {
    overrides: Mutex<HashMap<String, Option<String>>>,
}

impl Env {
    /// The variable as `os.environ.get(key)` gives it (it may be empty).
    pub fn raw(&self, key: &str) -> Option<String> {
        if let Some(value) = lock(&self.overrides).get(key) {
            return value.clone();
        }
        std::env::var(key).ok()
    }
    /// The variable if it is set and not empty (`os.environ.get(key)` used as a truth value).
    pub fn get(&self, key: &str) -> Option<String> {
        self.raw(key).filter(|v| !v.is_empty())
    }
    pub fn set(&self, key: &str, value: impl Into<String>) {
        lock(&self.overrides).insert(key.to_owned(), Some(value.into()));
    }
    pub fn unset(&self, key: &str) {
        lock(&self.overrides).insert(key.to_owned(), None);
    }
    /// The names given overrides (set or unset).
    pub fn overridden(&self) -> Vec<String> {
        lock(&self.overrides).keys().cloned().collect()
    }
    /// Gives a child process the overrides.
    pub fn apply(&self, command: &mut Command) {
        for (key, value) in lock(&self.overrides).iter() {
            match value {
                Some(v) => command.env(key, v),
                None => command.env_remove(key),
            };
        }
    }
}

/// Seconds on a monotonic clock (Python's `time.monotonic()`): what [`crate::CodexTask::began`]
/// and its timing are measured on, and what [`crate::describe_timing`] takes. It starts well above
/// zero, like Python's (seconds since boot): a time a second or so before the first reading is never
/// 0.0, which the timing reads as "not given".
pub fn monotonic() -> f64 {
    use std::sync::OnceLock;
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() + 1000.0
}

/// Seconds since 1970 (Python's `time.time()`).
pub(crate) fn unix_time() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 32 random hex digits (Python's `uuid.uuid4().hex`, as an opaque identifier).
pub(crate) fn random_hex() -> Result<String, AgentError> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The message of a caught panic.
pub(crate) fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "the tool crashed".into())
}
