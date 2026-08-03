//! Port of `cloud-relay/jobs.js`.
//!
//! Jobs are modelled as `serde_json::Value` objects rather than typed structs
//! on purpose. `updateJob` is a SHALLOW merge over the whole stored JSON blob,
//! and the Mac bridge writes fields the relay never declares
//! (`result.pendantSpeech`, `result.thinking`, planner metadata). A typed
//! struct would silently drop them on the next read-modify-write.

use serde_json::{Map, Value};

use crate::util::time::parse_iso;
use crate::util::{b64, collapse_whitespace, js_number, js_string, js_truthy, slice_utf16};

pub const PENDANT_PCM_SAMPLE_RATE: i64 = 24_000;
pub const PENDANT_PCM_CHANNELS: i64 = 1;
pub const PENDANT_PCM_BITS: i64 = 16;

pub const DEVICE_ONLINE_WINDOW_MS: i64 = 90_000;

/// Jobs earn a spot in the operator feed only when the owner started them
/// directly: pendant audio buffered to microSD, or a command from a signed-in
/// dashboard browser.
const VOICE_RUN_ORIGINS: &[&str] = &["microsd", "dashboard"];

pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key.to_string(), value);
    }
    Value::Object(map)
}

/// Build an object where a `None` value means the JS expression evaluated to
/// `undefined` — and `JSON.stringify` DROPS those keys entirely.
///
/// This distinction is observable: `voiceRunForJob`'s tts event emits
/// `{format, sampleRate, pcmBytes}` when the bridge omitted `channels` and
/// `bitsPerSample`, not those keys set to null.
fn obj_opt(pairs: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        if let Some(value) = value {
            map.insert(key.to_string(), value);
        }
    }
    Value::Object(map)
}

/// `value.key`, distinguishing an explicit `null` (kept) from an absent key
/// (`undefined`, dropped).
fn undef(value: &Value, key: &str) -> Option<Value> {
    value.get(key).cloned()
}

/// `job.key ?? null`
fn or_null(job: &Value, key: &str) -> Value {
    job.get(key).cloned().unwrap_or(Value::Null)
}

pub fn create_job_id(uuid: &str) -> String {
    format!("job_{uuid}")
}

pub fn create_plan_job(
    job_id: String,
    command: Value,
    device_id: Option<&str>,
    session_id: Option<&str>,
    status: &str,
    input_telemetry: Option<Value>,
    now: &str,
) -> Value {
    obj(vec![
        ("jobId", job_id.into()),
        ("type", "plan".into()),
        ("status", status.into()),
        ("command", command),
        ("sessionId", session_id.map(Value::from).unwrap_or(Value::Null)),
        ("inputTelemetry", input_telemetry.unwrap_or(Value::Null)),
        ("deviceEvents", Value::Array(vec![])),
        ("actions", Value::Array(vec![])),
        ("result", Value::Null),
        ("error", Value::Null),
        ("createdBy", device_id.unwrap_or("mobile").into()),
        ("createdAt", now.into()),
        ("updatedAt", now.into()),
        ("claimedBy", Value::Null),
        ("claimedAt", Value::Null),
    ])
}

pub fn create_execute_job(
    job_id: String,
    command: Value,
    actions: Value,
    plan_job_id: Option<&str>,
    device_id: Option<&str>,
    session_id: Option<&str>,
    now: &str,
) -> Value {
    obj(vec![
        ("jobId", job_id.into()),
        ("type", "execute".into()),
        ("status", "queued".into()),
        ("command", command),
        ("actions", actions),
        ("planJobId", plan_job_id.map(Value::from).unwrap_or(Value::Null)),
        ("sessionId", session_id.map(Value::from).unwrap_or(Value::Null)),
        ("deviceEvents", Value::Array(vec![])),
        ("result", Value::Null),
        ("error", Value::Null),
        ("createdBy", device_id.unwrap_or("mobile").into()),
        ("createdAt", now.into()),
        ("updatedAt", now.into()),
        ("claimedBy", Value::Null),
        ("claimedAt", Value::Null),
    ])
}

