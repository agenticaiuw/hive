import crypto from 'node:crypto'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { usableCapsuleIds } from './evidenceCapsules.js'

/*
 * What the owner has already been told, and what is waiting for them.
 *
 * Two questions, one store, because they are the same ledger read from
 * different ends. "Only tell me what changed" needs a record of what was said
 * last time; "put findings in a review queue instead of acting" needs a record
 * of what is still open. A finding moves from one to the other and back, and
 * splitting them across two files is how they drift.
 *
 * This is deliberately separate from audioBrief.js's briefing shelf. That store
 * answers "what audio exists"; this one answers "what has the owner heard, and
 * what still needs them". The duplicate-unplayed-briefings failure came from
 * having only the first of those: nothing on the shelf could say whether the
 * brief about to be rendered said anything the previous one had not — and on
 * this Mac that produced 44 byte-identical unplayed copies of one schedule
 * brief inside three minutes, which then evicted every other brief the owner
 * had not heard.
 */

const STORE_PATH = path.join(workspacePath, '.pendant-briefing-queue.json')

/*
 * Bounds. `told` is the novelty ledger and is read on every run, so it is the
 * one that has to stay small; 500 rows covers roughly a fortnight of three-item
 * briefings plus everything that was queued rather than spoken. A fingerprint
 * that ages out of it can be spoken again, which is the right failure: the
 * owner hears something twice a fortnight apart rather than never.
 */
const MAX_TOLD = 500
const MAX_QUEUE = 200
const MAX_RUNS = 30

const isValidStore = (value) =>
  value &&
  Array.isArray(value.told) &&
  Array.isArray(value.queue) &&
  Array.isArray(value.runs)

const EMPTY = () => ({ policy: null, told: [], queue: [], runs: [] })

function load(filePath = STORE_PATH) {
  ensureJsonStore(filePath, EMPTY(), { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: EMPTY(),
    validate: isValidStore,
  })
}

function save(store, filePath = STORE_PATH) {
  writeJsonAtomic(filePath, store, { validate: isValidStore })
}

export function briefingQueueLocation() {
  return { store: STORE_PATH }
}

export function readBriefingQueueStore({ filePath = STORE_PATH } = {}) {
  return load(filePath)
}

/* ---------------------------------------------------------------- policy */

/**
 * The owner's stated interruption policy, or null if they have not stated one.
 *
 * Null is a real answer and is returned as one. briefingTriage.js falls back to
 * a documented placeholder default and says in its output that it is running on
 * a guess — a threshold nobody chose should never be reported as though someone
 * had.
 */
export function statedPolicy({ filePath = STORE_PATH } = {}) {
  return load(filePath).policy ?? null
}

export function statePolicy(policy, { filePath = STORE_PATH } = {}) {
  if (!policy || typeof policy !== 'object') {
    throw new Error('An interruption policy must be an object.')
  }
  const store = load(filePath)
  store.policy = {
    ...(store.policy ?? {}),
    ...policy,
    statedAt: new Date().toISOString(),
  }
  save(store, filePath)
  return store.policy
}

/* ------------------------------------------------------------- what was said */

/**
 * Fingerprints the owner has already been told, newest first.
 *
 * `withinMs` exists so a caller can ask the narrower question — "did I say this
 * in the last hour" — which is what run-level dedupe needs, as distinct from
 * "have I ever said this", which is what the novelty gate needs.
 *
 * `excludeRunIds` is the difference between composed and heard, and it is not
 * an optimisation. Composing a brief writes its findings into this ledger; if
 * the owner has not played that brief yet, those findings have reached nobody.
 * Observed end to end: run one said "2 things need you" and went unplayed, run
 * three minutes later found both fingerprints in the ledger, said "nothing
 * needs you right now", and replaced the audio the owner had not heard. The
 * caller passes the runs whose brief is still sitting unplayed, and their
 * fingerprints come back out of the ledger.
 */
export function toldFingerprints({
  filePath = STORE_PATH,
  withinMs = null,
  now = Date.now(),
  excludeRunIds = [],
} = {}) {
  const floor = Number.isFinite(withinMs) ? now - withinMs : null
  const unheard = new Set(excludeRunIds.filter(Boolean))
  const seen = new Map()
  for (const entry of load(filePath).told) {
    if (floor !== null && Date.parse(entry.at) < floor) continue
    if (entry.runId && unheard.has(entry.runId)) continue
    if (!seen.has(entry.fingerprint)) seen.set(entry.fingerprint, entry)
  }
  return seen
}

/**
 * The runs whose brief is still waiting to be played.
 *
 * `playedBriefingIds` is passed in rather than read here because the played
 * flag lives on audioBrief.js's shelf, and this store deliberately does not
 * import that one — the same contract buildEvidenceLedger uses for jobs. A run
 * that produced no audio at all is treated as delivered: it wrote a note the
 * owner can open, and there is no flag that could ever say otherwise.
 */
export function unheardRunIds({ filePath = STORE_PATH, unplayedBriefingIds = [] } = {}) {
  const unplayed = new Set(unplayedBriefingIds.filter(Boolean))
  if (!unplayed.size) return []
  return load(filePath)
    .runs.filter((run) => run.briefingId && unplayed.has(run.briefingId))
    .map((run) => run.id)
}

export function listBriefingRuns({ filePath = STORE_PATH, limit = 10 } = {}) {
  return load(filePath).runs.slice(0, Math.max(1, Number(limit) || 10))
}

export function lastBriefingRun({ filePath = STORE_PATH } = {}) {
  return load(filePath).runs[0] ?? null
}

