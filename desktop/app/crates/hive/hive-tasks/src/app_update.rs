//! Hive.app itself on a club member's Mac: the app, its helpers and the Safari extension inside it
//! (the owner, 2026-11-20: "how would all the club members receive all the updates like in safari
//! extension, chrome extension, mac and windows app, ..."). update.rs puts in the agent, its tools and
//! the Chrome extension; the app around them changes only with a new download, so this takes the
//! club's newest download by itself.
//!
//! The club page's Get Hive for Mac is the notarized Hive.dmg tools/release.sh builds and `node
//! cloud/release.mjs download` publishes (cloud/tasks/club.js /v1/club/download/mac). A downloaded
//! Hive.app runs its agent with HIVE_APP (its own path), and once the Mac is connected to the club
//! (club.rs) the updater looks now and then:
//! 1. GET /v1/club/download/mac/about names the newest download's release. An app that carries that
//!    one (Contents/Resources/hive/VERSION), or one this Mac gave up on, stays.
//! 2. It downloads Hive.dmg, copies its Hive.app beside the running one (`.Hive.app.update`, so it goes
//!    in by rename) and checks it: a valid signature (codesign --verify --deep --strict) by the same
//!    developer with the same bundle identifier as the running app, accepted by Gatekeeper (notarized),
//!    carrying the release the board named. One that fails is removed, given up on and said on the
//!    board.
//! 3. Once Hive is idle (update::wait_for_idle, as for a release), the running app goes aside, the new
//!    one takes its place and the old one is removed; Hive.app reopens itself ("@@ relaunch"). Its
//!    first-open.sh puts in the agent and tools it carries when they're new to this Mac, and update.rs
//!    takes any newer release after that.
//! The owner's Mac runs the Hive.app built in the clone, not a download, so it never does this.

use crate::{update, Cloud};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Hive.dmg is about 160 MB; anything past this isn't Hive.
const MOST_BYTES: u64 = 1 << 30;

/// What one look for a newer Hive.app came to.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Nothing to do: no download, the one this app carries, or one given up on.
    Current,
    /// A newer app is checked and waits beside this one for Hive to be idle.
    Waiting(String),
    /// It's in place: Hive.app has to reopen to run it.
    PutIn { from: String, to: String },
}

/// The release an app carries (the first word of Contents/Resources/hive/VERSION), or None for one
/// that carries none (built in a clone).
pub fn carried(app: &Path) -> Option<String> {
    let text = std::fs::read_to_string(app.join("Contents/Resources/hive/VERSION")).ok()?;
    text.split_whitespace().next().map(str::to_string)
}

/// Where the newer app is laid out: beside the running one, so it goes in by rename.
pub fn staged_path(app: &Path) -> PathBuf {
    beside(app, "update")
}

fn beside(app: &Path, what: &str) -> PathBuf {
    let name = app.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Hive.app".into());
    app.with_file_name(format!(".{name}.{what}"))
}

/// The downloads this Mac gave up on, in `<hive>/.app-update.json` (outside the build first-open.sh
/// replaces).
fn state_path(hive: &Path) -> PathBuf {
    hive.join(".app-update.json")
}

