//! Deploying Hive Cloud into the owner's own Cloudflare account through the Cloudflare API, with
//! an API token the owner creates (template "Edit Cloudflare Workers"). Nothing else is needed:
//! no Node, no wrangler, no server.
//!
//! What it creates: one Worker (cloud/hive-cloud/worker.js) with two SQLite Durable Object
//! classes, its workers.dev address, and, when R2 is enabled on the account, one R2 bucket for
//! the encrypted chunks.
use crate::crypto;
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;

pub const WORKER_JS: &str = include_str!("../../../../../../cloud/hive-cloud/worker.js");
const API: &str = "https://api.cloudflare.com/client/v4";
const COMPATIBILITY_DATE: &str = "2026-07-31";

pub struct Cloudflare {
    token: String,
    agent: ureq::Agent,
}

pub struct Account {
    pub id: String,
    pub name: String,
}

pub struct Plan {
    pub account: Account,
    pub script: String,
    pub bucket: Option<String>,
    pub exists: bool,
    pub subdomain: Option<String>,
}

impl Plan {
    pub fn url(&self) -> Option<String> {
        self.subdomain.as_ref().map(|s| format!("https://{}.{s}.workers.dev", self.script))
    }

    /// What will be created and what it costs, shown before anything is created.
    pub fn describe(&self) -> String {
        let mut out = format!("Cloudflare account: {}\n", self.account.name);
        out += &format!(
            "Worker: {} at {}\n",
            self.script,
            self.url().unwrap_or_else(|| format!("https://{}.<new workers.dev name>.workers.dev", self.script))
        );
        match &self.bucket {
            Some(b) => {
                out += &format!("R2 bucket for encrypted chunks: {b}\n");
                out += "Cost: requests are covered by Workers Paid ($5/month) and fit Workers Free for light use.\n";
                out += "      R2 storage: first 10 GB-month free, then $0.015 per GB-month; no charge for downloads.\n";
            }
            None => {
                out += "Storage: SQLite Durable Objects (R2 is not enabled on this account).\n";
                out += "Cost: Workers Free holds up to 4 GB here; Workers Paid includes 5 GB-month, then $0.20 per GB-month.\n";
            }
        }
        out += "Everything stored is encrypted on your devices first; Cloudflare holds only ciphertext.\n";
        out
    }
}

impl Cloudflare {
    pub fn new(token: String) -> Cloudflare {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent(concat!("hive-cloud/", env!("CARGO_PKG_VERSION")))
            .build();
        Cloudflare { token: token.trim().to_string(), agent }
    }

    fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, (u16, String)> {
        let req = self.agent.request(method, &format!("{API}{path}")).set("authorization", &format!("Bearer {}", self.token));
        let res = match body {
            Some(b) => req.set("content-type", "application/json").send_string(&b.to_string()),
            None => req.call(),
        };
        Self::answer(res)
    }