pub fn create_agent_proxy_job(
    job_id: String,
    method: &str,
    path: &str,
    body: Value,
    device_id: Option<&str>,
    now: &str,
) -> Value {
    let method_value = if method.is_empty() { "GET" } else { method };
    let path_value = if path.is_empty() { "/" } else { path };
    obj(vec![
        ("jobId", job_id.into()),
        ("type", "agent_proxy".into()),
        ("status", "queued".into()),
        // `command` uses the RAW method/path, before the || fallbacks.
        ("command", format!("{method} {path}").into()),
        ("sessionId", Value::Null),
        ("deviceEvents", Value::Array(vec![])),
        ("actions", Value::Array(vec![])),
        ("method", method_value.into()),
        ("path", path_value.into()),
        ("body", body),
        ("result", Value::Null),
        ("error", Value::Null),
        ("createdBy", device_id.unwrap_or("ops").into()),
        ("createdAt", now.into()),
        ("updatedAt", now.into()),
        ("claimedBy", Value::Null),
        ("claimedAt", Value::Null),
    ])
}

/// Build an `audio_capture` record.
///
/// `audio_base64` / `audio_storage_warning` are `Option` because
/// `JSON.stringify` DROPS keys whose value is `undefined`. An R2-backed
/// capture is persisted with no `audioBase64` key at all, and
/// `loadAudioCapture`'s `String(capture.audioBase64 || '')` fallback depends
/// on that.
#[allow(clippy::too_many_arguments)]
pub fn create_audio_capture(
    job_id: String,
    audio_base64: Option<String>,
    audio_ref: Value,
    audio_storage: Value,
    audio_storage_warning: Option<String>,
    audio_bytes: Value,
    format: Value,
    language: Value,
    transcript: Value,
    transcription_model: Value,
    status: &str,
    now: &str,
) -> Value {
    let mut map = Map::new();
    map.insert("jobId".into(), job_id.into());
    map.insert("type".into(), "audio_capture".into());
    map.insert("status".into(), status.into());
    if let Some(audio) = audio_base64 {
        map.insert("audioBase64".into(), audio.into());
    }
    map.insert("audioRef".into(), audio_ref);
    map.insert("audioStorage".into(), audio_storage);
    if let Some(warning) = audio_storage_warning {
        map.insert("audioStorageWarning".into(), warning.into());
    }
    map.insert("audioBytes".into(), audio_bytes);
    map.insert("format".into(), format);
    map.insert("language".into(), language);
    map.insert("transcript".into(), transcript);
    map.insert("transcriptionModel".into(), transcription_model);
    map.insert("createdAt".into(), now.into());
    map.insert("updatedAt".into(), now.into());
    Value::Object(map)
}

/// Port of `publicJob`. Deliberately hides `audioBase64`, `audioRef`, and the
/// claim fields.
pub fn public_job(job: &Value) -> Value {
    if !job.is_object() {
        return Value::Null;
    }

    let mut map = Map::new();
    // A key that is `undefined` in JS is dropped by JSON.stringify, so a
    // missing source key must be omitted rather than written as null.
    for key in ["jobId", "type", "status", "command", "actions"] {
        if let Some(value) = job.get(key) {
            map.insert(key.to_string(), value.clone());
        }
    }

    map.insert("planJobId".into(), or_null(job, "planJobId"));
    map.insert("method".into(), or_null(job, "method"));
    map.insert("path".into(), or_null(job, "path"));
    map.insert("inputTelemetry".into(), or_null(job, "inputTelemetry"));
    map.insert("deviceEvents".into(), Value::Array(last_device_events(job)));

    for key in ["result", "error", "createdAt", "updatedAt"] {
        if let Some(value) = job.get(key) {
            map.insert(key.to_string(), value.clone());
        }
    }

    Value::Object(map)
}

/// `Array.isArray(job.deviceEvents) ? job.deviceEvents.slice(-32) : []`
pub fn last_device_events(job: &Value) -> Vec<Value> {
    match job.get("deviceEvents") {
        Some(Value::Array(items)) => {
            let start = items.len().saturating_sub(32);
            items[start..].to_vec()
        }
        _ => vec![],
    }
}

/// Port of `normalizePipelineStatus`. Any unrecognised or missing value
/// becomes `done`.
pub fn normalize_pipeline_status(value: Option<&Value>) -> &'static str {
    match js_string(value).trim().to_lowercase().as_str() {
        "active" | "processing" => "active",
        "failed" | "error" => "failed",
        "waiting" | "queued" => "waiting",
        _ => "done",
    }
}

