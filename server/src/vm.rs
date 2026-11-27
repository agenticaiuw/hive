//! The VM's own things: its screen, typing a saved login (cred.rs keeps them), and rebuilding Hive from its git checkout.
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn x_env() -> [(&'static str, &'static str); 2] { [("DISPLAY", ":99"), ("XAUTHORITY", "/home/ubuntu/.Xauthority-99")] }

pub fn screen() -> Option<Vec<u8>> {
    let out = Command::new("vm-shot").output().ok()?;
    out.status.success().then_some(out.stdout)
}

fn xdotool_type(secret: &str) -> Result<(), String> {
    let mut child = Command::new("xdotool").args(["type", "--delay", "40", "--file", "-"]).envs(x_env())
        .stdin(Stdio::piped()).spawn().map_err(|e| format!("couldn't run xdotool: {e}"))?;
    child.stdin.take().unwrap().write_all(secret.as_bytes()).ok();
    if child.wait().map(|s| s.success()).unwrap_or(false) { Ok(()) }
    else { Err("xdotool couldn't type on the VM's screen".into()) }
}

pub fn type_password(site: &str, username: &str) -> Result<String, String> {
    let login = crate::cred::pick(site, username)?;
    let password = login["password"].as_str().ok_or(format!("No saved password for {site}"))?;
    xdotool_type(password)?;
    Ok(format!("Typed the password for {} ({}) into the focused field.", login["url"].as_str().unwrap_or(site), login["username"].as_str().unwrap_or("")))
}

pub fn type_card_field(label: &str, field: &str) -> Result<String, String> {
    let secret = crate::cred::pick_card(label, field)?;
    xdotool_type(&secret)?;
    Ok(format!("Typed saved card '{}' field '{field}' into the focused field.", if label.is_empty() { "default" } else { label }))
}

fn run_cmd(prog: &str, args: &[&str], dir: &Path, envs: &[(&str, &str)]) -> (bool, String) {
    match Command::new(prog).args(args).envs(envs.iter().copied()).current_dir(dir).output() {
        Ok(o) => (o.status.success(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))),
        Err(e) => (false, e.to_string()),
    }
}

fn tail(out: &str, n: usize) -> String { out.chars().rev().take(n).collect::<String>().chars().rev().collect() }

pub fn head_sha(repo: &Path) -> String {
    let (ok, out) = run_cmd("git", &["rev-parse", "--short=12", "HEAD"], repo, &[]);
    if ok { out.trim().to_string() } else { String::new() }
}

/// Sum `N passed; M failed` across all Cargo test binaries in a `cargo test` run.
pub fn parse_test_counts(out: &str) -> (i64, i64) {
    let (mut passed, mut failed) = (0i64, 0i64);
    for line in out.lines().filter(|l| l.starts_with("test result:")) {
        let toks: Vec<&str> = line.split_whitespace().collect();
        for w in toks.windows(2) {
            if let Ok(n) = w[0].parse::<i64>() {
                if w[1].starts_with("passed") { passed += n; }
                else if w[1].starts_with("failed") { failed += n; }
            }
        }
    }
    (passed, passed + failed)
}

pub struct Reinstall {
    pub passed: i64,
    pub total: i64,
    pub net_loc: i64,
    pub commit: String,
    pub message: String,
}

/// Parse `git diff --shortstat` (`N insertions(+), M deletions(-)`) into signed net LOC (`insertions - deletions`).
pub fn parse_shortstat_net_loc(out: &str) -> i64 {
    let (mut ins, mut del) = (0i64, 0i64);
    for part in out.split(',') {
        let mut toks = part.split_whitespace();
        if let (Some(n), Some(kind)) = (toks.next().and_then(|v| v.parse::<i64>().ok()), toks.next()) {
            if kind.starts_with("insertion") { ins += n; }
            else if kind.starts_with("deletion") { del += n; }
        }
    }
    ins - del
}

