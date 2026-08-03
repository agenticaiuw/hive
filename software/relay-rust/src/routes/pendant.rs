//! The firmware-facing routes.
//!
//! The nRF9160 parses responses with substring scans rather than a JSON
//! parser: it finds the FIRST `"text"` and the FIRST `"jobId"` in the body.
//! Key ORDER in these responses is therefore load-bearing, which is why they
//! are built as ordered objects and serialized with the JS-compatible
//! stringifier.

use serde_json::{json, Map, Value};
use worker::{Response, Result};

use super::{clamp_query, job_belongs_to_other_device, sleep, Ctx};
use crate::audio_storage::{self, LoadPlan, PersistPlan};
use crate::device_auth::principal_owns_device;
use crate::http::{binary_response, error_response, header, json_response, query_param};
use crate::jobs::{
    create_agent_proxy_job, create_audio_capture, create_job_id, create_plan_job, is_device_online,
    normalize_pipeline_status, pendant_speech_for_job, public_job, sanitize_telemetry_meta,
    spoken_text_for_job, PendantAudio, PENDANT_PCM_BITS, PENDANT_PCM_CHANNELS,
    PENDANT_PCM_SAMPLE_RATE,
};
use crate::random::random_uuid;
use crate::speech::{synthesize_speech, transcribe_audio};
use crate::util::time::{now_iso, now_ms};
use crate::util::{b64, js_number, js_string, js_truthy, slice_utf16};

/// 1 MiB — the largest recording that may be inlined in D1.
pub const DIAGNOSTIC_AUDIO_MAX_BYTES: usize = 1024 * 1024;
/// 8 MiB — the largest recording that may be archived in R2.
pub const DIAGNOSTIC_AUDIO_R2_MAX_BYTES: usize = 8 * 1024 * 1024;

/// The EXACT header block the firmware sniffs.
///
/// It matches case-insensitively on a substring that INCLUDES the `": "`
/// separator, so there must be exactly one space after each colon and no
/// parameters on the audio content types. Adding `charset=utf-8` to
/// `audio/pcm` would brick reply playback.
fn send_pendant_audio(audio: PendantAudio, job_status: Option<&str>) -> Result<Response> {
    let mut headers: Vec<(&str, String)> = vec![
        ("Content-Type", audio.mime_type.clone()),
        ("Content-Length", audio.audio.len().to_string()),
        ("Cache-Control", "no-store".to_string()),
        ("X-Audio-Format", audio.format.clone()),
        ("X-Audio-Sample-Rate", PENDANT_PCM_SAMPLE_RATE.to_string()),
        ("X-Audio-Channels", PENDANT_PCM_CHANNELS.to_string()),
        ("X-Audio-Bits", PENDANT_PCM_BITS.to_string()),
    ];
    if let Some(status) = job_status {
        headers.push(("X-Pendant-Job-Status", status.to_string()));
    }
    binary_response(200, audio.audio, &headers)
}

/// `POST /v1/pendant/announce`
///
/// Creates a visible pending job the moment the pendant stops recording,
/// seconds before the upload itself completes.
pub async fn announce(ctx: &Ctx) -> Result<Response> {
    let device_id = super::or_default(ctx.body_str("deviceId"), "nrf9160-pendant");

    if !principal_owns_device(&ctx.principal, &device_id) {
        return error_response(
            403,
            "Blocked for safety: a device may only announce its own audio.",
        );
    }

    let now = now_iso();
    let format = ctx.body_val("format");
    let telemetry = json!({
        "storage": "microSD",
        "format": if js_truthy(format) { js_string(format) } else { "wav".to_string() },
        "expectedPcmBytes": nonzero_number(ctx.body_val("pcmBytes")),
        "sampleRate": nonzero_number(ctx.body_val("sampleRate")),
        "uploadState": "uploading",
        "announcedAt": now,
    });

    let job = create_plan_job(
        create_job_id(&random_uuid()),
        json!(""),
        Some(&device_id),
        ctx.body_str_opt("sessionId").as_deref(),
        "transcribing",
        Some(telemetry),
        &now,
    );
    ctx.store.create_job(&job).await?;

    // The firmware greps `"jobId"` out of this body.
    json_response(201, &json!({ "ok": true, "jobId": job["jobId"] }))
}

