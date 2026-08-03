//! In-memory twin of the D1 store.
//!
//! Mirrors `cloud-relay/store/memoryStore.js`. It exists so the job lifecycle,
//! retention rules and state-revision semantics can be exercised on the host
//! toolchain, where there is no D1 binding. The Worker always uses [`super::d1`].

use serde_json::{Map, Value};

use super::{
    claimed_job, expired_job, is_fail_candidate, merge_job_patch, prune_cutoff_iso,
    safe_list_limit, should_expire_agent_proxy, DEFAULT_JOB_TTL_MS,
};
use crate::device_auth::CredentialRecord;
use crate::util::js_string;
use crate::util::time::iso_from_ms;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateRecord {
    pub state_key: String,
    pub revision: u64,
    pub updated_at: String,
    pub updated_by: String,
    pub data: Value,
}

impl StateRecord {
    /// The `state` object returned by `GET`/`PUT /v1/state/:stateKey`.
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("stateKey".into(), self.state_key.clone().into());
        map.insert("revision".into(), self.revision.into());
        map.insert("updatedAt".into(), self.updated_at.clone().into());
        map.insert("updatedBy".into(), self.updated_by.clone().into());
        map.insert("data".into(), self.data.clone());
        Value::Object(map)
    }
}

#[derive(Debug, Default)]
pub struct MemoryStore {
    jobs: Vec<Value>,
    devices: Vec<Value>,
    credentials: Vec<CredentialRecord>,
    states: Vec<StateRecord>,
    job_ttl_ms: i64,
    /// Test clock, in epoch milliseconds.
    clock_ms: i64,
}

impl MemoryStore {
    pub fn new() -> Self {
        MemoryStore {
            job_ttl_ms: DEFAULT_JOB_TTL_MS,
            clock_ms: crate::util::time::now_ms(),
            ..Default::default()
        }
    }

