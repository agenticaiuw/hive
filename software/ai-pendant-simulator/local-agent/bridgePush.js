/*
 * Push delivery for the Mac bridge: the doorbell socket and the pieces of
 * pure logic around it.
 *
 * The bridge keeps ONE outbound WebSocket open to the relay
 * (`GET /v1/bridge/socket`, terminated by the BridgeHub Durable Object).
 * Nothing of substance travels on it: a `{"type":"work"}` frame means "run
 * your normal authenticated claim NOW", and the claim itself is the same
 * `GET /v1/bridge/work` long-poll the bridge has always run. The long-poll
 * loop stays intact as fallback and catch-up; a healthy socket only lets it
 * idle between polls instead of polling continuously.
 *
 * Rollout honesty: against a relay deployed before this feature the connect
 * attempt gets a non-101 response, the socket never reports healthy, the
 * idle delay stays zero, and the bridge behaves byte-for-byte as it did
 * yesterday — one rate-limited log line, reconnect attempts backing off to a
 * 30 s cap, no error spam.
 */
import {
  BRIDGE_PING_FRAME,
  parseBridgeFrame,
} from '../shared/bridgeSocketProtocol.js'
import {
  createRateLimitedErrorReporter,
  createRetryBackoff,
} from './retryPolicy.js'

/**
 * Latching wake signal — the doorbell debounce.
 *
 * ring() during a wait wakes it immediately; ring() while the loop is busy
 * polling or executing latches, so the NEXT wait returns at once and no
 * doorbell is ever lost to a race. A burst of rings coalesces into a single
 * pending wake, because one claim sweep drains the whole queue — that
 * coalescing is the debounce, and unlike a time-window debounce it can never
 * swallow the ring that mattered.
 */
export function createWorkSignal() {
  let pending = false
  let release = null

  return {
    ring() {
      pending = true
      if (release) {
        const wake = release
        release = null
        wake('doorbell')
      }
    },
    /** Resolves 'doorbell' when rung (immediately if already pending),
     * 'timeout' after ms otherwise. ms <= 0 never sleeps. */
    async wait(ms) {
      if (pending) {
        pending = false
        return 'doorbell'
      }
      const delay = Number(ms)
      if (!Number.isFinite(delay) || delay <= 0) {
        return 'timeout'
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          release = null
          resolve('timeout')
        }, delay)
        release = (cause) => {
          clearTimeout(timer)
          pending = false
          resolve(cause)
        }
      })
    },
    pending: () => pending,
  }
}

/**
 * Poll-cadence switching, the whole point of the doorbell: with a healthy
 * socket the empty-queue loop idles a full safety interval between polls;
 * without one it returns 0 and the loop is the old continuous long-poll.
 */
export function pollIdleDelay({ socketHealthy, safetyIntervalMs = 60_000 } = {}) {
  if (!socketHealthy) return 0
  const interval = Number(safetyIntervalMs)
  return Number.isFinite(interval) && interval > 0 ? Math.round(interval) : 0
}

/** Reconnect schedule: 1s doubling to a 30s cap, jittered so a fleet (or a
 * flapping network) cannot synchronize its retries. */
export function createSocketReconnectBackoff({
  baseMs = 1000,
  maximumMs = 30_000,
  random = Math.random,
} = {}) {
  return createRetryBackoff({ baseMs, maximumMs, jitterRatio: 0.2, random })
}