/// Port of `/base64|authorization|api.?key|token|secret|password/i`.
fn is_forbidden_meta_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    if ["base64", "authorization", "token", "secret", "password"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return true;
    }
    // `api.?key`: "api", then an OPTIONAL single character, then "key".
    let chars: Vec<char> = lower.chars().collect();
    for start in 0..chars.len() {
        if chars[start..].starts_with(&['a', 'p', 'i']) {
            let after = start + 3;
            let matches_at = |idx: usize| chars.get(idx..idx + 3) == Some(&['k', 'e', 'y'][..]);
            if matches_at(after) || matches_at(after + 1) {
                return true;
            }
        }
    }
    false
}

/// Port of `sanitizeTelemetryMeta`.
pub fn sanitize_telemetry_meta(value: Option<&Value>) -> Value {
    let Some(Value::Object(map)) = value else {
        return Value::Object(Map::new());
    };

    let mut out = Map::new();
    for (raw_key, raw_value) in map.iter().take(32) {
        let key = slice_utf16(raw_key, 80);
        if key.is_empty() || is_forbidden_meta_key(&key) {
            continue;
        }
        match raw_value {
            Value::Number(_) | Value::Bool(_) => {
                out.insert(key, raw_value.clone());
            }
            Value::String(s) => {
                out.insert(key, Value::String(slice_utf16(s, 240)));
            }
            // Objects, arrays and null are dropped entirely.
            _ => {}
        }
    }
    Value::Object(out)
}

/// Port of `isDeviceOnline`: seen within the last 90 seconds.
pub fn is_device_online(device: Option<&Value>, now_ms: i64) -> bool {
    let Some(device) = device else { return false };
    let last_seen = js_string(device.get("lastSeenAt"));
    if last_seen.is_empty() {
        return false;
    }
    match parse_iso(&last_seen) {
        // An unparseable timestamp yields NaN in JS, and `NaN < 90000` is
        // false, so the device counts as offline.
        None => false,
        Some(ms) => now_ms - ms < DEVICE_ONLINE_WINDOW_MS,
    }
}

/// Audio ready to stream to the pendant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendantAudio {
    pub audio: Vec<u8>,
    pub mime_type: String,
    pub format: String,
}

/// Port of `pendantSpeechForJob`.
///
/// Only accepts speech the Mac bridge rendered at exactly 24 kHz / mono /
/// 16-bit. Prefers an Ogg Opus payload when one is present and genuinely
/// starts with the `OggS` magic.
pub fn pendant_speech_for_job(job: &Value) -> Option<PendantAudio> {
    let speech = job.get("result")?.get("pendantSpeech")?;

    let audio_base64 = js_string(speech.get("audioBase64"));
    let audio_base64 = audio_base64.trim();
    if audio_base64.is_empty()
        || js_string(speech.get("format")).to_lowercase() != "s16le"
        || js_number(speech.get("sampleRate")) != PENDANT_PCM_SAMPLE_RATE as f64
        || js_number(speech.get("channels")) != PENDANT_PCM_CHANNELS as f64
        || js_number(speech.get("bitsPerSample")) != PENDANT_PCM_BITS as f64
    {
        return None;
    }

    let compressed = js_string(speech.get("compressedAudioBase64"));
    let compressed = compressed.trim();
    if !compressed.is_empty()
        && js_string(speech.get("compressedFormat")).to_lowercase() == "ogg-opus"
    {
        let bytes = b64::decode(compressed);
        if bytes.len() >= 64 && bytes.starts_with(b"OggS") {
            return Some(PendantAudio {
                audio: bytes,
                mime_type: "audio/ogg".to_string(),
                format: "ogg-opus".to_string(),
            });
        }
    }

    let audio = b64::decode(audio_base64);
    if audio.is_empty() || audio.len() % 2 != 0 {
        return None;
    }

    Some(PendantAudio {
        audio,
        mime_type: "audio/pcm".to_string(),
        format: "s16le".to_string(),
    })
}

