/*
 * The phone's side of the node mesh: one drain path, one dedupe ledger, one
 * doorbell.
 *
 * WHY THIS IS NOT IN mobileTools.js. That file is a dispatch table — a map of
 * name → run(). A socket that reconnects, pings for the life of the app and
 * drains mail nobody asked for is a lifecycle object, and the two have nothing
 * in common but the word "mesh". What they DO share is the drain, so the drain
 * lives here and the tool is a thin wrapper over it. Two drainers with two
 * dedupe ledgers would race, and the symptom would be the model being told
 * "no mail" about mail that had just arrived.
 *
 * ---------------------------------------------------------------------------
 * AT-LEAST-ONCE IS THE CONTRACT, NOT A CAVEAT
 *
 * A drain LEASES for 60 s; an ack DELETES. A node that dies between the two
 * gets the batch again when the lease lapses — and this node dies constantly,
 * because iOS suspends a backgrounded WKWebView whenever it likes. So dedupe
 * on `envelope.id` is not defensive programming, it is the receiving half of
 * the protocol. `seenEnvelopes` below is that half.
 *
 * The ledger is module scope, which means it is lost on app restart. That is
 * the honest ceiling of an in-memory ledger and it is stated rather than hidden:
 * a message redelivered across a restart WILL be reported as new. The window is
 * one lease (60 s) and the cost is a duplicate line in a prompt, not a duplicate
 * action — the phone's brain reads mail, it does not execute it. The browser
 * extension, which does execute mesh mail, persists its ledger to
 * storage.local for exactly this reason (browser-extension/src/relay-peer.js).
 *
 * ---------------------------------------------------------------------------
 * WHY THE LISTENER ACKS, AND WHY IT KEEPS A BUFFER
 *
 * An ack means "I have this", not "I did this" — the same rule the extension
 * follows. A drainer that withholds acks until something acts on the mail gets
 * the whole batch back every 60 s forever, and the inbox climbs toward
 * MAX_INBOX_DEPTH until sends to this phone start being refused.
 *
 * But acking makes the mail gone, and the socket drains without anyone asking.
 * If that were the end of it, mail that arrived while the app was open would be
 * deleted before the model ever saw it — strictly worse than having no socket.
 * So drained envelopes land in `delivered` below, and mesh_inbox reads that
 * buffer before it touches the network. The socket makes mail arrive sooner; it
 * never makes it arrive to nobody.
 */
import {
  BRIDGE_MAIL_FRAME,
  BRIDGE_PING_FRAME,
  BRIDGE_PING_INTERVAL_MS,
  parseBridgeFrame,
} from '../../shared/bridgeSocketProtocol.js'
import { parseNodeEnvelope } from '../../shared/nodeMesh.js'

/* Ids stay remembered a little past the lease they could be redelivered under.
 * Anything longer is memory spent on a message that can no longer come back. */
const LEDGER_TTL_MS = 5 * 60_000
const LEDGER_MAX = 400

/* Mail the socket drained that nothing has read yet. Bounded because an app
 * left open all day with no reader must not grow without limit; the OLDEST is
 * dropped, since the newest is the part still worth acting on. */
const DELIVERED_MAX = 100

const seenEnvelopes = new Map()
let delivered = []

/** Test seam, and what a re-pair should call: forget everything. */
export function resetMeshMailbox() {
  seenEnvelopes.clear()
  delivered = []
}

/** How many drained-but-unread envelopes are waiting locally. */
export function bufferedMeshMail() {
  return delivered.length
}

function pruneLedger(now) {
  for (const [id, expiresAt] of seenEnvelopes) {
    if (expiresAt <= now) seenEnvelopes.delete(id)
  }
  /* Insertion-ordered, so the front is the oldest. */
  while (seenEnvelopes.size > LEDGER_MAX) {
    const oldest = seenEnvelopes.keys().next().value
    if (oldest === undefined) break
    seenEnvelopes.delete(oldest)
  }
}

