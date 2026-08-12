/*
 * Domain memory: the fact store logic every body shares.
 *
 * A domain fact is small, named, and owned by a capability domain:
 *
 *   { key: 'dom.email.account.school', domain: 'email', name: 'account.school',
 *     value: 'liu@uni.edu', scope: 'hive' | 'node', node: 'mac', confidence,
 *     at, expiresAt, sensitivity }
 *
 * SCOPE IS THE ROUTING DECISION, in the owner's words: 'hive' is "shared
 * through the relay so every node's brain can fetch it"; 'node' "stays local
 * to the capturing node". Hive facts ride the EXISTING fleet-state channel —
 * a `domainMemory` block inside the FLEET_STATE_KEY document — rather than a
 * new transport. The relay merges on write (mergeDomainMemory) so the Mac's
 * heartbeat PUT cannot clobber facts the voice loop saved, and the merged
 * block flows back to the Mac in the PUT response.
 *
 * Node facts never appear in this module's hive block at all: normalizeHive
 * refuses them, because a fact that "stays local" leaking through the shared
 * channel is the failure that would be hardest to notice and worst to have.
 *
 * Pure and workerd-safe: no filesystem, no clock of its own beyond Date.now
 * defaults, importable by all three brains.
 */
import { classifySensitivity, maskSecretValue } from '../local-agent/redaction.js'
import { MEMORY_DOMAINS } from './domains/index.js'

export const DOMAIN_FACT_SCOPES = Object.freeze(['hive', 'node'])

/** Field inside the fleet-state document that carries the hive block. */
export const DOMAIN_MEMORY_FIELD = 'domainMemory'

/* Byte ceilings, matching the house rule that budgets are bytes, not rows. */
export const MAX_DOMAIN_FACT_BYTES = 512
export const MAX_DOMAIN_MEMORY_BYTES = 32 * 1024

/* Connections and task shapes rot; identities and defaults do not. */
const DAY_MS = 24 * 60 * 60 * 1000
export const DOMAIN_FACT_TTL_MS = Object.freeze({
  /* account.*, list.*, service.*, language.*, *.default — standing identity */
  identity: null,
  /* contact.*, site.*, place.* — connections, refreshed by reuse */
  connection: 90 * DAY_MS,
  /* task.* — repeated task shapes */
  task: 45 * DAY_MS,
})

const NAME_CLASS_RULES = [
  { prefix: 'task.', klass: 'task' },
  { prefix: 'contact.', klass: 'connection' },
  { prefix: 'site.', klass: 'connection' },
  { prefix: 'place.', klass: 'connection' },
]

export function domainFactClass(name) {
  const factName = String(name ?? '')
  for (const rule of NAME_CLASS_RULES) {
    if (factName.startsWith(rule.prefix)) return rule.klass
  }
  return 'identity'
}

export function domainFactKey(domain, name) {
  return `dom.${domain}.${name}`
}

export function parseDomainFactKey(key) {
  const match = /^dom\.([a-z][a-z0-9-]*)\.(.+)$/.exec(String(key ?? ''))
  if (!match) return null
  return { domain: match[1], name: match[2] }
}

/**
 * Normalize one fact. Throws on anything a writer got structurally wrong —
 * an unknown domain, a missing name or value — because domain facts are
 * written by heuristics and models, and a silently-dropped write hides the
 * bug for weeks (same argument as fleet memory made, kept).
 */
export function normalizeDomainFact(
  {
    domain,
    name,
    value,
    scope = 'hive',
    node = 'unknown',
    confidence = 0.8,
    sensitivity = null,
    at = undefined,
    expiresAt = undefined,
  } = {},
  { now = Date.now() } = {},
) {
  const domainName = String(domain ?? '').trim().toLowerCase()
  if (!MEMORY_DOMAINS.includes(domainName)) {
    throw new TypeError(
      `domain must be one of ${MEMORY_DOMAINS.join(', ')} (got ${JSON.stringify(domain)}).`,
    )
  }

  const factName = slugName(name)
  if (!factName) throw new TypeError('A domain fact needs a dotted name.')

  const text = collapse(value)
  if (!text) throw new TypeError('A domain fact needs a value.')

  const factScope = String(scope ?? 'hive').trim().toLowerCase()
  if (!DOMAIN_FACT_SCOPES.includes(factScope)) {
    throw new TypeError(`scope must be 'hive' or 'node' (got ${JSON.stringify(scope)}).`)
  }

  const stamp = Number.isFinite(Date.parse(at || '')) ? Date.parse(at) : now
  const klass = domainFactClass(factName)
  const ttl = DOMAIN_FACT_TTL_MS[klass]

  const fact = {
    key: domainFactKey(domainName, factName),
    domain: domainName,
    name: factName,
    value: text.slice(0, MAX_DOMAIN_FACT_BYTES),
    scope: factScope,
    node: String(node ?? 'unknown').trim().slice(0, 60) || 'unknown',
    confidence: clampConfidence(confidence),
    sensitivity: sensitivity || classifySensitivity(text),
    at: new Date(stamp).toISOString(),
    expiresAt:
      expiresAt !== undefined
        ? expiresAt
        : ttl
          ? new Date(stamp + ttl).toISOString()
          : null,
  }
  return fact
}

export function isDomainFactExpired(fact, now = Date.now()) {
  if (!fact?.expiresAt) return false
  const at = Date.parse(fact.expiresAt)
  return Number.isFinite(at) && at <= now
}

/** Newest write per key wins; expired facts drop. Deterministic tiebreak. */
export function foldDomainFacts(facts, { now = Date.now() } = {}) {
  const winners = new Map()
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact?.key) continue
    const current = winners.get(fact.key)
    if (!current || isNewer(fact, current)) winners.set(fact.key, fact)
  }
  return [...winners.values()].filter((fact) => !isDomainFactExpired(fact, now))
}

