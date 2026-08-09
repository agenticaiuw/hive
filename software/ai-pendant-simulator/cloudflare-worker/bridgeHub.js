/*
 * BridgeHub — the doorbell between the relay and one node.
 *
 * NAME. It was written for the Mac bridge and now serves any node: the
 * browser extension and the iOS shell open their own sockets here through
 * /v1/node/socket. The class keeps its name because renaming a Durable Object
 * class needs a `renamed_classes` migration, and doing that to the live
 * doorbell to fix a comment would be an absurd trade. Read "BridgeHub" as
 * "the hub for one node".
 *
 * ONE SOCKET PER NODE, whichever route opened it. /v1/bridge/socket and
 * /v1/node/socket both resolve to idFromName(deviceId), and a new connection
 * closes the old one, so a node that opened both would kick itself. It never
 * needs to: every frame type is delivered to whatever socket is connected. A
 * Mac holding its work doorbell receives mesh mail on the same wire.
 *
 * One Durable Object instance per device (idFromName on the deviceId). The
 * node holds one outbound WebSocket here; when the relay enqueues D1 work it
 * POSTs /ring (Mac work) or /deliver (mesh mail) on this hub, and the hub
 * sends the tiny frame down any connected socket. That is the entire job:
 *
 *   - NO payloads travel on this socket. The D1 queue remains the single
 *     durable record; the Mac answers a doorbell with the same authenticated
 *     `GET /v1/bridge/work` claim it has always used. A ring with no socket
 *     connected is a silent no-op — the bridge's safety poll picks the job
 *     up exactly as the pull-only design always did.
 *   - Presence is observed, never inferred: connected means a live accepted
 *     socket exists right now, which replaces lastSeenAt-guessing.
 *
 * Uses the WebSocket Hibernation API (state.acceptWebSocket + handler
 * methods) so an idle connected Mac holds no isolate in memory and accrues
 * no duration. Heartbeat pings are answered by setWebSocketAutoResponse
 * without waking the object at all. On the Workers Free plan the class must
 * be SQLite-backed — wrangler.jsonc declares it via `new_sqlite_classes`.
 *
 * Reachability: this class has no public URL. The only path in is the Worker
 * entry (worker.js), which authenticates `GET /v1/bridge/socket` BEFORE
 * forwarding the upgrade to the stub, and cloud-relay code ringing /ring or
 * reading /presence through the BRIDGE_HUB binding. The /ring and /presence
 * routes therefore carry no auth of their own on purpose.
 *
 * Module scope stays featherweight: worker.js must re-export this class
 * statically, and the cron invocation that shares the entry module has a
 * 10 ms CPU budget. Everything heavier (deviceAuth, the store) is imported
 * lazily inside the upgrade handler below.
 */
import {
  BRIDGE_MAIL_FRAME,
  BRIDGE_PING_FRAME,
  BRIDGE_PONG_FRAME,
  BRIDGE_WORK_FRAME,
  parseBridgeFrame,
} from '../shared/bridgeSocketProtocol.js'

const LAST_DOORBELL_KEY = 'lastDoorbell'

