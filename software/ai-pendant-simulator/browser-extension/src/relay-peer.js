/*
 * The extension's SECOND peer: the relay, reached directly.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 *
 * Every relay→extension hop went through the Mac at http://127.0.0.1:8000.
 * bridge-core.js refused any other host, and manifest.json granted no other
 * origin, so the relay — the one body that is awake by construction — could
 * not tell this extension anything at all once the lid closed. This module is
 * the other half of the node mesh (shared/nodeMesh.js) seen from inside a
 * browser: drain my own inbox, act on what is addressed to me, answer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A POLLER AND NOT A SOCKET
 *
 * The mesh was designed around a doorbell: GET /v1/node/socket, one frame
 * {"type":"mail"}, drain immediately. A browser cannot open it. Verified
 * against the live relay on 2026-08-09:
 *
 *   Upgrade + Authorization: Bearer <device token>  -> 101 Switching Protocols
 *   Upgrade, no Authorization header                -> 401
 *   Upgrade + Sec-WebSocket-Protocol: bearer.<tok>  -> 401
 *
 * The WebSocket constructor available to a service worker cannot set request
 * headers; its only extension point is the subprotocol argument, and
 * cloudflare-worker/bridgeHub.js handleHubUpgrade reads Authorization and
 * nothing else. So the doorbell is closed to this node until the relay learns
 * to accept a credential a browser can actually send. Until then the durable
 * half of the mesh — the D1 queue behind GET /v1/node/inbox — is reachable
 * over ordinary authenticated HTTPS and delivers every message, just later.
 *
 * The property the owner asked for survives: relay → extension with the Mac
 * asleep. What is lost is latency, and only latency: a poll interval instead
 * of one round trip. That trade is stated here rather than hidden in a comment
 * about "eventual" delivery, because it is the one thing a reader of this file
 * should not have to discover by measuring.
 *
 * ---------------------------------------------------------------------------
 * TWO PEERS, NOT A NEW SINGLE POINT OF FAILURE
 *
 * The Mac path is untouched. choosePeer() below is the whole policy, written
 * as a pure function so it can be asserted rather than inferred from timing:
 * listen on BOTH peers whenever both are configured, prefer the Mac for
 * outbound because it is a loopback round trip, and poll the relay harder the
 * moment the Mac stops answering. Listening on both is not redundancy for its
 * own sake — mesh mail is durable, so a relay message sent while the Mac is
 * healthy must still be read, or "two reachable peers" is a slogan.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE IS PURE. No fetch, no storage, no browser APIs. The impure
 * edges live in background.js and are injected, the same split brain.js uses.
 */
import {
  envelopeIsLive,
  MAX_ENVELOPE_BYTES,
  normalizeNodeAddress,
  parseNodeEnvelope,
  RELAY_NODE_ADDRESS,
} from '../../shared/nodeMesh.js'
import { COMMAND_TYPES } from './bridge-core.js'

export { RELAY_NODE_ADDRESS }

/* ===================================================================== *
 * The origin boundary.
 * ===================================================================== */

/*
 * The relay origins this extension may speak to, by name.
 *
 * An allowlist rather than "https is enough", for the reason the loopback rule
 * in bridge-core.js exists at all: the value that decides where the extension
 * points lives in storage.local, and the check is what stands between a bad
 * write to that key and a device token being posted to somebody else's host.
 * "Any https origin" would make the token bearer-usable by whoever won the
 * race to set the URL.
 *
 * Loopback http is here for `npm run relay`, which serves the identical route
 * table on 8787. It is a development origin on the owner's own machine, which
 * is the same argument that keeps the Mac agent on loopback.
 */
export const RELAY_ORIGIN_ALLOWLIST = Object.freeze([
  'https://ai-pendant-relay.your-subdomain.workers.dev',
  'http://127.0.0.1:8787',
  'http://localhost:8787',
])

/**
 * A usable relay origin, or ''.
 *
 * Deliberately NOT a widening of normalizeAgentUrl(). That function's output
 * is the base URL background.js sends `Authorization: Bearer <agentToken>` to,
 * and agentToken is the MAC's credential. One URL field covering two origins
 * therefore means one field that can aim either credential at either host —
 * and the failure is silent, because both hosts answer 401 the same way. Two
 * fields, two allowlists, one credential bound to each: a misconfiguration
 * then costs a failed request instead of a leaked token.
 */
