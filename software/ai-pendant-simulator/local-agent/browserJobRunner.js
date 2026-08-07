import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { addressPage, excerptAround, normalizeText, readPageText } from './browserPage.js'
import { workspacePath } from './config.js'
import { redactionMapFor } from './evidenceCapsules.js'
import {
  SESSION_NEED,
  compareReadings,
  judgeSessionNeed,
  observationFromComparison,
  originOf,
  readSessionNeedStore,
  recordSessionObservation,
  sessionNeedLocation,
  shouldCalibrate,
} from './sessionNeedSignal.js'

/*
 * A durable browser job: one web read, two possible browsers, and a rule that
 * picks between them from what has been observed rather than from a list.
 *
 * WHY A JOB AND NOT A CALL. Both browsers are absent most of the time. The
 * owner's Safari is awake when they are at the Mac; the Cloudflare browser is
 * rate limited to one page every ten seconds and has ten browser-minutes a day.
 * A function call has to resolve into one of "answer", "error" or a hang, so
 * every one of those absences becomes a failure the caller has to babysit. A
 * job can wait: it is written to disk before anything is attempted, it survives
 * the agent restarting, and "the Mac is asleep, I will read this the moment it
 * wakes" is a state it can actually be in rather than an error it has to
 * pretend to be.
 *
 * WHY RETRY IS SAFE HERE AND NOT IN browserBridge.js. That module retires an
 * expired lease instead of re-queueing it, and is right to: it carries clicks
 * and typing, and re-running a command that may already have run acts on a real
 * page twice. This runner is read-only BY CONSTRUCTION — JOB_READ_ONLY is
 * handed to every extension call and runBrowserActions throws on anything
 * outside it before a request is built — so a re-attempt can at worst re-read a
 * page. That difference is what buys durability, and it is why the vocabulary
 * here is deliberately not extended to click or type.
 *
 * WHAT THE ROUTING RULE IS. In order, and every step falls out of a fact rather
 * than a preference:
 *
 *   1. Physics. An address the public internet cannot resolve — RFC1918,
 *      localhost, a single-label host — is not forbidden to a datacenter
 *      browser, it is unreachable by it. serverBrowser.normalizePublicUrl() is
 *      the single definition of that and it is injected, never re-implemented.
 *   2. Session need. sessionNeedSignal.judgeSessionNeed() answers "does this
 *      page need the owner's login?" from observed fetches, decayed. Read that
 *      file: the entire anti-allowlist argument lives there.
 *   3. Otherwise the server browser, which is what the request asked for: web
 *      reads default to the cloud tier, and the Mac is reserved for pages that
 *      need the owner's session.
 *
 * WHAT HAPPENS WHEN A BACKEND IS MISSING. Nothing silently succeeds. A page
 * that needs the owner's session while the Mac is asleep PARKS — status
 * 'waiting-for-session', retried on a backoff, and it says so — because the
 * thing a user actually wants there is the answer when the Mac comes back, not
 * a stranger's logged-out view of their account labelled as their own record.
 * A caller who genuinely prefers the logged-out page can pass allowDegraded and
 * gets it with authenticated:false and answersOwnerRecord:false on the result.
 * When the deadline passes with nobody home, the job fails and names what was
 * missing.
 *
 * WHAT IS PERSISTED. Never the page. The stored result carries a redacted
 * preview, the quotes the caller asked for, and counts; the full text is
 * returned to the caller that ran the job and then dropped.
 */

const STORE_VERSION = 1

/* The whole vocabulary. Same three verbs originFanOut.js allows itself, for the
 * same reason — see the note on retry safety above. */
export const JOB_READ_ONLY = new Set(['list_tabs', 'navigate', 'read_page'])

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING: 'waiting-for-session',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

/* Long enough for the owner to come back from lunch and the job still to be
 * live; short enough that a page nobody needed by tonight is not read tomorrow
 * morning and spoken as news. */
const DEFAULT_DEADLINE_MS = 6 * 60 * 60 * 1000

/* Exponential, because the two reasons a job waits — a rate limit and a sleeping
 * Mac — are minutes and hours respectively, and one schedule should not make
 * the first one slow or the second one a busy-loop. */
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 10 * 60_000

/*
 * A job left 'running' by a crashed process. Twice the longest a single attempt
 * can take (an extension lease is 45s, a cloud page 20s, and a calibration is
 * both), so a lease this old means the process holding it is gone.
 */
const RUN_LEASE_MS = 3 * 60_000

const DEFAULT_MAX_CHARS = 12_000
const PREVIEW_CHARS = 400
const EXCERPT_RADIUS = 110
const MAX_JOBS = 200
/* How long a finished job stays readable. A caller that asked at breakfast and
 * came back at lunch should still find its answer. */
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000

/* ------------------------------------------------------------------ store */

export function browserJobsLocation() {
  return (
    process.env.PENDANT_BROWSER_JOBS_PATH ||
    path.join(workspacePath, '.pendant-browser-jobs.json')
  )
}

