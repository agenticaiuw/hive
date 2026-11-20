//! Putting in a new release of Hive on this Mac by itself (owner, 2026-11-18: "No version check or
//! automatic updates between nodes. A node on old code finds out only when a route answers
//! differently."). The VM's twin is cloud/vm-agent/updater.mjs.
//!
//! A Mac release (`node cloud/release.mjs mac`) is what a build makes, never source, so it can't
//! overwrite anyone's work: the agent and its tools (desktop/app/build/hive-agent and the rest), the
//! dashboard Hive's window shows (desktop/app/build/dashboard) and the browser extension Chrome runs
//! (browser/chrome/build/chrome, which reloads itself when its files change: browser/chrome/src/
//! version.js), in the format cloud/vm-agent/version.mjs makes. The app itself (Hive.app), the voice
//! models' Python and the privileged helper come with the install, not a release.
//!
//! 1. Now and then the agent asks the board for the newest Mac release (GET /v1/releases/latest).
//!    A build made by hand ("dev") is never replaced (node::wants_update), nor is a release put in
//!    for one this Mac already gave up on.
//! 2. It downloads it, checks its sha256, its processor and its files, and lays it out beside the
//!    build (build/.update/<version>), where its hive-agent must answer --version with that version.
//! 3. Once Hive is idle (no task, not listening or dictating, nothing said or done on the Mac for a
//!    while), each file or folder goes in by rename (the old one kept in build/.update/previous),
//!    and the agent stops; Hive.app starts the new one within a second.
//! 4. The new agent confirms the release once it has run for two minutes. One that starts a third
//!    time without that puts the previous files back and stops, so the app starts the old agent.
//! What happened is said on the board (POST /v1/nodes/report) for the dashboard.
//!
//! A club member's Mac asks the club's board instead, with the member's key (tasks.json `releases`,
//! lib.rs Cloud::release_source), so every member's Mac runs the same Hive as the owner's.

use crate::{node, Cloud};
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The release format this reads (cloud/vm-agent/version.mjs FORMAT).
pub const FORMAT: u64 = 1;
/// Where a release's files may go, under the Hive folder (the repository's root): build output only.
pub const PLACES: [&str; 2] = ["desktop/app/build/", "browser/chrome/build/chrome/"];
/// Folders that go in whole, so what's in them always belongs together.
pub const WHOLE: [&str; 2] = ["desktop/app/build/dashboard", "browser/chrome/build/chrome"];
/// The new agent has to run this long before its release counts as good.
pub const CONFIRM_AFTER: Duration = Duration::from_secs(120);
/// Starts without that before the previous files go back.
pub const MOST_STARTS: u64 = 3;
/// Hive has to have been quiet this long (and still be) before the files go in.
pub const QUIET: Duration = Duration::from_secs(300);
const MOST_BYTES: u64 = 200 << 20;

#[derive(Debug, Clone, PartialEq)]
pub struct File {
    pub path: String,
    pub mode: u32,
    pub data: Vec<u8>,
}

#[derive(Debug)]
pub struct Release {
    pub version: String,
    pub files: Vec<File>,
}

/// This Mac's processor, as releases name it (Node's process.arch).
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The hash of a release's files (version.mjs bundleVersion): the same files always give the same 12 hex.
pub fn files_version(files: &[File]) -> String {
    let mut sorted: Vec<&File> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut text = String::new();
    for f in sorted {
        text.push_str(&format!("{}\0{}\0{}\n", f.path, f.mode, hex(&Sha256::digest(&f.data))));
    }
    hex(&Sha256::digest(text.as_bytes()))[..12].to_string()
}

/// A path a release may hold (version.mjs SAFE_PATH): plain names, no "." or "..", none empty.
pub fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}

