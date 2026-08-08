/*
 * BridgeHub — the doorbell between the relay and the Mac bridge.
 *
 * One Durable Object instance per bridge device (idFromName on the bridge's
 * deviceId). The Mac holds one outbound WebSocket here; when the relay
 * enqueues Mac-bound work in D1 it POSTs /ring on this hub, and the hub sends
 * the tiny work frame down any connected socket. That is the entire job:
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

    if (request.method === 'POST' && url.pathname === '/ring') {
      let delivered = 0
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(BRIDGE_WORK_FRAME)
          delivered += 1
        } catch {
          /* socket died between getWebSockets and send */
        }
      }

      const info = await request.json().catch(() => ({}))
      const record = {
        at: new Date().toISOString(),
        reason: String(info?.reason || 'work'),
        jobId: info?.jobId ?? null,
        delivered,
      }
      /*
       * lastDoorbell records rings RECEIVED, with `delivered` saying whether
       * a live socket heard each one — never a claim that the Mac reacted.
       */
      await this.state.storage.put(LAST_DOORBELL_KEY, record)

      return Response.json({ ok: true, delivered, lastDoorbell: record })
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
 * `GET /v1/bridge/socket` — claimed in worker.js BEFORE Express, exactly like
 * /v1/pendant/converse, because httpServerHandler cannot complete an Upgrade
 * handshake. Authenticates with the SAME credential check every Express route
 * uses (admin RELAY_API_KEY or a scoped device token) BEFORE any upgrade
 * happens, then forwards the request to the device's hub instance.
 */
export async function handleBridgeSocketUpgrade(request, env) {
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

  /* Lazy: this path runs only when the Mac (re)connects, and the entry
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
    !principalHasScopes(auth.principal, 'bridge:work:claim')
  ) {
    return Response.json(
      {
        ok: false,
        error: 'Blocked for safety: a bridge may only open its own socket.',
      },
      { status: 403 },
    )
  }

  const stub = env.BRIDGE_HUB.get(env.BRIDGE_HUB.idFromName(deviceId))
  return stub.fetch(request)
}
