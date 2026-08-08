import {
  graphEntityLine,
  listFacts,
  normalizeForOverlap,
  servesSurface,
} from './memoryService.js'
import { classifySensitivity, maskSecretValue } from './redaction.js'
import { provenanceSuffix } from './sampledFacts.js'

/*
 * Turn the fact store into the smallest prompt that still answers the request.
 *
 * The economics that motivate this file: context is re-sent on every turn, so a
 * line that is 90% irrelevant is not paid once, it is paid per call for as long
 * as it stays in the store. The old path shipped the whole memory block on
 * every turn — recent turns, working project, eight long-term entities, the
 * fleet's "Recent context" line — regardless of what was asked. This ships the
 * facts that match the surface and the task, and nothing else.
 *
 * Section order is load-bearing, for the same reason fleetContext.js orders its
 * blocks: providers cache the longest byte-identical prefix. Preferences and
 * permissions change on the order of weeks and are emitted first in sorted
 * order, so the head of the projection stays identical between turns; the
 * task-dependent tail is the only part that churns.
 */

/** Surfaces a fact can be scoped to. An empty scope means every surface. */
export const SURFACES = Object.freeze(['voice', 'mac', 'browser', 'ios'])

const STABLE_KINDS = ['preference', 'permission']

/*
 * Which knowledge-graph entities are worth a prompt line, and what kind of fact
 * each becomes. Byte-for-byte the table memoryService.syncFactsFromContextGraph
 * uses, and deliberately so: a fact derived live from the graph here and the
 * same fact after a sync has run must be one fact, not two spellings of it.
 * Anything absent from this table (Action, Tool, Device, Model — the telemetry
 * that is most of the graph) is not memory and never reaches a prompt.
 */
const GRAPH_KIND_BY_TYPE = {
  Person: 'entity',
  Project: 'entity',
  File: 'entity',
  Resource: 'entity',
  EmailDraft: 'observation',
  Note: 'observation',
  Task: 'task',
}

/* The clip memoryService applies to a fact value, applied to the same values. */
const MAX_VALUE_CHARS = 400

/* ~4 characters per token for English prose; the char counts are exact. */
const CHARS_PER_TOKEN = 4

export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN)
}

/**
 * Build the prompt text for one surface and one task.
 *
 * Pure: it reports which facts it used in factIds and writes nothing. The
 * caller records the read with touchFacts(), which is what lets idle pruning
 * tell a load-bearing fact from one that has been paid for and never read.
 */
