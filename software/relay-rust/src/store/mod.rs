//! Storage semantics shared by the D1 store and the in-memory twin.
//!
//! The SQL itself lives in [`d1`]; everything that decides *what* to write —
//! the shallow job merge, the claim/expiry state machine, prune cutoffs,
//! limit clamping — is pure and tested here.

use serde_json::{Map, Value};

use crate::util::time::iso_from_ms;
use crate::util::{js_number, js_string};

#[cfg(target_arch = "wasm32")]
pub mod d1;

pub mod memory;

/// `JOB_TTL_MS` default: 24 hours.
pub const DEFAULT_JOB_TTL_MS: i64 = 86_400_000;
/// An `agent_proxy` job older than this is failed instead of claimed.
pub const AGENT_PROXY_MAX_AGE_MS: i64 = 10_000;
/// Statements per `db.batch` chunk when writing product state.
pub const PRODUCT_BATCH_SIZE: usize = 80;

pub const EXPIRED_PROXY_ERROR: &str = "Expired before the Mac bridge could run it.";

/// Port of `listJobs`'s `Math.min(Math.max(Number(limit) || 40, 1), 100)`.
pub fn safe_list_limit(limit: Option<&Value>) -> i64 {
    let n = js_number(limit);
    // `Number(limit) || 40` — NaN and 0 both fall back to 40.
    let n = if n.is_nan() || n == 0.0 { 40.0 } else { n };
    n.max(1.0).min(100.0) as i64
}

/// Cutoff for `pruneExpiredJobs`. Rows older than this are deleted, EXCEPT
/// `audio_capture`, which is retained forever by design.
pub fn prune_cutoff_iso(now_ms: i64, job_ttl_ms: i64) -> String {
    iso_from_ms(now_ms - job_ttl_ms)
}