/// `Number(value || 0) || null`
fn nonzero_number(value: Option<&Value>) -> Value {
    let n = js_number(value);
    if n.is_finite() && n != 0.0 {
        json!(n)
    } else {
        Value::Null
    }
}

/// `POST /v1/transcribe` — the hot firmware path.
pub async fn transcribe(ctx: &Ctx) -> Result<Response> {
    let request_device_id = ctx.body_str("deviceId");
    if ctx.is_device()
        && (request_device_id.is_empty()
            || !principal_owns_device(&ctx.principal, &request_device_id))
    {
        return error_response(
            403,
            "Blocked for safety: deviceId must identify the authenticated device.",
        );
    }

    let raw_audio = js_string(ctx.body_val("audioBase64"));
    let audio_base64 = b64::strip_data_url(&raw_audio).to_string();
    let audio_bytes = b64::byte_length(&audio_base64);

    let requested_telemetry = ctx
        .body_object("inputTelemetry")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));

    let format_value = ctx.body_val("format");
    let format = if js_truthy(format_value) {
        js_string(format_value)
    } else {
        "wav".to_string()
    };
    let language = ctx.body_val("language").cloned().unwrap_or(Value::Null);
    let language_or_null = if js_truthy(Some(&language)) {
        language.clone()
    } else {
        Value::Null
    };

    let mut transcription_job: Option<Value> = None;
    let mut capture: Option<Value> = None;

    if audio_bytes > 0 {
        let announced_job_id = ctx.body_str("jobId");
        let announced = if announced_job_id.is_empty() {
            None
        } else {
            ctx.store.get_job(&announced_job_id).await?
        };

        let reusable = announced.as_ref().is_some_and(|job| {
            js_string(job.get("type")) == "plan"
                && !js_truthy(job.get("result"))
                && js_string(job.get("status")) == "transcribing"
        });

        if reusable {
            // The pendant announced this recording before uploading; attach
            // the audio to the already-visible job instead of a new one.
            let announced = announced.unwrap();
            let mut telemetry = announced
                .get("inputTelemetry")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            merge_into(&mut telemetry, &requested_telemetry);
            let storage = first_truthy(&[
                requested_telemetry.get("storage"),
                announced.get("inputTelemetry").and_then(|t| t.get("storage")),
            ])
            .unwrap_or(json!("microSD"));

            set(&mut telemetry, "audioBytes", json!(audio_bytes));
            set(&mut telemetry, "format", json!(format));
            set(&mut telemetry, "storage", storage);
            set(&mut telemetry, "transcriptionLanguage", language_or_null.clone());
            set(&mut telemetry, "uploadState", json!("uploaded"));

            transcription_job = ctx
                .store
                .update_job(
                    &js_string(announced.get("jobId")),
                    &json!({ "status": "transcribing", "inputTelemetry": telemetry }),
                )
                .await?;
        } else {
            let mut telemetry = requested_telemetry.clone();
            let storage = first_truthy(&[requested_telemetry.get("storage")])
                .unwrap_or(json!("microSD"));
            set(&mut telemetry, "audioBytes", json!(audio_bytes));
            set(&mut telemetry, "format", json!(format));
            set(&mut telemetry, "storage", storage);
            set(&mut telemetry, "transcriptionLanguage", language_or_null.clone());

            let device_id = super::or_default(request_device_id.clone(), "nrf9160-pendant");
            let job = create_plan_job(
                create_job_id(&random_uuid()),
                json!(""),
                Some(&device_id),
                ctx.body_str_opt("sessionId").as_deref(),
                "transcribing",
                Some(telemetry),
                &now_iso(),
            );
            ctx.store.create_job(&job).await?;
            transcription_job = Some(job);
        }

        // Persist the raw recording BEFORE speech-to-text runs, so the Mac
        // capture watcher can download it while Whisper is still working.
        capture = persist_capture(ctx, &audio_base64, audio_bytes, &format, &language_or_null)
            .await?;
    }

    let started_at = now_ms();
    let result = transcribe_audio(
        &ctx.env,
        &ctx.cfg,
        &audio_base64,
        Some(&format),
        js_string(Some(&language)).as_str().into(),
    )
    .await;
    let duration_ms = now_ms() - started_at;

    let result = match result {
        Ok(result) => result,
        Err(error) => {
            // Best-effort failure marking on both records.
            let message = if error.message().is_empty() {
                "Transcription failed.".to_string()
            } else {
                error.message().to_string()
            };
            let patch = json!({ "status": "failed", "error": message });
            if let Some(job) = &transcription_job {
                let _ = ctx
                    .store
                    .update_job(&js_string(job.get("jobId")), &patch)
                    .await;
            }
            if let Some(capture) = &capture {
                let _ = ctx
                    .store
                    .update_job(&js_string(capture.get("jobId")), &patch)
                    .await;
            }
            return error_response(error.status(), &message);
        }
    };

    if let Some(job) = &transcription_job {
        let mut telemetry = job
            .get("inputTelemetry")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        set(&mut telemetry, "transcriptionModel", json!(result.model));
        set(
            &mut telemetry,
            "transcriptionLanguage",
            result
                .language
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        set(&mut telemetry, "transcriptionDurationMs", json!(duration_ms));

        transcription_job = ctx
            .store
            .update_job(
                &js_string(job.get("jobId")),
                &json!({
                    "command": result.text,
                    "status": "transcribed",
                    "inputTelemetry": telemetry
                }),
            )
            .await?;
    }

    if let Some(current) = &capture {
        let language = result
            .language
            .clone()
            .map(Value::String)
            .filter(|v| js_truthy(Some(v)))
            .unwrap_or(language_or_null.clone());
        capture = ctx
            .store
            .update_job(
                &js_string(current.get("jobId")),
                &json!({
                    "status": "completed",
                    "language": language,
                    "transcript": result.text,
                    "transcriptionModel": result.model
                }),
            )
            .await?;
    }

    // KEY ORDER IS LOAD-BEARING: the firmware greps the FIRST `"text"` and the
    // FIRST `"jobId"` in this body.
    json_response(
        200,
        &json!({
            "ok": true,
            "text": result.text,
            "model": result.model,
            "language": result.language.map(Value::String).unwrap_or(Value::Null),
            "captureId": capture
                .as_ref()
                .map(|c| c["jobId"].clone())
                .unwrap_or(Value::Null),
            "jobId": transcription_job
                .as_ref()
                .map(|j| j["jobId"].clone())
                .unwrap_or(Value::Null),
        }),
    )
}

