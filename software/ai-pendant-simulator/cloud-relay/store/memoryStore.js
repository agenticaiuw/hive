import { JOB_TTL_MS } from '../config.js'
import {
  mergeProductSync as mergeProductSyncDocuments,
  normalizeProductSync,
} from '../../shared/productSync.js'
import {
  compareJobsNewestFirst,
  jobIsBeforeCursor,
  jobMatchesSearch,
  normalizeJobCursor,
  normalizeJobListLimit,
} from './jobQuery.js'

const AGENT_PROXY_MAX_AGE_MS = 10_000

/**
 * A store, with its own state.
 *
 * The maps used to sit at module scope, which made `createMemoryStore()` a
 * misleading name: it handed out a new façade over one shared set of maps. In
 * production that was invisible — store/index.js memoizes one store per
 * isolate — but it is a real hazard in two places, and both are the kind that
 * only bite once something has already gone wrong:
 *
 *   - Any future relay that holds more than one store at once (a second
 *     account, a replay harness, a per-tenant isolate) would serve one
 *     owner's facts to another. The fleet state's domainMemory block is the
 *     worst row for that to happen to, because it is the one designed to be
 *     handed to a model.
 *   - Tests. Two `createMemoryStore()` calls in one process shared state, so
 *     a test could pass on rows another test wrote.
 *
 * Nothing else changes: every method below closes over these maps instead of
 * the module's, and none of them use `this`, so a detached method
 * (`{ getState: store.getState }`) still works.
 */