    fn answer(res: Result<ureq::Response, ureq::Error>) -> Result<Value, (u16, String)> {
        let (status, text) = match res {
            Ok(r) => (r.status(), read(r)),
            Err(ureq::Error::Status(s, r)) => (s, read(r)),
            Err(ureq::Error::Transport(t)) => return Err((0, format!("Cloudflare is unreachable: {t}"))),
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if v["success"] == json!(true) {
            return Ok(v);
        }
        let errors: Vec<String> = v["errors"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| format!("{} ({})", e["message"].as_str().unwrap_or("error"), e["code"]))
            .collect();
        Err((status, if errors.is_empty() { format!("HTTP {status}") } else { errors.join("; ") }))
    }

    pub fn accounts(&self) -> Result<Vec<Account>, String> {
        let v = self.call("GET", "/accounts?per_page=50", None).map_err(|(_, e)| format!("listing accounts: {e}"))?;
        Ok(v["result"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| Some(Account { id: a["id"].as_str()?.into(), name: a["name"].as_str().unwrap_or("").into() }))
            .collect())
    }

    pub fn subdomain(&self, account: &str) -> Result<Option<String>, String> {
        match self.call("GET", &format!("/accounts/{account}/workers/subdomain"), None) {
            Ok(v) => Ok(v["result"]["subdomain"].as_str().filter(|s| !s.is_empty()).map(String::from)),
            Err((404, _)) => Ok(None),
            Err((_, e)) if e.contains("10007") => Ok(None),
            Err((_, e)) => Err(format!("reading the workers.dev name: {e}")),
        }
    }

    pub fn script_exists(&self, account: &str, script: &str) -> Result<bool, String> {
        match self.call("GET", &format!("/accounts/{account}/workers/scripts/{script}/settings"), None) {
            Ok(_) => Ok(true),
            Err((404, _)) => Ok(false),
            Err((_, e)) => Err(format!("checking for an existing Worker: {e}")),
        }
    }

    /// Ok(true) when the bucket is there or was created; Ok(false) when R2 is not enabled.
    pub fn ensure_bucket(&self, account: &str, bucket: &str) -> Result<bool, String> {
        if self.call("GET", &format!("/accounts/{account}/r2/buckets/{bucket}"), None).is_ok() {
            return Ok(true);
        }
        match self.call("POST", &format!("/accounts/{account}/r2/buckets"), Some(&json!({ "name": bucket }))) {
            Ok(_) => Ok(true),
            Err((_, e)) if e.contains("10042") || e.to_lowercase().contains("enable r2") => Ok(false),
            Err((_, e)) => Err(format!("creating R2 bucket {bucket}: {e}")),
        }
    }

    pub fn r2_enabled(&self, account: &str) -> bool {
        self.call("GET", &format!("/accounts/{account}/r2/buckets?per_page=1"), None).is_ok()
    }

    /// Upload the Worker. A new Worker gets its Durable Object classes and the claim hash; an
    /// update replaces the code and keeps the secret and all data.
    pub fn upload(&self, account: &str, script: &str, bucket: Option<&str>, claim_hash: Option<&str>) -> Result<(), String> {
        let mut bindings = vec![
            json!({ "type": "durable_object_namespace", "name": "ACCOUNT", "class_name": "Account" }),
            json!({ "type": "durable_object_namespace", "name": "SHARD", "class_name": "BlobShard" }),
        ];
        if let Some(b) = bucket {
            bindings.push(json!({ "type": "r2_bucket", "name": "BLOBS", "bucket_name": b }));
        }
        let mut metadata = json!({ "main_module": "worker.js", "compatibility_date": COMPATIBILITY_DATE, "bindings": bindings });
        match claim_hash {
            Some(hash) => {
                metadata["bindings"].as_array_mut().unwrap().push(json!({ "type": "secret_text", "name": "CLAIM_HASH", "text": hash }));
                metadata["migrations"] = json!({ "new_tag": "v1", "new_sqlite_classes": ["Account", "BlobShard"] });
            }
            None => metadata["keep_bindings"] = json!(["secret_text"]),
        }
        let boundary = format!("hive{}", crypto::hex(&crypto::random::<12>()));
        let mut body = Vec::new();
        let mut part = |name: &str, filename: Option<&str>, kind: &str, data: &[u8]| {
            body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"").as_bytes());
            if let Some(f) = filename {
                body.extend_from_slice(format!("; filename=\"{f}\"").as_bytes());
            }
            body.extend_from_slice(format!("\r\nContent-Type: {kind}\r\n\r\n").as_bytes());
            body.extend_from_slice(data);
            body.extend_from_slice(b"\r\n");
        };
        part("metadata", None, "application/json", metadata.to_string().as_bytes());
        part("worker.js", Some("worker.js"), "application/javascript+module", WORKER_JS.as_bytes());
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        let res = self
            .agent
            .put(&format!("{API}/accounts/{account}/workers/scripts/{script}"))
            .set("authorization", &format!("Bearer {}", self.token))
            .set("content-type", &format!("multipart/form-data; boundary={boundary}"))
            .send_bytes(&body);
        Self::answer(res).map(|_| ()).map_err(|(_, e)| format!("uploading the Worker: {e}"))
    }

    pub fn enable_workers_dev(&self, account: &str, script: &str) -> Result<(), String> {
        self.call("POST", &format!("/accounts/{account}/workers/scripts/{script}/subdomain"), Some(&json!({ "enabled": true, "previews_enabled": false })))
            .map(|_| ())
            .map_err(|(_, e)| format!("turning on the workers.dev address: {e}"))
    }

    pub fn delete_script(&self, account: &str, script: &str) -> Result<(), String> {
        self.call("DELETE", &format!("/accounts/{account}/workers/scripts/{script}?force=true"), None)
            .map(|_| ())
            .map_err(|(_, e)| format!("deleting the Worker: {e}"))
    }
}

fn read(res: ureq::Response) -> String {
    let mut text = String::new();
    let _ = res.into_reader().take(4 * 1024 * 1024).read_to_string(&mut text);
    text
}

/// Wait until a new Worker answers its health check (a new workers.dev name can take a minute).
/// One answer isn't enough: a new Worker reaches Cloudflare's servers one by one, so it waits for
/// several in a row.
pub fn wait_healthy(url: &str, timeout: Duration) -> Result<Value, String> {
    let api = crate::api::Client::new(url, None)?;
    let start = std::time::Instant::now();
    let mut good = 0;
    loop {
        match api.get("/v1/health") {
            Ok(v) if v["service"] == "hive-cloud" => {
                good += 1;
                if good >= 5 {
                    return Ok(v);
                }
                std::thread::sleep(Duration::from_secs(2));
            }
            Ok(_) | Err(_) if start.elapsed() < timeout => {
                good = 0;
                std::thread::sleep(Duration::from_secs(3));
            }
            Ok(v) => return Err(format!("{url} answered, but not as a Hive Cloud: {v}")),
            Err(e) => return Err(format!("{url} did not come up: {e}")),
        }
    }
}
