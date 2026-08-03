//! Ports of `cloud-relay/transcribe.js` and `cloud-relay/speak.js`.

use serde::{Deserialize, Serialize};
use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit};

use crate::config::Config;
use crate::util::b64;

pub const CF_STT_MODEL: &str = "@cf/openai/whisper-large-v3-turbo";

/// MUST stay byte-identical: any drift measurably changes recognition quality,
/// and no test would catch it except this constant.
pub const WHISPER_INITIAL_PROMPT: &str = "A short spoken command for a Mac. Common application names include Outlook, Finder, Safari, Chrome, Mail, Calendar, Notes, Messages, Home, Music, and System Settings.";

/// An error whose message is part of the client contract.
///
/// The routes map any message containing the substring `not configured` to
/// HTTP 503 and everything else to 400.
#[derive(Debug, Clone)]
pub struct SpeechError(pub String);

impl SpeechError {
    pub fn new(message: impl Into<String>) -> Self {
        SpeechError(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }

    pub fn status(&self) -> u16 {
        if self.0.contains("not configured") {
            503
        } else {
            400
        }
    }
}

#[derive(Debug, Clone)]
pub struct Transcript {
    pub text: String,
    pub model: String,
    pub language: Option<String>,
}

/// Whisper input.
///
/// This MUST be a struct, not a map. `Ai::run` serializes with plain
/// `serde_wasm_bindgen::to_value`, which turns Rust maps (`HashMap`,
/// `serde_json::Value::Object`) into a JS `Map` — the AI binding silently
/// fails to read that as an options object.
#[derive(Serialize)]
struct WhisperInput<'a> {
    /// The clean base64 STRING, passed verbatim. Never decode and re-encode.
    audio: &'a str,
    task: &'a str,
    language: &'a str,
    vad_filter: bool,
    beam_size: u32,
    condition_on_previous_text: bool,
    initial_prompt: &'a str,
}

/// Whisper output. `serde_wasm_bindgen::from_value` chokes on JS `undefined`
/// where `serde_json` would tolerate it, so every field is optional.
#[derive(Deserialize, Default)]
struct WhisperOutput {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    transcription_info: Option<TranscriptionInfo>,
}

#[derive(Deserialize, Default)]
struct TranscriptionInfo {
    #[serde(default)]
    language: Option<String>,
}

/// Port of `normalizeFormat`, used only by the OpenRouter fallback.
pub fn normalize_format(format: &str) -> String {
    let value = format.to_lowercase();
    let value = value.strip_prefix('.').unwrap_or(&value).to_string();
    let value = if value.is_empty() {
        "webm".to_string()
    } else {
        value
    };

    if value.contains("webm") {
        return "webm".to_string();
    }
    if value.contains("mp4") || value.contains("m4a") || value.contains("aac") {
        return "m4a".to_string();
    }
    if value.contains("ogg") || value.contains("opus") {
        return "ogg".to_string();
    }
    if value.contains("mp3") || value.contains("mpeg") {
        return "mp3".to_string();
    }
    if value.contains("wav") {
        return "wav".to_string();
    }
    if value.contains("flac") {
        return "flac".to_string();
    }
    value
}

fn openrouter_headers(cfg: &Config) -> Result<Headers, worker::Error> {
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("Authorization", &format!("Bearer {}", cfg.llm_api_key))?;
    if cfg.llm_api_base_url.contains("openrouter.ai") {
        headers.set("HTTP-Referer", &cfg.openrouter_http_referer)?;
        headers.set("X-Title", &cfg.openrouter_app_title)?;
    }
    Ok(headers)
}

/// Port of `transcribeAudio`.
pub async fn transcribe_audio(
    env: &Env,
    cfg: &Config,
    audio_base64: &str,
    format: Option<&str>,
    language: Option<&str>,
) -> Result<Transcript, SpeechError> {
    let clean_base64 = b64::strip_data_url(audio_base64);
    if clean_base64.is_empty() {
        return Err(SpeechError::new("audioBase64 is required."));
    }

    // PRIMARY PATH: the Workers AI binding, always present in production.
    if let Ok(ai) = env.ai("AI") {
        let input = WhisperInput {
            audio: clean_base64,
            task: "transcribe",
            language: language.filter(|l| !l.is_empty()).unwrap_or("en"),
            vad_filter: true,
            beam_size: 8,
            condition_on_previous_text: false,
            initial_prompt: WHISPER_INITIAL_PROMPT,
        };

        let payload: WhisperOutput = ai
            .run(CF_STT_MODEL, &input)
            .await
            .map_err(|e| SpeechError::new(e.to_string()))?;

        let text = payload.text.unwrap_or_default().trim().to_string();
        if text.is_empty() {
            return Err(SpeechError::new("Speech-to-text returned empty text."));
        }

        // `payload.language || language || null`. Some model versions report
        // the detected language nested under transcription_info.
        let detected = payload
            .language
            .filter(|l| !l.is_empty())
            .or_else(|| {
                payload
                    .transcription_info
                    .and_then(|info| info.language)
                    .filter(|l| !l.is_empty())
            })
            .or_else(|| language.filter(|l| !l.is_empty()).map(|l| l.to_string()));

        return Ok(Transcript {
            text,
            // The reported model is the hardcoded literal, not the binding.
            model: CF_STT_MODEL.to_string(),
            language: detected,
        });
    }

    // FALLBACK PATH: dead in production, but it is the only offline/CI route
    // for this handler, since Workers AI has no local simulation.
    if cfg.llm_api_key.is_empty() {
        return Err(SpeechError::new(
            "Speech-to-text is not configured on the relay (missing Workers AI binding or LLM_API_KEY).",
        ));
    }

    let mut body = json!({
        "model": cfg.stt_model,
        "input_audio": {
            "data": clean_base64,
            "format": normalize_format(format.unwrap_or("webm")),
        }
    });
    if let Some(language) = language.filter(|l| !l.is_empty()) {
        body["language"] = json!(language);
    }

    let payload = post_json(
        &format!("{}/audio/transcriptions", cfg.llm_api_base_url),
        cfg,
        &body,
        "Speech-to-text",
    )
    .await?;

    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(SpeechError::new("Speech-to-text returned empty text."));
    }

    Ok(Transcript {
        text,
        model: cfg.stt_model.clone(),
        language: payload
            .get("language")
            .and_then(|v| v.as_str())
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .or_else(|| language.filter(|l| !l.is_empty()).map(|l| l.to_string())),
    })
}

