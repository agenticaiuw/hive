import { JOB_TTL_MS } from '../config.js'
import {
  MAX_LOG_BYTES,
  pruneFleetMemoryEvents,
  takeWithinByteBudget,
} from '../../shared/fleetMemory.js'
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
 *     owner's facts to another. The memory log is the worst table for that to
 *     happen to, because it is the one designed to be pasted into a prompt.
 *   - Tests. Two `createMemoryStore()` calls in one process shared a log, so a
 *     test could pass on rows another test wrote — and fleetMemory.test.js
 *     already carries a `freshMemoryStore()` helper whose whole job is to
 *     scrub the shared state before each case. That helper is the bug's
 *     receipt, not its fix.
 *
 * Nothing else changes: every method below closes over these maps instead of
 * the module's, and none of them use `this`, so a detached method
 * (`{ listMemoryEvents: store.listMemoryEvents }`) still works.
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
  const memoryEvents = new Map()

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
   * One sweep for expiry, supersession and the byte ceiling, run on write and
   * on read. Read-side too, for the same reason contexts are checked on read:
   * it is what makes "expired" mean the same thing whether or not a write has
   * happened since, and this store is the one that runs for days in local
   * development without a single append.
   */
  function sweepMemoryEvents(now = Date.now(), maxBytes = MAX_LOG_BYTES) {
    const { kept, stats } = pruneFleetMemoryEvents([...memoryEvents.values()], {
      now,
      maxBytes,
    })

    if (stats.removed) {
      memoryEvents.clear()
      for (const record of kept) memoryEvents.set(record.eventId, record)
    }

    return stats
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

    async listJobs({ type = null, limit = 40, before = null, search = null } = {}) {
      pruneExpiredJobs()
      const safeLimit = normalizeJobListLimit(limit)
      const cursor = normalizeJobCursor(before)
      return [...jobs.values()]
        .filter((job) => !type || job.type === type)
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
        const queued = [...jobs.values()]
          .filter((job) => job.status === 'queued')
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

    /* ---- cross-surface memory -------------------------------------------
     * Same contract as d1Store so `npm run relay` locally exercises the real
     * fold and the real byte budget rather than a stub that only works in
     * production. The eviction ORDER matters as much as the totals here, and
     * it is the thing a stub would get wrong: see fleetMemory.js.
     * -------------------------------------------------------------------- */

    /*
     * `now` is threaded here for the same reason every other method takes it,
     * and its absence was a real bug: the post-append sweep ran on the wall
     * clock while the events had been stamped with the caller's, so an event
     * written with an explicit `now` more than one TTL behind real time was
     * expired by the very call that created it. The append still reported
     * `appended: 1` — the loss was silent, and only visible in the sweep
     * report's `reasons: {expired: 1}`.
     */
    async appendMemoryEvents(events, { now = Date.now() } = {}) {
      for (const event of Array.isArray(events) ? events : []) {
        // Appends are immutable, and a device on a flaky LTE link retries. A
        // re-sent batch must be a no-op, not a second copy of the same fact.
        if (!memoryEvents.has(event.eventId)) {
          memoryEvents.set(event.eventId, { ...event })
        }
      }
      return sweepMemoryEvents(now)
    },

    async listMemoryEvents({ now = Date.now(), maxBytes = MAX_LOG_BYTES } = {}) {
      sweepMemoryEvents(now, maxBytes)
      // Bounded again on the way out. The sweep already fits the log to the
      // budget, so this only binds when a caller asks for less than the store
      // holds — which is what a small surface with a small prompt should do.
      return takeWithinByteBudget([...memoryEvents.values()], maxBytes).map(
        (record) => ({ ...record }),
      )
    },

    async pruneMemoryEvents({ now = Date.now(), maxBytes = MAX_LOG_BYTES } = {}) {
      return sweepMemoryEvents(now, maxBytes)
    },
  }
}
