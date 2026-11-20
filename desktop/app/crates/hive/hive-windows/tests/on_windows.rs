//! Hive for Windows on a fresh Windows (GitHub's, in .github/workflows/windows.yml): a member opens the
//! download, connects with a Connect this PC link, and the PC puts in the club's newer release by
//! itself, as two real builds of Hive.exe (HIVE_TEST_OLD_EXE, HIVE_TEST_NEW_EXE) against a stand-in
//! club board.
#![cfg(windows)]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead as _, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CODE: &str = "0123456789abcdef0123456789abcdef";

/// A stand-in club board whose newest windows release is `version` (`bytes`); every call is kept.
fn board(version: String, bytes: Vec<u8>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let (mut line, mut length, mut node) = (String::new(), 0, String::new());
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
                if let Some(v) = lower.strip_prefix("x-hive-node:") {
                    node = v.trim().to_string();
                }
            }
            let mut body = vec![0; length];
            let _ = reader.read_exact(&mut body);
            let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
            log.lock().unwrap().push(format!("{path} {node} {}", String::from_utf8_lossy(&body)));
            let key = format!("club.alice.{}", "d".repeat(64));
            let (extra, out): (String, Vec<u8>) = if path == "/v1/club/devices/connect" {
                (String::new(), json!({ "name": "alice", "key": key }).to_string().into_bytes())
            } else if path == "/v1/releases/latest?kind=windows" {
                (String::new(), json!({ "release": { "version": version, "sha256": sha } }).to_string().into_bytes())
            } else if path == format!("/v1/releases/get?kind=windows&version={version}") {
                (format!("x-hive-sha256: {sha}\r\n"), bytes.clone())
            } else {
                (String::new(), b"{\"ok\":true}".to_vec())
            };
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", out.len());
            let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(&out));
        }
    });
    (url, seen)
}