pub fn gave_up_on(hive: &Path, version: &str) -> bool {
    let state: Value = std::fs::read_to_string(state_path(hive)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    state["gave_up"].as_array().is_some_and(|v| v.iter().any(|x| x == version))
}

fn give_up(hive: &Path, version: &str) {
    let path = state_path(hive);
    let mut state: Value = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let mut list = state["gave_up"].as_array().cloned().unwrap_or_default();
    if !list.iter().any(|x| x == version) {
        list.push(json!(version));
    }
    let keep = list.len().saturating_sub(20);
    state["gave_up"] = Value::Array(list.split_off(keep));
    let _ = std::fs::write(&path, serde_json::to_vec_pretty(&state).unwrap_or_default());
}

/// One look (the module's 1–3) for the app at `app` in the Hive folder `hive`, taking the club's
/// download from `cloud`'s release source. `idle` is asked every half minute for up to `wait`.
pub fn once(hive: &Path, app: &Path, cloud: &Cloud, idle: &dyn Fn() -> bool, wait: Duration) -> Result<Outcome, String> {
    let cloud = &cloud.release_source();
    let Some(running) = carried(app) else { return Ok(Outcome::Current) };
    if !cloud.is_club() {
        return Ok(Outcome::Current);
    }
    let answer = cloud.get("/v1/club/download/mac/about")?;
    let Some(version) = answer["download"]["version"].as_str().filter(|v| release_like(v)).map(str::to_string) else {
        return Ok(Outcome::Current);
    };
    if version == running || gave_up_on(hive, &version) {
        return Ok(Outcome::Current);
    }
    let staged = staged_path(app);
    let refuse = |why: String| {
        let _ = update::remove(&staged);
        give_up(hive, &version);
        update::report(cloud, &format!("Didn't update Hive.app to {version}: {why}."));
        Err(why)
    };
    if !replaceable(app) {
        return refuse(format!("{} is somewhere this Mac's user can't change (move Hive.app to Applications)", app.display()));
    }
    if carried(&staged).as_deref() != Some(version.as_str()) {
        let _ = update::remove(&staged);
        let folder = std::env::temp_dir().join(format!("hive-app-update-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&folder);
        let dmg = folder.join("Hive.dmg");
        // The network failing is tried again at the next look; what came failing isn't.
        let downloaded = cloud.get_file("/v1/club/download/mac", &dmg, 1800, MOST_BYTES);
        let copied = downloaded.as_ref().map_err(String::clone).map(|_| copy_out(&dmg, &staged));
        let _ = std::fs::remove_dir_all(&folder);
        match copied {
            Err(why) => return Err(format!("Hive.dmg didn't download: {why}")),
            Ok(Err(why)) => return refuse(why),
            Ok(Ok(())) => {}
        }
    }
    // Checked each time, also when it waited from an earlier look.
    if let Err(why) = check(&staged, app, &version) {
        return refuse(why);
    }
    if !update::wait_for_idle(idle, wait) {
        return Ok(Outcome::Waiting(version));
    }
    swap(app, &staged)?;
    update::report(cloud, &format!("Updated Hive.app from {running} to {version}; it reopens now."));
    Ok(Outcome::PutIn { from: running, to: version })
}

fn release_like(v: &str) -> bool {
    (7..=40).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Whether this Mac's user can put another app in `app`'s place: not one opened from the disk image
/// or from where macOS moved a downloaded app to run it (App Translocation), both read-only.
fn replaceable(app: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt as _;
    let writable = |p: &Path| {
        let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return false };
        // SAFETY: access reads the NUL-terminated path and nothing else.
        unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
    };
    app.parent().is_some_and(writable) && writable(app) && !app.to_string_lossy().contains("/AppTranslocation/")
}

/// The Hive.app in the disk image at `dmg`, copied (signature and all) to `to`.
fn copy_out(dmg: &Path, to: &Path) -> Result<(), String> {
    let mount = dmg.with_extension("mount");
    std::fs::create_dir_all(&mount).map_err(|e| format!("{}: {e}", mount.display()))?;
    let attached = Command::new("/usr/bin/hdiutil")
        .args(["attach", "-quiet", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"])
        .arg(&mount)
        .arg(dmg)
        .output()
        .map_err(|e| format!("hdiutil: {e}"))?;
    if !attached.status.success() {
        return Err(format!("Hive.dmg didn't open ({})", last_line(&attached.stderr)));
    }
    let inside = mount.join("Hive.app");
    let copied = if inside.is_dir() {
        Command::new("/usr/bin/ditto").arg(&inside).arg(to).output().map_err(|e| format!("ditto: {e}"))
    } else {
        Err("Hive.dmg holds no Hive.app".into())
    };
    let _ = Command::new("/usr/bin/hdiutil").args(["detach", "-quiet", "-force"]).arg(&mount).output();
    let _ = std::fs::remove_dir(&mount);
    let copied = copied?;
    if !copied.status.success() {
        return Err(format!("Hive.app didn't copy out of Hive.dmg ({})", last_line(&copied.stderr)));
    }
    Ok(())
}

/// Whether the app at `new` may take the place of the one at `running`: it carries `version`, its
/// signature checks out, it's signed by the same developer with the same identifier, and Gatekeeper
/// accepts it (it's notarized).
pub fn check(new: &Path, running: &Path, version: &str) -> Result<(), String> {
    if carried(new).as_deref() != Some(version) {
        return Err(format!("the board named {version}, but its Hive.app carries {}", carried(new).as_deref().unwrap_or("none")));
    }
    let verified = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(new)
        .output()
        .map_err(|e| format!("codesign: {e}"))?;
    if !verified.status.success() {
        return Err(format!("its signature doesn't check out ({})", last_line(&verified.stderr)));
    }
    let (Some(signed), Some(ours)) = (signer(new), signer(running)) else {
        return Err("it, or the running Hive.app, has no developer's signature".into());
    };
    if signed != ours {
        return Err("it isn't signed by the running Hive.app's developer as the same app".into());
    }
    let assessed = Command::new("/usr/sbin/spctl")
        .args(["--assess", "--type", "execute"])
        .arg(new)
        .output()
        .map_err(|e| format!("spctl: {e}"))?;
    if !assessed.status.success() {
        return Err(format!("Gatekeeper doesn't accept it ({})", last_line(&assessed.stderr)));
    }
    Ok(())
}

/// Who signed the app at `path` as what: codesign's Identifier and TeamIdentifier, None without a
/// developer's (an ad-hoc or missing signature).
fn signer(path: &Path) -> Option<(String, String)> {
    let shown = Command::new("/usr/bin/codesign").arg("-dv").arg(path).output().ok()?;
    let text = String::from_utf8_lossy(&shown.stderr);
    let field = |name: &str| text.lines().find_map(|l| l.strip_prefix(name)).map(|v| v.trim().to_string());
    let identifier = field("Identifier=")?;
    let team = field("TeamIdentifier=").filter(|t| !t.is_empty() && t != "not set")?;
    Some((identifier, team))
}

fn last_line(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no reason given").trim().to_string()
}

/// The app at `staged` takes the place of the one at `app`, which goes aside and is removed; if it
/// can't, the running app stays where it was.
pub fn swap(app: &Path, staged: &Path) -> Result<(), String> {
    let previous = beside(app, "previous");
    let _ = update::remove(&previous);
    std::fs::rename(app, &previous).map_err(|e| format!("Couldn't move {} aside: {e}", app.display()))?;
    if let Err(e) = std::fs::rename(staged, app) {
        let _ = std::fs::rename(&previous, app);
        return Err(format!("Couldn't put the new Hive.app in place: {e}"));
    }
    let _ = update::remove(&previous);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::{Arc, Mutex};

    /// An app folder carrying `version`.
    fn app_at(path: &Path, version: &str, marker: &str) {
        std::fs::create_dir_all(path.join("Contents/Resources/hive")).unwrap();
        std::fs::write(path.join("Contents/Resources/hive/VERSION"), format!("{version} 0123456789ab\n")).unwrap();
        std::fs::write(path.join("Contents/marker"), marker).unwrap();
    }

    /// A stand-in club board: `about` at /v1/club/download/mac/about, `dmg` at /v1/club/download/mac;
    /// every path asked is kept.
    fn board(about: Value, dmg: Vec<u8>) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::BufRead as _;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let mut length = 0usize;
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
                let _ = std::io::Read::read_exact(&mut reader, &mut body);
                let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(format!("{path} {}", String::from_utf8_lossy(&body)));
                let answer: Vec<u8> = match path.as_str() {
                    "/v1/club/download/mac/about" => json!({ "download": about }).to_string().into_bytes(),
                    "/v1/club/download/mac" => dmg.clone(),
                    _ => b"{}".to_vec(),
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", answer.len());
                let _ = stream.write_all(&answer);
            }
        });
        (url, seen)
    }

    fn club(url: &str) -> Cloud {
        Cloud::release_source_of(&json!({ "releases": { "url": url, "token": format!("club.alice.{}", "a".repeat(64)) }, "machine": "alices-mac" })).unwrap()
    }

    #[test]
    fn an_app_carrying_the_clubs_newest_download_or_one_given_up_on_stays() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("Applications/Hive.app");
        app_at(&app, "b40fdeb43958", "old");
        let (url, seen) = board(json!({ "version": "b40fdeb43958", "size": 1 }), vec![]);
        let idle = || true;
        assert_eq!(once(dir.path(), &app, &club(&url), &idle, Duration::ZERO).unwrap(), Outcome::Current);
        give_up(dir.path(), "c0ffee123456");
        let (url2, seen2) = board(json!({ "version": "c0ffee123456" }), vec![]);
        assert_eq!(once(dir.path(), &app, &club(&url2), &idle, Duration::ZERO).unwrap(), Outcome::Current);
        let (url3, seen3) = board(Value::Null, vec![]);
        assert_eq!(once(dir.path(), &app, &club(&url3), &idle, Duration::ZERO).unwrap(), Outcome::Current);
        // Nothing was downloaded: each only asked what the newest download is.
        for seen in [seen, seen2, seen3] {
            assert_eq!(seen.lock().unwrap().iter().map(|s| s.trim().to_string()).collect::<Vec<_>>(), ["/v1/club/download/mac/about"]);
        }
        assert_eq!(std::fs::read_to_string(app.join("Contents/marker")).unwrap(), "old");
    }

    #[test]
    fn a_mac_on_a_board_of_its_own_or_an_app_built_in_a_clone_never_looks() {
        let dir = tempfile::tempdir().unwrap();
        let (url, seen) = board(json!({ "version": "c0ffee123456" }), vec![]);
        let app = dir.path().join("Hive.app");
        app_at(&app, "b40fdeb43958", "old");
        let own = Cloud::from_config(&json!({ "url": url, "token": "machine-token", "machine": "m" })).unwrap();
        assert_eq!(once(dir.path(), &app, &own, &|| true, Duration::ZERO).unwrap(), Outcome::Current);
        let built = dir.path().join("Agent.app");
        std::fs::create_dir_all(&built).unwrap();
        assert_eq!(once(dir.path(), &built, &club(&url), &|| true, Duration::ZERO).unwrap(), Outcome::Current);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_download_that_isnt_a_signed_hive_is_given_up_on_and_the_running_app_stays() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("Applications/Hive.app");
        app_at(&app, "b40fdeb43958", "old");
        // Not a disk image at all.
        let (url, seen) = board(json!({ "version": "c0ffee123456" }), b"not a disk image".to_vec());
        let why = once(dir.path(), &app, &club(&url), &|| true, Duration::ZERO).unwrap_err();
        assert!(why.contains("Hive.dmg didn't open"), "{why}");
        assert!(gave_up_on(dir.path(), "c0ffee123456"));
        assert!(!staged_path(&app).exists());
        assert_eq!(std::fs::read_to_string(app.join("Contents/marker")).unwrap(), "old");
        let seen = seen.lock().unwrap().join("\n");
        assert!(seen.contains("/v1/club/download/mac ") && seen.contains("Didn't update Hive.app to c0ffee123456: Hive.dmg didn't open"), "{seen}");
        // An unsigned app carrying the right release is refused for its signature.
        let new = dir.path().join("new/Hive.app");
        app_at(&new, "c0ffee123456", "new");
        assert!(check(&new, &app, "c0ffee123456").unwrap_err().contains("signature"));
        assert!(check(&new, &app, "d00d00123456").unwrap_err().contains("carries c0ffee123456"));
    }

    #[test]
    fn the_new_app_takes_the_old_ones_place_whole() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("Hive.app");
        app_at(&app, "b40fdeb43958", "old");
        std::fs::write(app.join("Contents/only-in-old"), "x").unwrap();
        let staged = staged_path(&app);
        assert_eq!(staged, dir.path().join(".Hive.app.update"));
        app_at(&staged, "c0ffee123456", "new");
        swap(&app, &staged).unwrap();
        assert_eq!(carried(&app).as_deref(), Some("c0ffee123456"));
        assert!(!app.join("Contents/only-in-old").exists());
        assert!(!staged.exists() && !dir.path().join(".Hive.app.previous").exists());
        // Nothing staged: the running app stays where it was.
        assert!(swap(&app, &staged).is_err());
        assert_eq!(std::fs::read_to_string(app.join("Contents/marker")).unwrap(), "new");
    }

    /// The real thing: HIVE_TEST_APP is a downloaded Hive.app (as a member's Mac runs it) and
    /// HIVE_TEST_DMG a newer notarized Hive.dmg tools/release.sh made; the app is copied, so neither
    /// changes. `cargo test -p hive-tasks app_update -- --ignored`
    #[test]
    #[ignore]
    fn a_members_hive_app_takes_the_clubs_newer_notarized_download() {
        let (Some(running), Some(dmg)) = (std::env::var_os("HIVE_TEST_APP"), std::env::var_os("HIVE_TEST_DMG")) else {
            panic!("set HIVE_TEST_APP and HIVE_TEST_DMG");
        };
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("Hive.app");
        assert!(Command::new("/usr/bin/ditto").arg(&running).arg(&app).status().unwrap().success());
        let from = carried(&app).unwrap();
        let bytes = std::fs::read(&dmg).unwrap();
        let mount = dir.path().join("look");
        std::fs::create_dir_all(&mount).unwrap();
        assert!(Command::new("/usr/bin/hdiutil").args(["attach", "-quiet", "-nobrowse", "-readonly", "-mountpoint"]).arg(&mount).arg(&dmg).status().unwrap().success());
        let to = carried(&mount.join("Hive.app")).unwrap();
        let _ = Command::new("/usr/bin/hdiutil").args(["detach", "-quiet"]).arg(&mount).status();
        assert_ne!(from, to, "the disk image carries the app's own release");
        let (url, seen) = board(json!({ "version": to, "size": bytes.len() }), bytes);
        let quiet = std::cell::Cell::new(0);
        // Not idle at first: it waits with the new app checked beside the old one.
        let busy = || false;
        assert_eq!(once(dir.path(), &app, &club(&url), &busy, Duration::ZERO).unwrap(), Outcome::Waiting(to.clone()));
        assert_eq!(carried(&staged_path(&app)), Some(to.clone()));
        assert_eq!(carried(&app), Some(from.clone()));
        let idle = || {
            quiet.set(quiet.get() + 1);
            true
        };
        assert_eq!(once(dir.path(), &app, &club(&url), &idle, Duration::from_secs(60)).unwrap(), Outcome::PutIn { from: from.clone(), to: to.clone() });
        assert_eq!(carried(&app), Some(to.clone()));
        check(&app, &PathBuf::from(&running), &to).unwrap();
        assert!(!staged_path(&app).exists());
        let seen = seen.lock().unwrap();
        // Downloaded once: the second look found it checked and waiting.
        assert_eq!(seen.iter().filter(|s| s.starts_with("/v1/club/download/mac ")).count(), 1);
        assert!(seen.iter().any(|s| s.contains(&format!("Updated Hive.app from {from} to {to}"))));
    }
}
