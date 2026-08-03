//! Mirrors `cloud-relay/jobs.test.js` (suite tests 20–25) plus byte-level
//! differential fixtures.
//!
//! The `GOLDEN_*` constants are `JSON.stringify(voiceRunForJob(fixture))`
//! captured from the real JavaScript implementation under Node. Comparing the
//! serialized string — not a structural diff — also pins KEY ORDER, which the
//! dashboard and the nRF firmware both depend on.

use super::*;
use crate::util::jsonjs::stringify;
use serde_json::json;

fn pendant_completed() -> Value {
    json!({
        "jobId": "job_test",
        "type": "plan",
        "status": "plan_ready",
        "command": "open Outlook",
        "inputTelemetry": {
            "audioBytes": 148800,
            "durationMs": 4650,
            "sampleRate": 16000,
            "storage": "microSD"
        },
        "result": {
            "response": "Outlook is open.",
            "planner": "llm",
            "actions": [{
                "type": "open_app",
                "label": "Open Outlook",
                "params": { "appName": "Microsoft Outlook" }
            }],
            "pendantSpeech": { "format": "s16le", "sampleRate": 24000, "pcmBytes": 32000 }
        },
        "deviceEvents": [{
            "eventId": "device_done",
            "stage": "device_playback",
            "status": "done",
            "label": "Playback complete",
            "detail": "Done",
            "at": "2026-08-01T01:00:04.000Z"
        }],
        "createdAt": "2026-08-01T01:00:00.000Z",
        "updatedAt": "2026-08-01T01:00:04.000Z"
    })
}

const GOLDEN_PENDANT_COMPLETED: &str = r#"{"pipelineId":"job_test","kind":"voice_command","command":"open Outlook","source":"cloudflare","origin":"microsd","status":"completed","events":[{"eventId":"cloud-job_test-transcription","stage":"transcription","status":"done","label":"Transcript received from cloud","detail":"Speech-to-text completed before this job reached the Mac bridge.","text":"open Outlook","source":"cloudflare","meta":{"inputTelemetry":{"audioBytes":148800,"durationMs":4650,"sampleRate":16000,"storage":"microSD"}},"at":"2026-08-01T01:00:00.000Z"},{"eventId":"cloud-job_test-agent","stage":"agent","status":"done","label":"Mac action selected","detail":"The Mac agent produced this action plan from the transcript.","text":"Outlook is open.","source":"mac-bridge","meta":{"planner":"llm","thinkingTraceId":null,"actions":[{"type":"open_app","label":"Open Outlook","params":{"appName":"Microsoft Outlook"}}]},"at":"2026-08-01T01:00:04.000Z"},{"eventId":"cloud-job_test-tts","stage":"tts","status":"done","label":"Response speech rendered","detail":"The Mac rendered raw PCM for the pendant.","text":"Outlook is open.","source":"mac-bridge","meta":{"format":"s16le","sampleRate":24000,"pcmBytes":32000},"at":"2026-08-01T01:00:04.000Z"},{"eventId":"cloud-job_test-relay","stage":"relay_result","status":"done","label":"Agent result stored in Cloudflare","detail":"The response is ready for the pendant to download.","source":"cloudflare","meta":null,"at":"2026-08-01T01:00:04.000Z"},{"eventId":"device_done","stage":"device_playback","status":"done","label":"Playback complete","detail":"Done","text":"","source":"nrf9160","meta":null,"at":"2026-08-01T01:00:04.000Z"}],"createdAt":"2026-08-01T01:00:00.000Z","updatedAt":"2026-08-01T01:00:04.000Z"}"#;

fn dashboard_voice() -> Value {
    json!({
        "jobId": "job_dashboard_voice",
        "type": "plan",
        "status": "queued",
        "command": "open Outlook",
        "inputTelemetry": {
            "storage": "dashboard",
            "source": "dashboard-web",
            "inputMode": "voice",
            "durationMs": 2400
        },
        "deviceEvents": [],
        "result": null,
        "error": null,
        "createdAt": "2026-08-02T01:00:00.000Z",
        "updatedAt": "2026-08-02T01:00:00.000Z"
    })
}