/// Anti-reward-hacking gate: prevent agents from deleting or weakening tests to make `cargo test` pass.
pub fn check_test_baseline(state: &Path, total: i64) -> Result<(), String> {
    let baseline = std::fs::read_to_string(state.join("test-baseline")).ok()
        .and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(0);
    if baseline > 0 && total < baseline {
        return Err(format!("Test count regressed ({total} < baseline {baseline}). Do not delete tests to make the suite pass; keep or expand test coverage."));
    }
    Ok(())
}

pub fn save_test_baseline(state: &Path, total: i64) {
    let path = state.join("test-baseline");
    let prev = std::fs::read_to_string(&path).ok().and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(0);
    if total > prev { std::fs::write(&path, total.to_string()).ok(); }
}

/// Rebase onto GitHub's main (keeping local commits on top), verify with `cargo test` + test-baseline gate, build release, and restart.
/// Aborts before restarting if tests, baseline, or build fail, returning `(passed, total, commit, error)` so SIM records failed evals too.
pub fn reinstall(repo: &Path, state: &Path) -> Result<Reinstall, (i64, i64, String, String)> {
    let _ = run_cmd("bash", &["-c", "git pull -q --rebase --autostash origin main || git rebase --abort"], repo, &[]);
    let commit = head_sha(repo);
    let env = [("CARGO_TARGET_DIR", "target")];
    let (ok, test_out) = run_cmd("cargo", &["test", "-p", "hive-server", "-p", "hive-protocol"], repo, &env);
    let (passed, total) = parse_test_counts(&test_out);
    if !ok { return Err((passed, total, commit, format!("Tests failed ({passed}/{total}):\n{}", tail(&test_out, 4000)))); }
    if let Err(e) = check_test_baseline(state, total) {
        return Err((passed, total, commit, e));
    }
    let (_, stat_out) = run_cmd("git", &["diff", "--shortstat", "HEAD~1..HEAD"], repo, &[]);
    let net_loc = parse_shortstat_net_loc(&stat_out);
    let (ok, build_out) = run_cmd("cargo", &["build", "--release", "-p", "hive-server"], repo, &env);
    if !ok { return Err((passed, total, commit, format!("The build failed:\n{}", tail(&build_out, 4000)))); }
    save_test_baseline(state, total);
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(2));
        Command::new("systemctl").args(["--no-block", "restart", "hive-server"]).status().ok();
    });
    let sign = if net_loc > 0 { "+" } else { "" };
    Ok(Reinstall {
        passed, total, net_loc, commit: commit.clone(),
        message: format!("Verified ({passed}/{total} tests passed at {commit}, net {sign}{net_loc} LOC) and built. Hive's server restarts in a moment; your turn continues after it's back."),
    })
}

/// Bridge the dashboard's authenticated WebSocket to the loopback-only VNC service.
/// Both directions are bounded by socket timeouts; closing the tab releases the VNC session.
pub fn control(req: &crate::http::Req, owner: bool) -> crate::http::Res {
    use crate::http::Res;
    // Cookies authenticate the upgrade, so reject cross-origin WebSocket requests.
    let origin = req.headers.get("origin").map(String::as_str).unwrap_or("");
    let host = req.headers.get("host").map(String::as_str).unwrap_or("");
    let same_origin = !host.is_empty() && [format!("http://{host}"), format!("https://{host}")].contains(&origin.to_string());
    // The Mac's authenticated tailnet door changes Host to the server address.
    let local_door = owner && origin == "http://127.0.0.1:8791";
    if !same_origin && !local_door {
        return Res::err(403, "Open screen control from your Hive dashboard.");
    }
    let key = match req.headers.get("sec-websocket-key") {
        Some(k) if req.headers.get("upgrade").is_some_and(|v| v.eq_ignore_ascii_case("websocket")) => k,
        _ => return Res::err(400, "A WebSocket upgrade is required."),
    };
    let vnc = match std::net::TcpStream::connect("127.0.0.1:5901") {
        Ok(s) => s,
        Err(_) => return Res::err(503, "The VM's VNC service isn't running."),
    };
    let mut res = Res::new(101, "", "").header("Upgrade", "websocket").header("Connection", "Upgrade")
        .header("Sec-WebSocket-Accept", &tungstenite::handshake::derive_accept_key(key.as_bytes()));
    res.upgrade = Some(Box::new(move |conn| { bridge(conn, vnc); }));
    res
}

