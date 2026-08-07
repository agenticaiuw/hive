/*
 * Cross-surface memory: every body appends typed events, each surface reads a
 * projection of only what it needs.
 *
 * What this replaces. Today exactly one body on the fleet can write memory:
 * the Mac. `grep -rl rememberFact` finds local-agent/server.js,
 * local-agent/quickCapture.js and memoryService.js itself — nothing in
 * cloud-relay, nothing in browser-extension, nothing in src (iOS). So the relay
 * holds the voice conversation, learns that the owner is in Seoul this week,
 * and has nowhere to put it; the browser extension watches a page change and
 * has nowhere to put it. The one thing that does cross is a block of
 * already-rendered prompt text the Mac PUTs into fleet state as `memory.text`,
 * which the relay pastes in whole. That is a one-way pipe from one node, and it
 * arrives pre-rendered, so the relay cannot re-scope it to what was actually
 * asked.
 *
 * Why a log rather than a shared mutable document. The nodes are not awake at
 * the same time — that is the premise of the whole product, and it is why
 * contextHandoff.js exists. A document needs a writer that can read the current
 * value first; an append does not. Two bodies that never overlap can both write
 * a log, and the fold below decides what the current value is at read time.
 *
 * It is a COMPACTED log, not an audit log. The pruner keeps one live event per
 * (type, key) and drops the rest. The audit trail already exists on the Mac —
 * local-agent/memory/context_graph.json, 421 entities of which 409 are Action
 * and Tool telemetry — and that file is the standing demonstration that an
 * append-only history and a prompt are different artifacts. This is the prompt
 * side. Nothing here is a system of record.
 *
 * Relationship to local-agent/memoryService.js: that is the Mac's own on-disk
 * fact store, and it stays. This is the wire between bodies. The type
 * vocabulary is deliberately a subset of that file's FACT_KINDS — anything a
 * node cannot express to another node has no business on the wire.
 */
import crypto from 'node:crypto'

import { classifySensitivity, maskSecretValue } from '../local-agent/redaction.js'

export const FLEET_MEMORY_VERSION = 1

/*
 * The typed vocabulary, in the order that decides who survives byte pressure.
 * A preference is what the owner chose and is cheap and near-permanent; an
 * event is one body's claim about a moment and is the first thing that stops
 * being worth prompt space.
 */
export const MEMORY_EVENT_TYPES = Object.freeze([
  'preference', // stable owner choices — behaviour, not news
  'task', // what is being worked on right now
  'entity', // durable people/files/projects worth naming across bodies
  'event', // something one body observed happen
])

/*
 * Bodies a memory event can be scoped to. An empty scope means every body.
 *
 * The same four as SURFACES in local-agent/contextProjection.js, and they must
 * stay the same four: a fact scoped on one side and unknown on the other
 * reaches nobody. The pendant is deliberately absent — it is a writer and a
 * microphone, not a body that reads a prompt.
 */
export const MEMORY_SURFACES = Object.freeze(['voice', 'mac', 'browser', 'ios'])

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/*
 * How long each type stays true when the writer does not say.
 *
 * preference/task/entity match local-agent/memoryService.js so a fact does not
 * change its lifetime by crossing a body — a fact that expires on Tuesday on
 * the Mac and next month on the relay is a fact nobody can reason about.
 *
 * `event` is the one with no local twin. Six hours: longer than
 * CONTEXT_TTL_MS (2 h in contextHandoff.js), because that TTL bounds a
 * description of live machine state — which apps and tabs are open — and an
 * event is a claim about the world ("the printer was out of paper") that does
 * not rot as fast. Short enough that yesterday's events are never in this
 * morning's prompt, which is the failure the Mac's context graph shows when it
 * is read directly: 381 Action entities, all of them true, none of them worth
 * a token today.
 */
export const MEMORY_TTL_MS = Object.freeze({
  preference: null,
  task: 14 * DAY_MS,
  entity: 30 * DAY_MS,
  event: 6 * HOUR_MS,
})

