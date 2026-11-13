//! Where hive-dream reads and writes. It reads Hive's state folder, Agent.log and the task
//! recordings, and writes only under `<state>/dream/` (and git worktrees and branches there).

use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Hive's private state: `AGENT_STATE_DIR`, else ~/Library/Application Support/Personal Agent
/// (hive-common's `state_dir`).
pub fn state_dir() -> PathBuf {
    env_path("AGENT_STATE_DIR")
        .unwrap_or_else(|| home().join("Library/Application Support/Personal Agent"))
}

/// Everything hive-dream writes: `HIVE_DREAM_DIR`, else `<state>/dream`.
pub fn dream_dir() -> PathBuf {
    env_path("HIVE_DREAM_DIR").unwrap_or_else(|| state_dir().join("dream"))
}

/// The task recordings: `HIVE_RECORDINGS_DIR`, else ~/Movies/Hive.
pub fn recordings_dir() -> PathBuf {
    env_path("HIVE_RECORDINGS_DIR").unwrap_or_else(|| home().join("Movies/Hive"))
}

/// `HIVE_AGENT_LOG`, else ~/Library/Logs/Agent.log.
pub fn agent_log() -> PathBuf {
    env_path("HIVE_AGENT_LOG").unwrap_or_else(|| home().join("Library/Logs/Agent.log"))
}

/// The Hive repository (its top, with .git): `HIVE_DREAM_REPO`, else ~/hive.
pub fn repo() -> PathBuf {
    env_path("HIVE_DREAM_REPO").unwrap_or_else(|| home().join("hive"))
}

/// The Mac's Codex CLI (the user's ChatGPT account): `HIVE_DREAM_CODEX`, else ChatGPT.app's.
pub fn codex() -> PathBuf {
    env_path("HIVE_DREAM_CODEX").unwrap_or_else(|| {
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex")
    })
}

pub fn register(dream: &Path) -> PathBuf {
    dream.join("register.json")
}

pub fn night(dream: &Path, date: &str) -> PathBuf {
    dream.join(date)
}

/// `<dream>/private-terms`: one personal term per line (never in the repo).
pub fn private_terms(dream: &Path) -> PathBuf {
    dream.join("private-terms")
}

/// The terms, or `None` when the file is missing (the check is then skipped with a warning).
pub fn load_private_terms(dream: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(private_terms(dream)).ok()?;
    Some(
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_string)
            .collect(),
    )
}

/// Writes through a temporary file and a rename, so a reader never sees half a file.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Modification time in epoch seconds.
pub fn mtime(path: &Path) -> Option<f64> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    m.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64())
}

/// Free space on the volume holding `path`, in bytes.
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: statvfs writes into the struct we own; the path is NUL-terminated.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    Some(u64::from(s.f_bavail) * s.f_frsize)
}