const GOLDEN_DASHBOARD_VOICE: &str = r#"{"pipelineId":"job_dashboard_voice","kind":"voice_command","command":"open Outlook","source":"cloudflare","origin":"dashboard","status":"processing","events":[{"eventId":"cloud-job_dashboard_voice-transcription","stage":"transcription","status":"done","label":"Transcript received from cloud","detail":"Speech-to-text completed before this job reached the Mac bridge.","text":"open Outlook","source":"cloudflare","meta":{"inputTelemetry":{"storage":"dashboard","source":"dashboard-web","inputMode":"voice","durationMs":2400}},"at":"2026-08-02T01:00:00.000Z"},{"eventId":"cloud-job_dashboard_voice-agent-active","stage":"agent","status":"waiting","label":"Waiting for Mac agent","detail":"The transcript is moving through the Mac bridge and agent.","text":"","source":"cloudflare","meta":null,"at":"2026-08-02T01:00:00.000Z"}],"createdAt":"2026-08-02T01:00:00.000Z","updatedAt":"2026-08-02T01:00:00.000Z"}"#;

fn dashboard_typed() -> Value {
    json!({
        "jobId": "job_dashboard_typed",
        "type": "plan",
        "status": "queued",
        "command": "open Outlook",
        "inputTelemetry": {
            "storage": "dashboard",
            "source": "dashboard-web",
            "inputMode": "typed"
        },
        "deviceEvents": [],
        "result": null,
        "error": null,
        "createdAt": "2026-08-02T01:00:00.000Z",
        "updatedAt": "2026-08-02T01:00:00.000Z"
    })
}

const GOLDEN_DASHBOARD_TYPED: &str = r#"{"pipelineId":"job_dashboard_typed","kind":"voice_command","command":"open Outlook","source":"cloudflare","origin":"dashboard","status":"processing","events":[{"eventId":"cloud-job_dashboard_typed-transcription","stage":"transcription","status":"done","label":"Typed in the dashboard","detail":"Command typed on a signed-in device, so there was no audio to transcribe.","text":"open Outlook","source":"dashboard","meta":{"inputTelemetry":{"storage":"dashboard","source":"dashboard-web","inputMode":"typed"}},"at":"2026-08-02T01:00:00.000Z"},{"eventId":"cloud-job_dashboard_typed-agent-active","stage":"agent","status":"waiting","label":"Waiting for Mac agent","detail":"The transcript is moving through the Mac bridge and agent.","text":"","source":"cloudflare","meta":null,"at":"2026-08-02T01:00:00.000Z"}],"createdAt":"2026-08-02T01:00:00.000Z","updatedAt":"2026-08-02T01:00:00.000Z"}"#;

fn transcribing() -> Value {
    json!({
        "jobId": "job_transcribing",
        "type": "plan",
        "status": "transcribing",
        "command": "",
        "inputTelemetry": { "audioBytes": 112044, "storage": "microSD", "format": "wav" },
        "deviceEvents": [],
        "result": null,
        "error": null,
        "createdAt": "2026-08-01T01:00:00.000Z",
        "updatedAt": "2026-08-01T01:00:00.000Z"
    })
}

const GOLDEN_TRANSCRIBING: &str = r#"{"pipelineId":"job_transcribing","kind":"voice_command","command":"","source":"cloudflare","origin":"microsd","status":"processing","events":[{"eventId":"cloud-job_transcribing-transcription","stage":"transcription","status":"active","label":"Recording received; transcription running","detail":"Cloudflare received the pendant recording and is transcribing it now.","text":"","source":"cloudflare","meta":{"inputTelemetry":{"audioBytes":112044,"storage":"microSD","format":"wav"}},"at":"2026-08-01T01:00:00.000Z"}],"createdAt":"2026-08-01T01:00:00.000Z","updatedAt":"2026-08-01T01:00:00.000Z"}"#;

fn failed_stt() -> Value {
    json!({
        "jobId": "job_failed",
        "type": "plan",
        "status": "failed",
        "command": "   ",
        "inputTelemetry": { "storage": "microSD" },
        "error": "Speech-to-text returned empty text.",
        "deviceEvents": [],
        "result": null,
        "createdAt": "2026-08-01T01:00:00.000Z",
        "updatedAt": "2026-08-01T01:00:01.000Z"
    })
}