/* -------------------------------------------------------------- the queue */

/**
 * Everything waiting for the owner, newest first.
 *
 * A queued item whose evidence has been revoked keeps its row and loses its
 * contents, exactly as pageWatch.js's pendingReports does — and for the same
 * reason. Dropping the row would make a revocation look like the finding never
 * happened; showing the detail would make "forget what you read there" mean
 * nothing. Derived on read so no purge has to be remembered.
 */
export function reviewQueue({
  filePath = STORE_PATH,
  now = Date.now(),
  includeResolved = false,
} = {}) {
  return load(filePath)
    .queue.filter((item) => includeResolved || item.status === 'waiting')
    .map((item) => withheldIfRevoked(item, now))
    .sort((left, right) => String(right.openedAt).localeCompare(String(left.openedAt)))
}

function withheldIfRevoked(item, now) {
  const ids = item.provenance?.capsuleIds ?? []
  if (!ids.length) return item
  const { withheld } = usableCapsuleIds(ids, { now })
  if (!withheld.length) return item

  return {
    ...item,
    title: item.title,
    detail: '',
    why: [],
    draft: null,
    summary: `${item.title}: this was found, but the evidence for it is no longer available.`,
    evidenceWithheld: withheld,
  }
}

/**
 * Take an item off the queue.
 *
 * `reviewed` and `dismissed` are both terminal and both the owner's call. There
 * is deliberately no "acted" — nothing in this feature acts, so there is no
 * status for it to report.
 */
export function resolveQueueItem(
  id,
  { status = 'reviewed', filePath = STORE_PATH } = {},
) {
  if (!['reviewed', 'dismissed'].includes(status)) {
    throw new Error(
      `A queued finding can be "reviewed" or "dismissed", not "${status}".`,
    )
  }
  const store = load(filePath)
  const item = store.queue.find((entry) => entry.id === id)
  if (!item) return null
  item.status = status
  item.resolvedAt = new Date().toISOString()
  save(store, filePath)
  return item
}

/* ------------------------------------------------------------- writing a run */

/**
 * Record one briefing: what was said out loud, what was queued, and the run.
 *
 * Queue entries are upserted on fingerprint, not appended. A finding that is
 * still open on the third consecutive morning is one row whose `seenCount`
 * reached three, not three rows — the queue is a list of open things, and a
 * queue that grows by the number of times you looked at it is a queue nobody
 * opens twice.
 */
export function recordBriefingRun(
  { run, told = [], queued = [] },
  { filePath = STORE_PATH } = {},
) {
  const store = load(filePath)
  const at = run?.generatedAt ?? new Date().toISOString()

  for (const finding of told) {
    store.told.unshift({
      fingerprint: finding.fingerprint,
      at,
      runId: run?.id ?? null,
      source: finding.source,
      /* The headline, not the finding. This ledger is read on every run and is
       * never shown to anyone; keeping the body here would make the novelty
       * check a megabyte read and would duplicate data the queue already holds
       * under the owner's own retention. */
      headline: String(finding.title ?? '').slice(0, 120),
    })
  }
  store.told = store.told.slice(0, MAX_TOLD)

  for (const finding of queued) {
    const existing = store.queue.find(
      (entry) => entry.fingerprint === finding.fingerprint,
    )
    if (existing) {
      existing.seenCount = (existing.seenCount ?? 1) + 1
      existing.lastSeenAt = at
      /* A finding whose detail moved is worth refreshing in place: the row is
       * about the open thing, not about the moment it was first noticed. */
      existing.detail = finding.detail ?? existing.detail
      existing.why = finding.why ?? existing.why
      existing.draft = finding.draft ?? existing.draft
      continue
    }
    store.queue.unshift({
      id: `bqi_${crypto.randomUUID()}`,
      fingerprint: finding.fingerprint,
      source: finding.source,
      title: finding.title ?? '',
      detail: finding.detail ?? '',
      why: finding.why ?? [],
      score: finding.score ?? 0,
      at: finding.at ?? null,
      actionableUntil: finding.actionableUntil ?? null,
      provenance: finding.provenance ?? null,
      draft: finding.draft ?? null,
      openedAt: at,
      lastSeenAt: at,
      seenCount: 1,
      status: 'waiting',
      resolvedAt: null,
      /* Said in the row as well as in the prose. A caller reading only JSON
       * should not have to infer that nothing was sent on its behalf. */
      acted: false,
    })
  }
  store.queue = trimQueue(store.queue)

  if (run) {
    store.runs.unshift({
      id: run.id,
      generatedAt: at,
      digest: run.digest,
      told: told.length,
      queued: queued.length,
      suppressed: run.suppressed ?? 0,
      spoken: run.spoken ?? '',
      notePath: run.notePath ?? null,
      briefingId: run.briefingId ?? null,
      policySource: run.policySource ?? 'default',
    })
    store.runs = store.runs.slice(0, MAX_RUNS)
  }

  save(store, filePath)
  return { told: told.length, queued: queued.length }
}

/* Resolved rows are dropped before waiting ones: the cap exists to bound the
 * file, and evicting something the owner has not looked at to keep something
 * they already dismissed is the wrong trade. */
function trimQueue(queue) {
  if (queue.length <= MAX_QUEUE) return queue
  const waiting = queue.filter((item) => item.status === 'waiting')
  const resolved = queue.filter((item) => item.status !== 'waiting')
  return [...waiting, ...resolved].slice(0, MAX_QUEUE)
}
