//! Port of `cloud-relay/audioStorage.js`.
//!
//! The R2 call itself lives in the wasm glue; everything that decides *what*
//! to write, *where*, and what the resulting metadata looks like is pure and
//! tested here.

use serde_json::{json, Value};

use crate::util::time::{iso_from_ms, parse_iso};

pub const DEFAULT_OBJECT_PREFIX: &str = "audio-captures";

/// Port of `normalizeAudioFormat`: strip a leading `audio/`, lowercase, and
/// truncate at the first `;` parameter.
pub fn normalize_audio_format(format: &str) -> String {
    let lowered = format.trim().to_lowercase();
    let stripped = lowered.strip_prefix("audio/").unwrap_or(&lowered);
    let base = stripped.split(';').next().unwrap_or("");
    match base {
        "x-wav" => "wav".to_string(),
        "mpeg" => "mp3".to_string(),
        other => other.to_string(),
    }
}

/// Port of `audioContentType`.
pub fn audio_content_type(format: &str) -> &'static str {
    match normalize_audio_format(format).as_str() {
        "ogg" | "opus" | "ogg-opus" => "audio/ogg",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "pcm" | "s16le" => "audio/pcm",
        _ => "application/octet-stream",
    }
}

/// Port of `audioExtension`.
pub fn audio_extension(format: &str) -> &'static str {
    match normalize_audio_format(format).as_str() {
        "ogg" | "opus" | "ogg-opus" => "ogg",
        "wav" => "wav",
        "mp3" | "mpeg" => "mp3",
        "pcm" | "s16le" => "pcm",
        _ => "bin",
    }
}

/// Port of `normalizeObjectPrefix`.
pub fn normalize_object_prefix(prefix: &str) -> Result<String, String> {
    let raw = if prefix.is_empty() {
        DEFAULT_OBJECT_PREFIX
    } else {
        prefix
    };
    let trimmed = raw.trim().trim_matches('/');

    let valid_segment = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    };

    if trimmed.is_empty() || trimmed.len() > 160 || !trimmed.split('/').all(valid_segment) {
        return Err("AUDIO_BUCKET_PREFIX contains an invalid path segment.".to_string());
    }

    Ok(trimmed.to_string())
}

/// Port of `createAudioObjectKey`.
///
/// Keys are deterministic: `<prefix>/<YYYY>/<MM>/<DD>/<captureId>.<ext>`.
pub fn create_audio_object_key(
    capture_id: &str,
    format: &str,
    created_at: &str,
    prefix: &str,
) -> Result<String, String> {
    let safe_capture_id = capture_id.trim();
    let valid = (1..=160).contains(&safe_capture_id.len())
        && safe_capture_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'));
    if !valid {
        return Err("A valid captureId is required for durable audio storage.".to_string());
    }

    let Some(ms) = parse_iso(created_at) else {
        return Err("A valid createdAt timestamp is required for audio storage.".to_string());
    };

    let safe_prefix = normalize_object_prefix(prefix)?;
    let day = iso_from_ms(ms)[..10].replace('-', "/");

    Ok(format!(
        "{safe_prefix}/{day}/{safe_capture_id}.{}",
        audio_extension(format)
    ))
}

/// Port of `isTrustedAudioKey`.
///
/// Guards against reading another capture's object: the key must be relative,
/// traversal-free, and its final segment must belong to this capture.
pub fn is_trusted_audio_key(key: &str, capture_id: &str) -> bool {
    if key.len() > 512 || key.starts_with('/') || key.contains("..") {
        return false;
    }
    let segments: Vec<&str> = key.split('/').collect();
    let all_safe = segments.iter().all(|part| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    });
    if !all_safe {
        return false;
    }
    match segments.last() {
        Some(last) => last.starts_with(&format!("{capture_id}.")),
        None => false,
    }
}

/// What the caller should do with a recording, decided before touching R2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PersistPlan {
    /// Write to R2 under `key`, then call [`r2_result`].
    WriteR2 {
        key: String,
        content_type: &'static str,
        custom_capture_id: String,
        custom_format: String,
        custom_created_at: String,
    },
    /// No bucket binding, but the recording is small enough for D1.
    D1Fallback,
    /// No bucket binding and too large for D1 — the capture is dropped.
    Unavailable(String),
}