export function createMemoryStore() {
  const jobs = new Map()
  const devices = new Map()
  const deviceCredentials = new Map()
  const states = new Map()
  const productStates = new Map()
  const routines = new Map()
  const routineRuns = new Map()
  const routineLeases = new Map()
  const announcements = new Map()
  const contexts = new Map()
  /* message_id → { envelope, leasedUntil, leaseToken, attempts } */
  const nodeMessages = new Map()

  function pruneExpiredJobs() {
    const cutoff = Date.now() - JOB_TTL_MS

    for (const [jobId, job] of jobs.entries()) {
      if (
        job.type !== 'audio_capture' &&
        new Date(job.updatedAt).getTime() < cutoff
      ) {
        jobs.delete(jobId)
      }
    }
  }

  /*
   * Expiry is enforced on read as well as by this sweep. The sweep keeps the
   * map from growing; the read-side check is what makes "expired" mean the
   * same thing whether or not a sweep has run since.
   */
  function pruneExpiredContexts(now = Date.now()) {
    for (const [handleId, record] of contexts.entries()) {
      if (new Date(record.expiresAt || 0).getTime() <= now) {
        contexts.delete(handleId)
      }
    }
  }

  return {
    kind: 'memory',

    async saveDevice(device) {
      devices.set(device.deviceId, {
        ...device,
        updatedAt: new Date().toISOString(),
      })
      return devices.get(device.deviceId)
    },

    async getDevice(deviceId) {
      return devices.get(deviceId) ?? null
    },

    async listDevices() {
      return [...devices.values()].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )
    },

    /* Same contract as d1Store, including the order: credentials and undrained
     * mail go first, so no token and no inbox can outlive the device it
     * belongs to. See d1Store.deleteDevice for why. */
    async deleteDevice(deviceId) {
      for (const [tokenId, credential] of deviceCredentials.entries()) {
        if (credential.deviceId === deviceId) {
          deviceCredentials.delete(tokenId)
        }
      }
      for (const [messageId, entry] of nodeMessages.entries()) {
        if (entry.envelope.to === deviceId) nodeMessages.delete(messageId)
      }
      return devices.delete(deviceId)
    },

    async saveDeviceCredential(credential) {
      const record = {
        ...credential,
        scopes: [...(credential.scopes || [])],
        updatedAt: credential.updatedAt || new Date().toISOString(),
      }
      deviceCredentials.set(record.tokenId, record)
      return { ...record, scopes: [...record.scopes] }
    },

    async getDeviceCredential(tokenId) {
      const record = deviceCredentials.get(tokenId)
      return record ? { ...record, scopes: [...record.scopes] } : null
    },

    /* Newest first, revoked rows included: the operator listing credentials is
     * usually asking "what did I just kill" as often as "what is live". */
    async listDeviceCredentials({ deviceId = null } = {}) {
      return [...deviceCredentials.values()]
        .filter((record) => !deviceId || record.deviceId === deviceId)
        .map((record) => ({ ...record, scopes: [...record.scopes] }))
        .sort((left, right) =>
          String(right.createdAt || '').localeCompare(String(left.createdAt || '')),
        )
    },

    async touchDeviceCredential(tokenId, lastUsedAt = new Date().toISOString()) {
      const current = deviceCredentials.get(tokenId)
      if (!current) {
        return null
      }

      const next = {
        ...current,
        lastUsedAt,
        updatedAt: lastUsedAt,
      }
      deviceCredentials.set(tokenId, next)
      return { ...next, scopes: [...next.scopes] }
    },

    async revokeDeviceCredential(tokenId, revokedAt = new Date().toISOString()) {
      const current = deviceCredentials.get(tokenId)
      if (!current) {
        return null
      }

      const next = {
        ...current,
        revokedAt,
        updatedAt: revokedAt,
      }
      deviceCredentials.set(tokenId, next)
      return { ...next, scopes: [...next.scopes] }
    },

    async saveState(stateKey, data, { updatedBy = 'unknown' } = {}) {
      const current = states.get(stateKey)
      const record = {
        stateKey,
        revision: Number(current?.revision || 0) + 1,
        updatedAt: new Date().toISOString(),
        updatedBy,
        data,
      }
      states.set(stateKey, record)
      return record
    },

    async getState(stateKey) {
      return states.get(stateKey) ?? null
    },

    async mergeProductState(input) {
      const incoming = normalizeProductSync(input)
      const current = productStates.get(incoming.accountId)
      const merged = current
        ? mergeProductSyncDocuments(current, incoming)
        : incoming
      const stored = normalizeProductSync({
        ...merged,
        revision: Number(current?.revision || 0) + 1,
        generatedAt: new Date().toISOString(),
      })
      productStates.set(incoming.accountId, stored)
      return normalizeProductSync(stored)
    },

    async getProductState(accountId) {
      const current = productStates.get(accountId)
      if (current) {
        return normalizeProductSync(current)
      }
      return normalizeProductSync({
        accountId,
        sourceDeviceId: 'cloud-memory',
        revision: 0,
        generatedAt: new Date().toISOString(),
        sessions: [],
        memory: {},
      })
    },

    async createJob(job) {
      pruneExpiredJobs()
      jobs.set(job.jobId, job)
      return job
    },

    async getJob(jobId) {
      return jobs.get(jobId) ?? null
    },

    /* `type` accepts one type or an array of them (the history feed pages
     * plan jobs and browser task records through one cursor). Same contract
     * as d1Store. */
    async listJobs({ type = null, limit = 40, before = null, search = null } = {}) {
      pruneExpiredJobs()
      const safeLimit = normalizeJobListLimit(limit)
      const cursor = normalizeJobCursor(before)
      const types = Array.isArray(type) ? type.filter(Boolean) : null
      return [...jobs.values()]
        .filter((job) =>
          types ? types.includes(job.type) : !type || job.type === type,
        )
        .filter((job) => jobIsBeforeCursor(job, cursor))
        .filter((job) => jobMatchesSearch(job, search))
        .sort(compareJobsNewestFirst)
        .slice(0, safeLimit)
    },

    async deleteJob(jobId) {
      return jobs.delete(jobId)
    },

    async updateJob(jobId, patch) {
      const current = jobs.get(jobId)

      if (!current) {
        return null
      }

      const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      }
      jobs.set(jobId, next)
      return next
    },

    async failQueuedAgentProxyJobs(
      reason = 'Superseded by a newer dashboard refresh.',
      { exceptJobId = null, olderThan = null } = {},
    ) {
      pruneExpiredJobs()
      let count = 0
      const now = new Date().toISOString()
      for (const [jobId, job] of jobs.entries()) {
        if (exceptJobId && jobId === exceptJobId) continue
        if (olderThan && String(job.createdAt || '') >= String(olderThan)) continue
        if (job.status === 'queued' && job.type === 'agent_proxy') {
          jobs.set(jobId, {
            ...job,
            status: 'failed',
            error: reason,
            updatedAt: now,
          })
          count += 1
        }
      }
      return count
    },

    async claimNextJob(deviceId) {
      pruneExpiredJobs()
      const nowMs = Date.now()
      const nowIso = new Date().toISOString()

      for (let attempt = 0; attempt < 40; attempt += 1) {
        // Same priority rule as d1Store: voice jobs preempt agent_proxy work.
        // 'browser_task' rows are records of work a browser node already
        // executed (browserTaskHistory.js), excluded by TYPE and not merely by
        // status: the Mac must never be able to claim or re-run one, whatever
        // status a future writer stamps on it.
        const queued = [...jobs.values()]
          .filter((job) => job.status === 'queued' && job.type !== 'browser_task')
          .sort(
            (a, b) =>
              (a.type === 'agent_proxy' ? 1 : 0) -
                (b.type === 'agent_proxy' ? 1 : 0) ||
              String(a.createdAt).localeCompare(String(b.createdAt)),
          )

        const job = queued[0]
        if (!job) return null

        if (job.type === 'agent_proxy') {
          const age = nowMs - new Date(job.createdAt || 0).getTime()
          if (age > AGENT_PROXY_MAX_AGE_MS) {
            jobs.set(job.jobId, {
              ...job,
              status: 'failed',
              error: 'Expired before the Mac bridge could run it.',
              updatedAt: nowIso,
            })
            continue
          }
        }

        const claimed = {
          ...job,
          status: 'processing',
          claimedBy: deviceId,
          claimedAt: nowIso,
          updatedAt: nowIso,
        }
        jobs.set(job.jobId, claimed)
        return claimed
      }

      return null
    },

    /* ---- scheduled routines / announcements -----------------------------
     * Same contract as d1Store so `npm run relay` locally exercises the real
     * scheduler rather than a stub that only works in production.
     * -------------------------------------------------------------------- */

    async saveRoutine(routine) {
      const record = { ...routine, updatedAt: new Date().toISOString() }
      routines.set(record.routineId, record)
      routineLeases.delete(record.routineId)
      return record
    },

    async getRoutine(routineId) {
      return routines.get(routineId) ?? null
    },

    async listRoutines({ limit = 50 } = {}) {
      return [...routines.values()]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200))
    },

    async deleteRoutine(routineId) {
      routineLeases.delete(routineId)
      return routines.delete(routineId)
    },

    async claimDueRoutines({ now = Date.now(), limit = 8, leaseMs = 300_000 } = {}) {
      const due = [...routines.values()]
        .filter(
          (routine) =>
            routine.enabled &&
            Number.isFinite(routine.nextRunAt) &&
            routine.nextRunAt <= now &&
            (routineLeases.get(routine.routineId) ?? 0) <= now,
        )
        .sort((a, b) => a.nextRunAt - b.nextRunAt)
        .slice(0, Math.min(Math.max(Number(limit) || 8, 1), 25))
      for (const routine of due) {
        routineLeases.set(routine.routineId, now + leaseMs)
      }
      return due.map((routine) => ({ ...routine }))
    },

    async recordRoutineRun(run) {
      routineRuns.set(run.runId, { ...run })
      return run
    },

    async listRoutineRuns({ routineId = null, status = null, limit = 25 } = {}) {
      return [...routineRuns.values()]
        .filter((run) => !routineId || run.routineId === routineId)
        .filter((run) => !status || run.status === status)
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, Math.min(Math.max(Number(limit) || 25, 1), 100))
    },

    async createAnnouncement(announcement) {
      announcements.set(announcement.announcementId, { ...announcement })
      return announcement
    },

    async listAnnouncements({ deviceId = null, state = null, limit = 20 } = {}) {
      return [...announcements.values()]
        .filter((entry) => !deviceId || entry.deviceId === deviceId)
        .filter((entry) => !state || entry.state === state)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100))
    },

    /* ---- announcement retention (see d1Store.js for why these exist) ----- */

    /** Rows past `expiresAt`. A missing expiry is never selected: unknown means keep. */
    async listExpiredAnnouncements({ before, limit = 200 }) {
      const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500)
      return [...announcements.values()]
        .filter((entry) => {
          const expiresAt = Date.parse(entry.expiresAt || '')
          return Number.isFinite(expiresAt) && expiresAt <= Date.parse(before)
        })
        .sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)))
        .slice(0, safeLimit)
        .map((entry) => ({ ...entry }))
    },

    async announcementStats({ before }) {
      const cutoff = Date.parse(before)
      let expired = 0
      let expiredBytes = 0
      let totalBytes = 0
      let undated = 0
      for (const entry of announcements.values()) {
        const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
        totalBytes += bytes
        const expiresAt = Date.parse(entry.expiresAt || '')
        if (!Number.isFinite(expiresAt)) {
          undated += 1
          continue
        }
        if (expiresAt <= cutoff) {
          expired += 1
          expiredBytes += bytes
        }
      }
      return {
        total: announcements.size,
        totalBytes,
        expired,
        expiredBytes,
        undated,
      }
    },

    async deleteAnnouncement(announcementId) {
      return announcements.delete(announcementId)
    },

    async updateAnnouncement(announcementId, patch) {
      const current = announcements.get(announcementId)
      if (!current) return null
      const next = { ...current, ...patch }
      announcements.set(announcementId, next)
      return next
    },

    /* ---- migrated contexts ----------------------------------------------
     * Storage lives on the relay because the relay is the only body awake
     * when the others sleep — a context stored on the Mac is unreachable at
     * exactly the moment the pendant needs to hand one over.
     * -------------------------------------------------------------------- */

    async saveContext(record) {
      pruneExpiredContexts()
      contexts.set(record.handleId, { ...record })
      return record
    },

    async getContext(handleId) {
      pruneExpiredContexts()
      const record = contexts.get(handleId)
      return record ? { ...record } : null
    },

    async deleteContext(handleId) {
      return contexts.delete(handleId)
    },

    /* ---- node mesh mailbox ----------------------------------------------
     * Same contract as d1Store, including the LEASE — a stub that handed the
     * same message to two drains would make local development the only place
     * the mesh looks exactly-once, and at-least-once is the property every
     * receiver has to be written against.
     * -------------------------------------------------------------------- */

    async enqueueNodeMessage(envelope) {
      /* INSERT ... ON CONFLICT DO NOTHING: a retried send is one message. */
      if (!nodeMessages.has(envelope.id)) {
        nodeMessages.set(envelope.id, {
          envelope,
          leasedUntil: null,
          leaseToken: null,
          attempts: 0,
        })
      }
      return envelope
    },

    async countPendingNodeMessages(toNode, { now = Date.now() } = {}) {
      let pending = 0
      for (const entry of nodeMessages.values()) {
        if (
          entry.envelope.to === toNode &&
          Date.parse(entry.envelope.expiresAt) > now
        ) {
          pending += 1
        }
      }
      return pending
    },

    async leaseNodeMessages(
      toNode,
      { limit = 50, leaseMs = 60_000, leaseToken, now = Date.now() } = {},
    ) {
      const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200)
      const token = String(leaseToken || `${now}-${Math.random()}`)
      const leasedUntil = new Date(now + Math.max(1_000, leaseMs)).toISOString()

      const claimable = [...nodeMessages.values()]
        .filter(
          (entry) =>
            entry.envelope.to === toNode &&
            Date.parse(entry.envelope.expiresAt) > now &&
            (!entry.leasedUntil || Date.parse(entry.leasedUntil) <= now),
        )
        .sort((a, b) =>
          String(a.envelope.createdAt).localeCompare(
            String(b.envelope.createdAt),
          ),
        )
        .slice(0, safeLimit)

      for (const entry of claimable) {
        entry.leasedUntil = leasedUntil
        entry.leaseToken = token
        entry.attempts += 1
      }
      return claimable.map((entry) => ({ ...entry.envelope }))
    },

    async ackNodeMessages(toNode, messageIds = []) {
      let removed = 0
      for (const messageId of new Set(messageIds.map(String))) {
        const entry = nodeMessages.get(messageId)
        /* Scoped by addressee, exactly as the DELETE's WHERE clause is: a
         * guessed message id must not reach into another node's inbox. */
        if (entry && entry.envelope.to === toNode) {
          nodeMessages.delete(messageId)
          removed += 1
        }
      }
      return removed
    },

    async pruneExpiredNodeMessages({ now = Date.now() } = {}) {
      let removed = 0
      for (const [messageId, entry] of nodeMessages.entries()) {
        if (Date.parse(entry.envelope.expiresAt) <= now) {
          nodeMessages.delete(messageId)
          removed += 1
        }
      }
      return removed
    },

    /*
     * No cross-surface memory-event log anymore. Domain memory lives in the
     * fleet state's domainMemory hive block (shared/domainMemory.js) and
     * rides the ordinary getState/saveState methods above, merged on write
     * by the relay — see cloud-relay/domainMemoryRelay.js.
     */
  }
}
