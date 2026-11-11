/*
 * The node-mesh envelope: one addressed message from any node to any node.
 *
 * WHY THIS EXISTS. Until now every cross-node hop went through the Mac. The
 * browser extension only knew http://127.0.0.1:8000; the iOS shell only spoke
 * HTTP to the relay and only through mac:* routes that queue a bridge job. So
 * "the relay tells the extension something" was physically impossible unless
 * the Mac was awake to carry it, and a closed lid was a dead mesh.
 *
 * WHAT O(N²) MEANS HERE. The owner asked for O(N²) links. That is a property
 * of the REACHABILITY GRAPH, not a count of TCP connections: every ordered
 * pair (A, B) must have a path that does not require a third node to be
 * awake. A star of sockets with a switching relay delivers exactly that —
 * N sockets, N² reachable pairs — and it is the only shape that works at all
 * here, because none of these nodes can accept an inbound connection: the
 * extension is a service worker behind a NAT, the phone is on cellular, the
 * pendant is an LTE modem. N² physical sockets would need N² listeners and
 * there are zero. The relay is not a hub in the sense the owner objected to;
 * it is the one node with a public address, and it is awake by construction.
 * The Mac was the wrong hub because it sleeps, not because hubs are wrong.
 *
 * THE ENVELOPE.
 *   {
 *     v: 1,                       protocol version
 *     id: "nmsg_<22 chars>",      unique; the ack key and the dedupe key
 *     from: "<deviceId>",         STAMPED BY THE RELAY from the authenticated
 *                                 principal. A body-supplied `from` is
 *                                 ignored — see createNodeEnvelope's caller
 *                                 in cloud-relay/nodeMailbox.js.
 *     to: "<deviceId>" | "@relay",target node; "@relay" is the relay brain
 *     kind: "browser.tab.open",   dotted lowercase verb the receiver switches on
 *     payload: { ... },           JSON, bounded (MAX_ENVELOPE_BYTES)
 *     corr: "<id>" | null,        correlation id: set it to the `id` of the
 *                                 message you are answering
 *     createdAt: "<iso>",
 *     expiresAt: "<iso>"          past this, the message is never delivered
 *   }
 *
 * RESERVED ADDRESSES start with '@', which deviceAuth.normalizeDeviceId
 * forbids in a deviceId (charset is [A-Za-z0-9_.:-]). That is why the relay's
 * own address is '@relay' and not 'relay': a device could legitimately have
 * registered itself as "relay" and would then have received the relay brain's
 * mail. An address space where a participant can name itself the router is
 * not an address space.
 *
 * SIZE. MAX_ENVELOPE_BYTES is 64 KiB against a D1 value limit of ~1 MB. The
 * gap is deliberate: an inbox page is MAX_INBOX_PAGE envelopes read in one
 * response, and 50 × 64 KiB = 3.2 MiB is already a large HTTP body — while a
 * single 1 MB envelope would fit D1 and then blow up the page that contains
 * it. Audio and screenshots do NOT go in a payload; they go to R2 and travel
 * as a reference, the same rule the bridge result path already follows.
 */

export const NODE_MESH_PROTOCOL_VERSION = 1

/** The relay brain's own mailbox. '@' can never appear in a deviceId. */
export const RELAY_NODE_ADDRESS = '@relay'

/** Serialized envelope ceiling. See the SIZE note above. */
export const MAX_ENVELOPE_BYTES = 64 * 1024

/** Envelopes returned by one inbox drain. */
export const MAX_INBOX_PAGE = 50

/* Ten minutes: long enough to survive a browser restart or a tunnel change,
 * short enough that a message whose moment has passed does not arrive as a
 * surprise an hour later. Senders that want longer say so, up to a day. */
export const DEFAULT_TTL_MS = 10 * 60_000
export const MAX_TTL_MS = 24 * 60 * 60_000

/* Same shape deviceAuth.normalizeDeviceId accepts, so an address that passes
 * here is one a device could actually hold. Kept as its own copy rather than
 * imported: shared/ must not depend on cloud-relay/, and this file is loaded
 * by clients that have no business importing the credential module. */
const DEVICE_ADDRESS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/
const RESERVED_ADDRESS_PATTERN = /^@[a-z][a-z0-9-]{1,30}$/
/* Underscores joined the charset for the approval contract, whose kinds are
 * 'approval_request' and 'approval_decision' (shared/approvalMesh.js) — frozen
 * with the underscore in them, so the pattern moved rather than the contract.
 * Segments still begin with a letter or digit; dots still separate them. */
const KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_]*){0,5}$/
const MESSAGE_ID_PATTERN = /^nmsg_[A-Za-z0-9_-]{8,64}$/

/**
 * A node address, or '' if it is not one. Accepts a registered device id or a
 * reserved '@name' address; rejects everything else, including empty strings
 * and the whitespace-padded near-misses a hand-typed config produces.
 */
