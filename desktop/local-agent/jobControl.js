/**
 * In-process registry so dashboard can cancel in-flight plan/execute jobs.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const activeJobs = new Map()

/*
 * The cancellation signal belonging to whatever is running right now.
 *
 * /execute owns an AbortController per job, but the chain between that
 * controller and the child process it is supposed to stop — orchestrator →
 * focusCoordinator → executor → computerControl — carries actions, not
 * signals. `executeActions(actions)` takes exactly one argument by contract
 * and is not ours to change, so there is no parameter to thread a signal down.
 * The result was a cancel that only ever landed *between* steps: abort a plan
 * whose current step is `sleep 600` and the endpoint answers "cancelling", the
 * job is marked cancelled, and the sleep runs to completion.
 *
 * An async-local scope carries it instead. The orchestrator opens the scope
 * around the plan; the one place that spawns a child process asks for it.
 * Nothing is obliged to look: a caller outside any scope reads null and says
 * so on its own record (`interruptible: false`) rather than implying a cancel
 * would reach it.
 */
const cancellationScope = new AsyncLocalStorage()

/** Run `fn` with `signal` visible to anything below it that asks. */
export function runWithCancellation(signal, fn) {
  if (!signal) return fn()
  return cancellationScope.run({ signal }, fn)
}

/** The enclosing scope's signal, or null when there is no scope. */
export function currentCancellationSignal() {
  return cancellationScope.getStore()?.signal ?? null
}

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
