/*
 * The capability-gap INBOX: what the owner asked for that nothing could do.
 *
 * Until now that evidence evaporated at the moment it was produced.
 * llmPlanner.js returns { status: 'unsupported' } and orchestrator.js folds it
 * into a thinking step; executor.js throws "Unsupported action type" and
 * catches its own throw; goalRouter.js returns `plan.unroutable` and — by its
 * own comment — persists nothing. Meanwhile the design committee
 * (scripts/derive-harness.mjs) wakes only when the capability manifest CHANGES,
 * i.e. when code ships. It designed against what exists, never against what was
 * asked for and refused. This module is the missing wire: every refusal is
 * written down here, and each NEW ask is mirrored into the design commons
 * (scripts/commons.mjs → diagnostics/harness-derivation) where new content is
 * exactly what the committee's eligibility gate wakes on.
 *
 * NOT capabilityGaps.js. That module is a static self-audit of capabilities
 * that were BUILT and became unreachable. This one is the inbox of capabilities
 * that were ASKED FOR and do not exist. The audit looks at the code; the inbox
 * listens to the owner.
 *
 * Three writers, one source name each:
 *
 *   'planner-unsupported'     — orchestrator.js, when the planner refuses
 *   'goal-router-unroutable'  — goalRouter.js /route + /reroute handlers
 *   'executor-missing-action' — executor.js, when a plan step has no handler
 *
 * All three call recordGapSafely(), which never throws: gap recording is a
 * side channel and must not be able to break the answer the owner is waiting
 * for. The local store is the source of truth; the commons deposit is a
 * best-effort mirror and its failure is a throttled warning, never an error.
 *
 * Dedup is by the normalized ask, not by the mechanical reason: "send a fax to
 * Dr. Kim" refused by the planner today and by the router tomorrow is one
 * demand signal asked twice, so the record's `timesAsked` counts real demand
 * that a designer can rank by. Only a NEW record deposits to the commons — an
 * increment is not novelty and must not wake the committee again.
 *
 * Secrets: `want` and `detail` are owner speech and planner errors, either of
 * which can carry a credential ("connect stripe with key sk-…"). Both pass
 * through redaction.js before anything is stored, using the same
 * classify-then-mask rule computerControl.js documents, because
 * maskSecretValue on ordinary text withholds the whole sentence.
 *
 * Store: one JSON document under the workspace, via atomicJsonStore, byte-
 * bounded like browserSpool.js because this project has already been wedged by
 * a store that capped a count. Resolving a gap marks it, never deletes it —
 * "we built this" is part of the record.
 *
 * HTTP: mount from local-agent/server.js with exactly:
 *
 *     import { registerCapabilityGapInboxRoutes } from './capabilityGapInbox.js'
 *     registerCapabilityGapInboxRoutes(app)
 *
 *     GET  /capability-gaps/inbox              — newest first, with counts
 *     POST /capability-gaps/inbox/:id/resolve  — body { note }
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deposit } from '../scripts/commons.mjs'
import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { classifySensitivity, maskSecretValue } from './redaction.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const STORE_PATH = path.join(workspacePath, '.pendant-capability-gap-inbox.json')

/*
 * Where the design committee reads. The same ../../../ the other commons
 * writers use (scripts/harness-ledger.mjs, scripts/publish-capabilities.mjs),
 * so every depositor agrees on the directory by construction.
 * PENDANT_COMMONS_DIR exists for tests (testWorkspace.js points it into the
 * temp workspace) — production never sets it.
 */
const DEFAULT_COMMONS_DIR = path.resolve(
  HERE,
  '..',
  '..',
  '..',
  'diagnostics',
  'harness-derivation',
)

export const GAP_SOURCES = Object.freeze([
  'planner-unsupported',
  'goal-router-unroutable',
  'executor-missing-action',
])
const GAP_SOURCE_SET = new Set(GAP_SOURCES)

