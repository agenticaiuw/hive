/**
 * In-process registry so dashboard can cancel in-flight plan/execute jobs.
 */
const activeJobs = new Map()

export function registerActiveJob(jobId, { abortController, kind = 'job' } = {}) {
  if (!jobId) return
  activeJobs.set(jobId, {
    abortController: abortController || new AbortController(),
    kind,
    startedAt: Date.now(),
  })
  return activeJobs.get(jobId)
}

export function getActiveJob(jobId) {
  return activeJobs.get(jobId) || null
}

export function clearActiveJob(jobId) {
  activeJobs.delete(jobId)
}

export function cancelActiveJob(jobId, reason = 'Cancelled from dashboard') {
  const entry = activeJobs.get(jobId)
  if (!entry) {
    return { ok: false, error: 'No in-progress job with that id.' }
  }
  try {
    entry.abortController.abort(reason)
  } catch {
    // ignore
  }
  return { ok: true, jobId, reason }
}

export function listActiveJobIds() {
  return [...activeJobs.keys()]
}

export class JobCancelledError extends Error {
  constructor(message = 'Cancelled from dashboard') {
    super(message)
    this.name = 'JobCancelledError'
    this.code = 'JOB_CANCELLED'
  }
}

export function throwIfAborted(signal, message = 'Cancelled from dashboard') {
  if (signal?.aborted) {
    throw new JobCancelledError(message)
  }
}
