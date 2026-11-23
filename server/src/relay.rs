//! The relay: how a Hive on a laptop at home gets an address when the internet can't reach it (most homes: the router or the
//! provider keeps incoming connections out). The home Hive connects out to the club's VM and gets <name>.hive.agenticaiuw.com;
//! the VM passes each connection for that name, as it arrived, down to the laptop. HTTPS stays end to end: the laptop has the
//! certificate for its name (Let's Encrypt checks it through the relay on port 80) and the VM only reads which name a connection
//! is for. On the VM, HIVE_RELAY_DOMAIN=hive.agenticaiuw.com turns serving on (vm/hive-server.service).
//!
//! A home Hive keeps one control connection (HTTPS, `GET /relay` on the VM, signed in with its name's secret). For each new
//! connection the VM writes `open <id> <port>`; the home Hive dials the VM's port 443 again, says `HIVE-RELAY <id>`, and the two
//! connections are joined. The VM tells the two kinds apart by their first bytes: a TLS hello, a plain HTTP request, or that line.
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The club's relay. HIVE_RELAY points a home Hive at another one.
pub fn domain() -> String { std::env::var("HIVE_RELAY").unwrap_or_else(|_| "hive.agenticaiuw.com".into()) }

/// What this computer serves, when it's a relay.
pub fn serving() -> Option<String> { std::env::var("HIVE_RELAY_DOMAIN").ok().filter(|d| !d.is_empty()) }

// ---- the relay, on the VM ----

#[derive(Default)]
pub struct Relay {
    homes: Mutex<HashMap<String, (u64, Sender<String>)>>,
    waiting: Mutex<HashMap<String, TcpStream>>,
}

pub fn relay() -> &'static Relay {
    static R: std::sync::OnceLock<Relay> = std::sync::OnceLock::new();
    R.get_or_init(Relay::default)
}

/// The name a connection is for, when it's for a home Hive: the first label of `host` under the relay's domain.
pub fn home_name(host: &str, domain: &str) -> Option<String> {
    let host = host.split(':').next()?.to_ascii_lowercase();
    let name = host.strip_suffix(&format!(".{domain}"))?;
    (!name.is_empty() && !name.contains('.')).then(|| name.to_string())
}

/// Hands a connection that arrived for `name` to that home Hive; false if it isn't connected.
pub fn forward(name: &str, public: TcpStream, port: u16) -> bool {
    let r = relay();
    let Some((_, home)) = r.homes.lock().unwrap().get(name).cloned() else { return false };
    let id = crate::api::random(16);
    r.waiting.lock().unwrap().insert(id.clone(), public);
    if home.send(format!("open {id} {port}")).is_err() { r.waiting.lock().unwrap().remove(&id); return false }
    // A home that never dials back doesn't keep the connection.
    std::thread::spawn(move || { std::thread::sleep(Duration::from_secs(15)); relay().waiting.lock().unwrap().remove(&id); });
    true
}

/// A home Hive dialled back for connection `id` (the line `HIVE-RELAY <id>` already read): join the two.
pub fn joined(id: &str, home: TcpStream) {
    let Some(public) = relay().waiting.lock().unwrap().remove(id) else { return };
    splice(public, home);
}

fn splice(a: TcpStream, b: TcpStream) {
    for s in [&a, &b] { s.set_read_timeout(Some(Duration::from_secs(600))).ok(); }
    let (Ok(mut a2), Ok(mut b2)) = (a.try_clone(), b.try_clone()) else { return };
    let (mut a, mut b) = (a, b);
    let t = std::thread::spawn(move || { std::io::copy(&mut a2, &mut b2).ok(); b2.shutdown(std::net::Shutdown::Write).ok(); });
    std::io::copy(&mut b, &mut a).ok();
    a.shutdown(std::net::Shutdown::Write).ok();
    t.join().ok();
}

/// A name a home Hive may have: short, plain, and not one the relay uses itself.
pub fn fair_name(n: &str) -> bool {
    (3..=30).contains(&n.len()) && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !n.starts_with('-') && !n.ends_with('-') && !["relay", "www", "api", "mail", "admin", "hive"].contains(&n)
}

