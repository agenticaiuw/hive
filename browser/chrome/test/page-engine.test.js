import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BACKGROUND_HOLDER,
  BACKGROUND_LEASE_STALE_MS,
  PAGE_LEASE_STALE_MS,
  PAIR_REPLY_TIMEOUT_MS,
  backgroundAliveVerdict,
  directOutcomeWritePlan,
  leaseDecision,
  pairFallbackVerdict,
  runDirectPairing,
} from '../src/page-engine.js'
import { PAIR_OUTCOME_KEY } from '../src/pairing.js'

/* ===================================================================== *
 * pairFallbackVerdict: when may the popup pair on its own?
 * ===================================================================== */

test('a worker that answered keeps the exchange — the page must not double-run', () => {
  const verdict = pairFallbackVerdict({
    replied: true,
    reply: { ok: true },
    startedAt: 1_000,
  })
  assert.equal(verdict.run, false)
  assert.equal(verdict.why, 'worker-answered')

  /* A refusal is still an answer: the worker is alive and its error narrates. */
  const refused = pairFallbackVerdict({
    replied: true,
    reply: { ok: false, error: 'wrong code' },
    startedAt: 1_000,
  })
  assert.equal(refused.run, false)
})

test('an undefined reply with no fresh outcome means the page runs the exchange', () => {
  /* Tonight's Safari: sendMessage resolves undefined without waking anything. */
  const verdict = pairFallbackVerdict({
    replied: true,
    reply: undefined,
    outcome: null,
    startedAt: 1_000,
  })
  assert.equal(verdict.run, true)
  assert.equal(verdict.why, 'no-reply')
})

test('a timeout with no outcome record runs the exchange', () => {
  const verdict = pairFallbackVerdict({ replied: false, startedAt: 1_000 })
  assert.equal(verdict.run, true)
})

test('a dropped reply whose outcome already landed does NOT re-run the exchange', () => {
  /* The 2026-08-12 war story: worker alive, Safari dropped the async reply,
   * but the worker's own PAIR_OUTCOME_KEY write is the proof it acted. */
  const verdict = pairFallbackVerdict({
    replied: true,
    reply: undefined,
    outcome: { ok: true, note: 'Paired.', at: 5_000 },
    startedAt: 1_000,
  })
  assert.equal(verdict.run, false)
  assert.equal(verdict.why, 'worker-outcome-landed')
})

test('a STALE outcome record (from last week) does not stop the exchange', () => {
  const verdict = pairFallbackVerdict({
    replied: false,
    outcome: { ok: true, note: 'Paired.', at: 900 },
    startedAt: 1_000,
  })
  assert.equal(verdict.run, true)
})

test('a thrown send (no receiver at all) runs the exchange', () => {
  const verdict = pairFallbackVerdict({
    failed: true,
    error: new Error('Receiving end does not exist'),
    startedAt: 1_000,
  })
  assert.equal(verdict.run, true)
  assert.equal(verdict.why, 'send-failed')
})

test('the reply window is bounded and sane', () => {
  assert.ok(PAIR_REPLY_TIMEOUT_MS >= 1_000 && PAIR_REPLY_TIMEOUT_MS <= 10_000)
})

/* ===================================================================== *
 * directOutcomeWritePlan: a failure must never bury a fresh success.
 * ===================================================================== */

test('a direct failure never overwrites a fresher success from the worker', () => {
  const existing = { ok: true, note: 'Paired.', at: 2_000 }
  const plan = directOutcomeWritePlan({
    existing,
    startedAt: 1_000,
    outcome: { ok: false, error: 'the race lost' },
  })
  assert.equal(plan.write, false)
  assert.deepEqual(plan.record, existing)
})

test('a direct success always writes, even over an existing success', () => {
  const plan = directOutcomeWritePlan({
    existing: { ok: true, note: 'Paired.', at: 2_000 },
    startedAt: 1_000,
    outcome: { ok: true, note: 'Paired again.' },
    now: 3_000,
  })
  assert.equal(plan.write, true)
  assert.deepEqual(plan.record, { ok: true, note: 'Paired again.', at: 3_000 })
})

