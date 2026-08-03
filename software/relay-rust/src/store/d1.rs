//! Port of `cloud-relay/store/d1Store.js`.
//!
//! The schema is NOT changed by this port: every statement below is the same
//! SQL the JS relay issues against `ai-pendant-relay-db`, so the Rust worker
//! can run side by side against the live database.

use serde::Deserialize;
use serde_json::{Map, Value};
use wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement};

use super::{
    bridge_work as _bridge_work, claimed_job, expired_job, is_fail_candidate, merge_job_patch,
    prune_cutoff_iso, safe_list_limit, should_expire_agent_proxy, PRODUCT_BATCH_SIZE,
};
use crate::device_auth::CredentialRecord;
use crate::product_sync::{
    normalize_product_sync, record_version_key, SyncError, PRODUCT_SYNC_LIMITS,
    PRODUCT_SYNC_SCHEMA_VERSION,
};
use crate::store::memory::StateRecord;
use crate::util::js_string;
use crate::util::jsonjs::stringify;
use crate::util::time::{iso_from_ms, now_iso, now_ms};

pub type StoreResult<T> = std::result::Result<T, worker::Error>;

fn text(value: &str) -> JsValue {
    JsValue::from_str(value)
}

fn opt_text(value: Option<&str>) -> JsValue {
    match value {
        Some(v) if !v.is_empty() => JsValue::from_str(v),
        _ => JsValue::NULL,
    }
}

fn number(value: i64) -> JsValue {
    JsValue::from_f64(value as f64)
}

#[derive(Deserialize, Default)]
struct DataRow {
    #[serde(default)]
    data: Option<String>,
}

#[derive(Deserialize, Default)]
struct JobRow {
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    data: Option<String>,
}

#[derive(Deserialize, Default)]
struct TurnRow {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    data: Option<String>,
}

#[derive(Deserialize, Default)]
struct StateRow {
    #[serde(default)]
    revision: Option<f64>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    updated_by: Option<String>,
    #[serde(default)]
    data: Option<String>,
}

#[derive(Deserialize, Default)]
struct RevisionRow {
    #[serde(default)]
    revision: Option<f64>,
}

#[derive(Deserialize, Default)]
struct CredentialRow {
    #[serde(default)]
    token_id: Option<String>,
    #[serde(default)]
    token_hash: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    scopes: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    last_used_at: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    revoked_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

/// Port of `parseRecord`: unparseable JSON yields nothing.
fn parse_record(data: Option<String>) -> Option<Value> {
    serde_json::from_str(&data?).ok()
}

pub struct D1Store {
    db: D1Database,
    job_ttl_ms: i64,
}

impl D1Store {
    pub fn new(db: D1Database, job_ttl_ms: i64) -> Self {
        D1Store { db, job_ttl_ms }
    }

    pub fn kind(&self) -> &'static str {
        "d1"
    }

    // --- Devices -----------------------------------------------------------