export function normalizeRelayUrl(value) {
  const candidate = String(value ?? '').trim()
  if (!candidate) return ''

  let url
  try {
    url = new URL(candidate)
  } catch {
    return ''
  }

  if (url.username || url.password || url.search || url.hash) return ''
  if (url.pathname !== '/' && url.pathname !== '') return ''
  return RELAY_ORIGIN_ALLOWLIST.includes(url.origin) ? url.origin : ''
}

/** The host_permissions match pattern for an allowlisted origin. */
export function relayOriginPattern(origin) {
  const normalized = normalizeRelayUrl(origin)
  return normalized ? `${normalized}/*` : ''
}

/* ===================================================================== *
 * Configuration.
 * ===================================================================== */

export const RELAY_STORAGE_KEYS = Object.freeze([
  'relayEnabled',
  'relayUrl',
  'relayDeviceId',
  'deviceToken',
  'meshTrustedSenders',
])

export const RELAY_DEFAULTS = Object.freeze({
  relayEnabled: false,
  relayUrl: null,
  relayDeviceId: null,
  deviceToken: null,
})

/*
 * Who may drive this browser over the mesh.
 *
 * '@relay' is the relay brain, and it is the only address the relay itself can
 * stamp for a principal that holds no deviceId. Everything else has to be
 * named by the owner. This matters because node:message:send is held by every
 * role in DEVICE_SCOPES — a second browser_node credential can address this
 * one — and "authenticated to the same relay" is not the same claim as
 * "allowed to open tabs in my Safari". Mail from an untrusted sender is still
 * received and still acked; it is simply not executed, and says so.
 */
export const DEFAULT_TRUSTED_SENDERS = Object.freeze([RELAY_NODE_ADDRESS])

export function normalizeTrustedSenders(value, extra = []) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '')
        .split(/[\s,]+/)
        .filter(Boolean)
  const senders = new Set(DEFAULT_TRUSTED_SENDERS)
  for (const candidate of [...raw, ...extra]) {
    const address = normalizeNodeAddress(candidate)
    if (address) senders.add(address)
  }
  return [...senders]
}

/**
 * Refuses to report `ready` unless the origin, the address and the credential
 * are all present and sane — the same discipline normalizeBrainConfig uses, so
 * a half-configured relay peer behaves exactly like an absent one.
 */
export function normalizeRelayConfig(values = {}) {
  const relayEnabled = values.relayEnabled === true
  const relayUrl = normalizeRelayUrl(values.relayUrl) || null
  const relayDeviceId = normalizeNodeAddress(values.relayDeviceId) || null
  const deviceToken = String(values.deviceToken ?? '').trim() || null

  let reason = ''
  if (!relayEnabled) {
    reason = 'The relay peer is switched off (relayEnabled is not true).'
  } else if (!relayUrl) {
    reason =
      'No usable relayUrl is configured. It must be one of the allowlisted relay origins.'
  } else if (!relayDeviceId) {
    reason =
      'No relayDeviceId is configured — that is the address the relay delivers this extension\'s mail to.'
  } else if (!deviceToken) {
    reason =
      'No deviceToken is configured — pair this browser with `pendant-credentials.mjs pair --role browser_node`.'
  }

  return {
    relayEnabled,
    relayUrl,
    relayDeviceId,
    deviceToken,
    trustedSenders: normalizeTrustedSenders(values.meshTrustedSenders),
    ready:
      relayEnabled && Boolean(relayUrl) && Boolean(relayDeviceId) && Boolean(deviceToken),
    reason,
  }
}

/* ===================================================================== *
 * Request shapes. Built here, sent by background.js.
 * ===================================================================== */

/**
 * Descriptors rather than fetches, so every URL, method and body this module
 * can produce is assertable in a unit test without a network or a mock.
 * `auth: 'device'` is a marker: the caller supplies the token, this module
 * never holds it and never puts it in a URL.
 */
export function inboxRequest(config) {
  return {
    method: 'GET',
    path: `/v1/node/inbox?deviceId=${encodeURIComponent(config.relayDeviceId)}`,
    auth: 'device',
    body: null,
  }
}

export function ackRequest(config, messageIds) {
  return {
    method: 'POST',
    path: '/v1/node/inbox/ack',
    auth: 'device',
    body: { deviceId: config.relayDeviceId, messageIds: [...messageIds] },
  }
}

