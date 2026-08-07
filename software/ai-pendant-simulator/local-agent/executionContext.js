import crypto from 'node:crypto'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'

/*
 * WHAT A JOB ALREADY DID, written down before it does it.
 *
 * The problem this exists for: the Mac agent writes real files into the
 * owner's workspace, and some of those jobs run unattended. A crash, a relay
 * reconnect, or an ordinary retry can hand the same plan to the agent twice.
 * With no durable record of identity, the second delivery is indistinguishable
 * from the first, and the agent redoes side effects nobody asked for twice.
 *
 * THE ONE IDEA HERE: identity is the pair (jobId, intentHash), not the jobId.
 *
 *     same jobId, same intentHash  -> the SAME event, delivered again. A retry.
 *                                     Whatever it already committed stands.
 *     same jobId, different hash   -> a DIFFERENT event that happens to reuse
 *                                     the id. A re-run. It must actually run.
 *
 * The store is therefore keyed by `contextId = <jobId>:<first 12 of hash>`, so
 * the two cases cannot collide by construction rather than by a comparison
 * somebody has to remember to write. A re-run's context records `supersedes`
 * pointing at the context it replaced, so the chain stays readable.
 *
 * THIS IS NOT A SECOND JOB ID SCHEME. jobTracker.js mints `local_<uuid>` and
 * actionLedger.js records ledgers against those ids; both remain the identity
 * of a run. This module accepts whatever jobId it is given and only adds the
 * intent dimension on top. `stampPlan` with no jobId mints one in the same
 * `local_` shape so a plan that arrives without tracking is not a special case
 * downstream.
 *
 * IT RUNS NOTHING. Opening a context, recording an event, adopting a handoff:
 * all of it is bookkeeping. workbenchTransaction.js is the module that touches
 * the workspace, and it asks this one for permission first.
 */

export const EXECUTION_CONTEXT_VERSION = 1

/*
 * Bounded by bytes as well as by count, for the reason actionLedger.js
 * documents: a count-capped store in this project already reached 129 MB
 * because one field was whatever the orchestrator happened to return. Every
 * transition here rewrites and fsyncs the whole file, so the budget is a
 * latency budget too.
 */
export const MAX_CONTEXTS = 240
export const MAX_STORE_BYTES = 256 * 1024

/* Enough events to see "opened, staged, committed, retried once". Not a log. */
const MAX_EVENTS_PER_CONTEXT = 12
const MAX_REFERENCES = 32
const MAX_REFERENCE_CHARS = 512
const MAX_INTENT_DEPTH = 8

const isValidStore = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  Array.isArray(value.contexts) &&
  Number.isFinite(value.sequence)

export function contextLocation(basePath = workspacePath) {
  if (basePath === workspacePath && process.env.PENDANT_WORKBENCH_PATH) {
    return process.env.PENDANT_WORKBENCH_PATH
  }
  return path.join(basePath, '.pendant-execution-context.json')
}

/*
 * The intent hash.
 *
 * Canonical JSON — keys sorted at every level, `undefined` dropped, Dates as
 * ISO — so that two structurally identical intents hash the same regardless of
 * how the caller happened to build the object. A cycle or a pathologically
 * deep structure throws rather than silently hashing a truncation, because a
 * hash that quietly loses part of the intent is worse than no hash: it makes
 * two different jobs look like one retry.
 *
 * `destinations` folds the declared output paths in. Forgetting to put the
 * target path in `intent` is the obvious footgun — the same briefing written
 * to a different file is not the same event — and folding it in costs nothing.
 */