const emptyStore = () => ({ version: STORE_VERSION, jobs: {}, keys: {} })

const isValidStore = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  Boolean(value.jobs) &&
  typeof value.jobs === 'object'

function readStore(filePath) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  const stored = readJsonWithRecovery(filePath, {
    fallback: emptyStore(),
    validate: isValidStore,
  })
  return { version: STORE_VERSION, jobs: { ...stored.jobs }, keys: { ...(stored.keys ?? {}) } }
}

function writeStore(store, filePath) {
  writeJsonAtomic(filePath, store, { validate: isValidStore })
  return store
}

function prune(store, now) {
  for (const [jobId, job] of Object.entries(store.jobs)) {
    const terminal = [JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(job.status)
    if (terminal && now - Date.parse(job.updatedAt) > TERMINAL_TTL_MS) delete store.jobs[jobId]
  }

  const ids = Object.entries(store.jobs)
  if (ids.length > MAX_JOBS) {
    /* Drop finished work before live work, oldest first. A queued job is
     * somebody still waiting for an answer and must outlive a stored one. */
    ids
      .filter(([, job]) =>
        [JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(job.status),
      )
      .sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt))
      .slice(0, ids.length - MAX_JOBS)
      .forEach(([jobId]) => delete store.jobs[jobId])
  }

  for (const [key, jobId] of Object.entries(store.keys)) {
    if (!store.jobs[jobId]) delete store.keys[key]
  }

  return store
}

function patchJob(jobId, updater, { filePath, now }) {
  const store = readStore(filePath)
  const job = store.jobs[jobId]
  if (!job) return null
  const next = { ...job, ...updater(job), updatedAt: new Date(now).toISOString() }
  store.jobs[jobId] = next
  writeStore(prune(store, now), filePath)
  return next
}

function note(job, entry, now) {
  return [...(job.history ?? []), { at: new Date(now).toISOString(), ...entry }].slice(-20)
}

/* --------------------------------------------------------------- intake */

/**
 * Write a job down before anything is attempted.
 *
 * An idempotency key means "these two asks are one act": the second returns the
 * first job rather than reading the page twice. Same contract browserBridge.js
 * uses, for the same reason — a caller that gave up waiting and asked again
 * must not spend a second Browser Run action.
 */
export function submitBrowserJob(input = {}, { now = Date.now(), filePath = browserJobsLocation() } = {}) {
  const url = String(input.url ?? '').trim()
  const origin = originOf(url)
  if (!origin) throw new Error(`A browser job needs an http(s) URL (got ${url || '(empty)'}).`)

  const store = readStore(filePath)
  const idempotencyKey = String(input.idempotencyKey ?? '').trim().slice(0, 200) || null

  if (idempotencyKey) {
    const existing = store.jobs[store.keys[idempotencyKey]]
    if (existing) return { ...existing, deduplicated: true }
  }

  const at = new Date(now).toISOString()
  const job = {
    jobId: `webjob_${crypto.randomUUID()}`,
    idempotencyKey,
    url,
    origin,
    /* Why the page is being read. Feeds the phrasing signal and nothing else —
     * it is never written to the session-need store. */
    requestText: String(input.requestText ?? input.question ?? '').slice(0, 400),
    look: []
      .concat(input.look ?? input.terms ?? [])
      .map((term) => String(term).trim())
      .filter(Boolean)
      .slice(0, 8),
    maxChars:
      Number(input.maxChars) > 0 ? Math.min(Number(input.maxChars), 20_000) : DEFAULT_MAX_CHARS,
    /* 'server' | 'bridge' | null. An override the caller is allowed to have and
     * which is honoured, flagged, and never silently reinterpreted. */
    backend: ['server', 'bridge'].includes(input.backend) ? input.backend : null,
    /* Take a logged-out reading rather than wait, and be told it is one. */
    allowDegraded: input.allowDegraded === true,
    /* null lets shouldCalibrate() decide; false is for a caller that cannot
     * afford the extra Mac round-trip. */
    calibrate: input.calibrate === undefined ? null : Boolean(input.calibrate),
    status: JOB_STATUS.QUEUED,
    attempts: 0,
    createdAt: at,
    updatedAt: at,
    nextAttemptAt: at,
    deadlineAt: new Date(
      now + Math.max(60_000, Number(input.deadlineMs) || DEFAULT_DEADLINE_MS),
    ).toISOString(),
    route: null,
    result: null,
    error: null,
    reason: null,
    history: [{ at, event: 'submitted' }],
  }

  store.jobs[job.jobId] = job
  if (idempotencyKey) store.keys[idempotencyKey] = job.jobId
  writeStore(prune(store, now), filePath)
  return job
}

export function getBrowserJob(jobId, { filePath = browserJobsLocation() } = {}) {
  return readStore(filePath).jobs[jobId] ?? null
}

