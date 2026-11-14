//! The VM's mirror of what the Mac uploaded: where each file goes, what is fetched again.

use hive_dream::sync::{local_path, plan};
use serde_json::json;
use std::path::Path;

#[test]
fn index_entries_land_where_collect_reads_them_and_nothing_escapes_the_mirror() {
    let m = Path::new("/m");
    assert_eq!(
        local_path(m, "journal", "2026-11-13T09-00-00-abc").unwrap(),
        Path::new("/m/state/sessions/2026-11-13T09-00-00-abc/journal.jsonl")
    );
    assert_eq!(local_path(m, "setting", "work-screen").unwrap(), Path::new("/m/state/work-screen"));
    assert_eq!(local_path(m, "agent_log", "Agent.log").unwrap(), Path::new("/m/Agent.log"));
    assert_eq!(
        local_path(m, "activity", "2026-11-14.jsonl").unwrap(),
        Path::new("/m/state/activity/2026-11-14.jsonl")
    );
    assert!(local_path(m, "journal", "../../etc").is_none());
    assert!(local_path(m, "journal", "a/b").is_none());
    assert!(local_path(m, "other", "x").is_none());
}

#[test]
fn only_recent_journals_and_changed_files_are_fetched() {
    let dir = tempfile::tempdir().unwrap();
    let mirror = dir.path();
    let index = json!({
        "files": [
            {"key": "logs/sessions/new/journal.jsonl", "kind": "journal", "name": "new", "bytes": 3, "mtime": 2000.0},
            {"key": "logs/sessions/old/journal.jsonl", "kind": "journal", "name": "old", "bytes": 3, "mtime": 10.0},
            {"key": "logs/Agent.log", "kind": "agent_log", "name": "Agent.log", "bytes": 3, "mtime": 10.0},
            {"key": "logs/sessions/x/journal.jsonl", "kind": "journal", "name": "../x", "bytes": 3, "mtime": 2000.0}
        ],
        "recordings": [
            {"folder": "2026-11-13 09.00.00 task", "prefix": "recordings/2026-11-13-09.00.00-task", "timeline_mtime": 2000.0},
            {"folder": "..", "prefix": "recordings/up", "timeline_mtime": 2000.0}
        ]
    });
    let keys: Vec<String> = plan(&index, mirror, 1000.0).into_iter().map(|(k, _, _)| k).collect();
    assert_eq!(
        keys,
        [
            "logs/sessions/new/journal.jsonl",
            "logs/Agent.log",
            "recordings/2026-11-13-09.00.00-task/timeline.jsonl"
        ]
    );
    // A file the mirror already has with the Mac's mtime isn't fetched again.
    let log = mirror.join("Agent.log");
    std::fs::write(&log, "abc").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&log)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(10))
        .unwrap();
    let keys: Vec<String> = plan(&index, mirror, 1000.0).into_iter().map(|(k, _, _)| k).collect();
    assert!(!keys.contains(&"logs/Agent.log".to_string()));
}
