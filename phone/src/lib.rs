//! The iPhone as a Hive device. Hive Phone (ios/) on the phone dials in to Hive's server over one WebSocket (link.rs), and
//! Hive's server runs the phone's node itself (`start`), since the phone can't run Hive's code: every computer that's
//! someone's Hive does this the same way.
mod link;
mod phone;

pub use link::{accept, device, Conn};
pub mod bootstrap;

use hive_protocol::{n, s, tool};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn tools() -> Vec<Value> {
    let xy = || json!({ "x": n("x in the latest screenshot"), "y": n("y in the latest screenshot") });
    let mut t = vec![
        tool("phone_unlock", "Unlock the iPhone with its saved passcode (Hive types it; you never see it). If it fails, stop using \
            the phone and say why.", json!({}), &[]),
        tool("phone_screenshot", "See the iPhone's screen. x/y in other phone tools are pixels in this image.", json!({}), &[]),
        tool("phone_tap", "Tap the iPhone at (x, y).", xy(), &["x", "y"]),
        tool("phone_swipe", "Swipe on the iPhone from (x, y) to (to_x, to_y).",
            { let mut p = xy(); p["to_x"] = n("end x"); p["to_y"] = n("end y"); p }, &["x", "y", "to_x", "to_y"]),
        tool("phone_type", "Type into the focused field on the iPhone ('\\n' = Return).", json!({ "text": s("Text") }), &["text"]),
        tool("phone_home", "Go to the iPhone's home screen (unlocked phones only).", json!({}), &[]),
        tool("phone_open_app", "Open an iPhone app by bundle id (e.g. com.apple.mobilesafari).", json!({ "bundle_id": s("Bundle id") }), &["bundle_id"]),
    ];
    for x in &mut t { x["lock"] = json!("touch"); x["timeout"] = json!(180); }
    t
}

/// Runs the phone's node, connected to this computer's Hive at `server` (paired with the owner key the first time).
pub fn start(state: PathBuf, server: String, owner_key: String) {
    std::thread::spawn(move || {
        let conf = loop {
            match hive_protocol::load("phone").filter(|c| c.server == server) {
                Some(c) => break c,
                None => match hive_protocol::pair("phone", &server, &owner_key, "phone", "iPhone") {
                    Ok(c) => break c,
                    Err(_) => std::thread::sleep(std::time::Duration::from_secs(2)),
                },
            }
        };
        let phone = phone::Phone::new(state);
        hive_protocol::run(conf, hive_protocol::Node { kind: "phone", name: "iPhone".into(), package: "hive-server", tools: tools(),
            notes: "The owner's iPhone: phone_* tools. One agent at a time touches it.".into() }, move |t, a| phone.call(t, a))
    });
}

/// For the dashboard: whether Hive Phone is connected and a passcode is saved.
pub fn status(state: &Path) -> Value {
    json!({ "connected": link::connected(), "passcode": state.join(phone::PASSCODE).exists(), "paused": state.join(phone::PAUSED).exists() })
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
