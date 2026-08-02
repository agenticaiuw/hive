import { JOB_TTL_MS } from '../config.js'
import {
  mergeProductSync as mergeProductSyncDocuments,
  normalizeProductSync,
} from '../../shared/productSync.js'

const jobs = new Map()
const devices = new Map()
const deviceCredentials = new Map()
const states = new Map()
const productStates = new Map()
const AGENT_PROXY_MAX_AGE_MS = 10_000

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

export function createMemoryStore() {
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

    async listJobs({ type = null, limit = 40 } = {}) {
      pruneExpiredJobs()
      const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100)
      return [...jobs.values()]
        .filter((job) => !type || job.type === type)
        .sort((left, right) =>
          String(right.createdAt).localeCompare(String(left.createdAt)),
        )
        .slice(0, safeLimit)
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
        const queued = [...jobs.values()]
          .filter((job) => job.status === 'queued')
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))

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
  }
}