export function projectContext({
  surface = 'voice',
  task = '',
  facts = null,
  now = Date.now(),
  budgetTokens = 200,
  revealSensitive = false,
  includeWeb = false,
  maxTasks = 3,
  maxRelevant = 6,
  maxWeb = 3,
  maxStable = 12,
} = {}) {
  const pool = (facts || listFacts({ surface, now })).filter(
    (fact) => servesSurface(fact, surface) && !isExpiredAt(fact, now),
  )
  const wanted = tokenize(task)

  // Trusted, well-used preferences win the head; the survivors are then sorted
  // by key so the head stays byte-identical between turns. Without the cap a
  // growing preference list would eat the whole budget and starve the facts the
  // task actually needs — the failure mode this file exists to prevent.
  const stable = pool
    .filter((fact) => STABLE_KINDS.includes(fact.kind))
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        (right.useCount || 0) - (left.useCount || 0) ||
        left.key.localeCompare(right.key),
    )
    .slice(0, maxStable)
    .sort((left, right) => left.key.localeCompare(right.key))

  const openTasks = pool
    .filter((fact) => fact.kind === 'task')
    .sort((left, right) => freshness(right) - freshness(left))
    .slice(0, maxTasks)

  const scored = pool
    .filter((fact) => fact.kind === 'entity' || fact.kind === 'observation')
    .map((fact) => ({ fact, ...score(fact, wanted, now) }))
    .sort((left, right) => right.score - left.score)

  // A browser finding is a different tier of memory: it entered the store from
  // a page, not from the owner, and it has no business in a conversation that
  // did not ask about it. It joins the prompt only on a task match.
  const web = scored
    .filter(({ fact }) => fact.source?.origin === 'browser-job')
    .filter(({ overlap }) => includeWeb || overlap > 0)
    .slice(0, maxWeb)

  const conversational = scored.filter(
    ({ fact }) => fact.source?.origin !== 'browser-job',
  )
  const matched = conversational.filter(({ overlap }) => overlap > 0)
  // A fact that does not mention what was asked is not worth a line. When
  // nothing matches (or there is no task yet) fall back to the two freshest,
  // which is what follow-up references like "send it to him" need to resolve.
  const relevant = (matched.length && wanted.size ? matched : conversational.slice(0, 2))
    .filter(({ fact, overlap }) => keepSensitive(fact, overlap, revealSensitive))
    .slice(0, maxRelevant)

  const budgetChars = budgetTokens * CHARS_PER_TOKEN
  const lines = []
  const factIds = []
  /*
   * Two facts can say the same sentence — the graph mints a fresh entity per
   * occurrence, so three identical "EmailDraft: Question about unknown topic"
   * rows are normal in a real store. The block this projection replaces
   * deduplicated by type and name (contextGraph.retrieveLongTermMemory does it
   * on the way out), so emitting the line three times here would be a straight
   * regression: the same idea billed three times, and a model reading repetition
   * as emphasis.
   */
  const emitted = new Set()
  /*
   * Normalized text of everything already emitted, for the near-duplicate the
   * byte-identical Set cannot catch.
   *
   * The same idea reaches the store by two routes: quickCapture writes the
   * owner's words, and syncFactsFromContextGraph derives a line from the graph
   * entity built out of the same words. Different keys, different writers,
   * different bytes — so both were emitted, and the prompt carried
   *
   *   - a pendant that files its own bug reports from the UART log.
   *   - Note: a pendant that files its own bug reports from the UART log
   *
   * as if they were two facts. Suppression is by CONTAINMENT rather than
   * equality, since the derived line is the captured one with a type prefix,
   * and it is one-directional: a later line adds nothing if what it says is
   * already on the page. A line that merely SHARES words with an earlier one is
   * kept — two facts about Downloads are two facts.
   */
  const emittedNormals = []
  let used = 0
  let droppedForBudget = 0
  let droppedAsRestatement = 0

  const emit = (line, fact) => {
    if (emitted.has(line)) return false
    const normal = normalizeForOverlap(line)
    /*
     * Containment runs BOTH ways, and the first cut only checked one. The
     * derived line is the captured one with a type prefix, so it CONTAINS what
     * came before rather than being contained by it — checking a single
     * direction let the pair through unchanged.
     *
     * Materiality is what keeps this from eating real facts: one line is a
     * restatement of another only if the longer adds little to the shorter.
     * "Note: " on a 57-character sentence is 5 characters of nothing; a line
     * that happens to quote an earlier one and then says something else is a
     * second fact and survives.
     *
     * Short lines are exempt entirely — "Note: yes" is contained in half the
     * store, and suppressing on three words would drop real facts to save
     * nothing.
     */
    if (normal.length >= 24) {
      const restates = emittedNormals.some((seen) => {
        const [shorter, longer] = seen.length <= normal.length ? [seen, normal] : [normal, seen]
        if (!longer.includes(shorter)) return false
        return longer.length - shorter.length <= Math.max(12, shorter.length * 0.25)
      })
      if (restates) {
        droppedAsRestatement += 1
        return false
      }
    }
    if (used + line.length + 1 > budgetChars) {
      droppedForBudget += 1
      return false
    }
    emitted.add(line)
    if (normal) emittedNormals.push(normal)
    lines.push(line)
    used += line.length + 1
    if (fact) factIds.push(fact.id)
    return true
  }

  const section = (heading, entries, render) => {
    if (!entries.length) return
    const before = lines.length
    lines.push(heading)
    used += heading.length + 1
    for (const entry of entries) {
      emit(render(entry), entry.fact ?? entry)
    }
    // A heading with everything under it dropped is pure overhead.
    if (lines.length === before + 1) {
      lines.pop()
      used -= heading.length + 1
    }
  }

  /*
   * Provenance rides on the stable head, and only there. A sampled reading and
   * a stated choice were rendered identically, so nothing downstream — model or
   * owner reading the prompt — could tell that "timezone: America/Chicago" was
   * something this Mac reported once rather than something the owner said. The
   * suffix costs a few tokens on the handful of machine-origin rows and is
   * empty for everything the owner actually chose.
   */
  section(
    '## Owner',
    stable,
    (fact) => `- ${shortKey(fact)}: ${promptValue(fact, revealSensitive)}${provenanceSuffix(fact)}`,
  )
  section('## Now', openTasks, (fact) => `- ${promptValue(fact, revealSensitive)}`)
  section(
    '## Relevant',
    relevant,
    ({ fact }) => `- ${promptValue(fact, revealSensitive)}${fact.confidence < 0.5 ? ' (?)' : ''}`,
  )
  section(
    '## Web',
    web,
    ({ fact }) =>
      `- ${promptValue(fact, revealSensitive)} [${fact.source?.host || 'web'} ${shortDate(
        fact.source?.at,
      )}]`,
  )

  const text = lines.join('\n')

  return {
    text,
    factIds,
    stats: {
      surface,
      chars: text.length,
      estimatedTokens: estimateTokens(text),
      considered: pool.length,
      included: factIds.length,
      droppedForBudget,
      budgetTokens,
    },
  }
}

