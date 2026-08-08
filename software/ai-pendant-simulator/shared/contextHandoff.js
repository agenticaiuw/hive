/*
 * Cross-environment context migration: store once, hand over a handle, pull.
 *
 * The relay holds a voice conversation, distils it into actions, and posts
 * those to the Mac. Everything the relay understood on the way — what it
 * checked, what it ruled out, why — used to stop at that boundary, and the
 * Mac's planner started from a fresh system prompt with nothing but the action
 * list. Measured across one round of five discovery agents: 64 discovery
 * calls, 11 inter-agent messages, 6 proposals. Most of every budget went to
 * rediscovering the system.
 *
 * What actually transfers is the serialized message history — what was asked,
 * what tools were called, what came back. The receiving body re-ingests it.
 * You pay the tokens again; you do not pay the re-derivation, and the
 * re-derivation is the expensive part.
 *
 * On the tokens: provider prompt caching is real and server-side, so two
 * different machines hitting the same provider with the same prefix both get
 * hits — "different device" is not the boundary. The boundary is the model:
 * the relay runs gpt-realtime-2.1 and the Mac runs gpt-5.6-luna, and a cache
 * entry does not cross models. So a same-model crossing (a resume replayed on
 * the Mac twice, a Mac→Mac hop) can hit; the relay→Mac hop cannot, and the
 * value there is the re-derivation alone. buildResumeMessages() emits a
 * prompt_cache_key so the hops that *can* hit do.
 *
 * Pull, not push: the context is not re-sent on every hop, and a handle can
 * resolve to a representation shaped for whichever body asks (see
 * adaptContextForModel).
 */
import crypto from 'node:crypto'

import {
  classifySensitivity,
  maskSecretValue,
  stripImageBytes,
} from '../local-agent/redaction.js'

export const PORTABLE_CONTEXT_VERSION = 1

/*
 * Two hours.
 *
 * The context has to outlive the longest realistic gap between the relay
 * finishing a turn and the Mac claiming the job — the Mac is usually asleep
 * when the pendant is worn, and the bridge only claims after it wakes. It must
 * NOT outlive the world it describes: a stored reasoning thread names open
 * apps, files and tabs, and resuming a stale one is worse than starting cold
 * because it is confidently wrong rather than merely empty.
 *
 * Deliberately shorter than JOB_TTL_MS (24 h), so a context can expire while
 * its job is still queued. That is the case the degrade-to-cold path exists
 * for, and it is why that path is a requirement rather than a nicety.
 */
export const CONTEXT_TTL_MS = Number(
  process.env.CONTEXT_HANDOFF_TTL_MS || 2 * 60 * 60 * 1000,
)

/*
 * A byte budget, not an item count — the mistake that grew a store on this
 * project to 135 MB was reading a count cap as a size cap.
 *
 * 256 KB is a token budget wearing a disguise: a stored context is re-sent
 * whole to the receiving model, and 256 KB of JSON is roughly 65k tokens,
 * which is already a large share of a planner window. Past that, re-ingestion
 * costs more than the re-derivation it saves and the whole trade inverts.
 */
export const MAX_CONTEXT_BYTES = Number(
  process.env.CONTEXT_HANDOFF_MAX_BYTES || 256 * 1024,
)

/* Enough of a shed item to say what it was and let a reader ask for the rest
 * somewhere else; not enough to matter against the budget. */
const KEEP_TEXT_CHARS = 400

