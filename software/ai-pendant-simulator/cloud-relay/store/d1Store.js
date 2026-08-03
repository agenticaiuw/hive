import { JOB_TTL_MS } from '../config.js'
import {
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
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    updatedAt: row.updated_at,
  }
}

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

    async saveDeviceCredential(credential) {
      const updatedAt = credential.updatedAt || new Date().toISOString()
      await db
        .prepare(
          `INSERT INTO relay_device_credentials
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
             updated_at = excluded.updated_at`,
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
        )
        .run()
      return this.getDeviceCredential(credential.tokenId)
    },

    async getDeviceCredential(tokenId) {
      const row = await db
        .prepare(
          `SELECT token_id, token_hash, device_id, role, scopes, created_at,
                  last_used_at, expires_at, revoked_at, updated_at
           FROM relay_device_credentials
           WHERE token_id = ?1`,
        )
        .bind(tokenId)
        .first()
      return parseCredential(row)
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
        sessions,
        memory: { entities, relations },
      })
    },

    async createJob(job) {
      await pruneExpiredJobs(db)
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
      await pruneExpiredJobs(db)

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const row = await db
          .prepare(
            `SELECT job_id, data FROM relay_jobs
             WHERE status = 'queued'
             ORDER BY created_at ASC
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
  }
}