/// Decide how to persist a capture. `has_bucket` mirrors `bucket?.put`.
pub fn plan_persist(
    capture_id: &str,
    format: &str,
    created_at: &str,
    prefix: &str,
    has_bucket: bool,
    allow_d1_fallback: bool,
) -> Result<PersistPlan, String> {
    if !has_bucket {
        return Ok(if allow_d1_fallback {
            PersistPlan::D1Fallback
        } else {
            PersistPlan::Unavailable(
                "R2 is not configured and the recording is too large for D1.".to_string(),
            )
        });
    }

    // Key construction happens BEFORE the write and can itself fail; the JS
    // lets that error propagate rather than falling back.
    let key = create_audio_object_key(capture_id, format, created_at, prefix)?;
    let normalized = normalize_audio_format(format);

    Ok(PersistPlan::WriteR2 {
        content_type: audio_content_type(format),
        key,
        custom_capture_id: capture_id.to_string(),
        custom_format: if normalized.is_empty() {
            "unknown".to_string()
        } else {
            normalized
        },
        custom_created_at: parse_iso(created_at)
            .map(iso_from_ms)
            .unwrap_or_else(|| created_at.to_string()),
    })
}

/// Shape returned after a successful R2 write.
///
/// `audioBase64` is deliberately ABSENT (JS sets it to `undefined`, which
/// `JSON.stringify` drops) so the stored D1 row carries no base64 copy.
pub fn r2_result(
    key: &str,
    content_type: &str,
    declared_audio_bytes: f64,
    actual_len: usize,
    etag: Option<String>,
    now: &str,
) -> Value {
    // `Number(audioBytes) || audio.length`
    let audio_bytes = if declared_audio_bytes.is_finite() && declared_audio_bytes != 0.0 {
        declared_audio_bytes
    } else {
        actual_len as f64
    };

    json!({
        "audioStorage": "r2",
        "audioRef": {
            "provider": "r2",
            "key": key,
            "contentType": content_type,
            "audioBytes": audio_bytes,
            "etag": etag.map(Value::String).unwrap_or(Value::Null),
            "persistedAt": now,
        }
    })
}

/// Shape returned when the recording stays in D1 as base64.
pub fn d1_fallback(clean_base64: &str, warning: Option<String>) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("audioBase64".into(), clean_base64.into());
    map.insert("audioStorage".into(), "d1-base64".into());
    map.insert("audioRef".into(), Value::Null);
    if let Some(warning) = warning {
        map.insert("audioStorageWarning".into(), warning.into());
    }
    Value::Object(map)
}

/// Shape returned when the recording cannot be archived at all.
pub fn unavailable_storage(warning: &str) -> Value {
    json!({
        "audioStorage": "unavailable",
        "audioRef": Value::Null,
        "audioStorageWarning": warning,
    })
}

/// Build the warning text for a failed R2 write.
pub fn write_failure_warning(detail: &str, allow_d1_fallback: bool) -> String {
    let detail = crate::util::slice_utf16(detail, 240);
    if allow_d1_fallback {
        format!("R2 write failed; retained D1 Base64 fallback: {detail}")
    } else {
        format!("R2 write failed and the recording is too large for D1: {detail}")
    }
}

/// Where `loadAudioCapture` should read a capture's bytes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadPlan {
    /// Try R2 first at this key, falling back to base64 if the object is gone.
    R2 { key: String, content_type: String },
    /// Read the legacy base64 blob out of D1.
    D1Base64 { content_type: &'static str },
    /// Nothing readable.
    None,
}

/// Decide where a capture's audio lives.
///
/// Returns `R2` only when the reference is trusted; an untrusted key falls
/// through to the base64 blob (and yields `None` when there isn't one).
pub fn plan_load(capture: &Value) -> LoadPlan {
    if capture.get("type").and_then(|v| v.as_str()) != Some("audio_capture") {
        return LoadPlan::None;
    }

    let capture_id = capture.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
    let format = capture.get("format").and_then(|v| v.as_str()).unwrap_or("");

    if let Some(reference) = capture.get("audioRef") {
        let provider = reference.get("provider").and_then(|v| v.as_str());
        let key = reference.get("key").and_then(|v| v.as_str()).unwrap_or("");
        if provider == Some("r2") && is_trusted_audio_key(key, capture_id) {
            let content_type = reference
                .get("contentType")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| audio_content_type(format));
            return LoadPlan::R2 {
                key: key.to_string(),
                content_type: content_type.to_string(),
            };
        }
    }

    let base64 = capture
        .get("audioBase64")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if base64.is_empty() {
        return LoadPlan::None;
    }

    LoadPlan::D1Base64 {
        content_type: audio_content_type(format),
    }
}

