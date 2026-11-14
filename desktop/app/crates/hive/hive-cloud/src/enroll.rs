//! Connecting a device to a Hive Cloud: the owner's first device claims it, later devices join
//! with an invite from an enrolled device or with the recovery code.
use crate::api::Client;
use crate::config::{device_name, now_ms, platform, Config, Secrets};
use crate::crypto::{self, CodeKeys, Keys};
use crate::sync::{host_of, Engine};
use serde_json::{json, Value};

const CODE_BYTES: usize = 20;

fn device() -> Value {
    json!({ "name": device_name(), "platform": platform() })
}

fn refuse_if_connected() -> Result<(), String> {
    if let Some(existing) = Config::load()? {
        return Err(format!(
            "This device is already connected to {}. Run `hive-cloud disconnect` first to connect it elsewhere.",
            existing.url
        ));
    }
    Ok(())
}

fn save(url: &str, res: &Value, keys: &Keys) -> Result<Config, String> {
    let token = res["token"].as_str().ok_or("the cloud sent no device token")?;
    let device_id = res["deviceId"].as_str().ok_or("the cloud sent no device ID")?;
    let host = host_of(url);
    let secrets = Secrets::system();
    secrets.set(&host, "device-token", token)?;
    secrets.set(&host, "account-key", &crypto::hex(keys.master()))?;
    let config = Config {
        url: url.to_string(),
        device_id: device_id.to_string(),
        device_name: device_name(),
        key_check: keys.check().to_string(),
        enrolled_at: now_ms(),
    };
    config.save()?;
    Ok(config)
}

/// Become the owner of a freshly deployed Hive Cloud. Returns the recovery code, which is shown
/// once and never stored anywhere.
pub fn claim(url: &str, claim_secret: &str) -> Result<(Config, String), String> {
    refuse_if_connected()?;
    let api = Client::new(url, None)?;
    let keys = Keys::generate();
    let recovery = crypto::random::<CODE_BYTES>();
    let wrap = CodeKeys::from_secret(&recovery, "recovery");
    let res = api
        .post(
            "/v1/claim",
            &json!({
                "claimSecret": claim_secret, "keyCheck": keys.check(), "recoveryAuth": wrap.auth,
                "recoveryWrappedKey": wrap.wrap_key(&keys), "device": device(),
            }),
        )
        .map_err(|e| e.to_string())?;
    let config = save(api.base(), &res, &keys)?;
    Ok((config, crypto::grouped(&crypto::base32(&recovery))))
}

/// A one-use link another device can join with, valid for `ttl_seconds`.
pub fn invite(engine: &Engine, ttl_seconds: u64) -> Result<(String, i64), String> {
    let secret = crypto::random::<CODE_BYTES>();
    let wrap = CodeKeys::from_secret(&secret, "invite");
    let res = engine
        .api
        .post("/v1/invites", &json!({ "inviteAuth": wrap.auth, "wrappedKey": wrap.wrap_key(&engine.keys), "ttlSeconds": ttl_seconds }))
        .map_err(|e| e.to_string())?;
    let link = format!("{}/#join={}", engine.api.base(), crypto::grouped(&crypto::base32(&secret)));
    Ok((link, res["expiresAt"].as_i64().unwrap_or(0)))
}

/// Split `https://host/#join=CODE` into the address and the code.
pub fn parse_link(link: &str) -> Result<(String, String), String> {
    let (url, code) = link.split_once("#join=").ok_or("an invite looks like https://…/#join=XXXX-XXXX-…")?;
    Ok((url.trim_end_matches('/').to_string(), code.trim().to_string()))
}

pub fn join(url: &str, code: &str) -> Result<Config, String> {
    refuse_if_connected()?;
    let secret = crypto::unbase32(code, CODE_BYTES)?;
    let wrap = CodeKeys::from_secret(&secret, "invite");
    let api = Client::new(url, None)?;
    let res = api.post("/v1/enroll", &json!({ "inviteAuth": wrap.auth, "device": device() })).map_err(|e| e.to_string())?;
    let keys = wrap.unwrap_key(res["wrappedKey"].as_str().unwrap_or(""), res["keyCheck"].as_str().unwrap_or(""))?;
    save(api.base(), &res, &keys)
}

pub fn recover(url: &str, code: &str) -> Result<Config, String> {
    refuse_if_connected()?;
    let secret = crypto::unbase32(code, CODE_BYTES)?;
    let wrap = CodeKeys::from_secret(&secret, "recovery");
    let api = Client::new(url, None)?;
    let res = api.post("/v1/recover", &json!({ "recoveryAuth": wrap.auth, "device": device() })).map_err(|e| e.to_string())?;
    let keys = wrap.unwrap_key(res["wrappedKey"].as_str().unwrap_or(""), res["keyCheck"].as_str().unwrap_or(""))?;
    save(api.base(), &res, &keys)
}

/// Remove this device: revoke it on the cloud (when reachable) and forget its keys and sync state.
pub fn disconnect() -> Result<String, String> {
    let config = Config::load()?.ok_or("This device is not connected to a Hive Cloud.")?;
    let revoked = match Engine::load() {
        Ok(engine) => engine.api.delete(&format!("/v1/devices/{}", config.device_id)).is_ok(),
        Err(_) => false,
    };
    let host = host_of(&config.url);
    let secrets = Secrets::system();
    secrets.delete(&host, "device-token");
    secrets.delete(&host, "account-key");
    let dir = crate::config::cloud_dir();
    for name in ["config.json", "sync.sqlite3", "sync.sqlite3-wal", "sync.sqlite3-shm", "status.json"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
    Ok(if revoked {
        format!("Disconnected from {} and removed this device there.", config.url)
    } else {
        format!("Forgot {} on this device. It could not be reached, so remove this device from another one with `hive-cloud revoke {}`.", config.url, config.device_id)
    })
}
