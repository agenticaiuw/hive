//! Chrome's way to the board key Hive wrote (~/.config/hive/extension.json), so the Hive extension in
//! Chrome reaches the cloud with nothing pasted, as Safari's does through Hive.app's own handler
//! (SafariWebExtensionHandler.swift "hive:key").
//!
//! hive-tasks is the native messaging host: Chrome starts it with the extension's origin as its only
//! argument, sends one length-prefixed JSON message on stdin, and reads one back on stdout
//! (browser/chrome/src/cloud-peer.js asks `{"type": "hive:key"}`). `install` registers it under
//! [`HOST`] for each unpacked Hive extension Chrome has, and keeps that up to date on every sync.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The name the extension asks for (cloud-peer.js NATIVE_HOST.chrome).
pub const HOST: &str = "hive.board_key";

/// Whether Chrome started this process as a native messaging host: its first argument is the
/// caller's origin.
pub fn started_by_chrome(args: &[String]) -> bool {
    args.first().is_some_and(|a| a.starts_with("chrome-extension://"))
}

/// The answer to one message: the key and the board's address for "hive:key", else why not.
pub fn answer(message: &Value, key_file: &Path) -> Value {
    if message.get("type").and_then(Value::as_str) != Some("hive:key") {
        return json!({ "ok": false, "error": "Hive only answers hive:key here." });
    }
    let saved = std::fs::read_to_string(key_file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    match saved {
        Some(file) if file.get("key").and_then(Value::as_str).is_some_and(|k| !k.is_empty()) => {
            json!({ "ok": true, "key": file["key"], "url": file.get("url").cloned().unwrap_or(Value::Null) })
        }
        _ => json!({ "ok": false, "error": "Hive on this Mac has no key for the extension yet." }),
    }
}

/// One message in, one answer out, in Chrome's framing (a 32-bit length in native byte order, then
/// the JSON).
pub fn serve(input: &mut impl Read, output: &mut impl Write, key_file: &Path) -> std::io::Result<()> {
    let mut length = [0u8; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_ne_bytes(length) as usize;
    if length > 1 << 20 {
        return Err(std::io::Error::other("message too long"));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    let message = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
    let reply = answer(&message, key_file).to_string();
    output.write_all(&(reply.len() as u32).to_ne_bytes())?;
    output.write_all(reply.as_bytes())?;
    output.flush()
}

/// The ids of the unpacked extensions named "Hive" in any of Chrome's profiles under `chrome_dir`
/// (an unpacked extension's id comes from its folder, so it differs from Mac to Mac).
pub fn hive_extension_ids(chrome_dir: &Path) -> Vec<String> {
    let mut ids = Vec::new();
    let Ok(profiles) = std::fs::read_dir(chrome_dir) else {
        return ids;
    };
    for profile in profiles.flatten() {
        for file in ["Secure Preferences", "Preferences"] {
            let Some(prefs) = std::fs::read_to_string(profile.path().join(file))
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            else {
                continue;
            };
            let Some(settings) = prefs.pointer("/extensions/settings").and_then(Value::as_object) else {
                continue;
            };
            for (id, entry) in settings {
                let Some(folder) = entry.get("path").and_then(Value::as_str) else {
                    continue;
                };
                let named_hive = std::fs::read_to_string(Path::new(folder).join("manifest.json"))
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .is_some_and(|m| m.get("name").and_then(Value::as_str) == Some("Hive"));
                if named_hive && !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
    }
    ids.sort();
    ids
}

/// The host's registration for Chrome: this program, callable only by those extensions.
pub fn manifest(exe: &Path, ids: &[String]) -> Value {
    json!({
        "name": HOST,
        "description": "Hive's key to its cloud board, for the Hive extension",
        "path": exe,
        "type": "stdio",
        "allowed_origins": ids.iter().map(|id| format!("chrome-extension://{id}/")).collect::<Vec<_>>(),
    })
}

/// Registers (or updates) the host in `chrome_dir`/NativeMessagingHosts when Chrome has a Hive
/// extension; whether anything changed.
pub fn install(exe: &Path, chrome_dir: &Path) -> std::io::Result<bool> {
    let ids = hive_extension_ids(chrome_dir);
    if ids.is_empty() {
        return Ok(false);
    }
    let dir = chrome_dir.join("NativeMessagingHosts");
    let path = dir.join(format!("{HOST}.json"));
    let text = format!("{:#}\n", manifest(exe, &ids));
    if std::fs::read_to_string(&path).ok().as_deref() == Some(text.as_str()) {
        return Ok(false);
    }
    std::fs::create_dir_all(&dir)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(true)
}

/// Google Chrome's folder for this user.
pub fn chrome_dir() -> PathBuf {
    hive_common::paths::home().join("Library/Application Support/Google/Chrome")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_the_key_hive_wrote_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("extension.json");
        let ask = json!({ "type": "hive:key" });
        assert_eq!(answer(&ask, &file)["ok"], false, "no key yet");
        std::fs::write(&file, r#"{"url":"https://board.test","key":"ext.mac-browser.abc"}"#).unwrap();
        assert_eq!(answer(&ask, &file), json!({ "ok": true, "key": "ext.mac-browser.abc", "url": "https://board.test" }));
        assert_eq!(answer(&json!({ "type": "other" }), &file)["ok"], false);
    }

    #[test]
    fn speaks_chromes_framing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("extension.json");
        std::fs::write(&file, r#"{"url":"https://board.test","key":"k"}"#).unwrap();
        let ask = br#"{"type":"hive:key"}"#;
        let mut input = (ask.len() as u32).to_ne_bytes().to_vec();
        input.extend_from_slice(ask);
        let mut output = Vec::new();
        serve(&mut input.as_slice(), &mut output, &file).unwrap();
        let length = u32::from_ne_bytes(output[..4].try_into().unwrap()) as usize;
        assert_eq!(length, output.len() - 4);
        let reply: Value = serde_json::from_slice(&output[4..]).unwrap();
        assert_eq!(reply["key"], "k");
    }

    #[test]
    fn registers_for_the_unpacked_hive_extensions_chrome_has() {
        let chrome = tempfile::tempdir().unwrap();
        let hive = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(hive.path().join("manifest.json"), r#"{"name":"Hive"}"#).unwrap();
        std::fs::write(other.path().join("manifest.json"), r#"{"name":"Something else"}"#).unwrap();
        let exe = Path::new("/bin/hive-tasks");
        assert!(!install(exe, chrome.path()).unwrap(), "no Chrome profile: nothing registered");
        std::fs::create_dir(chrome.path().join("Default")).unwrap();
        let prefs = json!({ "extensions": { "settings": {
            "hiveid": { "path": hive.path(), "location": 4 },
            "otherid": { "path": other.path(), "location": 4 },
            "storeid": { "location": 1 },
        } } });
        std::fs::write(chrome.path().join("Default/Secure Preferences"), prefs.to_string()).unwrap();
        assert_eq!(hive_extension_ids(chrome.path()), vec!["hiveid".to_string()]);
        assert!(install(exe, chrome.path()).unwrap());
        assert!(!install(exe, chrome.path()).unwrap(), "unchanged: not written again");
        let written: Value = serde_json::from_str(
            &std::fs::read_to_string(chrome.path().join("NativeMessagingHosts/hive.board_key.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(written["path"], "/bin/hive-tasks");
        assert_eq!(written["allowed_origins"], json!(["chrome-extension://hiveid/"]));
        assert!(started_by_chrome(&["chrome-extension://hiveid/".into()]));
        assert!(!started_by_chrome(&["sync".into()]));
    }
}