export function intentHashFor(intent, { destinations = [] } = {}) {
  if (intent === undefined || intent === null) {
    throw new TypeError('An execution context needs a declared intent to hash.')
  }

  const payload = {
    intent: canonicalize(intent, 0, new Set()),
    destinations: [...new Set(destinations.map((entry) => String(entry)))].sort(),
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
}

export function contextIdFor(jobId, intentHash) {
  return `${jobId}:${String(intentHash).slice(0, 12)}`
}

/**
 * Stamp a plan with the identity it will be resumed by. Pure: no disk, no
 * clock beyond `now`, safe to call on the relay side before anything exists.
 */
export function stampPlan({
  jobId = null,
  parentId = null,
  intent,
  destinations = [],
  references = [],
  rootId = null,
  now = new Date(),
} = {}) {
  const intentHash = intentHashFor(intent, { destinations })
  const resolvedJobId = normalizeId(jobId) || `local_${crypto.randomUUID()}`
  const resolvedParent = normalizeId(parentId)

  return {
    jobId: resolvedJobId,
    contextId: contextIdFor(resolvedJobId, intentHash),
    parentId: resolvedParent,
    /* The top of the chain, so ancestry is one field read instead of a walk
     * through contexts that may already have been pruned. */
    rootId: normalizeId(rootId) || resolvedParent || resolvedJobId,
    intentHash,
    intent: summarizeIntent(intent),
    destinations: [...new Set(destinations.map(String))].sort(),
    references: normalizeReferences(references),
    stampedAt: toIso(now),
  }
}

/**
 * Open (or recognise) the durable context for a stamped plan.
 *
 * decision:
 *   'fresh'      nothing on disk for this (jobId, intentHash). Do the work.
 *   'retry'      a context exists but never committed. Do the work again;
 *                whatever it left behind was never declared complete.
 *   'completed'  this exact event already committed. The caller must not redo
 *                side effects — only verify that its outputs are still there.
 *   'rerun'      the jobId is known but the intent changed. A different event
 *                reusing an id. A new context is opened and `supersedes` names
 *                the one it replaced.
 */
export function openContext(descriptor, { filePath = contextLocation(), now = new Date() } = {}) {
  const store = load(filePath)
  const stampedAt = toIso(now)
  const existing = store.contexts.find((entry) => entry.contextId === descriptor.contextId)

  if (existing) {
    const decision = existing.status === 'committed' ? 'completed' : 'retry'
    if (decision === 'retry') {
      existing.attempts = (existing.attempts ?? 0) + 1
      existing.updatedAt = stampedAt
      existing.lastSequence = ++store.sequence
      existing.references = mergeReferences(existing.references, descriptor.references)
      pushEvent(existing, { sequence: existing.lastSequence, at: stampedAt, status: 'reopened' })
      save(store, filePath)
    }
    return { decision, context: clone(existing) }
  }

  const superseded = store.contexts
    .filter((entry) => entry.jobId === descriptor.jobId)
    .sort((left, right) => (right.lastSequence ?? 0) - (left.lastSequence ?? 0))[0]

  const sequence = ++store.sequence
  const context = {
    contextId: descriptor.contextId,
    jobId: descriptor.jobId,
    parentId: descriptor.parentId ?? null,
    rootId: descriptor.rootId ?? descriptor.jobId,
    intentHash: descriptor.intentHash,
    intent: descriptor.intent ?? null,
    sequence,
    lastSequence: sequence,
    /* A foreign body's counter, kept beside ours rather than merged into it.
     * Two counters advancing independently do not make one clock, and pretending
     * they do would let a relay-supplied number rewind local ordering. */
    remoteSequence: null,
    status: 'open',
    attempts: 1,
    supersedes: superseded ? superseded.contextId : null,
    references: normalizeReferences(descriptor.references),
    outputs: [],
    staging: null,
    openedAt: stampedAt,
    updatedAt: stampedAt,
    committedAt: null,
    events: [],
  }
  pushEvent(context, { sequence, at: stampedAt, status: 'open' })
  store.contexts.push(context)
  save(store, filePath)

  return { decision: superseded ? 'rerun' : 'fresh', context: clone(context) }
}

/**
 * Advance a context's durable state. The sequence is store-wide and strictly
 * increasing, so "which of these two records is later" never depends on a
 * wall clock that can move backwards.
 */
export function recordEvent(
  contextId,
  { status = null, outputs = null, staging = undefined, references = null, note = null } = {},
  { filePath = contextLocation(), now = new Date() } = {},
) {
  const store = load(filePath)
  const context = store.contexts.find((entry) => entry.contextId === contextId)
  if (!context) return null

  const at = toIso(now)
  context.lastSequence = ++store.sequence
  context.updatedAt = at
  if (status) context.status = status
  if (status === 'committed') context.committedAt = at
  if (outputs) context.outputs = outputs.slice(0, 64)
  if (staging !== undefined) context.staging = staging
  if (references) context.references = mergeReferences(context.references, references)
  pushEvent(context, { sequence: context.lastSequence, at, status: status ?? 'note', note })

  save(store, filePath)
  return clone(context)
}

export function getContext(contextId, { filePath = contextLocation() } = {}) {
  const store = load(filePath)
  return clone(store.contexts.find((entry) => entry.contextId === contextId) ?? null)
}

export function listContexts({ filePath = contextLocation(), limit = 50, jobId = null } = {}) {
  const store = load(filePath)
  return store.contexts
    .filter((entry) => (jobId ? entry.jobId === jobId : true))
    .sort((left, right) => (right.lastSequence ?? 0) - (left.lastSequence ?? 0))
    .slice(0, Math.max(1, limit))
    .map(clone)
}

/**
 * What a job resumed after a restart needs in front of it: every context that
 * has ever run under this jobId, newest first, with what each one committed.
 *
 * `outstanding` is the honest part. A context left in `staging` is one that
 * was interrupted between "files written" and "files in place"; the outputs it
 * names may or may not have landed, and the caller should re-run rather than
 * assume either way. Absence of a committed record never means "it did not
 * happen" — it means "nobody ever declared that it did".
 */
export function handoffFor(jobId, { filePath = contextLocation() } = {}) {
  const contexts = listContexts({ filePath, jobId, limit: MAX_CONTEXTS })
  if (!contexts.length) return { jobId, known: false, contexts: [], outstanding: [], references: [] }

  const references = []
  for (const context of contexts) {
    for (const reference of context.references ?? []) references.push(reference)
  }

  return {
    jobId,
    known: true,
    latestSequence: contexts[0].lastSequence ?? null,
    contexts: contexts.map((context) => ({
      contextId: context.contextId,
      intentHash: context.intentHash,
      parentId: context.parentId,
      rootId: context.rootId,
      sequence: context.sequence,
      lastSequence: context.lastSequence,
      status: context.status,
      attempts: context.attempts,
      supersedes: context.supersedes,
      committedAt: context.committedAt,
      outputs: (context.outputs ?? []).map((output) => output.path),
    })),
    outstanding: contexts
      .filter((context) => context.status === 'staging' || context.status === 'failed')
      .map((context) => ({
        contextId: context.contextId,
        status: context.status,
        reason:
          context.status === 'staging'
            ? 'interrupted between write and rename; re-run rather than assume'
            : 'the last attempt failed; nothing was declared complete',
      })),
    references: dedupeReferences(references),
  }
}

/**
 * Take a context envelope produced by another body (a relay plan resumed on
 * this Mac, or the reverse) into the local store.
 *
 * A foreign envelope may not lower a local status: if this Mac committed the
 * work, a relay copy that still says `open` is stale, not authoritative. The
 * only thing it can do is add references and record its own sequence.
 */
export function adoptHandoff(envelope, { filePath = contextLocation(), now = new Date() } = {}) {
  if (!envelope || typeof envelope !== 'object') {
    return { adopted: false, reason: 'not_an_envelope' }
  }
  const contextId = normalizeId(envelope.contextId)
  const jobId = normalizeId(envelope.jobId)
  const intentHash = normalizeId(envelope.intentHash)
  if (!contextId || !jobId || !intentHash) {
    return { adopted: false, reason: 'missing_identity' }
  }
  if (contextIdFor(jobId, intentHash) !== contextId) {
    return { adopted: false, reason: 'identity_mismatch' }
  }

  const store = load(filePath)
  const at = toIso(now)
  const existing = store.contexts.find((entry) => entry.contextId === contextId)

  if (existing) {
    existing.remoteSequence = Number.isFinite(envelope.sequence)
      ? Math.max(existing.remoteSequence ?? 0, envelope.sequence)
      : existing.remoteSequence
    existing.references = mergeReferences(existing.references, envelope.references)
    existing.lastSequence = ++store.sequence
    existing.updatedAt = at
    pushEvent(existing, {
      sequence: existing.lastSequence,
      at,
      status: 'adopted',
      note: `remote status ${String(envelope.status ?? 'unknown')}`,
    })
    save(store, filePath)
    return { adopted: true, merged: true, statusKept: existing.status, context: clone(existing) }
  }

  const sequence = ++store.sequence
  const context = {
    contextId,
    jobId,
    parentId: normalizeId(envelope.parentId),
    rootId: normalizeId(envelope.rootId) || jobId,
    intentHash,
    intent: envelope.intent ? summarizeIntent(envelope.intent) : null,
    sequence,
    lastSequence: sequence,
    remoteSequence: Number.isFinite(envelope.sequence) ? envelope.sequence : null,
    /* Adopted, not observed. A foreign 'committed' describes a filesystem this
     * process cannot see, so it is recorded as its own status rather than
     * allowed to satisfy an idempotency check against local paths. */
    status: 'adopted',
    remoteStatus: String(envelope.status ?? 'unknown'),
    attempts: 0,
    supersedes: null,
    references: normalizeReferences(envelope.references),
    outputs: [],
    staging: null,
    openedAt: at,
    updatedAt: at,
    committedAt: null,
    events: [],
  }
  pushEvent(context, { sequence, at, status: 'adopted' })
  store.contexts.push(context)
  save(store, filePath)
  return { adopted: true, merged: false, context: clone(context) }
}

/** Test and operator escape hatch. Never called from a request path. */
export function clearContexts({ filePath = contextLocation() } = {}) {
  writeJsonAtomic(filePath, emptyStore(), { validate: isValidStore })
}

function emptyStore() {
  return {
    version: EXECUTION_CONTEXT_VERSION,
    sequence: 0,
    droppedContexts: 0,
    contexts: [],
  }
}

function load(filePath) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  return readJsonWithRecovery(filePath, { fallback: emptyStore(), validate: isValidStore })
}

