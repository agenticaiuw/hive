//! Hive's address: HTTPS on this computer's public address, the same on a VM or a laptop at home. Hive finds the address
//! itself (STUN), asks a home router to send ports 80 and 443 to this computer (UPnP; a VM has no router and skips it), and
//! gets a Let's Encrypt certificate (ACME, RFC 8555) for the address, renewing it and following the address when it changes.
//! Port 80 answers Let's Encrypt's checks and sends everything else to HTTPS. When Let's Encrypt can't reach it, `why` says
//! exactly what to do, from what it found: a cloud VM's closed firewall, a router to open, or a provider sharing one address.
//! A Hive at home that the internet can't reach goes through the club's relay instead (relay.rs), and the relay runs here too.
use crate::http::{self, Req, Res};
use crate::relay;
use hive_protocol::b64;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime};

const DIRECTORY: &str = "https://acme-v02.api.letsencrypt.org/directory";
type Handler = Arc<dyn Fn(Req) -> Res + Send + Sync>;

#[derive(Debug)]
struct Current(RwLock<Option<Arc<CertifiedKey>>>);
impl ResolvesServerCert for Current {
    fn resolve(&self, _: ClientHello) -> Option<Arc<CertifiedKey>> { self.0.read().unwrap().clone() }
}

/// This Hive's address, once it has a certificate for it.
pub fn address(state: &Path) -> Option<String> {
    let host = std::fs::read_to_string(state.join("host")).ok()?;
    state.join("tls").join("cert.pem").exists().then(|| format!("https://{}", host.trim()))
}

/// What to do when the internet can't reach this computer, once Let's Encrypt has said so.
pub fn why(state: &Path) -> Option<String> { std::fs::read_to_string(state.join("tls").join("why")).ok() }

