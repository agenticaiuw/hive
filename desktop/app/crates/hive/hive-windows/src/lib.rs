//! Hive for Windows: a club member's PC takes the club's releases, like their Mac (the owner,
//! 2026-11-20: "how would all the club members receive all the updates like in safari extension,
//! chrome extension, mac and windows app").
//!
//! The member downloads Hive.exe from the club page (cloud/tasks/club.js /v1/club/download/windows)
//! and opens it: it puts itself in their user folders (no administrator), registers the `hive://`
//! links Connect this PC opens, starts with Windows and runs in the background. Connect this PC on
//! the club page opens `hive://club/connect?board=<board>&code=<code>`; after the member says yes,
//! `join` trades the one-use code for this PC's own key (POST /v1/club/devices/connect) and keeps it
//! in tasks.json as `releases`, as hive-tasks club.rs does on a Mac. From then on `look` asks the board
//! for the newest windows release (/v1/releases/latest?kind=windows, which also shows this PC on the
//! club page under the member's name) and puts in a newer one: downloaded beside Hive.exe, checked
//! (its sha256, a Windows program, and that it says it's that release), swapped in by rename (a
//! running program can be renamed on Windows, not overwritten) and started; the old one is removed
//! when the new one starts. What happened is said on the board (POST /v1/nodes/report).
//!
//! Windows releases are built on GitHub's Windows machines (.github/workflows/windows.yml) and
//! published with `node cloud/release.mjs windows`. Everything here but the dialogs, the registry and
//! starting programs detached (main.rs) works on any system, so it's tested on the Mac too.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The board's routes this code was written against (cloud/shared/protocol.json).
pub const PROTOCOL: u32 = 1;

/// This build's release (`HIVE_VERSION` when it was built), or "dev" for a build made by hand, which
/// never replaces itself.
pub const VERSION: &str = match option_env!("HIVE_VERSION") {
    Some(v) => v,
    None => "dev",
};

/// The largest release the board takes (nodes.js MOST_BYTES).
pub const MOST_BYTES: u64 = 95 * 1024 * 1024;
pub const EXE: &str = "Hive.exe";
pub const NEW_EXE: &str = "Hive.new.exe";
pub const OLD_EXE: &str = "Hive.old.exe";

/// Where Hive for Windows keeps things: its settings and log (`home`, %APPDATA%\Hive) and the program
/// itself (`install`, %LOCALAPPDATA%\Programs\Hive), both the member's own.
#[derive(Clone, Debug)]
pub struct Places {
    pub home: PathBuf,
    pub install: PathBuf,
}

impl Places {
    /// This user's places; HIVE_HOME and HIVE_INSTALL_DIR say others (the Windows check in CI).
    pub fn here() -> Result<Places, String> {
        let from = |given: &str, base: &str, rest: &[&str]| -> Result<PathBuf, String> {
            if let Some(dir) = std::env::var_os(given).filter(|d| !d.is_empty()) {
                return Ok(PathBuf::from(dir));
            }
            let mut dir = PathBuf::from(std::env::var_os(base).filter(|d| !d.is_empty()).ok_or_else(|| format!("Windows didn't say where {base} is."))?);
            dir.extend(rest);
            Ok(dir)
        };
        Ok(Places { home: from("HIVE_HOME", "APPDATA", &["Hive"])?, install: from("HIVE_INSTALL_DIR", "LOCALAPPDATA", &["Programs", "Hive"])? })
    }

    pub fn config(&self) -> PathBuf {
        self.home.join("tasks.json")
    }
    pub fn log_file(&self) -> PathBuf {
        self.home.join("hive.log")
    }
    pub fn gave_up_file(&self) -> PathBuf {
        self.home.join("gave-up.json")
    }
    pub fn exe(&self) -> PathBuf {
        self.install.join(EXE)
    }

