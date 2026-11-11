//! Durable workspace creation policy (python/workspace_fence.py); no display or daemon operations
//! here. The policy lives in `workspace-creation-policy.json` in the state folder, guarded by an
//! exclusive lock on `workspace-creation-policy.json.lock`.

use crate::pydump::dumps;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

pub const FILE: &str = "workspace-creation-policy.json";

struct Locked {
    _lock: File,
    path: PathBuf,
}

fn locked(directory: &Path) -> std::io::Result<Locked> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(directory.join(format!("{FILE}.lock")))?;
    loop {
        // SAFETY: the descriptor is open for the whole call.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } == 0 {
            break;
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    Ok(Locked {
        _lock: lock,
        path: directory.join(FILE),
    })
}

fn read(path: &Path) -> &'static str {
    let text = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return "unconfigured",
        Err(_) => return "closed",
    };
    let Ok(Value::Object(data)) = serde_json::from_slice::<Value>(&text) else {
        return "closed";
    };
    if data.get("version").and_then(Value::as_i64) != Some(1) {
        return "closed";
    }
    match data.get("mode").and_then(Value::as_str) {
        Some("closed") => "closed",
        Some("allow-once") => "allow-once",
        Some("existing-only") => "existing-only",
        _ => "closed",
    }
}

fn write(path: &Path, mode: &str) -> Result<(), String> {
    let text = dumps(&json!({"version": 1, "mode": mode}), true) + "\n";
    hive_common::atomic_write(path, text.as_bytes()).map_err(|e| e.to_string())
}

/// Records `closed` or `allow-once`.
pub fn set_policy(directory: &Path, mode: &str) -> Result<(), String> {
    if mode != "closed" && mode != "allow-once" {
        return Err("Invalid workspace policy".into());
    }
    let held = locked(directory).map_err(|e| e.to_string())?;
    write(&held.path, mode)
}

/// `unconfigured`, `closed`, `allow-once` or `existing-only`; anything unreadable is `closed`.
pub fn policy(directory: &Path) -> &'static str {
    match locked(directory) {
        Ok(held) => read(&held.path),
        Err(_) => "closed",
    }
}

/// A successful claim consumes a pending create permit without creating.
pub fn settle_existing(directory: &Path) -> Result<(), String> {
    let held = locked(directory).map_err(|e| e.to_string())?;
    match read(&held.path) {
        "closed" => Err(
            "Workspace was explicitly closed; an explicit user request is required to reopen it"
                .into(),
        ),
        "allow-once" => write(&held.path, "existing-only"),
        _ => Ok(()),
    }
}

/// Consumes the explicit authorization before the side effect; never retries ambiguity.
pub fn create_once<T>(directory: &Path, create: impl FnOnce() -> T) -> Result<T, String> {
    let held = locked(directory).map_err(|e| e.to_string())?;
    if read(&held.path) != "allow-once" {
        return Err("Workspace creation requires an explicit user request".into());
    }
    write(&held.path, "existing-only")?;
    Ok(create())
}

/// `workspace-fence closed|allow-once|status` (python/workspace_fence.py as a script).
pub fn main(args: &[String]) -> i32 {
    let usage = || {
        eprintln!("usage: workspace-fence [-h] {{closed,allow-once,status}}");
    };
    let [action] = args else {
        usage();
        return 2;
    };
    let directory = hive_common::state_dir();
    match action.as_str() {
        "status" => println!("{}", policy(&directory)),
        "closed" | "allow-once" => {
            if let Err(e) = set_policy(&directory, action) {
                eprintln!("{e}");
                return 1;
            }
            println!("Workspace creation policy recorded; no display was changed.");
        }
        _ => {
            usage();
            return 2;
        }
    }
    0
}