/// Archive the recording, honouring the asymmetric size gates.
async fn persist_capture(
    ctx: &Ctx,
    audio_base64: &str,
    audio_bytes: usize,
    format: &str,
    language: &Value,
) -> Result<Option<Value>> {
    let bucket = ctx.env.bucket("AUDIO_BUCKET").ok();
    let limit = if bucket.is_some() {
        DIAGNOSTIC_AUDIO_R2_MAX_BYTES
    } else {
        DIAGNOSTIC_AUDIO_MAX_BYTES
    };
    if audio_bytes > limit {
        // Oversized audio is still transcribed — it is just not archived.
        return Ok(None);
    }

    let allow_d1_fallback = audio_bytes <= DIAGNOSTIC_AUDIO_MAX_BYTES;
    let capture_id = create_job_id(&random_uuid());
    let created_at = now_iso();

    let plan = match audio_storage::plan_persist(
        &capture_id,
        format,
        &created_at,
        &ctx.cfg.audio_bucket_prefix,
        bucket.is_some(),
        allow_d1_fallback,
    ) {
        Ok(plan) => plan,
        // A key-construction failure propagates in the JS too.
        Err(message) => return Err(worker::Error::RustError(message)),
    };

    let audio = b64::decode(audio_base64);
    let (storage, warning) = match plan {
        PersistPlan::D1Fallback => (
            audio_storage::d1_fallback(audio_base64, None),
            None,
        ),
        PersistPlan::Unavailable(warning) => {
            worker::console_warn!("[relay] {warning}");
            // The capture is dropped entirely.
            return Ok(None);
        }
        PersistPlan::WriteR2 {
            key,
            content_type,
            custom_capture_id,
            custom_format,
            custom_created_at,
        } => {
            let bucket = bucket.as_ref().unwrap();
            let mut metadata = std::collections::HashMap::new();
            metadata.insert("captureId".to_string(), custom_capture_id);
            metadata.insert("format".to_string(), custom_format);
            metadata.insert("createdAt".to_string(), custom_created_at);

            let written = bucket
                .put(&key, audio.clone())
                .http_metadata(worker::HttpMetadata {
                    content_type: Some(content_type.to_string()),
                    ..Default::default()
                })
                .custom_metadata(metadata)
                .execute()
                .await;

            match written {
                Ok(object) => (
                    audio_storage::r2_result(
                        &key,
                        content_type,
                        audio_bytes as f64,
                        audio.len(),
                        object.map(|o| o.http_etag()),
                        &now_iso(),
                    ),
                    None,
                ),
                Err(error) => {
                    let warning = audio_storage::write_failure_warning(
                        &error.to_string(),
                        allow_d1_fallback,
                    );
                    worker::console_warn!("[relay] {warning}");
                    if allow_d1_fallback {
                        (
                            audio_storage::d1_fallback(audio_base64, Some(warning)),
                            None,
                        )
                    } else {
                        return Ok(None);
                    }
                }
            }
        }
    };
    let _ = warning;

    let capture = create_audio_capture(
        capture_id,
        storage
            .get("audioBase64")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        storage.get("audioRef").cloned().unwrap_or(Value::Null),
        storage.get("audioStorage").cloned().unwrap_or(Value::Null),
        storage
            .get("audioStorageWarning")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        json!(audio_bytes),
        json!(format),
        language.clone(),
        Value::Null,
        Value::Null,
        "received",
        &created_at,
    );

    match ctx.store.create_job(&capture).await {
        Ok(_) => Ok(Some(capture)),
        Err(error) => {
            // Clean up the orphaned R2 object before letting the error escape.
            if let (Some(bucket), Some(key)) = (
                bucket.as_ref(),
                audio_storage::can_delete_capture_object(&capture),
            ) {
                if let Err(cleanup) = bucket.delete(&key).await {
                    worker::console_warn!("[relay] Could not remove orphaned audio object: {cleanup}");
                }
            }
            Err(error)
        }
    }
}