    /// Adds a line to the log, starting a new one past a megabyte.
    pub fn log(&self, line: &str) {
        let file = self.log_file();
        let _ = std::fs::create_dir_all(&self.home);
        if std::fs::metadata(&file).map(|m| m.len() > 1 << 20).unwrap_or(false) {
            let _ = std::fs::rename(&file, self.home.join("hive.log.1"));
        }
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
            let _ = writeln!(f, "{at} {line}");
        }
    }
}

/// This PC's name for the club: its computer name, as the board keeps names.
pub fn machine_name() -> String {
    let given = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default().to_lowercase();
    let name: String = given.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(60).collect();
    if name.is_empty() {
        "pc".into()
    } else {
        name
    }
}

/// The tasks.json at `path` as an object, or an empty one when there's none.
pub fn read_config(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|e| format!("{} isn't JSON ({e}), so it was left as it is.", path.display()))?;
            if value.is_object() {
                Ok(value)
            } else {
                Err(format!("{} isn't a JSON object, so it was left as it is.", path.display()))
            }
        }
        Err(_) => Ok(Value::Object(Map::new())),
    }
}

/// Where this PC takes Hive's releases from, as the member connected it.
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub url: String,
    pub token: String,
    pub machine: String,
}

impl Source {
    pub fn of(config: &Value, machine: &str) -> Option<Source> {
        let r = config.get("releases")?;
        let url = r.get("url")?.as_str()?.trim_end_matches('/').to_string();
        let token = r.get("token")?.as_str()?.to_string();
        (!url.is_empty() && !token.is_empty()).then(|| Source { url, token, machine: machine.to_string() })
    }

    /// The member this PC is connected as (its key is `club.<member>.<secret>`).
    pub fn member(&self) -> Option<&str> {
        self.token.strip_prefix("club.")?.split('.').next()
    }

    fn call(&self, method: &str, path: &str, seconds: u64) -> ureq::Request {
        ureq::request(method, &format!("{}{path}", self.url))
            .set("authorization", &format!("Bearer {}", self.token))
            .set("user-agent", "hive-windows")
            .set("x-hive-node", &format!("windows:{}", self.machine))
            .set("x-hive-version", VERSION)
            .set("x-hive-protocol", &PROTOCOL.to_string())
            .timeout(Duration::from_secs(seconds))
    }

    pub fn get_json(&self, path: &str) -> Result<Value, String> {
        let answer = self.call("GET", path, 30).call().map_err(said)?;
        answer.into_json().map_err(|e| format!("The club's board answered something else: {e}"))
    }

    pub fn post_json(&self, path: &str, body: &Value) -> Result<Value, String> {
        let answer = self.call("POST", path, 30).send_json(body.clone()).map_err(said)?;
        answer.into_json().map_err(|e| format!("The club's board answered something else: {e}"))
    }

    /// Streams `path` into the file `to`, refusing more than `most` bytes: (its length, the sha256
    /// the board says it has).
    pub fn get_file(&self, path: &str, to: &Path, most: u64) -> Result<(u64, Option<String>), String> {
        let answer = self.call("GET", path, 1800).call().map_err(said)?;
        let sha256 = answer.header("x-hive-sha256").map(str::to_lowercase);
        let failed = |e: std::io::Error| format!("Couldn't write {}: {e}", to.display());
        let mut file = std::fs::File::create(to).map_err(failed)?;
        let n = std::io::copy(&mut answer.into_reader().take(most + 1), &mut file).map_err(|e| format!("The download stopped: {e}"))?;
        file.sync_all().map_err(failed)?;
        if n > most {
            return Err(format!("The download is over {} MB.", most >> 20));
        }
        Ok((n, sha256))
    }
}

fn said(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(status, r) => {
            let value: Value = r.into_json().unwrap_or(Value::Null);
            value["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("The club's board said no ({status})."))
        }
        e => format!("Couldn't reach the club's board: {e}"),
    }
}