export function listBrowserJobs({ status = null, filePath = browserJobsLocation() } = {}) {
  const jobs = Object.values(readStore(filePath).jobs).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )
  return status ? jobs.filter((job) => job.status === status) : jobs
}

export function cancelBrowserJob(jobId, { now = Date.now(), filePath = browserJobsLocation() } = {}) {
  return patchJob(
    jobId,
    (job) =>
      [JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(job.status)
        ? {}
        : {
            status: JOB_STATUS.CANCELLED,
            reason: 'cancelled',
            error: 'Cancelled before it was read.',
            history: note(job, { event: 'cancelled' }, now),
          },
    { filePath, now },
  )
}

/* --------------------------------------------------------------- routing */

/**
 * Which browser answers this job, and why that one.
 *
 * Pure, and separated from everything that does I/O so the rule itself can be
 * argued with in a test rather than inferred from a run.
 *
 * @param need         judgeSessionNeed() output for this job's URL.
 * @param serverReady  the cloud browser is configured for this process.
 * @param reach        normalizePublicUrl(url) from the relay module, or null
 *                     when that module could not be loaded at all.
 * @param bridgeUp     true / false / null. null means "not known" and is
 *                     treated as attemptable: one timeout is cheaper than
 *                     refusing to try, and the runner learns from the attempt.
 */
export function routeBrowserJob(job, {
  need = { verdict: SESSION_NEED.UNKNOWN, confidence: 0 },
  serverReady = false,
  reach = null,
  bridgeUp = null,
  allowDegraded = false,
} = {}) {
  const degradedAllowed = allowDegraded || job.allowDegraded === true
  const bridgeAttemptable = bridgeUp !== false
  const reachable = reach ? reach.ok === true : false
  const serverUsable = serverReady && reachable

  const serverBlocked = !serverReady
    ? 'the cloud browser is not configured for this process'
    : !reach
      ? 'the cloud browser module could not be loaded, so publicness is unverified'
      : !reach.ok
        ? reach.error || 'the cloud browser cannot reach that address'
        : null

  if (job.backend === 'bridge') {
    return bridgeAttemptable
      ? { backend: 'bridge', reason: 'the caller asked for the owner\'s browser by name' }
      : {
          backend: null,
          park: true,
          reason: 'the owner\'s browser was asked for by name and is not answering',
        }
  }

  if (job.backend === 'server') {
    if (!serverUsable) {
      return { backend: null, park: true, reason: `the cloud browser was asked for by name but ${serverBlocked}` }
    }
    return {
      backend: 'server',
      /* Honoured, but a cloud reading of a page that needs a session is not the
       * owner's record and the flag travels all the way to the result. */
      degraded: need.verdict === SESSION_NEED.REQUIRED,
      reason:
        need.verdict === SESSION_NEED.REQUIRED
          ? 'the caller asked for the cloud browser, which holds none of the owner\'s sessions'
          : 'the caller asked for the cloud browser by name',
    }
  }

  /*
   * Physics outranks everything, including a verdict. An address only the
   * owner's network can resolve has exactly one browser that can see it, and no
   * amount of evidence about sessions changes that.
   */
  if (!reachable) {
    /* Two different facts arrive here and they must not be reported as one. A
     * judged-unreachable address is physics; a missing judgement is a relay
     * that could not be loaded, and telling the owner their news site is on
     * their home network would be a lie with a plausible shape. */
    const why =
      reach && !reach.ok
        ? `only the owner's browser can reach this: ${serverBlocked}`
        : `${serverBlocked}, so the owner's browser reads it`

    return bridgeAttemptable
      ? { backend: 'bridge', reason: why }
      : {
          backend: null,
          park: true,
          reason: `${serverBlocked}, and the owner's browser is not answering`,
        }
  }

  if (need.verdict === SESSION_NEED.REQUIRED) {
    if (bridgeAttemptable) {
      return {
        backend: 'bridge',
        reason: `this page needs the owner's session — ${need.why ?? need.basis?.[0] ?? 'observed'}`,
      }
    }
    if (degradedAllowed && serverUsable) {
      return {
        backend: 'server',
        degraded: true,
        reason:
          'the owner\'s browser is not answering and the caller accepted a logged-out reading of a page that needs their session',
      }
    }
    return {
      backend: null,
      park: true,
      reason:
        'this page needs the owner\'s session and their browser is not answering, so a cloud reading of it would not be their record',
    }
  }

  if (serverUsable) {
    const calibration = shouldCalibrate(need, { bridgeUp, enabled: job.calibrate !== false })
    return {
      backend: 'server',
      calibrate: calibration.calibrate,
      calibrateReason: calibration.why,
      reason:
        need.verdict === SESSION_NEED.PUBLIC
          ? 'this origin has read the same with and without the owner\'s session, so the cloud browser reads it'
          : 'a web read with no sign that it needs the owner\'s session, so the cloud browser takes it and the Mac stays asleep',
    }
  }

  if (bridgeAttemptable) {
    return { backend: 'bridge', reason: `${serverBlocked}, so the owner's browser reads it` }
  }

  return { backend: null, park: true, reason: `${serverBlocked}, and the owner's browser is not answering` }
}

/* ------------------------------------------------------------- execution */

function matchTerms(text, look) {
  const clean = normalizeText(text)
  return look.map((term) => {
    const quote = excerptAround(clean, term, EXCERPT_RADIUS)
    const found = Boolean(quote) && quote.toLowerCase().includes(term.toLowerCase())
    return {
      term,
      found,
      quote: found ? redactionMapFor(quote).content : null,
    }
  })
}

/** What is safe to keep on disk: quotes the caller asked for, a redacted
 * preview, and counts. Never the page. */
function storableResult(reading, look) {
  const preview = redactionMapFor(normalizeText(reading.text).slice(0, PREVIEW_CHARS))
  return {
    backend: reading.backend,
    url: reading.url,
    title: String(reading.title ?? '').slice(0, 200),
    authenticated: reading.authenticated === true,
    /* The one field a caller has to read before quoting this as the owner's
     * own record. False on every cloud reading, always. */
    answersOwnerRecord: reading.authenticated === true,
    degraded: reading.degraded === true,
    chars: normalizeText(reading.text).length,
    truncated: reading.truncated === true,
    untrusted: reading.untrusted === true,
    observedAt: reading.observedAt,
    matches: matchTerms(reading.text, look),
    preview: preview.content,
    redaction: { counts: preview.counts, classification: preview.classification },
    ...(reading.capsuleId ? { capsuleId: reading.capsuleId } : {}),
    ...(reading.browserMs ? { browserMs: reading.browserMs } : {}),
    ...(reading.comparison ? { comparison: reading.comparison } : {}),
    ...(reading.warning ? { warning: reading.warning } : {}),
  }
}

/** The relay's cloud browser, loaded only if something routes to it. Same lazy
 * import originFanOut.js uses, and for the same reason: nothing should drag
 * Cloudflare bindings into a process that never touches them. */
async function defaultServerBrowser() {
  try {
    const { normalizePublicUrl, readPublicPage } = await import('../cloud-relay/serverBrowser.js')
    return { normalizePublicUrl, readPublicPage }
  } catch {
    return null
  }
}

/** The owner's Safari, through the agent's own /execute contract. */
async function defaultBridgeRead(url, { maxChars = DEFAULT_MAX_CHARS, timeoutMs = 45_000 } = {}) {
  const options = {
    command: `read ${url}`,
    source: 'browser-job',
    allow: JOB_READ_ONLY,
    timeoutMs,
  }
  /* Always a re-fetch: a tab left open since yesterday answers instantly with
   * yesterday's page, and this runner stamps what it returns as read now. */
  const landed = await addressPage(url, { reload: true, options })
  const page = await readPageText(landed.target, { mode: 'main_text', maxChars, options })
  return {
    text: page.content,
    title: page.title || landed.title || '',
    url: page.url || landed.url || url,
    capsuleId: page.capsuleId ?? null,
  }
}

/** Is the owner's browser there? null when nothing has ever heartbeated, which
 * is "unknown" and not "no". */
async function defaultBridgeUp() {
  try {
    const { getBrowserStatus } = await import('./browserBridge.js')
    const status = getBrowserStatus()
    if (!status?.devices?.length) return null
    return Boolean(status.online)
  } catch {
    return null
  }
}

/*
 * A failure worth waiting out, versus one that will still be true in ten
 * minutes. 401/403 are retryable because they are the wall signal, and the
 * response to them is a different browser rather than the same one again.
 */
function isRetryable(reason, status) {
  if (['rate-limited', 'timeout', 'transport-error', 'not-configured', 'no-backend', 'bridge-offline'].includes(reason)) {
    return true
  }
  if (reason === 'http-error') {
    if (!Number.isFinite(status)) return true
    if (status === 401 || status === 403 || status === 408 || status === 429) return true
    return status >= 500
  }
  return reason !== 'not-public-web' && reason !== 'invalid-url'
}

const backoffMs = (attempts) =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))