export function sendRequest(config, { to, kind, payload, correlationId = null, ttlMs }) {
  return {
    method: 'POST',
    path: '/v1/node/messages',
    auth: 'device',
    /* `from` is deliberately absent. The relay stamps it from the authenticated
     * principal and ignores a body-supplied one (cloud-relay/nodeMailbox.js),
     * so sending it would only encourage a reader to believe it means
     * something. Verified live: a body carrying from:'@relay' came back
     * stamped with this device's own id. */
    body: {
      to,
      kind,
      payload,
      ...(correlationId ? { correlationId } : {}),
      ...(Number.isFinite(ttlMs) ? { ttlMs } : {}),
    },
  }
}

/* ===================================================================== *
 * At-least-once: the dedupe ledger.
 * ===================================================================== */

/*
 * A drain leases for INBOX_LEASE_MS (60 s) and an ack deletes. A node that
 * dies between the two gets the batch again — and this node dies constantly,
 * because Safari suspends MV3 service workers whenever it likes. So the ledger
 * CANNOT live only in module scope the way the command ledger does: the exact
 * window redelivery happens in is the window a worker restart fits inside.
 * createEnvelopeLedger is therefore a plain serializable object the caller
 * persists to storage.local.
 */
export const ENVELOPE_LEDGER_MAX = 400

export function createEnvelopeLedger(seen = {}) {
  const entries = {}
  for (const [id, expiresAt] of Object.entries(seen ?? {})) {
    const at = Number(expiresAt)
    if (Number.isFinite(at)) entries[id] = at
  }
  return entries
}

/** Forget ids whose envelopes could no longer be delivered anyway. */
export function pruneEnvelopeLedger(ledger, now = Date.now(), max = ENVELOPE_LEDGER_MAX) {
  const live = Object.entries(ledger).filter(([, expiresAt]) => expiresAt > now)
  /* Oldest expiry first, so the entries dropped under pressure are the ones
   * closest to being harmless. */
  live.sort((left, right) => left[1] - right[1])
  return Object.fromEntries(live.slice(Math.max(0, live.length - max)))
}

/* ===================================================================== *
 * What arrived, and what may act.
 * ===================================================================== */

/*
 * The mesh's own expiry is the sender's declared window, and it is the right
 * clock for mail — bridge-core's MAX_COMMAND_AGE_MS (90 s) is not, because
 * queue-while-you-sleep is the property the mesh exists to provide and a 90 s
 * rule would throw away exactly the messages it was built to keep.
 *
 * But shared/nodeMesh.js lets a sender ask for MAX_TTL_MS = 24 h, and a tab
 * opening in the owner's Safari a day after anyone stopped waiting for it is
 * the surprise MAX_COMMAND_AGE_MS was written to prevent. So the receiver
 * keeps a ceiling of its own, set to the mesh's DEFAULT_TTL_MS: the default
 * case is unchanged, and a sender who asked for a day gets ten minutes of
 * actionability rather than a day of it.
 */
export const MAX_MESH_COMMAND_AGE_MS = 10 * 60_000

/** kind → what this extension does with it. */
export const MESH_KINDS = Object.freeze({
  /* payload: {type, params, idempotencyKey?} — one of the 11 page commands. */
  'browser.command': 'command',
  /* payload: {} — answer with presence. Costs nothing, proves reachability. */
  'browser.ping': 'ping',
})

export const MESH_RESULT_KIND = 'browser.command.result'
export const MESH_PONG_KIND = 'browser.pong'

/*
 * A result payload must fit MAX_ENVELOPE_BYTES with room for the envelope
 * around it. read_page returns up to 50 000 characters, so overflow is the
 * normal case rather than the exotic one, and the mesh's answer to a large
 * payload — put it in R2 and send a reference — is not available to a browser
 * extension, which holds no R2 credential. Truncating and SAYING SO is the
 * only honest option left: a caller that receives half a page and is told it
 * received half a page can ask for less, while a caller whose message was
 * silently dropped at the relay learns nothing.
 */
export const MAX_RESULT_PAYLOAD_BYTES = MAX_ENVELOPE_BYTES - 2_048

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null
const byteLength = (value) => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  return encoder ? encoder.encode(text).length : text.length * 2
}

