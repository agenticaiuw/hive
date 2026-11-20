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
    here.ancestors()
        .find(|dir| is_repo(dir))
        .map(Path::to_path_buf)
        .unwrap_or(here)
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

/// The agent's private state: `AGENT_STATE_DIR`, else ~/Library/Application Support/Hive.
pub fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AGENT_STATE_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    state_dir_in(&home())
}

/// `<home>/Library/Application Support/Hive`, or the folder's old name, `Personal Agent`, on a Mac
/// that has only that (Hive was called Personal Agent until 2026-11). Once `Hive` exists, an old
/// `Personal Agent` beside it is ignored: on the owner's Mac it's a link to `Hive`, kept for the
/// input helper installed as root, which still reads `speak-aloud` through the old name.
pub fn state_dir_in(home: &Path) -> PathBuf {
    let support = home.join("Library/Application Support");
    let hive = support.join("Hive");
    let legacy = support.join("Personal Agent");
    if !hive.exists() && legacy.is_dir() {
        legacy
    } else {
        hive
    }
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Python's `tempfile.gettempdir()`: `TMPDIR` (per-user on macOS), else /tmp.
pub fn temp_dir() -> PathBuf {
    std::env::var_os("TMPDIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

/// Cut over the old data folders with same-volume renames after all legacy writers stop.
/// This primitive does not stop or lock writers and must never run against a live installation.
/// Collisions are rejected. A cross-volume error leaves that source in place and can be retried.
pub fn migrate_legacy_at(home: &Path) -> Result<(), String> {
    let support = home.join("Library/Application Support");
    let old = support.join("Personal Agent");
    let new = support.join("Hive");
    let old_recordings = home.join("Movies/Hive");
    let recordings = new.join("recordings");
    if old.exists() && new.exists() {
        return Err(format!(
            "Both {} and {} exist; migration cannot choose a copy",
            old.display(),
            new.display()
        ));
    }
    if old_recordings.exists()
        && (recordings.exists() || (old.exists() && old.join("recordings").exists()))
    {
        return Err(format!(
            "Both {} and {} exist; migration cannot choose a copy",
            old_recordings.display(),
            recordings.display()
        ));
    }
    if old.exists() {
        std::fs::rename(&old, &new).map_err(|e| {
            format!(
                "Could not migrate {} to {}: {e}",
                old.display(),
                new.display()
            )
        })?;
    }
    if old_recordings.exists() {
        std::fs::create_dir_all(&new)
            .map_err(|e| format!("Could not create {}: {e}", new.display()))?;
        std::fs::rename(&old_recordings, &recordings).map_err(|e| {
            format!(
                "Could not migrate {} to {}: {e}",
                old_recordings.display(),
                recordings.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    #[test]
    fn moves_state_and_recordings_without_losing_contents() {
        let temp = tempfile::tempdir().unwrap();
        let h = temp.path();
        let old = h.join("Library/Application Support/Personal Agent");
        let movies = h.join("Movies/Hive");
        std::fs::create_dir_all(old.join("sessions")).unwrap();
        std::fs::create_dir_all(&movies).unwrap();
        std::fs::write(old.join("sessions/data"), b"session").unwrap();
        std::fs::write(movies.join("screen.mov"), b"video").unwrap();
        migrate_legacy_at(h).unwrap();
        let new = h.join("Library/Application Support/Hive");
        assert_eq!(
            std::fs::read(new.join("sessions/data")).unwrap(),
            b"session"
        );
        assert_eq!(
            std::fs::read(new.join("recordings/screen.mov")).unwrap(),
            b"video"
        );
        assert!(!old.exists() && !movies.exists());
        migrate_legacy_at(h).unwrap();
    }
    #[test]
    fn preserves_both_sides_on_collision() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp
            .path()
            .join("Library/Application Support/Personal Agent");
        let new = temp.path().join("Library/Application Support/Hive");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("data"), b"old").unwrap();
        std::fs::write(new.join("data"), b"new").unwrap();
        assert!(migrate_legacy_at(temp.path()).is_err());
        assert_eq!(std::fs::read(old.join("data")).unwrap(), b"old");
        assert_eq!(std::fs::read(new.join("data")).unwrap(), b"new");
    }
}

/// Copy the former runtime voiceprint into the state folder during a coordinated, quiescent
/// cutover. The old file remains for rollback. Refuse symlinks and conflicting enrolled voices;
/// a private temporary file and an exclusive hard link prevent exposing a partial destination.
pub fn migrate_voiceprint_at(legacy: &Path, state: &Path) -> Result<(), String> {
    use std::io::{Read, Write};
    use std::os::unix::fs::OpenOptionsExt;
    let mut source = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(legacy)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("Cannot read old voiceprint: {e}")),
    };
    let meta = source.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > 1_048_576 {
        return Err("Old voiceprint is not a regular, reasonably sized file".into());
    }
    let mut bytes = Vec::new();
    source.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(state).map_err(|e| e.to_string())?;
    let dest = state.join("voiceprint.npz");
    if dest.exists() {
        let existing = std::fs::symlink_metadata(&dest).map_err(|e| e.to_string())?;
        if existing.is_file()
            && !existing.file_type().is_symlink()
            && std::fs::read(&dest).map_err(|e| e.to_string())? == bytes
        {
            return Ok(());
        }
        return Err("Voiceprint already exists and differs; neither copy was changed".into());
    }
    let stage = state.join(format!(".voiceprint-migration-{}", std::process::id()));
    let mut created = false;
    let result = (|| -> Result<(), String> {
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&stage)
            .map_err(|e| format!("Cannot stage voiceprint: {e}"))?;
        created = true;
        out.write_all(&bytes)
            .and_then(|_| out.sync_all())
            .map_err(|e| e.to_string())?;
        if std::fs::read(legacy).map_err(|e| e.to_string())? != bytes {
            return Err("Old voiceprint changed during migration".into());
        }
        std::fs::hard_link(&stage, &dest)
            .map_err(|e| format!("Cannot install voiceprint without overwrite: {e}"))?;
        Ok(())
    })();
    // Remove only our unique temporary file; the old enrolled voice remains intact.
    if created {
        let _ = std::fs::remove_file(&stage);
    }
    result
}

#[cfg(test)]
mod voiceprint_migration_tests {
    use super::*;
    #[test]
    fn copies_voiceprint_without_removing_original_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("old.npz");
        let state = dir.path().join("state");
        std::fs::write(&legacy, b"voice").unwrap();
        migrate_voiceprint_at(&legacy, &state).unwrap();
        assert_eq!(std::fs::read(&legacy).unwrap(), b"voice");
        assert_eq!(
            std::fs::read(state.join("voiceprint.npz")).unwrap(),
            b"voice"
        );
        migrate_voiceprint_at(&legacy, &state).unwrap();
    }
    #[test]
    fn conflicting_voiceprint_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("old.npz");
        let state = dir.path().join("state");
        std::fs::create_dir(&state).unwrap();
        std::fs::write(&legacy, b"old").unwrap();
        std::fs::write(state.join("voiceprint.npz"), b"new").unwrap();
        assert!(migrate_voiceprint_at(&legacy, &state).is_err());
        assert_eq!(std::fs::read(&legacy).unwrap(), b"old");
        assert_eq!(std::fs::read(state.join("voiceprint.npz")).unwrap(), b"new");
    }
}