const GOLDEN_FAILED_STT: &str = r#"{"pipelineId":"job_failed","kind":"voice_command","command":"   ","source":"cloudflare","origin":"microsd","status":"failed","events":[{"eventId":"cloud-job_failed-transcription","stage":"transcription","status":"failed","label":"Speech was not recognized","detail":"Speech-to-text returned empty text.","text":"   ","source":"cloudflare","meta":{"inputTelemetry":{"storage":"microSD"}},"at":"2026-08-01T01:00:00.000Z"}],"createdAt":"2026-08-01T01:00:00.000Z","updatedAt":"2026-08-01T01:00:01.000Z"}"#;

fn thinking_trace() -> Value {
    json!({
        "jobId": "job_think",
        "type": "plan",
        "status": "plan_ready",
        "command": "hi",
        "inputTelemetry": { "storage": "microSD" },
        "result": {
            "summary": "Did it",
            "thinking": { "traceId": "tr-1", "updatedAt": "2026-08-01T02:00:00.000Z" },
            "actions": [
                { "type": "a" },
                { "description": "Desc only", "params": { "x": 1, "y": "z" } },
                { "label": "  " }
            ]
        },
        "deviceEvents": [],
        "createdAt": "2026-08-01T01:00:00.000Z",
        "updatedAt": "2026-08-01T01:00:05.000Z"
    })
}

const GOLDEN_THINKING_TRACE: &str = r#"{"pipelineId":"job_think","kind":"voice_command","command":"hi","source":"cloudflare","origin":"microsd","status":"processing","events":[{"eventId":"cloud-job_think-transcription","stage":"transcription","status":"done","label":"Transcript received from cloud","detail":"Speech-to-text completed before this job reached the Mac bridge.","text":"hi","source":"cloudflare","meta":{"inputTelemetry":{"storage":"microSD"}},"at":"2026-08-01T01:00:00.000Z"},{"eventId":"cloud-job_think-agent","stage":"agent","status":"done","label":"Mac action selected","detail":"The Mac agent produced this action plan from the transcript.","text":"Did it","source":"mac-bridge","meta":{"planner":null,"thinkingTraceId":"tr-1","actions":[{"type":"a"},{"description":"Desc only","params":{"x":1,"y":"z"}},{"label":"  "}]},"at":"2026-08-01T02:00:00.000Z"},{"eventId":"cloud-job_think-relay","stage":"relay_result","status":"done","label":"Agent result stored in Cloudflare","detail":"The response is ready for the pendant to download.","source":"cloudflare","meta":null,"at":"2026-08-01T01:00:05.000Z"}],"createdAt":"2026-08-01T01:00:00.000Z","updatedAt":"2026-08-01T01:00:05.000Z"}"#;

/// The whole point of the port: byte-identical output for every fixture.
#[test]
fn voice_runs_are_byte_identical_to_the_javascript_implementation() {
    let cases: &[(&str, Value, &str)] = &[
        ("pendant_completed", pendant_completed(), GOLDEN_PENDANT_COMPLETED),
        ("dashboard_voice", dashboard_voice(), GOLDEN_DASHBOARD_VOICE),
        ("dashboard_typed", dashboard_typed(), GOLDEN_DASHBOARD_TYPED),
        ("transcribing", transcribing(), GOLDEN_TRANSCRIBING),
        ("failed_stt", failed_stt(), GOLDEN_FAILED_STT),
        ("thinking_trace", thinking_trace(), GOLDEN_THINKING_TRACE),
    ];

    for (name, job, golden) in cases {
        let run = voice_run_for_job(job).expect("run should exist");
        assert_eq!(&stringify(&run), golden, "voice run diverged for {name}");
    }
}

// --- Mirrors jobs.test.js test 20 -------------------------------------------