/**
 * The projection for one conversational turn.
 *
 * Same projection, one extra input: the knowledge-graph entities the turn has
 * ALREADY retrieved. This closes the only gap that made the projection weaker
 * than the block it replaces. The fact store is refreshed from the graph only
 * when something POSTs /memory/sync-graph — nothing does it on a timer — so a
 * projection built from the store alone can be arbitrarily behind on exactly
 * the thing the owner just did, while the old `## Long-term personal memory`
 * block read the graph live on every turn. Passing the live entities in costs
 * no extra I/O (the caller read them to resolve follow-up references anyway)
 * and makes the projection at least as current as what it replaces.
 *
 * Stored facts still win their own metadata: a graph entity that has already
 * been synced keeps the stored row's id, so touchFacts() can still find it and
 * idle pruning keeps working.
 */
export function projectTurnContext({ longTerm = [], ...options } = {}) {
  const { surface = 'voice', now = Date.now() } = options
  const stored = options.facts || listFacts({ surface, now })
  const merged = new Map(stored.map((fact) => [fact.key, fact]))

  for (const entity of longTerm) {
    const derived = factFromGraphEntity(entity)
    if (!derived) continue
    const existing = merged.get(derived.key)
    merged.set(
      derived.key,
      existing
        ? {
            ...derived,
            // Identity and read history belong to the stored row; only the
            // value and its freshness come from the live graph.
            id: existing.id,
            createdAt: existing.createdAt,
            lastUsedAt: existing.lastUsedAt,
            useCount: existing.useCount,
          }
        : derived,
    )
  }

  return projectContext({ ...options, facts: [...merged.values()] })
}

/**
 * One knowledge-graph entity as a fact, without writing anything.
 *
 * NOT given an expiry, unlike its synced twin. The entity was just read from
 * the live graph, which is the same read the block this replaces did, so
 * expiring it here would drop something the old path shipped. Age still costs
 * it: freshness() reads source.at, so a stale entity ranks low and simply loses
 * to something the task actually mentions.
 */