/// The control connection's sign-in: a new name is claimed by the first secret to use it; after that only that secret.
pub fn admit(state: &Path, name: &str, secret: &str) -> Result<(), String> {
    if !fair_name(name) { return Err("names are 3 to 30 letters, digits and dashes".into()) }
    if secret.len() < 24 { return Err("a longer secret".into()) }
    let file = state.join("relay-names.json");
    let _g = relay().homes.lock().unwrap();
    let mut names: HashMap<String, String> = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let hash: String = Sha256::digest(secret.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    match names.get(name) {
        Some(h) if *h == hash => Ok(()),
        Some(_) => Err("taken".into()),
        None => {
            names.insert(name.into(), hash);
            crate::private(&file, serde_json::to_vec(&names).unwrap_or_default());
            Ok(())
        }
    }
}

/// The relay's side of a control connection, once admitted: `open` lines go down it, and a ping every 25 seconds, until it drops.
pub fn control(name: String, mut conn: Box<dyn hive_phone::Conn>) {
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let me = SERIAL.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let (tx, rx) = mpsc::channel::<String>();
    // A reconnect replaces the old connection; the old one's ending mustn't remove the new one.
    relay().homes.lock().unwrap().insert(name.clone(), (me, tx));
    eprintln!("relay: {name} connected");
    loop {
        let line = rx.recv_timeout(Duration::from_secs(25)).unwrap_or_else(|_| "ping".into());
        if writeln!(conn, "{line}").and_then(|_| conn.flush()).is_err() { break }
    }
    let mut homes = relay().homes.lock().unwrap();
    if homes.get(&name).is_some_and(|h| h.0 == me) { homes.remove(&name); }
    eprintln!("relay: {name} left");
}

// ---- a home Hive's side ----

/// This home Hive's name at the relay, picked once from the computer's name (and a number if that's taken).
pub fn name(state: &Path) -> Option<String> { std::fs::read_to_string(state.join("relay")).ok().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) }

fn computer_name() -> String {
    let raw = std::process::Command::new(if cfg!(target_os = "macos") { "scutil" } else { "hostname" })
        .args(if cfg!(target_os = "macos") { &["--get", "LocalHostName"][..] } else { &[][..] }).output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let mut n: String = raw.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    n = n.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    n.truncate(24);
    let n = n.trim_matches('-').to_string();
    if fair_name(&n) { n } else { format!("hive-{}", crate::api::random(6).to_ascii_lowercase()) }
}

/// Keeps this home Hive connected to the relay, for good; `serve` answers each connection that comes down it on `port` (80 or
/// 443), as if it had arrived here. Returns once the relay has admitted a name, with that name.
pub fn connect(state: &Path, serve: Arc<dyn Fn(TcpStream, u16) + Send + Sync>) -> Result<String, String> {
    let secret_file = state.join("relay-secret");
    let secret = std::fs::read_to_string(&secret_file).ok().filter(|s| s.len() >= 24).unwrap_or_else(|| {
        let s = crate::api::random(32);
        crate::private(&secret_file, &s);
        s
    });
    let base = name(state).unwrap_or_else(computer_name);
    let mut tried = 0;
    let (name, first) = loop {
        let n = if tried == 0 { base.clone() } else { format!("{base}-{}", tried + 1) };
        match dial(&n, &secret) {
            Ok(c) => break (n, c),
            Err(e) if e.contains("taken") && tried < 20 => tried += 1,
            Err(e) => return Err(format!("Couldn't reach the relay at relay.{}: {e}", domain())),
        }
    };
    std::fs::write(state.join("relay"), &name).ok();
    let n = name.clone();
    std::thread::spawn(move || {
        let mut conn = Some(first);
        loop {
            if let Some(c) = conn.take() { listen(c, &serve) }
            std::thread::sleep(Duration::from_secs(5));
            conn = dial(&n, &secret).map_err(|e| eprintln!("relay: {e}")).ok();
        }
    });
    Ok(name)
}