#[test]
fn converts_a_pendant_relay_job_into_a_dashboard_voice_run() {
    let run = voice_run_for_job(&pendant_completed()).unwrap();

    assert_eq!(run["pipelineId"], "job_test");
    assert_eq!(run["status"], "completed");

    let stages: Vec<&str> = run["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["stage"].as_str().unwrap())
        .collect();
    assert_eq!(
        stages,
        ["transcription", "agent", "tts", "relay_result", "device_playback"]
    );

    assert_eq!(run["events"][0]["meta"]["inputTelemetry"]["audioBytes"], 148800);
    assert_eq!(run["events"][1]["label"], "Mac action selected");
    assert_eq!(run["events"][1]["meta"]["actions"][0]["label"], "Open Outlook");
}

// --- Mirrors test 21 --------------------------------------------------------

#[test]
fn ignores_plan_jobs_the_owner_did_not_start_from_pendant_or_dashboard() {
    assert!(voice_run_for_job(
        &json!({ "jobId": "job_mobile", "type": "plan", "inputTelemetry": null })
    )
    .is_none());

    // A non-plan job never appears, even with a qualifying origin.
    assert!(voice_run_for_job(
        &json!({ "jobId": "x", "type": "execute", "inputTelemetry": { "storage": "microSD" } })
    )
    .is_none());

    // An unrecognised storage origin is filtered out.
    assert!(voice_run_for_job(
        &json!({ "jobId": "x", "type": "plan", "inputTelemetry": { "storage": "s3" } })
    )
    .is_none());
}

#[test]
fn origin_matching_is_case_insensitive() {
    // `String(telemetry.storage).toLowerCase()` — "microSD" must match.
    for storage in ["microSD", "MICROSD", "microsd", "Dashboard"] {
        let job = json!({
            "jobId": "j", "type": "plan", "status": "queued", "command": "hi",
            "inputTelemetry": { "storage": storage },
            "createdAt": "2026-08-01T01:00:00.000Z",
            "updatedAt": "2026-08-01T01:00:00.000Z"
        });
        assert!(voice_run_for_job(&job).is_some(), "storage {storage}");
    }
}

// --- Mirrors tests 22-24 ----------------------------------------------------

#[test]
fn shows_a_voice_command_recorded_in_a_signed_in_dashboard_browser() {
    let run = voice_run_for_job(&dashboard_voice()).unwrap();
    assert_eq!(run["pipelineId"], "job_dashboard_voice");
    assert_eq!(run["command"], "open Outlook");
    assert_eq!(run["events"][0]["stage"], "transcription");
    assert_eq!(run["events"][0]["status"], "done");
    assert_eq!(run["events"][0]["source"], "cloudflare");
    assert_eq!(
        run["events"][0]["meta"]["inputTelemetry"]["source"],
        "dashboard-web"
    );
}

#[test]
fn labels_a_typed_dashboard_command_instead_of_faking_a_transcription() {
    let run = voice_run_for_job(&dashboard_typed()).unwrap();
    assert_eq!(run["events"][0]["stage"], "transcription");
    assert_eq!(run["events"][0]["status"], "done");
    assert_eq!(run["events"][0]["source"], "dashboard");
    assert_eq!(run["events"][0]["label"], "Typed in the dashboard");
    assert!(run["events"][0]["detail"]
        .as_str()
        .unwrap()
        .contains("no audio to transcribe"));
}

#[test]
fn shows_a_recording_immediately_while_cloudflare_is_transcribing_it() {
    let run = voice_run_for_job(&transcribing()).unwrap();
    assert_eq!(run["status"], "processing");
    assert_eq!(run["command"], "");
    assert_eq!(run["events"].as_array().unwrap().len(), 1);
    assert_eq!(run["events"][0]["stage"], "transcription");
    assert_eq!(run["events"][0]["status"], "active");
    assert_eq!(
        run["events"][0]["label"],
        "Recording received; transcription running"
    );
}

#[test]
fn a_whitespace_only_command_counts_as_unrecognized_speech() {
    // `/[\p{L}\p{N}]/u` — punctuation and whitespace alone are not a transcript.
    let run = voice_run_for_job(&failed_stt()).unwrap();
    assert_eq!(run["events"][0]["status"], "failed");
    assert_eq!(run["status"], "failed");
    // The job error is surfaced as the detail when present.
    assert_eq!(
        run["events"][0]["detail"],
        "Speech-to-text returned empty text."
    );
}

#[test]
fn transcript_detection_accepts_letters_and_digits_in_any_script() {
    let run_with = |command: &str| {
        let job = json!({
            "jobId": "j", "type": "plan", "status": "plan_ready", "command": command,
            "inputTelemetry": { "storage": "microSD" },
            "createdAt": "t", "updatedAt": "t"
        });
        voice_run_for_job(&job).unwrap()["events"][0]["status"]
            .as_str()
            .unwrap()
            .to_string()
    };

    assert_eq!(run_with("hello"), "done");
    assert_eq!(run_with("7"), "done");
    assert_eq!(run_with("한국어"), "done");
    assert_eq!(run_with("..."), "failed");
    assert_eq!(run_with(""), "failed");
}

// --- Mirrors test 25: diagnostic audio stays out of public payloads ---------

#[test]
fn keeps_diagnostic_audio_out_of_public_job_payloads() {
    let capture = create_audio_capture(
        "job_cap".into(),
        Some("UklGRg==".into()),
        Value::Null,
        Value::Null,
        None,
        json!(4),
        json!("wav"),
        json!("en"),
        json!("."),
        json!("local-test"),
        "completed",
        "2026-08-02T00:00:00.000Z",
    );

    assert_eq!(capture["type"], "audio_capture");
    assert_eq!(capture["status"], "completed");
    assert_eq!(capture["audioBase64"], "UklGRg==");

    let public = public_job(&capture);
    assert!(public.get("audioBase64").is_none());
    assert!(public.get("audioRef").is_none());
    assert!(public.get("claimedBy").is_none());
    assert!(public.get("claimedAt").is_none());
}

#[test]
fn r2_backed_captures_omit_the_audio_base64_key_entirely() {
    // JSON.stringify drops `undefined`, so the stored row has NO audioBase64
    // key. Writing `null` instead would break loadAudioCapture's fallback.
    let capture = create_audio_capture(
        "job_cap".into(),
        None,
        json!({ "provider": "r2", "key": "audio-captures/2026/08/02/job_cap.wav" }),
        json!("r2"),
        None,
        json!(4),
        json!("wav"),
        Value::Null,
        Value::Null,
        Value::Null,
        "received",
        "2026-08-02T00:00:00.000Z",
    );

    assert!(capture.get("audioBase64").is_none());
    assert!(!stringify(&capture).contains("audioBase64"));
    assert!(capture.get("audioStorageWarning").is_none());
    assert_eq!(capture["audioStorage"], "r2");
}

#[test]
fn audio_capture_key_order_matches_the_javascript_record() {
    let capture = create_audio_capture(
        "job_cap".into(),
        Some("AAAA".into()),
        Value::Null,
        json!("d1-base64"),
        Some("warned".into()),
        json!(3),
        json!("wav"),
        Value::Null,
        Value::Null,
        Value::Null,
        "received",
        "t",
    );
    let keys: Vec<&str> = capture.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "jobId",
            "type",
            "status",
            "audioBase64",
            "audioRef",
            "audioStorage",
            "audioStorageWarning",
            "audioBytes",
            "format",
            "language",
            "transcript",
            "transcriptionModel",
            "createdAt",
            "updatedAt"
        ]
    );
}

