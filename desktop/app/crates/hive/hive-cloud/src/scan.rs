//! What Hive Cloud uploads from this Mac, and what it deliberately leaves out.
//!
//! Every path is named `<root>/<path inside root>`:
//! - `state/`       Hive's application support folder (`AGENT_STATE_DIR`, else
//!                  ~/Library/Application Support/Hive, or Personal Agent before migration)
//! - `recordings/`  task recordings when they still live outside the state folder (~/Movies/Hive)
//! - `voiceprint/`  the voiceprint when it still lives in the source checkout (models/voiceprint.npz)
//!
//! Exclusions carry a reason and are counted in the status, so nothing is silently skipped.
use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Root {
    pub name: String,
    pub path: PathBuf,
    /// A root that is a single file rather than a folder.
    pub file: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    File,
    /// Copied with `VACUUM INTO` first, so a database in use is captured consistently.
    Sqlite,
    Symlink(String),
}

#[derive(Clone, Debug)]
pub struct Item {
    pub rel: String,
    pub abs: PathBuf,
    pub kind: Kind,
    pub size: u64,
    pub mtime_ns: i64,
    pub mode: u32,
    /// Lower goes first. 0: settings, memory, sessions, tasks. 2: captures. 3: browsing context.
    /// 4: recording transcripts and logs. 5: compressed recordings. 6: original recordings.
    pub priority: u8,
}

#[derive(Default, Debug)]
pub struct Scan {
    pub items: Vec<Item>,
    /// reason -> (files, bytes)
    pub excluded: BTreeMap<&'static str, (u64, u64)>,
    /// Roots that should exist but do not (their files are never treated as deleted).
    pub missing_roots: Vec<String>,
}

pub fn roots() -> Vec<Root> {
    let state = hive_common::state_dir();
    let mut roots = vec![Root { name: "state".into(), path: state.clone(), file: false }];
    let recordings = match std::env::var_os("HIVE_RECORDINGS").filter(|v| !v.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => {
            let legacy = hive_common::paths::home().join("Movies/Hive");
            legacy.exists().then_some(legacy)
        }
    };
    if let Some(dir) = recordings.filter(|d| !d.starts_with(&state)) {
        roots.push(Root { name: "recordings".into(), path: dir, file: false });
    }
    let legacy_print = hive_common::repo_root().join("models/voiceprint.npz");
    if !state.join("voiceprint.npz").exists() && legacy_print.is_file() {
        roots.push(Root { name: "voiceprint".into(), path: legacy_print, file: true });
    }
    roots
}

/// Why a path inside the state folder is left out, if it is.
pub fn state_exclusion(rel: &str) -> Option<&'static str> {
    let top = rel.split('/').next().unwrap_or("");
    match top {
        "cloud" => return Some("sync settings and keys (stay on this device)"),
        "authentication" => return Some("credentials (never uploaded)"),
        "app-backups" | "updates" => return Some("app builds (reinstalled, not restored)"),
        "lipread" => return Some("model weights (downloaded, not personal data)"),
        _ => {}
    }
    if ["dream/target", "dream/worktrees", "dream/tmp"].iter().any(|p| rel == *p || rel.starts_with(&format!("{p}/"))) {
        return Some("build output (rebuilt, not restored)");
    }
    if rel == "control/request-ledger.key" {
        return Some("credentials (never uploaded)");
    }
    None
}

fn temporary(name: &str) -> bool {
    name.ends_with(".lock")
        || name.ends_with(".sock")
        || name.ends_with("-wal")
        || name.ends_with("-shm")
        || name.ends_with("-journal")
        || name.ends_with(".tmp")
        || name.contains(".tmp-")
        || name == ".DS_Store"
}

fn priority(root: &str, rel: &str) -> u8 {
    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match root {
        "state" if rel.starts_with("context/") => 3,
        "state" if rel.starts_with("captures/") || rel.starts_with("task-photos/") => 2,
        "state" if rel.starts_with("recordings/") => match ext.as_str() {
            "mp4" => 5,
            "mov" => 6,
            _ => 4,
        },
        "recordings" => match ext.as_str() {
            "mp4" => 5,
            "mov" => 6,
            _ => 4,
        },
        _ => 0,
    }
}