function isNewer(candidate, current) {
  const left = Date.parse(candidate.at || '') || 0
  const right = Date.parse(current.at || '') || 0
  if (left !== right) return left > right
  return String(candidate.value) > String(current.value)
}

/* ---- the hive block (fleet-state channel) -------------------------------- */

/** The domainMemory block as stored inside fleet state. */
export function normalizeDomainMemoryBlock(raw, { now = Date.now() } = {}) {
  const data = raw && typeof raw === 'object' ? raw : {}
  const facts = []
  for (const entry of Array.isArray(data.facts) ? data.facts : []) {
    try {
      const fact = normalizeDomainFact(entry, { now })
      /* Hive block holds hive facts ONLY. A node fact arriving here is a
       * writer bug; refusing it is what keeps 'stays local' true. */
      if (fact.scope !== 'hive') continue
      facts.push(fact)
    } catch {
      continue
    }
  }
  return {
    version: 1,
    updatedAt: data.updatedAt || null,
    facts: foldDomainFacts(facts, { now }),
  }
}

/**
 * Merge incoming hive facts into the stored block: union by key, newest wins,
 * byte-bounded oldest-first eviction. This runs on the relay for BOTH writers
 * — the Mac's heartbeat PUT and the voice loop's memory_save — which is what
 * makes the fleet-state channel safe for two bodies that never coordinate.
 */
export function mergeDomainMemory(currentBlock, incomingFacts, { now = Date.now() } = {}) {
  const current = normalizeDomainMemoryBlock(currentBlock, { now })
  const incoming = []
  const rejected = []

  for (const [index, entry] of (Array.isArray(incomingFacts) ? incomingFacts : []).entries()) {
    try {
      const fact = normalizeDomainFact(entry, { now })
      if (fact.scope !== 'hive') {
        rejected.push({ index, reason: "node-scoped facts do not ride the hive block" })
        continue
      }
      incoming.push(fact)
    } catch (error) {
      rejected.push({ index, reason: error?.message || 'invalid fact' })
    }
  }

  let folded = foldDomainFacts([...current.facts, ...incoming], { now })

  /* Byte ceiling: identities are the standing choices, so they evict LAST;
   * within a class, oldest goes first. */
  folded.sort(compareByValueDesc)
  const kept = []
  let bytes = 0
  let dropped = 0
  for (const fact of folded) {
    const cost = jsonBytes(fact)
    if (bytes + cost > MAX_DOMAIN_MEMORY_BYTES) {
      dropped += 1
      continue
    }
    bytes += cost
    kept.push(fact)
  }

  return {
    block: {
      version: 1,
      updatedAt: new Date(now).toISOString(),
      facts: kept,
    },
    stats: {
      accepted: incoming.length,
      rejected,
      kept: kept.length,
      bytes,
      dropped,
    },
  }
}

const CLASS_RANK = { identity: 0, connection: 1, task: 2 }

function compareByValueDesc(left, right) {
  const rank =
    (CLASS_RANK[domainFactClass(left?.name)] ?? 3) -
    (CLASS_RANK[domainFactClass(right?.name)] ?? 3)
  if (rank !== 0) return rank
  return (Date.parse(right?.at || '') || 0) - (Date.parse(left?.at || '') || 0)
}

/* ---- lookup and rendering ------------------------------------------------ */

/**
 * The read every brain performs when a domain's tool is selected: this
 * domain's facts, best-matching first, bounded. `domain: null` searches all
 * domains — that is what memory_lookup with a query but a wrong domain still
 * needs to degrade into being useful.
 */
export function lookupDomainFacts(
  facts,
  { domain = null, query = '', limit = 8, now = Date.now() } = {},
) {
  const wanted = tokenize(query)
  const domainName = domain ? String(domain).trim().toLowerCase() : null

  return foldDomainFacts(facts, { now })
    .filter((fact) => (domainName ? fact.domain === domainName : true))
    .map((fact) => {
      const haystack = normalizeText(`${fact.name} ${fact.value}`)
      let overlap = 0
      for (const token of wanted) {
        if (haystack.includes(token)) overlap += 1
      }
      return { fact, overlap }
    })
    /* Matches first, then the domain's standing facts as fill: a lookup with a
     * query that matches nothing should still return the domain's accounts and
     * defaults rather than an empty hand. */
    .sort(
      (left, right) =>
        right.overlap - left.overlap ||
        right.fact.confidence - left.fact.confidence ||
        left.fact.key.localeCompare(right.fact.key),
    )
    .slice(0, Math.max(1, limit))
    .map(({ fact }) => fact)
}

/**
 * Render facts for a tool result or planning block. Secrets are masked here —
 * the one reader that should ever see a secret in full is the owner, and no
 * brain is the owner.
 */
export function renderDomainFactLines(facts, { revealSensitive = false } = {}) {
  return (Array.isArray(facts) ? facts : []).map((fact) => {
    const value =
      fact.sensitivity === 'secret' && !revealSensitive
        ? maskSecretValue(fact.value)
        : fact.value
    return `- ${fact.domain}/${fact.name}: ${value}`
  })
}

/* ---- helpers ------------------------------------------------------------- */

function slugName(name) {
  return String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}.\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
}

function clampConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0.8
  return Math.min(1, Math.max(0, number))
}

function collapse(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(text) {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((token) => token.length > 1),
  )
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* TextEncoder rather than Buffer: this module is imported by the browser
 * extension's brain, and Buffer exists on Node and workerd but not in a page. */
const encoder = new TextEncoder()

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 0 : encoder.encode(serialized).length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}