/// Runs `exe` with `args` and `env`, its output in a file (a background Hive it starts keeps any pipe
/// open): (whether it succeeded, what it printed).
fn run(exe: &Path, args: &[&str], env: &[(&str, String)], scratch: &Path) -> (bool, String) {
    static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let out = scratch.join(format!("out-{}.txt", RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let file = std::fs::File::create(&out).unwrap();
    let status = Command::new(exe)
        .args(args)
        .envs(env.iter().map(|(k, v)| (*k, v.as_str())))
        .stdout(file.try_clone().unwrap())
        .stderr(file)
        .status()
        .unwrap();
    (status.success(), std::fs::read_to_string(&out).unwrap_or_default())
}

fn reg_query(key: &str, value: Option<&str>) -> String {
    let mut c = Command::new("reg");
    c.arg("query").arg(key);
    match value {
        Some(v) => c.arg("/v").arg(v),
        None => c.arg("/ve"),
    };
    let out = c.output().unwrap();
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn wait_for(what: &str, seconds: u64, mut done: impl FnMut() -> bool, log: impl Fn() -> String) {
    let start = Instant::now();
    while !done() {
        assert!(start.elapsed() < Duration::from_secs(seconds), "{what} didn't happen within {seconds} s; Hive's log:\n{}", log());
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[test]
#[ignore = "needs two builds of Hive.exe: HIVE_TEST_OLD_EXE and HIVE_TEST_NEW_EXE (the Windows check in CI)"]
fn a_members_pc_sets_hive_up_connects_and_puts_in_the_clubs_newer_release_by_itself() {
    let old = PathBuf::from(std::env::var("HIVE_TEST_OLD_EXE").expect("HIVE_TEST_OLD_EXE"));
    let new = PathBuf::from(std::env::var("HIVE_TEST_NEW_EXE").expect("HIVE_TEST_NEW_EXE"));
    let dir = tempfile::tempdir().unwrap();
    let (home, install, downloads) = (dir.path().join("home"), dir.path().join("install"), dir.path().join("Downloads"));
    std::fs::create_dir_all(&downloads).unwrap();
    let env = vec![
        ("HIVE_HOME", home.display().to_string()),
        ("HIVE_INSTALL_DIR", install.display().to_string()),
        ("HIVE_TEST_ANSWER", "yes".to_string()),
        ("HIVE_UPDATE_FIRST_LOOK_S", "1".to_string()),
        ("HIVE_UPDATE_EVERY_S", "5".to_string()),
    ];
    let version_of = |exe: &Path| run(exe, &["--version"], &env, dir.path()).1.trim().to_string();
    let (old_v, new_v) = (version_of(&old), version_of(&new));
    assert!(!old_v.is_empty() && old_v != "dev" && old_v != new_v, "{old_v} {new_v}");
    let (url, seen) = board(new_v.clone(), std::fs::read(&new).unwrap());

    // The member opens the download: it sets itself up in their own folders, for their links and sign-in.
    let download = downloads.join("Hive.exe");
    std::fs::copy(&old, &download).unwrap();
    let (ok, said) = run(&download, &[], &env, dir.path());
    assert!(ok && said.contains("dialog: Hive for Windows is set up"), "{said}");
    let installed = install.join("Hive.exe");
    assert_eq!(version_of(&installed), old_v);
    let open = reg_query(r"HKCU\Software\Classes\hive\shell\open\command", None);
    assert!(open.contains(&format!("\"{}\" --open \"%1\"", installed.display())), "{open}");
    assert!(reg_query(r"HKCU\Software\Classes\hive", Some("URL Protocol")).contains("URL Protocol"));
    let run_key = reg_query(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", Some("Hive"));
    assert!(run_key.contains(&format!("\"{}\" --background", installed.display())), "{run_key}");

    // A link that isn't the club's, or a member who says no, connects nothing.
    let (ok, said) = run(&installed, &["--open", "hive://club/connect?board=http%3A%2F%2Fevil.example&code=x"], &env, dir.path());
    assert!(!ok && said.contains("isn't a"), "{said}");
    let link = format!("hive://club/connect?board={}&code={CODE}", url.replace(':', "%3A").replace('/', "%2F"));
    let mut no = env.clone();
    no[2].1 = "no".into();
    let (ok, said) = run(&installed, &["--open", &link], &no, dir.path());
    assert!(ok && said.contains("dialog: Take Hive's updates from the club's board at"), "{said}");
    assert!(!home.join("tasks.json").exists());

    // Connect this PC: Windows opens the link with Hive.exe, and the member says yes.
    let (ok, said) = run(&installed, &["--open", &link], &env, dir.path());
    assert!(ok && said.contains("connected as alice's"), "{said}");
    let config: Value = serde_json::from_str(&std::fs::read_to_string(home.join("tasks.json")).unwrap()).unwrap();
    assert_eq!(config["releases"]["url"], url.as_str());

    // The background Hive sees the club's newer release and puts it in by itself.
    let log = || std::fs::read_to_string(home.join("hive.log")).unwrap_or_default();
    wait_for("the newer release going in", 180, || version_of(&installed) == new_v, log);
    let calls = seen.lock().unwrap().join("\n");
    assert!(calls.contains(&format!("Updated from {old_v} to {new_v}.")), "{calls}");
    assert!(calls.contains("/v1/releases/latest?kind=windows windows:"), "{calls}");
    // The new one started and removed the old one.
    let started = format!("{new_v} running in the background");
    wait_for("the new release starting", 120, || log().contains(&started) && !install.join("Hive.old.exe").exists(), log);
    let log = log();
    let (_, said) = run(&installed, &["--update-now"], &env, dir.path());
    assert!(said.contains("Current"), "{said}");
    assert!(!home.join("gave-up.json").exists(), "nothing was given up on: {log}");

    let _ = Command::new("taskkill").args(["/F", "/IM", "Hive.exe"]).output();
}