test('a failure writes when nothing fresher stands', () => {
  const stale = directOutcomeWritePlan({
    existing: { ok: true, note: 'Paired.', at: 500 },
    startedAt: 1_000,
    outcome: { ok: false, error: 'agent off' },
    now: 3_000,
  })
  assert.equal(stale.write, true)
  assert.equal(stale.record.ok, false)
  assert.equal(stale.record.error, 'agent off')

  const empty = directOutcomeWritePlan({
    existing: undefined,
    startedAt: 1_000,
    outcome: { ok: false, error: 'agent off' },
  })
  assert.equal(empty.write, true)
})

/* ===================================================================== *
 * runDirectPairing: the worker's storage contract, driven from a page.
 * ===================================================================== */

function fakeApi({ session = true, native = true } = {}) {
  const local = {}
  const sessionStore = {}
  const ops = []
  const nativeMessages = []
  const api = {
    storage: {
      local: {
        async get(key) {
          const keys = Array.isArray(key) ? key : [key]
          return Object.fromEntries(keys.filter((k) => k in local).map((k) => [k, local[k]]))
        },
        async set(values) {
          ops.push(['local.set', Object.keys(values).sort().join(',')])
          Object.assign(local, values)
        },
      },
      sync: {
        async remove(key) {
          ops.push(['sync.remove', key])
        },
      },
    },
    runtime: {},
  }
  if (session) {
    api.storage.session = {
      async set(values) {
        ops.push(['session.set', Object.keys(values).sort().join(',')])
        Object.assign(sessionStore, values)
      },
    }
  }
  if (native) {
    api.runtime.sendNativeMessage = async (_id, message) => {
      nativeMessages.push(message)
      return null
    }
  }
  return { api, local, sessionStore, ops, nativeMessages }
}

const jsonResponse = (payload, status = 200) => ({
  status,
  async json() {
    if (payload === null) throw new Error('no body')
    return payload
  },
})

const EXCHANGE = {
  agentUrl: 'http://127.0.0.1:8000',
  code: 'owl-code',
  deviceId: 'browser-abc123',
  deviceName: 'Safari',
  startedAt: 1_000,
}

test('a successful direct pair stores the full patch, escrows, and records the outcome', async () => {
  const { api, local, ops, nativeMessages } = fakeApi()
  const requests = []
  const record = await runDirectPairing(
    api,
    { ...EXCHANGE, lifetime: 'forever' },
    async (url, init) => {
      requests.push({ url, init })
      return jsonResponse({
        ok: true,
        agentToken: 'agent-token-1',
        relay: {
          url: 'https://ai-pendant-relay.evan20050827.workers.dev',
          deviceId: 'browser-abc123',
          deviceToken: 'pdt_1',
        },
      })
    },
  )

  assert.equal(requests[0].url, 'http://127.0.0.1:8000/pair/browser')
  assert.equal(requests[0].init.method, 'POST')
  /* The stored keys are the live contract both peers' loops watch. */
  assert.equal(local.agentToken, 'agent-token-1')
  assert.equal(local.relayEnabled, true)
  assert.equal(local.deviceToken, 'pdt_1')
  assert.equal(local.relayDeviceId, 'browser-abc123')
  assert.equal(local.pairLifetime, 'forever')
  assert.equal(record.ok, true)
  assert.equal(local[PAIR_OUTCOME_KEY].ok, true)
  /* An old synced token must not outlive the re-pair. */
  assert.ok(ops.some(([op, key]) => op === 'sync.remove' && key === 'agentToken'))
  /* Escrowed with the wrapper app, exactly like the worker path. */
  assert.equal(nativeMessages.length, 1)
  assert.equal(nativeMessages[0].type, 'escrow:store')
  assert.equal(nativeMessages[0].values.agentToken, 'agent-token-1')
})

