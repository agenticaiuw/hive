import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bridgeSocketUrl,
  createBridgeSocket,
  createSocketReconnectBackoff,
  createWorkSignal,
  pollIdleDelay,
} from './bridgePush.js'

/* ------------------------------------------------------------------ *
 * Doorbell debounce: the latching work signal
 * ------------------------------------------------------------------ */

test('a doorbell that rang while the loop was busy is never lost', async () => {
  const signal = createWorkSignal()
  signal.ring()
  assert.equal(signal.pending(), true)
  // The loop finishes handling work, then waits: must wake immediately.
  assert.equal(await signal.wait(60_000), 'doorbell')
  assert.equal(signal.pending(), false)
})

test('a burst of work frames coalesces into a single wake', async () => {
  const signal = createWorkSignal()
  signal.ring()
  signal.ring()
  signal.ring()
  assert.equal(await signal.wait(60_000), 'doorbell')
  // One claim sweep drains the whole queue, so the burst owes exactly one
  // wake — the next wait must actually sleep.
  assert.equal(await signal.wait(20), 'timeout')
})

test('a ring during an idle wait wakes it immediately', async () => {
  const signal = createWorkSignal()
  const startedAt = Date.now()
  setTimeout(() => signal.ring(), 10)
  assert.equal(await signal.wait(60_000), 'doorbell')
  assert.ok(
    Date.now() - startedAt < 5_000,
    'the wait should not have slept out its full interval',
  )
})

test('a zero or invalid delay never sleeps', async () => {
  const signal = createWorkSignal()
  assert.equal(await signal.wait(0), 'timeout')
  assert.equal(await signal.wait(-5), 'timeout')
  assert.equal(await signal.wait(Number.NaN), 'timeout')
})

test('an un-rung wait times out and leaves no latch behind', async () => {
  const signal = createWorkSignal()
  assert.equal(await signal.wait(10), 'timeout')
  assert.equal(signal.pending(), false)
  // A ring after a timeout latches for the next wait as normal.
  signal.ring()
  assert.equal(await signal.wait(60_000), 'doorbell')
})

/* ------------------------------------------------------------------ *
 * Poll-cadence switching
 * ------------------------------------------------------------------ */

test('poll cadence: healthy socket idles, no socket polls continuously', () => {
  assert.equal(
    pollIdleDelay({ socketHealthy: true, safetyIntervalMs: 60_000 }),
    60_000,
  )
  assert.equal(
    pollIdleDelay({ socketHealthy: false, safetyIntervalMs: 60_000 }),
    0,
    'socket down must mean the old continuous long-poll',
  )
  assert.equal(pollIdleDelay({ socketHealthy: false }), 0)
})

test('poll cadence: a broken safety interval fails toward continuous polling', () => {
  assert.equal(
    pollIdleDelay({ socketHealthy: true, safetyIntervalMs: Number.NaN }),
    0,
  )
  assert.equal(pollIdleDelay({ socketHealthy: true, safetyIntervalMs: -1 }), 0)
})

/* ------------------------------------------------------------------ *
 * Reconnect backoff schedule
 * ------------------------------------------------------------------ */

test('socket reconnect backoff doubles from 1s, caps at 30s, resets', () => {
  const backoff = createSocketReconnectBackoff({ random: () => 0.5 })
  assert.deepEqual(
    Array.from({ length: 7 }, () => backoff.nextDelay()),
    [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000],
  )
  backoff.reset()
  assert.equal(backoff.nextDelay(), 1000)
})

test('socket reconnect jitter never pushes a delay past the cap', () => {
  const backoff = createSocketReconnectBackoff({ random: () => 1 })
  for (let i = 0; i < 10; i += 1) {
    assert.ok(backoff.nextDelay() <= 30_000)
  }
})

/* ------------------------------------------------------------------ *
 * Socket URL derivation
 * ------------------------------------------------------------------ */

