//! `hive-dream sync`, on Hive's VM: mirrors what the Mac uploaded for the dream (hive-knowledge's
//! `log_archive`: `logs/index.json` and what it lists) from Cloudflare R2 into a folder laid out
//! as the Mac has it, each file with the Mac's mtime (collect picks files by mtime):
//!
//! `<mirror>/state/sessions/<id>/journal.jsonl`, `<mirror>/state/<setting>`, `<mirror>/Agent.log`,
//! `<mirror>/recordings/<folder>/timeline.jsonl`.
//!
//! The nightly run then reads the mirror (AGENT_STATE_DIR, HIVE_AGENT_LOG, HIVE_RECORDINGS_DIR).
//! Objects are read with wrangler (`HIVE_DREAM_WRANGLER`, else `wrangler` in a login shell, which
//! is how the VM is signed in to Cloudflare).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::Value;

/// Only files changed in the last this many days are mirrored.
pub const DAYS: f64 = 14.0;

pub fn bucket() -> String {
    std::env::var("HIVE_R2_BUCKET").unwrap_or_else(|_| "hive-recordings".into())
}

fn safe_part(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains('/') && !s.contains('\0')
}

fn safe_key(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('/')
        && s.split('/').all(safe_part)
        && s.chars().all(|c| !c.is_control())
}

/// Where one entry of the index goes in the mirror, or None when it isn't one the dream reads.
pub fn local_path(mirror: &Path, kind: &str, name: &str) -> Option<PathBuf> {
    if !safe_part(name) {
        return None;
    }
    match kind {
        "journal" => Some(mirror.join("state/sessions").join(name).join("journal.jsonl")),
        "setting" => Some(mirror.join("state").join(name)),
        "agent_log" => Some(mirror.join("Agent.log")),
        _ => None,
    }
}

/// Everything to fetch: (R2 key, local path, the Mac's mtime), skipping what's older than
/// `since` and what the mirror already has with that mtime.
pub fn plan(index: &Value, mirror: &Path, since: f64) -> Vec<(String, PathBuf, f64)> {
    let mut out = Vec::new();
    let mut want = |key: &str, path: PathBuf, mtime: f64, since: f64| {
        if mtime < since || !safe_key(key) {
            return;
        }
        if crate::paths::mtime(&path).is_some_and(|m| (m - mtime).abs() < 0.001) {
            return;
        }
        out.push((key.to_string(), path, mtime));
    };
    for f in index["files"].as_array().into_iter().flatten() {
        let (Some(key), Some(kind), Some(name), Some(mtime)) = (
            f["key"].as_str(),
            f["kind"].as_str(),
            f["name"].as_str(),
            f["mtime"].as_f64(),
        ) else {
            continue;
        };
        // Agent.log and the settings are read whatever their age.
        let since_here = if kind == "journal" { since } else { 0.0 };
        if let Some(path) = local_path(mirror, kind, name) {
            want(key, path, mtime, since_here);
        }
    }
    for r in index["recordings"].as_array().into_iter().flatten() {
        let (Some(folder), Some(prefix), Some(mtime)) = (
            r["folder"].as_str(),
            r["prefix"].as_str(),
            r["timeline_mtime"].as_f64(),
        ) else {
            continue;
        };
        if !safe_part(folder) {
            continue;
        }
        want(
            &format!("{prefix}/timeline.jsonl"),
            mirror.join("recordings").join(folder).join("timeline.jsonl"),
            mtime,
            since,
        );
    }
    out
}

/// Fetches one object to `path` (through a `.part` file), then sets its mtime.
fn get(bucket: &str, key: &str, path: &Path, mtime: Option<f64>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let part = path.with_extension("part");
    let _ = std::fs::remove_file(&part);
    let out = match std::env::var("HIVE_DREAM_WRANGLER").ok().filter(|v| !v.is_empty()) {
        Some(w) => Command::new(w)
            .args(["r2", "object", "get", &format!("{bucket}/{key}"), "--remote", "--file"])
            .arg(&part)
            .output(),
        None => Command::new("bash")
            .args([
                "-lc",
                r#"wrangler r2 object get "$1/$2" --remote --file "$3" >/dev/null"#,
                "hive-dream",
                bucket,
                key,
            ])
            .arg(&part)
            .output(),
    }
    .map_err(|e| format!("wrangler: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&part);
        let said = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "{key}: {}",
            said.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("wrangler failed")
        ));
    }
    if let Some(t) = mtime {
        let f = std::fs::File::options()
            .write(true)
            .open(&part)
            .map_err(|e| e.to_string())?;
        f.set_modified(UNIX_EPOCH + Duration::from_secs_f64(t.max(0.0)))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&part, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Mirrors the index and what changed. Returns a one-line summary.
pub fn run(mirror: &Path) -> Result<String, String> {
    let bucket = bucket();
    let index_path = mirror.join("index.json");
    get(&bucket, "logs/index.json", &index_path, None)?;
    let index: Value = serde_json::from_str(
        &std::fs::read_to_string(&index_path).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("logs/index.json: {e}"))?;
    let since = crate::time::now() - DAYS * 86400.0;
    let todo = plan(&index, mirror, since);
    let (mut got, mut failed) = (0usize, Vec::new());
    for (key, path, mtime) in &todo {
        match get(&bucket, key, path, Some(*mtime)) {
            Ok(()) => got += 1,
            Err(e) => failed.push(e),
        }
    }
    let updated = index["updated"].as_str().unwrap_or("?");
    if failed.is_empty() {
        Ok(format!("mirrored {got} files (the Mac's index from {updated})"))
    } else {
        Ok(format!(
            "mirrored {got} files, {} failed, e.g. {} (the Mac's index from {updated})",
            failed.len(),
            failed[0]
        ))
    }
}
