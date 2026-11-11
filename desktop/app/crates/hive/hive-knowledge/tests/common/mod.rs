//! What the tests share: environment variables are process-global, so a test that sets them holds
//! one lock for its whole run and puts them back when it ends.
#![allow(dead_code)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

static ENV: Mutex<()> = Mutex::new(());

/// A temporary folder and environment variables set for one test, restored when it ends.
pub struct Env {
    pub dir: tempfile::TempDir,
    saved: Vec<(String, Option<OsString>)>,
    _held: MutexGuard<'static, ()>,
}

impl Env {
    /// Takes the lock and makes a temporary folder; `vars` are set to paths inside it ("" for the
    /// folder itself).
    pub fn new(vars: &[(&str, &str)]) -> Env {
        let held = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().expect("temporary folder");
        let mut env = Env {
            dir,
            saved: Vec::new(),
            _held: held,
        };
        for (name, sub) in vars {
            let value = if sub.is_empty() {
                env.path().to_path_buf()
            } else {
                env.path().join(sub)
            };
            env.set(name, value.as_os_str());
        }
        env
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    pub fn set(&mut self, name: &str, value: impl AsRef<std::ffi::OsStr>) {
        self.saved.push((name.to_string(), std::env::var_os(name)));
        std::env::set_var(name, value);
    }

    pub fn remove(&mut self, name: &str) {
        self.saved.push((name.to_string(), std::env::var_os(name)));
        std::env::remove_var(name);
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        for (name, value) in self.saved.drain(..).rev() {
            match value {
                Some(v) => std::env::set_var(&name, v),
                None => std::env::remove_var(&name),
            }
        }
    }
}

/// The file's permission bits.
pub fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777
}

/// Waits up to `seconds` for `done`.
pub fn wait_for(seconds: f64, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs_f64(seconds);
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    done()
}

/// This repository's root (the folder holding desktop/ and cloud/).
pub fn hive_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(5)
        .expect("repo root")
        .to_path_buf()
}