/*
 * The cloud browser answered, but with the wall it can never climb.
 *
 * `empty` is included deliberately: a page that renders no text to a blank
 * Chrome is nearly always a client-side app that redirected to a sign-in, and
 * treating it as "nothing to read" would lose the single most useful
 * observation this system can make.
 */
function looksUnauthenticated(result) {
  if (!result) return false
  if (result.likelyLoginWall) return true
  if (result.ok) return false
  if (result.reason === 'empty') return true
  return result.reason === 'http-error' && [401, 403].includes(Number(result.status))
}

/**
 * Run one job to whatever conclusion it can reach right now.
 *
 * Never throws: everything ends up as a stored status the caller can read back,
 * because a job that failed by throwing into a drain loop is a job nobody can
 * find out about later.
 */
export async function runBrowserJob(jobId, deps = {}) {
  const {
    server = null,
    loadServer = defaultServerBrowser,
    bridgeRead = defaultBridgeRead,
    bridgeUp = defaultBridgeUp,
    clock = () => Date.now(),
    filePath = browserJobsLocation(),
    signalPath = sessionNeedLocation(),
  } = deps

  const now = clock()
  const stored = getBrowserJob(jobId, { filePath })
  if (!stored) return null
  if ([JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(stored.status)) {
    return stored
  }

  if (now >= Date.parse(stored.deadlineAt)) {
    return patchJob(
      jobId,
      (job) => ({
        status: JOB_STATUS.FAILED,
        reason: 'deadline',
        error:
          job.reason === 'waiting-for-session'
            ? 'This page needs your own browser, and the Mac never came back before the job expired.'
            : `Gave up after ${Math.round((Date.parse(job.deadlineAt) - Date.parse(job.createdAt)) / 60_000)} minutes without a browser that could read it.`,
        history: note(job, { event: 'expired' }, now),
      }),
      { filePath, now },
    )
  }

  const relay = server ?? (await loadServer())
  const bridgeState = typeof bridgeUp === 'function' ? await bridgeUp() : bridgeUp
  const signals = readSessionNeedStore({ filePath: signalPath })
  const need = judgeSessionNeed({
    url: stored.url,
    requestText: stored.requestText,
    now,
    store: signals,
  })
  const reach = relay?.normalizePublicUrl ? relay.normalizePublicUrl(stored.url) : null
  const route = routeBrowserJob(stored, {
    need,
    serverReady: Boolean(relay?.readPublicPage),
    reach,
    bridgeUp: bridgeState,
  })

  const job = patchJob(
    jobId,
    (current) => ({
      status: JOB_STATUS.RUNNING,
      attempts: (current.attempts ?? 0) + 1,
      leasedAt: new Date(now).toISOString(),
      route: { ...route, need: { verdict: need.verdict, confidence: need.confidence, why: need.why } },
      history: note(current, { event: 'routed', backend: route.backend, reason: route.reason }, now),
    }),
    { filePath, now },
  )

  if (!route.backend) {
    return park(jobId, {
      filePath,
      now,
      attempts: job.attempts,
      reason: route.park ? 'waiting-for-session' : 'no-backend',
      error: route.reason,
      status: route.park ? JOB_STATUS.WAITING : JOB_STATUS.QUEUED,
    })
  }

  try {
    const reading =
      route.backend === 'server'
        ? await runServerLeg({ job, relay, route, bridgeRead, bridgeState, signalPath, clock })
        : await runBridgeLeg({ job, bridgeRead, clock })

    if (reading.park) {
      return park(jobId, {
        filePath,
        now: clock(),
        attempts: job.attempts,
        reason: reading.reason,
        error: reading.error,
        status: JOB_STATUS.WAITING,
      })
    }

    if (reading.failed) {
      return fail(jobId, {
        filePath,
        now: clock(),
        attempts: job.attempts,
        reason: reading.reason,
        error: reading.error,
        retryable: reading.retryable,
      })
    }

    const finished = patchJob(
      jobId,
      (current) => ({
        status: JOB_STATUS.DONE,
        reason: null,
        error: null,
        result: storableResult(reading, current.look),
        history: note(current, { event: 'read', backend: reading.backend, chars: reading.text.length }, clock()),
      }),
      { filePath, now: clock() },
    )

    /* The full text goes to whoever ran the job and is not written down. */
    return { ...finished, text: reading.text }
  } catch (error) {
    return fail(jobId, {
      filePath,
      now: clock(),
      attempts: job.attempts,
      reason: error?.reason ?? 'read-failed',
      error: String(error?.message ?? error),
      retryable: isRetryable(error?.reason ?? 'read-failed', error?.status),
    })
  }
}

function park(jobId, { filePath, now, attempts, reason, error, status }) {
  return patchJob(
    jobId,
    (job) => ({
      status,
      reason,
      error,
      nextAttemptAt: new Date(now + backoffMs(attempts)).toISOString(),
      history: note(job, { event: 'parked', reason }, now),
    }),
    { filePath, now },
  )
}

function fail(jobId, { filePath, now, attempts, reason, error, retryable }) {
  if (!retryable) {
    return patchJob(
      jobId,
      (job) => ({
        status: JOB_STATUS.FAILED,
        reason,
        error,
        history: note(job, { event: 'failed', reason }, now),
      }),
      { filePath, now },
    )
  }
  return patchJob(
    jobId,
    (job) => ({
      status: JOB_STATUS.QUEUED,
      reason,
      error,
      nextAttemptAt: new Date(now + backoffMs(attempts)).toISOString(),
      history: note(job, { event: 'retry-scheduled', reason }, now),
    }),
    { filePath, now },
  )
}

/**
 * The cloud browser leg, plus everything it teaches.
 *
 * Three outcomes worth naming:
 *   - it hit a wall            → record it, and hand the job to the Mac if the
 *                                Mac is there. That escalation gives both
 *                                readings for free, so the comparison is made
 *                                and recorded at no extra cost.
 *   - it read a page and this origin is unjudged → read it on the Mac too and
 *                                compare. This is the only way the dangerous
 *                                case is ever caught: a page that renders fine
 *                                logged out and shows the owner something else.
 *   - it read a page on an origin already judged public → done, one fetch.
 */
async function runServerLeg({ job, relay, route, bridgeRead, bridgeState, signalPath, clock }) {
  const result = await relay.readPublicPage(job.url, {
    maxChars: job.maxChars,
    /* A background job has the time the free plan's ten-second gap costs; a
     * voice turn does not, which is why serverBrowser defaults this to 0. */
    maxRateLimitWaitMs: 11_000,
  })

  if (looksUnauthenticated(result)) {
    recordSessionObservation(
      {
        url: job.url,
        kind: 'login-wall',
        detail: result.likelyLoginWall
          ? 'the cloud browser rendered a sign-in wall'
          : `the cloud browser got ${result.reason}${result.status ? ` (${result.status})` : ''}`,
      },
      { now: clock(), filePath: signalPath },
    )

    if (bridgeState === false) {
      return {
        park: true,
        reason: 'waiting-for-session',
        error:
          'The cloud browser hit a sign-in wall on this page and the Mac is not answering, so there is no browser that holds your session for it yet.',
      }
    }

    const authenticated = await bridgeRead(job.url, { maxChars: job.maxChars })
    /* Both readings in hand. Compare them even though the wall already settled
     * the routing — a wall says "needs a session", the comparison says how
     * different the page actually is, and the second fact is the one that
     * survives the wall being replaced by a soft paywall next month. */
    if (result.ok && result.text) {
      recordComparison({ job, publicText: result.text, authText: authenticated.text, signalPath, clock })
    }

    return {
      backend: 'bridge',
      authenticated: true,
      text: authenticated.text,
      title: authenticated.title,
      url: authenticated.url,
      capsuleId: authenticated.capsuleId,
      observedAt: new Date(clock()).toISOString(),
      warning: 'The cloud browser saw a sign-in wall here; this reading came from your own browser.',
    }
  }

  if (!result?.ok) {
    return {
      failed: true,
      reason: result?.reason ?? 'read-failed',
      error: result?.error || 'the cloud browser could not read that page',
      retryable: isRetryable(result?.reason ?? 'read-failed', Number(result?.status)),
    }
  }

  const publicReading = {
    backend: 'server',
    authenticated: false,
    degraded: route.degraded === true,
    untrusted: true,
    text: String(result.text ?? ''),
    title: result.title ?? '',
    url: result.url || job.url,
    truncated: Boolean(result.truncated),
    browserMs: result.browserMs ?? 0,
    observedAt: new Date(clock()).toISOString(),
    ...(route.degraded
      ? {
          warning:
            'This origin needs your session and this reading has none of it, so it is not your own record.',
        }
      : {}),
  }

  if (!route.calibrate) {
    /* The weakest observation there is, and the reason it is weak is written
     * down in sessionNeedSignal.js: a logged-out page renders fine. */
    recordSessionObservation(
      {
        url: job.url,
        kind: 'public-read-ok',
        detail: 'the cloud browser read this page with no sign-in wall',
      },
      { now: clock(), filePath: signalPath },
    )
    return publicReading
  }

  /* Calibration. Costs one Mac round-trip and settles the origin. */
  let authenticated
  try {
    authenticated = await bridgeRead(job.url, { maxChars: job.maxChars })
  } catch {
    /* The Mac not answering must not lose a page the cloud already read. Keep
     * the reading, record the weak fact, leave the origin unjudged. */
    recordSessionObservation(
      {
        url: job.url,
        kind: 'public-read-ok',
        detail: 'the cloud browser read this page; the owner\'s browser was not available to compare',
      },
      { now: clock(), filePath: signalPath },
    )
    return publicReading
  }

  const comparison = recordComparison({
    job,
    publicText: publicReading.text,
    authText: authenticated.text,
    signalPath,
    clock,
  })

  if (comparison?.verdict === 'different') {
    /* The two browsers disagree, so the cloud reading is not what the owner
     * would see. Answer with theirs — it is already in hand. */
    return {
      backend: 'bridge',
      authenticated: true,
      text: authenticated.text,
      title: authenticated.title,
      url: authenticated.url,
      capsuleId: authenticated.capsuleId,
      observedAt: new Date(clock()).toISOString(),
      comparison,
      warning:
        'Your own browser sees a different page here than a logged-out one does, so this reading came from yours.',
    }
  }

  return { ...publicReading, comparison }
}

function recordComparison({ job, publicText, authText, signalPath, clock }) {
  const comparison = compareReadings(publicText, authText)
  const observation = observationFromComparison(comparison)
  if (observation) {
    recordSessionObservation(
      {
        url: job.url,
        kind: observation.kind,
        weight: observation.weight,
        detail: observation.detail,
        stats: comparison,
      },
      { now: clock(), filePath: signalPath },
    )
  }
  return comparison
}

async function runBridgeLeg({ job, bridgeRead, clock }) {
  const authenticated = await bridgeRead(job.url, { maxChars: job.maxChars })
  return {
    backend: 'bridge',
    authenticated: true,
    text: String(authenticated.text ?? ''),
    title: authenticated.title ?? '',
    url: authenticated.url || job.url,
    capsuleId: authenticated.capsuleId,
    observedAt: new Date(clock()).toISOString(),
  }
}

/* -------------------------------------------------------------- draining */

/** Jobs due to be attempted now, oldest first. */
export function dueBrowserJobs({ now = Date.now(), filePath = browserJobsLocation() } = {}) {
  return Object.values(readStore(filePath).jobs)
    .filter((job) => [JOB_STATUS.QUEUED, JOB_STATUS.WAITING].includes(job.status))
    .filter((job) => now >= Date.parse(job.nextAttemptAt))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/**
 * Attempt every job that is due, one at a time.
 *
 * Serial on purpose: both backends are serial transports — the extension runs
 * one command at a time and the cloud browser allows one page every ten seconds
 * — so concurrency here would buy queueing and 429s rather than throughput.
 * Same reasoning as originFanOut.js's lane limits.
 */
export async function drainBrowserJobs(deps = {}) {
  const { clock = () => Date.now(), filePath = browserJobsLocation(), limit = 10 } = deps
  const due = dueBrowserJobs({ now: clock(), filePath }).slice(0, limit)
  const ran = []
  for (const job of due) {
    ran.push(await runBrowserJob(job.jobId, deps))
  }
  return {
    drainedAt: new Date(clock()).toISOString(),
    attempted: ran.length,
    done: ran.filter((job) => job?.status === JOB_STATUS.DONE).length,
    waiting: ran.filter((job) => job?.status === JOB_STATUS.WAITING).length,
    failed: ran.filter((job) => job?.status === JOB_STATUS.FAILED).length,
    jobs: ran.map((job) => ({ jobId: job?.jobId, status: job?.status, reason: job?.reason ?? null })),
  }
}

/**
 * Recover from a process that died mid-job, and expire what nobody can answer.
 *
 * A job stuck in 'running' is re-queued rather than retired — the opposite of
 * browserBridge.orphanExpiredLeases, and safe for exactly the reason in the
 * header: this runner cannot click anything, so the worst a re-attempt does is
 * read a page a second time.
 */
export function sweepBrowserJobs({ now = Date.now(), filePath = browserJobsLocation() } = {}) {
  const store = readStore(filePath)
  const recovered = []
  const expired = []

  for (const job of Object.values(store.jobs)) {
    const terminal = [JOB_STATUS.DONE, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(job.status)
    if (terminal) continue

    if (now >= Date.parse(job.deadlineAt)) {
      store.jobs[job.jobId] = {
        ...job,
        status: JOB_STATUS.FAILED,
        reason: 'deadline',
        error:
          job.reason === 'waiting-for-session'
            ? 'This page needs your own browser, and the Mac never came back before the job expired.'
            : 'No browser could read this page before the job expired.',
        updatedAt: new Date(now).toISOString(),
        history: note(job, { event: 'expired' }, now),
      }
      expired.push(job.jobId)
      continue
    }

    if (job.status === JOB_STATUS.RUNNING && now - Date.parse(job.leasedAt ?? job.updatedAt) >= RUN_LEASE_MS) {
      store.jobs[job.jobId] = {
        ...job,
        status: JOB_STATUS.QUEUED,
        reason: 'interrupted',
        error: 'The agent stopped while this page was being read; it is queued again.',
        nextAttemptAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        history: note(job, { event: 'recovered' }, now),
      }
      recovered.push(job.jobId)
    }
  }

  writeStore(prune(store, now), filePath)
  return { sweptAt: new Date(now).toISOString(), recovered, expired }
}

/**
 * Sweep and drain on a timer. Returns a stop function.
 *
 * unref'd, like browserBridge's supervisor: a background runner must never be
 * the reason the process refuses to exit.
 */
export function startBrowserJobRunner({ intervalMs = 30_000, ...deps } = {}) {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      sweepBrowserJobs({ filePath: deps.filePath ?? browserJobsLocation() })
      await drainBrowserJobs(deps)
    } catch (error) {
      console.warn('browser job runner tick failed:', error?.message || error)
    } finally {
      running = false
    }
  }, intervalMs)

  timer.unref?.()
  return () => clearInterval(timer)
}

