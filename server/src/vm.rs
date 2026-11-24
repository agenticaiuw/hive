//! The VM's own things: its screen, typing a saved login (cred.rs keeps them), and rebuilding Hive from its git checkout.
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn x_env() -> [(&'static str, &'static str); 2] { [("DISPLAY", ":99"), ("XAUTHORITY", "/home/ubuntu/.Xauthority-99")] }

pub fn screen() -> Option<Vec<u8>> {
    let out = Command::new("vm-shot").output().ok()?;
    out.status.success().then_some(out.stdout)
}

pub fn type_password(site: &str, username: &str) -> Result<String, String> {
    let login = crate::cred::pick(site, username)?;
    let password = login["password"].as_str().ok_or(format!("No saved password for {site}"))?;
    let mut child = Command::new("xdotool").args(["type", "--delay", "40", "--file", "-"]).envs(x_env())
        .stdin(Stdio::piped()).spawn().map_err(|e| format!("couldn't run xdotool: {e}"))?;
    child.stdin.take().unwrap().write_all(password.as_bytes()).ok();
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    if !ok { return Err("xdotool couldn't type on the VM's screen".into()); }
    Ok(format!("Typed the password for {} ({}) into the focused field.", login["url"].as_str().unwrap_or(site), login["username"].as_str().unwrap_or("")))
}

fn sh(cmd: &str, dir: &Path) -> (bool, String) {
    match Command::new("bash").args(["-c", cmd]).current_dir(dir).output() {
        Ok(o) => (o.status.success(), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))),
        Err(e) => (false, e.to_string()),
    }
}

/// Take in GitHub's main (keeping this checkout's own commits on top), build, and restart Hive's server; the restart comes after this
/// answer is sent. This checkout's commits stay here, the owner's own; devices keep GitHub's build.
pub fn reinstall(repo: &Path) -> Result<Value, String> {
    let (ok, out) = sh("(git pull -q --rebase --autostash origin main || git rebase --abort); CARGO_TARGET_DIR=target cargo build --release -p hive-server 2>&1 | tail -30", repo);
    let tail: String = out.chars().rev().take(4000).collect::<String>().chars().rev().collect();
    if !ok || tail.contains("error[") || tail.contains("error:") { return Err(format!("The build failed:\n{tail}")); }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(2));
        Command::new("systemctl").args(["--no-block", "restart", "hive-server"]).status().ok();
    });
    Ok(json!("Built. Hive's server restarts in a moment; your turn continues after it's back."))
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
}