/// A Connect this PC link: `hive://club/connect?board=<board>&code=<code>` → (board, code).
pub fn parse_link(link: &str) -> Result<(String, String), String> {
    let wrong = || "That isn't a Connect this PC link: open Connect this PC on the club page again.".to_string();
    let query = link.trim().strip_prefix("hive://club/connect?").ok_or_else(wrong)?;
    let (mut board, mut code) = (None, None);
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "board" => board = Some(unescape(value).ok_or_else(wrong)?),
            "code" => code = Some(unescape(value).ok_or_else(wrong)?),
            _ => {}
        }
    }
    Ok((board.ok_or_else(wrong)?, code.ok_or_else(wrong)?))
}

/// A link's percent-escaped text, or None when it isn't escaped right.
fn unescape(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let (mut out, mut i) = (Vec::with_capacity(bytes.len()), 0);
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// The board's address, `https://host[:port]` (or a loopback `http://` one), without a path: whatever
/// else a link says isn't a board this PC takes code from (hive-tasks club.rs board_url).
pub fn board_url(board: &str) -> Result<String, String> {
    let board = board.trim().trim_end_matches('/');
    let host = board.strip_prefix("https://").or_else(|| {
        board.strip_prefix("http://").filter(|h| h.starts_with("127.0.0.1:") || h.starts_with("localhost:") || *h == "localhost")
    });
    let fine = host.is_some_and(|h| {
        let (name, port) = h.split_once(':').unwrap_or((h, ""));
        !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && port.bytes().all(|b| b.is_ascii_digit())
            && (port.is_empty() != h.contains(':'))
    });
    if !fine {
        return Err(format!("“{board}” isn't a Hive board's address, so this PC didn't connect to it."));
    }
    Ok(board.to_string())
}

/// Whose PC this now is.
#[derive(Debug, PartialEq)]
pub struct Joined {
    pub member: String,
    pub board: String,
}

/// Trades `code` for this PC's key at `board` and keeps it in the tasks.json at `config` as
/// `releases`, keeping what else is there; `device` names this PC to the club.
pub fn join(config: &Path, board: &str, code: &str, device: &str) -> Result<Joined, String> {
    let board = board_url(board)?;
    if code.len() != 32 || !code.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("That isn't a Connect this PC link: open Connect this PC on the club page again.".into());
    }
    let mut settings = read_config(config)?;
    let answer = ureq::post(&format!("{board}/v1/club/devices/connect"))
        .set("user-agent", "hive-windows")
        .timeout(Duration::from_secs(20))
        .send_json(json!({ "code": code, "device": device }))
        .map_err(said)?;
    let value: Value = answer.into_json().map_err(|e| format!("The club's board answered something else: {e}"))?;
    let member = value["name"].as_str().unwrap_or_default().to_string();
    let key = value["key"].as_str().unwrap_or_default();
    let valid_name = !member.is_empty() && member.len() <= 40 && member.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    let secret = key.strip_prefix(&format!("club.{member}.")).unwrap_or_default();
    if !valid_name || secret.len() != 64 || !secret.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("The club's board answered without a key for this PC.".into());
    }
    // The board the member said yes to, not one its answer names.
    if let Some(fields) = settings.as_object_mut() {
        fields.insert("releases".into(), json!({ "url": board, "token": key }));
        fields.insert("machine".into(), json!(device));
    }
    write_whole(config, &serde_json::to_string_pretty(&settings).unwrap_or_default())?;
    // Saying hello with the new key shows this PC on the club page now.
    if let Some(source) = Source::of(&settings, device) {
        let _ = source.get_json("/v1/releases/latest?kind=windows");
    }
    Ok(Joined { member, board })
}

/// `text` as the file at `path`, written whole or not at all (in the member's own %APPDATA%, which
/// only they and administrators can read).
fn write_whole(path: &Path, text: &str) -> Result<(), String> {
    let failed = |e: std::io::Error| format!("Couldn't write {}: {e}", path.display());
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(failed)?;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut file = std::fs::File::create(&temporary).map_err(failed)?;
    file.write_all(text.as_bytes()).and_then(|_| file.write_all(b"\n")).and_then(|_| file.sync_all()).map_err(failed)?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(failed)
}