export function normalizeNodeAddress(value) {
  const address = String(value ?? '').trim()
  if (RESERVED_ADDRESS_PATTERN.test(address)) return address
  return DEVICE_ADDRESS_PATTERN.test(address) ? address : ''
}

export function isReservedNodeAddress(value) {
  return RESERVED_ADDRESS_PATTERN.test(String(value ?? '').trim())
}

/** A message kind, or '' if it is not one. Lowercase dotted verbs only. */
export function normalizeNodeKind(value) {
  const kind = String(value ?? '').trim()
  return kind.length <= 64 && KIND_PATTERN.test(kind) ? kind : ''
}

function randomMessageId(randomBytes) {
  if (typeof randomBytes === 'function') {
    return `nmsg_${Buffer.from(randomBytes(16)).toString('base64url')}`
  }
  /* crypto.getRandomValues exists in Workers, browsers and Node ≥ 19 — the
   * three runtimes that build envelopes. No Node-only import here on purpose:
   * this module is loaded by an MV3 service worker. */
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `nmsg_${btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')}`
}

/**
 * Build a validated envelope, or throw with a message safe to return to the
 * caller (it never quotes the payload — a rejected envelope's contents are
 * the sender's, not the error log's).
 *
 * `from` is a parameter rather than a body field on purpose: the only correct
 * value is the authenticated principal's deviceId, and the only code that
 * knows it is the route handler.
 */
export function createNodeEnvelope({
  from,
  to,
  kind,
  payload = {},
  correlationId = null,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
  randomBytes = null,
  messageId = null,
} = {}) {
  const fromAddress = normalizeNodeAddress(from)
  if (!fromAddress) {
    throw new TypeError('A valid sender node address is required.')
  }

  const toAddress = normalizeNodeAddress(to)
  if (!toAddress) {
    throw new TypeError('A valid `to` node address is required.')
  }
  if (toAddress === fromAddress) {
    /* Not a safety rule, an honesty one: a self-addressed message would sit
     * in your own inbox and look like someone reached you. */
    throw new TypeError('A node cannot address itself.')
  }

  const messageKind = normalizeNodeKind(kind)
  if (!messageKind) {
    throw new TypeError(
      '`kind` must be a dotted lowercase verb, e.g. "browser.tab.open".',
    )
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('`payload` must be a JSON object.')
  }

  const requestedTtl = Number(ttlMs)
  const effectiveTtl =
    Number.isFinite(requestedTtl) && requestedTtl > 0
      ? Math.min(requestedTtl, MAX_TTL_MS)
      : DEFAULT_TTL_MS

  const id = messageId || randomMessageId(randomBytes)
  if (!MESSAGE_ID_PATTERN.test(id)) {
    throw new TypeError('messageId must look like nmsg_<id>.')
  }

  const corr = correlationId ? String(correlationId).trim().slice(0, 128) : null

  const envelope = {
    v: NODE_MESH_PROTOCOL_VERSION,
    id,
    from: fromAddress,
    to: toAddress,
    kind: messageKind,
    payload,
    corr,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + effectiveTtl).toISOString(),
  }

  const bytes = envelopeBytes(envelope)
  if (bytes > MAX_ENVELOPE_BYTES) {
    throw new TypeError(
      `Envelope is ${bytes} B; the ceiling is ${MAX_ENVELOPE_BYTES} B. ` +
        'Put large payloads in R2 and send a reference.',
    )
  }

  return envelope
}

/** Serialized size in bytes — the number the ceiling is enforced against. */
export function envelopeBytes(envelope) {
  const text = JSON.stringify(envelope)
  /* TextEncoder rather than Buffer: same reason as randomMessageId. */
  return new TextEncoder().encode(text).length
}

/** True while the envelope is still deliverable. */
export function envelopeIsLive(envelope, now = Date.now()) {
  const expiresAt = Date.parse(envelope?.expiresAt || '')
  return Number.isFinite(expiresAt) && expiresAt > now
}

/**
 * Parse one envelope off the wire. Returns null for anything that is not a
 * well-formed envelope of a version we speak — a receiver must never have to
 * guess whether `payload` exists.
 */
export function parseNodeEnvelope(input) {
  let candidate = input
  if (typeof input === 'string') {
    try {
      candidate = JSON.parse(input)
    } catch {
      return null
    }
  }
  if (!candidate || typeof candidate !== 'object') return null
  if (candidate.v !== NODE_MESH_PROTOCOL_VERSION) return null
  if (!MESSAGE_ID_PATTERN.test(String(candidate.id || ''))) return null
  if (!normalizeNodeAddress(candidate.from)) return null
  if (!normalizeNodeAddress(candidate.to)) return null
  if (!normalizeNodeKind(candidate.kind)) return null
  if (
    candidate.payload === null ||
    typeof candidate.payload !== 'object' ||
    Array.isArray(candidate.payload)
  ) {
    return null
  }
  return candidate
}