export function fitResultPayload(payload, max = MAX_RESULT_PAYLOAD_BYTES) {
  if (byteLength(payload) <= max) return { payload, truncated: false }

  const trimmed = { ...payload }
  const result = trimmed.result && typeof trimmed.result === 'object'
    ? { ...trimmed.result }
    : null

  if (result && typeof result.content === 'string') {
    /* Halve until it fits. Bounded by the string shrinking every pass. */
    let content = result.content
    while (content.length > 64) {
      content = content.slice(0, Math.floor(content.length / 2))
      result.content = `${content}\n[truncated to fit the 64 KiB node-mesh envelope]`
      trimmed.result = result
      if (byteLength(trimmed) <= max) {
        return { payload: { ...trimmed, truncated: true }, truncated: true }
      }
    }
  }

  /* Nothing text-shaped to shrink — a capture's imageDataUrl, most likely.
   * Keep the fact and the shape, drop the bytes. */
  return {
    payload: {
      ok: payload?.ok === true,
      truncated: true,
      error:
        'The result did not fit a 64 KiB node-mesh envelope and no text field could be ' +
        'trimmed. Screenshots and other large blobs cannot cross the mesh; ask the Mac ' +
        'peer for them, or ask for a narrower selector.',
    },
    truncated: true,
  }
}

/**
 * Sort one drained page into what to run, what to ignore, and what to ack.
 *
 * EVERYTHING drained is acked, including duplicates, expired mail and mail
 * this node refuses to execute. An ack is "I have this", not "I did this" —
 * leaving a message unacked because it was refused would guarantee it comes
 * back every 60 s forever, and the inbox would fill until MAX_INBOX_DEPTH
 * started rejecting the sends that mattered.
 */
export function acceptEnvelopes(rawMessages, { ledger = {}, config, now = Date.now() } = {}) {
  const trusted = new Set(config?.trustedSenders ?? DEFAULT_TRUSTED_SENDERS)
  const self = normalizeNodeAddress(config?.relayDeviceId)
  const seen = { ...ledger }

  const run = []
  const ignored = []
  const ackIds = []

  for (const raw of Array.isArray(rawMessages) ? rawMessages : []) {
    const envelope = parseNodeEnvelope(raw)
    if (!envelope) {
      /* Unparseable and therefore unackable: with no id there is nothing to
       * name in an ack. It expires on its own. */
      ignored.push({ envelope: null, reason: 'not a node-mesh envelope of a version we speak' })
      continue
    }

    ackIds.push(envelope.id)

    if (envelope.id in seen) {
      ignored.push({ envelope, reason: 'already handled (at-least-once redelivery)' })
      continue
    }
    seen[envelope.id] = Date.parse(envelope.expiresAt) || now + MAX_MESH_COMMAND_AGE_MS

    if (self && envelope.to !== self) {
      ignored.push({ envelope, reason: `addressed to ${envelope.to}, not to this node` })
      continue
    }
    if (!envelopeIsLive(envelope, now)) {
      ignored.push({ envelope, reason: 'expired before it was drained' })
      continue
    }

    const handling = MESH_KINDS[envelope.kind]
    if (!handling) {
      ignored.push({ envelope, reason: `no handler for kind "${envelope.kind}"` })
      continue
    }

    if (!trusted.has(envelope.from)) {
      ignored.push({
        envelope,
        reason:
          `"${envelope.from}" is not a trusted sender for this browser. ` +
          'Add it to meshTrustedSenders to let it drive tabs.',
      })
      continue
    }

    const age = now - (Date.parse(envelope.createdAt) || now)
    if (age > MAX_MESH_COMMAND_AGE_MS) {
      ignored.push({
        envelope,
        reason: `queued ${Math.round(age / 1000)}s ago; this node refuses mesh mail older than ${
          MAX_MESH_COMMAND_AGE_MS / 60_000
        } minutes`,
      })
      continue
    }

    run.push({ envelope, handling })
  }

  return { run, ignored, ackIds, ledger: seen }
}

/**
 * A mesh envelope, shaped as the command the extension already knows how to
 * validate and execute — so mesh-borne work goes through exactly the same
 * validateCommand / sanitizeExtraction path as Mac-borne work, with no second
 * executor to keep in sync and no shortcut past the privacy boundary.
 *
 * createdAt is stamped at DELIVERY, not copied from the envelope: acceptEnvelopes
 * above has already applied the mesh's own freshness rules, and letting
 * bridge-core's 90 s rule run a second time over the same field would refuse
 * every message the durable queue held while the browser was closed.
 */
