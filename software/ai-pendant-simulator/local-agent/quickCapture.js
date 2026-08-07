import crypto from 'node:crypto'

import { classifySensitivity } from './redaction.js'
import { forgetFact, listFacts, rememberFact } from './memoryService.js'
import { upsertContextEntity } from './contextGraph.js'

/*
 * "Save this idea for later." / "Remember this: my bike lock code is 4829."
 *
 * One breath, no follow-up questions, no form. Everything else the pendant can
 * do starts a plan the owner has to wait on; capture has to be over before the
 * owner has finished walking past the bike rack. So this module never calls the
 * planner and never touches the network — it parses, writes twice, and returns
 * a sentence short enough to say back.
 *
 * It writes to two stores because they answer different questions, and a single
 * store would have to be wrong about one of them:
 *
 *   memoryService  the prompt tier. Small, sensitivity-aware, and pruned when
 *                  nobody reads a fact — which is correct for prompts and fatal
 *                  for "for later".
 *   contextGraph   the durable archive. Never pruned, browsable at
 *                  /context-graph, and the thing the owner means by "you said
 *                  you'd remember".
 *
 * The split is also what keeps a spoken secret out of outbound prompts. The
 * graph copy of a secret carries the label and not the value, so the full text
 * exists in exactly one file (facts.json, 0600) and reaches a model only when
 * the caller asks for it by name. This is a redaction rule, not an access
 * rule: the owner reads any captured value back at full fidelity through
 * recallCaptures().
 */

/*
 * Lead-ins the owner says to mean "this next part is the payload". Ordered
 * longest-first so "save this idea for later" is not clipped by "save this".
 */
