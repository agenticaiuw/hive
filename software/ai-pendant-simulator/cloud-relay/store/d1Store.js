import crypto from 'node:crypto'

import { JOB_TTL_MS } from '../config.js'
import {
  MAX_LOG_BYTES,
  MEMORY_EVENT_TYPES,
} from '../../shared/fleetMemory.js'
import {
  limitSessionWindow,
  normalizeProductSync,
  PRODUCT_SYNC_SCHEMA_VERSION,
  recordVersionKey,
} from '../../shared/productSync.js'
import {
  likePatternForSearch,
  normalizeJobCursor,
  normalizeJobListLimit,
  normalizeJobSearch,
} from './jobQuery.js'

const AGENT_PROXY_MAX_AGE_MS = 10_000
const PRODUCT_BATCH_SIZE = 80
export const JOB_PRUNE_INTERVAL_MS = 5 * 60 * 1000

function parseRecord(row) {
  if (!row?.data) {
    return null
  }

  try {
    return JSON.parse(row.data)
  } catch {
    return null
  }
}

function parseCredential(row) {
  if (!row) {
    return null
  }

  let scopes = []
  try {
    scopes = JSON.parse(row.scopes || '[]')
  } catch {
    scopes = []
  }

  return {
    tokenId: row.token_id,
    tokenHash: row.token_hash,
    deviceId: row.device_id,
    role: row.role,
    scopes: Array.isArray(scopes) ? scopes : [],
    /* Only 1 means "this stored list is a ceiling". Anything else — 0, NULL on
     * a row written before the column existed, a missing column on a database
     * that predates credential-narrowing-migration.sql — means the credential
     * tracks live role policy, which is what every credential in the fleet
     * does. Un-narrowed is the safe reading to default to precisely because it
     * is the one that lets DEVICE_SCOPES withdraw a capability. */
    narrowed: row.narrowed === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    updatedAt: row.updated_at,
  }
}

/*
 * The order every fleet-memory read and eviction uses, as SQL.
 *
 * Built from MEMORY_EVENT_TYPES rather than typed out, because this ladder has
 * to be the same ladder compareMemoryEventsByValue() applies in JS. Two stores
 * that evict in different orders only diverge once a log is full, which is the
 * worst possible time to find out. fleetMemory.test.js runs both against the
 * same rows and asserts they keep the same set.
 *
 * Not newest-first: a preference is written once and is then permanently the
 * oldest row and permanently the most valuable one.
 */
const MEMORY_VALUE_ORDER = `CASE type ${MEMORY_EVENT_TYPES.map(
  (type, index) => `WHEN '${type}' THEN ${index}`,
).join(' ')} ELSE ${MEMORY_EVENT_TYPES.length} END ASC, at DESC, event_id DESC`

/* A running SUM() over that order: the byte budget, expressed as a query. */
const MEMORY_RUNNING_BYTES = `SUM(bytes) OVER (
         ORDER BY ${MEMORY_VALUE_ORDER}
         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
       )`

async function pruneExpiredJobs(db) {
  const cutoff = new Date(Date.now() - JOB_TTL_MS).toISOString()
  await db
    .prepare(
      `DELETE FROM relay_jobs
       WHERE updated_at < ?1 AND type <> 'audio_capture'`,
    )
    .bind(cutoff)
    .run()
}

async function runPreparedBatch(db, statements) {
  for (let index = 0; index < statements.length; index += PRODUCT_BATCH_SIZE) {
    const chunk = statements.slice(index, index + PRODUCT_BATCH_SIZE)
    if (typeof db.batch === 'function') {
      await db.batch(chunk)
    } else {
      for (const statement of chunk) {
        await statement.run()
      }
    }
  }
}

