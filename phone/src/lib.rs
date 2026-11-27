//! The iPhone as a Hive device. Hive Phone (ios/) on the phone dials in to Hive's server over one WebSocket (link.rs), and
//! Hive's server runs the phone's node itself (`start`), since the phone can't run Hive's code: every computer that's
//! someone's Hive does this the same way.
mod link;
mod phone;

pub use link::{accept, connected, device};
pub mod bootstrap;

use hive_protocol::{n, s, tool};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Where phone.yml publishes each signed Hive for iPhone: Hive.ipa, the manifest.plist iOS installs it from, and phone.json,
/// read here. GitHub Pages, since a release download redirects to a short-lived signed address, which iOS's installer isn't
/// known to follow.
pub const SITE: &str = "https://agenticaiuw.github.io/hive";
/// Where the owner adds an iPhone to that build: phone.yml's "Run workflow", given the iPhone's UDID.
pub const REGISTER: &str = "https://github.com/agenticaiuw/hive/actions/workflows/phone.yml";

fn tools() -> Vec<Value> {
    let mut t = vec![
        tool("phone_unlock", "Unlock the iPhone with its saved passcode (Hive types it; you never see it). If it fails, stop using \
            the phone and say why.", json!({}), &[]),
        tool("phone_screenshot", "See the iPhone's screen. x/y in phone_input are pixels in this image.", json!({}), &[]),
        tool("phone_input", "Interact with the iPhone screen: action=tap(x,y), swipe(x,y,to_x,to_y), type(text; '\\n'=Return), or home (unlocked only). Returns a fresh screenshot.",
            json!({ "action": s("tap, swipe, type, or home"), "x": n("x in the latest screenshot (tap/swipe)"),
                "y": n("y in the latest screenshot (tap/swipe)"), "to_x": n("end x (swipe)"), "to_y": n("end y (swipe)"),
                "text": s("Text to type (type)") }), &["action"]),
        tool("phone_open_app", "Open an iPhone app by bundle id (e.g. com.apple.mobilesafari).", json!({ "bundle_id": s("Bundle id") }), &["bundle_id"]),
    ];
    for x in &mut t { x["lock"] = json!("touch"); x["timeout"] = json!(180); }
    t
}

/// Runs the phone's node, connected to this computer's Hive with the token the server gave it (`conf`).
pub fn start(state: PathBuf, conf: hive_protocol::Conf) {
    std::thread::spawn(move || {
        let phone = phone::Phone::new(state);
        hive_protocol::run(conf, hive_protocol::Node { kind: "phone", name: "iPhone".into(), package: "hive-server", tools: tools(),
            notes: "The owner's iPhone: phone_* tools. One agent at a time touches it.".into() }, move |t, a| phone.call(t, a))
    });
}

