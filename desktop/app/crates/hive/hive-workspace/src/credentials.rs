//! The local authentication helper for the workspace's Passwords window
//! (python/credentials.py `executable` and `native`). Everything else in credentials.py is the Mac
//! porter's; the bridge only needs `fill-workspace-passwords`, behind a trait the app can replace.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Unlocks the workspace's Passwords app with the saved Mac credential, without exposing it.
pub trait PasswordsFiller: Send + Sync {
    fn fill_workspace_passwords(&self, pid: i64, window_id: i64) -> Result<String, String>;
}

/// Runs the signed Hive app's own `--credential` command, as python did.
pub struct NativeCredentials;

impl PasswordsFiller for NativeCredentials {
    fn fill_workspace_passwords(&self, pid: i64, window_id: i64) -> Result<String, String> {
        native(&[
            "fill-workspace-passwords",
            &pid.to_string(),
            &window_id.to_string(),
        ])
    }
}

/// Prefers the installed, signed Hive bundle. A present but damaged bundle must not silently
/// redirect credential operations to an older or unsigned copy.
pub fn executable() -> Result<PathBuf, String> {
    let bundles = [
        hive_common::paths::home().join("Applications/Hive.app"),
        hive_common::paths::home().join("Applications/Agent.app"),
        hive_common::paths::repo_root().join("build/Agent.app"),
    ];
    for bundle in bundles {
        let link = std::fs::symlink_metadata(&bundle);
        if link.is_err() {
            continue;
        }
        let path = bundle.join("Contents/MacOS/Agent");
        let executable = std::fs::metadata(&path)
            .map(|m| {
                use std::os::unix::fs::PermissionsExt;
                m.is_file() && m.permissions().mode() & 0o111 != 0
            })
            .unwrap_or(false);
        let path_is_link = std::fs::symlink_metadata(&path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if link.map(|m| m.file_type().is_symlink()).unwrap_or(true)
            || !bundle.is_dir()
            || path_is_link
            || !executable
        {
            return Err("The selected local authentication helper is unavailable.".into());
        }
        return Ok(path);
    }
    Err("Build Hive first with make build/Agent.app.".into())
}

pub fn native(args: &[&str]) -> Result<String, String> {
    let unfinished =
        || "The local authentication helper did not finish. No automatic retry.".to_string();
    let mut child = Command::new(executable()?)
        .arg("--credential")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| unfinished())?;
    let (mut out, mut err) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = out.read_to_end(&mut bytes);
        bytes
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = err.read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(12);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(unfinished());
            }
        }
    };
    let (out, err) = (
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
    );
    if !status.success() {
        let message = String::from_utf8_lossy(&err).trim().to_string();
        return Err(if message.is_empty() {
            "Authentication unavailable.".into()
        } else {
            message
        });
    }
    String::from_utf8(out)
        .map(|s| s.trim().to_string())
        .map_err(|e| e.to_string())
}