/*
 * Byte budgets, never item counts — a store on this project was once wedged by
 * a cap that counted rows while the rows grew.
 *
 * MAX_EVENT_BYTES: the 19 facts in the Mac's live store measure 511 bytes at
 * the median and 566 at the largest, with a 400-character value cap upstream.
 * 1 KB leaves an event room to carry that value plus its provenance envelope
 * and still be a fixed, known cost.
 *
 * MAX_LOG_BYTES: the whole cross-node log. At that median it is roughly 250
 * live events for the entire fleet — far more than four bodies produce between
 * prunes, and small enough to read whole on a session start rather than
 * paginate. Measured against the real store: those 19 facts become a 6.2 KB
 * log, and the projection the voice agent actually gets from it is 700 bytes.
 */
export const MAX_EVENT_BYTES = Number(
  process.env.FLEET_MEMORY_MAX_EVENT_BYTES || 1024,
)
export const MAX_LOG_BYTES = Number(
  process.env.FLEET_MEMORY_MAX_LOG_BYTES || 128 * 1024,
)

/*
 * What one projection may cost. 800 bytes ≈ 200 tokens at the 4-chars-per-token
 * estimate contextProjection.js uses, which is the budget the Mac's own
 * projection already runs at. The ceiling matches MAX_MEMORY_TEXT_CHARS in
 * cloud-relay/fleetContext.js: that is what the relay already lets into a
 * prompt today, so a caller asking for the maximum is not asking for anything
 * new.
 */
export const DEFAULT_PROJECTION_BYTES = 800
export const MAX_PROJECTION_BYTES = 2000

/* ---- events ------------------------------------------------------------- */

/**
 * Normalize one append into the record that goes on the wire and into a store.
 *
 * Throws rather than coercing: the writers are other bodies, and a body that
 * sends an event with no key has a bug that a silently-dropped write will hide
 * for weeks. normalizeMemoryEvents() below turns the throw into a per-event
 * rejection so one bad event cannot fail a whole batch.
 */
export function normalizeMemoryEvent(
  {
    type = 'event',
    key,
    value = '',
    retract = false,
    node,
    surfaces = [],
    confidence = 0.7,
    sensitivity = null,
    at = undefined,
    ttlMs = undefined,
    expiresAt = undefined,
  } = {},
  { now = Date.now(), randomUUID = crypto.randomUUID } = {},
) {
  const eventType = String(type || '').trim()
  if (!MEMORY_EVENT_TYPES.includes(eventType)) {
    throw new TypeError(
      `type must be one of ${MEMORY_EVENT_TYPES.join(', ')} (got ${JSON.stringify(type)}).`,
    )
  }

  const eventKey = String(key ?? '').trim()
  if (!eventKey) throw new TypeError('A memory event needs a key.')

  const writer = String(node ?? '').trim()
  if (!writer) {
    // Which body said it is half of what makes a cross-node fact usable: the
    // reader has to be able to weigh a scrape against the owner's own words.
    throw new TypeError('A memory event needs the node that wrote it.')
  }

  const isRetraction = Boolean(retract)
  const text = collapse(value)
  if (!isRetraction && !text) throw new TypeError('A memory event needs a value.')

  /*
   * Unknown surface names are rejected, not carried. A surface list is the
   * routing table for the fact, so a typo does not mean "goes somewhere
   * unusual", it means "silently reaches nobody" — indistinguishable from a
   * write that never happened.
   */
  const scope = normalizeSurfaces(surfaces)

  const stamp = Number.isFinite(Date.parse(at || '')) ? Date.parse(at) : now
  const record = {
    version: FLEET_MEMORY_VERSION,
    eventId: `fme_${randomUUID()}`,
    type: eventType,
    key: eventKey,
    value: isRetraction ? '' : text,
    retracted: isRetraction,
    node: writer.slice(0, 120),
    surfaces: scope,
    confidence: clampConfidence(confidence),
    // Inferred when unset: most writers are automated and will never think to
    // set it, and an unclassified secret is one that reaches a third-party
    // prompt in full.
    sensitivity: sensitivity || (isRetraction ? 'normal' : classifySensitivity(text)),
    at: new Date(stamp).toISOString(),
    expiresAt: resolveExpiry({ expiresAt, ttlMs, type: eventType, now: stamp }),
    bytes: 0,
  }

  return fitEventToBudget(record)
}

/**
 * Normalize a batch, reporting what was refused and why.
 *
 * Rejections are returned rather than thrown for the same reason contextHandoff
 * records what it shed: a caller that cannot tell a refused write from an
 * accepted one has no way to notice it is writing garbage.
 */