/// The relay's own address: relay.<domain>, which points at the VM.
fn relay_ip() -> Result<std::net::SocketAddr, String> {
    use std::net::ToSocketAddrs;
    (format!("relay.{}", domain()).as_str(), 443).to_socket_addrs().map_err(|e| e.to_string())?.find(|a| a.is_ipv4()).ok_or("no address".into())
}

type Tls = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

/// Opens and signs in a control connection: HTTPS to the VM's own address (its certificate is for its IP address).
fn dial(name: &str, secret: &str) -> Result<BufReader<Tls>, String> {
    let addr = relay_ip()?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(15)).map_err(|e| e.to_string())?;
    tcp.set_read_timeout(Some(Duration::from_secs(90))).ok();
    let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().map_err(|e| e.to_string())?
        .with_root_certificates(roots).with_no_client_auth();
    let server = rustls::pki_types::ServerName::IpAddress(addr.ip().into());
    let conn = rustls::ClientConnection::new(Arc::new(config), server).map_err(|e| e.to_string())?;
    let mut tls = rustls::StreamOwned::new(conn, tcp);
    write!(tls, "GET /relay HTTP/1.1\r\nHost: {}\r\nConnection: Upgrade\r\nUpgrade: hive-relay\r\nX-Relay-Name: {name}\r\nX-Relay-Secret: {secret}\r\n\r\n", addr.ip())
        .and_then(|_| tls.flush()).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(tls);
    let mut status = String::new();
    r.read_line(&mut status).map_err(|e| e.to_string())?;
    let mut body = String::new();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).map_err(|e| e.to_string())? == 0 || h.trim().is_empty() { break }
    }
    if !status.contains(" 101") {
        r.get_mut().sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let mut buf = [0u8; 512];
        if let Ok(n) = r.read(&mut buf) { body = String::from_utf8_lossy(&buf[..n]).into_owned(); }
        return Err(format!("{} {body}", status.trim()));
    }
    Ok(r)
}

fn listen(mut conn: BufReader<Tls>, serve: &Arc<dyn Fn(TcpStream, u16) + Send + Sync>) {
    let Ok(addr) = relay_ip() else { return };
    loop {
        let mut line = String::new();
        if conn.read_line(&mut line).unwrap_or(0) == 0 { return }
        let mut w = line.split_whitespace();
        if w.next() != Some("open") { continue }
        let (Some(id), Some(port)) = (w.next().map(String::from), w.next().and_then(|p| p.parse::<u16>().ok())) else { continue };
        let serve = serve.clone();
        std::thread::spawn(move || {
            let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(15)) else { return };
            if writeln!(s, "HIVE-RELAY {id}").is_err() { return }
            s.set_read_timeout(Some(Duration::from_secs(60))).ok();
            serve(s, port);
        });
    }
}

/// What a connection to the VM's port 443 is: a home Hive dialling back (`HIVE-RELAY <id>`, which this reads off), a TLS hello
/// for a name (its SNI), or anything else.
pub enum Arrival { Back(String), Tls(Option<String>), Other }

pub fn arrival(s: &mut TcpStream) -> Arrival {
    let mut buf = [0u8; 2048];
    let n = s.peek(&mut buf).unwrap_or(0);
    if buf[..n].starts_with(b"HIVE-RELAY ") {
        let mut line = Vec::new();
        let mut b = [0u8; 1];
        while line.len() < 64 && s.read(&mut b).unwrap_or(0) == 1 && b[0] != b'\n' { line.push(b[0]) }
        return Arrival::Back(String::from_utf8_lossy(&line[11..]).trim().to_string());
    }
    if n > 0 && buf[0] == 0x16 { return Arrival::Tls(sni(&buf[..n])) }
    Arrival::Other
}