/* Same ask again within a day folds into the existing record. */
export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000

/* Byte-bounded, measured with the writer's own serialization (indent 2) — a
 * budget measured with a different serializer than the writer uses is a hope
 * with a number on it (browserSpool.js learned this with receipts). */
export const MAX_STORE_BYTES = 256 * 1024

const MAX_TEXT_CHARS = 400
const MAX_SURFACE_CHARS = 60
const MAX_JOB_ID_CHARS = 120

/* ---- store -------------------------------------------------------------- */

const isValidStore = (value) =>
  Boolean(value) &&
  Array.isArray(value.gaps) &&
  typeof value.dropped === 'object' &&
  value.dropped !== null

const emptyStore = () => ({ gaps: [], dropped: { entries: 0, lastAt: null } })

function load(filePath) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: emptyStore(),
    validate: isValidStore,
  })
}

export function capabilityGapInboxLocation() {
  return STORE_PATH
}

const storeBytes = (store) =>
  Buffer.byteLength(JSON.stringify(store, null, 2), 'utf8')

/*
 * Under byte pressure, resolved gaps go first (their demand was answered), then
 * the oldest open one. Dropping is counted, because a store that silently
 * overflowed looks exactly like a store nothing was written to.
 */
function evictUntilFits(store) {
  const oldestIndex = (matches) => {
    let index = -1
    let oldest = Infinity
    store.gaps.forEach((gap, at) => {
      if (!matches(gap)) return
      const seen = Date.parse(gap.lastAskedAt) || 0
      if (seen < oldest) {
        oldest = seen
        index = at
      }
    })
    return index
  }

  while (store.gaps.length > 1 && storeBytes(store) > MAX_STORE_BYTES) {
    const resolved = oldestIndex((gap) => Boolean(gap.resolvedAt))
    const victim = resolved !== -1 ? resolved : oldestIndex(() => true)
    const [gone] = store.gaps.splice(victim, 1)
    store.dropped.entries += 1
    store.dropped.lastAt = gone?.lastAskedAt ?? store.dropped.lastAt
  }
}

/* ---- redaction ---------------------------------------------------------- */

/*
 * classify first, mask only when needed — the rule computerControl.js
 * documents: maskSecretValue on ordinary text returns "[withheld]" for the
 * whole value, which would erase every innocent ask. Masking happens BEFORE
 * truncation so a credential cut in half cannot slip past its own pattern.
 */
function sanitizeText(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const safe = classifySensitivity(text) === 'secret' ? maskSecretValue(text) : text
  return safe.slice(0, maxChars)
}

/* ---- warnings ----------------------------------------------------------- */

/*
 * A misconfigured mirror must not turn a chatty agent into a log flood: each
 * distinct failure reason speaks at most once per interval.
 */
const WARN_EVERY_MS = 5 * 60 * 1000
const lastWarnAt = new Map()

function warnThrottled(reason, message) {
  const now = Date.now()
  if (now - (lastWarnAt.get(reason) ?? 0) < WARN_EVERY_MS) return
  lastWarnAt.set(reason, now)
  console.warn(message)
}

/* ---- record ------------------------------------------------------------- */

/**
 * Record one refused ask.
 *
 * `want` is the owner-facing ask (command text, goal clause, action label);
 * `detail` is the mechanical reason (planner error, missing need name, unknown
 * action type). Returns { gap, deduped } — deduped means an existing open
 * record inside the window absorbed this ask as `timesAsked += 1` and the
 * commons was NOT touched.
 *
 * Options exist for tests and for callers that know better: `filePath` moves
 * the store, `commonsDir` moves the mirror, `now`/`at` pin the clock.
 */
