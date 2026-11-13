//! Where things are: the repository (desktop/app), its build folder, the Python sidecars and the
//! agent's private state.

use std::path::{Path, PathBuf};

/// desktop/app: `HIVE_REPO` if set, else found from the running executable (it lives in
/// `<repo>/build/` or `<repo>/crates/hive/target/<profile>/`), else the current directory.
pub fn repo_root() -> PathBuf {
    if let Some(repo) = std::env::var_os("HIVE_REPO").filter(|v| !v.is_empty()) {
        return PathBuf::from(repo);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(found) = exe.ancestors().skip(1).find(|dir| is_repo(dir)) {
            return found.to_path_buf();
        }
    }
    let here = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    here.ancestors().find(|dir| is_repo(dir)).map(Path::to_path_buf).unwrap_or(here)
}

fn is_repo(dir: &Path) -> bool {
    dir.join("Makefile").is_file() && dir.join("crates/hive/Cargo.toml").is_file()
}

/// `<repo>/build`, where make puts the helpers (agent-vhid-ocr, agent-vhid-captions, ...).
pub fn build_dir() -> PathBuf {
    repo_root().join("build")
}

/// `<repo>/python`, where the model sidecars live.
pub fn python_dir() -> PathBuf {
    repo_root().join("python")
}

/// The Python that runs the model sidecars: `<repo>/.venv/bin/python`.
pub fn sidecar_python() -> PathBuf {
    repo_root().join(".venv/bin/python")
}

/// The agent's private state: `AGENT_STATE_DIR`, else ~/Library/Application Support/Personal Agent.
pub fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AGENT_STATE_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    home().join("Library/Application Support/Personal Agent")
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Python's `tempfile.gettempdir()`: `TMPDIR` (per-user on macOS), else /tmp.
pub fn temp_dir() -> PathBuf {
    std::env::var_os("TMPDIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}