export function createD1Store(db) {
  let nextJobPruneAt = 0

  async function pruneJobsWhenDue() {
    const now = Date.now()
    if (now < nextJobPruneAt) return false

    // Advance before the await so concurrent creates share the same sweep.
    nextJobPruneAt = now + JOB_PRUNE_INTERVAL_MS
    await pruneExpiredJobs(db)
    return true
  }

  return {
    kind: 'd1',

    async saveDevice(device) {
      const record = {
        ...device,
        updatedAt: new Date().toISOString(),
      }
      await db
        .prepare(
          `INSERT INTO relay_devices (device_id, updated_at, data)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(device_id) DO UPDATE SET
             updated_at = excluded.updated_at,
             data = excluded.data`,
        )
        .bind(record.deviceId, record.updatedAt, JSON.stringify(record))
        .run()
      return record
    },

    async getDevice(deviceId) {
      const row = await db
        .prepare('SELECT data FROM relay_devices WHERE device_id = ?1')
        .bind(deviceId)
        .first()
      return parseRecord(row)
    },

    async listDevices() {
      const { results = [] } = await db
        .prepare(
          'SELECT data FROM relay_devices ORDER BY updated_at DESC LIMIT 20',
        )
        .all()
      return results.map(parseRecord).filter(Boolean)
    },

    /*
     * Retire a device row.
     *
     * There was no way to remove one, so every throwaway pairing probe any
     * agent ever ran is still in this table and still shows up in the fleet as
     * a node that exists. Devices are legitimately retired — a phone is
     * replaced, an extension is uninstalled — and a fleet view that cannot
     * forget is one that gets less true every month.
     *
     * Credentials go first and unconditionally. relay_device_credentials has a
     * FOREIGN KEY to this table, so deleting the device with rows still
     * pointing at it is the ordering that fails; more importantly, a device
     * row that vanished while a live token still authenticated as its
     * deviceId would leave a credential nothing owns. Undrained mesh mail goes
     * with it for the same reason: nothing will ever drain that inbox again.
     */
    async deleteDevice(deviceId) {
      await db
        .prepare('DELETE FROM relay_device_credentials WHERE device_id = ?1')
        .bind(deviceId)
        .run()
      await db
        .prepare('DELETE FROM relay_node_messages WHERE to_node = ?1')
        .bind(deviceId)
        .run()
      const result = await db
        .prepare('DELETE FROM relay_devices WHERE device_id = ?1')
        .bind(deviceId)
        .run()
      return Boolean(result?.meta?.changes)
    },

    async saveDeviceCredential(credential) {
      const updatedAt = credential.updatedAt || new Date().toISOString()
      await db
        .prepare(
          `INSERT INTO relay_device_credentials
             (token_id, token_hash, device_id, role, scopes, created_at,
              last_used_at, expires_at, revoked_at, updated_at, narrowed)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT(token_id) DO UPDATE SET
             token_hash = excluded.token_hash,
             device_id = excluded.device_id,
             role = excluded.role,
             scopes = excluded.scopes,
             last_used_at = excluded.last_used_at,
             expires_at = excluded.expires_at,
             revoked_at = excluded.revoked_at,
             updated_at = excluded.updated_at,
             narrowed = excluded.narrowed`,
        )
        .bind(
          credential.tokenId,
          credential.tokenHash,
          credential.deviceId,
          credential.role,
          JSON.stringify(credential.scopes || []),
          credential.createdAt,
          credential.lastUsedAt || null,
          credential.expiresAt || null,
          credential.revokedAt || null,
          updatedAt,
          credential.narrowed ? 1 : 0,
        )
        .run()
      return this.getDeviceCredential(credential.tokenId)
    },

    async getDeviceCredential(tokenId) {
      const row = await db
        .prepare(
          `SELECT token_id, token_hash, device_id, role, scopes, created_at,
                  last_used_at, expires_at, revoked_at, updated_at, narrowed
           FROM relay_device_credentials
           WHERE token_id = ?1`,
        )
        .bind(tokenId)
        .first()
      return parseCredential(row)
    },

    /* Newest first, revoked rows included: the operator listing credentials is
     * usually asking "what did I just kill" as often as "what is live". */
    async listDeviceCredentials({ deviceId = null, limit = 100 } = {}) {
      const statement = deviceId
        ? db
            .prepare(
              `SELECT token_id, token_hash, device_id, role, scopes, created_at,
                      last_used_at, expires_at, revoked_at, updated_at, narrowed
               FROM relay_device_credentials
               WHERE device_id = ?1
               ORDER BY created_at DESC LIMIT ?2`,
            )
            .bind(deviceId, limit)
        : db
            .prepare(
              `SELECT token_id, token_hash, device_id, role, scopes, created_at,
                      last_used_at, expires_at, revoked_at, updated_at, narrowed
               FROM relay_device_credentials
               ORDER BY created_at DESC LIMIT ?1`,
            )
            .bind(limit)
      const { results = [] } = await statement.all()
      return results.map(parseCredential).filter(Boolean)
    },

    async touchDeviceCredential(tokenId, lastUsedAt = new Date().toISOString()) {
      await db
        .prepare(
          `UPDATE relay_device_credentials
           SET last_used_at = ?2, updated_at = ?2
           WHERE token_id = ?1 AND revoked_at IS NULL`,
        )
        .bind(tokenId, lastUsedAt)
        .run()
      return this.getDeviceCredential(tokenId)
    },

    async revokeDeviceCredential(tokenId, revokedAt = new Date().toISOString()) {
      await db
        .prepare(
          `UPDATE relay_device_credentials
           SET revoked_at = ?2, updated_at = ?2
           WHERE token_id = ?1`,
        )
        .bind(tokenId, revokedAt)
        .run()
      return this.getDeviceCredential(tokenId)
    },

    async saveState(stateKey, data, { updatedBy = 'unknown' } = {}) {
      const now = new Date().toISOString()
      await db
        .prepare(
          `INSERT INTO relay_state
             (state_key, revision, updated_at, updated_by, data)
           VALUES (?1, 1, ?2, ?3, ?4)
           ON CONFLICT(state_key) DO UPDATE SET
             revision = relay_state.revision + 1,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by,
             data = excluded.data`,
        )
        .bind(stateKey, now, updatedBy, JSON.stringify(data))
        .run()

      return this.getState(stateKey)
    },

    async getState(stateKey) {
      const row = await db
        .prepare(
          `SELECT revision, updated_at, updated_by, data
           FROM relay_state
           WHERE state_key = ?1`,
        )
        .bind(stateKey)
        .first()

      if (!row) {
        return null
      }

      return {
        stateKey,
        revision: Number(row.revision || 1),
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        data: parseRecord(row),
      }
    },

    async mergeProductState(input) {
      const sync = normalizeProductSync(input)
      const now = new Date().toISOString()
      await db
        .prepare(
          `INSERT INTO product_accounts
             (account_id, schema_version, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?3)
           ON CONFLICT(account_id) DO UPDATE SET
             schema_version = excluded.schema_version,
             updated_at = excluded.updated_at`,
        )
        .bind(sync.accountId, PRODUCT_SYNC_SCHEMA_VERSION, now)
        .run()

      const statements = []
      for (const session of sync.sessions) {
        const sessionData = { ...session }
        delete sessionData.turns
        statements.push(
          db
            .prepare(
              `INSERT INTO product_sessions
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
               WHERE excluded.version_key > product_sessions.version_key`,
            )
            .bind(
              sync.accountId,
              session.sessionId,
              PRODUCT_SYNC_SCHEMA_VERSION,
              session.title,
              session.createdAt,
              session.updatedAt,
              session.deletedAt,
              session.sourceDeviceId,
              recordVersionKey(session),
              JSON.stringify(sessionData),
            ),
        )

        for (const turn of session.turns) {
          statements.push(
            db
              .prepare(
                `INSERT INTO product_turns
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
                 WHERE excluded.version_key > product_turns.version_key`,
              )
              .bind(
                sync.accountId,
                session.sessionId,
                turn.id,
                PRODUCT_SYNC_SCHEMA_VERSION,
                turn.createdAt,
                turn.updatedAt,
                turn.deletedAt,
                turn.sourceDeviceId,
                recordVersionKey(turn),
                JSON.stringify(turn),
              ),
          )
        }
      }

      for (const entity of sync.memory.entities) {
        statements.push(
          db
            .prepare(
              `INSERT INTO product_memory_entities
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
               WHERE excluded.version_key > product_memory_entities.version_key`,
            )
            .bind(
              sync.accountId,
              entity.id,
              PRODUCT_SYNC_SCHEMA_VERSION,
              String(entity.type || 'Note').slice(0, 80),
              String(entity.name || 'Untitled').slice(0, 240),
              entity.createdAt,
              entity.updatedAt,
              entity.deletedAt,
              entity.sourceDeviceId,
              recordVersionKey(entity),
              JSON.stringify(entity),
            ),
        )
      }

      for (const relation of sync.memory.relations) {
        statements.push(
          db
            .prepare(
              `INSERT INTO product_memory_relations
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
               WHERE excluded.version_key > product_memory_relations.version_key`,
            )
            .bind(
              sync.accountId,
              relation.id,
              PRODUCT_SYNC_SCHEMA_VERSION,
              String(relation.from || ''),
              String(relation.to || ''),
              String(relation.type || 'related_to').slice(0, 80),
              relation.createdAt,
              relation.updatedAt,
              relation.deletedAt,
              relation.sourceDeviceId,
              recordVersionKey(relation),
              JSON.stringify(relation),
            ),
        )
      }

      await runPreparedBatch(db, statements)
      const turnCount = sync.sessions.reduce(
        (count, session) => count + session.turns.length,
        0,
      )
      await db
        .prepare(
          `INSERT INTO product_sync_events
             (account_id, schema_version, changed_at, source_device_id,
              session_count, turn_count, memory_entity_count,
              memory_relation_count)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(
          sync.accountId,
          PRODUCT_SYNC_SCHEMA_VERSION,
          now,
          sync.sourceDeviceId,
          sync.sessions.length,
          turnCount,
          sync.memory.entities.length,
          sync.memory.relations.length,
        )
        .run()
      return this.getProductState(sync.accountId)
    },

    async getProductState(accountId) {
      const safeAccountId = normalizeProductSync({
        accountId,
        sourceDeviceId: 'cloud-d1',
        generatedAt: new Date().toISOString(),
        sessions: [],
        memory: {},
      }).accountId
      const [
        sessionResult,
        turnResult,
        entityResult,
        relationResult,
        revisionRow,
      ] = await Promise.all([
        db
          .prepare(
            `SELECT data FROM product_sessions
             WHERE account_id = ?1
             ORDER BY updated_at DESC, session_id
             LIMIT 1100`,
          )
          .bind(safeAccountId)
          .all(),
        db
          .prepare(
            `SELECT session_id, data FROM product_turns
             WHERE account_id = ?1
             ORDER BY session_id, created_at, turn_id
             LIMIT 50000`,
          )
          .bind(safeAccountId)
          .all(),
        db
          .prepare(
            `SELECT data FROM product_memory_entities
             WHERE account_id = ?1
             ORDER BY entity_id
             LIMIT 5000`,
          )
          .bind(safeAccountId)
          .all(),
        db
          .prepare(
            `SELECT data FROM product_memory_relations
             WHERE account_id = ?1
             ORDER BY relation_id
             LIMIT 10000`,
          )
          .bind(safeAccountId)
          .all(),
        db
          .prepare(
            `SELECT MAX(revision) AS revision
             FROM product_sync_events
             WHERE account_id = ?1`,
          )
          .bind(safeAccountId)
          .first(),
      ])

      const turnsBySession = new Map()
      for (const row of turnResult.results || []) {
        const turn = parseRecord(row)
        if (!turn) continue
        const turns = turnsBySession.get(row.session_id) || []
        turns.push(turn)
        turnsBySession.set(row.session_id, turns)
      }

      const sessions = (sessionResult.results || [])
        .map((row) => parseRecord(row))
        .filter(Boolean)
        .map((session) => ({
          ...session,
          turns: turnsBySession.get(session.sessionId) || [],
        }))
      const entities = (entityResult.results || []).map(parseRecord).filter(Boolean)
      const relations = (relationResult.results || [])
        .map(parseRecord)
        .filter(Boolean)

      return normalizeProductSync({
        accountId: safeAccountId,
        sourceDeviceId: 'cloud-d1',
        revision: Number(revisionRow?.revision || 0),
        generatedAt: new Date().toISOString(),
        // These rows are the union of every payload ever pushed, so they can
        // hold more active sessions than any one payload may carry: each device
        // sends its own newest maxSessions and the upsert never deletes. Served
        // unwindowed, normalizeProductSync() would reject the account's whole
        // state forever. Trimming is safe because the rows themselves survive.
        sessions: limitSessionWindow(sessions),
        memory: { entities, relations },
      })
    },

    async createJob(job) {
      await pruneJobsWhenDue()
      await db
        .prepare(
          `INSERT INTO relay_jobs
             (job_id, status, type, created_at, updated_at, data)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(
          job.jobId,
          job.status,
          job.type,
          job.createdAt,
          job.updatedAt,
          JSON.stringify(job),
        )
        .run()
      return job
    },

    async getJob(jobId) {
      const row = await db
        .prepare('SELECT data FROM relay_jobs WHERE job_id = ?1')
        .bind(jobId)
        .first()
      return parseRecord(row)
    },

    async listJobs({ type = null, limit = 40, before = null, search = null } = {}) {
      const safeLimit = normalizeJobListLimit(limit)
      const cursor = normalizeJobCursor(before)
      const needle = normalizeJobSearch(search)

      // Keep the legacy statements byte-identical when no cursor or search is
      // supplied: every existing caller keeps its exact query plan, and the
      // json_extract() path is only reached by the new history routes.
      if (!cursor && !needle) {
        const query = type
          ? db
              .prepare(
                `SELECT data FROM relay_jobs
               WHERE type = ?1
               ORDER BY created_at DESC
               LIMIT ?2`,
              )
              .bind(type, safeLimit)
          : db
              .prepare(
                `SELECT data FROM relay_jobs
               ORDER BY created_at DESC
               LIMIT ?1`,
              )
              .bind(safeLimit)
        const { results = [] } = await query.all()
        return results.map(parseRecord).filter(Boolean)
      }

      const conditions = []
      const bindings = []
      const next = () => `?${bindings.length + 1}`

      if (type) {
        conditions.push(`type = ${next()}`)
        bindings.push(type)
      }
      if (cursor) {
        const createdAtParam = next()
        bindings.push(cursor.createdAt)
        const cursorCreatedAtParam = next()
        bindings.push(cursor.createdAt)
        const jobIdParam = next()
        bindings.push(cursor.jobId)
        conditions.push(
          `(created_at < ${createdAtParam} OR (created_at = ${cursorCreatedAtParam} AND job_id < ${jobIdParam}))`,
        )
      }
      if (needle) {
        const pattern = likePatternForSearch(needle)
        const commandParam = next()
        bindings.push(pattern)
        const transcriptParam = next()
        bindings.push(pattern)
        const responseParam = next()
        bindings.push(pattern)
        conditions.push(
          `(lower(COALESCE(json_extract(data, '$.command'), '')) LIKE ${commandParam} ESCAPE '\\'
            OR lower(COALESCE(json_extract(data, '$.transcript'), '')) LIKE ${transcriptParam} ESCAPE '\\'
            OR lower(COALESCE(json_extract(data, '$.result.response'), '')) LIKE ${responseParam} ESCAPE '\\')`,
        )
      }

      const limitParam = next()
      bindings.push(safeLimit)
      const { results = [] } = await db
        .prepare(
          `SELECT data FROM relay_jobs
           WHERE ${conditions.join(' AND ')}
           ORDER BY created_at DESC, job_id DESC
           LIMIT ${limitParam}`,
        )
        .bind(...bindings)
        .all()
      return results.map(parseRecord).filter(Boolean)
    },

    async deleteJob(jobId) {
      const result = await db
        .prepare('DELETE FROM relay_jobs WHERE job_id = ?1')
        .bind(jobId)
        .run()
      return Number(result?.meta?.changes || 0) > 0
    },

    async updateJob(jobId, patch) {
      const row = await db
        .prepare('SELECT data FROM relay_jobs WHERE job_id = ?1')
        .bind(jobId)
        .first()
      const current = parseRecord(row)

      if (!current) {
        return null
      }

      const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      }
      await db
        .prepare(
          `UPDATE relay_jobs
           SET status = ?2, type = ?3, updated_at = ?4, data = ?5
           WHERE job_id = ?1`,
        )
        .bind(
          jobId,
          next.status,
          next.type,
          next.updatedAt,
          JSON.stringify(next),
        )
        .run()
      return next
    },

    async failQueuedAgentProxyJobs(
      reason = 'Superseded by a newer dashboard refresh.',
      { exceptJobId = null, olderThan = null } = {},
    ) {
      const { results = [] } = await db
        .prepare(
          `SELECT job_id, data FROM relay_jobs
           WHERE status = 'queued' AND type = 'agent_proxy'
           ORDER BY created_at ASC
           LIMIT 80`,
        )
        .all()
      const candidates = results
        .map((row) => ({
          jobId: row.job_id,
          job: parseRecord(row),
        }))
        .filter(
          ({ jobId, job }) =>
            job &&
            (!exceptJobId || jobId !== exceptJobId) &&
            (!olderThan || String(job.createdAt || '') < String(olderThan)),
        )

      if (!candidates.length) {
        return 0
      }

      const now = new Date().toISOString()
      await db.batch(
        candidates.map(({ jobId, job }) => {
          const failed = {
            ...job,
            status: 'failed',
            error: reason,
            updatedAt: now,
          }
          return db
            .prepare(
              `UPDATE relay_jobs
               SET status = 'failed', updated_at = ?2, data = ?3
               WHERE job_id = ?1 AND status = 'queued'`,
            )
            .bind(jobId, now, JSON.stringify(failed))
        }),
      )
      return candidates.length
    },

    async claimNextJob(deviceId) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        // Voice jobs preempt dashboard proxy work: a queued agent_proxy job
        // must never delay a pendant press behind its serial execution.
        const row = await db
          .prepare(
            `SELECT job_id, data FROM relay_jobs
             WHERE status = 'queued'
             ORDER BY CASE WHEN type = 'agent_proxy' THEN 1 ELSE 0 END ASC,
                      created_at ASC
             LIMIT 1`,
          )
          .first()
        const job = parseRecord(row)

        if (!job) {
          return null
        }

        const nowIso = new Date().toISOString()
        if (
          job.type === 'agent_proxy' &&
          Date.now() - new Date(job.createdAt || 0).getTime() >
            AGENT_PROXY_MAX_AGE_MS
        ) {
          const failed = {
            ...job,
            status: 'failed',
            error: 'Expired before the Mac bridge could run it.',
            updatedAt: nowIso,
          }
          await db
            .prepare(
              `UPDATE relay_jobs
               SET status = 'failed', updated_at = ?2, data = ?3
               WHERE job_id = ?1 AND status = 'queued'`,
            )
            .bind(job.jobId, nowIso, JSON.stringify(failed))
            .run()
          continue
        }

        const claimed = {
          ...job,
          status: 'processing',
          claimedBy: deviceId,
          claimedAt: nowIso,
          updatedAt: nowIso,
        }
        const result = await db
          .prepare(
            `UPDATE relay_jobs
             SET status = 'processing', updated_at = ?2, data = ?3
             WHERE job_id = ?1 AND status = 'queued'`,
          )
          .bind(job.jobId, nowIso, JSON.stringify(claimed))
          .run()

        if (Number(result.meta?.changes || 0) === 1) {
          return claimed
        }
      }

      return null
    },

    /* ---- scheduled routines (cloud-relay/routines.js) ------------------ *
     * Deliberately NOT relay_jobs rows. That table is a 24 h work queue
     * swept by JOB_TTL_MS and drained by claimNextJob(), so a routine parked
     * there would be handed to the Mac bridge as work and then deleted a day
     * later. A routine is durable configuration, not a job.
     * ------------------------------------------------------------------- */

    async saveRoutine(routine) {
      const record = { ...routine, updatedAt: new Date().toISOString() }
      await db
        .prepare(
          `INSERT INTO relay_routines
             (routine_id, enabled, next_run_at, lease_owner, lease_until,
              created_at, updated_at, data)
           VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6)
           ON CONFLICT(routine_id) DO UPDATE SET
             enabled = excluded.enabled,
             next_run_at = excluded.next_run_at,
             lease_owner = NULL,
             lease_until = NULL,
             updated_at = excluded.updated_at,
             data = excluded.data`,
        )
        .bind(
          record.routineId,
          record.enabled ? 1 : 0,
          Number.isFinite(record.nextRunAt) ? record.nextRunAt : null,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record),
        )
        .run()
      return record
    },

    async getRoutine(routineId) {
      const row = await db
        .prepare('SELECT data FROM relay_routines WHERE routine_id = ?1')
        .bind(routineId)
        .first()
      return parseRecord(row)
    },

    async listRoutines({ limit = 50 } = {}) {
      const { results = [] } = await db
        .prepare(
          `SELECT data FROM relay_routines
           ORDER BY created_at DESC LIMIT ?1`,
        )
        .bind(Math.min(Math.max(Number(limit) || 50, 1), 200))
        .all()
      return results.map(parseRecord).filter(Boolean)
    },

    async deleteRoutine(routineId) {
      const result = await db
        .prepare('DELETE FROM relay_routines WHERE routine_id = ?1')
        .bind(routineId)
        .run()
      return Number(result.meta?.changes || 0) > 0
    },

    /*
     * Lease-then-read, not read-then-lease: the UPDATE is the claim, and it
     * stamps a token unique to this tick. Two overlapping ticks (a cron and
     * a manual POST /v1/routines/tick, say) cannot both take the same
     * routine, because the second UPDATE's WHERE clause no longer matches.
     */
    async claimDueRoutines({ now = Date.now(), limit = 8, leaseMs = 300_000 } = {}) {
      const leaseOwner = `tick_${crypto.randomUUID()}`
      const leaseUntil = now + leaseMs
      await db
        .prepare(
          `UPDATE relay_routines
              SET lease_owner = ?1, lease_until = ?2
            WHERE routine_id IN (
              SELECT routine_id FROM relay_routines
               WHERE enabled = 1
                 AND next_run_at IS NOT NULL
                 AND next_run_at <= ?3
                 AND (lease_until IS NULL OR lease_until <= ?3)
               ORDER BY next_run_at ASC
               LIMIT ?4
            )`,
        )
        .bind(
          leaseOwner,
          leaseUntil,
          now,
          Math.min(Math.max(Number(limit) || 8, 1), 25),
        )
        .run()

      const { results = [] } = await db
        .prepare(
          `SELECT data FROM relay_routines
            WHERE lease_owner = ?1 ORDER BY next_run_at ASC`,
        )
        .bind(leaseOwner)
        .all()
      return results.map(parseRecord).filter(Boolean)
    },

    async recordRoutineRun(run) {
      await db
        .prepare(
          `INSERT INTO relay_routine_runs
             (run_id, routine_id, status, started_at, data)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(run_id) DO UPDATE SET
             status = excluded.status,
             data = excluded.data`,
        )
        .bind(
          run.runId,
          run.routineId,
          run.status,
          run.startedAt,
          JSON.stringify(run),
        )
        .run()
      return run
    },

    async listRoutineRuns({ routineId = null, status = null, limit = 25 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100)
      const clauses = []
      const bindings = []
      if (routineId) {
        bindings.push(routineId)
        clauses.push(`routine_id = ?${bindings.length}`)
      }
      if (status) {
        bindings.push(status)
        clauses.push(`status = ?${bindings.length}`)
      }
      bindings.push(safeLimit)
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const { results = [] } = await db
        .prepare(
          `SELECT data FROM relay_routine_runs ${where}
            ORDER BY started_at DESC LIMIT ?${bindings.length}`,
        )
        .bind(...bindings)
        .all()
      return results.map(parseRecord).filter(Boolean)
    },

    /* ---- outbound announcements (cloud-relay/announce.js) -------------- */

    async createAnnouncement(announcement) {
      await db
        .prepare(
          `INSERT INTO relay_announcements
             (announcement_id, device_id, state, created_at, expires_at, data)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(
          announcement.announcementId,
          announcement.deviceId,
          announcement.state,
          announcement.createdAt,
          announcement.expiresAt,
          JSON.stringify(announcement),
        )
        .run()
      return announcement
    },

    async listAnnouncements({ deviceId = null, state = null, limit = 20 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100)
      const clauses = []
      const bindings = []
      if (deviceId) {
        bindings.push(deviceId)
        clauses.push(`device_id = ?${bindings.length}`)
      }
      if (state) {
        bindings.push(state)
        clauses.push(`state = ?${bindings.length}`)
      }
      bindings.push(safeLimit)
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const { results = [] } = await db
        .prepare(
          `SELECT data FROM relay_announcements ${where}
            ORDER BY created_at ASC LIMIT ?${bindings.length}`,
        )
        .bind(...bindings)
        .all()
      return results.map(parseRecord).filter(Boolean)
    },

    /*
     * ---- announcement retention ------------------------------------------
     *
     * An announcement carries speech, and a routine composed on the relay puts
     * up to 1500 characters of scraped page text into it (cloud-relay/
     * routines.js composeOnRelay). Every reader of this table already refuses
     * an expired row — announcementIsLive() is checked in selectDeliverable
     * before anything is spoken — so until these two statements existed, an
     * announcement's text was unreachable AND permanent: the worst of both.
     * A filter on the read path is not deletion.
     * ---------------------------------------------------------------------- */

    /** Rows past `expires_at`. NULL expiry is never selected: unknown means keep. */
    async listExpiredAnnouncements({ before, limit = 200 }) {
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500)
      const { results = [] } = await db
        .prepare(
          `SELECT data FROM relay_announcements
            WHERE expires_at IS NOT NULL AND expires_at <= ?1
            ORDER BY expires_at ASC LIMIT ?2`,
        )
        .bind(before, safeLimit)
        .all()
      return results.map(parseRecord).filter(Boolean)
    },

    /** What the table holds, split at the same cutoff, in rows and in bytes. */
    async announcementStats({ before }) {
      const row = await db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             COALESCE(SUM(LENGTH(data)), 0) AS total_bytes,
             SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ?1 THEN 1 ELSE 0 END) AS expired,
             COALESCE(SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ?1 THEN LENGTH(data) ELSE 0 END), 0) AS expired_bytes,
             SUM(CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END) AS undated
           FROM relay_announcements`,
        )
        .bind(before)
        .first()
      return {
        total: Number(row?.total || 0),
        totalBytes: Number(row?.total_bytes || 0),
        expired: Number(row?.expired || 0),
        expiredBytes: Number(row?.expired_bytes || 0),
        undated: Number(row?.undated || 0),
      }
    },

    async deleteAnnouncement(announcementId) {
      const result = await db
        .prepare('DELETE FROM relay_announcements WHERE announcement_id = ?1')
        .bind(announcementId)
        .run()
      return Boolean(result?.meta?.changes)
    },

    async updateAnnouncement(announcementId, patch) {
      const current = parseRecord(
        await db
          .prepare(
            'SELECT data FROM relay_announcements WHERE announcement_id = ?1',
          )
          .bind(announcementId)
          .first(),
      )
      if (!current) return null
      const next = { ...current, ...patch }
      await db
        .prepare(
          `UPDATE relay_announcements
              SET state = ?2, data = ?3
            WHERE announcement_id = ?1`,
        )
        .bind(announcementId, next.state, JSON.stringify(next))
        .run()
      return next
    },

    /* ---- migrated contexts ----------------------------------------------
     * Same contract as memoryStore. Kept out of relay_state on purpose: that
     * table is a bounded last-known telemetry cache with no expiry, and a
     * context is the owner's actual words with a deadline on them.
     * -------------------------------------------------------------------- */

    async saveContext(record) {
      await pruneExpiredContexts(db)
      await db
        .prepare(
          `INSERT INTO relay_contexts
             (handle_id, secret_hash, origin, created_at, expires_at, bytes, data)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(handle_id) DO UPDATE SET
             secret_hash = excluded.secret_hash,
             origin = excluded.origin,
             expires_at = excluded.expires_at,
             bytes = excluded.bytes,
             data = excluded.data`,
        )
        .bind(
          record.handleId,
          record.secretHash,
          record.origin,
          record.createdAt,
          record.expiresAt,
          Number(record.bytes || 0),
          JSON.stringify(record),
        )
        .run()
      return record
    },

    async getContext(handleId) {
      // Filtered here as well as swept, so an unswept expired row can never be
      // resumed just because the sweep has not come round yet.
      const row = await db
        .prepare(
          `SELECT data FROM relay_contexts
            WHERE handle_id = ?1 AND expires_at > ?2`,
        )
        .bind(handleId, new Date().toISOString())
        .first()
      return parseRecord(row)
    },

    async deleteContext(handleId) {
      const result = await db
        .prepare('DELETE FROM relay_contexts WHERE handle_id = ?1')
        .bind(handleId)
        .run()
      return Boolean(result?.meta?.changes)
    },

    /* ---- node mesh mailbox ----------------------------------------------
     * Same contract as memoryStore. See cloudflare-worker/schema.sql for why
     * this is neither relay_jobs (claimed by whoever asks first, has a result)
     * nor relay_announcements (spoken, carries rendered speech).
     * -------------------------------------------------------------------- */

    async enqueueNodeMessage(envelope) {
      await db
        .prepare(
          `INSERT INTO relay_node_messages
             (message_id, to_node, from_node, created_at, expires_at,
              leased_until, lease_token, attempts, data)
           VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 0, ?6)
           ON CONFLICT(message_id) DO NOTHING`,
        )
        .bind(
          envelope.id,
          envelope.to,
          envelope.from,
          envelope.createdAt,
          envelope.expiresAt,
          JSON.stringify(envelope),
        )
        .run()
      return envelope
    },

    /** Unacked, unexpired rows for one addressee. Ignores leases: this is the
     * "how much is waiting" question presence asks, not a delivery. */
    async countPendingNodeMessages(toNode, { now = Date.now() } = {}) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS pending FROM relay_node_messages
            WHERE to_node = ?1 AND expires_at > ?2`,
        )
        .bind(toNode, new Date(now).toISOString())
        .first()
      return Number(row?.pending || 0)
    },

    /**
     * Lease the next page of mail for one addressee.
     *
     * Two statements, not one with RETURNING: the UPDATE is atomic on its own,
     * so stamping a unique lease_token and then SELECTing by it makes the claim
     * race-free without depending on a RETURNING clause. Two drains racing the
     * same inbox split the page between them; neither sees the other's rows.
     */
    async leaseNodeMessages(
      toNode,
      { limit = 50, leaseMs = 60_000, leaseToken, now = Date.now() } = {},
    ) {
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200)
      const nowIso = new Date(now).toISOString()
      const leaseUntil = new Date(now + Math.max(1_000, leaseMs)).toISOString()
      const token = String(leaseToken || `${now}-${Math.random()}`)

      await db
        .prepare(
          `UPDATE relay_node_messages
              SET leased_until = ?3, lease_token = ?4, attempts = attempts + 1
            WHERE message_id IN (
              SELECT message_id FROM relay_node_messages
               WHERE to_node = ?1
                 AND expires_at > ?2
                 AND (leased_until IS NULL OR leased_until <= ?2)
               ORDER BY created_at ASC
               LIMIT ?5)`,
        )
        .bind(toNode, nowIso, leaseUntil, token, safeLimit)
        .run()

      const { results = [] } = await db
        .prepare(
          `SELECT data FROM relay_node_messages
            WHERE lease_token = ?1 ORDER BY created_at ASC`,
        )
        .bind(token)
        .all()
      return results.map(parseRecord).filter(Boolean)
    },

    /** Acknowledge = delete. Scoped by to_node so a node holding a guessed
     * message id still cannot reach into another node's inbox. */
    async ackNodeMessages(toNode, messageIds = []) {
      const ids = [...new Set(messageIds.map(String))].filter(Boolean)
      if (!ids.length) return 0
      const placeholders = ids.map((_id, index) => `?${index + 2}`).join(', ')
      const result = await db
        .prepare(
          `DELETE FROM relay_node_messages
            WHERE to_node = ?1 AND message_id IN (${placeholders})`,
        )
        .bind(toNode, ...ids)
        .run()
      return Number(result?.meta?.changes || 0)
    },

    async pruneExpiredNodeMessages({ now = Date.now() } = {}) {
      const result = await db
        .prepare('DELETE FROM relay_node_messages WHERE expires_at <= ?1')
        .bind(new Date(now).toISOString())
        .run()
      return Number(result?.meta?.changes || 0)
    },

    /* ---- cross-surface memory -------------------------------------------
     * Same contract as memoryStore. Kept out of relay_state because that table
     * is one row per key overwritten in place — which is exactly what the
     * bodies cannot do, since they are never awake at the same time. An append
     * needs no read of the current value; that is the whole reason this is a
     * log. See shared/fleetMemory.js.
     * -------------------------------------------------------------------- */

    /* `now` threaded for the same reason as in memoryStore: the post-append
     * prune ran on the wall clock while events carried the caller's, so an
     * event stamped more than one TTL behind real time was deleted by the call
     * that wrote it, and the append still reported success. */
    async appendMemoryEvents(events, { now = Date.now() } = {}) {
      const list = Array.isArray(events) ? events : []
      if (!list.length) return { removed: 0, kept: 0, reasons: {} }

      const statements = list.map((event) =>
        db
          .prepare(
            `INSERT INTO relay_memory_events
               (event_id, type, fact_key, node, surfaces, at, expires_at, bytes, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(event_id) DO NOTHING`,
          )
          .bind(
            event.eventId,
            event.type,
            event.key,
            event.node,
            JSON.stringify(event.surfaces || []),
            event.at,
            event.expiresAt ?? null,
            Number(event.bytes || 0),
            JSON.stringify(event),
          ),
      )

      await runPreparedBatch(db, statements)
      return pruneMemoryEventLog(db, { now })
    },

    async listMemoryEvents({ now = Date.now(), maxBytes = MAX_LOG_BYTES } = {}) {
      /*
       * Expiry is filtered here as well as swept, so an unswept row can never
       * reach a prompt just because no append has happened lately.
       *
       * Supersession is NOT filtered here, deliberately: the reader folds the
       * log anyway (a fold is how "current value" is defined), and a
       * superseded row that survives between sweeps costs bytes, not
       * correctness. Surfaces are not filtered here either — the log is capped
       * at MAX_LOG_BYTES, so scoping it in SQL would buy a second, drifting
       * copy of the surface rule for no measurable read.
       */
      const { results = [] } = await db
        .prepare(
          `SELECT data FROM (
             SELECT event_id, type, at, data,
                    ${MEMORY_RUNNING_BYTES} AS running
               FROM relay_memory_events
              WHERE expires_at IS NULL OR expires_at > ?1
           )
            WHERE running <= ?2
            ORDER BY ${MEMORY_VALUE_ORDER}`,
        )
        .bind(new Date(now).toISOString(), Math.max(0, Number(maxBytes) || 0))
        .all()

      return results.map(parseRecord).filter(Boolean)
    },

    async pruneMemoryEvents(options = {}) {
      return pruneMemoryEventLog(db, options)
    },
  }
}

async function pruneExpiredContexts(db) {
  await db
    .prepare('DELETE FROM relay_contexts WHERE expires_at <= ?1')
    .bind(new Date().toISOString())
    .run()
}

/**
 * Compact the memory log: superseded writes, then expirations, then the tail
 * that does not fit the byte ceiling.
 *
 * The order of the first two is load-bearing and is the reverse of what reads
 * naturally. A retraction inherits its type's TTL, so it can expire while the
 * value it cancelled is still live. Delete expired rows first and that
 * retraction disappears before it has suppressed anything, and the retracted
 * fact comes back — silently, and confidently wrong. Supersession first means
 * the tombstone has already deleted its target by the time it expires itself.
 * foldMemoryEvents() gets the same guarantee by folding before it filters.
 */
async function pruneMemoryEventLog(
  db,
  { now = Date.now(), maxBytes = MAX_LOG_BYTES } = {},
) {
  const superseded = await db
    .prepare(
      `DELETE FROM relay_memory_events
        WHERE EXISTS (
          SELECT 1 FROM relay_memory_events AS newer
           WHERE newer.type = relay_memory_events.type
             AND newer.fact_key = relay_memory_events.fact_key
             AND (newer.at > relay_memory_events.at
                  OR (newer.at = relay_memory_events.at
                      AND newer.event_id > relay_memory_events.event_id)))`,
    )
    .run()

  const expired = await db
    .prepare(
      `DELETE FROM relay_memory_events
        WHERE expires_at IS NOT NULL AND expires_at <= ?1`,
    )
    .bind(new Date(now).toISOString())
    .run()

  // A running sum can only cut a prefix of the value order, which is why the
  // JS pruner stops at the first row that does not fit instead of packing.
  const overflow = await db
    .prepare(
      `DELETE FROM relay_memory_events WHERE event_id IN (
         SELECT event_id FROM (
           SELECT event_id, ${MEMORY_RUNNING_BYTES} AS running
             FROM relay_memory_events
         )
          WHERE running > ?1
       )`,
    )
    .bind(Math.max(0, Number(maxBytes) || 0))
    .run()

  const reasons = {
    superseded: Number(superseded?.meta?.changes || 0),
    expired: Number(expired?.meta?.changes || 0),
    overflow: Number(overflow?.meta?.changes || 0),
  }

  return {
    removed: reasons.superseded + reasons.expired + reasons.overflow,
    reasons,
  }
}