/// `POST /v1/pendant/command` — RAW WAV body.
pub async fn command(ctx: &Ctx, audio: Vec<u8>) -> Result<Response> {
    if audio.is_empty() {
        return error_response(400, "Raw audio body is required.");
    }

    let format = super::or_default(
        header(&ctx.req, "x-audio-format").trim().to_lowercase(),
        "wav",
    );
    let language = header(&ctx.req, "x-language").trim().to_string();
    let device_id = super::or_default(
        header(&ctx.req, "x-device-id").trim().to_string(),
        "nrf9160-pendant",
    );

    if !principal_owns_device(&ctx.principal, &device_id) {
        return error_response(
            403,
            "Blocked for safety: a device may only upload its own commands.",
        );
    }

    let session_id = header(&ctx.req, "x-session-id").trim().to_string();
    // Dispatch is enabled unless the value is exactly the string "0".
    let should_dispatch = query_param(&ctx.req, "dispatch").unwrap_or_else(|| "1".to_string()) != "0";

    let audio_bytes = audio.len();
    let started_at = now_ms();
    let transcript = match transcribe_audio(
        &ctx.env,
        &ctx.cfg,
        &b64::encode(&audio),
        Some(&format),
        if language.is_empty() { None } else { Some(&language) },
    )
    .await
    {
        Ok(transcript) => transcript,
        Err(error) => {
            let message = if error.message().is_empty() {
                "Pendant audio upload failed.".to_string()
            } else {
                error.message().to_string()
            };
            return error_response(error.status(), &message);
        }
    };
    let duration_ms = now_ms() - started_at;

    let mut job: Option<Value> = None;
    let mut mac_bridge_online = false;

    if should_dispatch {
        let bridge = ctx.store.mac_bridge().await?;
        mac_bridge_online = is_device_online(bridge.as_ref(), now_ms());

        if mac_bridge_online {
            let created = create_plan_job(
                create_job_id(&random_uuid()),
                json!(transcript.text),
                Some(&device_id),
                if session_id.is_empty() {
                    None
                } else {
                    Some(session_id.as_str())
                },
                "queued",
                Some(json!({
                    "audioBytes": audio_bytes,
                    "format": format,
                    "sampleRate": PENDANT_PCM_SAMPLE_RATE,
                    "channels": PENDANT_PCM_CHANNELS,
                    "bitsPerSample": PENDANT_PCM_BITS,
                    "transcriptionModel": transcript.model,
                    "transcriptionLanguage": transcript
                        .language
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    "transcriptionDurationMs": duration_ms,
                })),
                &now_iso(),
            );
            ctx.store.create_job(&created).await?;
            job = Some(created);
        }
    }

    json_response(
        if job.is_some() { 202 } else { 200 },
        &json!({
            "ok": true,
            "text": transcript.text,
            "model": transcript.model,
            "language": transcript.language.map(Value::String).unwrap_or(Value::Null),
            "audioBytes": audio_bytes,
            "dispatchRequested": should_dispatch,
            "macBridgeOnline": mac_bridge_online,
            "queued": job.is_some(),
            "job": job.as_ref().map(public_job).unwrap_or(Value::Null),
        }),
    )
}

