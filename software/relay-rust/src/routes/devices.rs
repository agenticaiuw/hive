//! `/health`, `/v1/devices/*`.

use serde_json::{json, Value};
use worker::{Env, Response, Result};

use super::Ctx;
use crate::config::Config;
use crate::device_auth::{
    create_device_credential, public_credential, supported_device_types, verify_pairing_code,
    principal_owns_device, TOKEN_ID_BYTES, TOKEN_SECRET_BYTES,
};
use crate::http::{error_response, json_response, JsonBody};
use crate::jobs::is_device_online;
use crate::random::random_bytes;
use crate::speech::CF_STT_MODEL;
use crate::store::d1::D1Store;
use crate::util::time::{now_iso, now_ms};
use crate::util::js_string;

/// `GET /health` — PUBLIC.
pub async fn health(env: &Env, cfg: &Config, store: &D1Store) -> Result<Response> {
    let devices = store.list_devices().await?;
    let mac_bridge = devices
        .iter()
        .find(|d| js_string(d.get("deviceType")) == "mac_bridge");

    let has_ai = env.ai("AI").is_ok();
    let has_bucket = env.bucket("AUDIO_BUCKET").is_ok();

    json_response(
        200,
        &json!({
            "ok": true,
            "service": "AI Pendant Cloud Relay",
            "version": "1.1.0",
            "platform": "cloudflare-workers",
            "store": store.kind(),
            "relayApiKeyConfigured": !cfg.relay_api_key.is_empty(),
            "speechToTextConfigured": has_ai || !cfg.llm_api_key.is_empty(),
            "pairingRequired": !cfg.pairing_code.is_empty(),
            "macBridgeOnline": is_device_online(mac_bridge, now_ms()),
            "macBridgeLastSeen": mac_bridge
                .and_then(|d| d.get("lastSeenAt"))
                .cloned()
                .unwrap_or(Value::Null),
            "capabilities": {
                "pendantPipelineTelemetry": true,
                "pendantSpeech": true,
                "persistentAgentState": true,
                "durableAudio": has_bucket,
            },
            "models": {
                "speechToText": if has_ai { CF_STT_MODEL } else { cfg.stt_model.as_str() },
                "textToSpeech": "macOS say (24 kHz PCM)",
                // The separator is " · " (U+00B7).
                "relayTextToSpeechFallback": format!("{} · {}", cfg.tts_model, cfg.tts_voice),
            }
        }),
    )
}

/// `POST /v1/devices/pair` — PUBLIC. Mints a scoped device token.
pub async fn pair(cfg: &Config, store: &D1Store, body: &JsonBody) -> Result<Response> {
    let field = |key: &str| js_string(body.get(key)).trim().to_string();
    let device_id = field("deviceId");
    let device_type = field("deviceType");
    let name = field("name");
    let pairing_code = field("pairingCode");

    let supported = supported_device_types();
    if device_id.is_empty() || !supported.contains(&device_type.as_str()) {
        return error_response(
            400,
            &format!(
                "deviceId and deviceType ({}) are required.",
                supported.join("|")
            ),
        );
    }

    if cfg.pairing_code.is_empty() {
        return error_response(
            503,
            "Blocked for safety: device pairing is not configured on the cloud relay.",
        );
    }

    if !verify_pairing_code(&pairing_code, &cfg.pairing_code) {
        return error_response(403, "Blocked for safety: invalid pairing code.");
    }

    let now = now_iso();
    let issued = match create_device_credential(
        &device_id,
        &device_type,
        &now,
        &random_bytes(TOKEN_ID_BYTES),
        &random_bytes(TOKEN_SECRET_BYTES),
    ) {
        Ok(issued) => issued,
        Err(message) => return error_response(400, &message),
    };

    let device = store
        .save_device(&json!({
            "deviceId": device_id,
            "deviceType": device_type,
            "name": if name.is_empty() { device_id.clone() } else { name },
            "registeredAt": now,
            "lastSeenAt": now,
            "updatedAt": now,
        }))
        .await?;

    store.save_device_credential(&issued.record).await?;

    // The token is returned exactly once, appended to the public credential.
    let mut credential = public_credential(&issued.record);
    if let Value::Object(map) = &mut credential {
        map.insert("token".into(), issued.token.into());
    }

    json_response(
        201,
        &json!({ "ok": true, "device": device, "credential": credential }),
    )
}

/// `POST /v1/devices/register` — admin only.
///
/// NOTE: this route's allow-list is hardcoded to `mac_bridge|mobile`, which is
/// deliberately NARROWER than `/pair`'s. The two are not unified.
pub async fn register(ctx: &Ctx) -> Result<Response> {
    let device_id = ctx.body_str("deviceId");
    let device_type = ctx.body_str("deviceType");
    let name = ctx.body_str("name");
    let pairing_code = ctx.body_str("pairingCode");

    if device_id.is_empty() || !["mac_bridge", "mobile"].contains(&device_type.as_str()) {
        return error_response(400, "deviceId and deviceType (mac_bridge|mobile) are required.");
    }

    // Plain `!==` here, NOT the constant-time compare used by /pair.
    if !ctx.cfg.pairing_code.is_empty() && pairing_code != ctx.cfg.pairing_code {
        return error_response(403, "Blocked for safety: invalid pairing code.");
    }

    let now = now_iso();
    let device = ctx
        .store
        .save_device(&json!({
            "deviceId": device_id,
            "deviceType": device_type,
            "name": if name.is_empty() { device_id.clone() } else { name },
            "registeredAt": now,
            "lastSeenAt": now,
            "updatedAt": now,
        }))
        .await?;

    // 200, not 201.
    json_response(200, &json!({ "ok": true, "device": device }))
}

/// `POST /v1/devices/heartbeat`
pub async fn heartbeat(ctx: &Ctx) -> Result<Response> {
    let device_id = ctx.body_str("deviceId");

    if device_id.is_empty() {
        return error_response(400, "deviceId is required.");
    }
    if !principal_owns_device(&ctx.principal, &device_id) {
        return error_response(403, "Blocked for safety: a device may only heartbeat itself.");
    }

    let Some(existing) = ctx.store.get_device(&device_id).await? else {
        return error_response(404, "Device is not registered.");
    };

    let now = now_iso();
    let device = ctx
        .store
        .save_device(&json!({
            "deviceId": device_id,
            "deviceType": existing.get("deviceType").cloned().unwrap_or(Value::Null),
            "name": existing.get("name").cloned().unwrap_or(Value::Null),
            "registeredAt": existing.get("registeredAt").cloned().unwrap_or(Value::Null),
            "lastSeenAt": now,
            "updatedAt": now,
        }))
        .await?;

    json_response(200, &json!({ "ok": true, "device": device }))
}

/// `GET /v1/devices/status`
pub async fn status(ctx: &Ctx) -> Result<Response> {
    let now = now_ms();
    let devices: Vec<Value> = ctx
        .store
        .list_devices()
        .await?
        .into_iter()
        .map(|device| {
            let online = is_device_online(Some(&device), now);
            let mut map = match device {
                Value::Object(map) => map,
                _ => serde_json::Map::new(),
            };
            map.insert("online".into(), online.into());
            Value::Object(map)
        })
        .collect();

    json_response(200, &json!({ "ok": true, "devices": devices }))
}