export function recordGap(
  { source, want, detail = '', jobId = null, surface = null, at = null },
  { filePath = STORE_PATH, commonsDir = null, now = Date.now(), warn = warnThrottled } = {},
) {
  if (!GAP_SOURCE_SET.has(source)) {
    throw new TypeError(
      `recordGap: unknown source "${source}" (expected ${GAP_SOURCES.join(' | ')})`,
    )
  }

  const cleanWant = sanitizeText(want, MAX_TEXT_CHARS)
  if (!cleanWant) {
    throw new TypeError('recordGap: `want` (the owner-facing ask) is required.')
  }
  const cleanDetail = sanitizeText(detail, MAX_TEXT_CHARS)
  const cleanSurface = sanitizeText(surface, MAX_SURFACE_CHARS) || null
  const cleanJobId = String(jobId ?? '').trim().slice(0, MAX_JOB_ID_CHARS) || null

  const askedAt = at ? new Date(at).toISOString() : new Date(now).toISOString()
  const askedMs = Date.parse(askedAt)
  const normalized = cleanWant.toLowerCase()

  const store = load(filePath)

  /*
   * Dedup against OPEN records only. A resolved gap asked for again is not a
   * duplicate — it is a regression or an unshipped fix, and it deserves a
   * fresh record (and a fresh commons deposit) rather than a silent increment
   * on something marked done.
   */
  const existing = store.gaps.find(
    (gap) =>
      !gap.resolvedAt &&
      gap.normalizedWant === normalized &&
      Math.abs(askedMs - Date.parse(gap.lastAskedAt)) <= DEDUP_WINDOW_MS,
  )

  if (existing) {
    existing.timesAsked += 1
    existing.lastAskedAt = askedAt
    if (!existing.sources.includes(source)) existing.sources.push(source)
    if (!existing.detail && cleanDetail) existing.detail = cleanDetail
    if (!existing.jobId && cleanJobId) existing.jobId = cleanJobId
    writeJsonAtomic(filePath, store, { validate: isValidStore })
    return { gap: existing, deduped: true }
  }

  const gap = {
    id: `gap_${crypto.randomUUID()}`,
    source,
    sources: [source],
    want: cleanWant,
    normalizedWant: normalized,
    detail: cleanDetail,
    jobId: cleanJobId,
    surface: cleanSurface,
    timesAsked: 1,
    firstAskedAt: askedAt,
    lastAskedAt: askedAt,
    resolvedAt: null,
    resolutionNote: null,
  }

  store.gaps.push(gap)
  evictUntilFits(store)
  writeJsonAtomic(filePath, store, { validate: isValidStore })

  /* Only after the local write succeeded: the inbox is the source of truth,
   * and a gap that exists only in the commons is a gap this surface lost. */
  depositNewGap(gap, { commonsDir, warn, now })

  return { gap, deduped: false }
}

/**
 * recordGap that cannot break its caller. Every production writer goes through
 * this: a refused ask is already a bad moment, and the recording of it must
 * never make the moment worse. Failure returns null and warns (throttled).
 */
export function recordGapSafely(gap, options = {}) {
  try {
    return recordGap(gap, options)
  } catch (error) {
    const warn = options.warn ?? warnThrottled
    try {
      warn(
        'record-failed',
        `[capability-gap-inbox] gap not recorded (${String(error?.message ?? error)}); continuing without it`,
      )
    } catch {
      /* Even the warning is not allowed to throw into the main path. */
    }
    return null
  }
}

/*
 * Mirror a NEW gap into the design commons, where fresh content is what the
 * committee's eligibility gate wakes on. Shape matches the other depositors
 * (tool/args/result/agent/round — see scripts/commons.mjs deposit()).
 *
 * The commons directory is the committee's, not ours: where it does not exist
 * (another machine, a checkout the committee never ran on) the deposit is
 * skipped with a throttled warning rather than creating the directory —
 * the local inbox remains the source of truth either way.
 */