/**
 * Split a drained page into what this node has not seen and what it has.
 *
 * Every id is remembered and every id is ackable, duplicates included: an ack
 * for a message already deleted is a no-op, and skipping it would leave the
 * duplicate to come back again on the next lease.
 */
export function sortMeshEnvelopes(rawMessages, { now = Date.now() } = {}) {
  pruneLedger(now)

  const fresh = []
  const duplicates = []
  const ackIds = []

  for (const raw of Array.isArray(rawMessages) ? rawMessages : []) {
    const envelope = parseNodeEnvelope(raw)
    if (!envelope) {
      /* No id, so nothing to name in an ack. It expires on its own. */
      continue
    }
    ackIds.push(envelope.id)
    if (seenEnvelopes.has(envelope.id)) {
      duplicates.push(envelope)
      continue
    }
    seenEnvelopes.set(
      envelope.id,
      Math.max(Date.parse(envelope.expiresAt) || 0, now + LEDGER_TTL_MS),
    )
    fresh.push(envelope)
  }

  return { fresh, duplicates, ackIds }
}

/**
 * Drain this device's inbox once: lease, dedupe, ack.
 *
 * → { messages, duplicates, pending, more, acknowledged, leaseMs }
 *
 * `more` is the one derived field, and it exists because `pending` is a trap:
 * the relay counts messages still waiting INCLUDING the ones it just leased to
 * you, so `pending > 0` is true immediately after a successful drain of
 * everything. Verified against production — a drain returning one message came
 * back with pending: 1, and only after the ack did it read 0. A caller that
 * loops on `pending > 0` loops forever; `more` is `pending > messages.length`,
 * which is the question that was actually meant.
 */
export async function drainMeshInbox({
  client,
  deviceId,
  ack = true,
  now = Date.now(),
} = {}) {
  if (!client?.drainNodeInbox) {
    throw new Error('This tool needs a relay client. The phone is not paired.')
  }
  const address = String(deviceId ?? '').trim()
  if (!address) throw new Error('The phone has no deviceId, so it has no inbox.')

  const page = await client.drainNodeInbox(address)
  const { fresh, duplicates, ackIds } = sortMeshEnvelopes(page?.messages, { now })
  const pending = Number(page?.pending || 0)

  let acknowledged = 0
  if (ack && ackIds.length) {
    /* A failed ack is not a failed drain: the mail is already in hand and the
     * lease will simply lapse. Losing the whole result over it would turn a
     * retry into a re-report of mail the caller has already been given. */
    try {
      const result = await client.ackNodeMessages(address, ackIds)
      acknowledged = Number(result?.acknowledged || 0)
    } catch {
      acknowledged = 0
    }
  }

  return {
    messages: fresh,
    duplicates,
    pending,
    more: pending > (page?.messages?.length ?? 0),
    acknowledged,
    leaseMs: Number(page?.leaseMs || 0),
  }
}

/** Take everything the socket drained but nothing has read. */
export function takeBufferedMeshMail() {
  const taken = delivered
  delivered = []
  return taken
}

function bufferMeshMail(envelopes) {
  if (!envelopes.length) return
  delivered = [...delivered, ...envelopes].slice(-DELIVERED_MAX)
}

/* ------------------------------------------------------------- the doorbell */

/* Reconnect backoff. A phone changes networks constantly, so the floor is low;
 * the ceiling keeps a relay outage from becoming a battery drain. */
const RECONNECT_MIN_MS = 2_000
const RECONNECT_MAX_MS = 60_000

/**
 * Hold the mesh doorbell open for this device.
 *
 * The socket carries NO payloads — its only frame is BRIDGE_MAIL_FRAME, which
 * means "drain your inbox". So this drains on every mail frame AND on every
 * connect: mail that arrived while the socket was down rang a doorbell nobody
 * was listening to, and a listener that only reacted to frames would sit next
 * to a full inbox believing it was empty.
 *
 * Everything here degrades to "no doorbell". A phone with no credential, a
 * platform with no WebSocket, a relay that is down — all of them leave the HTTP
 * drain working, which is the durable half. Nothing in this function throws
 * into its caller.
 *
 * @returns stop() — idempotent.
 */