// --- Job construction and lifecycle ----------------------------------------

#[test]
fn plan_jobs_start_queued_with_the_documented_shape() {
    let job = create_plan_job(
        "job_1".into(),
        json!("open mail"),
        Some("nrf9160-pendant"),
        Some("sess-1"),
        "queued",
        Some(json!({ "storage": "microSD" })),
        "2026-08-02T00:00:00.000Z",
    );

    let keys: Vec<&str> = job.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "jobId", "type", "status", "command", "sessionId", "inputTelemetry",
            "deviceEvents", "actions", "result", "error", "createdBy", "createdAt",
            "updatedAt", "claimedBy", "claimedAt"
        ]
    );
    assert_eq!(job["createdBy"], "nrf9160-pendant");
    assert_eq!(job["claimedBy"], Value::Null);
}

#[test]
fn plan_and_execute_jobs_default_created_by_to_mobile() {
    let plan = create_plan_job("j".into(), json!(""), None, None, "queued", None, "t");
    assert_eq!(plan["createdBy"], "mobile");

    let execute = create_execute_job("j".into(), json!(""), json!([]), None, None, None, "t");
    assert_eq!(execute["createdBy"], "mobile");
    assert_eq!(execute["type"], "execute");
    assert_eq!(execute["status"], "queued");
    // Execute jobs carry planJobId and have NO inputTelemetry key.
    assert!(execute.get("planJobId").is_some());
    assert!(execute.get("inputTelemetry").is_none());
}