test('a session-only direct pair plants the sentinel first and never escrows', async () => {
  const { api, sessionStore, ops, nativeMessages } = fakeApi()
  await runDirectPairing(
    api,
    { ...EXCHANGE, lifetime: 'session' },
    async () => jsonResponse({ ok: true, agentToken: 'agent-token-2' }),
  )

  assert.equal(sessionStore.pairSessionAlive, true)
  const sentinelAt = ops.findIndex(([op]) => op === 'session.set')
  const credentialsAt = ops.findIndex(([op, keys]) => op === 'local.set' && keys.includes('agentToken'))
  assert.ok(sentinelAt !== -1 && sentinelAt < credentialsAt, 'sentinel lands before the credentials')
  assert.equal(nativeMessages.length, 0, 'session pairings are never escrowed')
})

test('an agent refusal stores nothing but the failure outcome', async () => {
  const { api, local } = fakeApi()
  const record = await runDirectPairing(
    api,
    { ...EXCHANGE, lifetime: 'forever' },
    async () => jsonResponse({ ok: false, error: 'Wrong or missing pairing code' }, 403),
  )
  assert.equal(record.ok, false)
  assert.match(record.error, /pairing code/)
  assert.equal(local.agentToken, undefined)
  assert.equal(local[PAIR_OUTCOME_KEY].ok, false)
})

test('a bodyless response reports the HTTP status honestly', async () => {
  const { api } = fakeApi()
  const record = await runDirectPairing(
    api,
    { ...EXCHANGE, lifetime: 'forever' },
    async () => jsonResponse(null, 502),
  )
  assert.equal(record.ok, false)
  assert.match(record.error, /HTTP 502/)
})

test('a network failure becomes a failure record, not a throw', async () => {
  const { api, local } = fakeApi()
  const record = await runDirectPairing(api, { ...EXCHANGE, lifetime: 'forever' }, async () => {
    throw new Error('Load failed')
  })
  assert.equal(record.ok, false)
  assert.match(record.error, /Load failed/)
  assert.equal(local[PAIR_OUTCOME_KEY].ok, false)
})

test('a losing direct failure leaves the worker\'s fresher success standing', async () => {
  const { api, local } = fakeApi()
  const workerRecord = { ok: true, note: 'Paired.', at: 2_000 }
  local[PAIR_OUTCOME_KEY] = workerRecord

  const record = await runDirectPairing(api, { ...EXCHANGE, startedAt: 1_000, lifetime: 'forever' }, async () => {
    throw new Error('the worker won the race')
  })

  assert.deepEqual(record, workerRecord, 'the standing record is returned for narration')
  assert.deepEqual(local[PAIR_OUTCOME_KEY], workerRecord, 'the stored success is untouched')
})

test('an engine without storage.session or a native host still pairs', async () => {
  const { api, local, nativeMessages } = fakeApi({ session: false, native: false })
  const record = await runDirectPairing(
    api,
    { ...EXCHANGE, lifetime: 'session' },
    async () => jsonResponse({ ok: true, agentToken: 'agent-token-3' }),
  )
  assert.equal(record.ok, true)
  assert.equal(local.agentToken, 'agent-token-3')
  assert.equal(nativeMessages.length, 0)
})

/* ===================================================================== *
 * backgroundAliveVerdict: is the background dead, from what the boot ping
 * observed? Timestamps in, verdict out — no browser needed.
 * ===================================================================== */

const T0 = Date.parse('2026-08-12T22:00:00.000Z')

test('an answered ping is proof of life on its own', () => {
  const verdict = backgroundAliveVerdict({
    pingReplied: true,
    beforeUpdatedAt: '',
    afterUpdatedAt: '',
    now: T0,
  })
  assert.equal(verdict.dead, false)
})

test('a dropped reply with a FRESHENED bridgeStatus is a live worker', () => {
  const verdict = backgroundAliveVerdict({
    pingReplied: false,
    beforeUpdatedAt: new Date(T0 - 60_000).toISOString(),
    afterUpdatedAt: new Date(T0 - 500).toISOString(),
    now: T0,
  })
  assert.equal(verdict.dead, false)
  assert.match(verdict.why, /freshened/)
})

