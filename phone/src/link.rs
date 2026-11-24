//! Hive Phone's one WebSocket (ios/HivePhone/Link.swift): the phone dials in to Hive's server, which sends it WebDriverAgent-style calls
//! ({id, method, path, body}); it answers each ({id, status, body}).
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Link { id: u64, out: Sender<String>, pending: HashMap<u64, Sender<(u16, String)>> }

static LINK: Mutex<Option<Link>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

pub fn connected() -> bool { LINK.lock().unwrap().is_some() }

/// Sec-WebSocket-Accept for the phone's Sec-WebSocket-Key (RFC 6455).
pub fn accept(key: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, format!("{}258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key.trim()).as_bytes());
    hive_protocol::b64::encode(d.as_ref())
}

/// One WebDriverAgent call on the phone: its HTTP status and body.
pub fn call(method: &str, path: &str, body: &str, secs: u64) -> Result<(u16, String), String> {
    let (tx, rx) = channel();
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    {
        let mut l = LINK.lock().unwrap();
        let l = l.as_mut().ok_or("phone offline: Hive Phone isn't connected")?;
        if l.pending.len() >= 4 { return Err("the phone is busy".into()); }
        l.pending.insert(id, tx);
        l.out.send(json!({ "id": id.to_string(), "method": method, "path": path, "body": body }).to_string()).map_err(|_| "phone disconnected")?;
    }
    let r = rx.recv_timeout(Duration::from_secs(secs));
    if let Some(l) = LINK.lock().unwrap().as_mut() { l.pending.remove(&id); }
    r.map_err(|e| if e == RecvTimeoutError::Timeout { "phone request timed out" } else { "phone disconnected" }.to_string())
}

/// Serves the phone's WebSocket until it closes or a newer one replaces it. While the phone's Hive (`version`, its
/// X-Hive-Version) is older than the newest signed build, it's told where to install that ({update: link}), once per build.
pub fn device(mut conn: TcpStream, version: String) {
    let me = NEXT.fetch_add(1, Ordering::Relaxed);
    let (out, rx) = channel::<String>();
    let tell = out.clone();
    *LINK.lock().unwrap() = Some(Link { id: me, out, pending: HashMap::new() });
    let ours = move || LINK.lock().unwrap().as_ref().is_some_and(|l| l.id == me);
    std::thread::spawn(move || {
        let mut told = String::new();
        while ours() {
            if let Some(link) = crate::update(&version).filter(|l| *l != told) {
                tell.send(json!({ "update": link }).to_string()).ok();
                told = link;
            }
            std::thread::sleep(Duration::from_secs(60));
        }
    });
    conn.set_read_timeout(Some(Duration::from_millis(25))).ok();
    let (mut buf, mut msg, mut heard, mut chunk) = (Vec::new(), Vec::new(), Instant::now(), vec![0u8; 64 << 10]);
    let _ = (|| -> Result<(), String> {
        while ours() {
            while let Ok(text) = rx.try_recv() { frame(&mut conn, 1, text.as_bytes()).map_err(|e| e.to_string())?; }
            match conn.read(&mut chunk) {
                Ok(0) => return Err("closed".into()),
                Ok(n) => { buf.extend_from_slice(&chunk[..n]); heard = Instant::now(); }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(e) => return Err(e.to_string()),
            }
            while let Some((fin, op, payload, used)) = parse(&buf)? {
                buf.drain(..used);
                match op {
                    0 | 1 | 2 => { msg.extend_from_slice(&payload); if fin { answer(&msg); msg.clear(); } }
                    8 => return Ok(()),
                    9 => frame(&mut conn, 10, &payload).map_err(|e| e.to_string())?,
                    _ => {}
                }
            }
            // The phone pings every 15 seconds.
            if heard.elapsed() > Duration::from_secs(60) { return Err("silent".into()); }
        }
        Ok(())
    })();
    let mut l = LINK.lock().unwrap();
    if l.as_ref().is_some_and(|l| l.id == me) { *l = None; }
}

fn answer(text: &[u8]) {
    let Ok(v) = serde_json::from_slice::<Value>(text) else { return };
    let id = v["id"].as_str().and_then(|i| i.parse::<u64>().ok()).unwrap_or(0);
    if let Some(tx) = LINK.lock().unwrap().as_mut().and_then(|l| l.pending.remove(&id)) {
        tx.send((v["status"].as_u64().unwrap_or(502) as u16, v["body"].as_str().unwrap_or("").to_string())).ok();
    }
}

/// One frame from the front of `b`, once it has all arrived: (fin, opcode, payload, bytes used).
fn parse(b: &[u8]) -> Result<Option<(bool, u8, Vec<u8>, usize)>, String> {
    if b.len() < 2 { return Ok(None); }
    let (len, mut i) = match b[1] & 0x7f {
        126 if b.len() >= 4 => (u16::from_be_bytes([b[2], b[3]]) as usize, 4),
        127 if b.len() >= 10 => (u64::from_be_bytes(b[2..10].try_into().unwrap()) as usize, 10),
        126 | 127 => return Ok(None),
        n => (n as usize, 2),
    };
    if len > 32 << 20 { return Err("frame too large".into()); }
    let mask = if b[1] & 0x80 != 0 { i += 4; b.get(i - 4..i).map(|m| [m[0], m[1], m[2], m[3]]) } else { Some([0; 4]) };
    let (Some(mask), Some(p)) = (mask, b.get(i..i + len)) else { return Ok(None) };
    Ok(Some((b[0] & 0x80 != 0, b[0] & 0x0f, p.iter().enumerate().map(|(k, x)| x ^ mask[k % 4]).collect(), i + len)))
}

fn frame(w: &mut dyn Write, op: u8, p: &[u8]) -> std::io::Result<()> {
    let mut h = vec![0x80 | op];
    match p.len() {
        n if n < 126 => h.push(n as u8),
        n if n < 65536 => { h.push(126); h.extend((n as u16).to_be_bytes()) }
        n => { h.push(127); h.extend((n as u64).to_be_bytes()) }
    }
    w.write_all(&h)?;
    w.write_all(p)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_the_rfc_example() { assert_eq!(accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="); }
    /// A fake Hive Phone: answers one call, pings, and gets its pong.
    #[test]
    fn passes_calls_to_the_phone_and_back() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || { device(l.accept().unwrap().0, "dev".into()) });
        let mut phone = TcpStream::connect(addr).unwrap();
        while !connected() { std::thread::sleep(Duration::from_millis(10)); }
        let caller = std::thread::spawn(|| call("GET", "/status", "", 5));
        let read = |p: &mut TcpStream| { let mut b = Vec::new(); let mut c = [0u8; 4096];
            loop { let n = p.read(&mut c).unwrap(); b.extend_from_slice(&c[..n]); if let Some(f) = parse(&b).unwrap() { return f } } };
        let send = |p: &mut TcpStream, op: u8, data: &[u8]| { let m = [9u8, 8, 7, 6]; let mut f = vec![0x80 | op, 0x80 | 126];
            f.extend((data.len() as u16).to_be_bytes()); f.extend(m); f.extend(data.iter().enumerate().map(|(k, x)| x ^ m[k % 4])); p.write_all(&f).unwrap() };
        let (_, op, asked, _) = read(&mut phone);
        let asked: Value = serde_json::from_slice(&asked).unwrap();
        assert_eq!((op, asked["path"].as_str()), (1, Some("/status")));
        send(&mut phone, 1, json!({ "id": asked["id"], "status": 200, "body": "{\"value\":{\"ready\":true}}" }).to_string().as_bytes());
        assert_eq!(caller.join().unwrap().unwrap(), (200, "{\"value\":{\"ready\":true}}".to_string()));
        send(&mut phone, 9, b"hi");
        assert_eq!(read(&mut phone).1, 10);
    }

    #[test]
    fn reads_masked_frames_whole_or_waits() {
        let (mask, text) = ([1u8, 2, 3, 4], b"hello");
        let mut f = vec![0x81, 0x80 | 5];
        f.extend(mask);
        f.extend(text.iter().enumerate().map(|(k, x)| x ^ mask[k % 4]));
        assert_eq!(parse(&f[..6]).unwrap(), None);
        assert_eq!(parse(&f).unwrap(), Some((true, 1, text.to_vec(), f.len())));
    }
}