#[test]
fn agent_proxy_jobs_default_created_by_to_ops_and_encode_the_command() {
    let job = create_agent_proxy_job(
        "j".into(),
        "POST",
        "/pipeline/events",
        json!({ "pipelineId": "job_1" }),
        None,
        "t",
    );
    assert_eq!(job["createdBy"], "ops");
    assert_eq!(job["command"], "POST /pipeline/events");
    assert_eq!(job["method"], "POST");
    assert_eq!(job["path"], "/pipeline/events");
    assert_eq!(job["status"], "queued");
}

#[test]
fn public_job_exposes_exactly_the_documented_key_set() {
    let job = create_plan_job(
        "job_1".into(),
        json!("cmd"),
        Some("mobile"),
        None,
        "queued",
        None,
        "t",
    );
    let public = public_job(&job);
    let keys: Vec<&str> = public.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "jobId", "type", "status", "command", "actions", "planJobId", "method",
            "path", "inputTelemetry", "deviceEvents", "result", "error", "createdAt",
            "updatedAt"
        ]
    );
}

#[test]
fn public_job_truncates_device_events_to_the_last_32() {
    let mut job = create_plan_job("j".into(), json!(""), None, None, "queued", None, "t");
    let events: Vec<Value> = (0..40).map(|i| json!({ "eventId": i })).collect();
    job["deviceEvents"] = Value::Array(events);

    let public = public_job(&job);
    let kept = public["deviceEvents"].as_array().unwrap();
    assert_eq!(kept.len(), 32);
    // slice(-32) keeps the NEWEST events.
    assert_eq!(kept[0]["eventId"], 8);
    assert_eq!(kept[31]["eventId"], 39);
}

#[test]
fn public_job_defaults_device_events_to_an_empty_array() {
    let job = json!({ "jobId": "j", "type": "plan", "status": "queued" });
    assert_eq!(public_job(&job)["deviceEvents"], json!([]));
}

// --- Pipeline event helpers -------------------------------------------------

#[test]
fn normalizes_pipeline_status_with_done_as_the_catch_all() {
    assert_eq!(normalize_pipeline_status(Some(&json!("active"))), "active");
    assert_eq!(normalize_pipeline_status(Some(&json!("PROCESSING"))), "active");
    assert_eq!(normalize_pipeline_status(Some(&json!(" failed "))), "failed");
    assert_eq!(normalize_pipeline_status(Some(&json!("error"))), "failed");
    assert_eq!(normalize_pipeline_status(Some(&json!("waiting"))), "waiting");
    assert_eq!(normalize_pipeline_status(Some(&json!("queued"))), "waiting");
    assert_eq!(normalize_pipeline_status(Some(&json!("done"))), "done");
    // Anything unrecognised — including missing — becomes `done`.
    assert_eq!(normalize_pipeline_status(None), "done");
    assert_eq!(normalize_pipeline_status(Some(&json!("banana"))), "done");
    assert_eq!(normalize_pipeline_status(Some(&Value::Null)), "done");
}

#[test]
fn telemetry_meta_drops_secrets_and_non_scalars() {
    let meta = sanitize_telemetry_meta(Some(&json!({
        "pcmBytes": 32000,
        "ok": true,
        "storage": "microSD",
        "audioBase64": "AAAA",
        "Authorization": "Bearer x",
        "apiKey": "k",
        "api_key": "k",
        "api-key": "k",
        "accessToken": "t",
        "SECRET": "s",
        "password": "p",
        "nested": { "a": 1 },
        "list": [1, 2],
        "nothing": null
    })));

    assert_eq!(meta["pcmBytes"], 32000);
    assert_eq!(meta["ok"], true);
    assert_eq!(meta["storage"], "microSD");

    for dropped in [
        "audioBase64",
        "Authorization",
        "apiKey",
        "api_key",
        "api-key",
        "accessToken",
        "SECRET",
        "password",
        "nested",
        "list",
        "nothing",
    ] {
        assert!(meta.get(dropped).is_none(), "{dropped} should be dropped");
    }
}

