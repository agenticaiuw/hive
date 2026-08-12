import { voiceRunForCapture, voiceRunForJob } from './jobs.js'
import { BROWSER_TASK_JOB_TYPE } from './browserTaskHistory.js'
import { stripProtocolTerminators } from '../shared/protocolText.js'

/*
 * History is derived from the same `plan` jobs the operator feed already shows,
 * so a run can never appear in one view and not the other. Everything here is
 * pure: the store hands over a page of jobs plus the audio captures that could
 * belong to them, and these helpers shape the response.
 *
 * Browser-executed tasks ride the same page: browserTaskHistory.js folds the
 * extension's 'browser.task.record' mail into relay_jobs rows (type
 * 'browser_task'), and buildHistoryPage() below shapes those rows next to the
 * plan-job entries — same store, same cursor, same order — with the fields
 * that attribute the run to the browser node that executed it.
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
  return stripProtocolTerminators(
    result.response || result.summary || '',
  ).slice(0, 2000)
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
    replyAvailable: Boolean(capture.replyCaptureId),
    replyCaptureId: capture.replyCaptureId || null,
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
      if (capture.role === 'reply') continue
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
/*
 * Conversational presses leave no plan job — the capture IS the run. Shape it
 * like any other history entry so both voices and transcripts surface.
 */