test('an unchanged but fresh bridgeStatus means an engine already runs — not dead', () => {
  const at = new Date(T0 - 4_000).toISOString()
  const verdict = backgroundAliveVerdict({
    pingReplied: false,
    beforeUpdatedAt: at,
    afterUpdatedAt: at,
    now: T0,
  })
  assert.equal(verdict.dead, false)
})

test('an unanswered ping over a stale, unmoved bridgeStatus is a dead background', () => {
  const at = new Date(T0 - 3 * 60_000).toISOString()
  const verdict = backgroundAliveVerdict({
    pingReplied: false,
    beforeUpdatedAt: at,
    afterUpdatedAt: at,
    now: T0,
  })
  assert.equal(verdict.dead, true)
})

test('no bridgeStatus at all (fresh install, dead background) is dead', () => {
  const verdict = backgroundAliveVerdict({
    pingReplied: false,
    beforeUpdatedAt: '',
    afterUpdatedAt: '',
    now: T0,
  })
  assert.equal(verdict.dead, true)
})

/* ===================================================================== *
 * leaseDecision: acquire / retain / steal / blocked.
 * ===================================================================== */

test('the background acquires unconditionally, even over a fresh page lease', () => {
  const overPage = leaseDecision(
    { holder: 'console-abc', at: T0 - 100 },
    { holder: BACKGROUND_HOLDER, now: T0 },
  )
  assert.equal(overPage.action, 'acquire')

  const own = leaseDecision(
    { holder: BACKGROUND_HOLDER, at: T0 - 100 },
    { holder: BACKGROUND_HOLDER, now: T0 },
  )
  assert.equal(own.action, 'retain')
})

test('a page acquires a free or malformed lease', () => {
  assert.equal(leaseDecision(undefined, { holder: 'popover-1', now: T0 }).action, 'acquire')
  assert.equal(leaseDecision(null, { holder: 'popover-1', now: T0 }).action, 'acquire')
  assert.equal(
    leaseDecision({ holder: '', at: T0 }, { holder: 'popover-1', now: T0 }).action,
    'acquire',
  )
  assert.equal(
    leaseDecision({ holder: 'console-2', at: 'soon' }, { holder: 'popover-1', now: T0 }).action,
    'acquire',
  )
})

test('a page retains its own lease and is blocked by another page\'s fresh one', () => {
  assert.equal(
    leaseDecision({ holder: 'console-2', at: T0 - 1_000 }, { holder: 'console-2', now: T0 }).action,
    'retain',
  )
  const blocked = leaseDecision(
    { holder: 'console-2', at: T0 - 1_000 },
    { holder: 'popover-1', now: T0 },
  )
  assert.equal(blocked.action, 'blocked')
  assert.match(blocked.reason, /console-2/)
})

test('a page steals another page\'s lease only once it is provably stale', () => {
  const justInside = leaseDecision(
    { holder: 'console-2', at: T0 - PAGE_LEASE_STALE_MS },
    { holder: 'popover-1', now: T0 },
  )
  assert.equal(justInside.action, 'blocked')

  const stale = leaseDecision(
    { holder: 'console-2', at: T0 - PAGE_LEASE_STALE_MS - 1 },
    { holder: 'popover-1', now: T0 },
  )
  assert.equal(stale.action, 'acquire')
})

test('the background\'s lease is measured against its own 30s alarm cadence', () => {
  /* 30s old would be one missed alarm — never stealable. */
  const oneAlarm = leaseDecision(
    { holder: BACKGROUND_HOLDER, at: T0 - 30_000 },
    { holder: 'console-2', now: T0 },
  )
  assert.equal(oneAlarm.action, 'blocked')

  const abandoned = leaseDecision(
    { holder: BACKGROUND_HOLDER, at: T0 - BACKGROUND_LEASE_STALE_MS - 1 },
    { holder: 'console-2', now: T0 },
  )
  assert.equal(abandoned.action, 'acquire')

  /* The asymmetry is the rule: a page lease this old fell long ago. */
  assert.ok(BACKGROUND_LEASE_STALE_MS > PAGE_LEASE_STALE_MS)
  assert.ok(BACKGROUND_LEASE_STALE_MS > 2 * 30_000, 'two whole alarm periods plus slack')
})
