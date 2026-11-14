//! The Hive Cloud HTTP API (cloud/hive-cloud/worker.js).
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

/// The code for an HTTP error whose body isn't Hive Cloud's JSON.
pub const NOT_HIVE: &str = "http_error";

#[derive(Debug)]
pub enum ApiError {
    /// No answer: offline, DNS, TLS or timeout. Safe to retry later.
    Offline(String),
    /// The server answered with an error.
    Http { status: u16, code: String, message: String },
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Offline(why) => write!(f, "Hive Cloud is unreachable ({why})"),
            ApiError::Http { status, code, message } => write!(f, "Hive Cloud refused ({status} {code}): {message}"),
        }
    }
}

impl ApiError {
    pub fn code(&self) -> &str {
        match self {
            ApiError::Offline(_) => "offline",
            ApiError::Http { code, .. } => code,
        }
    }
}

pub type Result<T> = std::result::Result<T, ApiError>;

pub struct PackResult {
    pub stored: usize,
    pub existing: usize,
    pub retry: Vec<String>,
}

pub struct Client {
    base: String,
    token: Option<String>,
    agent: ureq::Agent,
}

/// HTTPS only, except a loopback address for tests.
pub fn check_url(url: &str) -> std::result::Result<String, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    let loopback = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
    if !(url.starts_with("https://") || loopback) || url.contains('?') || url.contains('#') {
        return Err(format!("{url} is not an https:// Hive Cloud address"));
    }
    Ok(url)
}

