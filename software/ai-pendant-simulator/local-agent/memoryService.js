import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { classifySensitivity } from './redaction.js'
import { readContextGraph } from './contextGraph.js'

/*
 * One scoped store for everything the model is told about the owner.
 *
 * Before this, three places decided what the model knows: the context graph
 * (every executed Action, forever), projectMemory (a hand-rolled summary), and
 * fleetContext.js (a prompt section hand-written per surface). All three were
 * re-serialized into the prompt on every turn, so the bill grew with the log
 * rather than with what the model actually needed. Nothing could expire,
 * because nothing recorded when a fact stopped being true or stopped being
 * used.
 *
 * A fact here carries the metadata that makes a small prompt possible:
 * provenance (can it be trusted), confidence (how hard to lean on it),
 * sensitivity (does the value belong in an outbound prompt), expiry (when does
 * it stop being true), and lastUsedAt (is anyone reading it). contextProjection
 * .js spends that metadata; this module only keeps it honest.
 *
 * Sensitivity is NOT an access gate — the owner has full access to every fact
 * through the API. It selects what gets pasted into a third-party prompt.
 */

const localAgentDirectory = path.dirname(fileURLToPath(import.meta.url))

export const FACTS_PATH =
  process.env.PENDANT_MEMORY_FACTS_PATH ||
  path.join(localAgentDirectory, 'memory', 'facts.json')

/**
 * The typed vocabulary the projection reasons over. Keep it small: every new
 * kind is a new decision the projection has to make about what to send.
 */
export const FACT_KINDS = Object.freeze([
  'preference', // stable owner choices — cheap, always worth sending
  'permission', // what the owner has standing approval for
  'task', // what is currently being worked on
  'entity', // durable people/files/projects worth naming
  'observation', // something noticed once; the fastest to go stale
])

/* Preferences and permissions define behavior, so idleness never evicts them. */
const PINNED_KINDS = new Set(['preference', 'permission'])

/* How long a fact stays true by default when the writer does not say. */
const DEFAULT_TTL_MS = {
  preference: null,
  permission: null,
  task: 14 * 24 * 60 * 60 * 1000,
  entity: 30 * 24 * 60 * 60 * 1000,
  observation: 7 * 24 * 60 * 60 * 1000,
}

/* Browser jobs read pages that change under us; a day-old scrape is a guess. */
const BROWSER_TTL_MS = 24 * 60 * 60 * 1000

/* A fact nobody has read in this long is not earning its place in the prompt. */
const IDLE_EVICT_MS = 30 * 24 * 60 * 60 * 1000

/* Ceilings, so one runaway writer cannot inflate every future prompt. */
const MAX_FACTS_PER_KIND = 120
const MAX_VALUE_CHARS = 400
const MAX_BROWSER_VALUE_CHARS = 200

const isValidStore = (value) => value && Array.isArray(value.facts)

const emptyStore = () => ({ version: 1, updatedAt: null, facts: [] })

export function memoryLocation({ filePath = FACTS_PATH } = {}) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  return filePath
}

export function readFactStore({ filePath = FACTS_PATH } = {}) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: emptyStore(),
    validate: isValidStore,
  })
}

function writeFactStore(store, filePath) {
  store.updatedAt = new Date().toISOString()
  writeJsonAtomic(filePath, store, { validate: isValidStore })
  return store
}

/**
 * Record a fact, replacing any earlier fact with the same key.
 *
 * Same-key replacement is the contradiction rule: the owner's editor cannot be
 * two things, and keeping both would put both in the prompt. The displaced
 * value survives one step as previousValue so a wrong overwrite is visible.
 */
export function rememberFact(
  {
    key,
    kind = 'observation',
    value,
    surfaces = [],
    source = null,
    confidence = 0.7,
    sensitivity = null,
    expiresAt = undefined,
    ttlMs = undefined,
    now = Date.now(),
  } = {},
  { filePath = FACTS_PATH } = {},
) {
  const factKey = String(key || '').trim()
  if (!factKey) throw new Error('A fact needs a key.')

  const factKind = FACT_KINDS.includes(kind) ? kind : 'observation'
  const text = normalizeValue(value, MAX_VALUE_CHARS)
  if (!text) throw new Error('A fact needs a value.')

  const nowIso = new Date(now).toISOString()
  const store = readFactStore({ filePath })
  const existing = store.facts.find((fact) => fact.key === factKey)

  const fact = {
    id: existing?.id || `fct_${crypto.randomUUID()}`,
    key: factKey,
    kind: factKind,
    value: text,
    surfaces: normalizeSurfaces(surfaces),
    source: normalizeSource(source, nowIso),
    confidence: clampConfidence(confidence),
    // An unspecified sensitivity is inferred rather than assumed safe: most
    // writers are automated and will never think to set it.
    sensitivity: sensitivity || classifySensitivity(text),
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    expiresAt: resolveExpiry({ expiresAt, ttlMs, kind: factKind, now }),
    lastUsedAt: existing?.lastUsedAt || null,
    useCount: existing?.useCount || 0,
    previousValue:
      existing && existing.value !== text ? existing.value : existing?.previousValue || null,
  }

  if (existing) {
    store.facts[store.facts.indexOf(existing)] = fact
  } else {
    store.facts.push(fact)
  }

  writeFactStore(store, filePath)
  return fact
}

