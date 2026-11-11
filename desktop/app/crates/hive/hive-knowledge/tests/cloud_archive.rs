//! Uploading recordings (python/cloud_archive.py) against a fake `cf` that only logs what it was
//! asked: nothing reaches Cloudflare, and with no screen.mov ffmpeg never runs.

mod common;

use hive_knowledge::cloud_archive::{self, Cf};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A `cf` script that appends its arguments to `cf.log` and exits with `code`.
fn fake_cf(dir: &Path, code: i32) -> Cf {
    let path = dir.join("cf");
    let log = dir.join("cf.log");
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n[ {code} -eq 0 ] || echo 'not authorized' >&2\nexit {code}\n",
        log.display()
    );
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    Cf {
        path,
        search_path: "/usr/bin:/bin".into(),
    }
}

fn calls(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("cf.log"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

/// A finished recording folder: timeline, subtitles and meta, no video.
fn recording(root: &Path, name: &str) -> PathBuf {
    let folder = root.join(name);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("timeline.jsonl"), "{}\n").unwrap();
    std::fs::write(folder.join("screen.srt"), "1\n").unwrap();
    std::fs::write(folder.join("meta.json"), "{}").unwrap();
    std::fs::write(folder.join("screencapture.log"), "").unwrap(); // empty: not uploaded
    folder
}

#[test]
fn a_recording_goes_up_with_its_manifest() {
    let dir = tempfile::tempdir().unwrap();
    let cf = fake_cf(dir.path(), 0);
    let folder = recording(dir.path(), "2026-11-11 09-30-00 Fill the form");
    std::fs::create_dir(folder.join("upload")).unwrap();
    let result = cloud_archive::archive_with(&folder, &cf, "test-bucket").unwrap();
    assert_eq!(
        result,
        "uploaded 3 files to R2 test-bucket/recordings/2026-11-11-09-30-00-Fill-the-form"
    );
    assert!(folder.join(".uploaded").exists());
    let calls = calls(dir.path());
    assert_eq!(calls.len(), 4);
    let prefix = "r2 objects put recordings/2026-11-11-09-30-00-Fill-the-form";
    assert!(calls[0].starts_with(&format!(
        "{prefix}/timeline.jsonl --bucket-name test-bucket --file "
    )));
    assert!(calls[0].ends_with("--content-type application/x-ndjson"));
    assert!(
        calls[1].contains("/screen.srt --bucket-name")
            && calls[1].ends_with("application/x-subrip")
    );
    assert!(
        calls[2].contains("/meta.json --bucket-name") && calls[2].ends_with("application/json")
    );
    assert!(calls[3].starts_with(&format!("{prefix}/manifest.json ")));
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(folder.join("upload/manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["bucket"], "test-bucket");
    assert_eq!(manifest["objects"].as_array().unwrap().len(), 3);
    assert_eq!(manifest["objects"][2]["bytes"], 2);
}

#[test]
fn a_failed_upload_says_which_file_and_is_tried_again() {
    let dir = tempfile::tempdir().unwrap();
    let cf = fake_cf(dir.path(), 1);
    let folder = recording(dir.path(), "one");
    std::fs::create_dir(folder.join("upload")).unwrap();
    let result = cloud_archive::archive_with(&folder, &cf, "b").unwrap();
    assert_eq!(result, "upload of timeline.jsonl failed: not authorized");
    assert!(!folder.join(".uploaded").exists());
    assert_eq!(calls(dir.path()).len(), 1);
}

#[test]
fn pending_recordings_are_reported_and_marked() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("recordings");
    let cf = fake_cf(dir.path(), 0);
    let done = recording(&root, "done");
    std::fs::write(done.join(".uploaded"), "{}").unwrap();
    recording(&root, "no upload folder"); // as in Python: the manifest can't be written yet
    let ready = recording(&root, "ready");
    std::fs::create_dir(ready.join("upload")).unwrap();
    std::fs::create_dir(root.join("unfinished")).unwrap(); // no meta.json: still recording
    let lines = Arc::new(Mutex::new(Vec::new()));
    let seen = lines.clone();
    let report: hive_knowledge::Report =
        Arc::new(move |line: &str| seen.lock().unwrap().push(line.to_string()));
    cloud_archive::archive_pending_in(&root, Some(cf), "b", Some(report.clone()));
    let lines = lines.lock().unwrap().clone();
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(lines[0].starts_with(
        "Recording no upload folder: upload failed: [Errno 2] No such file or directory: "
    ));
    assert_eq!(
        lines[1],
        "Recording ready: uploaded 3 files to R2 b/recordings/ready"
    );
    assert!(ready.join(".uploaded").exists());
    assert!(!root.join("no upload folder/.uploaded").exists());
    let missing = Arc::new(Mutex::new(Vec::new()));
    let seen = missing.clone();
    let report: hive_knowledge::Report =
        Arc::new(move |line: &str| seen.lock().unwrap().push(line.to_string()));
    cloud_archive::archive_pending_in(&root, None, "b", Some(report));
    assert_eq!(
        *missing.lock().unwrap(),
        ["Recording no upload folder: cf (Cloudflare CLI) not found"]
    );
}

#[test]
fn keys_types_and_the_bucket() {
    assert_eq!(
        cloud_archive::key_prefix(Path::new("/x/2026-11-11 09:30 Fill the form!")),
        "recordings/2026-11-11-09-30-Fill-the-form"
    );
    assert_eq!(
        cloud_archive::content_type(Path::new("a/screen-part-01.mp4")),
        "video/mp4"
    );
    assert_eq!(
        cloud_archive::content_type(Path::new("screencapture.log")),
        "text/plain"
    );
    assert_eq!(
        cloud_archive::content_type(Path::new("screen.mov")),
        "application/octet-stream"
    );
    let mut env = common::Env::new(&[]);
    env.remove("HIVE_R2_BUCKET");
    assert_eq!(cloud_archive::bucket(), "hive-recordings");
    env.set("HIVE_R2_BUCKET", "other");
    assert_eq!(cloud_archive::bucket(), "other");
}