/// A Mac release's bytes → its files, checked: the sha256 the board gave, the format, that it's for a
/// Mac with this processor, every path inside the build output, and the files against their hash.
pub fn unpack(bytes: &[u8], sha256: &str) -> Result<Release, String> {
    if hex(&Sha256::digest(bytes)) != sha256.to_ascii_lowercase() {
        return Err("the release's bytes don't match its sha256".into());
    }
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes)
        .take(MOST_BYTES * 2)
        .read_to_string(&mut text)
        .map_err(|e| format!("the release isn't gzipped JSON: {e}"))?;
    let body: Value = serde_json::from_str(&text).map_err(|e| format!("the release isn't gzipped JSON: {e}"))?;
    if body["format"].as_u64() != Some(FORMAT) {
        return Err(format!("release format {} is newer than this updater reads", body["format"]));
    }
    if body["kind"] != "mac" {
        return Err(format!("that's a {} release, not a Mac's", body["kind"].as_str().unwrap_or("?")));
    }
    let made_for = body["arch"].as_str().unwrap_or("");
    if made_for != arch() {
        return Err(format!("it's built for {} processors and this Mac has {}", if made_for.is_empty() { "unnamed" } else { made_for }, arch()));
    }
    let version = body["version"].as_str().unwrap_or("").to_string();
    if version.is_empty() {
        return Err("the release has no version".into());
    }
    let mut files = Vec::new();
    for f in body["files"].as_array().ok_or("the release lists no files")? {
        let path = f["path"].as_str().unwrap_or("");
        if !safe_path(path) || !PLACES.iter().any(|p| path.starts_with(p)) {
            return Err(format!("the release holds a file outside Hive's build output: {path}"));
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(f["data"].as_str().unwrap_or(""))
            .map_err(|e| format!("{path} isn't base64: {e}"))?;
        let mode = if f["mode"].as_u64() == Some(0o755) { 0o755 } else { 0o644 };
        files.push(File { path: path.to_string(), mode, data });
    }
    let said = body["files_version"].as_str().unwrap_or(&version);
    if files_version(&files) != said {
        return Err("the release's files don't match its version".into());
    }
    Ok(Release { version, files })
}

/// Where updates are worked out: `<hive>/desktop/app/build/.update`.
pub fn work_dir(hive: &Path) -> PathBuf {
    hive.join("desktop/app/build/.update")
}

/// The Hive folder this agent runs from: `<hive>/desktop/app/build/hive-agent`. None for an agent
/// run from anywhere else (a test build), which never updates itself.
pub fn hive_folder() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let build = exe.parent()?;
    let app = build.parent()?;
    let desktop = app.parent()?;
    (build.file_name()? == "build" && app.file_name()? == "app" && desktop.file_name()? == "desktop")
        .then(|| desktop.parent().map(Path::to_path_buf))
        .flatten()
}

/// What the updater keeps between runs (build/.update/state.json): the release it put in last, and
/// the releases it gave up on.
fn read_state(hive: &Path) -> Value {
    std::fs::read_to_string(work_dir(hive).join("state.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn write_state(hive: &Path, state: &Value) -> Result<(), String> {
    let dir = work_dir(hive);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = dir.join("state.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap_or_default()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, dir.join("state.json")).map_err(|e| format!("{}: {e}", dir.display()))
}

/// Whether this Mac gave up on `version` before (it failed a check, or didn't start).
pub fn gave_up_on(hive: &Path, version: &str) -> bool {
    read_state(hive)["gave_up"].as_array().is_some_and(|v| v.iter().any(|x| x == version))
}

fn give_up(hive: &Path, version: &str) {
    let mut state = read_state(hive);
    let mut list = state["gave_up"].as_array().cloned().unwrap_or_default();
    if !list.iter().any(|x| x == version) {
        list.push(json!(version));
    }
    let keep = list.len().saturating_sub(20);
    state["gave_up"] = Value::Array(list.split_off(keep));
    let _ = write_state(hive, &state);
}

/// Lays the release out in build/.update/<version> and checks its agent answers --version with the
/// release's version. Returns that folder.
pub fn stage(hive: &Path, release: &Release) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt as _;
    let staged = work_dir(hive).join(&release.version);
    let _ = std::fs::remove_dir_all(&staged);
    for f in &release.files {
        let to = staged.join(&f.path);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&to, &f.data).map_err(|e| format!("{}: {e}", to.display()))?;
        std::fs::set_permissions(&to, std::fs::Permissions::from_mode(f.mode)).map_err(|e| format!("{}: {e}", to.display()))?;
    }
    let agent = staged.join("desktop/app/build/hive-agent");
    let answer = std::process::Command::new(&agent)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("its hive-agent wouldn't start: {e}"))?;
    let said = String::from_utf8_lossy(&answer.stdout).trim().to_string();
    if !answer.status.success() || said != release.version {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(format!("its hive-agent says it's {:?}, not {}", said, release.version));
    }
    Ok(staged)
}

