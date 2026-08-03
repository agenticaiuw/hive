import path from 'node:path'
import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'

const jobsPath = path.join(workspacePath, 'pendant-jobs.json')
const MAX_JOBS = 120
const ARRAY_STORE = { validate: Array.isArray }

export function jobsLocation() {
  ensureStore()
  return jobsPath
}

export function readJobs() {
  ensureStore()
  return readJsonWithRecovery(jobsPath, { fallback: [], ...ARRAY_STORE })
}

export function recordJobStart({ type, command, sessionId = null, source = 'local' }) {
  const now = new Date().toISOString()
  const job = {
    jobId: `local_${crypto.randomUUID()}`,
    type,
    status: 'processing',
    command: String(command ?? ''),
    sessionId,
    source,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  }

  writeJobs([job, ...readJobs()].slice(0, MAX_JOBS))
  return job
}

export function recordJobFinish(
  jobId,
  { status, result = null, error = null, thinking = null, undoneAt = undefined },
) {
  const jobs = readJobs()
  const job = jobs.find((item) => item.jobId === jobId)

  if (!job) {
    return null
  }

  job.status = status
  job.result = result
  job.error = error
  job.thinking = thinking
  if (undoneAt !== undefined) {
    job.undoneAt = undoneAt
  }
  job.updatedAt = new Date().toISOString()
  writeJobs(jobs)
  return job
}

export function getJob(jobId) {
  return readJobs().find((item) => item.jobId === jobId) ?? null
}

export function markJobUndone(jobId, undoResult) {
  const jobs = readJobs()
  const job = jobs.find((item) => item.jobId === jobId)
  if (!job) return null
  job.undoneAt = new Date().toISOString()
  job.undoResult = undoResult
  job.updatedAt = job.undoneAt
  writeJobs(jobs)
  return job
}

export function clearJobs() {
  writeJobs([])
  return []
}

function ensureStore() {
  ensureJsonStore(jobsPath, [], ARRAY_STORE)
}

function writeJobs(jobs) {
  writeJsonAtomic(jobsPath, jobs, ARRAY_STORE)
}