/** Explicit "forget this" — by id or by key, so the owner can use either. */
export function forgetFact(idOrKey, { filePath = FACTS_PATH } = {}) {
  const store = readFactStore({ filePath })
  const before = store.facts.length
  store.facts = store.facts.filter(
    (fact) => fact.id !== idOrKey && fact.key !== idOrKey,
  )
  if (store.facts.length === before) return false
  writeFactStore(store, filePath)
  return true
}

export function listFacts(
  { kind = null, surface = null, includeExpired = false, now = Date.now() } = {},
  { filePath = FACTS_PATH } = {},
) {
  return readFactStore({ filePath })
    .facts.filter((fact) => (kind ? fact.kind === kind : true))
    .filter((fact) => (surface ? servesSurface(fact, surface) : true))
    .filter((fact) => (includeExpired ? true : !isExpired(fact, now)))
}

/**
 * Mark facts as actually used.
 *
 * This is the measurement that makes idle pruning meaningful: without it every
 * fact looks equally deserving of prompt space forever. The projection reports
 * which facts it shipped; the caller records it here.
 */
export function touchFacts(
  factIds = [],
  { now = Date.now() } = {},
  { filePath = FACTS_PATH } = {},
) {
  const wanted = new Set(factIds)
  if (!wanted.size) return 0

  const store = readFactStore({ filePath })
  const nowIso = new Date(now).toISOString()
  let touched = 0

  for (const fact of store.facts) {
    if (!wanted.has(fact.id)) continue
    fact.lastUsedAt = nowIso
    fact.useCount = (fact.useCount || 0) + 1
    touched += 1
  }

  if (touched) writeFactStore(store, filePath)
  return touched
}

/**
 * Drop what the owner should stop paying for: facts past their expiry, facts
 * nobody has read in a month, and the tail of any kind that grew past its cap.
 */
export function pruneFacts(
  { now = Date.now(), idleMs = IDLE_EVICT_MS, maxPerKind = MAX_FACTS_PER_KIND } = {},
  { filePath = FACTS_PATH } = {},
) {
  const store = readFactStore({ filePath })
  const removed = []
  const kept = []

  for (const fact of store.facts) {
    if (isExpired(fact, now)) {
      removed.push({ ...fact, reason: 'expired' })
      continue
    }
    if (!PINNED_KINDS.has(fact.kind) && idleSince(fact, now) > idleMs) {
      removed.push({ ...fact, reason: 'idle' })
      continue
    }
    kept.push(fact)
  }

  const byKind = new Map()
  for (const fact of kept) {
    const bucket = byKind.get(fact.kind) || []
    bucket.push(fact)
    byKind.set(fact.kind, bucket)
  }

  const survivors = []
  for (const bucket of byKind.values()) {
    bucket.sort((left, right) => lastTouched(right) - lastTouched(left))
    survivors.push(...bucket.slice(0, maxPerKind))
    for (const fact of bucket.slice(maxPerKind)) {
      removed.push({ ...fact, reason: 'overflow' })
    }
  }

  if (removed.length) {
    store.facts = survivors
    writeFactStore(store, filePath)
  }

  return {
    removed: removed.length,
    kept: survivors.length,
    reasons: removed.reduce((counts, fact) => {
      counts[fact.reason] = (counts[fact.reason] || 0) + 1
      return counts
    }, {}),
  }
}

/**
 * The browser-job memory tier.
 *
 * A browser job's output is a page — thousands of tokens of markup, prose, and
 * screenshots that would poison conversational context if it were merged into
 * it. What survives the job is the normalized claim, where it came from, and
 * when it was read; the page itself is not memory. Values are clipped hard
 * here rather than trusted, because the caller is a scraper.
 */
