//! HTTPS on the VM's public address, with a Let's Encrypt certificate (ACME, RFC 8555) the server gets and renews
//! itself. Port 80 answers Let's Encrypt's checks and sends everything else to HTTPS. It runs only when the state folder
//! holds a `host` file (the public address or name), which is written once the owner agrees to Let's Encrypt's terms.
use crate::http::{self, Req, Res};
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
use std::net::{IpAddr, TcpListener};
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

pub fn start(host: String, dir: PathBuf, handler: Handler) {
    std::fs::create_dir_all(&dir).ok();
    let current = Arc::new(Current(RwLock::new(load(&dir))));
    let tokens: Arc<Mutex<HashMap<String, String>>> = Default::default();

    let (h, t) = (host.clone(), tokens.clone());
    std::thread::spawn(move || listen("0.0.0.0:80", move |mut s| {
        let res = match http::parse(&mut s, 1 << 16) {
            Some(r) => match r.path.strip_prefix("/.well-known/acme-challenge/").and_then(|k| t.lock().unwrap().get(k).cloned()) {
                Some(answer) => Res::new(200, "text/plain", answer),
                None => Res::new(301, "text/plain", "").header("Location", &format!("https://{h}{}", r.path)),
            },
            None => Res::err(400, "bad request"),
        };
        http::write(&mut s, &res).ok();
    }));

    let (cur, d) = (current.clone(), dir.clone());
    std::thread::spawn(move || loop {
        if due(&host, &d) {
            match issue(&host, &d, &tokens) {
                Ok(()) => { *cur.0.write().unwrap() = load(&d); eprintln!("certificate for {host} renewed") }
                Err(e) => eprintln!("certificate: {e}"),
            }
        }
        std::thread::sleep(Duration::from_secs(3600));
    });

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = Arc::new(rustls::ServerConfig::builder_with_provider(provider).with_safe_default_protocol_versions()
        .expect("tls versions").with_no_client_auth().with_cert_resolver(current));
    std::thread::spawn(move || listen("0.0.0.0:443", move |s| {
        let Ok(conn) = rustls::ServerConnection::new(config.clone()) else { return };
        http::handle(rustls::StreamOwned::new(conn, s), &*handler);
    }));
}

fn listen(addr: &str, each: impl Fn(std::net::TcpStream) + Send + Sync + 'static) {
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
            if s == "invalid" { return Err(format!("Let's Encrypt said no: {}", v)) }
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
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, data).map_err(|e| e.to_string())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
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