export function createMeshListener({
  client,
  deviceId,
  onMail = null,
  onStatus = null,
  WebSocketImpl = undefined,
  pingIntervalMs = BRIDGE_PING_INTERVAL_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
} = {}) {
  let stopped = false
  let socket = null
  let pingTimer = null
  let reconnectTimer = null
  let attempt = 0

  const say = (state, detail = {}) => {
    try {
      onStatus?.({ state, deviceId, ...detail })
    } catch {
      /* A status sink must never be able to break the doorbell. */
    }
  }

  const clearTimers = () => {
    if (pingTimer !== null) clearIntervalImpl(pingTimer)
    if (reconnectTimer !== null) clearTimeoutImpl(reconnectTimer)
    pingTimer = null
    reconnectTimer = null
  }

  const drain = async (reason) => {
    try {
      const result = await drainMeshInbox({ client, deviceId })
      if (result.messages.length) {
        bufferMeshMail(result.messages)
        try {
          onMail?.({ reason, ...result })
        } catch {
          /* Same rule as onStatus: a bad sink loses a notification, not the
           * mail — it is already buffered above. */
        }
      }
      return result
    } catch (error) {
      say('drain_failed', { error: error?.message ?? String(error), code: error?.code ?? null })
      return null
    }
  }

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer !== null) return
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS)
    attempt += 1
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null
      connect()
    }, delay)
    say('reconnecting', { inMs: delay })
  }

  async function connect() {
    if (stopped) return
    try {
      socket = await client.openNodeSocket(deviceId, {
        ...(WebSocketImpl ? { WebSocketImpl } : {}),
      })
    } catch (error) {
      /* Not paired, no WebSocket, bad URL. Say it once per attempt and keep
       * the HTTP drain as the whole mesh. */
      say('unavailable', { error: error?.message ?? String(error) })
      scheduleReconnect()
      return
    }

    /*
     * stop() can land inside the await above — React unmounts faster than a
     * handshake, and StrictMode does it on purpose. Without this the socket
     * that resolved after the stop would keep its listeners, its ping interval
     * and its reconnect loop, and nothing would ever close it.
     */
    if (stopped) {
      try {
        socket.close()
      } catch {
        /* Never opened. */
      }
      socket = null
      return
    }

    socket.addEventListener('open', () => {
      attempt = 0
      say('connected', { protocol: socket?.protocol ?? null })
      /* Mail may have arrived while this node was disconnected, and nothing
       * will ring for it — the doorbell was pressed when nobody was home. */
      drain('connect')
      pingTimer = setIntervalImpl(() => {
        try {
          socket?.send(BRIDGE_PING_FRAME)
        } catch {
          /* A send on a dying socket; `close` is already on its way. */
        }
      }, pingIntervalMs)
    })

    socket.addEventListener('message', (event) => {
      const frame = parseBridgeFrame(String(event?.data ?? ''))
      if (!frame) return
      if (String(event.data) === BRIDGE_MAIL_FRAME || frame.type === 'mail') {
        drain('mail')
      }
      /* `pong` is the auto-response and needs no handling; `work` is the Mac's
       * frame and reaches this node only if the relay ever addresses it one. */
    })

    socket.addEventListener('close', (event) => {
      clearTimers()
      socket = null
      say('closed', { code: event?.code ?? null })
      scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      /* `close` always follows, and it is the one that schedules the retry. */
      say('error')
    })
  }

  connect()

  return function stop() {
    if (stopped) return
    stopped = true
    clearTimers()
    try {
      socket?.close()
    } catch {
      /* Already gone. */
    }
    socket = null
    say('stopped')
  }
}