/// What a release replaces: each file on its own, and each WHOLE folder as one.
fn units(release: &Release) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in &release.files {
        let unit = WHOLE
            .iter()
            .find(|w| f.path.starts_with(&format!("{w}/")))
            .map(|w| w.to_string())
            .unwrap_or_else(|| f.path.clone());
        if !out.contains(&unit) {
            out.push(unit);
        }
    }
    out
}

fn remove(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Puts the staged release in: each unit by rename, the one it replaces kept in
/// build/.update/previous. On a failure partway, what went in comes back out.
pub fn apply(hive: &Path, staged: &Path, release: &Release, from: &str) -> Result<(), String> {
    let previous = work_dir(hive).join("previous");
    remove(&previous).map_err(|e| format!("{}: {e}", previous.display()))?;
    let units = units(release);
    let mut done: Vec<&String> = Vec::new();
    let put_back = |done: &[&String]| {
        for unit in done.iter().rev() {
            let (target, kept) = (hive.join(unit), previous.join(unit));
            let _ = remove(&target);
            if kept.symlink_metadata().is_ok() {
                let _ = std::fs::rename(&kept, &target);
            }
        }
    };
    for unit in &units {
        let (target, new, kept) = (hive.join(unit), staged.join(unit), previous.join(unit));
        let step = || -> std::io::Result<()> {
            if target.symlink_metadata().is_ok() {
                std::fs::create_dir_all(kept.parent().unwrap_or(&previous))?;
                std::fs::rename(&target, &kept)?;
            }
            std::fs::create_dir_all(target.parent().unwrap_or(hive))?;
            std::fs::rename(&new, &target)
        };
        if let Err(e) = step() {
            put_back(&done);
            put_back(&[unit]);
            return Err(format!("{unit} wouldn't go in ({e}); everything is as it was"));
        }
        done.push(unit);
    }
    let _ = std::fs::remove_dir_all(staged);
    let mut state = read_state(hive);
    state["put_in"] = json!({ "from": from, "to": release.version, "at": secs(), "starts": 0, "confirmed": false, "units": units });
    write_state(hive, &state)
}

/// Puts back what the last release replaced. What it says happened.
pub fn roll_back(hive: &Path) -> Result<String, String> {
    let mut state = read_state(hive);
    let put_in = state["put_in"].clone();
    let units: Vec<String> = put_in["units"].as_array().into_iter().flatten().filter_map(|u| u.as_str().map(str::to_string)).collect();
    if units.is_empty() {
        return Err("no release was put in to take back out".into());
    }
    let previous = work_dir(hive).join("previous");
    for unit in &units {
        let (target, kept) = (hive.join(unit), previous.join(unit));
        remove(&target).map_err(|e| format!("{}: {e}", target.display()))?;
        if kept.symlink_metadata().is_ok() {
            std::fs::rename(&kept, &target).map_err(|e| format!("{}: {e}", target.display()))?;
        }
    }
    let (from, to) = (put_in["from"].as_str().unwrap_or("?").to_string(), put_in["to"].as_str().unwrap_or("?").to_string());
    state["put_in"]["rolled_back"] = json!(true);
    state["put_in"]["confirmed"] = json!(true);
    let _ = write_state(hive, &state);
    give_up(hive, &to);
    Ok(format!("Hive {to} didn't stay running on this Mac, so it went back to {from}."))
}

/// What the agent does as it starts: counts a start of a release not yet confirmed, and puts the
/// previous one back on the MOST_STARTS-th. `version` is this agent's (node::VERSION).
#[derive(Debug, PartialEq)]
pub enum Start {
    /// Carry on; `confirm` is a release to confirm once the agent has run CONFIRM_AFTER.
    Run { confirm: Option<String> },
    /// The previous release is back: stop, so the app starts it. The note says why.
    RolledBack(String),
}

pub fn on_start(hive: &Path, version: &str) -> Start {
    let mut state = read_state(hive);
    let put_in = &state["put_in"];
    if put_in["to"] != version || put_in["confirmed"] == true {
        return Start::Run { confirm: None };
    }
    let starts = put_in["starts"].as_u64().unwrap_or(0) + 1;
    state["put_in"]["starts"] = json!(starts);
    let _ = write_state(hive, &state);
    if starts >= MOST_STARTS {
        return match roll_back(hive) {
            Ok(note) => Start::RolledBack(note),
            Err(_) => Start::Run { confirm: None },
        };
    }
    Start::Run { confirm: Some(version.to_string()) }
}

/// The release this agent runs has run long enough: it stays.
pub fn confirm(hive: &Path, version: &str) {
    let mut state = read_state(hive);
    if state["put_in"]["to"] == version && state["put_in"]["confirmed"] != true {
        state["put_in"]["confirmed"] = json!(true);
        let _ = write_state(hive, &state);
        let _ = std::fs::remove_dir_all(work_dir(hive).join("previous"));
    }
}

/// Says on the board what happened (the dashboard shows it beside this Mac).
pub fn report(cloud: &Cloud, note: &str) {
    let _ = cloud.post("/v1/nodes/report", &json!({ "kind": "mac", "name": cloud.machine, "note": note }));
}

fn encode(value: &str) -> String {
    value.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// What one look for a release came to.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Nothing to do (a build made by hand, no release, this one, or one given up on).
    Current,
    /// A release is checked and waits for Hive to be idle.
    Waiting(String),
    /// It's in; the agent has to stop for the app to start it.
    PutIn { from: String, to: String },
}

/// One look: asks the board for the newest Mac release, and if this Mac should have it, downloads,
/// checks and stages it, waits for `idle` (asked every half minute, for up to `wait`) and puts it in.
pub fn once(hive: &Path, cloud: &Cloud, idle: &dyn Fn() -> bool, wait: Duration) -> Result<Outcome, String> {
    if node::VERSION == "dev" {
        return Ok(Outcome::Current);
    }
    look(hive, cloud, Some((idle, wait)), false)
}

/// `hive-agent --update`: puts the newest release in now, over a build made by hand too (that's how a
/// Mac set up by hand joins releases, and from then on updates itself) or one this Mac gave up on.
/// Hive runs it from its next start; a release agent running now puts it in again once it's idle.
pub fn now(hive: &Path, cloud: &Cloud) -> Result<Outcome, String> {
    look(hive, cloud, None, false)
}

/// The newest release, over a build made by hand too, once Hive is idle: Hive changing itself puts in
/// the release it just made of its own change (hive-app self_change.rs), so the task that needed it
/// can go on with it. `wait` long at most; the release stays staged if Hive wasn't idle by then.
pub fn put_in_when_idle(hive: &Path, cloud: &Cloud, idle: &dyn Fn() -> bool, wait: Duration) -> Result<Outcome, String> {
    look(hive, cloud, Some((idle, wait)), true)
}

/// `idle` is None to put the release in without waiting; `over_any` puts it in over a build made by
/// hand or one this Mac gave up on.
fn look(hive: &Path, cloud: &Cloud, idle: Option<(&dyn Fn() -> bool, Duration)>, over_any: bool) -> Result<Outcome, String> {
    // A club member's Mac takes the club's releases and reports there (lib.rs Cloud::release_source).
    let cloud = &cloud.release_source();
    let answer = cloud.get("/v1/releases/latest?kind=mac")?;
    let release = &answer["release"];
    let Some(version) = release["version"].as_str().map(str::to_string) else {
        return Ok(Outcome::Current);
    };
    let wanted = match idle {
        Some(_) if !over_any => node::wants_update(Some(&version)) && !gave_up_on(hive, &version),
        _ => version != node::VERSION,
    };
    if !wanted {
        return Ok(Outcome::Current);
    }
    let staged = work_dir(hive).join(&version);
    let checked = staged.join(".checked");
    let unpacked = {
        let bytes = cloud.get_bytes(&format!("/v1/releases/get?kind=mac&version={}", encode(&version)), 600)?;
        let sha = release["sha256"].as_str().unwrap_or("");
        match unpack(&bytes, sha).and_then(|r| if r.version == version { Ok(r) } else { Err(format!("the board's {version} holds {}", r.version)) }) {
            Ok(r) => r,
            Err(why) => {
                give_up(hive, &version);
                report(cloud, &format!("Didn't update to {version}: {why}."));
                return Err(why);
            }
        }
    };
    if !checked.exists() {
        if let Err(why) = stage(hive, &unpacked) {
            give_up(hive, &version);
            report(cloud, &format!("Didn't update to {version}: {why}."));
            return Err(why);
        }
        let _ = std::fs::write(&checked, b"");
    }
    if let Some((idle, wait)) = idle {
        let until = std::time::Instant::now() + wait;
        let mut quiet_twice = false;
        loop {
            if idle() {
                if quiet_twice {
                    break;
                }
                quiet_twice = true;
            } else {
                quiet_twice = false;
            }
            if std::time::Instant::now() >= until {
                return Ok(Outcome::Waiting(version));
            }
            std::thread::sleep(Duration::from_secs(30).min(wait));
        }
    }
    let _ = std::fs::remove_file(&checked);
    apply(hive, &staged, &unpacked, node::VERSION)?;
    let when = if idle.is_some() { "Hive restarts on it now" } else { "Hive runs it from its next start" };
    report(cloud, &format!("Updated from {} to {version}; {when}.", node::VERSION));
    Ok(Outcome::PutIn { from: node::VERSION.to_string(), to: version })
}

/// Starts the updater for an agent Hive.app runs: confirms the release it runs once it has run long
/// enough, then looks for a new one a minute in and every ten minutes after. `idle` says whether Hive
/// is idle; `restart` stops the agent so the app starts the new one (it's told what to say).
pub fn watch(hive: PathBuf, confirm_release: Option<String>, idle: Box<dyn Fn() -> bool + Send>, restart: Box<dyn Fn(&str) + Send>) {
    let _ = std::thread::Builder::new().name("hive-update".into()).spawn(move || {
        if let Some(version) = confirm_release {
            std::thread::sleep(CONFIRM_AFTER);
            confirm(&hive, &version);
        } else {
            std::thread::sleep(Duration::from_secs(60));
        }
        loop {
            // tasks.json is read each time: a Mac connected from the club page meanwhile takes the club's.
            if let Some(cloud) = Cloud::load_release_source() {
                match once(&hive, &cloud, &*idle, Duration::from_secs(3600)) {
                    Ok(Outcome::PutIn { to, .. }) => {
                        restart(&format!("restart to run Hive {to}"));
                        return;
                    }
                    Ok(_) => {}
                    Err(why) => hive_common::say(format!("   ✗ update: {why}")),
                }
            }
            std::thread::sleep(Duration::from_secs(600));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn file(path: &str, mode: u32, data: &str) -> File {
        File { path: path.into(), mode, data: data.as_bytes().to_vec() }
    }

    /// A release as version.mjs packs one.
    fn pack(kind: &str, version: Option<&str>, arch: &str, files: &[File]) -> (Vec<u8>, String) {
        let files_version = files_version(files);
        let body = json!({
            "format": 1, "kind": kind, "version": version.unwrap_or(&files_version), "files_version": files_version,
            "protocol": 1, "arch": arch,
            "files": files.iter().map(|f| json!({ "path": f.path, "mode": f.mode, "data": base64::engine::general_purpose::STANDARD.encode(&f.data) })).collect::<Vec<_>>(),
        });
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(body.to_string().as_bytes()).unwrap();
        let bytes = gz.finish().unwrap();
        let sha = hex(&Sha256::digest(&bytes));
        (bytes, sha)
    }

    #[test]
    fn the_files_hash_is_the_one_version_mjs_makes() {
        // node -e "import('./cloud/vm-agent/version.mjs').then(v => console.log(v.bundleVersion([...])))"
        let files = [file("desktop/app/build/hive-agent", 0o755, "bin"), file("a", 0o644, "x")];
        assert_eq!(files_version(&files), "02b7544e693c");
    }

    #[test]
    fn a_release_from_cloud_release_mjs_unpacks() {
        // cloud/vm-agent/version.mjs pack('mac', ..., { version: 'abcdef123456', arch: 'arm64' })
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mac-release.bin")).unwrap();
        let sha = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mac-release.sha256")).unwrap();
        if arch() != "arm64" {
            assert!(unpack(&bytes, sha.trim()).unwrap_err().contains("built for arm64"));
            return;
        }
        let release = unpack(&bytes, sha.trim()).unwrap();
        assert_eq!(release.version, "abcdef123456");
        let paths: Vec<&str> = release.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["desktop/app/build/hive-agent", "desktop/app/build/dashboard/index.html", "browser/chrome/build/chrome/manifest.json"]);
        assert_eq!(release.files[0].mode, 0o755);
        assert_eq!(release.files[1].data, b"<p>dashboard</p>");
    }

    #[test]
    fn a_release_is_checked_before_anything_is_written() {
        let files = [file("desktop/app/build/hive-agent", 0o755, "bin")];
        let (bytes, sha) = pack("mac", Some("abcdef123456"), arch(), &files);
        assert_eq!(unpack(&bytes, &sha).unwrap().version, "abcdef123456");
        assert!(unpack(&bytes, &"0".repeat(64)).unwrap_err().contains("sha256"));
        let (vm, vm_sha) = pack("vm", None, arch(), &files);
        assert!(unpack(&vm, &vm_sha).unwrap_err().contains("not a Mac's"));
        let (other, other_sha) = pack("mac", Some("abcdef123456"), "sparc", &files);
        assert!(unpack(&other, &other_sha).unwrap_err().contains("built for sparc"));
        for path in ["desktop/app/python/mic.py", "desktop/app/build/../install.sh", "/etc/hosts", "browser/chrome/src/background.js"] {
            let (b, s) = pack("mac", Some("abcdef123456"), arch(), &[file(path, 0o644, "x")]);
            assert!(unpack(&b, &s).unwrap_err().contains("outside Hive's build output"), "{path}");
        }
    }

    fn hive_with_old_build() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (path, text) in [
            ("desktop/app/build/hive-agent", "old agent"),
            ("desktop/app/build/hive-ask", "old ask"),
            ("desktop/app/build/dashboard/index.html", "old dashboard"),
            ("desktop/app/build/dashboard/old.js", "only in the old dashboard"),
            ("browser/chrome/build/chrome/manifest.json", "old manifest"),
            ("desktop/app/python/mic.py", "someone's work"),
        ] {
            std::fs::create_dir_all(root.join(path).parent().unwrap()).unwrap();
            std::fs::write(root.join(path), text).unwrap();
        }
        dir
    }

    fn release_with_agent(version: &str, says: &str) -> Release {
        Release {
            version: version.into(),
            files: vec![
                file("desktop/app/build/hive-agent", 0o755, &format!("#!/bin/sh\necho {says}\n")),
                file("desktop/app/build/dashboard/index.html", 0o644, "new dashboard"),
                file("browser/chrome/build/chrome/manifest.json", 0o644, "new manifest"),
            ],
        }
    }

    fn read(root: &Path, path: &str) -> String {
        std::fs::read_to_string(root.join(path)).unwrap_or_default()
    }

    #[test]
    fn a_release_goes_in_whole_and_comes_back_out_whole() {
        let dir = hive_with_old_build();
        let root = dir.path();
        let release = release_with_agent("abcdef123456", "abcdef123456");
        let staged = stage(root, &release).unwrap();
        apply(root, &staged, &release, "000000000001").unwrap();
        assert!(read(root, "desktop/app/build/hive-agent").contains("echo abcdef123456"));
        assert_eq!(read(root, "desktop/app/build/hive-ask"), "old ask", "a tool the release doesn't hold stays");
        assert_eq!(read(root, "desktop/app/build/dashboard/index.html"), "new dashboard");
        assert!(!root.join("desktop/app/build/dashboard/old.js").exists(), "the dashboard goes in as one folder");
        assert_eq!(read(root, "browser/chrome/build/chrome/manifest.json"), "new manifest");
        assert_eq!(read(root, "desktop/app/python/mic.py"), "someone's work", "source is never touched");
        assert!(!staged.exists());

        // It starts twice without running long enough; the third start puts the old build back.
        assert_eq!(on_start(root, "abcdef123456"), Start::Run { confirm: Some("abcdef123456".into()) });
        assert_eq!(on_start(root, "abcdef123456"), Start::Run { confirm: Some("abcdef123456".into()) });
        let Start::RolledBack(note) = on_start(root, "abcdef123456") else { panic!("expected a roll back") };
        assert!(note.contains("went back to 000000000001"), "{note}");
        assert_eq!(read(root, "desktop/app/build/hive-agent"), "old agent");
        assert_eq!(read(root, "desktop/app/build/dashboard/old.js"), "only in the old dashboard");
        assert_eq!(read(root, "browser/chrome/build/chrome/manifest.json"), "old manifest");
        assert!(gave_up_on(root, "abcdef123456"), "it isn't put in again");
        assert_eq!(on_start(root, "000000000001"), Start::Run { confirm: None });
    }

    #[test]
    fn a_release_that_runs_long_enough_stays() {
        let dir = hive_with_old_build();
        let root = dir.path();
        let release = release_with_agent("abcdef123456", "abcdef123456");
        let staged = stage(root, &release).unwrap();
        apply(root, &staged, &release, "000000000001").unwrap();
        assert_eq!(on_start(root, "abcdef123456"), Start::Run { confirm: Some("abcdef123456".into()) });
        confirm(root, "abcdef123456");
        assert!(!work_dir(root).join("previous").exists(), "the old build is let go");
        for _ in 0..MOST_STARTS + 1 {
            assert_eq!(on_start(root, "abcdef123456"), Start::Run { confirm: None });
        }
        assert!(read(root, "desktop/app/build/hive-agent").contains("abcdef123456"));
    }

    #[test]
    fn a_release_whose_agent_says_another_version_is_never_put_in() {
        let dir = hive_with_old_build();
        let root = dir.path();
        let err = stage(root, &release_with_agent("abcdef123456", "dev")).unwrap_err();
        assert!(err.contains("says it's \"dev\""), "{err}");
        assert_eq!(read(root, "desktop/app/build/hive-agent"), "old agent");
        assert!(!work_dir(root).join("abcdef123456").exists());
    }

    /// A stand-in board serving one Mac release; what it was asked is kept, bodies included.
    fn board(release: (Vec<u8>, String), version: &str) -> (Cloud, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead as _, Read as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (log, version, (bytes, sha)) = (seen.clone(), version.to_string(), release);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let (mut line, mut length) = (String::new(), 0);
                let _ = reader.read_line(&mut line);
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(format!("{path} {}", String::from_utf8_lossy(&body)));
                let answer = if path.starts_with("/v1/releases/latest") {
                    json!({ "release": { "kind": "mac", "version": version, "sha256": sha } }).to_string().into_bytes()
                } else if path.starts_with("/v1/releases/get") {
                    bytes.clone()
                } else {
                    b"{}".to_vec()
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", answer.len());
                let _ = stream.write_all(&answer);
            }
        });
        (Cloud { url, token: "t".into(), machine: "test-mac".into(), releases: None }, seen)
    }

    #[test]
    fn asked_to_it_puts_the_newest_release_in_now_even_over_a_hand_build() {
        if node::VERSION != "dev" {
            return; // built as a release: the hand build this is about isn't this one
        }
        let dir = hive_with_old_build();
        let root = dir.path();
        let files = release_with_agent("abcdef123456", "abcdef123456").files;
        let (cloud, seen) = board(pack("mac", Some("abcdef123456"), arch(), &files), "abcdef123456");
        // By itself, the updater leaves a build made by hand alone, without even asking.
        assert_eq!(once(root, &cloud, &|| true, Duration::ZERO).unwrap(), Outcome::Current);
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(now(root, &cloud).unwrap(), Outcome::PutIn { from: "dev".into(), to: "abcdef123456".into() });
        assert!(read(root, "desktop/app/build/hive-agent").contains("echo abcdef123456"));
        assert_eq!(read(root, "desktop/app/build/dashboard/index.html"), "new dashboard");
        assert_eq!(read(root, "desktop/app/python/mic.py"), "someone's work");
        let seen = seen.lock().unwrap().join("\n");
        assert!(seen.contains("/v1/releases/get?kind=mac&version=abcdef123456"), "{seen}");
        assert!(seen.contains("Updated from dev to abcdef123456; Hive runs it from its next start."), "{seen}");
        // A release that started badly three times went back; asked again, it goes in again.
        assert_eq!(on_start(root, "abcdef123456"), Start::Run { confirm: Some("abcdef123456".into()) });
    }

    #[test]
    fn a_club_members_mac_takes_the_clubs_releases_and_reports_there() {
        if node::VERSION != "dev" {
            return; // built as a release: the hand build this is about isn't this one
        }
        let dir = hive_with_old_build();
        let root = dir.path();
        let files = release_with_agent("abcdef123456", "abcdef123456").files;
        let (club, seen) = board(pack("mac", Some("abcdef123456"), arch(), &files), "abcdef123456");
        // Its own board isn't there at all: everything about releases goes to the club's.
        let config = json!({ "url": "http://127.0.0.1:9/", "token": "own", "machine": "test-mac",
            "releases": { "url": format!("{}/", club.url), "token": format!("club.alice.{}", "a".repeat(64)) } });
        let cloud = Cloud::from_config(&config).unwrap();
        assert_eq!(cloud.url, "http://127.0.0.1:9");
        assert_eq!(cloud.release_source().url, club.url);
        assert_eq!(now(root, &cloud).unwrap(), Outcome::PutIn { from: "dev".into(), to: "abcdef123456".into() });
        let seen = seen.lock().unwrap().join("\n");
        assert!(seen.contains("/v1/releases/get?kind=mac&version=abcdef123456"), "{seen}");
        assert!(seen.contains("Updated from dev to abcdef123456"), "{seen}");
        // Without `releases`, the board itself is where releases come from.
        let plain = Cloud::from_config(&json!({ "url": club.url, "token": "t", "machine": "m" })).unwrap();
        assert_eq!(plain.release_source().url, club.url);
        assert!(Cloud::from_config(&json!({ "url": "", "token": "t" })).is_none());
    }

    #[test]
    fn the_hive_folder_is_three_up_from_the_agent_and_only_there() {
        // A test binary runs from target/, never desktop/app/build: it never updates itself.
        assert_eq!(hive_folder(), None);
    }
}