export function factFromGraphEntity(entity) {
  const kind = GRAPH_KIND_BY_TYPE[entity?.type]
  if (!kind || !entity?.id || !entity?.name) return null

  /* Built by memoryService so this and the importer cannot drift. A drifted
   * copy means the same entity reads differently depending on whether the sync
   * had run, which is exactly the kind of difference nobody would think to look
   * for. */
  const value = clip(graphEntityLine(entity))
  if (!value) return null

  const at = entity.updatedAt || entity.createdAt || null

  return {
    /* `live:` cannot collide with a stored fact id, so an entity the store has
     * never seen is never mistaken for one when the read is recorded. */
    id: `live:graph.${entity.id}`,
    key: `graph.${entity.id}`,
    kind,
    value,
    surfaces: [],
    source: { origin: 'context-graph', entityId: entity.id, at },
    confidence: Number(entity.attributes?.importance) || 0.6,
    // Inferred, never assumed safe: the graph holds notes the owner spoke, and
    // "Note: bike lock code" has to stay [withheld] on this path too.
    sensitivity: classifySensitivity(value),
    createdAt: entity.createdAt || at,
    updatedAt: at,
    expiresAt: null,
    lastUsedAt: null,
    useCount: 0,
  }
}

function clip(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length <= MAX_VALUE_CHARS ? text : `${text.slice(0, MAX_VALUE_CHARS - 1)}…`
}

/**
 * Score a fact for this task: does it mention what was asked, is it recent, is
 * it trusted. Overlap dominates because relevance is the whole point — a fresh
 * fact about something else still costs tokens and buys nothing.
 */
function score(fact, wanted, now) {
  const haystack = normalizeText(`${fact.key} ${fact.value}`)
  let overlap = 0
  for (const token of wanted) {
    if (haystack.includes(token)) overlap += 1
  }

  const ageDays = Math.max(0, (now - freshness(fact)) / (24 * 60 * 60 * 1000))
  const recency = Math.max(0, 3 - ageDays / 7)
  const used = Math.min(2, (fact.useCount || 0) * 0.25)

  return { overlap, score: overlap * 5 + recency + fact.confidence * 2 + used }
}

function keepSensitive(fact, overlap, revealSensitive) {
  if (revealSensitive) return true
  // A personal detail rides along only when the request is actually about it.
  if (fact.sensitivity === 'sensitive') return overlap > 0
  return true
}

function promptValue(fact, revealSensitive) {
  if (fact.sensitivity === 'secret' && !revealSensitive) {
    return maskSecretValue(fact.value)
  }
  return fact.value
}

function shortKey(fact) {
  const prefix = `${fact.kind}.`
  return fact.key.startsWith(prefix) ? fact.key.slice(prefix.length) : fact.key
}

function shortDate(iso) {
  const at = Date.parse(iso || '')
  if (!Number.isFinite(at)) return '?'
  return new Date(at).toISOString().slice(5, 10)
}

function freshness(fact) {
  return (
    Date.parse(fact.source?.at || '') ||
    Date.parse(fact.updatedAt || '') ||
    Date.parse(fact.createdAt || '') ||
    0
  )
}

function isExpiredAt(fact, now) {
  const at = Date.parse(fact?.expiresAt || '')
  return Number.isFinite(at) && at <= now
}

/*
 * Without this, "the" matches every fact in the store and relevance ranking
 * silently degrades into "send everything" — the exact bill this file exists to
 * cut. Short content words like "gpu" must survive, so length alone cannot be
 * the filter.
 */
const STOPWORDS = new Set(
  [
    'the', 'and', 'for', 'you', 'your', 'that', 'this', 'with', 'from', 'what',
    'when', 'where', 'which', 'who', 'how', 'why', 'can', 'could', 'would',
    'should', 'are', 'was', 'were', 'has', 'have', 'had', 'please', 'just',
    'also', 'about', 'into', 'over', 'under', 'out', 'off', 'not', 'any', 'all',
    'some', 'more', 'get', 'got', 'let', 'make', 'made', 'tell', 'told', 'say',
    'said', 'ask', 'asked', 'show', 'open', 'send', 'give', 'find',
    // Korean demonstratives, which conversationContext.js already treats as
    // pronouns rather than content.
    '그거', '이거', '저거', '방금', '아까',
  ],
)

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