    pub async fn save_device(&self, device: &Value) -> StoreResult<Value> {
        let mut record = match device {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        record.insert("updatedAt".into(), now_iso().into());
        let record = Value::Object(record);

        self.db
            .prepare(
                "INSERT INTO relay_devices (device_id, updated_at, data)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(device_id) DO UPDATE SET
                   updated_at = excluded.updated_at,
                   data = excluded.data",
            )
            .bind(&[
                text(&js_string(record.get("deviceId"))),
                text(&js_string(record.get("updatedAt"))),
                text(&stringify(&record)),
            ])?
            .run()
            .await?;

        Ok(record)
    }

    pub async fn get_device(&self, device_id: &str) -> StoreResult<Option<Value>> {
        let row: Option<DataRow> = self
            .db
            .prepare("SELECT data FROM relay_devices WHERE device_id = ?1")
            .bind(&[text(device_id)])?
            .first(None)
            .await?;
        Ok(row.and_then(|r| parse_record(r.data)))
    }

    pub async fn list_devices(&self) -> StoreResult<Vec<Value>> {
        let result = self
            .db
            .prepare("SELECT data FROM relay_devices ORDER BY updated_at DESC LIMIT 20")
            .all()
            .await?;
        let rows: Vec<DataRow> = result.results()?;
        Ok(rows.into_iter().filter_map(|r| parse_record(r.data)).collect())
    }

    /// The first `mac_bridge` device, used by every "is the bridge online?"
    /// check.
    pub async fn mac_bridge(&self) -> StoreResult<Option<Value>> {
        Ok(self
            .list_devices()
            .await?
            .into_iter()
            .find(|d| js_string(d.get("deviceType")) == "mac_bridge"))
    }

    // --- Credentials -------------------------------------------------------

    pub async fn save_device_credential(&self, credential: &CredentialRecord) -> StoreResult<()> {
        let scopes = serde_json::to_string(&credential.scopes).unwrap_or_else(|_| "[]".into());
        self.db
            .prepare(
                "INSERT INTO relay_device_credentials
                   (token_id, token_hash, device_id, role, scopes, created_at,
                    last_used_at, expires_at, revoked_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(token_id) DO UPDATE SET
                   token_hash = excluded.token_hash,
                   device_id = excluded.device_id,
                   role = excluded.role,
                   scopes = excluded.scopes,
                   last_used_at = excluded.last_used_at,
                   expires_at = excluded.expires_at,
                   revoked_at = excluded.revoked_at,
                   updated_at = excluded.updated_at",
            )
            .bind(&[
                text(&credential.token_id),
                text(&credential.token_hash),
                text(&credential.device_id),
                text(&credential.role),
                text(&scopes),
                text(&credential.created_at),
                opt_text(credential.last_used_at.as_deref()),
                opt_text(credential.expires_at.as_deref()),
                opt_text(credential.revoked_at.as_deref()),
                text(&credential.updated_at),
            ])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn get_device_credential(
        &self,
        token_id: &str,
    ) -> StoreResult<Option<CredentialRecord>> {
        let row: Option<CredentialRow> = self
            .db
            .prepare(
                "SELECT token_id, token_hash, device_id, role, scopes, created_at,
                        last_used_at, expires_at, revoked_at, updated_at
                 FROM relay_device_credentials
                 WHERE token_id = ?1",
            )
            .bind(&[text(token_id)])?
            .first(None)
            .await?;

        Ok(row.map(|row| {
            // A scopes column that fails to parse falls back to [].
            let scopes: Vec<String> = row
                .scopes
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .unwrap_or_default();

            CredentialRecord {
                token_id: row.token_id.unwrap_or_default(),
                token_hash: row.token_hash.unwrap_or_default(),
                device_id: row.device_id.unwrap_or_default(),
                role: row.role.unwrap_or_default(),
                scopes,
                created_at: row.created_at.unwrap_or_default(),
                last_used_at: row.last_used_at.filter(|v| !v.is_empty()),
                expires_at: row.expires_at.filter(|v| !v.is_empty()),
                revoked_at: row.revoked_at.filter(|v| !v.is_empty()),
                updated_at: row.updated_at.unwrap_or_default(),
            }
        }))
    }

    pub async fn touch_device_credential(
        &self,
        token_id: &str,
        last_used_at: &str,
    ) -> StoreResult<()> {
        self.db
            .prepare(
                "UPDATE relay_device_credentials
                 SET last_used_at = ?2, updated_at = ?2
                 WHERE token_id = ?1 AND revoked_at IS NULL",
            )
            .bind(&[text(token_id), text(last_used_at)])?
            .run()
            .await?;
        Ok(())
    }

    // --- Persistent state --------------------------------------------------

    pub async fn save_state(
        &self,
        state_key: &str,
        data: &Value,
        updated_by: &str,
    ) -> StoreResult<Option<StateRecord>> {
        self.db
            .prepare(
                "INSERT INTO relay_state
                   (state_key, revision, updated_at, updated_by, data)
                 VALUES (?1, 1, ?2, ?3, ?4)
                 ON CONFLICT(state_key) DO UPDATE SET
                   revision = relay_state.revision + 1,
                   updated_at = excluded.updated_at,
                   updated_by = excluded.updated_by,
                   data = excluded.data",
            )
            .bind(&[
                text(state_key),
                text(&now_iso()),
                text(updated_by),
                text(&stringify(data)),
            ])?
            .run()
            .await?;

        self.get_state(state_key).await
    }

    pub async fn get_state(&self, state_key: &str) -> StoreResult<Option<StateRecord>> {
        let row: Option<StateRow> = self
            .db
            .prepare(
                "SELECT revision, updated_at, updated_by, data
                 FROM relay_state
                 WHERE state_key = ?1",
            )
            .bind(&[text(state_key)])?
            .first(None)
            .await?;

        Ok(row.map(|row| StateRecord {
            state_key: state_key.to_string(),
            // `Number(row.revision || 1)`
            revision: row.revision.filter(|r| *r != 0.0).unwrap_or(1.0) as u64,
            updated_at: row.updated_at.unwrap_or_default(),
            updated_by: row.updated_by.unwrap_or_default(),
            data: parse_record(row.data).unwrap_or(Value::Null),
        }))
    }

    // --- Jobs --------------------------------------------------------------

    /// Delete jobs past the TTL. `audio_capture` rows are excluded so
    /// diagnostic recordings are retained indefinitely.
    async fn prune_expired_jobs(&self) -> StoreResult<()> {
        let cutoff = prune_cutoff_iso(now_ms(), self.job_ttl_ms);
        self.db
            .prepare(
                "DELETE FROM relay_jobs
                 WHERE updated_at < ?1 AND type <> 'audio_capture'",
            )
            .bind(&[text(&cutoff)])?
            .run()
            .await?;
        Ok(())
    }

    pub async fn create_job(&self, job: &Value) -> StoreResult<Value> {
        self.prune_expired_jobs().await?;
        self.db
            .prepare(
                "INSERT INTO relay_jobs
                   (job_id, status, type, created_at, updated_at, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .bind(&[
                text(&js_string(job.get("jobId"))),
                text(&js_string(job.get("status"))),
                text(&js_string(job.get("type"))),
                text(&js_string(job.get("createdAt"))),
                text(&js_string(job.get("updatedAt"))),
                // JS-identical stringification, so `undefined` fields (such as
                // an R2-backed capture's audioBase64) are omitted entirely.
                text(&stringify(job)),
            ])?
            .run()
            .await?;
        Ok(job.clone())
    }

    pub async fn get_job(&self, job_id: &str) -> StoreResult<Option<Value>> {
        let row: Option<DataRow> = self
            .db
            .prepare("SELECT data FROM relay_jobs WHERE job_id = ?1")
            .bind(&[text(job_id)])?
            .first(None)
            .await?;
        Ok(row.and_then(|r| parse_record(r.data)))
    }

    pub async fn list_jobs(
        &self,
        job_type: Option<&str>,
        limit: Option<&Value>,
    ) -> StoreResult<Vec<Value>> {
        let safe_limit = safe_list_limit(limit);
        let statement = match job_type {
            Some(job_type) => self
                .db
                .prepare(
                    "SELECT data FROM relay_jobs
                     WHERE type = ?1
                     ORDER BY created_at DESC
                     LIMIT ?2",
                )
                .bind(&[text(job_type), number(safe_limit)])?,
            None => self
                .db
                .prepare(
                    "SELECT data FROM relay_jobs
                     ORDER BY created_at DESC
                     LIMIT ?1",
                )
                .bind(&[number(safe_limit)])?,
        };

        let rows: Vec<DataRow> = statement.all().await?.results()?;
        Ok(rows.into_iter().filter_map(|r| parse_record(r.data)).collect())
    }

    /// Read-modify-write shallow merge. Returns nothing when the job is gone.
    pub async fn update_job(&self, job_id: &str, patch: &Value) -> StoreResult<Option<Value>> {
        let Some(current) = self.get_job(job_id).await? else {
            return Ok(None);
        };
        let next = merge_job_patch(&current, patch, &now_iso());

        self.db
            .prepare(
                "UPDATE relay_jobs
                 SET status = ?2, type = ?3, updated_at = ?4, data = ?5
                 WHERE job_id = ?1",
            )
            .bind(&[
                text(job_id),
                text(&js_string(next.get("status"))),
                text(&js_string(next.get("type"))),
                text(&js_string(next.get("updatedAt"))),
                text(&stringify(&next)),
            ])?
            .run()
            .await?;

        Ok(Some(next))
    }

    /// Claim the oldest queued job.
    ///
    /// The guarded `WHERE ... AND status = 'queued'` update plus the
    /// `changes == 1` check is the concurrency guard between multiple bridge
    /// pollers: a losing racer retries instead of double-claiming.
    pub async fn claim_next_job(&self, device_id: &str) -> StoreResult<Option<Value>> {
        self.prune_expired_jobs().await?;

        for _ in 0..40 {
            let row: Option<JobRow> = self
                .db
                .prepare(
                    "SELECT job_id, data FROM relay_jobs
                     WHERE status = 'queued'
                     ORDER BY created_at ASC
                     LIMIT 1",
                )
                .first(None)
                .await?;

            let Some(job) = row.and_then(|r| parse_record(r.data)) else {
                return Ok(None);
            };
            let job_id = js_string(job.get("jobId"));
            let now = now_iso();

            if should_expire_agent_proxy(&job, now_ms()) {
                let failed = expired_job(&job, &now);
                self.db
                    .prepare(
                        "UPDATE relay_jobs
                         SET status = 'failed', updated_at = ?2, data = ?3
                         WHERE job_id = ?1 AND status = 'queued'",
                    )
                    .bind(&[text(&job_id), text(&now), text(&stringify(&failed))])?
                    .run()
                    .await?;
                continue;
            }

            let claimed = claimed_job(&job, device_id, &now);
            let result = self
                .db
                .prepare(
                    "UPDATE relay_jobs
                     SET status = 'processing', updated_at = ?2, data = ?3
                     WHERE job_id = ?1 AND status = 'queued'",
                )
                .bind(&[text(&job_id), text(&now), text(&stringify(&claimed))])?
                .run()
                .await?;

            let changes = result.meta()?.and_then(|m| m.changes).unwrap_or(0);
            if changes == 1 {
                return Ok(Some(claimed));
            }
        }

        Ok(None)
    }

    pub async fn fail_queued_agent_proxy_jobs(
        &self,
        reason: &str,
        except_job_id: Option<&str>,
        older_than: Option<&str>,
    ) -> StoreResult<usize> {
        let rows: Vec<JobRow> = self
            .db
            .prepare(
                "SELECT job_id, data FROM relay_jobs
                 WHERE status = 'queued' AND type = 'agent_proxy'
                 ORDER BY created_at ASC
                 LIMIT 80",
            )
            .all()
            .await?
            .results()?;

        let now = now_iso();
        let mut statements: Vec<D1PreparedStatement> = Vec::new();
        let mut count = 0usize;

        for row in rows {
            let job_id = row.job_id.unwrap_or_default();
            let Some(job) = parse_record(row.data) else {
                continue;
            };
            if !is_fail_candidate(&job_id, &job, except_job_id, older_than) {
                continue;
            }

            let patch = serde_json::json!({ "status": "failed", "error": reason });
            let failed = merge_job_patch(&job, &patch, &now);
            statements.push(
                self.db
                    .prepare(
                        "UPDATE relay_jobs
                         SET status = 'failed', updated_at = ?2, data = ?3
                         WHERE job_id = ?1 AND status = 'queued'",
                    )
                    .bind(&[text(&job_id), text(&now), text(&stringify(&failed))])?,
            );
            count += 1;
        }

        if statements.is_empty() {
            return Ok(0);
        }

        self.db.batch(statements).await?;
        Ok(count)
    }

    // --- Product sync ------------------------------------------------------

    async fn run_batched(&self, statements: Vec<D1PreparedStatement>) -> StoreResult<()> {
        for chunk in statements.chunks(PRODUCT_BATCH_SIZE) {
            self.db.batch(chunk.to_vec()).await?;
        }
        Ok(())
    }

    pub async fn merge_product_state(
        &self,
        input: &Value,
    ) -> StoreResult<std::result::Result<Value, SyncError>> {
        let sync = match normalize_product_sync(input, &PRODUCT_SYNC_LIMITS) {
            Ok(sync) => sync,
            Err(error) => return Ok(Err(error)),
        };
        let account_id = js_string(sync.get("accountId"));
        let now = now_iso();

        self.db
            .prepare(
                "INSERT INTO product_accounts
                   (account_id, schema_version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?3)
                 ON CONFLICT(account_id) DO UPDATE SET
                   schema_version = excluded.schema_version,
                   updated_at = excluded.updated_at",
            )
            .bind(&[
                text(&account_id),
                text(PRODUCT_SYNC_SCHEMA_VERSION),
                text(&now),
            ])?
            .run()
            .await?;

        let mut statements: Vec<D1PreparedStatement> = Vec::new();
        let empty = vec![];
        let sessions = sync.get("sessions").and_then(|v| v.as_array()).unwrap_or(&empty);
        let mut turn_count = 0usize;

        for session in sessions {
            let mut session_data = match session {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            // Session rows exclude their turns; those live in product_turns.
            session_data.shift_remove("turns");
            let session_id = js_string(session.get("sessionId"));
            let version_key = match record_version_key(session) {
                Ok(key) => key,
                Err(error) => return Ok(Err(error)),
            };

            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO product_sessions
                           (account_id, session_id, schema_version, title, created_at,
                            updated_at, deleted_at, source_device_id, version_key, data)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                         ON CONFLICT(account_id, session_id) DO UPDATE SET
                           schema_version = excluded.schema_version,
                           title = excluded.title,
                           created_at = excluded.created_at,
                           updated_at = excluded.updated_at,
                           deleted_at = excluded.deleted_at,
                           source_device_id = excluded.source_device_id,
                           version_key = excluded.version_key,
                           data = excluded.data
                         WHERE excluded.version_key > product_sessions.version_key",
                    )
                    .bind(&[
                        text(&account_id),
                        text(&session_id),
                        text(PRODUCT_SYNC_SCHEMA_VERSION),
                        text(&js_string(session.get("title"))),
                        text(&js_string(session.get("createdAt"))),
                        text(&js_string(session.get("updatedAt"))),
                        opt_text(session.get("deletedAt").and_then(|v| v.as_str())),
                        text(&js_string(session.get("sourceDeviceId"))),
                        text(&version_key),
                        text(&stringify(&Value::Object(session_data))),
                    ])?,
            );

            let turns = session.get("turns").and_then(|v| v.as_array()).unwrap_or(&empty);
            for turn in turns {
                turn_count += 1;
                let turn_version_key = match record_version_key(turn) {
                    Ok(key) => key,
                    Err(error) => return Ok(Err(error)),
                };
                statements.push(
                    self.db
                        .prepare(
                            "INSERT INTO product_turns
                               (account_id, session_id, turn_id, schema_version, created_at,
                                updated_at, deleted_at, source_device_id, version_key, data)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                             ON CONFLICT(account_id, session_id, turn_id) DO UPDATE SET
                               schema_version = excluded.schema_version,
                               created_at = excluded.created_at,
                               updated_at = excluded.updated_at,
                               deleted_at = excluded.deleted_at,
                               source_device_id = excluded.source_device_id,
                               version_key = excluded.version_key,
                               data = excluded.data
                             WHERE excluded.version_key > product_turns.version_key",
                        )
                        .bind(&[
                            text(&account_id),
                            text(&session_id),
                            text(&js_string(turn.get("id"))),
                            text(PRODUCT_SYNC_SCHEMA_VERSION),
                            text(&js_string(turn.get("createdAt"))),
                            text(&js_string(turn.get("updatedAt"))),
                            opt_text(turn.get("deletedAt").and_then(|v| v.as_str())),
                            text(&js_string(turn.get("sourceDeviceId"))),
                            text(&turn_version_key),
                            text(&stringify(turn)),
                        ])?,
                );
            }
        }

        let entities = sync
            .get("memory")
            .and_then(|m| m.get("entities"))
            .and_then(|v| v.as_array())
            .unwrap_or(&empty);
        for entity in entities {
            let version_key = match record_version_key(entity) {
                Ok(key) => key,
                Err(error) => return Ok(Err(error)),
            };
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO product_memory_entities
                           (account_id, entity_id, schema_version, entity_type, name,
                            created_at, updated_at, deleted_at, source_device_id,
                            version_key, data)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                         ON CONFLICT(account_id, entity_id) DO UPDATE SET
                           schema_version = excluded.schema_version,
                           entity_type = excluded.entity_type,
                           name = excluded.name,
                           created_at = excluded.created_at,
                           updated_at = excluded.updated_at,
                           deleted_at = excluded.deleted_at,
                           source_device_id = excluded.source_device_id,
                           version_key = excluded.version_key,
                           data = excluded.data
                         WHERE excluded.version_key > product_memory_entities.version_key",
                    )
                    .bind(&[
                        text(&account_id),
                        text(&js_string(entity.get("id"))),
                        text(PRODUCT_SYNC_SCHEMA_VERSION),
                        text(&crate::util::slice_utf16(
                            &fallback(entity.get("type"), "Note"),
                            80,
                        )),
                        text(&crate::util::slice_utf16(
                            &fallback(entity.get("name"), "Untitled"),
                            240,
                        )),
                        text(&js_string(entity.get("createdAt"))),
                        text(&js_string(entity.get("updatedAt"))),
                        opt_text(entity.get("deletedAt").and_then(|v| v.as_str())),
                        text(&js_string(entity.get("sourceDeviceId"))),
                        text(&version_key),
                        text(&stringify(entity)),
                    ])?,
            );
        }

        let relations = sync
            .get("memory")
            .and_then(|m| m.get("relations"))
            .and_then(|v| v.as_array())
            .unwrap_or(&empty);
        for relation in relations {
            let version_key = match record_version_key(relation) {
                Ok(key) => key,
                Err(error) => return Ok(Err(error)),
            };
            statements.push(
                self.db
                    .prepare(
                        "INSERT INTO product_memory_relations
                           (account_id, relation_id, schema_version, from_entity_id,
                            to_entity_id, relation_type, created_at, updated_at,
                            deleted_at, source_device_id, version_key, data)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                         ON CONFLICT(account_id, relation_id) DO UPDATE SET
                           schema_version = excluded.schema_version,
                           from_entity_id = excluded.from_entity_id,
                           to_entity_id = excluded.to_entity_id,
                           relation_type = excluded.relation_type,
                           created_at = excluded.created_at,
                           updated_at = excluded.updated_at,
                           deleted_at = excluded.deleted_at,
                           source_device_id = excluded.source_device_id,
                           version_key = excluded.version_key,
                           data = excluded.data
                         WHERE excluded.version_key > product_memory_relations.version_key",
                    )
                    .bind(&[
                        text(&account_id),
                        text(&js_string(relation.get("id"))),
                        text(PRODUCT_SYNC_SCHEMA_VERSION),
                        text(&js_string(relation.get("from"))),
                        text(&js_string(relation.get("to"))),
                        text(&crate::util::slice_utf16(
                            &fallback(relation.get("type"), "related_to"),
                            80,
                        )),
                        text(&js_string(relation.get("createdAt"))),
                        text(&js_string(relation.get("updatedAt"))),
                        opt_text(relation.get("deletedAt").and_then(|v| v.as_str())),
                        text(&js_string(relation.get("sourceDeviceId"))),
                        text(&version_key),
                        text(&stringify(relation)),
                    ])?,
            );
        }

        self.run_batched(statements).await?;

        self.db
            .prepare(
                "INSERT INTO product_sync_events
                   (account_id, schema_version, changed_at, source_device_id,
                    session_count, turn_count, memory_entity_count,
                    memory_relation_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .bind(&[
                text(&account_id),
                text(PRODUCT_SYNC_SCHEMA_VERSION),
                text(&now),
                text(&js_string(sync.get("sourceDeviceId"))),
                number(sessions.len() as i64),
                number(turn_count as i64),
                number(entities.len() as i64),
                number(relations.len() as i64),
            ])?
            .run()
            .await?;

        self.get_product_state(&account_id).await
    }

    pub async fn get_product_state(
        &self,
        account_id: &str,
    ) -> StoreResult<std::result::Result<Value, SyncError>> {
        // The JS re-normalizes the account id through normalizeProductSync
        // before querying, which rejects malformed ids the same way.
        let probe = serde_json::json!({
            "accountId": account_id,
            "sourceDeviceId": "cloud-d1",
            "generatedAt": now_iso(),
            "sessions": [],
            "memory": {}
        });
        let safe_account_id = match normalize_product_sync(&probe, &PRODUCT_SYNC_LIMITS) {
            Ok(v) => js_string(v.get("accountId")),
            Err(error) => return Ok(Err(error)),
        };

        let session_rows: Vec<DataRow> = self
            .db
            .prepare(
                "SELECT data FROM product_sessions
                 WHERE account_id = ?1
                 ORDER BY updated_at DESC, session_id
                 LIMIT 1100",
            )
            .bind(&[text(&safe_account_id)])?
            .all()
            .await?
            .results()?;

        let turn_rows: Vec<TurnRow> = self
            .db
            .prepare(
                "SELECT session_id, data FROM product_turns
                 WHERE account_id = ?1
                 ORDER BY session_id, created_at, turn_id
                 LIMIT 50000",
            )
            .bind(&[text(&safe_account_id)])?
            .all()
            .await?
            .results()?;

        let entity_rows: Vec<DataRow> = self
            .db
            .prepare(
                "SELECT data FROM product_memory_entities
                 WHERE account_id = ?1
                 ORDER BY entity_id
                 LIMIT 5000",
            )
            .bind(&[text(&safe_account_id)])?
            .all()
            .await?
            .results()?;

        let relation_rows: Vec<DataRow> = self
            .db
            .prepare(
                "SELECT data FROM product_memory_relations
                 WHERE account_id = ?1
                 ORDER BY relation_id
                 LIMIT 10000",
            )
            .bind(&[text(&safe_account_id)])?
            .all()
            .await?
            .results()?;

        let revision_row: Option<RevisionRow> = self
            .db
            .prepare(
                "SELECT MAX(revision) AS revision
                 FROM product_sync_events
                 WHERE account_id = ?1",
            )
            .bind(&[text(&safe_account_id)])?
            .first(None)
            .await?;

        let mut turns_by_session: Map<String, Value> = Map::new();
        for row in turn_rows {
            let session_id = row.session_id.clone().unwrap_or_default();
            let Some(turn) = parse_record(row.data) else {
                continue;
            };
            match turns_by_session.get_mut(&session_id) {
                Some(Value::Array(list)) => list.push(turn),
                _ => {
                    turns_by_session.insert(session_id, Value::Array(vec![turn]));
                }
            }
        }

        let sessions: Vec<Value> = session_rows
            .into_iter()
            .filter_map(|row| parse_record(row.data))
            .map(|session| {
                let session_id = js_string(session.get("sessionId"));
                let mut map = match session {
                    Value::Object(map) => map,
                    _ => Map::new(),
                };
                map.insert(
                    "turns".into(),
                    turns_by_session
                        .get(&session_id)
                        .cloned()
                        .unwrap_or_else(|| Value::Array(vec![])),
                );
                Value::Object(map)
            })
            .collect();

        let entities: Vec<Value> = entity_rows
            .into_iter()
            .filter_map(|row| parse_record(row.data))
            .collect();
        let relations: Vec<Value> = relation_rows
            .into_iter()
            .filter_map(|row| parse_record(row.data))
            .collect();

        let rebuilt = serde_json::json!({
            "accountId": safe_account_id,
            "sourceDeviceId": "cloud-d1",
            "revision": revision_row.and_then(|r| r.revision).unwrap_or(0.0),
            "generatedAt": now_iso(),
            "sessions": sessions,
            "memory": { "entities": entities, "relations": relations }
        });

        Ok(normalize_product_sync(&rebuilt, &PRODUCT_SYNC_LIMITS))
    }
}

/// `String(value || fallback)`
fn fallback(value: Option<&Value>, default: &str) -> String {
    if crate::util::js_truthy(value) {
        js_string(value)
    } else {
        default.to_string()
    }
}

/// Re-exported so route modules have one import path for the work payload.
pub use _bridge_work as bridge_work;

/// Not used at runtime; kept so `iso_from_ms` stays reachable from this module
/// for future migrations that need explicit timestamps.
#[allow(dead_code)]
fn _iso(ms: i64) -> String {
    iso_from_ms(ms)
}