export function normalizeMemoryEvents(list, options = {}) {
  const source = Array.isArray(list) ? list : []
  const events = []
  const rejected = []

  for (const [index, raw] of source.entries()) {
    try {
      events.push(normalizeMemoryEvent(raw, options))
    } catch (error) {
      rejected.push({ index, reason: error?.message || 'invalid event' })
    }
  }

  return { events, rejected }
}

export function memoryEventBytes(record) {
  return jsonBytes(record)
}

export function isMemoryEventExpired(record, now = Date.now()) {
  if (!record?.expiresAt) return false
  const at = Date.parse(record.expiresAt)
  return Number.isFinite(at) && at <= now
}

export function servesSurface(record, surface) {
  if (!surface) return true
  const scope = Array.isArray(record?.surfaces) ? record.surfaces : []
  return scope.length === 0 || scope.includes(surface)
}

/**
 * Reduce the log to the current value of each (type, key).
 *
 * Fold BEFORE filtering expiry, never after. A retraction inherits its type's
 * TTL, so a retraction can expire while the value it cancelled is still live —
 * filter first and the retracted fact rises from the dead, which is the worst
 * possible failure for a memory system because it is silent and it is
 * confidently wrong. Folding first means the newest statement about a key wins
 * even when the newest statement is "expired" or "forget this".
 *
 * Ties on the timestamp break on the event id. Two bodies writing the same key
 * in the same millisecond is a genuine race; the tiebreak only has to be
 * deterministic so every reader folds the same way.
 */
export function foldMemoryEvents(events, { now = Date.now(), surface = null } = {}) {
  const winners = new Map()

  for (const record of Array.isArray(events) ? events : []) {
    if (!record?.key || !record?.type) continue
    const identity = `${record.type} ${record.key}`
    const current = winners.get(identity)
    if (!current || isNewer(record, current)) winners.set(identity, record)
  }

  return [...winners.values()]
    .filter((record) => !record.retracted)
    .filter((record) => !isMemoryEventExpired(record, now))
    .filter((record) => servesSurface(record, surface))
}

function isNewer(candidate, current) {
  const left = Date.parse(candidate.at || '') || 0
  const right = Date.parse(current.at || '') || 0
  if (left !== right) return left > right
  return String(candidate.eventId) > String(current.eventId)
}

/*
 * The order everything reads and evicts in.
 *
 * NOT newest-first. A preference is written once and then never again, so it is
 * permanently the oldest row in the log and permanently the most valuable one;
 * an age-ordered eviction deletes the owner's standing choices to make room for
 * an hour-old observation. Type first, then recency within the type.
 *
 * cloud-relay/store/d1Store.js encodes this same ladder as a SQL CASE. The two
 * are checked against each other in fleetMemory.test.js, because a store that
 * evicts in a different order than the reader expects is a bug that only shows
 * up once the log is full.
 */
export const MEMORY_EVICTION_RANK = Object.freeze(
  Object.fromEntries(MEMORY_EVENT_TYPES.map((type, index) => [type, index])),
)

export function compareMemoryEventsByValue(left, right) {
  const rank =
    (MEMORY_EVICTION_RANK[left?.type] ?? MEMORY_EVENT_TYPES.length) -
    (MEMORY_EVICTION_RANK[right?.type] ?? MEMORY_EVENT_TYPES.length)
  if (rank !== 0) return rank

  const at =
    (Date.parse(right?.at || '') || 0) - (Date.parse(left?.at || '') || 0)
  if (at !== 0) return at

  return String(right?.eventId || '').localeCompare(String(left?.eventId || ''))
}

/**
 * Drop what the fleet should stop paying for: superseded writes, expirations,
 * and — only if the log is still over its byte ceiling — the least valuable
 * tail.
 *
 * Retracted keys are kept until their own expiry rather than deleted with the
 * value they cancelled. A tombstone that outlives nothing suppresses nothing:
 * delete both and the next node to sync an old copy of the fact re-introduces
 * it.
 */