impl Client {
    pub fn new(url: &str, token: Option<String>) -> std::result::Result<Client, String> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(180))
            .user_agent(concat!("hive-cloud/", env!("CARGO_PKG_VERSION")))
            .build();
        Ok(Client { base: check_url(url)?, token, agent })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn host(&self) -> String {
        self.base.split("://").nth(1).unwrap_or(&self.base).to_string()
    }

    fn request(&self, method: &str, path: &str) -> ureq::Request {
        let mut req = self.agent.request(method, &format!("{}{}", self.base, path));
        if let Some(token) = &self.token {
            req = req.set("authorization", &format!("Bearer {token}"));
        }
        req
    }

    fn finish(result: std::result::Result<ureq::Response, ureq::Error>) -> Result<ureq::Response> {
        match result {
            Ok(res) => Ok(res),
            Err(ureq::Error::Status(status, res)) => {
                let text = res.into_string().unwrap_or_default();
                let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                match body["error"].as_str() {
                    Some(code) => Err(ApiError::Http {
                        status,
                        code: code.to_string(),
                        message: body["message"].as_str().unwrap_or("").to_string(),
                    }),
                    // Not Hive Cloud's own answer: Cloudflare's edge (a Worker that hasn't reached
                    // every server yet, a limit) or something in between. Show what came back.
                    None => Err(ApiError::Http {
                        status,
                        code: NOT_HIVE.into(),
                        message: text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect(),
                    }),
                }
            }
            Err(ureq::Error::Transport(t)) => Err(ApiError::Offline(t.to_string())),
        }
    }

    fn json_of(res: ureq::Response) -> Result<Value> {
        let mut text = String::new();
        res.into_reader()
            .take(64 * 1024 * 1024)
            .read_to_string(&mut text)
            .map_err(|e| ApiError::Offline(format!("reading the answer: {e}")))?;
        let value: Value = serde_json::from_str(&text).map_err(|e| ApiError::Offline(format!("bad JSON from server: {e}")))?;
        if value["ok"] != json!(true) {
            return Err(ApiError::Http { status: 200, code: "not_ok".into(), message: text.chars().take(200).collect() });
        }
        Ok(value)
    }

    pub fn get(&self, path: &str) -> Result<Value> {
        Self::json_of(Self::finish(self.request("GET", path).call())?)
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value> {
        let res = self.request("POST", path).set("content-type", "application/json").send_string(&body.to_string());
        Self::json_of(Self::finish(res)?)
    }

    pub fn delete(&self, path: &str) -> Result<Value> {
        Self::json_of(Self::finish(self.request("DELETE", path).call())?)
    }

    pub fn put_blob(&self, hash: &str, bytes: &[u8]) -> Result<bool> {
        let res = self
            .request("PUT", &format!("/v1/blobs/{hash}"))
            .set("content-type", "application/octet-stream")
            .send_bytes(bytes);
        Ok(Self::json_of(Self::finish(res)?)?["stored"].as_bool().unwrap_or(false))
    }

    pub fn get_blob(&self, hash: &str) -> Result<Vec<u8>> {
        let res = Self::finish(self.request("GET", &format!("/v1/blobs/{hash}")).call())?;
        let mut out = Vec::new();
        res.into_reader()
            .take(4 * 1024 * 1024)
            .read_to_end(&mut out)
            .map_err(|e| ApiError::Offline(format!("reading a chunk: {e}")))?;
        Ok(out)
    }

    /// Upload many chunks in one request. A pack is chunks back to back: the 32-byte SHA-256,
    /// a 4-byte big-endian length, the bytes. The server may ask for some again (`retry`).
    pub fn put_pack(&self, items: &[(&str, &[u8])]) -> Result<PackResult> {
        let mut body = Vec::with_capacity(items.iter().map(|(_, b)| b.len() + 36).sum());
        for (hash, bytes) in items {
            let raw = crate::crypto::unhex(hash).filter(|r| r.len() == 32).ok_or_else(|| ApiError::Http {
                status: 0,
                code: "bad_hash".into(),
                message: format!("{hash} is not a SHA-256"),
            })?;
            body.extend_from_slice(&raw);
            body.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            body.extend_from_slice(bytes);
        }
        let res = self.request("PUT", "/v1/packs").set("content-type", "application/octet-stream").send_bytes(&body);
        let v = Self::json_of(Self::finish(res)?)?;
        Ok(PackResult {
            stored: v["stored"].as_u64().unwrap_or(0) as usize,
            existing: v["existing"].as_u64().unwrap_or(0) as usize,
            retry: v["retry"].as_array().into_iter().flatten().filter_map(|h| h.as_str().map(String::from)).collect(),
        })
    }

    /// Download chunks by hash. The answer holds those that fit in 8 MiB, in the order asked;
    /// ask again for the rest. Unknown hashes are left out.
    pub fn get_pack(&self, hashes: &[String]) -> Result<Vec<(String, Vec<u8>)>> {
        let res = Self::finish(
            self.request("POST", "/v1/packs/get")
                .set("content-type", "application/json")
                .send_string(&json!({ "hashes": hashes }).to_string()),
        )?;
        let mut buf = Vec::new();
        res.into_reader()
            .take(16 * 1024 * 1024)
            .read_to_end(&mut buf)
            .map_err(|e| ApiError::Offline(format!("reading chunks: {e}")))?;
        let mut out = Vec::new();
        let mut i = 0;
        while i < buf.len() {
            let bad = || ApiError::Offline("the chunk pack from the server is cut short".into());
            let head = buf.get(i..i + 36).ok_or_else(bad)?;
            let len = u32::from_be_bytes([head[32], head[33], head[34], head[35]]) as usize;
            let bytes = buf.get(i + 36..i + 36 + len).ok_or_else(bad)?;
            out.push((crate::crypto::hex(&head[..32]), bytes.to_vec()));
            i += 36 + len;
        }
        Ok(out)
    }

    pub fn missing(&self, hashes: &[String]) -> Result<Vec<String>> {
        let mut missing = Vec::new();
        for group in hashes.chunks(1000) {
            let res = self.post("/v1/blobs/missing", &json!({ "hashes": group }))?;
            missing.extend(res["missing"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)));
        }
        Ok(missing)
    }
}
