/*
 * The node mesh switch: any node → any node, without a third node being awake.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 *
 * The Mac was the hub. The browser extension knew one URL (127.0.0.1:8000);
 * the iOS shell could only reach another node by queueing a mac:* job. So a
 * closed lid was not a slow mesh, it was no mesh: the relay — the one body
 * that is awake by construction — could not tell the extension anything at
 * all. This module is the switch that removes the Mac from the path.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, AND WHY IT IS NOT N² SOCKETS
 *
 * The owner asked for O(N²) links. That is a property of the REACHABILITY
 * GRAPH: every ordered pair (A, B) must have a path that needs no third node
 * awake. N sockets into a switching relay give N² reachable pairs, and it is
 * the only shape available — none of these nodes can accept an inbound
 * connection. The extension is a service worker behind a NAT, the phone is on
 * cellular, the pendant is an LTE modem. N² physical sockets would need N²
 * listeners and there are zero. See shared/nodeMesh.js for the long version.
 *
 * ---------------------------------------------------------------------------
 * PUSH, NOT POLL-IN-DISGUISE
 *
 * send → the envelope is written to D1 → the addressee's BridgeHub is rung →
 * a live socket receives {"type":"mail"} and drains immediately. Latency is
 * one round trip, not a poll interval. If no socket is connected the ring is
 * a silent no-op, the row stays in D1, and the node drains it the moment it
 * next connects — which is the "save the tasks for later" half the owner
 * asked for, done durably rather than in a sender's memory.
 *
 * The doorbell carries NO payload, exactly like the Mac's work doorbell. Three
 * reasons, in order of how much they cost to get wrong:
 *   1. A payload on the socket makes delivery depend on the socket being up at
 *      the instant of send. That is the failure the mesh exists to remove.
 *   2. Durable Object RPC counts UTF-16 bytes toward 32 MiB and DO storage is
 *      not where a message queue belongs; D1 already has the queue.
 *   3. One mechanism. The bridge doorbell is proven in production; a second
 *      transport beside it would be the thing that rots.
 * The cost is one extra authenticated round trip per drain. That is the right
 * trade: every payload byte crosses a route where principalOwnsDevice is
 * checked, rather than a socket whose authorization happened at handshake.
 *
 * ---------------------------------------------------------------------------
 * DELIVERY GUARANTEE: at-least-once, with the receiver deduping on
 * `envelope.id`. A drain leases; an ack deletes. A node that crashes between
 * the two gets the batch again when the lease lapses. Exactly-once is not on
 * offer over a network and pretending otherwise would just move the bug into
 * the receiver.
 */
import crypto from 'node:crypto'
import { getCloudflareBindings } from './cloudflareBindings.js'
import {
  createNodeEnvelope,
  MAX_INBOX_PAGE,
  normalizeNodeAddress,
  RELAY_NODE_ADDRESS,
} from '../shared/nodeMesh.js'
import { principalOwnsDevice } from './deviceAuth.js'

/* A hub ring may cost a send this much and no more. A send is often awaited
 * inside a live turn, and a wedged hub must not stall it — the D1 row is
 * already durable by the time we ring, so a timeout costs latency, not mail. */
const RING_TIMEOUT_MS = 1_500

/* How long a drained batch is hidden from a second drain. Long enough to
 * process a page of work, short enough that a crashed node's mail comes back
 * while the sender still cares. */
export const INBOX_LEASE_MS = 60_000

/*
 * Per-inbox ceiling. A node that never connects would otherwise let any
 * sender grow D1 without bound, and the first symptom would be a relay-wide
 * SQLITE_TOOBIG rather than anything pointing at the real culprit. 500
 * envelopes × 64 KiB is a 32 MiB worst case for one dead addressee, which is
 * survivable and loud.
 */
export const MAX_INBOX_DEPTH = 500

/*
 * The machine-readable name for "your credential is fine, that inbox is not
 * yours" — the refusal principalOwnsDevice raises on the inbox routes.
 *
 * It exists because it was the ONE refusal on these routes with no `code`,
 * while scope_denied / credential_predates_capability / unknown_node /
 * inbox_full / invalid_envelope all had one. Clients are told to switch on
 * `code` and never on message text (the text is deliberately vague so a
 * probing token gets no scope-enumeration oracle), so the absence forced them
 * to key on the bare HTTP status instead — and 403 alone cannot separate this
 * from any other 403 the relay might grow later. It is also the likeliest real
 * misconfiguration on these routes: a wrong deviceId.
 *
 * The MESSAGE stays generic on purpose. Adding the code does not widen what a
 * prober learns: it already knew it got a 403 here, and the code names the
 * rule that fired without naming the inbox, the owner, or the scope.
 */
