//! A club member's Mac joins the club's releases (cloud/tasks/club.js), so it runs the same Hive as
//! every other member's devices (the owner, 2026-11-20: "how would all the club members receive all
//! the updates like in ... mac and windows app").
//!
//! The member chooses Connect this Mac on the club page, which asks the board for a one-use code and
//! opens `hive://club/connect?board=<board>&code=<code>`. Hive.app asks the member whether to take
//! Hive's updates from that board, then runs `hive-agent --join-club <board> <code>`: `join` trades the
//! code for a key of this Mac's own (POST /v1/club/devices/connect, once, within ten minutes) and
//! writes it in tasks.json as `releases` (lib.rs Cloud), keeping everything else there. The updater
//! (update.rs) takes the club's releases from then on, and the Mac shows on the club page as soon as
//! it has said hello with its new key.

use crate::Cloud;
use serde_json::{json, Map, Value};
use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

/// What joining came to: whose Mac this now is, and where it takes Hive's releases from.
#[derive(Debug, PartialEq)]
pub struct Joined {
    pub member: String,
    pub board: String,
}

/// Trades `code` for this Mac's key at `board` and writes it in the tasks.json at `config`
/// (Cloud::config_path) as `releases`, keeping what else is there; `device` names this Mac to the club.
pub fn join(config: &Path, board: &str, code: &str, device: &str) -> Result<Joined, String> {
    let board = board_url(board)?;
    if code.len() != 32 || !code.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("That link isn't a club connect link: open Connect this Mac on the club page again.".into());
    }
    let answer = ureq::post(&format!("{board}/v1/club/devices/connect"))
        .set("user-agent", "hive-tasks")
        .timeout(Duration::from_secs(20))
        .send_json(json!({ "code": code, "device": device }));
    let value: Value = match answer {
        Ok(r) => r.into_json().map_err(|e| format!("The club's board answered something else: {e}"))?,
        Err(ureq::Error::Status(status, r)) => {
            let said: Value = r.into_json().unwrap_or(Value::Null);
            return Err(said["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("The club's board said no ({status}).")));
        }
        Err(e) => return Err(format!("Couldn't reach the club's board: {e}")),
    };
    let member = value["name"].as_str().unwrap_or_default().to_string();
    let key = value["key"].as_str().unwrap_or_default();
    let valid_name = !member.is_empty() && member.len() <= 40 && member.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    let secret = key.strip_prefix(&format!("club.{member}.")).unwrap_or_default();
    if !valid_name || secret.len() != 64 || !secret.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("The club's board answered without a key for this Mac.".into());
    }
    // The board the member said yes to, not one its answer names.
    let mut settings = match std::fs::read_to_string(config) {
        Ok(text) => serde_json::from_str::<Value>(&text).map_err(|e| format!("{} isn't JSON ({e}), so it was left as it is.", config.display()))?,
        Err(_) => Value::Object(Map::new()),
    };
    let Some(fields) = settings.as_object_mut() else {
        return Err(format!("{} isn't a JSON object, so it was left as it is.", config.display()));
    };
    fields.insert("releases".into(), json!({ "url": board, "token": key }));
    write_private(config, &serde_json::to_string_pretty(&settings).unwrap_or_default())?;
    // Saying hello with the new key shows this Mac on the club page now, not at the updater's next look.
    if let Some(source) = Cloud::release_source_of(&settings) {
        let _ = source.get("/v1/releases/latest?kind=mac");
    }
    Ok(Joined { member, board })
}

/// The board's address, `https://host[:port]` (or a loopback `http://` one, for a board on this Mac),
/// without a path: whatever else a link says isn't a board this Mac takes code from.
fn board_url(board: &str) -> Result<String, String> {
    let board = board.trim().trim_end_matches('/');
    let host = board.strip_prefix("https://").or_else(|| {
        board.strip_prefix("http://").filter(|h| h.starts_with("127.0.0.1:") || h.starts_with("localhost:") || *h == "localhost")
    });
    let fine = host.is_some_and(|h| {
        let (name, port) = h.split_once(':').unwrap_or((h, ""));
        !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && port.bytes().all(|b| b.is_ascii_digit())
            && (port.is_empty() == !h.contains(':'))
    });
    if !fine {
        return Err(format!("“{board}” isn't a Hive board's address, so this Mac didn't connect to it."));
    }
    Ok(board.to_string())
}