    pub fn kind(&self) -> &'static str {
        "memory"
    }

    /// Pin the clock so lifecycle tests are deterministic.
    pub fn set_clock_ms(&mut self, now_ms: i64) {
        self.clock_ms = now_ms;
    }

    pub fn advance_ms(&mut self, delta: i64) {
        self.clock_ms += delta;
    }

    pub fn now_ms(&self) -> i64 {
        self.clock_ms
    }

    pub fn now_iso(&self) -> String {
        iso_from_ms(self.clock_ms)
    }

    // --- Jobs --------------------------------------------------------------

    /// Delete jobs older than the TTL, EXCEPT `audio_capture` rows.
    ///
    /// Diagnostic recordings are retained forever by design.
    fn prune_expired_jobs(&mut self) {
        let cutoff = prune_cutoff_iso(self.clock_ms, self.job_ttl_ms);
        self.jobs.retain(|job| {
            js_string(job.get("type")) == "audio_capture"
                || js_string(job.get("updatedAt")).as_str() >= cutoff.as_str()
        });
    }

    pub fn create_job(&mut self, job: Value) -> Value {
        self.prune_expired_jobs();
        self.jobs.push(job.clone());
        job
    }

    pub fn get_job(&self, job_id: &str) -> Option<Value> {
        self.jobs
            .iter()
            .find(|job| js_string(job.get("jobId")) == job_id)
            .cloned()
    }

    pub fn list_jobs(&self, job_type: Option<&str>, limit: Option<&Value>) -> Vec<Value> {
        let safe_limit = safe_list_limit(limit) as usize;
        let mut matching: Vec<Value> = self
            .jobs
            .iter()
            .filter(|job| match job_type {
                Some(t) => js_string(job.get("type")) == t,
                None => true,
            })
            .cloned()
            .collect();
        // ORDER BY created_at DESC (stable, so ties keep insertion order).
        matching.sort_by(|a, b| {
            js_string(b.get("createdAt")).cmp(&js_string(a.get("createdAt")))
        });
        matching.truncate(safe_limit);
        matching
    }

    pub fn update_job(&mut self, job_id: &str, patch: &Value) -> Option<Value> {
        let now = self.now_iso();
        let index = self
            .jobs
            .iter()
            .position(|job| js_string(job.get("jobId")) == job_id)?;
        let next = merge_job_patch(&self.jobs[index], patch, &now);
        self.jobs[index] = next.clone();
        Some(next)
    }

    /// Claim the oldest queued job, expiring stale `agent_proxy` work.
    pub fn claim_next_job(&mut self, device_id: &str) -> Option<Value> {
        self.prune_expired_jobs();

        for _ in 0..40 {
            let now = self.now_iso();
            let index = self
                .jobs
                .iter()
                .enumerate()
                .filter(|(_, job)| js_string(job.get("status")) == "queued")
                .min_by(|(ia, a), (ib, b)| {
                    js_string(a.get("createdAt"))
                        .cmp(&js_string(b.get("createdAt")))
                        .then(ia.cmp(ib))
                })
                .map(|(index, _)| index)?;

            if should_expire_agent_proxy(&self.jobs[index], self.clock_ms) {
                self.jobs[index] = expired_job(&self.jobs[index], &now);
                continue;
            }

            let claimed = claimed_job(&self.jobs[index], device_id, &now);
            self.jobs[index] = claimed.clone();
            return Some(claimed);
        }

        None
    }

    pub fn fail_queued_agent_proxy_jobs(
        &mut self,
        reason: &str,
        except_job_id: Option<&str>,
        older_than: Option<&str>,
    ) -> usize {
        let now = self.now_iso();
        let targets: Vec<usize> = self
            .jobs
            .iter()
            .enumerate()
            .filter(|(_, job)| {
                js_string(job.get("status")) == "queued"
                    && js_string(job.get("type")) == "agent_proxy"
            })
            .filter(|(_, job)| {
                is_fail_candidate(&js_string(job.get("jobId")), job, except_job_id, older_than)
            })
            .map(|(index, _)| index)
            .take(80)
            .collect();

        for index in &targets {
            let patch = serde_json::json!({ "status": "failed", "error": reason });
            self.jobs[*index] = merge_job_patch(&self.jobs[*index], &patch, &now);
        }

        targets.len()
    }

    // --- Devices -----------------------------------------------------------

    pub fn save_device(&mut self, device: &Value) -> Value {
        let mut record = match device {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        record.insert("updatedAt".into(), self.now_iso().into());
        let record = Value::Object(record);
        let device_id = js_string(record.get("deviceId"));

        match self
            .devices
            .iter()
            .position(|d| js_string(d.get("deviceId")) == device_id)
        {
            Some(index) => self.devices[index] = record.clone(),
            None => self.devices.push(record.clone()),
        }
        record
    }

    pub fn get_device(&self, device_id: &str) -> Option<Value> {
        self.devices
            .iter()
            .find(|d| js_string(d.get("deviceId")) == device_id)
            .cloned()
    }

    /// `ORDER BY updated_at DESC LIMIT 20`
    pub fn list_devices(&self) -> Vec<Value> {
        let mut devices = self.devices.clone();
        devices.sort_by(|a, b| js_string(b.get("updatedAt")).cmp(&js_string(a.get("updatedAt"))));
        devices.truncate(20);
        devices
    }

    // --- Credentials -------------------------------------------------------

    pub fn save_device_credential(&mut self, credential: CredentialRecord) -> CredentialRecord {
        match self
            .credentials
            .iter()
            .position(|c| c.token_id == credential.token_id)
        {
            Some(index) => self.credentials[index] = credential.clone(),
            None => self.credentials.push(credential.clone()),
        }
        credential
    }

    pub fn get_device_credential(&self, token_id: &str) -> Option<CredentialRecord> {
        self.credentials
            .iter()
            .find(|c| c.token_id == token_id)
            .cloned()
    }

    /// `WHERE token_id = ?1 AND revoked_at IS NULL`
    pub fn touch_device_credential(&mut self, token_id: &str, last_used_at: &str) {
        if let Some(record) = self
            .credentials
            .iter_mut()
            .find(|c| c.token_id == token_id && c.revoked_at.is_none())
        {
            record.last_used_at = Some(last_used_at.to_string());
            record.updated_at = last_used_at.to_string();
        }
    }

    pub fn revoke_device_credential(&mut self, token_id: &str, revoked_at: &str) {
        if let Some(record) = self.credentials.iter_mut().find(|c| c.token_id == token_id) {
            record.revoked_at = Some(revoked_at.to_string());
            record.updated_at = revoked_at.to_string();
        }
    }

    // --- Persistent state --------------------------------------------------

    /// Upsert that advances `revision` by one on every write.
    pub fn save_state(&mut self, state_key: &str, data: Value, updated_by: &str) -> StateRecord {
        let now = self.now_iso();
        match self.states.iter_mut().find(|s| s.state_key == state_key) {
            Some(record) => {
                record.revision += 1;
                record.updated_at = now;
                record.updated_by = updated_by.to_string();
                record.data = data;
                record.clone()
            }
            None => {
                let record = StateRecord {
                    state_key: state_key.to_string(),
                    revision: 1,
                    updated_at: now,
                    updated_by: updated_by.to_string(),
                    data,
                };
                self.states.push(record.clone());
                record
            }
        }
    }

    pub fn get_state(&self, state_key: &str) -> Option<StateRecord> {
        self.states
            .iter()
            .find(|s| s.state_key == state_key)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{create_agent_proxy_job, create_plan_job};
    use crate::util::time::parse_iso;
    use serde_json::json;

    fn store_at(iso: &str) -> MemoryStore {
        let mut store = MemoryStore::new();
        store.set_clock_ms(parse_iso(iso).unwrap());
        store
    }

    fn expired_job_record(job_id: &str, job_type: &str) -> Value {
        json!({
            "jobId": job_id,
            "type": job_type,
            "status": "completed",
            "createdAt": "2000-01-01T00:00:00.000Z",
            "updatedAt": "2000-01-01T00:00:00.000Z"
        })
    }

    // --- Mirrors audioRetention.test.js test 26 ---------------------------

    #[test]
    fn queue_cleanup_retains_durable_audio_capture_metadata() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        store.create_job(expired_job_record("job_old_audio", "audio_capture"));
        store.create_job(expired_job_record("job_old_plan", "plan"));

        // Creating another job triggers cleanup of rows older than JOB_TTL_MS.
        store.create_job(create_plan_job(
            "job_current".into(),
            json!(""),
            None,
            None,
            "queued",
            None,
            &store.now_iso(),
        ));

        assert!(store.get_job("job_old_audio").is_some());
        assert!(store.get_job("job_old_plan").is_none());
        assert!(store.get_job("job_current").is_some());
    }

    #[test]
    fn recent_jobs_survive_cleanup() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        // 23 hours old — inside the 24 hour TTL.
        store.create_job(json!({
            "jobId": "job_recent",
            "type": "plan",
            "status": "queued",
            "createdAt": "2026-08-01T01:00:00.000Z",
            "updatedAt": "2026-08-01T01:00:00.000Z"
        }));
        store.create_job(expired_job_record("job_ancient", "plan"));
        // Pruning runs BEFORE each insert, so a later write is what evicts the
        // ancient row.
        store.create_job(json!({
            "jobId": "job_trigger",
            "type": "plan",
            "status": "queued",
            "createdAt": "2026-08-02T00:00:00.000Z",
            "updatedAt": "2026-08-02T00:00:00.000Z"
        }));

        assert!(store.get_job("job_recent").is_some());
        assert!(store.get_job("job_ancient").is_none());
    }

    // --- Job lifecycle -----------------------------------------------------

    #[test]
    fn a_plan_job_walks_the_documented_state_machine() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        let job = create_plan_job(
            "job_1".into(),
            json!(""),
            Some("nrf9160-pendant"),
            None,
            "transcribing",
            Some(json!({ "storage": "microSD" })),
            &store.now_iso(),
        );
        store.create_job(job);

        // transcribing -> transcribed
        let job = store
            .update_job("job_1", &json!({ "status": "transcribed", "command": "hi" }))
            .unwrap();
        assert_eq!(job["status"], "transcribed");

        // transcribed -> queued
        store.update_job("job_1", &json!({ "status": "queued" })).unwrap();

        // queued -> processing, via the bridge claim
        let claimed = store.claim_next_job("mac-bridge-01").unwrap();
        assert_eq!(claimed["jobId"], "job_1");
        assert_eq!(claimed["status"], "processing");
        assert_eq!(claimed["claimedBy"], "mac-bridge-01");

        // processing -> plan_ready
        let done = store
            .update_job("job_1", &json!({ "status": "plan_ready", "result": { "response": "ok" } }))
            .unwrap();
        assert_eq!(done["status"], "plan_ready");
        // The telemetry set at creation survived every transition.
        assert_eq!(done["inputTelemetry"]["storage"], "microSD");
    }

    #[test]
    fn claiming_takes_the_oldest_queued_job_first() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        for (id, created) in [
            ("job_b", "2026-08-02T00:00:02.000Z"),
            ("job_a", "2026-08-02T00:00:01.000Z"),
            ("job_c", "2026-08-02T00:00:03.000Z"),
        ] {
            store.create_job(json!({
                "jobId": id, "type": "plan", "status": "queued",
                "createdAt": created, "updatedAt": created
            }));
        }

        assert_eq!(store.claim_next_job("bridge").unwrap()["jobId"], "job_a");
        assert_eq!(store.claim_next_job("bridge").unwrap()["jobId"], "job_b");
        assert_eq!(store.claim_next_job("bridge").unwrap()["jobId"], "job_c");
        assert!(store.claim_next_job("bridge").is_none());
    }

    #[test]
    fn a_claimed_job_cannot_be_claimed_twice() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        store.create_job(json!({
            "jobId": "job_1", "type": "plan", "status": "queued",
            "createdAt": "2026-08-02T00:00:00.000Z", "updatedAt": "2026-08-02T00:00:00.000Z"
        }));

        assert!(store.claim_next_job("bridge-a").is_some());
        assert!(store.claim_next_job("bridge-b").is_none());
        assert_eq!(store.get_job("job_1").unwrap()["claimedBy"], "bridge-a");
    }

    #[test]
    fn a_stale_agent_proxy_job_is_skipped_and_failed() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        store.create_job(create_agent_proxy_job(
            "job_stale".into(),
            "GET",
            "/ops/snapshot",
            Value::Null,
            None,
            "2026-08-02T00:00:00.000Z",
        ));
        store.create_job(json!({
            "jobId": "job_fresh", "type": "plan", "status": "queued",
            "createdAt": "2026-08-02T00:00:05.000Z", "updatedAt": "2026-08-02T00:00:05.000Z"
        }));

        // 11 seconds later the proxy job is past AGENT_PROXY_MAX_AGE_MS.
        store.advance_ms(11_000);

        let claimed = store.claim_next_job("bridge").unwrap();
        assert_eq!(claimed["jobId"], "job_fresh");

        let stale = store.get_job("job_stale").unwrap();
        assert_eq!(stale["status"], "failed");
        assert_eq!(stale["error"], "Expired before the Mac bridge could run it.");
    }

    #[test]
    fn a_fresh_agent_proxy_job_is_claimed_normally() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        store.create_job(create_agent_proxy_job(
            "job_proxy".into(),
            "GET",
            "/ops/snapshot",
            Value::Null,
            None,
            "2026-08-02T00:00:00.000Z",
        ));
        store.advance_ms(5_000);

        assert_eq!(store.claim_next_job("bridge").unwrap()["jobId"], "job_proxy");
    }

    #[test]
    fn superseding_a_snapshot_fails_only_stale_backlog() {
        let mut store = store_at("2026-08-02T00:00:10.000Z");
        for (id, created) in [
            ("job_old", "2026-08-02T00:00:00.000Z"),
            ("job_peer", "2026-08-02T00:00:07.000Z"),
            ("job_self", "2026-08-02T00:00:10.000Z"),
        ] {
            store.create_job(create_agent_proxy_job(
                id.into(),
                "GET",
                "/ops/snapshot",
                Value::Null,
                None,
                created,
            ));
        }

        let failed = store.fail_queued_agent_proxy_jobs(
            "Superseded by a newer dashboard snapshot request.",
            Some("job_self"),
            Some("2026-08-02T00:00:07.000Z"),
        );

        assert_eq!(failed, 1);
        assert_eq!(store.get_job("job_old").unwrap()["status"], "failed");
        assert_eq!(
            store.get_job("job_old").unwrap()["error"],
            "Superseded by a newer dashboard snapshot request."
        );
        assert_eq!(store.get_job("job_peer").unwrap()["status"], "queued");
        assert_eq!(store.get_job("job_self").unwrap()["status"], "queued");
    }

    #[test]
    fn listing_jobs_is_newest_first_and_filtered_by_type() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        store.create_job(json!({
            "jobId": "p1", "type": "plan", "status": "queued",
            "createdAt": "2026-08-02T00:00:01.000Z", "updatedAt": "2026-08-02T00:00:01.000Z"
        }));
        store.create_job(json!({
            "jobId": "c1", "type": "audio_capture", "status": "completed",
            "createdAt": "2026-08-02T00:00:02.000Z", "updatedAt": "2026-08-02T00:00:02.000Z"
        }));
        store.create_job(json!({
            "jobId": "p2", "type": "plan", "status": "queued",
            "createdAt": "2026-08-02T00:00:03.000Z", "updatedAt": "2026-08-02T00:00:03.000Z"
        }));

        let plans = store.list_jobs(Some("plan"), Some(&json!(80)));
        let ids: Vec<String> = plans.iter().map(|j| js_string(j.get("jobId"))).collect();
        assert_eq!(ids, ["p2", "p1"]);

        assert_eq!(store.list_jobs(Some("audio_capture"), None).len(), 1);
        assert_eq!(store.list_jobs(None, None).len(), 3);
        assert_eq!(store.list_jobs(None, Some(&json!(1))).len(), 1);
    }

    #[test]
    fn updating_a_missing_job_returns_nothing() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        assert!(store.update_job("nope", &json!({ "status": "failed" })).is_none());
    }

    // --- Mirrors stateStore.test.js tests 30-35 ---------------------------

    #[test]
    fn state_store_returns_nothing_for_an_unpublished_key() {
        let store = store_at("2026-08-02T00:00:00.000Z");
        assert!(store.get_state("missing").is_none());
    }

    #[test]
    fn state_store_overwrites_atomically_and_advances_revision() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");

        let first = store.save_state(
            "agent-snapshot",
            json!({ "sessions": [{ "sessionId": "session-1" }], "jobs": [] }),
            "home-mac",
        );
        let second = store.save_state(
            "agent-snapshot",
            json!({ "sessions": [{ "sessionId": "session-1" }], "jobs": [{ "jobId": "job-1" }] }),
            "home-mac",
        );
        let stored = store.get_state("agent-snapshot").unwrap();

        assert_eq!(first.revision, 1);
        assert_eq!(second.revision, 2);
        assert_eq!(stored.revision, 2);
        assert_eq!(stored.updated_by, "home-mac");
        assert_eq!(
            stored.data,
            json!({ "sessions": [{ "sessionId": "session-1" }], "jobs": [{ "jobId": "job-1" }] })
        );
        assert!(parse_iso(&stored.updated_at).is_some());
    }

    #[test]
    fn state_store_isolates_independently_named_documents() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        store.save_state("left", json!({ "value": "left" }), "admin");
        store.save_state("right", json!({ "value": "right" }), "admin");

        assert_eq!(store.get_state("left").unwrap().data, json!({ "value": "left" }));
        assert_eq!(
            store.get_state("right").unwrap().data,
            json!({ "value": "right" })
        );
        // Revisions are per-document.
        assert_eq!(store.get_state("left").unwrap().revision, 1);
    }

    #[test]
    fn state_json_has_the_documented_key_order() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        let record = store.save_state("agent-snapshot", json!({ "a": 1 }), "admin");
        let json = record.to_json();
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        assert_eq!(keys, ["stateKey", "revision", "updatedAt", "updatedBy", "data"]);
    }

    // --- Devices and credentials -------------------------------------------

    #[test]
    fn saving_a_device_upserts_and_stamps_updated_at() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        store.save_device(&json!({
            "deviceId": "mac-bridge-01",
            "deviceType": "mac_bridge",
            "name": "Home Mac",
            "registeredAt": "2026-08-01T00:00:00.000Z",
            "lastSeenAt": "2026-08-01T00:00:00.000Z"
        }));

        store.advance_ms(1000);
        store.save_device(&json!({
            "deviceId": "mac-bridge-01",
            "deviceType": "mac_bridge",
            "name": "Home Mac",
            "registeredAt": "2026-08-01T00:00:00.000Z",
            "lastSeenAt": "2026-08-02T00:00:01.000Z"
        }));

        assert_eq!(store.list_devices().len(), 1);
        let device = store.get_device("mac-bridge-01").unwrap();
        assert_eq!(device["updatedAt"], "2026-08-02T00:00:01.000Z");
        assert_eq!(device["lastSeenAt"], "2026-08-02T00:00:01.000Z");
    }

    #[test]
    fn touching_a_revoked_credential_is_a_no_op() {
        let mut store = store_at("2026-08-02T00:00:00.000Z");
        let issued = crate::device_auth::create_device_credential(
            "mac-bridge-01",
            "mac_bridge",
            "2026-08-02T00:00:00.000Z",
            &[1u8; 12],
            &[2u8; 32],
        )
        .unwrap();
        let token_id = issued.record.token_id.clone();
        store.save_device_credential(issued.record);

        store.touch_device_credential(&token_id, "2026-08-02T00:01:00.000Z");
        assert_eq!(
            store.get_device_credential(&token_id).unwrap().last_used_at,
            Some("2026-08-02T00:01:00.000Z".to_string())
        );

        store.revoke_device_credential(&token_id, "2026-08-02T00:02:00.000Z");
        store.touch_device_credential(&token_id, "2026-08-02T00:03:00.000Z");

        let record = store.get_device_credential(&token_id).unwrap();
        assert_eq!(
            record.last_used_at,
            Some("2026-08-02T00:01:00.000Z".to_string()),
            "a revoked credential must not be touched"
        );
        assert!(record.revoked_at.is_some());
    }
}