export const OWNERSHIP_DENIED_CODE = 'not_your_inbox'

const WARN_INTERVAL_MS = 60_000
let lastWarnAt = 0

function warnThrottled(message, now = Date.now()) {
  if (now - lastWarnAt < WARN_INTERVAL_MS) return
  lastWarnAt = now
  console.warn(message)
}

/** Test seam. */
export function resetNodeMailboxWarnings() {
  lastWarnAt = 0
}

/**
 * Chain relay-brain letterbox consumers into one `relayMail` function.
 *
 * First refusal in ORDER: the first consumer to answer {consumed:true} wins
 * and the rest never see the envelope, so each consumer stays a one-kind
 * switch and adding a kind to the relay brain means adding a consumer to the
 * chain in server.js — one seam, many kinds, never a second path beside the
 * letterbox. A consumer that throws fails the send loudly (the sender must
 * know the relay did not take the message), same as a single consumer did.
 */
export function composeRelayMail(...consumers) {
  return async (delivery) => {
    for (const consumer of consumers) {
      if (typeof consumer !== 'function') continue
      const answer = await consumer(delivery)
      if (answer?.consumed) return answer
    }
    return { consumed: false }
  }
}

/**
 * Ring one node's doorbell. Resolves to a report and never rejects: the
 * envelope is already durable when this is called, so a hub outage costs
 * latency, not the message.
 *
 * `delivered` counts sockets that actually received the frame. Zero means the
 * node is not connected right now — the honest answer to "is it online",
 * observed rather than inferred from a lastSeenAt timestamp.
 */