export function rememberBrowserFindings(
  { jobId = null, url = null, retrievedAt = null, findings = [], now = undefined } = {},
  { filePath = FACTS_PATH } = {},
) {
  // The lease starts when the page was read, not when the job got around to
  // reporting: a finding from a job that ran an hour ago is an hour stale.
  const reported = Date.parse(retrievedAt || '')
  const readAt = now ?? (Number.isFinite(reported) ? reported : Date.now())
  const at = new Date(readAt).toISOString()
  const host = hostOf(url)

  return (Array.isArray(findings) ? findings : [])
    .map((finding) => {
      const value = normalizeValue(finding?.value, MAX_BROWSER_VALUE_CHARS)
      const key = String(finding?.key || '').trim()
      if (!key || !value) return null

      return rememberFact(
        {
          // Namespaced by host so two sites can disagree about the same field
          // without silently overwriting each other.
          key: `web.${host || 'unknown'}.${key}`,
          kind: 'observation',
          value,
          surfaces: finding?.surfaces || [],
          source: { origin: 'browser-job', url, host, jobId, at },
          confidence: finding?.confidence ?? 0.6,
          sensitivity: finding?.sensitivity || null,
          ttlMs: finding?.ttlMs ?? BROWSER_TTL_MS,
          now: readAt,
        },
        { filePath },
      )
    })
    .filter(Boolean)
}

const GRAPH_NOISE_TYPES = new Set(['Action', 'Tool', 'Device', 'Model'])

const GRAPH_KIND_BY_TYPE = {
  Person: 'entity',
  Project: 'entity',
  File: 'entity',
  Resource: 'entity',
  EmailDraft: 'observation',
  Note: 'observation',
  Task: 'task',
}

/**
 * Adopt what the knowledge graph already knows, once.
 *
 * The graph stays as it is — it is the raw event log, and it is good at that.
 * What it is bad at is being a prompt: 84 of the 108 entities on this machine
 * are Action/Tool telemetry that no prompt should ever carry. This lifts only
 * the durable types across, keyed by entity id so re-running is a no-op.
 */
export function syncFactsFromContextGraph({ now = Date.now() } = {}, { filePath = FACTS_PATH } = {}) {
  const graph = readContextGraph()
  const imported = []

  for (const entity of graph.entities) {
    if (GRAPH_NOISE_TYPES.has(entity.type)) continue
    const kind = GRAPH_KIND_BY_TYPE[entity.type]
    if (!kind) continue

    const detail =
      entity.attributes?.note ||
      entity.attributes?.subject ||
      entity.attributes?.path ||
      entity.attributes?.due ||
      ''

    imported.push(
      rememberFact(
        {
          key: `graph.${entity.id}`,
          kind,
          value: `${entity.type}: ${entity.name}${detail ? ` — ${detail}` : ''}`,
          source: {
            origin: 'context-graph',
            entityId: entity.id,
            at: entity.updatedAt || entity.createdAt || null,
          },
          confidence: Number(entity.attributes?.importance) || 0.6,
          // Age the import from when the graph last saw it, not from now, so a
          // year-old entity does not get a fresh 30-day lease on the prompt.
          ttlMs: DEFAULT_TTL_MS[kind],
          now: Date.parse(entity.updatedAt || entity.createdAt || '') || now,
        },
        { filePath },
      ),
    )
  }

  return imported
}

export function resetFacts({ filePath = FACTS_PATH } = {}) {
  return writeFactStore(emptyStore(), filePath)
}

export function isExpired(fact, now = Date.now()) {
  if (!fact?.expiresAt) return false
  const at = Date.parse(fact.expiresAt)
  return Number.isFinite(at) && at <= now
}

export function servesSurface(fact, surface) {
  if (!surface) return true
  const surfaces = Array.isArray(fact?.surfaces) ? fact.surfaces : []
  return surfaces.length === 0 || surfaces.includes(surface)
}

function idleSince(fact, now) {
  return now - lastTouched(fact)
}

function lastTouched(fact) {
  return (
    Date.parse(fact.lastUsedAt || '') ||
    Date.parse(fact.updatedAt || '') ||
    Date.parse(fact.createdAt || '') ||
    0
  )
}

function resolveExpiry({ expiresAt, ttlMs, kind, now }) {
  if (expiresAt !== undefined) return expiresAt
  const ttl = ttlMs === undefined ? DEFAULT_TTL_MS[kind] : ttlMs
  if (!ttl) return null
  return new Date(now + ttl).toISOString()
}

function normalizeValue(value, maxChars) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

function normalizeSurfaces(surfaces) {
  if (!Array.isArray(surfaces)) return []
  return [...new Set(surfaces.map((name) => String(name || '').trim()).filter(Boolean))]
}

function normalizeSource(source, nowIso) {
  if (!source || typeof source !== 'object') {
    return { origin: String(source || 'local'), at: nowIso }
  }
  return {
    origin: String(source.origin || 'local'),
    url: source.url || null,
    host: source.host || hostOf(source.url),
    jobId: source.jobId || null,
    entityId: source.entityId || null,
    at: source.at || nowIso,
  }
}

function clampConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0.7
  return Math.min(1, Math.max(0, number))
}

function hostOf(url) {
  if (!url) return null
  try {
    return new URL(String(url)).host.replace(/^www\./, '')
  } catch {
    return null
  }
}
