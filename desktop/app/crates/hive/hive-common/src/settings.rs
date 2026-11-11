//! Settings from the .env file at the top of the repo (python/settings.py): KEY=value lines and
//! # comments. A value set in .env wins over the same variable in the environment; empty values
//! are skipped. `AGENT_ENV_FILE` points somewhere else (the tests use it).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static FROM_FILE: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

pub fn env_file() -> PathBuf {
    std::env::var_os("AGENT_ENV_FILE")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::repo_root().join(".env"))
}

/// Loads the .env file (or `path`) into this process's environment. A missing file is fine.
pub fn load(path: Option<&Path>) -> Result<(), String> {
    let path = path.map(Path::to_path_buf).unwrap_or_else(env_file);
    if !path.exists() {
        return Ok(());
    }
    let pairs = personal_agent_core::settings::read(&path)?;
    let mut from_file = FROM_FILE.lock().unwrap_or_else(|e| e.into_inner());
    for (key, value) in pairs {
        if value.is_empty() {
            continue;
        }
        std::env::set_var(&key, &value);
        from_file.insert(key);
    }
    Ok(())
}

/// Whether `key` came from the .env file (rather than the environment the app was started with).
pub fn from_file(key: &str) -> bool {
    FROM_FILE.lock().map(|set| set.contains(key)).unwrap_or(false)
}

/// The variable's value if it is set and not empty.
pub fn get(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// "1", "true", "yes" or "on" (any case).
pub fn flag(key: &str) -> bool {
    matches!(get(key).map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("1" | "true" | "yes" | "on"))
}