/// What a look for a newer release came to.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Not connected to a club yet.
    NotConnected,
    /// Nothing newer to put in (or a build made by hand, or a release given up on).
    Current,
    /// The newer release is in place of the old one; start it.
    PutIn { from: String, to: String },
}

/// Asks the board for the newest windows release and, when it isn't `running`, puts it in. A
/// network failure is tried again at the next look; a download that fails its checks is given up on
/// (and said on the board), so it's never downloaded again. `ran` runs a program with `--version`.
pub fn look(places: &Places, running: &str, ran: &dyn Fn(&Path) -> Result<String, String>) -> Result<Outcome, String> {
    let config = read_config(&places.config())?;
    let machine = config.get("machine").and_then(Value::as_str).map(str::to_string).unwrap_or_else(machine_name);
    let Some(source) = Source::of(&config, &machine) else { return Ok(Outcome::NotConnected) };
    let latest = source.get_json("/v1/releases/latest?kind=windows")?;
    let release = &latest["release"];
    let to = release["version"].as_str().unwrap_or_default().to_string();
    let valid = (4..=40).contains(&to.len()) && to.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    if !valid || running == "dev" || to == running || gave_up(places).contains(&to) {
        return Ok(Outcome::Current);
    }
    let new = places.install.join(NEW_EXE);
    let _ = std::fs::remove_file(&new);
    std::fs::create_dir_all(&places.install).map_err(|e| format!("Couldn't make {}: {e}", places.install.display()))?;
    let (_, header) = match source.get_file(&format!("/v1/releases/get?kind=windows&version={to}"), &new, MOST_BYTES) {
        Ok(got) => got,
        Err(why) => {
            let _ = std::fs::remove_file(&new);
            return Err(why);
        }
    };
    let expected = release["sha256"].as_str().unwrap_or_default().to_lowercase();
    if let Err(why) = check(&new, &expected, header.as_deref(), &to, ran).and_then(|_| swap(&places.install)) {
        let _ = std::fs::remove_file(&new);
        give_up(places, &to);
        let note = format!("Didn't update to {to}: {why}");
        let _ = source.post_json("/v1/nodes/report", &json!({ "kind": "windows", "name": machine, "note": note }));
        return Err(note);
    }
    let note = format!("Updated from {running} to {to}.");
    let _ = source.post_json("/v1/nodes/report", &json!({ "kind": "windows", "name": machine, "version": to, "note": note }));
    Ok(Outcome::PutIn { from: running.to_string(), to })
}

/// Whether the download at `new` is the release `version`: the sha256 the board published (and sent
/// with it), a Windows program, and one that says it's that release.
pub fn check(new: &Path, expected: &str, header: Option<&str>, version: &str, ran: &dyn Fn(&Path) -> Result<String, String>) -> Result<(), String> {
    let bytes = std::fs::read(new).map_err(|e| format!("Couldn't read the download: {e}"))?;
    let sha = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
    if expected.len() != 64 || sha != expected || header.is_some_and(|h| h != sha) {
        return Err("the download isn't the release the board published (its sha256 differs)".into());
    }
    if !bytes.starts_with(b"MZ") {
        return Err("the download isn't a Windows program".into());
    }
    let says = ran(new)?;
    if says.trim() != version {
        return Err(format!("the download says it's {:?}, not {version}", says.trim()));
    }
    Ok(())
}

/// Puts Hive.new.exe in Hive.exe's place: the old one becomes Hive.old.exe (a running program can be
/// renamed, not overwritten), removed when the new one starts (`clean_old`). Undone if it can't finish.
pub fn swap(install: &Path) -> Result<(), String> {
    let (exe, new, old) = (install.join(EXE), install.join(NEW_EXE), install.join(OLD_EXE));
    if old.exists() {
        std::fs::remove_file(&old).map_err(|e| format!("couldn't remove the Hive.old.exe of the update before ({e})"))?;
    }
    let had = exe.exists();
    if had {
        std::fs::rename(&exe, &old).map_err(|e| format!("couldn't move the running Hive.exe aside ({e})"))?;
    }
    if let Err(e) = std::fs::rename(&new, &exe) {
        if had {
            let _ = std::fs::rename(&old, &exe);
        }
        return Err(format!("couldn't put the new Hive.exe in place ({e})"));
    }
    Ok(())
}