export class BridgeHub {
  constructor(state) {
    this.state = state
    /*
     * Answer the exact ping frame with the exact pong frame while hibernated.
     * Set every construction on purpose: the constructor is what runs on each
     * wake, and the call is idempotent.
     */
    try {
      this.state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(BRIDGE_PING_FRAME, BRIDGE_PONG_FRAME),
      )
    } catch {
      /* Runtime without auto-response: webSocketMessage answers pings below. */
    }
  }

  async fetch(request) {
    const url = new URL(request.url)
    const upgrade = String(request.headers.get('Upgrade') || '').toLowerCase()

    if (upgrade === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)

      /*
       * One Mac, one socket. A reconnect racing its own half-dead predecessor
       * must not leave a zombie inflating presence or eating doorbells, so
       * the newest connection wins and the rest are told why.
       */
      for (const existing of this.state.getWebSockets()) {
        try {
          existing.close(1000, 'Replaced by a newer bridge connection.')
        } catch {
          /* already dying */
        }
      }

      this.state.acceptWebSocket(server)
      server.serializeAttachment({ connectedAt: new Date().toISOString() })
      return new Response(null, { status: 101, webSocket: client })
    }

    if (
      request.method === 'POST' &&
      (url.pathname === '/ring' || url.pathname === '/deliver')
    ) {
      /*
       * Two doorbells, one mechanism. /ring means "claim /v1/bridge/work";
       * /deliver means "drain /v1/node/inbox". Neither carries a payload —
       * the D1 row is the durable record in both cases, and a frame that
       * carried the work would make delivery depend on the socket being up at
       * the instant of send, which is the failure both queues exist to
       * remove. The frame is the only difference between these two paths.
       */
      const frame =
        url.pathname === '/deliver' ? BRIDGE_MAIL_FRAME : BRIDGE_WORK_FRAME
      let delivered = 0
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(frame)
          delivered += 1
        } catch {
          /* socket died between getWebSockets and send */
        }
      }

      const info = await request.json().catch(() => ({}))
      const record = {
        at: new Date().toISOString(),
        reason: String(info?.reason || (url.pathname === '/deliver' ? 'mail' : 'work')),
        jobId: info?.jobId ?? null,
        delivered,
      }
      /*
       * lastDoorbell records rings RECEIVED, with `delivered` saying whether
       * a live socket heard each one — never a claim that the node reacted.
       */
      await this.state.storage.put(LAST_DOORBELL_KEY, record)

      return Response.json({ ok: true, delivered, lastDoorbell: record })
    }

    /*
     * POST /budget — the per-device inference counter.
     *
     * Lives here rather than in D1 because this object already IS the
     * per-device coordination point, its storage is strongly consistent, and
     * a counter in relay_state would sit in a key space that `state:read`
     * exposes and `state:write` could reset. It is also the only spend
     * control that survives isolate churn: an in-process limiter resets every
     * time Cloudflare spins a new isolate, which is exactly the ceiling a
     * leaked token would walk through.
     *
     * Fixed window, not a token bucket: a bucket's refill needs a monotonic
     * clock this object does not have across hibernations, and a fixed window
     * that occasionally lets 2× through at a boundary is a far smaller
     * problem than a budget that silently stops counting.
     */
    if (request.method === 'POST' && url.pathname === '/budget') {
      const body = await request.json().catch(() => ({}))
      const limit = Math.max(1, Number(body?.limit) || 120)
      const windowMs = Math.max(1_000, Number(body?.windowMs) || 3_600_000)
      const now = Date.now()

      const current = (await this.state.storage.get('budget')) || {
        windowStartedAt: 0,
        count: 0,
      }
      const expired = now - Number(current.windowStartedAt || 0) >= windowMs
      const windowStartedAt = expired ? now : Number(current.windowStartedAt)
      const count = expired ? 0 : Number(current.count || 0)

      if (count >= limit) {
        return Response.json({
          ok: false,
          allowed: false,
          limit,
          used: count,
          resetAt: new Date(windowStartedAt + windowMs).toISOString(),
        })
      }

      await this.state.storage.put('budget', {
        windowStartedAt,
        count: count + 1,
      })
      return Response.json({
        ok: true,
        allowed: true,
        limit,
        used: count + 1,
        resetAt: new Date(windowStartedAt + windowMs).toISOString(),
      })
    }

    if (request.method === 'GET' && url.pathname === '/presence') {
      const sockets = this.state.getWebSockets()
      let since = null
      for (const socket of sockets) {
        let attachment = null
        try {
          attachment = socket.deserializeAttachment()
        } catch {
          /* attachment from an incompatible older build */
        }
        const connectedAt = attachment?.connectedAt || null
        if (connectedAt && (!since || connectedAt < since)) since = connectedAt
      }
      const lastDoorbell =
        (await this.state.storage.get(LAST_DOORBELL_KEY)) ?? null

      return Response.json({
        connected: sockets.length > 0,
        sockets: sockets.length,
        since,
        lastDoorbell,
      })
    }

    return Response.json(
      { ok: false, error: 'Unknown bridge hub path.' },
      { status: 404 },
    )
  }

  async webSocketMessage(socket, message) {
    /*
     * Auto-response already answered the canonical ping without waking us.
     * This is the defensive path for a ping serialized differently — answer
     * it; ignore everything else (the Mac has nothing to tell the hub).
     */
    const frame = parseBridgeFrame(message)
    if (frame?.type === 'ping') {
      try {
        socket.send(BRIDGE_PONG_FRAME)
      } catch {
        /* closing */
      }
    }
  }

  async webSocketClose(socket, code) {
    try {
      socket.close(code, 'Bridge hub closing.')
    } catch {
      /* already closed */
    }
  }

  async webSocketError() {
    /* close follows; nothing to persist */
  }
}