#[test]
fn telemetry_meta_truncates_keys_and_values_and_caps_entry_count() {
    let long_value = "x".repeat(300);
    let long_key = "k".repeat(100);
    let mut input = serde_json::Map::new();
    input.insert(long_key.clone(), json!(long_value));
    for i in 0..40 {
        input.insert(format!("n{i:02}"), json!(i));
    }

    let meta = sanitize_telemetry_meta(Some(&Value::Object(input)));
    let obj = meta.as_object().unwrap();
    // Only the first 32 entries are considered.
    assert!(obj.len() <= 32);

    let truncated_key = "k".repeat(80);
    assert_eq!(obj[&truncated_key].as_str().unwrap().len(), 240);
}

#[test]
fn non_object_telemetry_meta_becomes_an_empty_object() {
    assert_eq!(sanitize_telemetry_meta(None), json!({}));
    assert_eq!(sanitize_telemetry_meta(Some(&json!([1, 2]))), json!({}));
    assert_eq!(sanitize_telemetry_meta(Some(&json!("nope"))), json!({}));
    assert_eq!(sanitize_telemetry_meta(Some(&Value::Null)), json!({}));
}

// --- Device online window ---------------------------------------------------

#[test]
fn device_is_online_only_within_ninety_seconds() {
    let base = crate::util::time::parse_iso("2026-08-02T00:00:00.000Z").unwrap();
    let device = json!({ "deviceId": "d", "lastSeenAt": "2026-08-02T00:00:00.000Z" });

    assert!(is_device_online(Some(&device), base));
    assert!(is_device_online(Some(&device), base + 89_999));
    assert!(!is_device_online(Some(&device), base + 90_000));
    assert!(!is_device_online(None, base));
    assert!(!is_device_online(Some(&json!({ "deviceId": "d" })), base));
    // An unparseable timestamp is NaN in JS, which compares false.
    assert!(!is_device_online(
        Some(&json!({ "lastSeenAt": "nonsense" })),
        base
    ));
}

// --- Pendant speech fast path (load-bearing: TTS is a 503 stub) -------------

fn speech_job(speech: Value) -> Value {
    json!({ "jobId": "j", "result": { "pendantSpeech": speech } })
}

#[test]
fn accepts_only_24khz_mono_16bit_pcm() {
    let pcm = crate::util::b64::encode(&[0u8; 64]);
    let audio = pendant_speech_for_job(&speech_job(json!({
        "audioBase64": pcm,
        "format": "s16le",
        "sampleRate": 24000,
        "channels": 1,
        "bitsPerSample": 16
    })))
    .expect("pcm accepted");
    assert_eq!(audio.mime_type, "audio/pcm");
    assert_eq!(audio.format, "s16le");
    assert_eq!(audio.audio.len(), 64);
}

#[test]
fn rejects_speech_with_the_wrong_audio_parameters() {
    let pcm = crate::util::b64::encode(&[0u8; 64]);
    let variants = [
        json!({ "audioBase64": pcm, "format": "mp3", "sampleRate": 24000, "channels": 1, "bitsPerSample": 16 }),
        json!({ "audioBase64": pcm, "format": "s16le", "sampleRate": 16000, "channels": 1, "bitsPerSample": 16 }),
        json!({ "audioBase64": pcm, "format": "s16le", "sampleRate": 24000, "channels": 2, "bitsPerSample": 16 }),
        json!({ "audioBase64": pcm, "format": "s16le", "sampleRate": 24000, "channels": 1, "bitsPerSample": 8 }),
        json!({ "audioBase64": "", "format": "s16le", "sampleRate": 24000, "channels": 1, "bitsPerSample": 16 }),
    ];
    for speech in variants {
        assert!(
            pendant_speech_for_job(&speech_job(speech.clone())).is_none(),
            "unexpectedly accepted {speech}"
        );
    }
    assert!(pendant_speech_for_job(&json!({ "jobId": "j" })).is_none());
}

#[test]
fn rejects_pcm_with_an_odd_byte_length() {
    // 16-bit samples must come in whole frames.
    let odd = crate::util::b64::encode(&[0u8; 3]);
    assert!(pendant_speech_for_job(&speech_job(json!({
        "audioBase64": odd,
        "format": "s16le",
        "sampleRate": 24000,
        "channels": 1,
        "bitsPerSample": 16
    })))
    .is_none());
}