/* ------------------------------------------------------------------ routes */

/**
 * Wire the job surface onto an app.
 *
 * A registration function rather than route blocks in server.js: several people
 * edit that file at once, and a feature that owns its routes can be mounted or
 * removed in one line. Same shape as registerBrowserBridgeRoutes.
 *
 * Mount with: registerBrowserJobRoutes(app)
 */
export function registerBrowserJobRoutes(app, { basePath = '/browser-jobs', ...deps } = {}) {
  const routes = []
  const add = (method, routePath, handler) => {
    app[method](routePath, handler)
    routes.push(`${method.toUpperCase()} ${routePath}`)
  }
  const fail = (response, error, code = 400) =>
    response.status(code).json({ ok: false, error: String(error?.message || error) })

  add('post', basePath, async (request, response) => {
    try {
      const job = submitBrowserJob(request.body || {})
      /* `run: true` is for a caller that is waiting; the default is to queue and
       * let the runner get to it, which is the whole point of a durable job. */
      const ran = request.body?.run === true ? await runBrowserJob(job.jobId, deps) : null
      response.json({ ok: true, job: ran ?? job })
    } catch (error) {
      fail(response, error)
    }
  })

  add('get', basePath, (request, response) => {
    const jobs = listBrowserJobs({ status: request.query?.status || null })
    response.json({
      ok: true,
      jobs,
      counts: jobs.reduce((counts, job) => ({ ...counts, [job.status]: (counts[job.status] ?? 0) + 1 }), {}),
      storePath: browserJobsLocation(),
    })
  })

  /* Literal paths before the parameterised one: Express answers with whichever
   * was registered first, and '/drain' matches ':jobId' perfectly well. */
  add('post', `${basePath}/drain`, async (_request, response) => {
    try {
      response.json({ ok: true, ...(await drainBrowserJobs(deps)) })
    } catch (error) {
      fail(response, error, 500)
    }
  })

  add('post', `${basePath}/sweep`, (_request, response) => {
    response.json({ ok: true, ...sweepBrowserJobs() })
  })

  add('get', `${basePath}/signals`, async (_request, response) => {
    const { listSessionNeeds } = await import('./sessionNeedSignal.js')
    response.json({ ok: true, origins: listSessionNeeds(), storePath: sessionNeedLocation() })
  })

  /*
   * The owner correcting the router. An observation like any other — it decays,
   * it can be outvoted by later fetches, and it is one origin at a time. This
   * is deliberately not a settings page: a permanent switch here would be the
   * hardcoded list arriving through the front door.
   */
  add('post', `${basePath}/signals`, async (request, response) => {
    try {
      const { needsSession, url } = request.body || {}
      const need = recordSessionObservation({
        url,
        kind: needsSession === false ? 'owner-cleared' : 'owner-marked',
        detail: 'the owner said so',
      })
      response.json({ ok: true, need })
    } catch (error) {
      fail(response, error)
    }
  })

  add('get', `${basePath}/:jobId`, (request, response) => {
    const job = getBrowserJob(request.params.jobId)
    if (!job) return fail(response, new Error('No such browser job.'), 404)
    return response.json({ ok: true, job })
  })

  add('post', `${basePath}/:jobId/run`, async (request, response) => {
    try {
      const job = await runBrowserJob(request.params.jobId, deps)
      if (!job) return fail(response, new Error('No such browser job.'), 404)
      return response.json({ ok: true, job })
    } catch (error) {
      return fail(response, error, 500)
    }
  })

  add('post', `${basePath}/:jobId/cancel`, (request, response) => {
    const job = cancelBrowserJob(request.params.jobId)
    if (!job) return fail(response, new Error('No such browser job.'), 404)
    return response.json({ ok: true, job })
  })

  return routes
}

/**
 * What this module offers, in shared/capabilityRegistry.js's vocabulary.
 *
 * Exported as data rather than registered here: the registry instance lives in
 * the orchestrator, and a module that reaches for a global registry at import
 * time cannot be tested without one.
 */
export const BROWSER_JOB_CAPABILITIES = Object.freeze([
  {
    name: 'web read job',
    surface: 'browser',
    kind: 'http',
    invoke: { method: 'POST', path: '/browser-jobs' },
    what: 'Queue a durable web read that routes itself between the cloud browser and the owner\'s Safari.',
    module: 'local-agent/browserJobRunner.js',
    provides: ['jobId'],
  },
  {
    name: 'web read job status',
    surface: 'browser',
    kind: 'http',
    invoke: { method: 'GET', path: '/browser-jobs/:jobId' },
    what: 'The routing decision, the reason for it, and the reading if there is one.',
    module: 'local-agent/browserJobRunner.js',
  },
  {
    name: 'session need signals',
    surface: 'browser',
    kind: 'http',
    invoke: { method: 'GET', path: '/browser-jobs/signals' },
    what: 'Per-origin learned verdicts on whether a page needs the owner\'s login, with their evidence.',
    module: 'local-agent/sessionNeedSignal.js',
  },
])