/*
 * The socket upgrade handlers, claimed in worker.js BEFORE Express — exactly
 * like /v1/pendant/converse, because httpServerHandler cannot complete an
 * Upgrade handshake. Both authenticate with the SAME credential check every
 * Express route uses (admin RELAY_API_KEY or a scoped device token) BEFORE any
 * upgrade happens, then forward to the device's hub instance.
 *
 * The scopes they demand are declared in cloud-relay/relayScopes.js
 * (SOCKET_SCOPES) so the socket rules are reviewable beside the HTTP ones, and
 * relayScopes.test.js holds these handlers to them.
 */

/** `GET /v1/bridge/socket` — the Mac's work doorbell. */
export async function handleBridgeSocketUpgrade(request, env) {
  return handleHubUpgrade(request, env, {
    requiredScopes: ['bridge:work:claim'],
    denial: 'Blocked for safety: a bridge may only open its own socket.',
  })
}

/**
 * `GET /v1/node/socket` — any node's mesh doorbell.
 *
 * Demands only node:message:receive: the socket's entire capability is being
 * TOLD that mail is waiting. Sending is POST /v1/node/messages with its own
 * scope, and the payload is drained over an authenticated HTTP route, so a
 * handshake that succeeded is not by itself permission to read anything.
 *
 * principalOwnsDevice is the half that matters most here, and it is why a
 * stolen browser-extension token cannot open the phone's socket: the token's
 * deviceId must equal the deviceId in the query string.
 */
export async function handleNodeSocketUpgrade(request, env) {
  return handleHubUpgrade(request, env, {
    requiredScopes: ['node:message:receive'],
    denial: 'Blocked for safety: a node may only open its own socket.',
  })
}

async function handleHubUpgrade(request, env, { requiredScopes, denial }) {
  if (
    String(request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket'
  ) {
    return new Response('WebSocket upgrade required', { status: 426 })
  }
  if (!env?.BRIDGE_HUB) {
    return Response.json(
      { ok: false, error: 'Bridge hub binding is not configured.' },
      { status: 503 },
    )
  }

  const url = new URL(request.url)
  const deviceId = String(url.searchParams.get('deviceId') || '').trim()
  if (!deviceId) {
    return Response.json(
      { ok: false, error: 'deviceId query parameter is required.' },
      { status: 400 },
    )
  }

  /* Lazy: this path runs only when a node (re)connects, and the entry
   * module must stay cheap to evaluate for the every-minute cron. */
  const [
    { authenticateRelayRequest, principalHasScopes, principalOwnsDevice },
    { getStore },
    { RELAY_API_KEY },
  ] = await Promise.all([
    import('../cloud-relay/deviceAuth.js'),
    import('../cloud-relay/store/index.js'),
    import('../cloud-relay/config.js'),
  ])

  const auth = await authenticateRelayRequest({
    authorization: request.headers.get('Authorization') || '',
    adminApiKey: RELAY_API_KEY,
    credentialStore: await getStore(),
  })
  if (!auth.ok) {
    return Response.json(
      { ok: false, error: auth.error || 'Unauthorized.' },
      { status: auth.status || 401 },
    )
  }
  if (
    !principalOwnsDevice(auth.principal, deviceId) ||
    !principalHasScopes(auth.principal, ...requiredScopes)
  ) {
    return Response.json({ ok: false, error: denial }, { status: 403 })
  }

  const stub = env.BRIDGE_HUB.get(env.BRIDGE_HUB.idFromName(deviceId))
  return stub.fetch(request)
}
