//! Port of `cloud-relay/config.js`.
//!
//! The JS relay copies every string binding into `process.env` on each fetch
//! and reads it through a module-level singleton. There is no such global
//! here: config is read from the per-request `Env` and threaded explicitly, so
//! nothing can cache a stale binding across isolate reuse.

use worker::Env;

pub const DEFAULT_PENDANT_ACCOUNT_ID: &str = "single-owner";
pub const DEFAULT_BRIDGE_POLL_TIMEOUT_MS: i64 = 25_000;
pub const DEFAULT_JOB_TTL_MS: i64 = 86_400_000;
pub const DEFAULT_LLM_API_BASE_URL: &str = "https://openrouter.ai/api/v1";
pub const DEFAULT_STT_MODEL: &str = "openai/whisper-large-v3";
pub const DEFAULT_TTS_MODEL: &str = "x-ai/grok-voice-tts-1.0";
pub const DEFAULT_TTS_VOICE: &str = "eve";
pub const DEFAULT_OPENROUTER_HTTP_REFERER: &str =
    "https://github.com/geunwoo-dev/ai-pendant-simulator";
pub const DEFAULT_OPENROUTER_APP_TITLE: &str = "AI Pendant Simulator";

/// Read a string binding, checking vars then secrets.
fn env_string(env: &Env, name: &str) -> String {
    if let Ok(var) = env.var(name) {
        return var.to_string();
    }
    if let Ok(secret) = env.secret(name) {
        return secret.to_string();
    }
    String::new()
}

fn env_string_or(env: &Env, name: &str, fallback: &str) -> String {
    let value = env_string(env, name);
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn env_number_or(env: &Env, name: &str, fallback: i64) -> i64 {
    let raw = env_string(env, name);
    if raw.trim().is_empty() {
        return fallback;
    }
    // `Number(x) || fallback` — NaN and 0 both fall back.
    match raw.trim().parse::<f64>() {
        Ok(n) if n != 0.0 && n.is_finite() => n as i64,
        _ => fallback,
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub relay_api_key: String,
    pub pairing_code: String,
    pub pendant_account_id: String,
    pub bridge_poll_timeout_ms: i64,
    pub job_ttl_ms: i64,
    pub llm_api_key: String,
    pub llm_api_base_url: String,
    pub stt_model: String,
    pub tts_model: String,
    pub tts_voice: String,
    pub openrouter_http_referer: String,
    pub openrouter_app_title: String,
    pub audio_bucket_prefix: String,
}

impl Config {
    pub fn from_env(env: &Env) -> Self {
        Config {
            relay_api_key: env_string(env, "RELAY_API_KEY"),
            pairing_code: env_string(env, "PAIRING_CODE"),
            pendant_account_id: env_string_or(
                env,
                "PENDANT_ACCOUNT_ID",
                DEFAULT_PENDANT_ACCOUNT_ID,
            ),
            bridge_poll_timeout_ms: env_number_or(
                env,
                "BRIDGE_POLL_TIMEOUT_MS",
                DEFAULT_BRIDGE_POLL_TIMEOUT_MS,
            ),
            job_ttl_ms: env_number_or(env, "JOB_TTL_MS", DEFAULT_JOB_TTL_MS),
            llm_api_key: env_string(env, "LLM_API_KEY"),
            llm_api_base_url: env_string_or(env, "LLM_API_BASE_URL", DEFAULT_LLM_API_BASE_URL),
            stt_model: env_string_or(env, "STT_MODEL", DEFAULT_STT_MODEL),
            tts_model: env_string_or(env, "TTS_MODEL", DEFAULT_TTS_MODEL),
            tts_voice: env_string_or(env, "TTS_VOICE", DEFAULT_TTS_VOICE),
            openrouter_http_referer: env_string_or(
                env,
                "OPENROUTER_HTTP_REFERER",
                DEFAULT_OPENROUTER_HTTP_REFERER,
            ),
            openrouter_app_title: env_string_or(
                env,
                "OPENROUTER_APP_TITLE",
                DEFAULT_OPENROUTER_APP_TITLE,
            ),
            audio_bucket_prefix: env_string_or(
                env,
                "AUDIO_BUCKET_PREFIX",
                crate::audio_storage::DEFAULT_OBJECT_PREFIX,
            ),
        }
    }
}
