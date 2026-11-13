//! The direct channel to Hive for other agents, such as Claude Code: what a request led to, live.
//!
//! A request to `control/request.sock` (or one typed or said, which the request ledger admits
//! too) has a receipt. Everything Hive then shows for it is appended to
//! `control/live/<receipt>.jsonl`, one JSON line per event:
//!
//! ```text
//! {"t": "2026-11-13T05:01:02.345", "kind": "say", "text": "Opening Course Search & Enroll."}
//! ```
//!
//! | kind | when |
//! |---|---|
//! | `started` | the task began; `text` is the request as the agent got it |
//! | `say` | its reply, a sentence or so at a time |
//! | `action` | a step, as "tool: why" |
//! | `announce` | a step that can't be undone (a send, a delete), as it happens |
//! | `error` | a step that went wrong; the task goes on |
//! | `paused` | the user took the mouse and keyboard; screen steps wait for them |
//! | `resumed` | fn or "continue" handed them back |
//! | `done` | it finished; `text` is its reply |
//! | `needs_you` | it stopped on purpose and said why (often a step it won't take alone) |
//! | `failed` | it failed; `text` says why |
//! | `stopped` | the floating window's x, or a newer request replaced it |
//!
//! The last four end the file. `hive-ask` (src/bin/hive-ask.rs) sends a request and follows its
//! file until then. The files are private: 0600, in a 0700 folder; the newest [`KEEP`] are kept.

use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// How many request files are kept.
pub const KEEP: usize = 200;
/// The kinds that end a request.
pub const ENDS: [&str; 4] = ["done", "needs_you", "failed", "stopped"];

/// `<state>/control/live`.
pub fn folder() -> PathBuf {
    hive_common::state_dir().join("control").join("live")
}

/// A receipt that can be a file name: letters, digits, `-` and `_`, at most 64.
pub fn valid_receipt(receipt: &str) -> bool {
    !receipt.is_empty()
        && receipt.len() <= 64
        && receipt
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Whether this event ends its request.
pub fn ends(event: &Value) -> bool {
    event
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| ENDS.contains(&kind))
}

/// Writes request files into one folder.
pub struct Live {
    dir: PathBuf,
}

impl Default for Live {
    fn default() -> Live {
        Live::at(folder())
    }
}

impl Live {
    pub fn at(dir: impl Into<PathBuf>) -> Live {
        Live { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn path(&self, receipt: &str) -> PathBuf {
        self.dir.join(format!("{receipt}.jsonl"))
    }

    /// Appends one event to the receipt's file (made, private, if it's new).
    pub fn event(&self, receipt: &str, kind: &str, text: &str) -> std::io::Result<()> {
        if !valid_receipt(receipt) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "not a receipt",
            ));
        }
        fs::create_dir_all(&self.dir)?;
        fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700))?;
        let path = self.path(receipt);
        let new = fs::symlink_metadata(&path).is_err();
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        let t = hive_knowledge::util::Local::now().iso_millis();
        let mut line = json!({"t": t, "kind": kind, "text": text}).to_string();
        line.push('\n');
        file.write_all(line.as_bytes())?;
        if new {
            self.prune();
        }
        Ok(())
    }

    /// Keeps the newest [`KEEP`] files.
    fn prune(&self) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        if files.len() <= KEEP {
            return;
        }
        files.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in files.into_iter().skip(KEEP) {
            let _ = fs::remove_file(path);
        }
    }

    /// The receipt whose file changed last: the request Hive is on, or was on last.
    pub fn latest(&self) -> Option<String> {
        fs::read_dir(&self.dir)
            .ok()?
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .max_by(|a, b| a.0.cmp(&b.0))
            .and_then(|(_, path)| Some(path.file_stem()?.to_str()?.to_owned()))
    }
}

/// The whole events after `offset` bytes of `path`, and the offset after the last of them. A line
/// still being written is left for next time; a line that isn't JSON is skipped.
pub fn read_from(path: &Path, offset: u64) -> (Vec<Value>, u64) {
    let Ok(mut file) = fs::File::open(path) else {
        return (Vec::new(), offset);
    };
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return (Vec::new(), offset);
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return (Vec::new(), offset);
    }
    let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else {
        return (Vec::new(), offset);
    };
    let events = bytes[..end]
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect();
    (events, offset + end as u64 + 1)
}

/// An event as a line for people: the same marks as Agent.log.
pub fn display(event: &Value) -> String {
    let text = event.get("text").and_then(Value::as_str).unwrap_or("");
    match event.get("kind").and_then(Value::as_str).unwrap_or("") {
        "started" => format!("▶️  Started: {text}"),
        "say" => format!("💬 {text}"),
        "action" => format!("→ {text}"),
        "announce" => format!("⚠️  {text}"),
        "error" => format!("✗ {text}"),
        "paused" => format!("⏸  {text}"),
        "resumed" => format!("▶️  {text}"),
        "done" => format!("✅ Done.\n{text}"),
        "needs_you" => format!("✋ {text}"),
        "failed" => format!("❌ {text}"),
        "stopped" => format!("⏹  Stopped: {text}"),
        other => format!("{other}: {text}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_go_to_a_private_file_per_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let live = Live::at(dir.path().join("live"));
        live.event("abc123", "say", "Hello.").unwrap();
        live.event("abc123", "done", "All set.").unwrap();
        let (events, offset) = read_from(&live.path("abc123"), 0);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["kind"], "say");
        assert_eq!(events[1]["text"], "All set.");
        assert!(ends(&events[1]) && !ends(&events[0]));
        assert_eq!(offset, fs::metadata(live.path("abc123")).unwrap().len());
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&live.path("abc123")), 0o600);
        assert_eq!(mode(live.dir()), 0o700);
        assert!(live.event("../x", "say", "no").is_err());
        assert!(live.event("", "say", "no").is_err());
    }

    #[test]
    fn a_half_written_line_waits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("r.jsonl");
        fs::write(&path, "{\"kind\":\"say\",\"text\":\"a\"}\n{\"kind\":\"do").unwrap();
        let (events, offset) = read_from(&path, 0);
        assert_eq!(events.len(), 1);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"ne\",\"text\":\"b\"}\n").unwrap();
        let (more, _) = read_from(&path, offset);
        assert_eq!(more.len(), 1);
        assert_eq!(more[0]["kind"], "done");
    }

    #[test]
    fn only_the_newest_files_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let live = Live::at(dir.path());
        for n in 0..KEEP + 3 {
            live.event(&format!("r{n}"), "started", "x").unwrap();
        }
        let count = fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(count, KEEP);
        assert!(live.latest().is_some());
    }
}