#[test]
fn prefers_ogg_opus_when_the_payload_really_is_ogg() {
    let mut ogg = b"OggS".to_vec();
    ogg.extend_from_slice(&[0u8; 60]);
    let audio = pendant_speech_for_job(&speech_job(json!({
        "audioBase64": crate::util::b64::encode(&[0u8; 64]),
        "format": "s16le",
        "sampleRate": 24000,
        "channels": 1,
        "bitsPerSample": 16,
        "compressedAudioBase64": crate::util::b64::encode(&ogg),
        "compressedFormat": "ogg-opus"
    })))
    .unwrap();

    assert_eq!(audio.mime_type, "audio/ogg");
    assert_eq!(audio.format, "ogg-opus");
    assert_eq!(audio.audio.len(), 64);
}

#[test]
fn falls_back_to_pcm_when_the_compressed_payload_is_not_ogg() {
    let not_ogg = crate::util::b64::encode(&[0x42u8; 64]);
    let audio = pendant_speech_for_job(&speech_job(json!({
        "audioBase64": crate::util::b64::encode(&[0u8; 64]),
        "format": "s16le",
        "sampleRate": 24000,
        "channels": 1,
        "bitsPerSample": 16,
        "compressedAudioBase64": not_ogg,
        "compressedFormat": "ogg-opus"
    })))
    .unwrap();
    assert_eq!(audio.format, "s16le");

    // Too short to be a real Ogg page, even with the right magic.
    let mut tiny = b"OggS".to_vec();
    tiny.extend_from_slice(&[0u8; 8]);
    let audio = pendant_speech_for_job(&speech_job(json!({
        "audioBase64": crate::util::b64::encode(&[0u8; 64]),
        "format": "s16le",
        "sampleRate": 24000,
        "channels": 1,
        "bitsPerSample": 16,
        "compressedAudioBase64": crate::util::b64::encode(&tiny),
        "compressedFormat": "ogg-opus"
    })))
    .unwrap();
    assert_eq!(audio.format, "s16le");
}

// --- Spoken text preference order ------------------------------------------

#[test]
fn spoken_text_prefers_response_then_summary_then_message_then_result() {
    let job = |result: Value| json!({ "status": "completed", "result": result });

    assert_eq!(
        spoken_text_for_job(&job(json!({
            "response": "R", "summary": "S", "message": "M", "result": "X"
        }))),
        "R"
    );
    assert_eq!(
        spoken_text_for_job(&job(json!({ "summary": "S", "message": "M" }))),
        "S"
    );
    assert_eq!(spoken_text_for_job(&job(json!({ "message": "M" }))), "M");
    assert_eq!(spoken_text_for_job(&job(json!({ "result": "X" }))), "X");
    // A non-string `result` is skipped.
    assert_eq!(spoken_text_for_job(&job(json!({ "result": { "a": 1 } }))), "Done.");
}

#[test]
fn spoken_text_collapses_whitespace_and_truncates_to_800_chars() {
    let job = json!({ "result": { "response": "  hello \n\t world  " } });
    assert_eq!(spoken_text_for_job(&job), "hello world");

    let long = json!({ "result": { "response": "a".repeat(900) } });
    assert_eq!(spoken_text_for_job(&long).len(), 800);
}

#[test]
fn spoken_text_falls_back_to_action_labels_with_confirmation_prefix() {
    let job = json!({
        "status": "plan_ready",
        "result": { "actions": [
            { "label": "Open Outlook" },
            { "type": "send_mail", "requiresConfirmation": true }
        ] }
    });
    assert_eq!(
        spoken_text_for_job(&job),
        "Ready for confirmation: Open Outlook, send_mail."
    );

    let no_confirm = json!({
        "status": "plan_ready",
        "result": { "actions": [{ "label": "Open Outlook" }] }
    });
    assert_eq!(spoken_text_for_job(&no_confirm), "Open Outlook.");
}

#[test]
fn spoken_text_uses_job_actions_when_the_result_has_none() {
    let job = json!({
        "status": "completed",
        "actions": [{ "label": "Do it" }],
        "result": {}
    });
    assert_eq!(spoken_text_for_job(&job), "Do it.");
}

#[test]
fn spoken_text_is_done_only_for_completed_jobs() {
    assert_eq!(spoken_text_for_job(&json!({ "status": "completed" })), "Done.");
    assert_eq!(spoken_text_for_job(&json!({ "status": "plan_ready" })), "");
    assert_eq!(spoken_text_for_job(&json!({})), "");
}