/** ws(s):// socket URL for a relay http(s):// base. */
export function bridgeSocketUrl(relayUrl, deviceId) {
  const url = new URL('/v1/bridge/socket', relayUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('deviceId', deviceId)
  return url.toString()
}

/**
 * The doorbell socket manager. Owns connect / heartbeat / staleness /
 * reconnect; reports work frames and health transitions upward and decides
 * nothing about polling — that stays in the work loop.
 *
 * Collaborators are injectable for tests; defaults are the real ones. Uses
 * Node 22's global WebSocket (undici), whose second argument accepts
 * `{ headers }` — verified, so the Authorization header rides the upgrade
 * exactly like it rides every poll.
 */
export function createBridgeSocket({
  url,
  headers = {},
  heartbeatMs = 55_000,
  /* Two missed heartbeat rounds plus margin: no inbound frame for this long
   * means the socket is a zombie — force a reconnect rather than let a
   * half-open TCP session keep the loop on its quiet cadence. */
  staleAfterMs = null,
  reconnectBaseMs = 1000,
  reconnectMaxMs = 30_000,
  onWork = () => {},
  onHealthyChange = () => {},
  WebSocketImpl = globalThis.WebSocket,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (timer) => clearTimeout(timer),
  scheduleRepeating = (fn, ms) => setInterval(fn, ms),
  cancelRepeating = (timer) => clearInterval(timer),
  now = Date.now,
  random = Math.random,
  log = (message) => console.log(message),
  warn = (message) => console.warn(message),
} = {}) {
  const staleLimitMs = Number(staleAfterMs) > 0
    ? Number(staleAfterMs)
    : heartbeatMs * 2 + 15_000
  const backoff = createSocketReconnectBackoff({
    baseMs: reconnectBaseMs,
    maximumMs: reconnectMaxMs,
    random,
  })
  /* "Log once, retry with backoff": first failure logs immediately, repeats
   * are summarized at most once per interval — an old relay or a long outage
   * costs one line every ten minutes, not one per attempt. */
  const reportUnavailable = createRateLimitedErrorReporter({
    intervalMs: 600_000,
    now,
    warn,
  })

  let socket = null
  let healthy = false
  let stopped = false
  let reconnectTimer = null
  let heartbeatTimer = null
  let lastInboundAt = 0

  function setHealthy(next) {
    if (healthy === next) return
    healthy = next
    try {
      onHealthyChange(next)
    } catch {
      /* listener errors must not kill the socket lifecycle */
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      cancelRepeating(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function heartbeatTick() {
    if (!socket) return
    if (now() - lastInboundAt > staleLimitMs) {
      /* A zombie (half-open TCP) may never emit close, so do not wait for
       * it. Leaving this socket "healthy" would keep the loop on its quiet
       * cadence while nothing could actually ring — the dishonest state
       * this check exists for. */
      warn(
        `[bridge] Doorbell socket silent for ${Math.round(staleLimitMs / 1000)}s — reconnecting.`,
      )
      handleSocketDown(socket, new Error('socket went silent past the stale limit'))
      return
    }
    try {
      socket.send(BRIDGE_PING_FRAME)
    } catch {
      /* send on a closing socket: the error/close path reconnects */
    }
  }

  function scheduleReconnect(cause) {
    if (stopped || reconnectTimer !== null) return
    reportUnavailable(
      '[bridge] Doorbell socket unavailable (long-poll fallback active)',
      cause,
    )
    reconnectTimer = schedule(() => {
      reconnectTimer = null
      connect()
    }, backoff.nextDelay())
  }

  function detach(target) {
    if (!target) return
    target.onopen = null
    target.onmessage = null
    target.onerror = null
    target.onclose = null
  }

  /*
   * The ONE teardown path, reachable from error, close, and staleness.
   * Idempotent by the `socket !== candidate` guard, and it must exist
   * because Node 22's undici WebSocket fires ONLY an error event — no
   * close — when the server answers the upgrade with a non-101 (verified
   * against this exact runtime). A reconnect hung solely off onclose would
   * try an old relay once and then never again.
   */
  function handleSocketDown(candidate, cause) {
    if (socket !== candidate) return
    detach(candidate)
    socket = null
    stopHeartbeat()
    const wasHealthy = healthy
    setHealthy(false)
    try {
      candidate.close()
    } catch {
      /* never opened or already closed */
    }
    if (stopped) return
    if (wasHealthy) {
      warn(
        `[bridge] Doorbell socket lost (${cause?.message || cause}) — continuous long-poll resumed.`,
      )
    }
    scheduleReconnect(cause)
  }

  function connect() {
    if (stopped) return
    let candidate
    try {
      candidate = new WebSocketImpl(url, { headers })
    } catch (error) {
      scheduleReconnect(error)
      return
    }
    socket = candidate

    candidate.onopen = () => {
      if (stopped || socket !== candidate) return
      backoff.reset()
      lastInboundAt = now()
      log('[bridge] Doorbell socket connected — polls drop to safety cadence.')
      stopHeartbeat()
      heartbeatTimer = scheduleRepeating(heartbeatTick, heartbeatMs)
      setHealthy(true)
    }

    candidate.onmessage = (event) => {
      if (socket !== candidate) return
      lastInboundAt = now()
      const frame = parseBridgeFrame(event?.data)
      if (frame?.type === 'work') {
        try {
          onWork()
        } catch {
          /* the claim loop reports its own errors */
        }
      }
      /* pong and unknown frames only refresh lastInboundAt */
    }

    candidate.onerror = (event) => {
      handleSocketDown(
        candidate,
        new Error(event?.message || 'socket error (non-101 or network)'),
      )
    }

    candidate.onclose = (event) => {
      handleSocketDown(
        candidate,
        new Error(`socket closed (code ${event?.code ?? 'unknown'})`),
      )
    }
  }

  return {
    start() {
      stopped = false
      if (!socket && reconnectTimer === null) connect()
    },
    stop() {
      stopped = true
      if (reconnectTimer !== null) {
        cancel(reconnectTimer)
        reconnectTimer = null
      }
      stopHeartbeat()
      const current = socket
      socket = null
      setHealthy(false)
      if (current) {
        detach(current)
        try {
          current.close()
        } catch {
          /* already closed */
        }
      }
    },
    isHealthy: () => healthy,
    lastInboundAt: () => lastInboundAt,
  }
}