/// The server name in a TLS ClientHello (RFC 8446 4.1.2, RFC 6066 3), if it has one.
pub fn sni(b: &[u8]) -> Option<String> {
    let at = |i: usize| b.get(i).copied().map(usize::from);
    let two = |i: usize| Some(at(i)? << 8 | at(i + 1)?);
    // record header 5, handshake header 4, version 2, random 32
    let mut i = 5 + 4 + 2 + 32;
    i += 1 + at(i)?; // session id
    i += 2 + two(i)?; // cipher suites
    i += 1 + at(i)?; // compression
    let end = i + 2 + two(i)?;
    i += 2;
    while i + 4 <= end.min(b.len()) {
        let (kind, len) = (two(i)?, two(i + 2)?);
        if kind == 0 {
            // list length 2, name type 1, name length 2
            let n = two(i + 4 + 3)?;
            return b.get(i + 4 + 5..i + 4 + 5 + n).map(|h| String::from_utf8_lossy(h).to_ascii_lowercase());
        }
        i += 4 + len;
    }
    None
}

/// The Host of a plain HTTP request peeked off port 80.
pub fn http_host(s: &TcpStream) -> Option<String> {
    let mut buf = [0u8; 4096];
    let n = s.peek(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    text.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("host")).map(|(_, v)| v.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(home_name("evan.hive.agenticaiuw.com", "hive.agenticaiuw.com").as_deref(), Some("evan"));
        assert_eq!(home_name("EVAN.hive.agenticaiuw.com:80", "hive.agenticaiuw.com").as_deref(), Some("evan"));
        assert_eq!(home_name("a.b.hive.agenticaiuw.com", "hive.agenticaiuw.com"), None);
        assert_eq!(home_name("153.66.203.47", "hive.agenticaiuw.com"), None);
        assert!(fair_name("evans-macbook-air") && !fair_name("relay") && !fair_name("-x-") && !fair_name("ab") && !fair_name("Evan"));
    }

    #[test]
    fn reads_the_name_in_a_tls_hello() {
        // A real ClientHello from rustls for evan.hive.agenticaiuw.com.
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        let config = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().unwrap()
            .with_root_certificates(roots).with_no_client_auth();
        let mut c = rustls::ClientConnection::new(Arc::new(config), "evan.hive.agenticaiuw.com".try_into().unwrap()).unwrap();
        let mut hello = Vec::new();
        c.write_tls(&mut hello).unwrap();
        assert_eq!(sni(&hello).as_deref(), Some("evan.hive.agenticaiuw.com"));
        assert_eq!(sni(&hello[..20]), None);
    }

    #[test]
    fn joins_a_public_connection_to_its_home() {
        use std::net::TcpListener;
        // The home Hive: told to open a connection, it dials back and answers.
        let (tx, rx) = mpsc::channel::<String>();
        relay().homes.lock().unwrap().insert("testhome".into(), (u64::MAX, tx));
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let mut visitor = TcpStream::connect(addr).unwrap();
        let (public, _) = l.accept().unwrap();
        assert!(forward("testhome", public, 443));
        let open = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let id = open.split_whitespace().nth(1).unwrap().to_string();
        assert!(open.ends_with(" 443"));
        let mut home = TcpStream::connect(addr).unwrap();
        let (back, _) = l.accept().unwrap();
        std::thread::spawn(move || joined(&id, back));
        visitor.write_all(b"hello").unwrap();
        let mut got = [0u8; 5];
        home.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"hello");
        home.write_all(b"world").unwrap();
        visitor.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"world");
        assert!(!forward("nobody", TcpStream::connect(addr).unwrap(), 80));
        relay().homes.lock().unwrap().remove("testhome");
    }

    #[test]
    fn claims_a_name_once() {
        let d = std::env::temp_dir().join(format!("hive-relay-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let (a, b) = ("a".repeat(32), "b".repeat(32));
        assert!(admit(&d, "evan", &a).is_ok());
        assert!(admit(&d, "evan", &a).is_ok());
        assert_eq!(admit(&d, "evan", &b), Err("taken".into()));
        assert!(admit(&d, "relay", &a).is_err());
        std::fs::remove_dir_all(&d).ok();
    }
}