export function pruneFleetMemoryEvents(
  events,
  { now = Date.now(), maxBytes = MAX_LOG_BYTES } = {},
) {
  const source = Array.isArray(events) ? events : []
  const live = new Set(
    // Retractions are winners too, so fold with the tombstones left in.
    foldWithTombstones(source).map((record) => record.eventId),
  )

  const removed = []
  const survivors = []

  for (const record of source) {
    if (!live.has(record.eventId)) {
      removed.push({ ...record, reason: 'superseded' })
      continue
    }
    if (isMemoryEventExpired(record, now)) {
      removed.push({ ...record, reason: 'expired' })
      continue
    }
    survivors.push(record)
  }

  survivors.sort(compareMemoryEventsByValue)

  /*
   * A prefix cut, not a best-fit pack: once the budget is spent everything
   * below the line goes, even a small record that would have squeezed in.
   * d1Store.js does this with a running SUM() window, which can only ever cut a
   * prefix, and two stores that keep different rows from the same log is a
   * divergence that would only surface in production, on a full log.
   */
  const kept = []
  let bytes = 0
  let overflowing = false
  for (const record of survivors) {
    const cost = Number(record.bytes) || jsonBytes(record)
    if (overflowing || bytes + cost > maxBytes) {
      overflowing = true
      removed.push({ ...record, reason: 'overflow' })
      continue
    }
    bytes += cost
    kept.push(record)
  }

  return {
    kept,
    removed,
    stats: {
      bytes,
      kept: kept.length,
      removed: removed.length,
      reasons: removed.reduce((counts, record) => {
        counts[record.reason] = (counts[record.reason] || 0) + 1
        return counts
      }, {}),
    },
  }
}

function foldWithTombstones(events) {
  const winners = new Map()
  for (const record of events) {
    if (!record?.key || !record?.type) continue
    const identity = `${record.type} ${record.key}`
    const current = winners.get(identity)
    if (!current || isNewer(record, current)) winners.set(identity, record)
  }
  return [...winners.values()]
}

/**
 * Take live events in value order until a byte budget is spent.
 *
 * Every read is bounded this way rather than by a row limit, so a caller can
 * reason about what a read costs without knowing how fat the rows got.
 */
export function takeWithinByteBudget(events, maxBytes = MAX_LOG_BYTES) {
  const ordered = [...(Array.isArray(events) ? events : [])].sort(
    compareMemoryEventsByValue,
  )
  const taken = []
  let bytes = 0

  for (const record of ordered) {
    const cost = Number(record.bytes) || jsonBytes(record)
    if (bytes + cost > maxBytes) break
    bytes += cost
    taken.push(record)
  }

  return taken
}

/* ---- projections -------------------------------------------------------- */

/*
 * One section per type, in the order that keeps a provider prompt cache warm.
 *
 * Providers cache the longest byte-identical prefix, so the sections whose
 * content changes on the order of weeks lead and the churning ones trail —
 * the same rule fleetContext.js applies to the fleet snapshot and
 * contextProjection.js applies to the Mac's facts. Preferences are additionally
 * sorted by key so the head is byte-identical between turns even as facts are
 * added.
 *
 * The share is a fraction of the BYTE budget, not a row cap. A row cap lets one
 * fat preference eat the space four short tasks needed; a share means a section
 * that is silent this turn hands its bytes to the next section rather than
 * hoarding them, and no section can starve the others no matter how many facts
 * it holds.
 */
const PROJECTION_SECTIONS = Object.freeze([
  { type: 'preference', heading: '## Owner', share: 0.4, order: 'key' },
  { type: 'task', heading: '## Now', share: 0.25, order: 'fresh' },
  { type: 'entity', heading: '## Known', share: 0.2, order: 'score' },
  { type: 'event', heading: '## Recent', share: 0.15, order: 'score' },
])

/**
 * Build the prompt block for one surface and one task.
 *
 * Pure. It reports the event ids it shipped so a caller can record the read;
 * nothing here writes, because the projection runs on whichever body is asking
 * and that body may have no store to write to.
 *
 * `inheritedText` is a migration accommodation with an explicit end condition.
 * The Mac still pushes a pre-rendered projection through fleet state
 * (local-agent/bridge.js → memory.text), and that block is the only memory the
 * voice agent has today. Merging it under THIS budget rather than emitting both
 * is the whole point: two memory blocks in one prompt pay twice for one idea.
 * When the bridge appends events instead, the parameter stops being passed and
 * this branch is dead.
 */
