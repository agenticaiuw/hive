import { voiceRunForJob } from './jobs.js'

/*
 * History is derived from the same `plan` jobs the operator feed already shows,
 * so a run can never appear in one view and not the other. Everything here is
 * pure: the store hands over a page of jobs plus the audio captures that could
 * belong to them, and these helpers shape the response.
 */

export const HISTORY_DEFAULT_LIMIT = 20
export const HISTORY_MAX_LIMIT = 50
export const HISTORY_MAX_QUERY_LENGTH = 120
// A page of runs is filtered after it is read (voiceRunForJob rejects jobs the
// owner did not start), so read a few pages' worth of rows per request.
export const HISTORY_OVERSCAN = 3
export const HISTORY_MAX_SCAN = 100

// Recordings created before the relay started stamping `captureId` onto the
// plan job can still be matched, but only when the transcript is identical and
// the two rows were written within the same handful of seconds.
const HEURISTIC_MATCH_WINDOW_MS = 120_000

export function normalizeHistoryLimit(
  value,
  { fallback = HISTORY_DEFAULT_LIMIT, max = HISTORY_MAX_LIMIT } = {},
) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(Math.max(Math.floor(parsed), 1), max)
}

/**
 * Cursors are `<createdAt>|<jobId>` so that two runs sharing a millisecond can
 * never hide each other across a page boundary.
 */
export function encodeHistoryCursor(entry) {
  if (!entry?.createdAt || !entry?.pipelineId) {
    return null
  }
  return `${entry.createdAt}|${entry.pipelineId}`
}

export function decodeHistoryCursor(value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return null
  }

  const separator = raw.lastIndexOf('|')
  const createdAt = separator === -1 ? raw : raw.slice(0, separator)
  const jobId = separator === -1 ? '' : raw.slice(separator + 1)

  if (Number.isNaN(new Date(createdAt).getTime())) {
    return null
  }
  if (jobId && !/^[A-Za-z0-9_.:-]{1,160}$/.test(jobId)) {
    return null
  }

  return { createdAt, jobId: jobId || '￿' }
}

export function normalizeHistoryQuery(value) {
  return String(value ?? '')
    .trim()
    .slice(0, HISTORY_MAX_QUERY_LENGTH)
}

export function matchesHistoryQuery(job, query) {
  const needle = normalizeHistoryQuery(query).toLowerCase()
  if (!needle) {
    return true
  }

  return [job?.command, job?.transcript, job?.result?.response]
    .map((field) => String(field ?? '').toLowerCase())
    .some((haystack) => haystack.includes(needle))
}

/** The outcome sentence the pendant actually spoke back, when there is one. */
export function spokenReplyForJob(job) {
  const result = job?.result && typeof job.result === 'object' ? job.result : null
  if (!result) {
    return ''
  }
  return String(result.response || result.summary || '').slice(0, 2000)
}

function audioSummary(capture, link) {
  if (!capture) {
    return {
      available: false,
      captureId: null,
      link: null,
      storage: null,
      format: null,
      audioBytes: null,
      createdAt: null,
      deletedAt: null,
    }
  }

  const storage = capture.audioStorage || (capture.audioBase64 ? 'd1-base64' : null)
  return {
    available: storage === 'r2' || storage === 'd1-base64',
    captureId: capture.jobId,
    link,
    storage,
    format: capture.format ?? null,
    audioBytes: Number(capture.audioBytes) || null,
    createdAt: capture.createdAt ?? null,
    deletedAt: capture.audioDeletedAt ?? null,
  }
}

/**
 * Pair each plan job with its recording. Explicit `inputTelemetry.captureId`
 * links win; the transcript/timestamp heuristic only fills gaps left by rows
 * written before that field existed, and never reuses one capture twice.
 */
export function linkAudioCaptures(jobs = [], captures = []) {
  const capturesById = new Map()
  for (const capture of captures) {
    if (capture?.jobId) {
      capturesById.set(capture.jobId, capture)
    }
  }

  const claimed = new Set()
  const links = new Map()

  for (const job of jobs) {
    const declared =
      String(job?.inputTelemetry?.captureId || '').trim() ||
      String(
        [...capturesById.values()].find(
          (capture) => capture.planJobId && capture.planJobId === job?.jobId,
        )?.jobId || '',
      )
    const capture = declared ? capturesById.get(declared) : null
    if (capture && !claimed.has(capture.jobId)) {
      claimed.add(capture.jobId)
      links.set(job.jobId, { capture, link: 'telemetry' })
    }
  }

  for (const job of jobs) {
    if (links.has(job?.jobId)) continue
    const transcript = String(job?.command || '').trim()
    if (!transcript) continue
    const jobTime = new Date(job?.createdAt || 0).getTime()
    if (!Number.isFinite(jobTime)) continue

    let best = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const capture of capturesById.values()) {
      if (claimed.has(capture.jobId)) continue
      if (String(capture.transcript || '').trim() !== transcript) continue
      const distance = Math.abs(new Date(capture.createdAt || 0).getTime() - jobTime)
      if (!Number.isFinite(distance) || distance > HEURISTIC_MATCH_WINDOW_MS) continue
      if (distance < bestDistance) {
        best = capture
        bestDistance = distance
      }
    }

    if (best) {
      claimed.add(best.jobId)
      links.set(job.jobId, { capture: best, link: 'heuristic' })
    }
  }

  return links
}

