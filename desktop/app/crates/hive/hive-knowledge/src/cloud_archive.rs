//! Copies each task recording (see [`crate::task_recording`]) to Cloudflare R2, bucket
//! "hive-recordings" (python/cloud_archive.py).
//!
//! The video is re-encoded for the upload (1440 px wide, 10 fps, quality-based H.264, at low
//! priority): a mostly still screen comes to well under 1 MB a minute. Only if a copy would still
//! pass R2's 300 MB single-upload limit is it split into parts. The full-resolution original stays
//! on the Mac. The timeline, subtitles and metadata go up as they are. Uploads use the signed-in
//! Cloudflare CLI (`cf`). A folder is marked done with `.uploaded`; anything not yet uploaded is
//! tried again after the next recording and when Hive starts.
//!
//! Objects: recordings/<folder name with dashes>/{screen.mp4 | screen-part-01.mp4 ...,
//! timeline.jsonl, screen.srt, meta.json, manifest.json}. `HIVE_R2_BUCKET` sets another bucket.

use crate::pyjson;
use crate::util;
use crate::Report;
use regex::Regex;
use serde_json::json;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Under R2's 300 MB single-upload limit.
pub const LIMIT: u64 = 280 * 1024 * 1024;

static LOCK: Mutex<()> = Mutex::new(());

/// The bucket: `HIVE_R2_BUCKET`, else "hive-recordings".
pub fn bucket() -> String {
    std::env::var("HIVE_R2_BUCKET").unwrap_or_else(|_| "hive-recordings".into())
}

/// The content type an object is uploaded with, by its file's extension.
pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("mp4") => "video/mp4",
        Some("jsonl") => "application/x-ndjson",
        Some("json") => "application/json",
        Some("srt") => "application/x-subrip",
        Some("log") => "text/plain",
        _ => "application/octet-stream",
    }
}

/// The Cloudflare CLI and the PATH it runs with (its own folder first, so its `node` is found).
#[derive(Debug, Clone)]
pub struct Cf {
    pub path: PathBuf,
    pub search_path: OsString,
}

impl Cf {
    /// A command running `cf`, with its PATH.
    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.path);
        command.env("PATH", &self.search_path);
        command
    }
}

/// `cf` on PATH, else the newest `~/.nvm/versions/node/*/bin/cf`.
pub fn cf() -> Option<Cf> {
    let found = util::which("cf").or_else(|| {
        let node = hive_common::paths::home().join(".nvm/versions/node");
        util::listing(&node)
            .into_iter()
            .map(|v| v.join("bin/cf"))
            .filter(|p| p.exists())
            .next_back()
    })?;
    let mut search_path = found
        .parent()
        .map(|p| p.as_os_str().to_owned())
        .unwrap_or_default();
    search_path.push(":");
    search_path.push(std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()));
    Some(Cf {
        path: found,
        search_path,
    })
}

/// ffmpeg on PATH or where Homebrew puts it.
pub fn ffmpeg() -> Option<PathBuf> {
    util::which("ffmpeg").or_else(|| {
        ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.exists())
    })
}

static UNSAFE_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^A-Za-z0-9._-]+").expect("valid pattern"));

/// `recordings/<folder name with dashes>`.
pub fn key_prefix(folder: &Path) -> String {
    let name = util::file_name(folder);
    format!(
        "recordings/{}",
        UNSAFE_KEY.replace_all(&name, "-").trim_matches('-')
    )
}

/// Smaller copies of screen.mov to upload: one file, or parts of equal length under the limit.
/// `Err` when ffmpeg couldn't be run or ran out of time (Python raised).
pub fn shrink(folder: &Path) -> Result<Vec<PathBuf>, String> {
    let source = folder.join("screen.mov");
    let Some(ffmpeg) = ffmpeg().filter(|_| source.exists()) else {
        return Ok(vec![]);
    };
    let out = folder.join("upload");
    if let Err(e) = std::fs::create_dir(&out) {
        if !out.is_dir() {
            return Err(util::os_error(&e, &out));
        }
    }
    for old in util::listing(&out) {
        let name = util::file_name(&old);
        if name.starts_with("screen") && name.ends_with(".mp4") {
            let _ = std::fs::remove_file(&old);
        }
    }
    let single = out.join("screen.mp4");
    // A mostly still screen compresses to well under 1 MB a minute this way (the raw 60 fps Retina
    // file is ~25 MB a minute). Quality-based x264 at 10 fps and the screen's point size (1440 wide).
    let mut encode = Command::new("nice");
    encode
        .arg("-n")
        .arg("15")
        .arg(&ffmpeg)
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(&source);
    encode.args([
        "-an",
        "-vf",
        "scale=1440:-2,fps=10",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "30",
    ]);
    encode
        .args(["-tune", "stillimage", "-movflags", "+faststart"])
        .arg(&single);
    let done = util::run(&mut encode, None, Some(Duration::from_secs(6 * 3600)))
        .map_err(|e| e.to_string())?;
    if !done.status.success() {
        return Ok(vec![]);
    }
    let size = std::fs::metadata(&single)
        .map(|m| m.len())
        .map_err(|e| util::os_error(&e, &single))?;
    if size <= LIMIT {
        return Ok(vec![single]);
    }
    let length = crate::task_recording::video_length(&single).unwrap_or(0.0);
    let parts = size / LIMIT + 1;
    let seconds = if length != 0.0 {
        30.max((length / parts as f64) as i64 - 5)
    } else {
        600
    };
    let mut split = Command::new(&ffmpeg);
    split.args(["-y", "-loglevel", "error", "-i"]).arg(&single);
    split.args([
        "-c",
        "copy",
        "-f",
        "segment",
        "-segment_time",
        &seconds.to_string(),
        "-reset_timestamps",
        "1",
    ]);
    split.arg(out.join("screen-part-%02d.mp4"));
    util::run(&mut split, None, Some(Duration::from_secs(3600))).map_err(|e| e.to_string())?;
    let pieces: Vec<PathBuf> = util::listing(&out)
        .into_iter()
        .filter(|p| {
            let name = util::file_name(p);
            name.starts_with("screen-part-") && name.ends_with(".mp4")
        })
        .collect();
    if !pieces.is_empty() {
        let _ = std::fs::remove_file(&single);
        let names: Vec<String> = pieces.iter().map(|p| util::file_name(p)).collect();
        let parts = json!({"secondsPerPart": seconds, "parts": names});
        let written = out.join("parts.json");
        std::fs::write(&written, pyjson::dumps_with(&parts, true, Some(1)))
            .map_err(|e| util::os_error(&e, &written))?;
    }
    Ok(pieces)
}