const HANDLE_PREFIX = 'pcx'
const HANDLE_ID_BYTES = 12
const HANDLE_SECRET_BYTES = 32
const HANDLE_PATTERN = /^pcx_([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{40,128})$/

export const CONTEXT_ITEM_KINDS = Object.freeze([
  'message',
  'tool_call',
  'tool_result',
  'reasoning',
  'note',
])

/* ---- handles ------------------------------------------------------------ */

/**
 * Mint an opaque handle and the record fields that verify it.
 *
 * Same shape as a device credential (`id.secret`, only the secret's hash is
 * stored) for the same reason: a context is whatever the owner said out loud,
 * so a dump of the store must not yield anything that can fetch one back. The
 * id is the lookup key and is safe to log; the secret is 256 bits and is not.
 */
export function mintContextHandle({ randomBytes = crypto.randomBytes } = {}) {
  const handleId = toBase64Url(randomBytes(HANDLE_ID_BYTES))
  const secret = toBase64Url(randomBytes(HANDLE_SECRET_BYTES))

  return {
    handle: `${HANDLE_PREFIX}_${handleId}.${secret}`,
    handleId,
    secretHash: hashHandleSecret(secret),
  }
}

export function parseContextHandle(handle) {
  const match = HANDLE_PATTERN.exec(String(handle || '').trim())
  if (!match) return null
  return { handleId: match[1], secret: match[2] }
}

export function verifyContextHandle(handle, record, now = Date.now()) {
  const parsed = parseContextHandle(handle)
  if (!parsed || !record || parsed.handleId !== record.handleId) return false
  if (isContextExpired(record, now)) return false
  return safeEqual(hashHandleSecret(parsed.secret), record.secretHash)
}

export function isContextExpired(record, now = Date.now()) {
  const expiresAt = new Date(record?.expiresAt || 0).getTime()
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

/* ---- the portable representation ---------------------------------------- */

/**
 * Normalize whatever a body kept into items that survive the crossing.
 *
 * Provider item formats differ per model — the realtime session speaks
 * conversation items, the Mac planner speaks chat-completions messages — so
 * neither is stored. What is stored is the part both can express: who said it,
 * what kind of turn it was, and the text. Anything unrecognised becomes a
 * `note`, because an item silently omitted is indistinguishable from an item
 * that never existed.
 */
export function normalizeContextItems(items) {
  const source = Array.isArray(items) ? items : []
  const normalized = []

  for (const [index, raw] of source.entries()) {
    if (!raw || typeof raw !== 'object') continue

    const kind = CONTEXT_ITEM_KINDS.includes(raw.kind) ? raw.kind : 'message'
    const text = textOf(raw)
    const item = {
      index,
      kind,
      role: normalizeRole(raw.role, kind),
      text,
    }

    if (raw.name) item.name = String(raw.name).slice(0, 120)
    if (raw.callId) item.callId = String(raw.callId).slice(0, 120)
    if (raw.at) item.at = String(raw.at)

    normalized.push(item)
  }

  return normalized
}

function textOf(raw) {
  if (typeof raw.text === 'string') return raw.text
  if (typeof raw.content === 'string') return raw.content
  if (raw.output !== undefined) return stableStringify(raw.output)
  if (raw.arguments !== undefined) return stableStringify(raw.arguments)
  if (Array.isArray(raw.content)) {
    // Audio and image parts carry no text worth migrating; their transcripts
    // do, and stripImageBytes already refuses to move pixels across a body.
    return raw.content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part?.text || part?.transcript || '',
      )
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function normalizeRole(role, kind) {
  const value = String(role || '').trim()
  if (value === 'user' || value === 'assistant' || value === 'system') {
    return value
  }
  return kind === 'tool_result' ? 'tool' : 'assistant'
}

/**
 * The producer adapter: what the realtime voice body knows, as portable items.
 *
 * Ordered causally — what the owner said, then what the session checked and
 * what came back, then what it decided. The plan's action list goes last and
 * on purpose: the Mac is given the actions anyway (plannerHint), and what it
 * has never had is the part above them. A receiver that sees only the
 * conclusion has to reconstruct the argument.
 */
export function contextItemsFromRealtimeState(state, plan = null) {
  const items = []
  const transcript = String(state?.transcript || '').trim()

  if (transcript) {
    items.push({ kind: 'message', role: 'user', text: transcript })
  }

  for (const entry of Array.isArray(state?.toolTrace) ? state.toolTrace : []) {
    items.push({
      kind: entry.kind,
      role: entry.kind === 'tool_result' ? 'tool' : 'assistant',
      name: entry.name,
      callId: entry.callId,
      text: entry.text,
      at: entry.at,
    })
  }

  const spoken = String(plan?.response ?? state?.response ?? '').trim()
  if (spoken) {
    items.push({ kind: 'message', role: 'assistant', text: spoken })
  }

  const actions = Array.isArray(plan?.actions ?? state?.actions)
    ? (plan?.actions ?? state.actions)
    : []
  if (actions.length) {
    items.push({
      kind: 'message',
      role: 'assistant',
      text: `Decided on these actions for the Mac:\n${JSON.stringify(actions, null, 2)}`,
    })
  }

  return items
}

/* ---- redaction ---------------------------------------------------------- */

/*
 * The guard that used to live here — mask, then check whether any substantial
 * word of the original survived — is gone because maskSecretValue no longer
 * needs supervising. It used to split on `:`/`=` and treat a separator-less
 * sentence as its own label, appending the marker and leaving the secret in
 * place ("my gate code is 4829: [withheld]"); it now removes the value or
 * withholds the segment. Keeping the guard would be actively harmful: it reads
 * any surviving word as evidence of a leak, so a sentence whose credential was
 * cut out precisely would be discarded along with the derivation this module
 * exists to preserve.
 */

/**
 * Redact item text before it is stored, per line and then per sentence.
 *
 * Line granularity rather than whole-item: an item is a tool result or a turn
 * of speech, and withholding all of it because one line held a key would throw
 * away the derivation this whole mechanism exists to keep.
 */
export function redactContextItems(items) {
  let secrets = 0
  let sensitive = 0

  const redacted = normalizeContextItems(items).map((item) => {
    const { text, secretCount, sensitiveCount } = redactText(item.text)
    secrets += secretCount
    sensitive += sensitiveCount
    return { ...item, text }
  })

  return { items: redacted, redaction: { secrets, sensitive } }
}

function redactText(value) {
  let secretCount = 0
  let sensitiveCount = 0

  const lines = String(value ?? '').split('\n')
  const out = lines.map((line) => {
    if (classifySensitivity(line) === 'normal') return line

    // Only the offending sentence goes. A tool result is often one long line.
    const pieces = line.split(/((?<=[.!?])\s+)/)
    return pieces
      .map((piece) => {
        if (/^\s*$/.test(piece)) return piece
        const verdict = classifySensitivity(piece)
        if (verdict === 'secret') {
          secretCount += 1
          return maskSecretValue(piece)
        }
        if (verdict === 'sensitive') sensitiveCount += 1
        return piece
      })
      .join('')
  })

  return { text: out.join('\n'), secretCount, sensitiveCount }
}

/* ---- byte budget -------------------------------------------------------- */

/**
 * Shrink an item list to the byte budget by shedding its largest items first.
 *
 * Not a list of field names: items grow fat for reasons nobody predicts, so
 * the rule is "the stored context has a size". Every shed item keeps its
 * identity (kind, role, tool name) and a short prefix, and records how many
 * bytes went, so a reader can tell an item that was elided from one that never
 * happened. The shed list is part of the stored record for the same reason.
 */
export function fitContextToBudget(items, maxBytes = MAX_CONTEXT_BYTES) {
  const kept = [...items]
  const shed = []

  if (jsonBytes(kept) <= maxBytes) return { items: kept, shed }

  const largestFirst = kept
    .map((item, position) => ({ position, bytes: jsonBytes(item) }))
    .sort((left, right) => right.bytes - left.bytes)

  for (const { position, bytes } of largestFirst) {
    if (jsonBytes(kept) <= maxBytes) break

    const item = kept[position]
    kept[position] = {
      ...item,
      text: `${String(item.text || '').slice(0, KEEP_TEXT_CHARS)}\n[elided: ${bytes} bytes did not fit the context budget]`,
      elidedBytes: bytes,
    }
    shed.push({
      index: item.index,
      kind: item.kind,
      name: item.name ?? null,
      bytes,
    })
  }

  return { items: kept, shed }
}

/* ---- packing ------------------------------------------------------------ */

/**
 * Build the stored record for a body that has finished its work.
 *
 * Returns the handle separately from the record: the handle is what travels
 * and the record is what is stored, and the two must never be the same object
 * or the secret ends up in the store.
 */
export function packContext({
  items,
  origin,
  model = null,
  sessionId = null,
  jobId = null,
  now = Date.now(),
  maxBytes = MAX_CONTEXT_BYTES,
  ttlMs = CONTEXT_TTL_MS,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!origin) throw new TypeError('packContext requires an origin body.')

  const minted = mintContextHandle({ randomBytes })
  const safe = stripImageBytes(Array.isArray(items) ? items : [])
  const { items: redacted, redaction } = redactContextItems(safe)
  const { items: fitted, shed } = fitContextToBudget(redacted, maxBytes)

  const record = {
    version: PORTABLE_CONTEXT_VERSION,
    handleId: minted.handleId,
    secretHash: minted.secretHash,
    origin: String(origin),
    model: model ? String(model) : null,
    sessionId: sessionId ? String(sessionId) : null,
    jobId: jobId ? String(jobId) : null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    items: fitted,
    shed,
    redaction,
    bytes: jsonBytes(fitted),
  }

  return { handle: minted.handle, record }
}

/* ---- adaptation for the receiving body ---------------------------------- */

/*
 * What a receiving body can swallow. Defaults describe the Mac planner, which
 * is a plain chat-completions call with no tools declared: send it a
 * role:"tool" message and the provider rejects the request outright, so a
 * faithful replay of the relay's tool calls would fail the job it was meant to
 * help. Transcribing them into prose keeps the derivation and loses only the
 * schema.
 */
export const DEFAULT_ACCEPTS = Object.freeze({
  toolItems: false,
  reasoning: false,
})

/**
 * Turn a stored context into messages the asking body can actually ingest.
 *
 * Every item that cannot cross as-is is either transcribed or dropped, and
 * either way it is recorded in `notes`. Silently dropping is what makes a
 * migrated context untrustworthy: the receiver cannot tell a thread that never
 * used a tool from one whose tool calls were quietly discarded.
 *
 * Reasoning items are the case worth being explicit about. They are opaque,
 * model-specific and often provider-encrypted; replaying one on a different
 * model is either rejected or meaningless. They are dropped, with a note that
 * says how many and why.
 */
export function adaptContextForModel(record, { accepts = DEFAULT_ACCEPTS } = {}) {
  const items = Array.isArray(record?.items) ? record.items : []
  const messages = []
  const notes = []

  for (const item of items) {
    if (item.kind === 'reasoning' && !accepts.reasoning) {
      notes.push({
        index: item.index,
        kind: 'reasoning',
        action: 'dropped',
        reason:
          'Reasoning items are model-specific and cannot be replayed on another model.',
      })
      continue
    }

    if (item.kind === 'tool_call' || item.kind === 'tool_result') {
      if (accepts.toolItems) {
        messages.push({
          role: item.kind === 'tool_call' ? 'assistant' : 'tool',
          content: item.text,
          ...(item.callId ? { tool_call_id: item.callId } : {}),
        })
        continue
      }

      notes.push({
        index: item.index,
        kind: item.kind,
        action: 'transcribed',
        reason:
          'The receiving body declares no tools, so the call is replayed as prose rather than as a tool item.',
      })
      messages.push({
        role: 'assistant',
        content:
          item.kind === 'tool_call'
            ? `[earlier: called ${item.name || 'a tool'}] ${item.text}`
            : `[earlier: ${item.name || 'tool'} returned] ${item.text}`,
      })
      continue
    }

    messages.push({ role: item.role === 'tool' ? 'assistant' : item.role, content: item.text })
  }

  for (const entry of Array.isArray(record?.shed) ? record.shed : []) {
    notes.push({
      index: entry.index,
      kind: entry.kind,
      action: 'shed',
      reason: `${entry.bytes} bytes exceeded the stored context budget.`,
    })
  }

  return { messages, notes }
}

/**
 * The messages a resuming body prepends, in the order that keeps a cache warm.
 *
 * The order is load-bearing, not cosmetic. Provider prompt caches key on an
 * exact prefix, so everything stable goes first — the receiver's own system
 * prompt, then the migrated context, which is byte-identical for the life of
 * the handle — and the volatile part, the new request, goes last. Put the new
 * request in the middle and every resume is a fresh prefix and every resume
 * misses.
 *
 * `cacheKey` is the handle ID, never the secret: a cache key is sent to the
 * provider on every call, and the secret is the thing that fetches the owner's
 * words back out of the store.
 */
export function buildResumeMessages(record, options = {}) {
  const { messages, notes } = adaptContextForModel(record, options)
  const dropped = notes.filter((note) => note.action === 'dropped').length
  const transcribed = notes.filter((note) => note.action === 'transcribed').length

  const preface = [
    `You are continuing a reasoning thread that started on another body (${record?.origin || 'unknown'}${record?.model ? `, ${record.model}` : ''}).`,
    'What follows is that thread. It is not a summary — it is what was actually said, called and returned. Do not re-derive any of it.',
    dropped || transcribed
      ? `Migration notes: ${transcribed} tool item(s) replayed as prose, ${dropped} item(s) dropped as un-ingestable on this model.`
      : null,
  ]
    .filter(Boolean)
    .join(' ')

  return {
    messages: [{ role: 'system', content: preface }, ...messages],
    notes,
    cacheKey: record?.handleId ? `ctx_${record.handleId}` : null,
  }
}

/* ---- store shaping ------------------------------------------------------ */

/** What a resume response may contain: everything except the verifier. */
export function publicContext(record) {
  if (!record) return null
  const { secretHash: _secretHash, ...rest } = record
  return rest
}

/* ---- helpers ------------------------------------------------------------ */

function hashHandleSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex')
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

function stableStringify(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized)
  } catch {
    // Unserialisable means unstorable, so treat it as maximally expensive and
    // let it be shed first.
    return Number.MAX_SAFE_INTEGER
  }
}