export function historyEntryForJob(job, { capture = null, link = null } = {}) {
  const run = voiceRunForJob(job)
  if (!run) {
    return null
  }

  const telemetry = job.inputTelemetry || {}
  const actions = Array.isArray(job.result?.actions) ? job.result.actions : []

  return {
    pipelineId: run.pipelineId,
    kind: run.kind,
    command: run.command,
    origin: run.origin,
    inputMode: String(telemetry.inputMode || (run.origin === 'dashboard' ? 'typed' : 'voice')),
    source: run.source,
    sessionId: job.sessionId ?? null,
    status: run.status,
    jobStatus: job.status,
    reply: spokenReplyForJob(job),
    actionCount: actions.length,
    eventCount: run.events.length,
    error: job.error ?? null,
    durationMs: Number(telemetry.durationMs) || null,
    audio: audioSummary(capture, link),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

/**
 * Turn one over-fetched page of plan jobs into history entries plus the cursor
 * for the next page. `scanned` is the raw row count so the caller can tell a
 * short page (nothing left) from a page thinned out by filtering.
 */
export function buildHistoryPage({
  jobs = [],
  captures = [],
  limit = HISTORY_DEFAULT_LIMIT,
  query = '',
  scanLimit = HISTORY_MAX_SCAN,
} = {}) {
  const safeLimit = normalizeHistoryLimit(limit)
  const matching = jobs.filter((job) => matchesHistoryQuery(job, query))
  const links = linkAudioCaptures(matching, captures)

  const all = matching
    .map((job) => {
      const linked = links.get(job.jobId)
      return historyEntryForJob(job, {
        capture: linked?.capture ?? null,
        link: linked?.link ?? null,
      })
    })
    .filter(Boolean)

  const entries = all.slice(0, safeLimit)
  const scanned = jobs.length
  // More rows exist when this page was trimmed, or when the store returned a
  // full scan window (so there is certainly something past the cursor).
  const hasMore = all.length > safeLimit || scanned >= scanLimit
  // When a whole scan window contained no owner-initiated runs there is no
  // entry to build a cursor from, so fall back to the oldest row scanned.
  // Without this the client would stop paging at the first quiet stretch.
  const oldestScanned = jobs.at(-1)
  const nextCursor = hasMore
    ? encodeHistoryCursor(entries.at(-1)) ||
      (oldestScanned
        ? encodeHistoryCursor({
            createdAt: oldestScanned.createdAt,
            pipelineId: oldestScanned.jobId,
          })
        : null)
    : null

  return {
    entries,
    nextCursor,
    hasMore: Boolean(nextCursor),
    scanned,
  }
}

/**
 * The single-run view: everything the dashboard needs to render one run
 * without a second round trip — the derived timeline, the planned actions, the
 * execution results, the spoken reply, and where the recording lives.
 */
export function runDetailForJob(job, { capture = null, link = null } = {}) {
  const run = voiceRunForJob(job)
  if (!run) {
    return null
  }

  const entry = historyEntryForJob(job, { capture, link })
  const result = job.result && typeof job.result === 'object' ? job.result : null
  const plannedActions = Array.isArray(job.actions) ? job.actions : []
  const resultActions = Array.isArray(result?.actions) ? result.actions : []

  return {
    ...entry,
    events: run.events,
    actions: plannedActions.length ? plannedActions : resultActions,
    execution: result
      ? {
          ok: result.ok ?? null,
          status: result.status ?? null,
          summary: result.summary ?? null,
          response: result.response ?? null,
          planner: result.planner ?? null,
          results: Array.isArray(result.results) ? result.results : [],
          actions: resultActions,
          thinking: result.thinking ?? null,
          pendantSpeech: result.pendantSpeech ?? null,
        }
      : null,
    inputTelemetry: job.inputTelemetry ?? null,
    transcript: capture?.transcript ?? null,
    transcriptionModel:
      job.inputTelemetry?.transcriptionModel ?? capture?.transcriptionModel ?? null,
    createdBy: job.createdBy ?? null,
  }
}

/** Compact list shape for the recordings view. */
export function audioCaptureSummary(capture) {
  return {
    captureId: capture.jobId,
    planJobId: capture.planJobId ?? null,
    audioBytes: capture.audioBytes ?? null,
    format: capture.format ?? null,
    language: capture.language ?? null,
    cloudTranscript: capture.transcript ?? null,
    cloudModel: capture.transcriptionModel ?? null,
    storage: capture.audioStorage || 'd1-base64',
    status: capture.status,
    audioDeletedAt: capture.audioDeletedAt ?? null,
    createdAt: capture.createdAt,
  }
}