/// Uploads one file. Returns (whether it worked, the end of what cf said).
pub fn put(cf: &Cf, bucket: &str, key: &str, path: &Path) -> (bool, String) {
    let mut command = cf.command();
    command
        .args([
            "r2",
            "objects",
            "put",
            key,
            "--bucket-name",
            bucket,
            "--file",
        ])
        .arg(path);
    command.args(["--content-type", content_type(path)]);
    match util::run(&mut command, None, Some(Duration::from_secs(3600))) {
        Ok(run) => {
            let said = if !run.stderr.is_empty() {
                &run.stderr
            } else {
                &run.stdout
            };
            let said = String::from_utf8_lossy(said);
            (
                run.status.success(),
                pyjson::tail(said.trim(), 300).to_string(),
            )
        }
        Err(error) => (false, error.to_string()),
    }
}

/// Uploads one finished recording folder. Returns a one-line result.
pub fn archive(folder: &Path) -> String {
    match cf() {
        None => "cf (Cloudflare CLI) not found".into(),
        Some(cf) => {
            archive_with(folder, &cf, &bucket()).unwrap_or_else(|e| format!("upload failed: {e}"))
        }
    }
}

/// [`archive`] with a given `cf` and bucket. `Err` is what Python raised (archive_pending reports
/// it as "upload failed: ...").
pub fn archive_with(folder: &Path, cf: &Cf, bucket: &str) -> Result<String, String> {
    let mut files = shrink(folder)?;
    let extra = [
        "timeline.jsonl",
        "screen.srt",
        "meta.json",
        "screencapture.log",
    ]
    .map(|n| folder.join(n));
    let parts = folder.join("upload/parts.json");
    files.extend(
        extra
            .into_iter()
            .chain([parts])
            .filter(|p| std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false)),
    );
    let (prefix, mut uploaded) = (key_prefix(folder), Vec::new());
    for path in &files {
        let key = format!("{prefix}/{}", util::file_name(path));
        let (ok, detail) = put(cf, bucket, &key, path);
        if !ok {
            return Ok(format!(
                "upload of {} failed: {detail}",
                util::file_name(path)
            ));
        }
        let bytes = std::fs::metadata(path)
            .map(|m| m.len())
            .map_err(|e| util::os_error(&e, path))?;
        uploaded.push(json!({"key": key, "bytes": bytes}));
    }
    let count = uploaded.len();
    let manifest = json!({"bucket": bucket, "uploaded": util::Local::now().iso_seconds(), "objects": uploaded,
                          "originalVideoOnMac": folder.join("screen.mov").to_string_lossy()});
    let text = pyjson::dumps_with(&manifest, true, Some(1));
    // As in Python: without an upload folder (no screen.mov or no ffmpeg) this fails, the folder
    // isn't marked uploaded, and it is tried again next time.
    let written = folder.join("upload/manifest.json");
    std::fs::write(&written, &text).map_err(|e| util::os_error(&e, &written))?;
    put(cf, bucket, &format!("{prefix}/manifest.json"), &written);
    let done = folder.join(".uploaded");
    std::fs::write(&done, &text).map_err(|e| util::os_error(&e, &done))?;
    Ok(format!("uploaded {count} files to R2 {bucket}/{prefix}"))
}

/// Uploads every finished recording that isn't uploaded yet, one at a time. Does nothing while
/// another call is uploading.
pub fn archive_pending(report: Option<Report>) {
    archive_pending_in(&crate::task_recording::folder(), cf(), &bucket(), report)
}

/// [`archive_pending`] for one recordings folder, with a given `cf` (None: not installed).
pub fn archive_pending_in(root: &Path, cf: Option<Cf>, bucket: &str, report: Option<Report>) {
    let Ok(_held) = LOCK.try_lock() else { return };
    for folder in util::listing(root) {
        if folder.is_dir()
            && folder.join("meta.json").exists()
            && !folder.join(".uploaded").exists()
        {
            let result = match &cf {
                None => "cf (Cloudflare CLI) not found".to_string(),
                Some(cf) => archive_with(&folder, cf, bucket)
                    .unwrap_or_else(|e| format!("upload failed: {e}")),
            };
            if let Some(report) = &report {
                report(&format!("Recording {}: {result}", util::file_name(&folder)));
            }
        }
    }
}

/// [`archive_pending`] on a thread named "cloud-archive".
pub fn archive_in_background(report: Option<Report>) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("cloud-archive".into())
        .spawn(move || archive_pending(report))
        .expect("spawn cloud-archive")
}