/// `text` as the file at `path`, readable only by this Mac's user, written whole or not at all.
fn write_private(path: &Path, text: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt as _;
    let failed = |e: std::io::Error| format!("Couldn't write {}: {e}", path.display());
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(failed)?;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&temporary).map_err(failed)?;
    file.write_all(text.as_bytes()).and_then(|_| file.write_all(b"\n")).and_then(|_| file.sync_all()).map_err(failed)?;
    std::fs::rename(&temporary, path).map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A stand-in club board: the connect route answers `connect` (status, body) once; every call is kept.
    fn board(connect: (u16, Value)) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::{BufRead as _, Read as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let (mut line, mut length, mut auth) = (String::new(), 0, String::new());
                let _ = reader.read_line(&mut line);
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                        break;
                    }
                    let lower = header.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("authorization:") {
                        auth = header.trim().to_string();
                    }
                }
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(format!("{path} {auth} {}", String::from_utf8_lossy(&body)));
                let (status, answer) = if path == "/v1/club/devices/connect" { connect.clone() } else { (200, json!({ "release": null })) };
                let answer = answer.to_string();
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}", answer.len());
            }
        });
        (url, seen)
    }

    const CODE: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn a_connect_code_becomes_this_macs_release_key_and_the_rest_of_tasks_json_stays() {
        let key = format!("club.alice.{}", "b".repeat(64));
        let (url, seen) = board((200, json!({ "name": "alice", "key": key, "board": "https://elsewhere.example" })));
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("hive/tasks.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, r#"{"url": "https://own.example", "token": "own", "machine": "alices-mac"}"#).unwrap();
        let joined = join(&config, &format!("{url}/"), CODE, "alices-mac").unwrap();
        assert_eq!(joined, Joined { member: "alice".into(), board: url.clone() });
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        // The board the member said yes to, not the one the answer named; everything else as it was.
        assert_eq!(saved, json!({ "url": "https://own.example", "token": "own", "machine": "alices-mac", "releases": { "url": url, "token": key } }));
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(std::fs::metadata(&config).unwrap().permissions().mode() & 0o777, 0o600);
        let seen = seen.lock().unwrap().join("\n");
        assert!(seen.contains(&format!("/v1/club/devices/connect  {{\"code\":\"{CODE}\",\"device\":\"alices-mac\"}}")), "{seen}");
        // It said hello with its new key, so it's on the club page already.
        assert!(seen.contains(&format!("/v1/releases/latest?kind=mac authorization: Bearer {key}")), "{seen}");
        assert_eq!(Cloud::release_source_of(&saved).unwrap().url, url);
    }

    #[test]
    fn a_mac_with_no_board_of_its_own_takes_releases_from_the_club_alone() {
        let key = format!("club.bob.{}", "c".repeat(64));
        let (url, _) = board((200, json!({ "name": "bob", "key": key })));
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("tasks.json");
        join(&config, &url, CODE, "bobs-mac").unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        assert_eq!(saved, json!({ "releases": { "url": url, "token": key } }));
        // No board of its own: no tasks synced anywhere, but releases come from the club.
        assert!(Cloud::from_config(&saved).is_none());
        assert_eq!(Cloud::release_source_of(&saved).unwrap().url, url);
    }

    #[test]
    fn a_used_code_a_wrong_answer_or_an_odd_board_leaves_tasks_json_alone() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("tasks.json");
        let (url, _) = board((403, json!({ "error": "That link was used or has expired: open Connect this Mac on the club page again." })));
        assert_eq!(join(&config, &url, CODE, "m").unwrap_err(), "That link was used or has expired: open Connect this Mac on the club page again.");
        let (url, _) = board((200, json!({ "name": "alice", "key": "club.mallory.x" })));
        assert_eq!(join(&config, &url, CODE, "m").unwrap_err(), "The club's board answered without a key for this Mac.");
        for odd in ["http://board.example", "https://board.example/v1/club", "file:///etc", "https://a b", "javascript:x", "https://"] {
            assert!(join(&config, odd, CODE, "m").unwrap_err().contains("isn't a Hive board's address"), "{odd}");
        }
        assert!(join(&config, &url, "../../x", "m").is_err());
        assert!(!config.exists());
        assert_eq!(board_url("https://board.example.com:8443/").unwrap(), "https://board.example.com:8443");
    }
}