fn bridge(conn: std::net::TcpStream, mut vnc: std::net::TcpStream) {
    use std::io::Read;
    use std::time::Duration;
    use tungstenite::{Message, Error, protocol::{Role, WebSocketConfig}};
    conn.set_read_timeout(Some(Duration::from_millis(8))).ok();
    conn.set_write_timeout(Some(Duration::from_secs(5))).ok();
    vnc.set_read_timeout(Some(Duration::from_millis(8))).ok();
    vnc.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let config = WebSocketConfig::default().max_message_size(Some(4 << 20)).max_frame_size(Some(4 << 20));
    let mut ws = tungstenite::WebSocket::from_raw_socket(conn, Role::Server, Some(config));
    let mut buf = [0; 65536];
    loop {
        match ws.read() {
            Ok(Message::Binary(bytes)) => if vnc.write_all(&bytes).is_err() { break; },
            Ok(Message::Close(_)) => break,
            Ok(_) => {},
            Err(Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {},
            Err(_) => break,
        }
        match vnc.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => if ws.send(Message::Binary(buf[..n].to_vec().into())).is_err() { break; },
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {},
            Err(_) => break,
        }
    }
    let _ = ws.close(None);
}

#[cfg(test)]
mod control_tests {
    use super::*;
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};
    #[test]
    fn vnc_bridge_transports_binary_and_releases_connection() {
        let browser_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let vnc_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let browser = TcpStream::connect(browser_listener.local_addr().unwrap()).unwrap();
        browser.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let vnc = TcpStream::connect(vnc_listener.local_addr().unwrap()).unwrap();
        let (server, _) = browser_listener.accept().unwrap();
        let (mut desktop, _) = vnc_listener.accept().unwrap();
        desktop.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let worker = std::thread::spawn(move || bridge(server, vnc));
        let mut client = tungstenite::WebSocket::from_raw_socket(browser, tungstenite::protocol::Role::Client, None);
        desktop.write_all(b"RFB 003.008\n").unwrap();
        assert_eq!(client.read().unwrap().into_data(), b"RFB 003.008\n"[..]);
        client.send(tungstenite::Message::Binary(vec![0, 255, 1, 2].into())).unwrap();
        let mut bytes = [0; 4];
        desktop.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, [0, 255, 1, 2]);
        client.close(None).unwrap();
        worker.join().unwrap();
        assert_eq!(desktop.read(&mut bytes).unwrap(), 0);
    }
    #[test]
    fn parses_cargo_test_counts() {
        let out = "running 16 tests\ntest result: ok. 16 passed; 0 failed; 0 ignored; 0 measured\n\
                   running 3 tests\ntest result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured\n";
        assert_eq!(parse_test_counts(out), (18, 19));
    }
    #[test]
    fn parses_net_loc_and_enforces_test_baseline() {
        assert_eq!(parse_shortstat_net_loc(" 3 files changed, 12 insertions(+), 45 deletions(-)\n"), -33);
        assert_eq!(parse_shortstat_net_loc(" 1 file changed, 10 insertions(+)\n"), 10);
        assert_eq!(parse_shortstat_net_loc(" 2 files changed, 8 deletions(-)\n"), -8);
        let dir = std::env::temp_dir().join(format!("hive-baseline-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(check_test_baseline(&dir, 10).is_ok());
        save_test_baseline(&dir, 42);
        assert!(check_test_baseline(&dir, 42).is_ok());
        assert!(check_test_baseline(&dir, 45).is_ok());
        assert!(check_test_baseline(&dir, 41).unwrap_err().contains("regressed"));
        save_test_baseline(&dir, 30); // never lowers baseline
        assert!(check_test_baseline(&dir, 41).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