export function envelopeToCommand(envelope, now = Date.now()) {
  const payload = envelope?.payload ?? {}
  const type = String(payload.type ?? '').trim()
  if (!COMMAND_TYPES.has(type)) {
    throw new Error(
      `"${type || '(none)'}" is not a browser command this extension can run.`,
    )
  }
  return {
    commandId: envelope.id,
    /* Two sends of the same act collapse; absent that, the envelope id is
     * already a perfectly good replay identity. */
    idempotencyKey: String(payload.idempotencyKey ?? '').trim() || undefined,
    createdAt: new Date(now).toISOString(),
    source: 'node-mesh',
    from: envelope.from,
    action: {
      type,
      params: payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
        ? payload.params
        : {},
    },
  }
}

/** The answer to a `browser.command`, addressed back at whoever asked. */
export function resultMessageFor(envelope, outcome, config) {
  const { payload, truncated } = fitResultPayload({
    ok: outcome?.ok === true,
    ...(outcome?.ok === true ? { result: outcome.result } : { error: String(outcome?.error ?? 'Command failed.') }),
  })
  return {
    ...sendRequest(config, {
      to: envelope.from,
      kind: MESH_RESULT_KIND,
      payload,
      correlationId: envelope.id,
    }),
    truncated,
  }
}

export function pongMessageFor(envelope, presence, config) {
  return sendRequest(config, {
    to: envelope.from,
    kind: MESH_PONG_KIND,
    payload: { ...presence, address: config.relayDeviceId },
    correlationId: envelope.id,
  })
}

/* ===================================================================== *
 * The policy: which peer, when.
 * ===================================================================== */

/*
 * How recently the Mac must have answered to count as present. The Mac poll
 * loop heartbeats every 12 s (HEARTBEAT_INTERVAL_MS in background.js), so
 * 40 s is three missed heartbeats — long enough not to flap across one slow
 * request, short enough that a closed lid is noticed before the owner is.
 */
export const MAC_FRESH_MS = 40_000

/* Relay poll cadences. The slow one is what a healthy Mac costs: mesh mail is
 * durable, so a message that waits 30 s is late, not lost. The fast one is
 * what the relay becomes when it is the only way through. */
export const RELAY_POLL_IDLE_MS = 30_000
export const RELAY_POLL_ACTIVE_MS = 3_000

/**
 * The whole routing policy, as one pure function.
 *
 * Written this way on purpose. "Prefer the Mac, fall back to the relay" is the
 * kind of rule that otherwise lives as an emergent property of two independent
 * loops and their timeouts, where the only way to find out what it does is to
 * unplug something and watch. Here it is a table a test can assert.
 *
 * The key decision: `inbound` lists BOTH peers whenever both are usable. A
 * mesh message is durable and silent — nothing tells the extension it exists —
 * so an extension that only drained its inbox while the Mac was down would
 * leave relay mail unread for as long as the Mac stayed up. Preferring the Mac
 * is a statement about where WORK GOES OUT, not about what is listened to.
 */
export function choosePeer({
  macConfigured = false,
  macLastOkAt = 0,
  relayReady = false,
  now = Date.now(),
} = {}) {
  const macFresh = macConfigured && now - macLastOkAt <= MAC_FRESH_MS
  const inbound = []
  if (macConfigured) inbound.push('mac')
  if (relayReady) inbound.push('relay')

  const outbound = macFresh ? 'mac' : relayReady ? 'relay' : macConfigured ? 'mac' : null

  let reason
  if (!macConfigured && !relayReady) {
    reason = 'Neither peer is configured; this extension is unreachable.'
  } else if (macFresh && relayReady) {
    reason =
      'Both peers reachable: results go to the Mac (loopback is faster), the relay inbox is drained on a slow cadence.'
  } else if (macFresh) {
    reason = 'Only the Mac is configured; the relay peer is off or unconfigured.'
  } else if (relayReady && macConfigured) {
    reason = `The Mac has not answered in ${Math.round((now - macLastOkAt) / 1000)}s; the relay is carrying this node.`
  } else if (relayReady) {
    reason = 'Only the relay is configured; there is no Mac peer.'
  } else {
    reason = 'The Mac is configured but silent, and there is no relay peer to fall back to.'
  }

  return {
    inbound,
    outbound,
    macFresh,
    relayPollMs: macFresh ? RELAY_POLL_IDLE_MS : RELAY_POLL_ACTIVE_MS,
    reason,
  }
}

/** One line for the popup and the status store. Never names a credential. */
export function describeRelayPeer(config, choice) {
  if (!config.ready) return `Relay peer: off — ${config.reason}`
  return `Relay peer: ${config.relayDeviceId} @ ${config.relayUrl} — ${choice.reason}`
}