function depositNewGap(gap, { commonsDir = null, warn = warnThrottled, now = Date.now() } = {}) {
  const dir = commonsDir ?? process.env.PENDANT_COMMONS_DIR ?? DEFAULT_COMMONS_DIR
  try {
    if (!fs.existsSync(dir)) {
      warn(
        'commons-missing',
        `[capability-gap-inbox] design commons not found at ${dir}; the gap is recorded locally only`,
      )
      return null
    }
    return deposit(dir, {
      tool: 'capability_gap',
      args: { source: gap.source, want: gap.want },
      result: {
        want: gap.want,
        detail: gap.detail,
        surface: gap.surface,
        timesAsked: gap.timesAsked,
      },
      agent: 'runtime',
      round: 0,
      now,
    })
  } catch (error) {
    warn(
      'commons-deposit-failed',
      `[capability-gap-inbox] commons deposit failed (${String(error?.message ?? error)}); the local inbox is the source of truth`,
    )
    return null
  }
}

/* ---- read / resolve ------------------------------------------------------ */

/** Every gap, newest ask first, with the counts a reader ranks by. */
export function listGaps({ filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const gaps = [...store.gaps].sort(
    (left, right) => (Date.parse(right.lastAskedAt) || 0) - (Date.parse(left.lastAskedAt) || 0),
  )

  const open = gaps.filter((gap) => !gap.resolvedAt)
  const bySource = Object.fromEntries(GAP_SOURCES.map((source) => [source, 0]))
  for (const gap of gaps) {
    for (const source of gap.sources ?? [gap.source]) {
      if (source in bySource) bySource[source] += 1
    }
  }

  return {
    gaps,
    counts: {
      total: gaps.length,
      open: open.length,
      resolved: gaps.length - open.length,
      asks: gaps.reduce((sum, gap) => sum + (Number(gap.timesAsked) || 0), 0),
      bySource,
    },
    dropped: store.dropped,
    storePath: filePath,
  }
}

/**
 * Mark a gap answered. Never deletes: the record that demand existed and was
 * met is exactly what distinguishes a quiet inbox from a deaf one. Unknown id
 * returns null; resolving twice keeps the first resolvedAt.
 */
export function resolveGap(id, note = '', { filePath = STORE_PATH, now = Date.now() } = {}) {
  const store = load(filePath)
  const gap = store.gaps.find((entry) => entry.id === String(id ?? ''))
  if (!gap) return null

  if (!gap.resolvedAt) gap.resolvedAt = new Date(now).toISOString()
  const cleanNote = sanitizeText(note, MAX_TEXT_CHARS)
  if (cleanNote) gap.resolutionNote = cleanNote

  writeJsonAtomic(filePath, store, { validate: isValidStore })
  return gap
}

/* ---- http ---------------------------------------------------------------- */

/**
 * Mount the inbox. NOT self-mounting: server.js is the operator's, and the one
 * line that makes these routes real is theirs to add (it is quoted verbatim in
 * this file's header). routeRegistration.test.js will hold the door open —
 * it fails on any exported registrar no server calls — until that line lands.
 */
export function registerCapabilityGapInboxRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerCapabilityGapInboxRoutes requires an Express-style app.')
  }

  const { basePath = '/capability-gaps/inbox', filePath = STORE_PATH } = options

  app.get(`${basePath}`, (_request, response) => {
    try {
      response.json({ ok: true, ...listGaps({ filePath }) })
    } catch (error) {
      response.status(500).json({ ok: false, error: String(error?.message || error) })
    }
  })

  app.post(`${basePath}/:id/resolve`, (request, response) => {
    try {
      const gap = resolveGap(request.params?.id, request.body?.note ?? '', { filePath })
      if (!gap) {
        response.status(404).json({ ok: false, error: 'No capability gap with that id.' })
        return
      }
      response.json({ ok: true, gap })
    } catch (error) {
      response.status(500).json({ ok: false, error: String(error?.message || error) })
    }
  })

  return [`GET ${basePath}`, `POST ${basePath}/:id/resolve`]
}