test('socket URL follows the relay scheme and carries the deviceId', () => {
  assert.equal(
    bridgeSocketUrl('http://localhost:8787', 'dev-bridge'),
    'ws://localhost:8787/v1/bridge/socket?deviceId=dev-bridge',
  )
  assert.equal(
    bridgeSocketUrl('https://relay.example.workers.dev', 'home macbook'),
    'wss://relay.example.workers.dev/v1/bridge/socket?deviceId=home+macbook',
  )
})

/* ------------------------------------------------------------------ *
 * Socket manager lifecycle (fake WebSocket, fake timers)
 * ------------------------------------------------------------------ */

function createHarness({ WebSocketImpl, heartbeatMs = 100, nowRef } = {}) {
  const sockets = []
  class FakeWebSocket {
    constructor(url, options) {
      this.url = url
      this.options = options ?? {}
      this.sent = []
      this.closeCalls = 0
      this.onopen = null
      this.onmessage = null
      this.onerror = null
      this.onclose = null
      sockets.push(this)
    }

    send(data) {
      this.sent.push(data)
    }

    close() {
      this.closeCalls += 1
    }
  }

  const scheduled = []
  const repeating = []
  const workEvents = []
  const healthyChanges = []
  const logs = []
  const warnings = []

  const manager = createBridgeSocket({
    url: 'wss://relay.test/v1/bridge/socket?deviceId=test-bridge',
    headers: { Authorization: 'Bearer test-key' },
    heartbeatMs,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 30_000,
    onWork: () => workEvents.push(Date.now()),
    onHealthyChange: (healthy) => healthyChanges.push(healthy),
    WebSocketImpl: WebSocketImpl ?? FakeWebSocket,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      scheduled.push(timer)
      return timer
    },
    cancel: (timer) => {
      if (timer) timer.cancelled = true
    },
    scheduleRepeating: (fn, ms) => {
      const timer = { fn, ms, cancelled: false }
      repeating.push(timer)
      return timer
    },
    cancelRepeating: (timer) => {
      if (timer) timer.cancelled = true
    },
    now: () => (nowRef ? nowRef.value : Date.now()),
    random: () => 0.5,
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
  })

  const runNextScheduled = () => {
    const timer = scheduled.shift()
    if (timer && !timer.cancelled) timer.fn()
    return timer
  }

  return {
    manager,
    sockets,
    scheduled,
    repeating,
    workEvents,
    healthyChanges,
    logs,
    warnings,
    runNextScheduled,
  }
}

test('the socket sends the Authorization header on the upgrade', () => {
  const harness = createHarness()
  harness.manager.start()
  assert.equal(harness.sockets.length, 1)
  assert.equal(
    harness.sockets[0].options.headers.Authorization,
    'Bearer test-key',
  )
  harness.manager.stop()
})

test('open turns healthy and a work frame triggers the claim callback', () => {
  const harness = createHarness()
  harness.manager.start()
  const socket = harness.sockets[0]

  assert.equal(harness.manager.isHealthy(), false)
  socket.onopen()
  assert.equal(harness.manager.isHealthy(), true)
  assert.deepEqual(harness.healthyChanges, [true])

  socket.onmessage({ data: '{"type":"work"}' })
  assert.equal(harness.workEvents.length, 1)

  // Pongs and garbage refresh liveness but never trigger claims.
  socket.onmessage({ data: '{"type":"pong"}' })
  socket.onmessage({ data: 'not json at all' })
  socket.onmessage({ data: 12345 })
  assert.equal(harness.workEvents.length, 1)
  harness.manager.stop()
})