/// Port of `spokenTextForJob`.
pub fn spoken_text_for_job(job: &Value) -> String {
    let empty = Value::Object(Map::new());
    let result = match job.get("result") {
        Some(v) if v.is_object() => v,
        _ => &empty,
    };

    let result_as_string = match result.get("result") {
        Some(Value::String(s)) => Value::String(s.clone()),
        _ => Value::String(String::new()),
    };

    let candidates = [
        result.get("response").cloned().unwrap_or(Value::Null),
        result.get("summary").cloned().unwrap_or(Value::Null),
        result.get("message").cloned().unwrap_or(Value::Null),
        result_as_string,
    ];

    for candidate in candidates.iter() {
        let text = collapse_whitespace(&js_string(Some(candidate)));
        if !text.is_empty() {
            return slice_utf16(&text, 800);
        }
    }

    let actions = match result.get("actions") {
        Some(Value::Array(items)) => items.clone(),
        _ => match job.get("actions") {
            Some(Value::Array(items)) => items.clone(),
            _ => vec![],
        },
    };

    let labels: Vec<String> = actions
        .iter()
        .map(|action| {
            let value = if js_truthy(action.get("label")) {
                js_string(action.get("label"))
            } else {
                js_string(action.get("type"))
            };
            value.trim().to_string()
        })
        .filter(|label| !label.is_empty())
        .collect();

    if !labels.is_empty() {
        let needs_confirmation = actions
            .iter()
            .any(|action| js_truthy(action.get("requiresConfirmation")));
        let prefix = if needs_confirmation {
            "Ready for confirmation: "
        } else {
            ""
        };
        return slice_utf16(&format!("{prefix}{}.", labels.join(", ")), 800);
    }

    if js_string(job.get("status")) == "completed" {
        "Done.".to_string()
    } else {
        String::new()
    }
}

/// `/[\p{L}\p{N}]/u.test(command)`
///
/// Rust's `is_alphanumeric` is `Alphabetic | N`, which differs from `L | N`
/// only by Other_Alphabetic combining marks — characters that cannot form a
/// transcript on their own.
fn has_transcript(command: &str) -> bool {
    command.chars().any(|c| c.is_alphanumeric())
}