/// `POST /v1/speak`
pub async fn speak(ctx: &Ctx) -> Result<Response> {
    let text = js_string(ctx.body_val("text"));
    match synthesize_speech(&ctx.cfg, &text, "mp3").await {
        Ok(speech) => json_response(
            200,
            &json!({
                "ok": true,
                "audioBase64": b64::encode(&speech.audio),
                "audioBytes": speech.audio_bytes,
                "mimeType": speech.mime_type,
                "format": speech.format,
                "model": speech.model,
                "voice": speech.voice,
            }),
        ),
        Err(error) => {
            let message = super::or_default(
                error.message().to_string(),
                "Speech synthesis failed.",
            );
            error_response(error.status(), &message)
        }
    }
}

/// `POST /v1/pendant/speak`
pub async fn pendant_speak(ctx: &Ctx) -> Result<Response> {
    let text = js_string(ctx.body_val("text"));
    match synthesize_speech(&ctx.cfg, &text, "pcm").await {
        Ok(speech) => send_pendant_audio(
            PendantAudio {
                audio: speech.audio,
                mime_type: speech.mime_type,
                format: speech.format,
            },
            None,
        ),
        Err(error) => {
            let message = super::or_default(
                error.message().to_string(),
                "Pendant speech synthesis failed.",
            );
            error_response(error.status(), &message)
        }
    }
}

/// `GET /v1/pendant/jobs/:jobId/speech` — the firmware's reply download.
///
/// HTTP 202 is the firmware's RETRY signal (`-EAGAIN`); any other non-2xx is a
/// hard failure that aborts playback. The long-poll timeout must therefore
/// never become 204 or 200.
pub async fn job_speech(ctx: &Ctx, job_id: &str) -> Result<Response> {
    let wait_param = query_param(&ctx.req, "waitMs");
    let wait_ms = clamp_query(wait_param.as_deref(), 25000.0, 0.0, 28000.0);

    // A non-numeric waitMs yields NaN in JS, and `Date.now() >= NaN` is always
    // false, so the JS loops until the job resolves or the platform kills the
    // request. We reproduce "no deadline" but cap it at the same 28 s ceiling
    // the valid path clamps to, so a malformed query cannot pin an isolate.
    // The firmware always sends waitMs=25000, so this path is unreachable for
    // the device.
    let deadline = now_ms() + if wait_ms.is_nan() { 28000 } else { wait_ms as i64 };

    loop {
        let Some(job) = ctx.store.get_job(job_id).await? else {
            return error_response(404, "Job not found.");
        };

        if job_belongs_to_other_device(ctx, &job, "createdBy") {
            return error_response(403, "Blocked for safety: this job belongs to another device.");
        }

        let status = js_string(job.get("status"));

        if status == "failed" || status == "cancelled" {
            let error = js_string(job.get("error"));
            let message = if error.is_empty() {
                format!("Mac job {status}.")
            } else {
                error
            };
            return error_response(502, &message);
        }

        if status == "plan_ready" || status == "completed" {
            if let Some(speech) = pendant_speech_for_job(&job) {
                return send_pendant_audio(speech, Some(&status));
            }

            let text = spoken_text_for_job(&job);
            if text.is_empty() {
                return error_response(422, "Mac job completed without a spoken response.");
            }

            return match synthesize_speech(&ctx.cfg, &text, "pcm").await {
                Ok(speech) => send_pendant_audio(
                    PendantAudio {
                        audio: speech.audio,
                        mime_type: speech.mime_type,
                        format: speech.format,
                    },
                    Some(&status),
                ),
                Err(error) => {
                    let message = super::or_default(
                        error.message().to_string(),
                        "Pendant speech synthesis failed.",
                    );
                    error_response(error.status(), &message)
                }
            };
        }

        if now_ms() >= deadline {
            // 202 == retry, for the firmware.
            return json_response(202, &json!({ "ok": true, "ready": false, "status": status }));
        }

        sleep(350).await;
    }
}

