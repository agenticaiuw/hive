import path from 'node:path'
import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'

const jobsPath = path.join(workspacePath, 'pendant-jobs.json')
const MAX_JOBS = 120

/*
 * MAX_JOBS caps how many jobs are kept, not how big they are, and a job's
 * result is whatever the orchestrator returned — which includes live snapshots
 * of stores that persist themselves elsewhere. Copying one into every job made
 * this file grow quadratically: measured at 129 MB across 120 jobs, of which
 * 99% was two snapshot fields, and every write re-serialises and fsyncs the
 * whole array three times. The agent stopped answering.
 *
 * The budget below is deliberately not a list of field names. Fields grow fat
 * for reasons nobody predicts, so the rule is "a job record has a size", and
 * the largest fields are shed first until it fits.
 */
const MAX_RESULT_BYTES = 64 * 1024

/* Small enough that keeping it costs nothing, big enough for the ids and
 * labels a caller follows to fetch the real value. */
const KEEP_SCALAR_BYTES = 256

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
  writeJsonAtomic(jobsPath, jobs.map(compactJobForStore), ARRAY_STORE)
}

/**
 * Shrink a job's result to the store budget by shedding its largest fields.
 *
 * Compaction is lossy and says so: every shed value is replaced by a summary
 * that names what went and how big it was, so a reader can tell an absent
 * field from an elided one.
 */
export function compactJobForStore(job) {
  const result = job?.result

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return job
  }

  if (jsonBytes(result) <= MAX_RESULT_BYTES) {
    return job
  }

  const largestFirst = Object.entries(result)
    .map(([key, value]) => ({ key, bytes: jsonBytes(value) }))
    .sort((left, right) => right.bytes - left.bytes)

  const compacted = { ...result }

  for (const { key } of largestFirst) {
    if (jsonBytes(compacted) <= MAX_RESULT_BYTES) break
    compacted[key] = summarizeOversized(compacted[key])
  }

  return { ...job, result: compacted }
}

/**
 * Keep the cheap identifying parts of a value and drop the bulk.
 *
 * A trace kept as `{ traceId }` still lets a caller fetch the trace; a bare
 * marker does not. That distinction is the whole point of summarising rather
 * than deleting.
 */
function summarizeOversized(value) {
  const bytes = jsonBytes(value)

  if (typeof value === 'string') {
    return {
      elided: 'string too large for the job store',
      bytes,
      preview: value.slice(0, KEEP_SCALAR_BYTES),
    }
  }

  if (Array.isArray(value)) {
    return { elided: 'array too large for the job store', bytes, length: value.length }
  }

  if (!value || typeof value !== 'object') {
    return { elided: 'value too large for the job store', bytes }
  }

  const kept = {}
  const dropped = []

  for (const [key, entry] of Object.entries(value)) {
    const isIdentifying =
      entry !== null &&
      typeof entry !== 'object' &&
      jsonBytes(entry) <= KEEP_SCALAR_BYTES

    if (isIdentifying) {
      kept[key] = entry
    } else {
      dropped.push(key)
    }
  }

  return { ...kept, elided: dropped, bytes }
}

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized)
  } catch {
    // A value that cannot be serialised cannot be stored either, so treat it
    // as maximally expensive and let it be shed first.
    return Number.MAX_SAFE_INTEGER
  }
}