fn action_text(result: &Value) -> String {
    let Some(Value::Array(actions)) = result.get("actions") else {
        return String::new();
    };

    actions
        .iter()
        .map(|action| {
            let label = if js_truthy(action.get("label")) {
                js_string(action.get("label"))
            } else if js_truthy(action.get("description")) {
                js_string(action.get("description"))
            } else {
                js_string(action.get("type"))
            };
            let label = label.trim().to_string();

            let parameters = match action.get("params") {
                Some(Value::Object(params)) => params
                    .iter()
                    .map(|(key, value)| format!("{key}: {}", js_string(Some(value))))
                    .collect::<Vec<_>>()
                    .join(", "),
                Some(Value::Array(params)) => params
                    .iter()
                    .enumerate()
                    .map(|(index, value)| format!("{index}: {}", js_string(Some(value))))
                    .collect::<Vec<_>>()
                    .join(", "),
                _ => String::new(),
            };

            if parameters.is_empty() {
                label
            } else {
                format!("{label} ({parameters})")
            }
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `value.key || null`
fn or_null_truthy(value: &Value, key: &str) -> Value {
    match value.get(key) {
        Some(v) if js_truthy(Some(v)) => v.clone(),
        _ => Value::Null,
    }
}

/// Port of `voiceRunForJob` — converts a relay plan job into the dashboard's
/// operator feed shape. Returns `None` for jobs that do not belong in the feed.
pub fn voice_run_for_job(job: &Value) -> Option<Value> {
    if !job.is_object() || js_string(job.get("type")) != "plan" {
        return None;
    }

    let telemetry = job.get("inputTelemetry").cloned().unwrap_or(Value::Null);
    let origin = js_string(telemetry.get("storage")).to_lowercase();
    if !VOICE_RUN_ORIGINS.contains(&origin.as_str()) {
        return None;
    }

    let typed = js_string(telemetry.get("inputMode")) == "typed";
    let command = js_string(job.get("command"));
    let job_id = js_string(job.get("jobId"));
    let status = js_string(job.get("status"));
    let created_at = undef(job, "createdAt");
    let updated_at = undef(job, "updatedAt");

    let mut events: Vec<Value> = Vec::new();

    let transcription_pending = status == "transcribing";
    let has_transcript = has_transcript(&command);

    events.push(if typed {
        obj_opt(vec![
            ("eventId", Some(format!("cloud-{job_id}-transcription").into())),
            ("stage", Some("transcription".into())),
            ("status", Some("done".into())),
            ("label", Some("Typed in the dashboard".into())),
            (
                "detail",
                Some(
                    "Command typed on a signed-in device, so there was no audio to transcribe."
                        .into(),
                ),
            ),
            ("text", Some(command.clone().into())),
            ("source", Some("dashboard".into())),
            (
                "meta",
                Some(obj(vec![("inputTelemetry", telemetry.clone())])),
            ),
            ("at", created_at.clone()),
        ])
    } else {
        let (status_value, label, detail) = if transcription_pending {
            (
                "active",
                "Recording received; transcription running",
                "Cloudflare received the pendant recording and is transcribing it now.".to_string(),
            )
        } else if has_transcript {
            (
                "done",
                "Transcript received from cloud",
                "Speech-to-text completed before this job reached the Mac bridge.".to_string(),
            )
        } else {
            (
                "failed",
                "Speech was not recognized",
                if js_truthy(job.get("error")) {
                    js_string(job.get("error"))
                } else {
                    "Audio arrived, but speech-to-text did not return words.".to_string()
                },
            )
        };

        obj_opt(vec![
            ("eventId", Some(format!("cloud-{job_id}-transcription").into())),
            ("stage", Some("transcription".into())),
            ("status", Some(status_value.into())),
            ("label", Some(label.into())),
            ("detail", Some(detail.into())),
            ("text", Some(command.clone().into())),
            ("source", Some("cloudflare".into())),
            (
                "meta",
                Some(obj(vec![("inputTelemetry", telemetry.clone())])),
            ),
            ("at", created_at.clone()),
        ])
    });

    let result = job.get("result").filter(|v| v.is_object()).cloned();

    if let Some(result) = result {
        let action_text = action_text(&result);
        let agent_text = if js_truthy(result.get("response")) {
            js_string(result.get("response"))
        } else if js_truthy(result.get("summary")) {
            js_string(result.get("summary"))
        } else {
            action_text.clone()
        };

        let thinking_updated_at = result
            .get("thinking")
            .and_then(|t| t.get("updatedAt"))
            .filter(|v| js_truthy(Some(v)))
            .cloned();

        events.push(obj_opt(vec![
            ("eventId", Some(format!("cloud-{job_id}-agent").into())),
            ("stage", Some("agent".into())),
            ("status", Some("done".into())),
            (
                "label",
                Some(
                    if action_text.is_empty() {
                        "Agent response ready"
                    } else {
                        "Mac action selected"
                    }
                    .into(),
                ),
            ),
            (
                "detail",
                Some(
                    if action_text.is_empty() {
                        "The Mac agent completed this request."
                    } else {
                        "The Mac agent produced this action plan from the transcript."
                    }
                    .into(),
                ),
            ),
            ("text", Some(agent_text.clone().into())),
            ("source", Some("mac-bridge".into())),
            (
                "meta",
                Some(obj(vec![
                    ("planner", or_null_truthy(&result, "planner")),
                    (
                        "thinkingTraceId",
                        result
                            .get("thinking")
                            .and_then(|t| t.get("traceId"))
                            .filter(|v| js_truthy(Some(v)))
                            .cloned()
                            .unwrap_or(Value::Null),
                    ),
                    (
                        "actions",
                        match result.get("actions") {
                            Some(v @ Value::Array(_)) => v.clone(),
                            _ => Value::Array(vec![]),
                        },
                    ),
                ])),
            ),
            (
                "at",
                match thinking_updated_at {
                    Some(v) => Some(v),
                    None => updated_at.clone(),
                },
            ),
        ]));

        if let Some(speech) = result.get("pendantSpeech").filter(|v| v.is_object()) {
            events.push(obj_opt(vec![
                ("eventId", Some(format!("cloud-{job_id}-tts").into())),
                ("stage", Some("tts".into())),
                ("status", Some("done".into())),
                ("label", Some("Response speech rendered".into())),
                (
                    "detail",
                    Some("The Mac rendered raw PCM for the pendant.".into()),
                ),
                ("text", Some(agent_text.into())),
                ("source", Some("mac-bridge".into())),
                (
                    // Absent speech fields are `undefined` and disappear from
                    // the serialized meta object entirely.
                    "meta",
                    Some(obj_opt(vec![
                        ("format", undef(speech, "format")),
                        ("sampleRate", undef(speech, "sampleRate")),
                        ("channels", undef(speech, "channels")),
                        ("bitsPerSample", undef(speech, "bitsPerSample")),
                        ("pcmBytes", undef(speech, "pcmBytes")),
                    ])),
                ),
                ("at", updated_at.clone()),
            ]));
        }

        // NOTE: this event intentionally has NO `text` key.
        events.push(obj_opt(vec![
            ("eventId", Some(format!("cloud-{job_id}-relay").into())),
            ("stage", Some("relay_result".into())),
            ("status", Some("done".into())),
            ("label", Some("Agent result stored in Cloudflare".into())),
            (
                "detail",
                Some("The response is ready for the pendant to download.".into()),
            ),
            ("source", Some("cloudflare".into())),
            ("meta", Some(Value::Null)),
            ("at", updated_at.clone()),
        ]));
    } else if !transcription_pending
        && !["failed", "cancelled", "completed"].contains(&status.as_str())
    {
        events.push(obj_opt(vec![
            ("eventId", Some(format!("cloud-{job_id}-agent-active").into())),
            ("stage", Some("agent".into())),
            (
                "status",
                Some(
                    if ["queued", "transcribed"].contains(&status.as_str()) {
                        "waiting"
                    } else {
                        "active"
                    }
                    .into(),
                ),
            ),
            (
                "label",
                Some(
                    if status == "transcribed" {
                        "Transcript ready; dispatching to Mac"
                    } else if status == "queued" {
                        "Waiting for Mac agent"
                    } else {
                        "Mac agent is processing"
                    }
                    .into(),
                ),
            ),
            (
                "detail",
                Some(
                    if status == "transcribed" {
                        "The pendant is linking this transcript to the agent job."
                    } else {
                        "The transcript is moving through the Mac bridge and agent."
                    }
                    .into(),
                ),
            ),
            ("text", Some("".into())),
            ("source", Some("cloudflare".into())),
            ("meta", Some(Value::Null)),
            ("at", updated_at.clone()),
        ]));
    }

    if let Some(Value::Array(device_events)) = job.get("deviceEvents") {
        for event in device_events {
            events.push(obj_opt(vec![
                ("eventId", undef(event, "eventId")),
                ("stage", undef(event, "stage")),
                ("status", undef(event, "status")),
                ("label", undef(event, "label")),
                ("detail", undef(event, "detail")),
                (
                    "text",
                    Some(if js_truthy(event.get("text")) {
                        event.get("text").cloned().unwrap_or(Value::Null)
                    } else {
                        "".into()
                    }),
                ),
                (
                    "source",
                    Some(if js_truthy(event.get("source")) {
                        event.get("source").cloned().unwrap_or(Value::Null)
                    } else {
                        "nrf9160".into()
                    }),
                ),
                (
                    "meta",
                    Some(if js_truthy(event.get("meta")) {
                        event.get("meta").cloned().unwrap_or(Value::Null)
                    } else {
                        Value::Null
                    }),
                ),
                ("at", undef(event, "at")),
            ]));
        }
    }

    let playback_done = events.iter().any(|event| {
        js_string(event.get("stage")) == "device_playback"
            && js_string(event.get("status")) == "done"
    });
    // Browser-originated runs never reach the pendant, so their finish line is
    // the Mac's answer rather than I2S playback.
    let dashboard_done = origin == "dashboard"
        && events.iter().any(|event| {
            js_string(event.get("stage")) == "agent" && js_string(event.get("status")) == "done"
        });

    let run_status = if ["failed", "cancelled"].contains(&status.as_str()) {
        "failed"
    } else if playback_done || dashboard_done {
        "completed"
    } else {
        "processing"
    };

    Some(obj_opt(vec![
        ("pipelineId", undef(job, "jobId")),
        ("kind", Some("voice_command".into())),
        ("command", Some(command.into())),
        ("source", Some("cloudflare".into())),
        ("origin", Some(origin.into())),
        ("status", Some(run_status.into())),
        ("events", Some(Value::Array(events))),
        ("createdAt", created_at),
        ("updatedAt", updated_at),
    ]))
}

#[cfg(test)]
mod tests;