/// Removes the Hive.old.exe an update left, once it's no longer running.
pub fn clean_old(install: &Path) {
    let _ = std::fs::remove_file(install.join(OLD_EXE));
}

/// The releases given up on, which are never downloaded again.
pub fn gave_up(places: &Places) -> Vec<String> {
    let text = std::fs::read_to_string(places.gave_up_file()).unwrap_or_default();
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    value["versions"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

pub fn give_up(places: &Places, version: &str) {
    let mut versions = gave_up(places);
    if !versions.iter().any(|v| v == version) {
        versions.push(version.to_string());
    }
    let keep = versions.len().saturating_sub(20);
    let _ = write_whole(&places.gave_up_file(), &json!({ "versions": &versions[keep..] }).to_string());
}

/// What a member sees when they open Hive again: what this PC runs and where it takes updates from.
pub fn status(places: &Places) -> String {
    let config = read_config(&places.config()).unwrap_or(Value::Null);
    let running = if VERSION == "dev" { "a build made by hand".to_string() } else { format!("release {VERSION}") };
    match Source::of(&config, &machine_name()) {
        Some(source) => format!(
            "Hive for Windows is running ({running}) and connected as {}'s PC. It takes the club's updates by itself.",
            source.member().unwrap_or("a member")
        ),
        None => format!("Hive for Windows is running ({running}). To take the club's updates, open the club page and choose Connect this PC."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A stand-in club board: `answer(path, body)` → (status, headers, body); every call is kept as
    /// "path auth node body".
    type Answer = dyn Fn(&str, &[u8]) -> (u16, Vec<(String, String)>, Vec<u8>) + Send + Sync;
    fn board(answer: Arc<Answer>) -> (String, Arc<Mutex<Vec<String>>>) {
        use std::io::{BufRead as _, Read as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let (mut line, mut length, mut auth, mut node) = (String::new(), 0, String::new(), String::new());
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
                    if let Some(v) = lower.strip_prefix("x-hive-node:") {
                        node = v.trim().to_string();
                    }
                }
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(format!("{path} {auth} {node} {}", String::from_utf8_lossy(&body)));
                let (status, headers, out) = answer(&path, &body);
                let mut head = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n", out.len());
                for (k, v) in headers {
                    head.push_str(&format!("{k}: {v}\r\n"));
                }
                let _ = stream.write_all(format!("{head}\r\n").as_bytes()).and_then(|_| stream.write_all(&out));
            }
        });
        (url, seen)
    }

    const CODE: &str = "0123456789abcdef0123456789abcdef";

    fn places() -> (tempfile::TempDir, Places) {
        let dir = tempfile::tempdir().unwrap();
        let places = Places { home: dir.path().join("home"), install: dir.path().join("install") };
        std::fs::create_dir_all(&places.install).unwrap();
        (dir, places)
    }

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn a_connect_link_names_the_board_and_the_code_and_nothing_else_is_one() {
        let link = format!("hive://club/connect?board={}&code={CODE}", "https%3A%2F%2Fboard.example.com");
        assert_eq!(parse_link(&link).unwrap(), ("https://board.example.com".to_string(), CODE.to_string()));
        for wrong in ["hive://club/other?board=x&code=y", "https://board.example.com", "hive://club/connect?board=x", "hive://club/connect?board=%zz&code=1"] {
            assert!(parse_link(wrong).unwrap_err().contains("Connect this PC"), "{wrong}");
        }
        assert_eq!(board_url("https://board.example.com:8443/").unwrap(), "https://board.example.com:8443");
        for odd in ["http://board.example", "https://board.example/v1/club", "file:///c:/x", "https://a b", "https://"] {
            assert!(board_url(odd).unwrap_err().contains("isn't a Hive board's address"), "{odd}");
        }
    }

    #[test]
    fn a_connect_code_becomes_this_pcs_release_key_and_it_says_hello() {
        let key = format!("club.alice.{}", "b".repeat(64));
        let answer_key = key.clone();
        let (url, seen) = board(Arc::new(move |path, _| {
            if path == "/v1/club/devices/connect" {
                (200, vec![], json!({ "name": "alice", "key": answer_key, "board": "https://elsewhere.example" }).to_string().into_bytes())
            } else {
                (200, vec![], json!({ "release": null }).to_string().into_bytes())
            }
        }));
        let (_dir, places) = places();
        std::fs::create_dir_all(&places.home).unwrap();
        std::fs::write(places.config(), r#"{"kept": true}"#).unwrap();
        let joined = join(&places.config(), &format!("{url}/"), CODE, "alices-pc").unwrap();
        assert_eq!(joined, Joined { member: "alice".into(), board: url.clone() });
        let saved = read_config(&places.config()).unwrap();
        assert_eq!(saved, json!({ "kept": true, "releases": { "url": url, "token": key }, "machine": "alices-pc" }));
        let seen = seen.lock().unwrap().join("\n");
        assert!(seen.contains(&format!("/v1/club/devices/connect   {{\"code\":\"{CODE}\",\"device\":\"alices-pc\"}}")), "{seen}");
        assert!(seen.contains(&format!("/v1/releases/latest?kind=windows authorization: Bearer {key} windows:alices-pc")), "{seen}");
        assert!(status(&places).contains("connected as alice's PC"));
        // A used code, or an answer without this member's key, leaves tasks.json as it was.
        let (url, _) = board(Arc::new(|_, _| (403, vec![], json!({ "error": "That link was used or has expired." }).to_string().into_bytes())));
        assert_eq!(join(&places.config(), &url, CODE, "x").unwrap_err(), "That link was used or has expired.");
        let (url, _) = board(Arc::new(|_, _| (200, vec![], json!({ "name": "alice", "key": "club.mallory.x" }).to_string().into_bytes())));
        assert_eq!(join(&places.config(), &url, CODE, "x").unwrap_err(), "The club's board answered without a key for this PC.");
        assert!(join(&places.config(), &url, "../../x", "x").is_err());
        assert_eq!(read_config(&places.config()).unwrap(), saved);
    }

    /// A board with `release` (version, bytes) as the newest windows release; `sent_sha` is the sha256
    /// it sends with the download.
    fn release_board(version: &'static str, bytes: Vec<u8>, sent_sha: Option<String>) -> (String, Arc<Mutex<Vec<String>>>) {
        let published = sha(&bytes);
        board(Arc::new(move |path, _| {
            if path == "/v1/releases/latest?kind=windows" {
                (200, vec![], json!({ "release": { "version": version, "sha256": published } }).to_string().into_bytes())
            } else if path == format!("/v1/releases/get?kind=windows&version={version}") {
                (200, vec![("x-hive-sha256".into(), sent_sha.clone().unwrap_or_else(|| published.clone()))], bytes.clone())
            } else {
                (200, vec![], b"{}".to_vec())
            }
        }))
    }

    fn connect(places: &Places, url: &str) {
        std::fs::create_dir_all(&places.home).unwrap();
        let config = json!({ "releases": { "url": url, "token": format!("club.alice.{}", "c".repeat(64)) }, "machine": "alices-pc" });
        std::fs::write(places.config(), config.to_string()).unwrap();
    }

    #[test]
    fn a_newer_release_takes_the_running_programs_place_and_is_said_on_the_board() {
        let (_dir, places) = places();
        assert_eq!(look(&places, "aaaaaaaaaaaa", &|_| unreachable!()).unwrap(), Outcome::NotConnected);
        let new = b"MZ the newer Hive.exe".to_vec();
        let (url, seen) = release_board("bbbbbbbbbbbb", new.clone(), None);
        connect(&places, &url);
        std::fs::write(places.exe(), b"MZ the running Hive.exe").unwrap();
        let asked = Mutex::new(Vec::new());
        let ran = |p: &Path| {
            asked.lock().unwrap().push(p.file_name().unwrap().to_string_lossy().to_string());
            Ok("bbbbbbbbbbbb\r\n".to_string())
        };
        assert_eq!(look(&places, "aaaaaaaaaaaa", &ran).unwrap(), Outcome::PutIn { from: "aaaaaaaaaaaa".into(), to: "bbbbbbbbbbbb".into() });
        assert_eq!(*asked.lock().unwrap(), [NEW_EXE], "the download said which release it is before it went in");
        assert_eq!(std::fs::read(places.exe()).unwrap(), new);
        assert_eq!(std::fs::read(places.install.join(OLD_EXE)).unwrap(), b"MZ the running Hive.exe");
        assert!(!places.install.join(NEW_EXE).exists());
        let seen = seen.lock().unwrap().join("\n");
        assert!(seen.contains("/v1/nodes/report") && seen.contains("Updated from aaaaaaaaaaaa to bbbbbbbbbbbb."), "{seen}");
        // The new one runs it now: nothing newer, and the old one goes.
        assert_eq!(look(&places, "bbbbbbbbbbbb", &|_| unreachable!()).unwrap(), Outcome::Current);
        clean_old(&places.install);
        assert!(!places.install.join(OLD_EXE).exists());
        // A build made by hand never replaces itself.
        assert_eq!(look(&places, "dev", &|_| unreachable!()).unwrap(), Outcome::Current);
    }

    #[test]
    fn a_download_that_isnt_the_published_release_is_given_up_on_and_the_running_program_stays() {
        // (release, its bytes, the sha256 sent with them, what it says it is, why it's given up on)
        type Case = (&'static str, Vec<u8>, Option<String>, &'static str, &'static str);
        let cases: [Case; 3] = [
            ("cccccccccccc", b"MZ but another".to_vec(), Some("0".repeat(64)), "cccccccccccc", "sha256 differs"),
            ("dddddddddddd", b"not a program".to_vec(), None, "dddddddddddd", "isn't a Windows program"),
            ("eeeeeeeeeeee", b"MZ an older one".to_vec(), None, "aaaaaaaaaaaa", "says it's \"aaaaaaaaaaaa\""),
        ];
        for (version, bytes, sent_sha, says, why) in cases {
            let (_dir, places) = places();
            let (url, seen) = release_board(version, bytes, sent_sha);
            connect(&places, &url);
            std::fs::write(places.exe(), b"MZ the running Hive.exe").unwrap();
            let ran = |_: &Path| Ok(says.to_string());
            let error = look(&places, "aaaaaaaaaaaa", &ran).unwrap_err();
            assert!(error.contains(why), "{version}: {error}");
            assert_eq!(std::fs::read(places.exe()).unwrap(), b"MZ the running Hive.exe");
            assert!(!places.install.join(NEW_EXE).exists() && !places.install.join(OLD_EXE).exists());
            assert_eq!(gave_up(&places), [version]);
            assert!(seen.lock().unwrap().join("\n").contains(&format!("Didn't update to {version}")));
            // Given up on: never downloaded again.
            assert_eq!(look(&places, "aaaaaaaaaaaa", &|_| unreachable!()).unwrap(), Outcome::Current);
        }
    }

    #[test]
    fn a_board_that_cant_be_reached_is_tried_again_at_the_next_look() {
        let (_dir, places) = places();
        connect(&places, "http://127.0.0.1:9");
        assert!(look(&places, "aaaaaaaaaaaa", &|_| unreachable!()).unwrap_err().contains("Couldn't reach the club's board"));
        assert!(gave_up(&places).is_empty());
    }
}