function save(store, filePath) {
  const pruned = prune(store.contexts)
  writeJsonAtomic(
    filePath,
    {
      ...store,
      version: EXECUTION_CONTEXT_VERSION,
      contexts: pruned.contexts,
      droppedContexts: (store.droppedContexts ?? 0) + pruned.dropped,
    },
    { validate: isValidStore },
  )
}

/*
 * Pruning drops the oldest SETTLED contexts first. A context still in
 * `staging` is the only kind whose loss actually costs something — it is the
 * record that says "an interrupted write may have half-landed" — so it is kept
 * until nothing else can be shed, and only then dropped to keep the store
 * inside its byte budget.
 */
function prune(contexts) {
  const byRecency = [...contexts].sort(
    (left, right) => (right.lastSequence ?? 0) - (left.lastSequence ?? 0),
  )
  let kept = byRecency.slice(0, MAX_CONTEXTS)
  let dropped = byRecency.length - kept.length

  while (kept.length > 1 && jsonBytes(kept) > MAX_STORE_BYTES) {
    const settledIndex = findLastIndex(kept, (entry) => entry.status !== 'staging')
    const index = settledIndex >= 0 ? settledIndex : kept.length - 1
    kept.splice(index, 1)
    dropped += 1
  }

  return { contexts: kept, dropped }
}