/// `POST /v1/pendant/jobs/:jobId/events`
pub async fn job_events(ctx: &Ctx, job_id: &str) -> Result<Response> {
    let stage = ctx.body_str("stage").to_lowercase();
    let status = normalize_pipeline_status(ctx.body_val("status"));

    let label_value = ctx.body_val("label");
    let label = slice_utf16(
        if js_truthy(label_value) {
            js_string(label_value)
        } else {
            stage.clone()
        }
        .trim(),
        160,
    );
    let detail = slice_utf16(js_string(ctx.body_val("detail")).trim(), 1000);

    let valid_stage = (1..=48).contains(&stage.len())
        && stage
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if !valid_stage {
        return error_response(400, "A lowercase pipeline stage is required.");
    }

    let Some(job) = ctx.store.get_job(job_id).await? else {
        return error_response(404, "Job not found.");
    };

    let event = json!({
        "eventId": format!("device_evt_{}", random_uuid()),
        "stage": stage,
        "status": status,
        "label": if label.is_empty() { stage.clone() } else { label },
        "detail": detail,
        "source": "nrf9160",
        "meta": sanitize_telemetry_meta(ctx.body_val("meta")),
        "at": now_iso(),
    });

    // Keep only the last 32 device events.
    let mut device_events = match job.get("deviceEvents") {
        Some(Value::Array(items)) => items.clone(),
        _ => vec![],
    };
    device_events.push(event.clone());
    let start = device_events.len().saturating_sub(32);
    let device_events = device_events[start..].to_vec();

    ctx.store
        .update_job(job_id, &json!({ "deviceEvents": device_events }))
        .await?;

    // Reuse the authenticated bridge queue to deliver device telemetry to the
    // local dashboard; the nRF never needs direct access to the Mac.
    let mut proxy_body = json!({
        "pipelineId": job_id,
        "kind": super::or_default(js_string(job.get("type")), "voice_command"),
        "command": js_string(job.get("command")),
        "sessionId": job.get("sessionId").cloned().unwrap_or(Value::Null),
    });
    merge_into(&mut proxy_body, &event);

    let proxy = create_agent_proxy_job(
        create_job_id(&random_uuid()),
        "POST",
        "/pipeline/events",
        proxy_body,
        Some("pendant-telemetry"),
        &now_iso(),
    );
    ctx.store.create_job(&proxy).await?;

    json_response(202, &json!({ "ok": true, "event": event }))
}

// --- small JSON helpers ----------------------------------------------------

/// `Object.assign(target, source)` with JS key-position semantics.
fn merge_into(target: &mut Value, source: &Value) {
    if let (Value::Object(target), Value::Object(source)) = (target, source) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
}

fn set(target: &mut Value, key: &str, value: Value) {
    if let Value::Object(map) = target {
        map.insert(key.to_string(), value);
    }
}

/// The first truthy candidate, mirroring a chain of `||`.
fn first_truthy(candidates: &[Option<&Value>]) -> Option<Value> {
    candidates
        .iter()
        .flatten()
        .find(|value| js_truthy(Some(value)))
        .map(|value| (*value).clone())
}