fn sqlite_name(name: &str) -> bool {
    [".sqlite3", ".sqlite", ".db", ".store"].iter().any(|e| name.ends_with(e))
}

fn is_sqlite(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 16];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == b"SQLite format 3\0"
}

pub fn scan(roots: &[Root]) -> Scan {
    let mut out = Scan::default();
    for root in roots {
        let meta = match std::fs::symlink_metadata(&root.path) {
            Ok(m) => m,
            Err(_) => {
                out.missing_roots.push(root.name.clone());
                continue;
            }
        };
        if root.file {
            if meta.is_file() {
                out.items.push(item(root, "", &root.path, &meta));
            }
            continue;
        }
        walk(root, &root.path, "", &mut out);
    }
    out.items.sort_by(|a, b| (a.priority, a.size, &a.rel).cmp(&(b.priority, b.size, &b.rel)));
    out
}

fn exclude(out: &mut Scan, reason: &'static str, bytes: u64) {
    let e = out.excluded.entry(reason).or_insert((0, 0));
    e.0 += 1;
    e.1 += bytes;
}

fn dir_size(path: &Path) -> (u64, u64) {
    let mut files = 0;
    let mut bytes = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    let (f, b) = dir_size(&entry.path());
                    files += f;
                    bytes += b;
                } else {
                    files += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    (files, bytes)
}

fn walk(root: &Root, dir: &Path, prefix: &str, out: &mut Scan) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if root.name == "state" {
            if let Some(reason) = state_exclusion(&rel) {
                let (files, bytes) = if meta.is_dir() { dir_size(&path) } else { (1, meta.len()) };
                let e = out.excluded.entry(reason).or_insert((0, 0));
                e.0 += files;
                e.1 += bytes;
                continue;
            }
        }
        if meta.is_dir() {
            walk(root, &path, &rel, out);
        } else if meta.file_type().is_symlink() || meta.is_file() {
            if temporary(&name) {
                exclude(out, "temporary and lock files", meta.len());
                continue;
            }
            out.items.push(item(root, &rel, &path, &meta));
        } else {
            exclude(out, "sockets and other special files", 0);
        }
    }
}

fn item(root: &Root, rel: &str, path: &Path, meta: &std::fs::Metadata) -> Item {
    let kind = if meta.file_type().is_symlink() {
        Kind::Symlink(std::fs::read_link(path).map(|t| t.to_string_lossy().to_string()).unwrap_or_default())
    } else if sqlite_name(rel) && is_sqlite(path) {
        Kind::Sqlite
    } else {
        Kind::File
    };
    // A database in WAL mode takes writes in its -wal file; count those as changes too.
    let mut mtime_ns = meta.mtime() * 1_000_000_000 + meta.mtime_nsec();
    if kind == Kind::Sqlite {
        let mut wal = path.as_os_str().to_os_string();
        wal.push("-wal");
        if let Ok(w) = std::fs::metadata(PathBuf::from(wal)) {
            mtime_ns = mtime_ns.max(w.mtime() * 1_000_000_000 + w.mtime_nsec());
        }
    }
    let full = if rel.is_empty() {
        format!("{}/{}", root.name, path.file_name().and_then(|n| n.to_str()).unwrap_or("file"))
    } else {
        format!("{}/{}", root.name, rel)
    };
    Item {
        priority: priority(&root.name, rel),
        rel: full,
        abs: path.to_path_buf(),
        kind,
        size: meta.len(),
        mtime_ns,
        mode: meta.mode() & 0o777,
    }
}

/// Where a cloud path lives on this device.
pub fn local_path(roots: &[Root], rel: &str) -> Option<PathBuf> {
    let (root_name, rest) = rel.split_once('/')?;
    if rest.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return None;
    }
    let root = roots.iter().find(|r| r.name == root_name)?;
    Some(if root.file { root.path.clone() } else { root.path.join(rest) })
}