export function historyEntryForCapture(capture) {
  const run = voiceRunForCapture(capture)
  if (!run) {
    return null
  }

  return {
    pipelineId: run.pipelineId,
    kind: run.kind,
    command: run.command,
    origin: run.origin,
    inputMode: 'voice',
    source: run.source,
    sessionId: null,
    status: run.status,
    jobStatus: 'completed',
    reply: capture.replyTranscript || null,
    actionCount: 0,
    eventCount: run.events.length,
    error: null,
    durationMs: null,
    audio: audioSummary(capture, 'self'),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

/*
 * A browser-executed run, shaped like every other history entry so the
 * dashboard renders it in the same list — plus the attribution fields:
 * `executor`/`executedBy`/`claimedBy` say WHICH browser node ran it (stamped
 * from the sender's credential, never from its payload), and
 * `claimable:false` restates on the wire what the stores enforce — this is a
 * record of finished-or-running browser work, never work for the Mac.
 *
 * `status` (and `jobStatus`, which the dashboard prefers) carry the honest
 * vocabulary browserTaskHistory.js stamped at fold time: only a verdict of
 * 'achieved' ever reads 'completed', so an incomplete browser run can never
 * render as Done.
 */
export function historyEntryForBrowserTask(job) {
  if (!job || job.type !== BROWSER_TASK_JOB_TYPE) {
    return null
  }

  const browser = job.browser && typeof job.browser === 'object' ? job.browser : {}
  const steps = Array.isArray(browser.steps) ? browser.steps : []
  const startedMs = Date.parse(job.startedAt ?? job.createdAt ?? '')
  const finishedMs = Date.parse(job.finishedAt ?? '')

  return {
    pipelineId: job.jobId,
    kind: 'browser_task',
    command: String(job.command || ''),
    origin: job.origin || 'browser-extension',
    /* Typed into the extension's console — there is no audio on this path. */
    inputMode: 'typed',
    /* The witnessing body. Plan entries say 'cloudflare'; here it is the
     * executing browser node itself, so the per-device attribution survives
     * even a client that only knows the plan-entry fields. */
    source: String(job.executedBy || 'browser'),
    sessionId: null,
    status: job.status,
    jobStatus: job.status,
    /* The extension's ledger-derived completion line, never model prose. */
    reply: String(browser.headline || ''),
    actionCount: steps.filter(
      (step) => step?.ok && (step.effect === 'act' || step.effect === 'outward'),
    ).length,
    eventCount: steps.length,
    error: job.error ?? null,
    durationMs:
      Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
        ? finishedMs - startedMs
        : null,
    audio: audioSummary(null),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    executor: 'browser',
    executedBy: job.executedBy ?? null,
    claimedBy: job.claimedBy ?? null,
    claimable: false,
    verdict: browser.verdict ?? null,
  }
}

/**
 * The single-run view for a browser task: the step trace as pipeline events
 * and an execution block, shaped so the existing run-detail consumers render
 * it without learning a second schema.
 */
export function browserTaskRunDetail(job) {
  const entry = historyEntryForBrowserTask(job)
  if (!entry) {
    return null
  }

  const browser = job.browser && typeof job.browser === 'object' ? job.browser : {}
  const steps = Array.isArray(browser.steps) ? browser.steps : []
  const terminal = browser.phase === 'verdict'

  const events = steps.map((step, index) => ({
    eventId: `browser-${job.jobId}-step-${index + 1}`,
    stage: 'browser',
    status: step?.ok ? 'done' : 'failed',
    label: [String(step?.tool || 'step'), step?.effect ? `(${step.effect})` : '']
      .filter(Boolean)
      .join(' '),
    detail: '',
    text: String(step?.summary || ''),
    source: entry.executedBy || 'browser',
    meta: null,
    at: step?.at ?? job.updatedAt,
  }))

  events.push({
    eventId: `browser-${job.jobId}-verdict`,
    stage: 'verdict',
    status: !terminal
      ? 'active'
      : entry.status === 'needs_approval'
        ? 'waiting'
        : ['failed', 'incomplete'].includes(entry.status)
          ? 'failed'
          : 'done',
    label: terminal
      ? String(browser.headline || `Recorded as ${entry.status}.`)
      : 'Executing in the browser',
    detail: terminal
      ? 'Verdict computed by the extension from its own step ledger.'
      : 'The browser node claimed this task and has not reported a verdict yet.',
    text: '',
    source: entry.executedBy || 'browser',
    meta: null,
    at: job.finishedAt ?? job.updatedAt,
  })

  return {
    ...entry,
    events,
    actions: [],
    execution: terminal
      ? {
          ok:
            entry.status === 'completed'
              ? true
              : entry.status === 'failed'
                ? false
                : null,
          status: entry.status,
          summary: String(browser.headline || '') || null,
          response: String(browser.headline || '') || null,
          planner: 'browser-affinity',
          results: steps.map((step) => ({
            ok: step?.ok === true,
            status: step?.ok ? 'done' : 'failed',
            message: String(step?.summary || step?.tool || ''),
            error: step?.ok ? null : String(step?.summary || '') || null,
          })),
          actions: steps.map((step) => ({
            type: String(step?.tool || 'step'),
            label: String(step?.summary || step?.tool || 'step'),
          })),
          thinking: null,
          pendantSpeech: null,
        }
      : null,
    inputTelemetry: null,
    transcript: null,
    transcriptionModel: null,
    createdBy: job.createdBy ?? entry.executedBy ?? null,
  }
}

/*
 * The operator-feed run for one relay_jobs row, whatever node produced it.
 *
 * WHY THIS EXISTS (owner, 2026-08-12, verbatim): "why didn't my question in
 * the browser extension carried to the dashboard?" The browser extension's
 * local brain answered "what's my latest personal gmail" entirely in-page,
 * recorded it here as a btask_ row — and the dashboard still showed nothing,
 * because the Recent feed reads /v1/ops/voice-runs, whose membership was
 * `type: 'plan'` only. The record had arrived; the feed never looked at it.
 * This helper is the one membership rule both /v1/ops/voice-runs and its
 * /latest freshness probe now share, so a row the history page shows can
 * never be invisible to the feed the owner actually watches.
 */
export function operatorRunForRow(job, options) {
  if (job?.type === BROWSER_TASK_JOB_TYPE) {
    return browserTaskRunDetail(job)
  }
  return voiceRunForJob(job, options)
}

export function buildHistoryPage({
  jobs = [],
  captures = [],
  limit = HISTORY_DEFAULT_LIMIT,
  query = '',
  scanLimit = HISTORY_MAX_SCAN,
} = {}) {
  const safeLimit = normalizeHistoryLimit(limit)
  /* Browser task rows share the page (and therefore the cursor) with plan
   * jobs, but never the capture linker below: the transcript heuristic would
   * happily hand a pendant recording to a typed browser run that repeated the
   * same words. */
  const planJobs = jobs.filter((job) => job?.type !== BROWSER_TASK_JOB_TYPE)
  const browserEntries = jobs
    .filter(
      (job) =>
        job?.type === BROWSER_TASK_JOB_TYPE && matchesHistoryQuery(job, query),
    )
    .map((job) => historyEntryForBrowserTask(job))
    .filter(Boolean)
  const matching = planJobs.filter((job) => matchesHistoryQuery(job, query))
  const links = linkAudioCaptures(matching, captures)

  const claimedCaptures = new Set(
    [...links.values()].map((linked) => linked?.capture?.jobId).filter(Boolean),
  )
  const captureEntries = captures
    .filter(
      (capture) =>
        capture &&
        !claimedCaptures.has(capture.jobId) &&
        !capture.planJobId &&
        capture.role !== 'reply' &&
        matchesHistoryQuery(
          { command: capture.transcript, transcript: capture.transcript },
          query,
        ),
    )
    .map((capture) => historyEntryForCapture(capture))
    .filter(Boolean)

  const all = matching
    .map((job) => {
      const linked = links.get(job.jobId)
      return historyEntryForJob(job, {
        capture: linked?.capture ?? null,
        link: linked?.link ?? null,
      })
    })
    .filter(Boolean)
    .concat(captureEntries)
    .concat(browserEntries)
    .sort(
      (left, right) =>
        new Date(right.createdAt || 0) - new Date(left.createdAt || 0),
    )

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
