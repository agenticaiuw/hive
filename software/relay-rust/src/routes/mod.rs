//! Route handlers.
//!
//! Every response shape here — status code, JSON key ORDER, header block — is
//! part of the wire contract with the nRF9160 firmware, the Mac bridge, and
//! the dashboard worker.

pub mod bridge;
pub mod devices;
pub mod mac;
pub mod ops;
pub mod pendant;
pub mod state;

use std::time::Duration;

use serde_json::Value;
use worker::{Delay, Env, Request, Response, Result};

use crate::config::Config;
use crate::device_auth::Principal;
use crate::http::{self, JsonBody};
use crate::jobs::is_device_online;
use crate::routing::Route;
use crate::store::d1::D1Store;
use crate::util::time::now_ms;
use crate::util::{js_string, js_truthy};

/// Everything a handler needs, owned so no borrow outlives the request.
pub struct Ctx {
    pub env: Env,
    pub cfg: Config,
    pub store: D1Store,
    pub principal: Principal,
    pub body: JsonBody,
    pub req: Request,
}

impl Ctx {
    /// `String(request.body?.<key> ?? '').trim()`
    pub fn body_str(&self, key: &str) -> String {
        crate::util::js_string(self.body.get(key)).trim().to_string()
    }

    /// `request.body?.<key>`
    pub fn body_val(&self, key: &str) -> Option<&Value> {
        self.body.get(key)
    }

    /// `request.body?.<key>` when it is a plain object, else `None`.
    pub fn body_object(&self, key: &str) -> Option<&Value> {
        self.body.get(key).filter(|v| v.is_object())
    }

    /// A trimmed string field, or `None` when empty — the `|| null` idiom.
    pub fn body_str_opt(&self, key: &str) -> Option<String> {
        let value = self.body_str(key);
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    pub fn is_device(&self) -> bool {
        self.principal.is_device()
    }

    /// Is the Mac bridge currently online?
    pub async fn mac_bridge_online(&self) -> Result<bool> {
        let bridge = self.store.mac_bridge().await?;
        Ok(is_device_online(bridge.as_ref(), now_ms()))
    }
}

/// Non-blocking sleep. Workers have no threads, so this is a timer-backed
/// future rather than a thread park.
pub async fn sleep(ms: u64) {
    Delay::from(Duration::from_millis(ms)).await;
}

/// `Math.min(Math.max(Number(value || fallback), lo), hi)`
pub fn clamp_query(value: Option<&str>, fallback: f64, lo: f64, hi: f64) -> f64 {
    let n = match value {
        Some(v) if !v.is_empty() => v.trim().parse::<f64>().unwrap_or(f64::NAN),
        _ => fallback,
    };
    // `Number('') || fallback` — an empty or zero value falls back.
    let n = if n == 0.0 { fallback } else { n };
    n.max(lo).min(hi)
}

pub async fn dispatch(
    route: Route,
    mut req: Request,
    env: Env,
    cfg: Config,
    store: D1Store,
    principal: Principal,
) -> Result<Response> {
    // The raw-audio parser is mounted ONLY on POST /v1/pendant/command.
    if let Route::PendantCommand = route {
        let audio = http::parse_raw_audio_body(&mut req).await;
        let ctx = Ctx {
            env,
            cfg,
            store,
            principal,
            body: JsonBody::Absent,
            req,
        };
        return pendant::command(&ctx, audio).await;
    }

    let body = http::parse_json_body(&mut req).await;
    if matches!(body, JsonBody::Malformed) {
        return http::malformed_body_response();
    }

    let ctx = Ctx {
        env,
        cfg,
        store,
        principal,
        body,
        req,
    };

    match route {
        Route::Health => devices::health(&ctx.env, &ctx.cfg, &ctx.store).await,
        Route::DevicesPair => devices::pair(&ctx.cfg, &ctx.store, &ctx.body).await,
        Route::DevicesRegister => devices::register(&ctx).await,
        Route::DevicesHeartbeat => devices::heartbeat(&ctx).await,
        Route::DevicesStatus => devices::status(&ctx).await,

        Route::ProductStateGet(account_id) => state::product_get(&ctx, &account_id).await,
        Route::ProductStatePut => state::product_put(&ctx).await,
        Route::StateGet(key) => state::get(&ctx, &key).await,
        Route::StatePut(key) => state::put(&ctx, &key).await,

        Route::PendantAnnounce => pendant::announce(&ctx).await,
        Route::Transcribe => pendant::transcribe(&ctx).await,
        Route::PendantCommand => unreachable!("handled above"),
        Route::Speak => pendant::speak(&ctx).await,
        Route::PendantSpeak => pendant::pendant_speak(&ctx).await,
        Route::PendantJobSpeech(job_id) => pendant::job_speech(&ctx, &job_id).await,
        Route::PendantJobEvents(job_id) => pendant::job_events(&ctx, &job_id).await,

        Route::MacPlan => mac::plan(&ctx).await,
        Route::MacExecute => mac::execute(&ctx).await,
        Route::MacJob(job_id) => mac::job(&ctx, &job_id).await,

        Route::OpsVoiceRuns => ops::voice_runs(&ctx).await,
        Route::OpsVoiceRunsLatest => ops::voice_runs_latest(&ctx).await,
        Route::OpsAudioCaptures => ops::audio_captures(&ctx).await,
        Route::OpsAudioCaptureAudio(capture_id) => ops::audio_capture_audio(&ctx, &capture_id).await,
        Route::OpsProxy => ops::proxy(&ctx).await,

        Route::BridgeWork => bridge::work(&ctx).await,
        Route::BridgeWorkResult(job_id) => bridge::work_result(&ctx, &job_id).await,
    }
}

/// `job.createdBy !== principal.deviceId` for a device principal.
pub fn job_belongs_to_other_device(ctx: &Ctx, job: &Value, field: &str) -> bool {
    ctx.is_device()
        && js_string(job.get(field)) != ctx.principal.device_id.clone().unwrap_or_default()
}

/// `value || fallback` for a trimmed string.
pub fn or_default(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

/// Truthiness helper re-exported for handlers.
pub fn truthy(value: Option<&Value>) -> bool {
    js_truthy(value)
}