function findLastIndex(list, predicate) {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) return index
  }
  return -1
}

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function pushEvent(context, event) {
  context.events = [...(context.events ?? []), event].slice(-MAX_EVENTS_PER_CONTEXT)
}

function normalizeId(value) {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, 200) : null
}

function normalizeReferences(references) {
  if (!Array.isArray(references)) return []
  return dedupeReferences(
    references
      .map((reference) => {
        if (typeof reference === 'string') {
          return { kind: 'ref', id: reference.slice(0, MAX_REFERENCE_CHARS) }
        }
        if (!reference || typeof reference !== 'object') return null
        const id = String(reference.id ?? reference.path ?? '').slice(0, MAX_REFERENCE_CHARS)
        if (!id) return null
        return { kind: String(reference.kind ?? 'ref').slice(0, 40), id }
      })
      .filter(Boolean),
  )
}

function mergeReferences(current, incoming) {
  return dedupeReferences([...(current ?? []), ...normalizeReferences(incoming)])
}

function dedupeReferences(references) {
  const seen = new Set()
  const out = []
  for (const reference of references) {
    const key = `${reference.kind} ${reference.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(reference)
    if (out.length >= MAX_REFERENCES) break
  }
  return out
}

/*
 * The stored intent is a label, not the intent. The HASH is computed over the
 * whole thing; only this shrunken version is persisted, because the store is
 * on the fsync path of every job and a plan's full parameters do not belong
 * there. Losing the detail costs nothing: identity lives in the hash.
 */
function summarizeIntent(intent) {
  if (intent === null || typeof intent !== 'object') {
    return { kind: null, label: String(intent).slice(0, 120) }
  }
  return {
    kind: intent.kind ? String(intent.kind).slice(0, 80) : null,
    label: intent.label ? String(intent.label).slice(0, 120) : null,
  }
}

function canonicalize(value, depth, seen) {
  if (depth > MAX_INTENT_DEPTH) {
    throw new RangeError('Intent is too deeply nested to hash honestly.')
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? `${value}n` : value
  }
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) {
    throw new TypeError('Intent contains a cycle and cannot be hashed.')
  }

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalize(entry, depth + 1, seen))
    }
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const canonical = canonicalize(value[key], depth + 1, seen)
      if (canonical !== undefined) out[key] = canonical
    }
    return out
  } finally {
    seen.delete(value)
  }
}

function toIso(now) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString()
}

function clone(value) {
  return value === null ? null : structuredClone(value)
}
