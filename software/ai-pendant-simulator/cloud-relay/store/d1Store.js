import { JOB_TTL_MS } from '../config.js'

const AGENT_PROXY_MAX_AGE_MS = 10_000

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

async function pruneExpiredJobs(db) {
  const cutoff = new Date(Date.now() - JOB_TTL_MS).toISOString()
  await db.prepare('DELETE FROM relay_jobs WHERE updated_at < ?1').bind(cutoff).run()
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

    async listJobs({ type = null, limit = 40 } = {}) {
      const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100)
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
