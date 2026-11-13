//! Copies what Hive's nightly dream reads to Cloudflare R2, so the dream runs in the cloud
//! (hive-dream on Hive's VM, which mirrors these back with `hive-dream sync`): the session
//! journals, Agent.log and the small settings files the dream checks, and `logs/index.json`
//! listing them along with every uploaded recording's timeline.
//!
//! Objects, in the recordings bucket ([`crate::cloud_archive::bucket`]):
//! `logs/sessions/<id>/journal.jsonl`, `logs/Agent.log`, `logs/settings/<name>`, `logs/index.json`.
//! Only files that changed since their last upload go up (`<state>/cloud-logs.json` remembers
//! each one's size and mtime), and at most once every [`MIN_GAP_SECS`]. It runs after each
//! recording's upload and when Hive starts, like the recordings.

use crate::cloud_archive::{self, Cf};
use crate::util;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MIN_GAP_SECS: f64 = 30.0 * 60.0;

/// The settings files hive-dream's collect checks (its `SETTINGS`).
pub const SETTINGS: &[&str] = &[
    "work-screen",
    "floating-window",
    "speak-aloud",
    "input-mode",
    "browser-preference",
];

static LOCK: Mutex<()> = Mutex::new(());

/// One file to keep in the cloud.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub key: String,
    pub kind: &'static str,
    pub name: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub mtime: f64,
}

fn stat(path: &Path) -> Option<(u64, f64)> {
    let m = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    let t = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs_f64();
    Some((m.len(), t))
}

/// `HIVE_AGENT_LOG`, else ~/Library/Logs/Agent.log (as hive-dream reads it).
pub fn agent_log() -> PathBuf {
    std::env::var_os("HIVE_AGENT_LOG")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| hive_common::paths::home().join("Library/Logs/Agent.log"))
}

/// Everything there is to keep: each session's journal, Agent.log, the settings files.
pub fn items(state: &Path, agent_log: &Path) -> Vec<Item> {
    let mut out = Vec::new();
    let mut add = |key: String, kind: &'static str, name: String, path: PathBuf| {
        if let Some((bytes, mtime)) = stat(&path) {
            out.push(Item { key, kind, name, path, bytes, mtime });
        }
    };
    for dir in util::listing(&state.join("sessions")) {
        let id = util::file_name(&dir);
        if !safe_name(&id) {
            continue;
        }
        add(
            format!("logs/sessions/{id}/journal.jsonl"),
            "journal",
            id,
            dir.join("journal.jsonl"),
        );
    }
    add("logs/Agent.log".into(), "agent_log", "Agent.log".into(), agent_log.to_path_buf());
    for name in SETTINGS {
        add(format!("logs/settings/{name}"), "setting", (*name).into(), state.join(name));
    }
    out
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        && !name.starts_with('.')
}

/// The uploaded recordings with a timeline: (folder name, its R2 prefix, the timeline's mtime).
pub fn recordings(root: &Path) -> Vec<Value> {
    util::listing(root)
        .into_iter()
        .filter(|f| f.join(".uploaded").exists())
        .filter_map(|f| {
            let (_, mtime) = stat(&f.join("timeline.jsonl"))?;
            Some(json!({
                "folder": util::file_name(&f),
                "prefix": cloud_archive::key_prefix(&f),
                "timeline_mtime": mtime,
            }))
        })
        .collect()
}