const LEAD_INS = [
  /^(?:hey\s+)?(?:pendant|assistant)[,:\s]+/i,
  /^save\s+this\s+idea\s+for\s+later\b[:,.\s–—-]*/i,
  /^save\s+(?:this|that|it)\s+for\s+later\b[:,.\s–—-]*/i,
  /^(?:make|take)\s+a\s+(?:quick\s+)?note\s*(?:of|that|:)?\s*/i,
  /^(?:don'?t\s+let\s+me\s+forget|remind\s+me\s+that)\b[:,.\s–—-]*/i,
  /^remember\s+(?:this|that|it)\b[:,.\s–—-]*/i,
  /^(?:jot|write)\s+(?:this|that)\s+down\b[:,.\s–—-]*/i,
  /^keep\s+(?:this|that)\s+in\s+mind\b[:,.\s–—-]*/i,
  /^save\s+(?:this|that)\b[:,.\s–—-]*/i,
  /^remember\b[:,.\s–—-]*/i,
  /^note\b[:,.\s–—-]*/i,
]

/* "my bike lock code is 4829" — a subject the owner can ask for by name. */
const FACT_SHAPE =
  /^(?:my|our|the)\s+(?<subject>[\p{L}\p{N}][\p{L}\p{N}\s'’/-]{1,58}?)\s+(?:is|are|=)\s+(?<value>.+)$/iu

const MAX_TEXT_CHARS = 400

export function stripLeadIn(utterance) {
  let text = String(utterance ?? '').trim()
  for (const pattern of LEAD_INS) {
    const stripped = text.replace(pattern, '')
    if (stripped !== text) {
      text = stripped.trim()
      break
    }
  }
  return text.replace(/^["“']|["”']$/g, '').trim()
}

/**
 * Decide what the owner just handed over.
 *
 * A keyed fact ("my X is Y") and a free-form idea are stored differently
 * because they are recalled differently: a fact is asked for by its subject and
 * must be overwritten when it changes, an idea is browsed and must never
 * overwrite the last one.
 */
export function parseCapture(utterance, { now = Date.now() } = {}) {
  const text = stripLeadIn(utterance).slice(0, MAX_TEXT_CHARS)
  if (!text) throw new Error('Nothing to capture.')

  const match = text.match(FACT_SHAPE)
  if (match) {
    const subject = normalizeSubject(match.groups.subject)
    const detail = match.groups.value.trim().replace(/[.\s]+$/, '')
    /* Stored as "subject: detail" so masking leaves a usable label behind —
     * "bike lock code: [withheld]" still tells the model the fact exists. */
    const value = `${subject}: ${detail}`
    return {
      mode: 'fact',
      title: subject,
      key: `owner.${slug(subject)}`,
      value,
      text,
      sensitivity: classifySensitivity(value),
    }
  }

  const title = firstClause(text)
  return {
    mode: 'idea',
    title,
    /* Ideas accumulate; a same-day repeat must not silently replace one. */
    key: `idea.${new Date(now).toISOString().slice(0, 10)}.${slug(title)}.${shortHash(text)}`,
    value: text,
    text,
    sensitivity: classifySensitivity(text),
  }
}

/**
 * Capture one utterance. Returns what was stored plus a line short enough to
 * speak back, which for a secret deliberately does not contain the secret.
 */
export function captureNote(
  { text, title = null, mode = null, now = Date.now(), source = 'owner' } = {},
  { filePath = undefined, archive = upsertContextEntity } = {},
) {
  const parsed = parseCapture(text, { now })
  const resolvedMode = mode === 'idea' || mode === 'fact' ? mode : parsed.mode
  const resolvedTitle = String(title || parsed.title).slice(0, 120)

  const fact = rememberFact(
    {
      key: parsed.key,
      /* Both are durable owner statements, so neither gets a default TTL: the
       * owner said "for later", and a memory that quietly expires in a week is
       * a bug wearing a policy's clothes. Idle pruning still applies. */
      kind: 'entity',
      value: parsed.value,
      source: { origin: source },
      /* The owner said it themselves — there is nothing to be unsure about. */
      confidence: 1,
      sensitivity: parsed.sensitivity,
      ttlMs: null,
      now,
    },
    filePath ? { filePath } : {},
  )

  const { entity } = archive({
    type: 'Note',
    name: resolvedTitle,
    attributes: {
      // The archive keeps the label and the pointer; the value stays in the one
      // store that knows how to withhold it.
      note: parsed.sensitivity === 'secret' ? '[stored privately]' : parsed.value,
      factKey: parsed.key,
      captureMode: resolvedMode,
      sensitivity: parsed.sensitivity,
      capturedAt: new Date(now).toISOString(),
      importance: 0.9,
    },
  })

  return {
    ok: true,
    mode: resolvedMode,
    title: resolvedTitle,
    key: parsed.key,
    factId: fact.id,
    entityId: entity.id,
    sensitivity: parsed.sensitivity,
    spoken: confirmationFor(resolvedMode, resolvedTitle, parsed.sensitivity),
  }
}

/**
 * Read captures back. Values are returned in full: withholding is about what
 * gets pasted into a third-party prompt, and the owner asking their own pendant
 * for their own bike lock code is neither third party nor prompt.
 */
export function recallCaptures(
  { query = '', limit = 10, now = Date.now() } = {},
  { filePath = undefined } = {},
) {
  const at = filePath ? { filePath } : {}
  const wanted = tokenize(query)
  const captured = listFacts({ now }, at).filter(
    (fact) => fact.key.startsWith('owner.') || fact.key.startsWith('idea.'),
  )

  const scored = captured
    .map((fact) => {
      const haystack = normalizeText(`${fact.key} ${fact.value}`)
      let overlap = 0
      for (const token of wanted) if (haystack.includes(token)) overlap += 1
      return { fact, overlap }
    })
    .filter((entry) => (wanted.size ? entry.overlap > 0 : true))
    .sort(
      (left, right) =>
        right.overlap - left.overlap ||
        Date.parse(right.fact.updatedAt) - Date.parse(left.fact.updatedAt),
    )
    .slice(0, limit)

  return scored.map(({ fact }) => ({
    key: fact.key,
    mode: fact.key.startsWith('idea.') ? 'idea' : 'fact',
    value: fact.value,
    sensitivity: fact.sensitivity,
    capturedAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  }))
}

export function forgetCapture(key, { filePath = undefined } = {}) {
  return forgetFact(key, filePath ? { filePath } : {})
}

function confirmationFor(mode, title, sensitivity) {
  if (sensitivity === 'secret') {
    /* Said out loud, possibly in public. Confirm the write, not the value. */
    return `Saved your ${title}. I won't read it back out loud.`
  }
  return mode === 'fact' ? `Got it — ${title} saved.` : `Saved: ${title}.`
}

function normalizeSubject(subject) {
  return String(subject)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function firstClause(text) {
  const clause = String(text).split(/[.;\n]/)[0].trim() || String(text).trim()
  return clause.length <= 80 ? clause : `${clause.slice(0, 77)}...`
}

function slug(text) {
  return (
    normalizeText(text)
      .split(' ')
      .filter(Boolean)
      .slice(0, 6)
      .join('-') || 'note'
  )
}

function shortHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 6)
}

function tokenize(text) {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((token) => token.length > 2),
  )
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