export function projectFleetMemory({
  events = [],
  surface = 'voice',
  task = '',
  now = Date.now(),
  budgetBytes = DEFAULT_PROJECTION_BYTES,
  inheritedText = null,
  revealSensitive = false,
} = {}) {
  const budget = Math.max(
    0,
    Math.min(Number(budgetBytes) || 0, MAX_PROJECTION_BYTES),
  )
  const live = foldMemoryEvents(events, { now, surface })
  const wanted = tokenize(task)
  const inherited = parseProjectionSections(inheritedText)

  const lines = []
  const eventIds = []
  let spent = 0
  let released = 0
  let droppedForBudget = 0

  const emit = (line, record) => {
    const cost = Buffer.byteLength(line) + 1
    if (spent + cost > released) {
      droppedForBudget += 1
      return false
    }
    lines.push(line)
    spent += cost
    if (record) eventIds.push(record.eventId)
    return true
  }

  const section = (heading, entries) => {
    if (!entries.length) return
    const before = lines.length
    const headingCost = Buffer.byteLength(heading) + 1
    lines.push(heading)
    spent += headingCost

    for (const entry of entries) emit(entry.line, entry.record)

    // A heading with everything under it dropped is pure overhead.
    if (lines.length === before + 1) {
      lines.pop()
      spent -= headingCost
    }
  }

  for (const [index, descriptor] of PROJECTION_SECTIONS.entries()) {
    // The last section releases whatever the shares left on the table, so
    // rounding never strands bytes.
    released =
      index === PROJECTION_SECTIONS.length - 1
        ? budget
        : released + Math.floor(budget * descriptor.share)

    const scored = live
      .filter((record) => record.type === descriptor.type)
      .map((record) => ({ record, ...score(record, wanted, now) }))
      .filter(({ record, overlap }) =>
        keepSensitive(record, overlap, revealSensitive),
      )

    const mine = (descriptor.order === 'score' ? selectRelevant(scored, wanted) : scored)
      .sort(sorterFor(descriptor.order))
      .map(({ record }) => ({
        record,
        line: renderLine(record, descriptor, revealSensitive),
      }))

    section(
      descriptor.heading,
      withInherited(mine, inherited.get(descriptor.heading)),
    )
    inherited.delete(descriptor.heading)
  }

  // Anything the other body emitted under a heading this module does not know
  // (contextProjection.js has a `## Web` tier, for one). Dropping it silently
  // would quietly delete memory during the migration; it goes last because an
  // unrecognised section cannot be ranked.
  released = budget
  for (const [heading, entries] of inherited.entries()) {
    section(heading, entries)
  }

  const text = lines.join('\n')

  return {
    text,
    eventIds,
    stats: {
      surface,
      bytes: Buffer.byteLength(text),
      budgetBytes: budget,
      considered: live.length,
      included: eventIds.length,
      droppedForBudget,
      inherited: inheritedText ? Buffer.byteLength(String(inheritedText)) : 0,
    },
  }
}

/*
 * A fact that does not mention what was asked is not worth a line, and the byte
 * budget is not the thing that should be deciding that: a section that fits is
 * still paid for on every turn it is sent, which is the whole economics of this
 * module. So relevance filters first and the budget only trims what survives.
 *
 * When nothing matches — or nothing has been asked yet, which is every
 * heartbeat — the two freshest stand in. That is what a follow-up reference
 * ("send it to him") needs to resolve, and it is why this is not simply "drop
 * everything with no overlap".
 *
 * Preferences and open tasks are exempt: they are behaviour and current work,
 * and they are relevant to a request that never mentions them.
 */
function selectRelevant(entries, wanted) {
  const matched = entries.filter(({ overlap }) => overlap > 0)
  if (wanted.size && matched.length) return matched
  return [...entries].sort((left, right) => right.score - left.score).slice(0, 2)
}

function sorterFor(order) {
  if (order === 'key') {
    // Sorted by key, not by score: this is the cacheable head of the prompt and
    // it must not reshuffle because the owner asked about something else.
    return (left, right) => left.record.key.localeCompare(right.record.key)
  }
  if (order === 'fresh') {
    return (left, right) => freshness(right.record) - freshness(left.record)
  }
  return (left, right) => right.score - left.score
}