/// Uploads what changed (through `put`, which returns whether it worked and what it said), then
/// the index. Returns a one-line result, or None when it ran too recently to try again.
pub fn upload_with(
    put: &dyn Fn(&str, &Path) -> (bool, String),
    state: &Path,
    agent_log: &Path,
    recordings_root: &Path,
    now: f64,
) -> Option<String> {
    let memory_path = state.join("cloud-logs.json");
    let memory: Value = std::fs::read_to_string(&memory_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    if memory["last"].as_f64().is_some_and(|last| now - last < MIN_GAP_SECS) {
        return None;
    }
    let mut known: Map<String, Value> = memory["files"].as_object().cloned().unwrap_or_default();
    let all = items(state, agent_log);
    let (mut sent, mut failed) = (0usize, Vec::new());
    for item in &all {
        let same = known
            .get(&item.key)
            .is_some_and(|v| v[0].as_u64() == Some(item.bytes) && v[1].as_f64() == Some(item.mtime));
        if same {
            continue;
        }
        let (ok, said) = put(&item.key, &item.path);
        if ok {
            known.insert(item.key.clone(), json!([item.bytes, item.mtime]));
            sent += 1;
        } else {
            failed.push(format!("{}: {said}", item.key));
        }
    }
    // The index lists what's in the cloud: only files that went up (now or before).
    let files: Vec<Value> = all
        .iter()
        .filter_map(|i| {
            let v = known.get(&i.key)?;
            Some(json!({"key": i.key, "kind": i.kind, "name": i.name, "bytes": v[0], "mtime": v[1]}))
        })
        .collect();
    let index = json!({
        "updated": util::Local::now().iso_seconds(),
        "files": files,
        "recordings": recordings(recordings_root),
    });
    let index_path = state.join("cloud-logs-index.json");
    let index_ok = std::fs::write(&index_path, serde_json::to_string_pretty(&index).unwrap_or_default())
        .is_ok()
        && {
            let (ok, said) = put("logs/index.json", &index_path);
            if !ok {
                failed.push(format!("logs/index.json: {said}"));
            }
            ok
        };
    let remembered = json!({"last": now, "files": known});
    let _ = std::fs::write(&memory_path, serde_json::to_string(&remembered).unwrap_or_default());
    Some(if failed.is_empty() && index_ok {
        format!("logs: {sent} changed files and the index uploaded to R2")
    } else {
        format!(
            "logs: {sent} uploaded, {} failed ({})",
            failed.len(),
            failed.first().map_or("", String::as_str)
        )
    })
}

/// [`upload_with`] through `cf`, for Hive's own state, Agent.log and recordings. Does nothing
/// while another call is uploading.
pub fn upload_pending(cf: &Cf, bucket: &str) -> Option<String> {
    let _held = LOCK.try_lock().ok()?;
    let put = |key: &str, path: &Path| cloud_archive::put(cf, bucket, key, path);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    upload_with(
        &put,
        &hive_common::paths::state_dir(),
        &agent_log(),
        &crate::task_recording::folder(),
        now,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn uploads_what_changed_then_the_index_and_waits_between_runs() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let recs = dir.path().join("recs");
        std::fs::create_dir_all(state.join("sessions/2026-11-13T09-00-00-abc")).unwrap();
        std::fs::create_dir_all(state.join("sessions/.hidden")).unwrap();
        std::fs::write(state.join("sessions/2026-11-13T09-00-00-abc/journal.jsonl"), "{}\n").unwrap();
        std::fs::write(state.join("work-screen"), "virtual").unwrap();
        let log = dir.path().join("Agent.log");
        std::fs::write(&log, "started\n").unwrap();
        let rec = recs.join("2026-11-13 09.00.00 task");
        std::fs::create_dir_all(&rec).unwrap();
        std::fs::write(rec.join("timeline.jsonl"), "{}\n").unwrap();
        std::fs::write(rec.join(".uploaded"), "{}").unwrap();

        let sent = RefCell::new(Vec::<String>::new());
        let put = |key: &str, _: &Path| {
            sent.borrow_mut().push(key.to_string());
            (true, String::new())
        };
        let said = upload_with(&put, &state, &log, &recs, 1000.0).unwrap();
        assert!(said.contains("3 changed files"), "{said}");
        assert_eq!(
            *sent.borrow(),
            [
                "logs/sessions/2026-11-13T09-00-00-abc/journal.jsonl",
                "logs/Agent.log",
                "logs/settings/work-screen",
                "logs/index.json"
            ]
        );
        let index: Value =
            serde_json::from_str(&std::fs::read_to_string(state.join("cloud-logs-index.json")).unwrap()).unwrap();
        assert_eq!(index["files"].as_array().unwrap().len(), 3);
        assert_eq!(index["recordings"][0]["folder"], "2026-11-13 09.00.00 task");
        assert_eq!(index["recordings"][0]["prefix"], "recordings/2026-11-13-09.00.00-task");

        // Too soon: nothing.
        assert!(upload_with(&put, &state, &log, &recs, 1000.0 + 60.0).is_none());
        // Later, only the file that changed (and the index) go up.
        sent.borrow_mut().clear();
        std::fs::write(&log, "started\nmore\n").unwrap();
        upload_with(&put, &state, &log, &recs, 1000.0 + MIN_GAP_SECS + 1.0).unwrap();
        assert_eq!(*sent.borrow(), ["logs/Agent.log", "logs/index.json"]);
    }

    #[test]
    fn a_failed_upload_is_tried_again_and_kept_out_of_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().to_path_buf();
        let log = dir.path().join("Agent.log");
        std::fs::write(&log, "x\n").unwrap();
        let failing = |key: &str, _: &Path| (key == "logs/index.json", "denied".to_string());
        let said = upload_with(&failing, &state, &log, dir.path(), 0.0).unwrap();
        assert!(said.contains("1 failed"), "{said}");
        let index: Value =
            serde_json::from_str(&std::fs::read_to_string(state.join("cloud-logs-index.json")).unwrap()).unwrap();
        assert_eq!(index["files"].as_array().unwrap().len(), 0);
        let sent = RefCell::new(Vec::<String>::new());
        let ok = |key: &str, _: &Path| {
            sent.borrow_mut().push(key.to_string());
            (true, String::new())
        };
        upload_with(&ok, &state, &log, dir.path(), MIN_GAP_SECS + 1.0).unwrap();
        assert!(sent.borrow().contains(&"logs/Agent.log".to_string()));
    }
}