/// Whether an R2 object may be deleted for this capture (orphan cleanup).
pub fn can_delete_capture_object(capture: &Value) -> Option<String> {
    let reference = capture.get("audioRef")?;
    if reference.get("provider").and_then(|v| v.as_str()) != Some("r2") {
        return None;
    }
    let key = reference.get("key").and_then(|v| v.as_str())?;
    let capture_id = capture.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
    if !is_trusted_audio_key(key, capture_id) {
        return None;
    }
    Some(key.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Mirrors audioStorage.test.js test 14 -----------------------------

    #[test]
    fn normalizes_content_types() {
        assert_eq!(audio_content_type("ogg-opus"), "audio/ogg");
        assert_eq!(audio_content_type("audio/ogg;codecs=opus"), "audio/ogg");
        assert_eq!(audio_content_type("audio/mpeg"), "audio/mpeg");
        assert_eq!(audio_content_type("s16le"), "audio/pcm");
        assert_eq!(audio_content_type("unexpected"), "application/octet-stream");
        assert_eq!(audio_content_type("wav"), "audio/wav");
        assert_eq!(audio_content_type("x-wav"), "audio/wav");
        assert_eq!(audio_content_type("audio/x-wav"), "audio/wav");
        assert_eq!(audio_content_type(""), "application/octet-stream");
    }

    #[test]
    fn builds_deterministic_object_keys() {
        assert_eq!(
            create_audio_object_key(
                "job_safe",
                "application/octet-stream",
                "2026-01-02T00:00:00.000Z",
                "tenant/default/audio"
            )
            .unwrap(),
            "tenant/default/audio/2026/01/02/job_safe.bin"
        );

        assert_eq!(
            create_audio_object_key(
                "job_capture_1",
                "wav",
                "2026-08-02T10:20:30.000Z",
                DEFAULT_OBJECT_PREFIX
            )
            .unwrap(),
            "audio-captures/2026/08/02/job_capture_1.wav"
        );

        assert_eq!(
            create_audio_object_key("job_x", "opus", "2026-08-02T10:20:30.000Z", "p").unwrap(),
            "p/2026/08/02/job_x.ogg"
        );
    }

    #[test]
    fn rejects_unsafe_capture_ids_prefixes_and_timestamps() {
        let err =
            create_audio_object_key("../evil", "wav", "2026-01-02T00:00:00.000Z", "p").unwrap_err();
        assert_eq!(err, "A valid captureId is required for durable audio storage.");

        // Dots are not allowed in a captureId, only in path segments.
        assert!(create_audio_object_key("job.1", "wav", "2026-01-02T00:00:00.000Z", "p").is_err());
        assert!(create_audio_object_key("", "wav", "2026-01-02T00:00:00.000Z", "p").is_err());

        let err = create_audio_object_key("job_1", "wav", "not-a-date", "p").unwrap_err();
        assert_eq!(err, "A valid createdAt timestamp is required for audio storage.");

        let err = create_audio_object_key("job_1", "wav", "2026-01-02T00:00:00.000Z", "bad prefix")
            .unwrap_err();
        assert_eq!(err, "AUDIO_BUCKET_PREFIX contains an invalid path segment.");
    }

    #[test]
    fn normalizes_prefixes_by_stripping_slashes() {
        assert_eq!(
            normalize_object_prefix("/audio-captures/").unwrap(),
            "audio-captures"
        );
        assert_eq!(normalize_object_prefix("a/b/c").unwrap(), "a/b/c");
        assert!(normalize_object_prefix("a//b").is_err());
        assert!(normalize_object_prefix("/").is_err());
        assert!(normalize_object_prefix(&"a".repeat(161)).is_err());
    }

    // --- Mirrors test 12: untrusted keys ----------------------------------

    #[test]
    fn refuses_untrusted_object_keys() {
        assert!(!is_trusted_audio_key("../another-users-audio.wav", "job_capture"));
        assert!(!is_trusted_audio_key("/abs/job_capture.wav", "job_capture"));
        assert!(!is_trusted_audio_key(
            "audio-captures/2026/08/02/other_job.wav",
            "job_capture"
        ));
        assert!(!is_trusted_audio_key(
            "audio captures/job_capture.wav",
            "job_capture"
        ));
        assert!(!is_trusted_audio_key(&"a".repeat(513), "job_capture"));

        assert!(is_trusted_audio_key(
            "audio-captures/2026/08/02/job_capture.wav",
            "job_capture"
        ));
    }

    #[test]
    fn a_prefix_match_is_not_enough_without_the_dot() {
        // `job_capture2.wav` must not satisfy captureId `job_capture`.
        assert!(!is_trusted_audio_key(
            "audio-captures/2026/08/02/job_capture2.wav",
            "job_capture"
        ));
    }

    // --- Mirrors tests 7, 10, 11: persistence decisions -------------------

    #[test]
    fn writes_to_r2_when_the_bucket_is_bound() {
        let plan = plan_persist(
            "job_capture_1",
            "wav",
            "2026-08-02T10:20:30.000Z",
            DEFAULT_OBJECT_PREFIX,
            true,
            true,
        )
        .unwrap();

        match plan {
            PersistPlan::WriteR2 {
                key,
                content_type,
                custom_capture_id,
                custom_format,
                custom_created_at,
            } => {
                assert_eq!(key, "audio-captures/2026/08/02/job_capture_1.wav");
                assert_eq!(content_type, "audio/wav");
                assert_eq!(custom_capture_id, "job_capture_1");
                assert_eq!(custom_format, "wav");
                assert_eq!(custom_created_at, "2026-08-02T10:20:30.000Z");
            }
            other => panic!("expected an R2 write, got {other:?}"),
        }
    }

    #[test]
    fn keeps_legacy_d1_base64_when_r2_is_not_configured() {
        assert_eq!(
            plan_persist("job_legacy", "wav", "2026-08-02T00:00:00.000Z", "p", false, true)
                .unwrap(),
            PersistPlan::D1Fallback
        );

        let result = d1_fallback("bGVnYWN5", None);
        assert_eq!(result["audioStorage"], "d1-base64");
        assert_eq!(result["audioBase64"], "bGVnYWN5");
        assert_eq!(result["audioRef"], Value::Null);
        assert!(result.get("audioStorageWarning").is_none());
    }

    #[test]
    fn does_not_force_oversized_audio_into_d1_when_r2_is_unavailable() {
        let plan =
            plan_persist("job_big", "wav", "2026-08-02T00:00:00.000Z", "p", false, false).unwrap();
        match plan {
            PersistPlan::Unavailable(warning) => {
                assert_eq!(
                    warning,
                    "R2 is not configured and the recording is too large for D1."
                );
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }

        let result =
            unavailable_storage("R2 is not configured and the recording is too large for D1.");
        assert_eq!(result["audioStorage"], "unavailable");
        assert_eq!(result["audioRef"], Value::Null);
        // No base64 key at all.
        assert!(result.get("audioBase64").is_none());
    }

    // --- Mirrors test 10: R2 write failure --------------------------------

    #[test]
    fn falls_back_to_d1_base64_when_an_r2_write_fails() {
        let warning = write_failure_warning("simulated bucket outage", true);
        assert!(warning.contains("simulated bucket outage"));
        assert!(warning.starts_with("R2 write failed; retained D1 Base64 fallback: "));

        let result = d1_fallback("ZG8gbm90IGxvc2UgbWU=", Some(warning));
        assert_eq!(result["audioStorage"], "d1-base64");
        assert_eq!(result["audioBase64"], "ZG8gbm90IGxvc2UgbWU=");
        assert!(result["audioStorageWarning"]
            .as_str()
            .unwrap()
            .contains("simulated bucket outage"));
    }

    #[test]
    fn oversized_write_failure_reports_the_d1_limit() {
        let warning = write_failure_warning("simulated bucket outage", false);
        assert!(warning.contains("too large for D1"));
        assert!(warning.contains("simulated bucket outage"));
    }

    #[test]
    fn write_failure_detail_is_truncated_to_240_chars() {
        let warning = write_failure_warning(&"x".repeat(500), true);
        let detail = warning
            .strip_prefix("R2 write failed; retained D1 Base64 fallback: ")
            .unwrap();
        assert_eq!(detail.len(), 240);
    }

    #[test]
    fn r2_result_leaves_only_a_durable_reference() {
        let result = r2_result(
            "audio-captures/2026/08/02/job_capture_1.wav",
            "audio/wav",
            15.0,
            15,
            Some("test-etag".to_string()),
            "2026-08-02T10:20:31.000Z",
        );

        assert_eq!(result["audioStorage"], "r2");
        // No base64 copy is retained.
        assert!(result.get("audioBase64").is_none());
        assert_eq!(
            result["audioRef"]["key"],
            "audio-captures/2026/08/02/job_capture_1.wav"
        );
        assert_eq!(result["audioRef"]["contentType"], "audio/wav");
        assert_eq!(result["audioRef"]["audioBytes"], 15.0);
        assert_eq!(result["audioRef"]["etag"], "test-etag");
        assert_eq!(result["audioRef"]["provider"], "r2");
    }

    #[test]
    fn r2_result_falls_back_to_the_actual_length_when_bytes_are_unknown() {
        // `Number(audioBytes) || audio.length`
        let result = r2_result("k", "audio/wav", 0.0, 42, None, "t");
        assert_eq!(result["audioRef"]["audioBytes"], 42.0);
        assert_eq!(result["audioRef"]["etag"], Value::Null);

        let result = r2_result("k", "audio/wav", f64::NAN, 42, None, "t");
        assert_eq!(result["audioRef"]["audioBytes"], 42.0);
    }

    // --- Mirrors tests 8, 9, 12: read path --------------------------------

    #[test]
    fn reads_an_r2_backed_recording_through_its_reference() {
        let capture = json!({
            "jobId": "job_capture_2",
            "type": "audio_capture",
            "format": "opus",
            "audioStorage": "r2",
            "audioRef": {
                "provider": "r2",
                "key": "audio-captures/2026/08/02/job_capture_2.ogg",
                "contentType": "audio/ogg"
            }
        });

        assert_eq!(
            plan_load(&capture),
            LoadPlan::R2 {
                key: "audio-captures/2026/08/02/job_capture_2.ogg".to_string(),
                content_type: "audio/ogg".to_string()
            }
        );
    }

    #[test]
    fn reads_legacy_base64_captures_from_d1() {
        let capture = json!({
            "jobId": "job_legacy",
            "type": "audio_capture",
            "format": "wav",
            "audioStorage": "d1-base64",
            "audioRef": Value::Null,
            "audioBase64": "bGVnYWN5IGF1ZGlv"
        });

        assert_eq!(
            plan_load(&capture),
            LoadPlan::D1Base64 {
                content_type: "audio/wav"
            }
        );
    }

    #[test]
    fn an_untrusted_key_yields_nothing_readable() {
        let capture = json!({
            "jobId": "job_capture",
            "type": "audio_capture",
            "format": "wav",
            "audioRef": { "provider": "r2", "key": "../another-users-audio.wav" }
        });
        assert_eq!(plan_load(&capture), LoadPlan::None);
    }

    #[test]
    fn non_capture_jobs_are_never_loadable() {
        let job = json!({ "jobId": "job_1", "type": "plan", "audioBase64": "AAAA" });
        assert_eq!(plan_load(&job), LoadPlan::None);
    }

    #[test]
    fn orphan_cleanup_only_targets_trusted_keys() {
        let capture = json!({
            "jobId": "job_orphan",
            "type": "audio_capture",
            "audioRef": {
                "provider": "r2",
                "key": "audio-captures/2026/08/02/job_orphan.wav"
            }
        });
        assert_eq!(
            can_delete_capture_object(&capture).as_deref(),
            Some("audio-captures/2026/08/02/job_orphan.wav")
        );

        let untrusted = json!({
            "jobId": "job_orphan",
            "audioRef": { "provider": "r2", "key": "../elsewhere.wav" }
        });
        assert_eq!(can_delete_capture_object(&untrusted), None);

        let d1 = json!({ "jobId": "job_orphan", "audioRef": Value::Null });
        assert_eq!(can_delete_capture_object(&d1), None);
    }
}