/// How phone.json lists an iPhone: the SHA-256 of its UDID (upper case, without dashes), so the public file names no device.
pub fn listing(udid: &str) -> String {
    let u = udid.trim().replace('-', "").to_ascii_uppercase();
    ring::digest::digest(&ring::digest::SHA256, u.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// The newest signed Hive for iPhone: phone.json, {version, install, devices (each a `listing`)}, asked for at most every
/// ten minutes; Null while there's none.
fn release() -> Value {
    static LAST: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap();
    if let Some((_, v)) = last.as_ref().filter(|(at, _)| at.elapsed() < Duration::from_secs(600)) { return v.clone(); }
    let v = ureq::get(&format!("{SITE}/phone.json")).timeout(Duration::from_secs(20)).call().ok()
        .and_then(|r| r.into_string().ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    *last = Some((Instant::now(), v.clone()));
    v
}

/// The install link for the newest build, if the phone's Hive (its X-Hive-Version) is older; never for a build of its own.
pub fn update(version: &str, build: u64) -> Option<String> {
    if version.len() < 7 { return None; }
    published_update(&release(), version, build)
}

fn published_update(r: &Value, version: &str, build: u64) -> Option<String> {
    if version.len() < 7 { return None; }
    if build > 0 && r["build"].as_u64().unwrap_or(0) <= build { return None; }
    let (want, link) = (r["version"].as_str()?, r["install"].as_str()?);
    (want.len() >= 7 && !want.starts_with(version) && !version.starts_with(want)).then(|| link.to_string())
}

/// An iPhone plugged into the owner's Mac: the Hive app there asks for its pairing identity by its UDID (desktop/src/phone_setup.rs).
pub fn seen(state: &Path, udid: &str) {
    let file = state.join("iphones");
    let known = std::fs::read_to_string(&file).unwrap_or_default();
    if bootstrap::valid(udid) && !known.lines().any(|l| l == udid) { std::fs::write(&file, format!("{known}{udid}\n")).ok(); }
}

/// For the dashboard: whether Hive Phone is connected and a passcode is saved, and the iPhones plugged into the owner's Mac
/// that the newest signed build doesn't list yet, with where to add them and the link that installs it.
pub fn status(state: &Path) -> Value {
    let r = release();
    let listed = r["devices"].as_array().cloned().unwrap_or_default();
    let known = std::fs::read_to_string(state.join("iphones")).unwrap_or_default();
    let unregistered: Vec<&str> = known.lines().filter(|u| !listed.contains(&json!(listing(u)))).collect();
    json!({ "connected": link::connected(), "passcode": state.join(phone::PASSCODE).exists(), "paused": state.join(phone::PAUSED).exists(),
        "unregistered": unregistered, "register": REGISTER, "install": r["install"] })
}

/// The owner saves the iPhone's passcode (tied to the connected iPhone) so Hive can type it at the lock screen; empty forgets it.
pub fn save_passcode(state: &Path, passcode: &str) -> Result<(), String> {
    std::fs::remove_file(state.join(phone::PAUSED)).ok();
    if passcode.is_empty() { std::fs::remove_file(state.join(phone::PASSCODE)).ok(); return Ok(()); }
    if !(4..=32).contains(&passcode.len()) || !passcode.bytes().all(|b| (b'!'..=b'~').contains(&b)) { return Err("That isn't a passcode.".into()); }
    let device = phone::wda("/wda/device/info", "GET", None, 30)
        .map_err(|_| "Open Hive Phone on the iPhone first: the passcode is tied to that iPhone, so it's saved while the phone is connected.")?;
    let file = state.join(phone::PASSCODE);
    std::fs::write(&file, json!({ "device": device["value"]["uuid"], "passcode": passcode }).to_string()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).ok(); }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn updates_only_to_a_newer_published_build() {
        let release = serde_json::json!({"version":"abcdef123456", "build":20, "install":"itms-services://install"});
        assert!(super::published_update(&release, "123456abcdef", 19).is_some());
        assert!(super::published_update(&release, "123456abcdef", 20).is_none());
        assert!(super::published_update(&release, "123456abcdef", 21).is_none());
        assert!(super::published_update(&release, "abcdef123456", 19).is_none());
        let legacy = serde_json::json!({"version":"abcdef123456", "install":"itms-services://install"});
        assert!(super::published_update(&legacy, "123456abcdef", 21).is_none());
        assert!(super::published_update(&release, "123456abcdef", 0).is_some());
    }
    #[test]
    fn lists_an_iphone_the_same_however_its_udid_is_written() {
        assert_eq!(super::listing("00008110-001a2b3c00000000"), super::listing("00008110001A2B3C00000000 "));
        assert_eq!(super::listing("x").len(), 64);
    }
    #[test]
    fn remembers_each_iphone_once() {
        let root = std::env::temp_dir().join(format!("hive-iphones-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for u in ["00008110-001A2B3C00000000", "00008110-001A2B3C00000000", "../nope"] { super::seen(&root, u); }
        assert_eq!(std::fs::read_to_string(root.join("iphones")).unwrap(), "00008110-001A2B3C00000000\n");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn consolidated_phone_tools() {
        let names: Vec<String> = super::tools().into_iter().filter_map(|t| t["name"].as_str().map(String::from)).collect();
        assert_eq!(names, vec!["phone_unlock", "phone_screenshot", "phone_input", "phone_open_app"]);
    }
}