test('close falls back to unhealthy and reconnects on the backoff schedule', () => {
  const harness = createHarness()
  harness.manager.start()

  // Failure 1: never opened, closed straight away → 1s retry.
  harness.sockets[0].onclose({ code: 1006 })
  assert.equal(harness.scheduled[0].ms, 1000)
  harness.runNextScheduled()

  // Failure 2 → 2s retry (schedule doubling).
  harness.sockets[1].onclose({ code: 1006 })
  assert.equal(harness.scheduled[0].ms, 2000)
  harness.runNextScheduled()

  // Success resets the schedule; the next drop starts back at 1s.
  const socket = harness.sockets[2]
  socket.onopen()
  assert.deepEqual(harness.healthyChanges, [true])
  socket.onclose({ code: 1001 })
  assert.deepEqual(harness.healthyChanges, [true, false])
  assert.equal(harness.scheduled[0].ms, 1000)
  harness.manager.stop()
})

test('an error event with NO close still reconnects (old-relay handshake)', () => {
  // Node 22's undici fires only `error` — never `close` — when the server
  // answers the upgrade with a non-101. Verified against this runtime; a
  // reconnect hung solely off onclose would try an old relay exactly once.
  const harness = createHarness()
  harness.manager.start()
  const socket = harness.sockets[0]

  socket.onerror({ message: 'Received network error or non-101 status code.' })
  assert.equal(harness.manager.isHealthy(), false)
  assert.equal(harness.scheduled.length, 1, 'error alone must schedule a retry')
  assert.equal(harness.scheduled[0].ms, 1000)

  // If a close event does trail the error, it must not double-schedule.
  socket.onclose?.({ code: 1006 })
  assert.equal(harness.scheduled.length, 1)
  harness.manager.stop()
})

test('an old relay (connect keeps failing) logs once, not per attempt', () => {
  class RefusingWebSocket {
    constructor() {
      throw new Error('unexpected server response 403')
    }
  }
  const harness = createHarness({ WebSocketImpl: RefusingWebSocket })
  harness.manager.start()
  for (let i = 0; i < 6; i += 1) {
    harness.runNextScheduled()
  }
  // Six more failures inside the rate-limit window: still a single line.
  assert.equal(harness.warnings.length, 1)
  assert.match(harness.warnings[0], /long-poll fallback active/)
  assert.equal(harness.manager.isHealthy(), false)
  harness.manager.stop()
})

test('a silent socket past the stale limit is torn down and replaced', () => {
  const nowRef = { value: 1_000_000 }
  const harness = createHarness({ heartbeatMs: 100, nowRef })
  harness.manager.start()
  const socket = harness.sockets[0]
  socket.onopen()
  assert.equal(harness.manager.isHealthy(), true)

  // Fresh socket: the heartbeat tick pings rather than reconnecting.
  const heartbeat = harness.repeating.at(-1)
  nowRef.value += 50
  heartbeat.fn()
  assert.deepEqual(socket.sent, ['{"type":"ping"}'])

  // An inbound frame refreshes liveness.
  nowRef.value += 100
  socket.onmessage({ data: '{"type":"pong"}' })

  // Then nothing arrives for far longer than the stale limit (2×100ms + 15s).
  nowRef.value += 60_000
  heartbeat.fn()
  assert.equal(harness.manager.isHealthy(), false)
  assert.equal(socket.closeCalls, 1)
  assert.ok(harness.warnings.some((line) => /silent/.test(line)))
  assert.equal(
    harness.scheduled.filter((timer) => !timer.cancelled).length,
    1,
    'a reconnect must be pending after the teardown',
  )
  harness.manager.stop()
})

test('stop closes the socket and cancels any pending reconnect', () => {
  const harness = createHarness()
  harness.manager.start()
  harness.sockets[0].onclose({ code: 1006 })
  assert.equal(harness.scheduled.length, 1)

  harness.manager.stop()
  assert.equal(harness.scheduled[0].cancelled, true)
  const revived = harness.runNextScheduled()
  assert.equal(revived.cancelled, true)
  assert.equal(harness.sockets.length, 1, 'no reconnect after stop')

  // start() after stop() is allowed and opens a fresh socket.
  harness.manager.start()
  assert.equal(harness.sockets.length, 2)
  harness.manager.stop()
  assert.equal(harness.sockets[1].closeCalls, 1)
})