export async function ringNodeDoorbell({ deviceId, reason = 'mail' } = {}) {
  const binding = getCloudflareBindings()?.BRIDGE_HUB
  if (!binding?.idFromName) {
    return { rung: false, delivered: 0, reason: 'no_hub_binding' }
  }
  const address = normalizeNodeAddress(deviceId)
  if (!address) {
    return { rung: false, delivered: 0, reason: 'invalid_address' }
  }

  try {
    const stub = binding.get(binding.idFromName(address))
    const response = await stub.fetch('https://bridge-hub/deliver', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
      signal: AbortSignal.timeout(RING_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => ({}))
    return { rung: true, delivered: Number(payload?.delivered || 0) }
  } catch (error) {
    warnThrottled(
      `[relay] Node doorbell failed for a mesh message: ${error?.message || error} — the envelope is queued and will deliver on reconnect.`,
    )
    return { rung: false, delivered: 0, reason: error?.message || 'ring_failed' }
  }
}

/** Live-socket presence for one node, observed rather than inferred. */
export async function nodePresence({ deviceId } = {}) {
  const binding = getCloudflareBindings()?.BRIDGE_HUB
  const address = normalizeNodeAddress(deviceId)
  if (!binding?.idFromName || !address) {
    return { connected: false, sockets: 0, since: null, observed: false }
  }
  try {
    const stub = binding.get(binding.idFromName(address))
    const response = await stub.fetch('https://bridge-hub/presence', {
      signal: AbortSignal.timeout(RING_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => ({}))
    return {
      connected: Boolean(payload?.connected),
      sockets: Number(payload?.sockets || 0),
      since: payload?.since ?? null,
      observed: true,
    }
  } catch {
    /* `observed: false` is not `connected: false`. The difference is the whole
     * point: we do not know, and saying "offline" would be a guess. */
    return { connected: false, sockets: 0, since: null, observed: false }
  }
}

/**
 * Route one message: validate, persist, ring.
 *
 * Order is load-bearing and matches ringBridgeDoorbell's: the row exists
 * BEFORE the doorbell. A ring that arrives before the row would send the
 * addressee to drain an inbox that does not yet contain its message, and the
 * node would go back to sleep having seen nothing.
 */
export async function sendNodeMessage({
  store,
  from,
  to,
  kind,
  payload,
  correlationId = null,
  ttlMs,
  now = Date.now(),
  /*
   * The relay brain's letterbox. Mail addressed to '@relay' used to have
   * exactly one fate — queue in D1 with no drainer, forever — because the
   * relay is the switch and nothing ever rang its own doorbell. A consumer
   * passed here gets first refusal on such mail: it returns
   * `{consumed: true, receipt}` to answer the message synchronously (the row
   * is never written; the sender gets the receipt in the send response), or
   * `{consumed: false}` to let the kind queue exactly as before. Consumers:
   * approvalDelivery.js's 'approval_decision' handler and
   * browserTaskHistory.js's 'browser.task.record' handler, chained with
   * composeRelayMail() and wired in server.js.
   */
  relayMail = null,
} = {}) {
  const envelope = createNodeEnvelope({
    from,
    to,
    kind,
    payload,
    correlationId,
    ttlMs,
    now,
  })

  const target = normalizeNodeAddress(envelope.to)
  if (target === RELAY_NODE_ADDRESS && typeof relayMail === 'function') {
    const answer = await relayMail({ store, envelope, now })
    if (answer?.consumed) {
      return {
        envelope,
        /* Neither pushed nor queued: the relay took it off the sender's hands
         * in this very request, so there is nothing left in flight. */
        pushed: false,
        queued: false,
        consumed: true,
        receipt: answer.receipt ?? null,
        ring: { rung: false, delivered: 0, reason: 'consumed_by_relay' },
      }
    }
  }
  if (target !== RELAY_NODE_ADDRESS) {
    /* An unregistered addressee is a typo, and a typo that queues silently is
     * a message the sender believes it sent. Refuse it while the caller is
     * still holding the stack that can report it. */
    const device = await store.getDevice(target)
    if (!device) {
      const error = new Error(
        `No node is registered as "${target}", so nothing could ever drain that inbox.`,
      )
      error.code = 'unknown_node'
      throw error
    }
  }

  const depth = await store.countPendingNodeMessages(target, { now })
  if (depth >= MAX_INBOX_DEPTH) {
    const error = new Error(
      `The inbox for "${target}" is full (${depth} undelivered messages). ` +
        'That node has not drained in a long time.',
    )
    error.code = 'inbox_full'
    throw error
  }

  await store.enqueueNodeMessage(envelope)
  const ring = await ringNodeDoorbell({ deviceId: target, reason: 'mail' })

  return {
    envelope,
    /* True only when a live socket received the doorbell. False means the
     * message is parked and will be delivered on reconnect — the caller is
     * told which happened rather than left to assume. */
    pushed: ring.delivered > 0,
    queued: ring.delivered === 0,
    ring,
  }
}

/** Lease the next page of a node's mail. */
export async function drainNodeInbox({
  store,
  deviceId,
  limit = MAX_INBOX_PAGE,
  leaseMs = INBOX_LEASE_MS,
  now = Date.now(),
} = {}) {
  const address = normalizeNodeAddress(deviceId)
  if (!address) return { messages: [], pending: 0 }

  const messages = await store.leaseNodeMessages(address, {
    limit: Math.min(Math.max(Number(limit) || MAX_INBOX_PAGE, 1), MAX_INBOX_PAGE),
    leaseMs,
    leaseToken: crypto.randomUUID(),
    now,
  })
  const pending = await store.countPendingNodeMessages(address, { now })
  return { messages, pending }
}

/**
 * Express routes for the mesh.
 *
 * Registered from server.js AFTER the auth middleware, so every handler here
 * can rely on request.relayPrincipal existing and on the scope table having
 * already run. The scopes live in relayScopes.js; what these handlers add is
 * the half a scope cannot express — WHICH inbox you may touch.
 */
export function registerNodeMeshRoutes(app, { getStore, relayMail = null }) {
  /* POST /v1/node/messages — send. */
  app.post('/v1/node/messages', async (request, response) => {
    const principal = request.relayPrincipal
    const store = await getStore()

    /*
     * `from` is taken from the credential, NEVER from the body. A sender that
     * could name itself could impersonate the Mac to the extension, and the
     * receiver's only basis for trusting a message is this field. An admin
     * principal has no deviceId of its own, so it speaks as the relay.
     */
    const from =
      principal?.kind === 'device' ? principal.deviceId : RELAY_NODE_ADDRESS

    try {
      const result = await sendNodeMessage({
        store,
        from,
        to: request.body?.to,
        kind: request.body?.kind,
        payload: request.body?.payload ?? {},
        correlationId: request.body?.correlationId ?? null,
        ttlMs: request.body?.ttlMs,
        relayMail,
      })
      response.status(202).json({
        ok: true,
        messageId: result.envelope.id,
        to: result.envelope.to,
        from: result.envelope.from,
        expiresAt: result.envelope.expiresAt,
        pushed: result.pushed,
        queued: result.queued,
        /* Present only when the relay answered the message in this request —
         * the sender learns the outcome without draining anything. */
        ...(result.consumed ? { consumed: true, receipt: result.receipt } : {}),
      })
    } catch (error) {
      const status = error?.code === 'inbox_full' ? 429 : 400
      response.status(status).json({
        ok: false,
        code: error?.code || 'invalid_envelope',
        error: error?.message || 'Could not route that message.',
      })
    }
  })

  /* GET /v1/node/inbox?deviceId=… — drain. */
  app.get('/v1/node/inbox', async (request, response) => {
    const deviceId = String(request.query?.deviceId ?? '').trim()
    if (!deviceId) {
      response
        .status(400)
        .json({ ok: false, error: 'deviceId query parameter is required.' })
      return
    }
    if (!principalOwnsDevice(request.relayPrincipal, deviceId)) {
      /* The scope said "you may drain an inbox". This says "not that one". */
      response.status(403).json({
        ok: false,
        code: OWNERSHIP_DENIED_CODE,
        error: 'Blocked for safety: a node may only drain its own inbox.',
      })
      return
    }

    const store = await getStore()
    const { messages, pending } = await drainNodeInbox({ store, deviceId })
    response.json({
      ok: true,
      deviceId,
      messages,
      /* Still waiting AFTER this page, including the leased ones. A drainer
       * that sees pending > messages.length should come back. */
      pending,
      leaseMs: INBOX_LEASE_MS,
    })
  })

  /* POST /v1/node/inbox/ack — acknowledge, which deletes. */
  app.post('/v1/node/inbox/ack', async (request, response) => {
    const deviceId = String(request.body?.deviceId ?? '').trim()
    const messageIds = Array.isArray(request.body?.messageIds)
      ? request.body.messageIds.slice(0, MAX_INBOX_PAGE).map(String)
      : []

    if (!deviceId) {
      response
        .status(400)
        .json({ ok: false, error: 'deviceId is required.' })
      return
    }
    if (!principalOwnsDevice(request.relayPrincipal, deviceId)) {
      response.status(403).json({
        ok: false,
        code: OWNERSHIP_DENIED_CODE,
        error: 'Blocked for safety: a node may only acknowledge its own mail.',
      })
      return
    }

    const store = await getStore()
    const acknowledged = await store.ackNodeMessages(deviceId, messageIds)
    const pending = await store.countPendingNodeMessages(deviceId)
    response.json({ ok: true, acknowledged, pending })
  })

  /*
   * GET /v1/node/presence?deviceId=… — is that node holding a socket now.
   *
   * NO principalOwnsDevice here, deliberately: asking about a node is not the
   * same privilege as using it, and this is what makes "is the Mac connected
   * right now" answerable from the phone. The scope table gates it on
   * device:status:read (NOT node:message:receive) for the same reason.
   *
   * THREE INDEPENDENT FACTS, and a client that collapses any two of them will
   * lie to the owner:
   *
   *   known      is there a registered node by that deviceId at all
   *   observed   could we reach its hub to ask
   *   connected  is it holding a live socket this second
   *
   * `known` is the one added last, and it was added because without it a
   * deviceId that was never paired answered `connected:false, observed:true` —
   * character for character what a real, registered, currently-asleep node
   * answers. Those want opposite client behaviour: one is a typo to correct,
   * the other is the normal resting state of a node and should be rendered as
   * nothing at all.
   *
   * It is a SEPARATE FIELD rather than a new value of `observed` on purpose.
   * `observed:false` already means "we could not ask", which clients are told
   * never to render as a dead node; spending that value on "there is nothing
   * to ask about" would collapse a distinction that is already load-bearing,
   * and would silently change the meaning of today's answers for every client
   * that has not been updated. Orthogonal facts, orthogonal fields.
   *
   * The hub is still asked for an unknown deviceId, so `connected`/`observed`
   * keep exactly the values they have today and this is additive for every
   * existing caller. The wasted round trip is the price of that compatibility,
   * and it is bounded by the same scope check as any other presence query.
   */
  app.get('/v1/node/presence', async (request, response) => {
    const deviceId = String(request.query?.deviceId ?? '').trim()
    if (!deviceId) {
      response
        .status(400)
        .json({ ok: false, error: 'deviceId query parameter is required.' })
      return
    }
    const store = await getStore()
    const presence = await nodePresence({ deviceId })
    /* Same registry `sendNodeMessage` refuses an unknown addressee against,
     * INCLUDING its exemption for the reserved '@relay' address, so the two
     * routes cannot disagree about which addresses exist — a `to` the send
     * route accepts must never come back `known:false` here. Pairing writes
     * the device row and the credential together (server.js /v1/devices/pair),
     * so a node that can authenticate at all is `known`. */
    const known =
      normalizeNodeAddress(deviceId) === RELAY_NODE_ADDRESS
        ? true
        : Boolean(await store.getDevice(deviceId))
    response.json({
      ok: true,
      deviceId,
      known,
      ...presence,
      pending: await store.countPendingNodeMessages(deviceId),
    })
  })
}