/// The cloud path of a file on this device: its root's name and its path inside that root.
pub fn cloud_name(roots: &[Root], path: &Path) -> Option<String> {
    roots.iter().filter(|r| !r.file).find_map(|r| {
        let rest = path.strip_prefix(&r.path).ok()?.to_str()?;
        (!rest.is_empty()).then(|| format!("{}/{rest}", r.name))
    })
}

/// Where a cloud path goes inside a restore folder.
pub fn restore_path(dir: &Path, rel: &str) -> Option<PathBuf> {
    if rel.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return None;
    }
    Some(dir.join(rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_named_by_the_root_it_is_in() {
        let roots = vec![
            Root { name: "state".into(), path: "/s".into(), file: false },
            Root { name: "voiceprint".into(), path: "/r/v.npz".into(), file: true },
        ];
        assert_eq!(cloud_name(&roots, Path::new("/s/recordings/a.mp4")).as_deref(), Some("state/recordings/a.mp4"));
        assert_eq!(cloud_name(&roots, Path::new("/s2/x")), None);
        assert_eq!(cloud_name(&roots, Path::new("/s")), None);
        assert_eq!(cloud_name(&roots, Path::new("/r/v.npz")), None);
    }

    #[test]
    fn credentials_models_and_builds_are_left_out_with_reasons() {
        assert_eq!(state_exclusion("authentication/x"), Some("credentials (never uploaded)"));
        assert_eq!(state_exclusion("control/request-ledger.key"), Some("credentials (never uploaded)"));
        assert_eq!(state_exclusion("cloud/config.json"), Some("sync settings and keys (stay on this device)"));
        assert!(state_exclusion("lipread/flare").is_some());
        assert!(state_exclusion("dream/target/debug").is_some());
        assert_eq!(state_exclusion("dream/register.json"), None);
        assert_eq!(state_exclusion("sessions/1/journal.jsonl"), None);
        assert_eq!(state_exclusion("memory/personal-memory.sqlite3"), None);
    }

    #[test]
    fn scan_finds_files_symlinks_and_sqlite_and_skips_locks() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        std::fs::create_dir_all(state.join("sessions/1")).unwrap();
        std::fs::create_dir_all(state.join("authentication")).unwrap();
        std::fs::create_dir_all(state.join("memory")).unwrap();
        std::fs::write(state.join("sessions/1/journal.jsonl"), b"{}\n").unwrap();
        std::fs::write(state.join("authentication/token"), b"secret").unwrap();
        std::fs::write(state.join("x.lock"), b"").unwrap();
        std::os::unix::fs::symlink("1", state.join("sessions/latest")).unwrap();
        let db = rusqlite::Connection::open(state.join("memory/m.sqlite3")).unwrap();
        db.execute_batch("create table t(x); insert into t values (1);").unwrap();
        drop(db);
        let roots = vec![Root { name: "state".into(), path: state.clone(), file: false }];
        let scan = scan(&roots);
        let rels: Vec<_> = scan.items.iter().map(|i| i.rel.as_str()).collect();
        assert!(rels.contains(&"state/sessions/1/journal.jsonl"));
        assert!(rels.contains(&"state/sessions/latest"));
        assert!(!rels.iter().any(|r| r.contains("authentication") || r.ends_with(".lock")));
        let db_item = scan.items.iter().find(|i| i.rel == "state/memory/m.sqlite3").unwrap();
        assert_eq!(db_item.kind, Kind::Sqlite);
        let link = scan.items.iter().find(|i| i.rel == "state/sessions/latest").unwrap();
        assert_eq!(link.kind, Kind::Symlink("1".into()));
        assert_eq!(scan.excluded["credentials (never uploaded)"].0, 1);
        assert_eq!(local_path(&roots, "state/a/b").unwrap(), state.join("a/b"));
        assert!(local_path(&roots, "state/../etc/passwd").is_none());
    }
}