pub fn start(state: PathBuf, handler: Handler) {
    let dir = state.join("tls");
    std::fs::create_dir_all(&dir).ok();
    let current = Arc::new(Current(RwLock::new(load(&dir))));
    let tokens: Arc<Mutex<HashMap<String, String>>> = Default::default();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = Arc::new(rustls::ServerConfig::builder_with_provider(provider).with_safe_default_protocol_versions()
        .expect("tls versions").with_no_client_auth().with_cert_resolver(current.clone()));
    // What a connection gets, whether it came in directly or down the relay.
    let serve: Arc<dyn Fn(TcpStream, u16) + Send + Sync> = {
        let (t, config, handler) = (tokens.clone(), config.clone(), handler.clone());
        Arc::new(move |s, port| if port == 80 { plain(s, &t) } else { secure(s, &config, &handler) })
    };
    let relay_domain = relay::serving();

    let (sv, rd) = (serve.clone(), relay_domain.clone());
    std::thread::spawn(move || listen("0.0.0.0:80", move |s| {
        if let Some(name) = rd.as_ref().and_then(|d| relay::http_host(&s).and_then(|h| relay::home_name(&h, d))) {
            let Ok(mut back) = s.try_clone() else { return };
            if !relay::forward(&name, s, 80) { http::write(&mut back, &Res::err(502, &format!("{name}'s Hive isn't connected right now."))).ok(); }
            return;
        }
        sv(s, 80)
    }));

    let (cur, file, home) = (current.clone(), state.join("host"), serve.clone());
    std::thread::spawn(move || {
        // A Hive at home the internet can't reach goes through the relay from then on (relay.rs).
        let mut relayed = relay::name(&state).is_some();
        let mut joined: Option<String> = None;
        loop {
            let mut router = None;
            let old = std::fs::read_to_string(&file).unwrap_or_default().trim().to_string();
            let host = if relayed {
                if joined.is_none() {
                    match relay::connect(&state, home.clone()) {
                        Ok(n) => joined = Some(n),
                        Err(e) => { std::fs::write(dir.join("why"), format!("{e}\nHive tries again every few minutes.\n")).ok(); std::thread::sleep(Duration::from_secs(300)); continue }
                    }
                }
                format!("{}.{}", joined.as_deref().unwrap_or(""), relay::domain())
            } else {
                router = open_ports();
                public_ip().unwrap_or(old.clone())
            };
            if host != old { std::fs::write(&file, &host).ok(); std::fs::remove_file(dir.join("cert.pem")).ok(); }
            if !host.is_empty() && due(&host, &dir) {
                match issue(&host, &dir, &tokens) {
                    Ok(()) => { *cur.0.write().unwrap() = load(&dir); std::fs::remove_file(dir.join("why")).ok(); eprintln!("certificate for {host} renewed") }
                    Err(e) if !relayed && !cloud() => { eprintln!("certificate: {e}; the internet can't reach {host}, so going through the relay"); relayed = true; continue }
                    Err(e) => { eprintln!("certificate: {e}"); std::fs::write(dir.join("why"), guide(&host, router, &e)).ok(); }
                }
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });

    std::thread::spawn(move || listen("0.0.0.0:443", move |mut s| {
        if let Some(d) = &relay_domain {
            match relay::arrival(&mut s) {
                relay::Arrival::Back(id) => return relay::joined(&id, s),
                relay::Arrival::Tls(Some(sni)) => if let Some(name) = relay::home_name(&sni, d) { relay::forward(&name, s, 443); return },
                _ => {}
            }
        }
        serve(s, 443)
    }));
}

/// Port 80: Let's Encrypt's checks, and everything else sent to HTTPS.
fn plain(mut s: TcpStream, tokens: &Mutex<HashMap<String, String>>) {
    let res = match http::parse(&mut s, 1 << 16) {
        Some(r) => match r.path.strip_prefix("/.well-known/acme-challenge/").and_then(|k| tokens.lock().unwrap().get(k).cloned()) {
            Some(answer) => Res::new(200, "text/plain", answer),
            None => Res::new(301, "text/plain", "").header("Location",
                &format!("https://{}{}", r.headers.get("host").map(String::as_str).unwrap_or(""), r.path)),
        },
        None => Res::err(400, "bad request"),
    };
    http::write(&mut s, &res).ok();
}

/// Port 443: the dashboard and API over HTTPS.
fn secure(s: TcpStream, config: &Arc<rustls::ServerConfig>, handler: &Handler) {
    let (Ok(conn), Ok(socket)) = (rustls::ServerConnection::new(config.clone()), s.try_clone()) else { return };
    http::handle(rustls::StreamOwned::new(conn, s), socket, &**handler);
}

/// Every big cloud answers on this address inside its VMs; a home network doesn't.
fn cloud() -> bool { std::net::TcpStream::connect_timeout(&"169.254.169.254:80".parse().unwrap(), Duration::from_secs(1)).is_ok() }

/// This computer's address as the internet sees it, from a STUN server (RFC 8489).
fn public_ip() -> Option<String> {
    let server = ("stun.l.google.com", 19302).to_socket_addrs().ok()?.find(|a| a.is_ipv4())?;
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    let mut req = [0u8; 20];
    req[1] = 1;
    req[4..8].copy_from_slice(&[0x21, 0x12, 0xa4, 0x42]);
    req[8..].copy_from_slice(crate::api::random(6).as_bytes());
    s.send_to(&req, server).ok()?;
    let mut b = [0u8; 512];
    let n = s.recv(&mut b).ok()?;
    let mut i = 20;
    while i + 4 <= n {
        let (kind, len) = (u16::from_be_bytes([b[i], b[i + 1]]), u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize);
        let v = b.get(i + 4..i + 4 + len)?;
        if kind == 0x20 && len >= 8 && v[1] == 1 { return Some(format!("{}.{}.{}.{}", v[4] ^ 0x21, v[5] ^ 0x12, v[6] ^ 0xa4, v[7] ^ 0x42)) }
        i += 4 + len.div_ceil(4) * 4;
    }
    None
}

/// What a home router said to UPnP: its own internet address, and why it wouldn't send the ports here, if it wouldn't.
struct Router { gateway: String, wan: String, refused: String }

/// Asks a home router to send ports 80 and 443 to this computer, for two hours (asked again every hour). None when no
/// router answered: a VM has none, and a home router may have UPnP off.
fn open_ports() -> Option<Router> {
    let gw = igd_next::search_gateway(igd_next::SearchOptions { timeout: Some(Duration::from_secs(3)), ..Default::default() }).ok()?;
    let local = UdpSocket::bind("0.0.0.0:0").ok().filter(|s| s.connect(gw.addr).is_ok()).and_then(|s| s.local_addr().ok())?;
    let mut refused = String::new();
    for port in [80, 443] {
        if let Err(e) = gw.add_port(igd_next::PortMappingProtocol::TCP, port, SocketAddr::new(local.ip(), port), 7200, "Hive") { refused = e.to_string() }
    }
    Some(Router { gateway: gw.addr.ip().to_string(), wan: gw.get_external_ip().map(|i| i.to_string()).unwrap_or_default(), refused })
}

/// Step by step, what to do when Let's Encrypt couldn't reach this computer at `host`.
fn guide(host: &str, router: Option<Router>, error: &str) -> String {
    let local = UdpSocket::bind("0.0.0.0:0").ok().filter(|s| s.connect("1.1.1.1:80").is_ok()).and_then(|s| s.local_addr().ok())
        .map(|a| a.ip().to_string()).unwrap_or_else(|| "this computer".into());
    let cloud = cloud();
    let again = if cfg!(target_os = "linux") { "Run sudo ./hive-server again" } else { "Open hive-server again" };
    let open = "allow incoming TCP on ports 80 and 443 from anywhere (0.0.0.0/0). Oracle Cloud: Networking > Virtual cloud networks > \
        the VM's network > Security Lists > Default Security List > Add Ingress Rules. AWS: EC2 > Security Groups > the VM's group > \
        Edit inbound rules. Google Cloud: VPC network > Firewall > Create firewall rule. Azure: the VM > Networking > Add inbound port rule.";
    let vm = format!("1. Make an Ubuntu VM with a public IPv4 address at a cloud provider (Oracle Cloud's Always Free tier is enough).\n\
        2. In the provider's console, for that VM, {open}\n\
        3. On the VM, run: curl -fLo hive-server {}/hive-server-linux-$(uname -m) && chmod +x hive-server && sudo ./hive-server\n\
        4. Then take Hive off this computer: {}", hive_protocol::RELEASES,
        if cfg!(target_os = "macos") { "launchctl unload -w ~/Library/LaunchAgents/app.hive.server.plist" } else { "sudo systemctl disable --now hive-server" });
    let steps = match router {
        _ if cloud => format!("This is a cloud VM, and its provider's firewall keeps the internet out:\n1. In the provider's console, for this VM, {open}\n2. {again}."),
        Some(r) if !r.wan.is_empty() && r.wan != host => format!("The router's internet address is {}, but the internet sees {host}: the provider \
            shares one address among many homes, or another router (often the provider's modem) sits in front of this one. Run Hive on a cloud \
            VM instead:\n{vm}", r.wan),
        Some(r) if r.refused.is_empty() => format!("The router opened ports 80 and 443 to {local}, so the internet provider blocks them. Run Hive on a cloud VM instead:\n{vm}"),
        r => format!("To keep Hive on this computer:\n\
            1. On a device on this network, open http://{} (the router) and sign in; the password is often on the router's label.\n\
            2. {} forward TCP ports 80 and 443 to {local} (often under Advanced, NAT or Port forwarding).\n\
            3. {again}.\n\
            If it still can't be reached, the provider blocks those ports or shares one address among many homes. A cloud VM always works, \
            and it's safer, since nothing at home is opened to the internet:\n{vm}",
            r.as_ref().map_or_else(|| gateway().unwrap_or_else(|| "192.168.1.1".into()), |r| r.gateway.clone()),
            r.as_ref().map_or("Turn on UPnP, or".into(), |r| format!("The router wouldn't open the ports itself ({}), so", r.refused))),
    };
    format!("The internet can't reach this computer at {host} on ports 80 and 443, so Hive can't get its secure address yet.\n\
        Let's Encrypt said: {error}\n\n{steps}\n")
}

/// The router's address on this network, from the default route.
fn gateway() -> Option<String> {
    let (cmd, args): (&str, &[&str]) = if cfg!(target_os = "macos") { ("route", &["-n", "get", "default"]) } else { ("ip", &["route", "show", "default"]) };
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    let out = String::from_utf8_lossy(&out.stdout);
    let mut w = out.split_whitespace();
    w.find(|x| *x == "via" || *x == "gateway:")?;
    w.next().map(String::from)
}

fn listen(addr: &str, each: impl Fn(TcpStream) + Send + Sync + 'static) {
    let Ok(l) = TcpListener::bind(addr) else { return eprintln!("can't listen on {addr}") };
    let each = Arc::new(each);
    for s in l.incoming().flatten() {
        s.set_read_timeout(Some(Duration::from_secs(60))).ok();
        let each = each.clone();
        std::thread::spawn(move || each(s));
    }
}

fn load(dir: &Path) -> Option<Arc<CertifiedKey>> {
    let certs = CertificateDer::pem_file_iter(dir.join("cert.pem")).ok()?.collect::<Result<Vec<_>, _>>().ok()?;
    let key = PrivateKeyDer::from_pem_file(dir.join("key.pem")).ok()?;
    Some(Arc::new(CertifiedKey::new(certs, rustls::crypto::ring::sign::any_supported_type(&key).ok()?)))
}

/// Address certificates last under a week, so renew those after 3 days; name certificates after 30.
fn due(host: &str, dir: &Path) -> bool {
    let days = if host.parse::<IpAddr>().is_ok() { 3 } else { 30 };
    std::fs::metadata(dir.join("cert.pem")).and_then(|m| m.modified()).ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok()).map_or(true, |age| age > Duration::from_secs(days * 86400))
}

fn u(d: &[u8]) -> String { b64::encode(d).replace('+', "-").replace('/', "_").trim_end_matches('=').to_string() }

struct Acme { key: EcdsaKeyPair, rng: SystemRandom, kid: String, nonce: String }

impl Acme {
    fn jwk(&self) -> Value {
        let p = self.key.public_key().as_ref();
        json!({ "crv": "P-256", "kty": "EC", "x": u(&p[1..33]), "y": u(&p[33..65]) })
    }
    /// The answer to an http-01 check: the token and this account key's thumbprint (RFC 7638: members in order, no spaces).
    fn answer(&self, token: &str) -> String {
        let j = self.jwk();
        let canon = format!(r#"{{"crv":"P-256","kty":"EC","x":{},"y":{}}}"#, j["x"], j["y"]);
        format!("{token}.{}", u(&Sha256::digest(canon)))
    }
    /// A signed request; `None` is POST-as-GET. Returns the body (JSON when it is JSON), the Location header and the raw text.
    fn post(&mut self, url: &str, payload: Option<&Value>) -> Result<(Value, String, String), String> {
        for attempt in 0..2 {
            let mut protected = json!({ "alg": "ES256", "nonce": self.nonce, "url": url });
            if self.kid.is_empty() { protected["jwk"] = self.jwk() } else { protected["kid"] = json!(self.kid) }
            let (p, pl) = (u(protected.to_string().as_bytes()), payload.map(|v| u(v.to_string().as_bytes())).unwrap_or_default());
            let sig = self.key.sign(&self.rng, format!("{p}.{pl}").as_bytes()).map_err(|_| "couldn't sign")?;
            let body = json!({ "protected": p, "payload": pl, "signature": u(sig.as_ref()) }).to_string();
            let r = match ureq::post(url).timeout(Duration::from_secs(30)).set("content-type", "application/jose+json").send_string(&body) {
                Ok(r) | Err(ureq::Error::Status(_, r)) => r,
                Err(e) => return Err(e.to_string()),
            };
            let status = r.status();
            if let Some(n) = r.header("replay-nonce") { self.nonce = n.into() }
            let loc = r.header("location").unwrap_or("").to_string();
            let text = r.into_string().map_err(|e| e.to_string())?;
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if status < 300 { return Ok((v, loc, text)) }
            if attempt == 0 && v["type"] == "urn:ietf:params:acme:error:badNonce" { continue }
            return Err(format!("{status} {}", v["detail"].as_str().unwrap_or(&text)));
        }
        Err("Let's Encrypt kept refusing the request".into())
    }
    /// Ask again until `status` is one of `done`, for up to two minutes.
    fn until(&mut self, url: &str, done: &[&str]) -> Result<Value, String> {
        for _ in 0..60 {
            let (v, _, _) = self.post(url, None)?;
            let s = v["status"].as_str().unwrap_or("");
            if done.contains(&s) { return Ok(v) }
            if s == "invalid" {
                let why = v["challenges"].as_array().into_iter().flatten().chain([&v]).find_map(|c| c["error"]["detail"].as_str());
                return Err(why.unwrap_or("it couldn't check this address").to_string());
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        Err(format!("Let's Encrypt didn't finish checking {url}"))
    }
}

fn issue(host: &str, dir: &Path, tokens: &Mutex<HashMap<String, String>>) -> Result<(), String> {
    let get = |url: &str| ureq::get(url).timeout(Duration::from_secs(30)).call().map_err(|e| e.to_string());
    let d: Value = serde_json::from_str(&get(DIRECTORY)?.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let nonce = ureq::head(d["newNonce"].as_str().unwrap_or("")).call().map_err(|e| e.to_string())?
        .header("replay-nonce").unwrap_or("").to_string();
    let rng = SystemRandom::new();
    let account = dir.join("account.p8");
    if !account.exists() {
        let k = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).map_err(|_| "couldn't make a key")?;
        write_private(&account, k.as_ref())?;
    }
    let p8 = std::fs::read(&account).map_err(|e| e.to_string())?;
    let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &p8, &rng).map_err(|_| "unreadable account key")?;
    let mut acme = Acme { key, rng, kid: String::new(), nonce };
    acme.kid = acme.post(d["newAccount"].as_str().unwrap_or(""), Some(&json!({ "termsOfServiceAgreed": true })))?.1;

    let ip = host.parse::<IpAddr>().ok();
    let mut want = json!({ "identifiers": [{ "type": if ip.is_some() { "ip" } else { "dns" }, "value": host }] });
    if ip.is_some() { want["profile"] = json!("shortlived") }
    let (order, order_url, _) = acme.post(d["newOrder"].as_str().unwrap_or(""), Some(&want))?;
    for a in order["authorizations"].as_array().cloned().unwrap_or_default() {
        let a = a.as_str().unwrap_or("");
        let (authz, _, _) = acme.post(a, None)?;
        if authz["status"] == "valid" { continue }
        let ch = authz["challenges"].as_array().and_then(|c| c.iter().find(|c| c["type"] == "http-01")).cloned()
            .ok_or("Let's Encrypt offered no http-01 check")?;
        let token = ch["token"].as_str().unwrap_or("").to_string();
        tokens.lock().unwrap().insert(token.clone(), acme.answer(&token));
        acme.post(ch["url"].as_str().unwrap_or(""), Some(&json!({})))?;
        acme.until(a, &["valid"])?;
    }
    tokens.lock().unwrap().clear();

    let cert_key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let mut params = rcgen::CertificateParams::default();
    params.distinguished_name = rcgen::DistinguishedName::new();
    params.subject_alt_names = vec![match ip {
        Some(ip) => rcgen::SanType::IpAddress(ip),
        None => rcgen::SanType::DnsName(host.try_into().map_err(|_| format!("{host} isn't a name"))?),
    }];
    let csr = params.serialize_request(&cert_key).map_err(|e| e.to_string())?;
    acme.post(order["finalize"].as_str().unwrap_or(""), Some(&json!({ "csr": u(csr.der()) })))?;
    let done = acme.until(&order_url, &["valid"])?;
    let (_, _, pem) = acme.post(done["certificate"].as_str().unwrap_or(""), None)?;
    write_private(&dir.join("key.pem"), cert_key.serialize_pem().as_bytes())?;
    std::fs::write(dir.join("cert.pem"), pem).map_err(|e| e.to_string())
}

fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    crate::private(path, data);
    if path.exists() { Ok(()) } else { Err(format!("couldn't write {}", path.display())) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loads_a_certificate_and_answers_checks() {
        let dir = std::env::temp_dir().join(format!("hive-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let k = rcgen::KeyPair::generate().unwrap();
        let c = rcgen::CertificateParams::new(vec!["localhost".into()]).unwrap().self_signed(&k).unwrap();
        std::fs::write(dir.join("cert.pem"), c.pem()).unwrap();
        std::fs::write(dir.join("key.pem"), k.serialize_pem()).unwrap();
        assert!(load(&dir).is_some());
        assert!(!due("localhost", &dir) && !due("192.0.2.1", &dir));
        std::fs::remove_dir_all(&dir).ok();

        let rng = SystemRandom::new();
        let p8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, p8.as_ref(), &rng).unwrap();
        let a = Acme { key, rng, kid: String::new(), nonce: String::new() };
        let answer = a.answer("tok");
        assert!(answer.starts_with("tok.") && answer.len() == 4 + 43 && !answer.contains(['+', '/', '=']));
    }
}