function renderLine(record, descriptor, revealSensitive) {
  const value = promptValue(record, revealSensitive)

  if (descriptor.type === 'preference') {
    return `- ${shortKey(record)}: ${value}`
  }
  if (descriptor.type === 'event') {
    /*
     * Only events carry their provenance inline. The other three are keyed
     * statements the fold has already resolved to one current value, so "who
     * says" adds nothing a reader can act on. An event is one body's claim
     * about a moment, and without when and who it cannot be weighed at all.
     */
    return `- ${value} [${record.node} ${shortDate(record.at)}]`
  }
  return `- ${value}${record.confidence < 0.5 ? ' (?)' : ''}`
}

/**
 * Relevance: does this mention what was asked, is it fresh, is it trusted.
 *
 * Overlap dominates, because a fresh fact about something else still costs
 * bytes and buys nothing — the reason this whole module exists rather than
 * shipping the log.
 */
function score(record, wanted, now) {
  const haystack = normalizeText(`${record.key} ${record.value}`)
  let overlap = 0
  for (const token of wanted) {
    if (haystack.includes(token)) overlap += 1
  }

  const ageDays = Math.max(0, (now - freshness(record)) / DAY_MS)
  const recency = Math.max(0, 3 - ageDays / 7)

  return { overlap, score: overlap * 5 + recency + record.confidence * 2 }
}

function keepSensitive(record, overlap, revealSensitive) {
  if (revealSensitive) return true
  // A personal detail rides along only when the request is actually about it.
  if (record.sensitivity === 'sensitive') return overlap > 0
  return true
}

function promptValue(record, revealSensitive) {
  if (record.sensitivity === 'secret' && !revealSensitive) {
    return maskSecretValue(record.value)
  }
  return record.value
}

/*
 * Merge a pre-rendered block from another body into the matching sections.
 *
 * Both sides render `## Heading` + `- item`, because both sides are
 * projections; that is what makes this a parse rather than a guess. Identical
 * lines are deduplicated so a fact that reached both bodies is not paid for
 * twice.
 */
function parseProjectionSections(text) {
  const sections = new Map()
  if (!text) return sections

  let heading = null
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    if (/^#{1,6}\s/.test(line)) {
      heading = `## ${line.replace(/^#+\s*/, '')}`
      if (!sections.has(heading)) sections.set(heading, [])
      continue
    }
    if (!heading) continue
    sections.get(heading).push({ record: null, line })
  }

  return sections
}

function withInherited(mine, inherited) {
  if (!inherited?.length) return mine
  const seen = new Set(mine.map((entry) => entry.line))
  return [...mine, ...inherited.filter((entry) => !seen.has(entry.line))]
}

/* ---- store operations (transport-free) ---------------------------------- */

/**
 * Append a batch on behalf of a node.
 *
 * Returned as `{ status, body }` rather than written to a response, so the same
 * code path is exercised by a test, by the relay's HTTP route, and by any body
 * that has a store in-process. cloud-relay/fleetContext.js holds the thin
 * Express adapter.
 */
export async function appendFleetMemory(store, input = {}, options = {}) {
  const node = String(input?.node ?? '').trim()
  const list = Array.isArray(input?.events) ? input.events : null

  if (!node || !list) {
    return {
      status: 400,
      body: { ok: false, error: 'node (string) and events (array) are required.' },
    }
  }
  if (typeof store?.appendMemoryEvents !== 'function') {
    return {
      status: 503,
      body: { ok: false, error: 'This relay store cannot hold fleet memory.' },
    }
  }

  const { events, rejected } = normalizeMemoryEvents(
    list.map((event) => ({ node, ...event })),
    options,
  )

  if (!events.length) {
    return {
      status: 400,
      body: { ok: false, error: 'No valid memory events in the batch.', rejected },
    }
  }

  const report = await store.appendMemoryEvents(events)

  return {
    status: 201,
    body: {
      ok: true,
      appended: events.length,
      bytes: events.reduce((total, event) => total + event.bytes, 0),
      // Reported, not logged and forgotten: a node that is writing events the
      // fleet immediately prunes should be able to see that from its own
      // response.
      rejected,
      log: report ?? null,
    },
  }
}

/**
 * Read the projection one surface should put in its prompt.
 *
 * The read is byte-bounded twice — once by what the store will hand over
 * (MAX_LOG_BYTES) and once by what the projection will render — so neither a
 * fat log nor a fat request can push an unbounded string into a prompt.
 */