/// Port of `updateJob`'s merge: `{ ...current, ...patch, updatedAt: now }`.
///
/// This is a SHALLOW merge over the whole JSON blob. Nested objects such as
/// `inputTelemetry` must be pre-merged by the caller — the routes do exactly
/// that — and unknown keys written by the Mac bridge must survive untouched.
pub fn merge_job_patch(current: &Value, patch: &Value, now: &str) -> Value {
    let mut next: Map<String, Value> = match current {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    if let Value::Object(patch) = patch {
        for (key, value) in patch {
            // IndexMap::insert keeps an existing key's position, matching JS
            // object-spread semantics.
            next.insert(key.clone(), value.clone());
        }
    }
    next.insert("updatedAt".into(), now.into());
    Value::Object(next)
}

/// Should this queued job be failed rather than claimed?
///
/// Stale `agent_proxy` jobs are dropped so a dashboard backlog cannot starve
/// the bridge.
pub fn should_expire_agent_proxy(job: &Value, now_ms: i64) -> bool {
    if js_string(job.get("type")) != "agent_proxy" {
        return false;
    }
    let created = crate::util::time::parse_iso(&js_string(job.get("createdAt"))).unwrap_or(0);
    now_ms - created > AGENT_PROXY_MAX_AGE_MS
}

/// The record written when a bridge claims a job.
pub fn claimed_job(job: &Value, device_id: &str, now: &str) -> Value {
    let patch = serde_json::json!({
        "status": "processing",
        "claimedBy": device_id,
        "claimedAt": now,
    });
    merge_job_patch(job, &patch, now)
}

/// The record written when a queued job is expired.
pub fn expired_job(job: &Value, now: &str) -> Value {
    let patch = serde_json::json!({ "status": "failed", "error": EXPIRED_PROXY_ERROR });
    merge_job_patch(job, &patch, now)
}

/// Port of `failQueuedAgentProxyJobs`'s candidate filter.
///
/// `older_than` is compared LEXICOGRAPHICALLY against `createdAt`, exactly as
/// the JS `String(job.createdAt || '') < String(olderThan)` does.
pub fn is_fail_candidate(
    job_id: &str,
    job: &Value,
    except_job_id: Option<&str>,
    older_than: Option<&str>,
) -> bool {
    if !job.is_object() {
        return false;
    }
    if let Some(except) = except_job_id {
        if !except.is_empty() && job_id == except {
            return false;
        }
    }
    if let Some(older_than) = older_than {
        if !older_than.is_empty() && js_string(job.get("createdAt")).as_str() >= older_than {
            return false;
        }
    }
    true
}

/// The `work` payload handed to the Mac bridge.
///
/// NOTE: this is NOT `publicJob` — it carries `body` and omits
/// result/error/timestamps.
pub fn bridge_work(job: &Value) -> Value {
    let or_null = |key: &str| job.get(key).cloned().unwrap_or(Value::Null);
    let mut map = Map::new();
    for key in ["jobId", "type", "command", "actions"] {
        if let Some(value) = job.get(key) {
            map.insert(key.to_string(), value.clone());
        }
    }
    map.insert("sessionId".into(), or_null("sessionId"));
    map.insert("inputTelemetry".into(), or_null("inputTelemetry"));
    map.insert("method".into(), or_null("method"));
    map.insert("path".into(), or_null("path"));
    map.insert("body".into(), or_null("body"));
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clamps_list_limits_between_1_and_100() {
        assert_eq!(safe_list_limit(None), 40);
        assert_eq!(safe_list_limit(Some(&json!(0))), 40);
        assert_eq!(safe_list_limit(Some(&json!("nonsense"))), 40);
        assert_eq!(safe_list_limit(Some(&json!(1))), 1);
        assert_eq!(safe_list_limit(Some(&json!(-5))), 1);
        assert_eq!(safe_list_limit(Some(&json!(80))), 80);
        assert_eq!(safe_list_limit(Some(&json!(500))), 100);
        assert_eq!(safe_list_limit(Some(&json!("12"))), 12);
    }

    #[test]
    fn prune_cutoff_is_now_minus_the_ttl() {
        let now = crate::util::time::parse_iso("2026-08-02T12:00:00.000Z").unwrap();
        assert_eq!(
            prune_cutoff_iso(now, DEFAULT_JOB_TTL_MS),
            "2026-08-01T12:00:00.000Z"
        );
    }

    // --- Shallow merge semantics -------------------------------------------

    #[test]
    fn job_patches_merge_shallowly_and_bump_updated_at() {
        let current = json!({
            "jobId": "job_1",
            "status": "queued",
            "inputTelemetry": { "storage": "microSD", "audioBytes": 100 },
            "result": Value::Null
        });
        let patch = json!({ "status": "processing" });

        let next = merge_job_patch(&current, &patch, "2026-08-02T00:00:01.000Z");
        assert_eq!(next["status"], "processing");
        assert_eq!(next["updatedAt"], "2026-08-02T00:00:01.000Z");
        // Untouched keys survive.
        assert_eq!(next["inputTelemetry"]["audioBytes"], 100);
    }

    #[test]
    fn a_nested_patch_replaces_rather_than_deep_merges() {
        // This is why the routes pre-merge inputTelemetry themselves.
        let current = json!({ "inputTelemetry": { "storage": "microSD", "audioBytes": 100 } });
        let patch = json!({ "inputTelemetry": { "audioBytes": 200 } });

        let next = merge_job_patch(&current, &patch, "t");
        assert_eq!(next["inputTelemetry"]["audioBytes"], 200);
        assert!(
            next["inputTelemetry"].get("storage").is_none(),
            "shallow merge must drop the old nested keys"
        );
    }

    #[test]
    fn unknown_bridge_written_fields_survive_a_round_trip() {
        // The Mac bridge writes result.pendantSpeech / result.thinking, which
        // the relay never declares. A typed struct would drop them here.
        let current = json!({
            "jobId": "job_1",
            "status": "processing",
            "result": {
                "pendantSpeech": { "audioBase64": "AAA", "format": "s16le" },
                "thinking": { "traceId": "tr-1" },
                "plannerSpecific": [1, 2, 3]
            }
        });
        let next = merge_job_patch(&current, &json!({ "status": "plan_ready" }), "t");
        assert_eq!(next["result"]["pendantSpeech"]["format"], "s16le");
        assert_eq!(next["result"]["thinking"]["traceId"], "tr-1");
        assert_eq!(next["result"]["plannerSpecific"], json!([1, 2, 3]));
    }

    #[test]
    fn merging_preserves_key_order_and_appends_new_keys() {
        let current = json!({ "a": 1, "b": 2 });
        let next = merge_job_patch(&current, &json!({ "a": 9, "c": 3 }), "t");
        let keys: Vec<&str> = next
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        assert_eq!(keys, ["a", "b", "c", "updatedAt"]);
        assert_eq!(next["a"], 9);
    }

    // --- Claim / expiry state machine --------------------------------------

    #[test]
    fn claiming_marks_a_job_processing_with_its_owner() {
        let job = json!({ "jobId": "job_1", "type": "plan", "status": "queued" });
        let claimed = claimed_job(&job, "mac-bridge-01", "2026-08-02T00:00:00.000Z");

        assert_eq!(claimed["status"], "processing");
        assert_eq!(claimed["claimedBy"], "mac-bridge-01");
        assert_eq!(claimed["claimedAt"], "2026-08-02T00:00:00.000Z");
        assert_eq!(claimed["updatedAt"], "2026-08-02T00:00:00.000Z");
    }

    #[test]
    fn stale_agent_proxy_jobs_expire_after_ten_seconds() {
        let base = crate::util::time::parse_iso("2026-08-02T00:00:00.000Z").unwrap();
        let job = json!({
            "jobId": "job_1",
            "type": "agent_proxy",
            "status": "queued",
            "createdAt": "2026-08-02T00:00:00.000Z"
        });

        assert!(!should_expire_agent_proxy(&job, base));
        assert!(!should_expire_agent_proxy(&job, base + 10_000));
        assert!(should_expire_agent_proxy(&job, base + 10_001));
    }

    #[test]
    fn only_agent_proxy_jobs_expire_on_claim() {
        let base = crate::util::time::parse_iso("2026-08-02T00:00:00.000Z").unwrap();
        for job_type in ["plan", "execute", "audio_capture"] {
            let job = json!({
                "type": job_type,
                "status": "queued",
                "createdAt": "2026-08-02T00:00:00.000Z"
            });
            assert!(
                !should_expire_agent_proxy(&job, base + 60_000),
                "{job_type} must not expire"
            );
        }
    }

    #[test]
    fn expiring_a_job_records_the_documented_error_string() {
        let job = json!({ "jobId": "job_1", "type": "agent_proxy", "status": "queued" });
        let expired = expired_job(&job, "2026-08-02T00:00:00.000Z");
        assert_eq!(expired["status"], "failed");
        assert_eq!(expired["error"], "Expired before the Mac bridge could run it.");
    }

    // --- Superseded snapshot filtering -------------------------------------

    #[test]
    fn fail_candidates_exclude_the_current_job_and_fresh_peers() {
        let job = |created: &str| json!({ "type": "agent_proxy", "createdAt": created });

        // The request that triggered the sweep is always spared.
        assert!(!is_fail_candidate(
            "job_self",
            &job("2026-08-02T00:00:00.000Z"),
            Some("job_self"),
            Some("2026-08-02T00:00:03.000Z")
        ));

        // Older backlog is swept.
        assert!(is_fail_candidate(
            "job_old",
            &job("2026-08-02T00:00:00.000Z"),
            Some("job_self"),
            Some("2026-08-02T00:00:03.000Z")
        ));

        // A peer created at the same instant as the cutoff is NOT swept
        // (the JS comparison is strictly `<`).
        assert!(!is_fail_candidate(
            "job_peer",
            &job("2026-08-02T00:00:03.000Z"),
            Some("job_self"),
            Some("2026-08-02T00:00:03.000Z")
        ));
        assert!(!is_fail_candidate(
            "job_new",
            &job("2026-08-02T00:00:05.000Z"),
            Some("job_self"),
            Some("2026-08-02T00:00:03.000Z")
        ));
    }

    #[test]
    fn fail_candidates_without_filters_include_everything() {
        let job = json!({ "type": "agent_proxy", "createdAt": "2026-08-02T00:00:00.000Z" });
        assert!(is_fail_candidate("job_1", &job, None, None));
        assert!(!is_fail_candidate("job_1", &json!("not-an-object"), None, None));
    }

    // --- Bridge work payload ------------------------------------------------

    #[test]
    fn bridge_work_carries_body_and_hides_results() {
        let job = json!({
            "jobId": "job_1",
            "type": "agent_proxy",
            "status": "processing",
            "command": "POST /ops/snapshot",
            "actions": [],
            "method": "POST",
            "path": "/ops/snapshot",
            "body": { "a": 1 },
            "result": { "secret": true },
            "error": Value::Null,
            "claimedBy": "mac-bridge-01",
            "createdAt": "t",
            "updatedAt": "t"
        });

        let work = bridge_work(&job);
        let keys: Vec<&str> = work
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        assert_eq!(
            keys,
            [
                "jobId",
                "type",
                "command",
                "actions",
                "sessionId",
                "inputTelemetry",
                "method",
                "path",
                "body"
            ]
        );
        assert_eq!(work["body"], json!({ "a": 1 }));
        assert_eq!(work["sessionId"], Value::Null);
        assert!(work.get("result").is_none());
        assert!(work.get("claimedBy").is_none());
    }
}