async fn post_json(
    url: &str,
    cfg: &Config,
    body: &serde_json::Value,
    label: &str,
) -> Result<serde_json::Value, SpeechError> {
    let headers = openrouter_headers(cfg).map_err(|e| SpeechError::new(e.to_string()))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&serde_json::to_string(body).unwrap_or_default())));

    let request =
        Request::new_with_init(url, &init).map_err(|e| SpeechError::new(e.to_string()))?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|e| SpeechError::new(e.to_string()))?;

    let status = response.status_code();
    let payload: serde_json::Value = response
        .json()
        .await
        .unwrap_or(serde_json::Value::Object(Default::default()));

    if !(200..300).contains(&status) {
        let message = payload
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                payload
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| format!("{label} failed ({status})."));
        return Err(SpeechError::new(message));
    }

    Ok(payload)
}

#[derive(Debug, Clone)]
pub struct Speech {
    pub audio: Vec<u8>,
    pub audio_bytes: usize,
    pub mime_type: String,
    pub format: String,
    pub model: String,
    pub voice: String,
}

/// Port of `synthesizeSpeech`.
///
/// In the deployed Worker `LLM_API_KEY` is unset, so this always returns the
/// "not configured" error and `/v1/speak` / `/v1/pendant/speak` answer 503.
/// The pendant reply path relies entirely on `result.pendantSpeech` written by
/// the Mac bridge — see [`crate::jobs::pendant_speech_for_job`].
pub async fn synthesize_speech(
    cfg: &Config,
    text: &str,
    format: &str,
) -> Result<Speech, SpeechError> {
    if cfg.llm_api_key.is_empty() {
        return Err(SpeechError::new(
            "Text-to-speech is not configured on the relay (missing LLM_API_KEY).",
        ));
    }

    let input = crate::util::collapse_whitespace(text);
    if input.is_empty() {
        return Err(SpeechError::new("text is required."));
    }

    let response_format = format.trim().to_lowercase();
    if response_format != "mp3" && response_format != "pcm" {
        return Err(SpeechError::new("format must be mp3 or pcm."));
    }

    let body = json!({
        "model": cfg.tts_model,
        "input": crate::util::slice_utf16(&input, 800),
        "voice": cfg.tts_voice,
        "response_format": response_format,
    });

    let headers = openrouter_headers(cfg).map_err(|e| SpeechError::new(e.to_string()))?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(
            &serde_json::to_string(&body).unwrap_or_default(),
        )));

    let request = Request::new_with_init(&format!("{}/audio/speech", cfg.llm_api_base_url), &init)
        .map_err(|e| SpeechError::new(e.to_string()))?;
    let mut response = Fetch::Request(request)
        .send()
        .await
        .map_err(|e| SpeechError::new(e.to_string()))?;

    let status = response.status_code();
    if !(200..300).contains(&status) {
        let payload: serde_json::Value = response
            .json()
            .await
            .unwrap_or(serde_json::Value::Object(Default::default()));
        let message = payload
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                payload
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| format!("Text-to-speech failed ({status})."));
        return Err(SpeechError::new(message));
    }

    let mime_type = response
        .headers()
        .get("content-type")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            if response_format == "pcm" {
                "audio/pcm".to_string()
            } else {
                "audio/mpeg".to_string()
            }
        });

    let audio = response
        .bytes()
        .await
        .map_err(|e| SpeechError::new(e.to_string()))?;

    Ok(Speech {
        audio_bytes: audio.len(),
        audio,
        mime_type,
        format: response_format,
        model: cfg.tts_model.clone(),
        voice: cfg.tts_voice.clone(),
    })
}