export async function readFleetMemoryProjection(store, query = {}, options = {}) {
  const surface = MEMORY_SURFACES.includes(String(query?.surface || '').trim())
    ? String(query.surface).trim()
    : 'voice'
  const task = String(query?.task ?? '').slice(0, 2000)
  const budgetBytes = Math.min(
    Number(query?.budgetBytes) || DEFAULT_PROJECTION_BYTES,
    MAX_PROJECTION_BYTES,
  )

  if (typeof store?.listMemoryEvents !== 'function') {
    return {
      status: 503,
      body: { ok: false, error: 'This relay store cannot hold fleet memory.' },
    }
  }

  const now = options.now ?? Date.now()
  const events = await store.listMemoryEvents({ now })
  const projection = projectFleetMemory({
    events,
    surface,
    task,
    now,
    budgetBytes,
    inheritedText: query?.inheritedText ?? null,
  })

  return { status: 200, body: { ok: true, surface, ...projection } }
}

/* ---- helpers ------------------------------------------------------------ */

/*
 * `bytes` counts the record as stored, so it cannot count itself. Measured with
 * the field present and zeroed: the few digits of drift are immaterial against
 * a 128 KB ceiling, and leaving the field out entirely would under-count the
 * envelope every store actually writes.
 */
function fitEventToBudget(record) {
  record.bytes = jsonBytes(record)

  let guard = 0
  while (record.bytes > MAX_EVENT_BYTES && record.value.length > 1 && guard < 40) {
    const overflow = record.bytes - MAX_EVENT_BYTES
    const keep = Math.max(1, record.value.length - Math.max(overflow, 8))
    record.value = `${record.value.slice(0, keep - 1)}…`
    record.clipped = true
    record.bytes = jsonBytes(record)
    guard += 1
  }

  return record
}

function resolveExpiry({ expiresAt, ttlMs, type, now }) {
  if (expiresAt !== undefined) return expiresAt
  const ttl = ttlMs === undefined ? MEMORY_TTL_MS[type] : ttlMs
  if (!ttl) return null
  return new Date(now + ttl).toISOString()
}

function normalizeSurfaces(surfaces) {
  if (surfaces == null) return []
  const list = Array.isArray(surfaces) ? surfaces : [surfaces]
  const scope = [
    ...new Set(list.map((name) => String(name || '').trim()).filter(Boolean)),
  ]

  const unknown = scope.filter((name) => !MEMORY_SURFACES.includes(name))
  if (unknown.length) {
    throw new TypeError(
      `Unknown surface(s): ${unknown.join(', ')}. Known: ${MEMORY_SURFACES.join(', ')}.`,
    )
  }

  return scope.sort()
}

function clampConfidence(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0.7
  return Math.min(1, Math.max(0, number))
}

function collapse(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function shortKey(record) {
  const prefix = `${record.type}.`
  return record.key.startsWith(prefix)
    ? record.key.slice(prefix.length)
    : record.key
}

function shortDate(iso) {
  const at = Date.parse(iso || '')
  if (!Number.isFinite(at)) return '?'
  return new Date(at).toISOString().slice(5, 16).replace('T', ' ')
}

function freshness(record) {
  return Date.parse(record?.at || '') || 0
}

/*
 * Enough of a stopword list that "the" does not match every event and relevance
 * ranking degrades into "send everything" — which is the bill this module
 * exists to cut. Short content words like "gpu" must survive, so length alone
 * cannot be the filter.
 *
 * local-agent/contextProjection.js keeps a longer list for the Mac's own facts.
 * The two are deliberately separate rather than shared: importing it here would
 * drag memoryService.js, atomicJsonStore.js and the on-disk fact store into
 * every body that reads a projection, including ones with no filesystem.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'that', 'this', 'with', 'from', 'what',
  'when', 'where', 'which', 'who', 'how', 'why', 'can', 'are', 'was', 'were',
  'has', 'have', 'had', 'please', 'just', 'about', 'into', 'not', 'any', 'all',
  'some', 'more', 'get', 'got', 'let', 'tell', 'say', 'ask', 'show', 'open',
  'send', 'give', 'find',
])

function tokenize(text) {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  )
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized)
  } catch {
    // Unserialisable means unstorable: cost it at the maximum so the budget
    // sheds it first rather than letting it through unmeasured.
    return Number.MAX_SAFE_INTEGER
  }
}
