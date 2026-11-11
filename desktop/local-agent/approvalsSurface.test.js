import assert from 'node:assert/strict'
import test from 'node:test'
import './testWorkspace.js'

import {
  createApprovalsSurface,
  pendingApprovalRow,
  registerApprovalsSurfaceRoutes,
} from './approvalsSurface.js'

/*
 * THE CONTRACT UNDER TEST IS FROZEN. A Swift consumer is being built against
 * exactly the shapes asserted here:
 *
 *   GET  /approvals/pending           → { approvals: [{ id, summary, detail,
 *                                          origin, risk, createdAt, expiresAt }] }
 *   POST /approvals/:id/decision      → { ok: true, state } | { ok: false, error }
 *
 * Everything runs against an injected fetch — never the live agent on :8000
 * (the operator restarts that; these routes go live then) and never the live
 * relay.
 */

const NOW = Date.parse('2026-08-09T09:00:00.000Z')
const LIVE = new Date(NOW + 20 * 60_000).toISOString()

const CREDENTIAL = { token: 'pdt_testtoken_not_a_secret.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'device', source: 'test' }

function relayRecord(overrides = {}) {
  return {
    approvalId: 'apv_1234567890',
    deviceId: 'nrf9160-pendant',
    origin: 'floating-hud',
    state: 'pending',
    readback: 'Ready to tidy the downloads folder. It will move 3 files. Nothing has run yet. To approve, say: approve marlin.',
    risk: { tiers: { 'reversible-write': 3 }, steps: 3, writes: 3, irreversible: 0 },
    createdAt: new Date(NOW).toISOString(),
    expiresAt: LIVE,
    ...overrides,
  }
}

/** A fetch stub that records what the surface sent and answers as the relay. */
function relayStub(handler) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const reply = await handler(String(url), options)
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    }
  }
  return { calls, fetchImpl }
}

function surfaceWith(handler) {
  const stub = relayStub(handler)
  const surface = createApprovalsSurface({
    relayUrl: 'https://relay.test',
    credential: CREDENTIAL,
    fetchImpl: stub.fetchImpl,
  })
  return { surface, calls: stub.calls }
}

/* ------------------------------------------------------------ row shape */

test('a pending relay record becomes exactly the frozen row', () => {
  const row = pendingApprovalRow(relayRecord(), { now: NOW })

  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'detail', 'expiresAt', 'id', 'origin', 'risk', 'summary'])
  assert.equal(row.id, 'apv_1234567890')
  assert.equal(row.summary, 'Ready to tidy the downloads folder.')
  assert.match(row.detail, /approve marlin/)
  assert.equal(row.origin, 'floating-hud')
  assert.equal(row.risk, 'reversible-write', 'risk is a phrase, never an object')
  assert.equal(row.createdAt, new Date(NOW).toISOString())
  assert.equal(row.expiresAt, LIVE)
})

test('settled and expired records never reach the list', () => {
  assert.equal(pendingApprovalRow(relayRecord({ state: 'granted' }), { now: NOW }), null)
  assert.equal(pendingApprovalRow(relayRecord({ state: 'denied' }), { now: NOW }), null)
  assert.equal(
    pendingApprovalRow(relayRecord({ expiresAt: new Date(NOW - 1).toISOString() }), { now: NOW }),
    null,
  )
  assert.equal(pendingApprovalRow(null, { now: NOW }), null)
})

test('a record from before origin routing lists with origin null, not missing', () => {
  const legacy = relayRecord()
  delete legacy.origin
  const row = pendingApprovalRow(legacy, { now: NOW })
  assert.equal(row.origin, null)
  assert.ok('origin' in row, 'the key is present for the frozen decoder')
})

/* ---------------------------------------------------------- the surface */

test('listPending forwards with the agent credential and returns only live rows', async () => {
  const { surface, calls } = surfaceWith(async () => ({
    status: 200,
    body: {
      ok: true,
      approvals: [
        relayRecord(),
        relayRecord({ approvalId: 'apv_settled', state: 'granted' }),
        relayRecord({ approvalId: 'apv_expired', expiresAt: new Date(NOW - 1000).toISOString() }),
      ],
    },
  }))

  const result = await surface.listPending({ now: NOW })
  assert.equal(result.ok, true)
  assert.equal(result.approvals.length, 1)
  assert.equal(result.approvals[0].id, 'apv_1234567890')

  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /^https:\/\/relay\.test\/v1\/approvals\?deviceId=nrf9160-pendant$/)
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${CREDENTIAL.token}`)
})

test('decide forwards the decision and answers the frozen success shape', async () => {
  const { surface, calls } = surfaceWith(async (url) => {
    assert.match(url, /\/v1\/approvals\/apv_1234567890\/decision$/)
    return { status: 200, body: { ok: true, code: 'settled', state: 'granted' } }
  })

  const result = await surface.decide({ approvalId: 'apv_1234567890', decision: 'approve' })
  assert.deepEqual(result, { ok: true, state: 'granted' })

  const sent = JSON.parse(calls[0].options.body)
  assert.equal(sent.decision, 'approve')
})

test('an already-settled decision comes back ok:false with the state in the error', async () => {
  const { surface } = surfaceWith(async () => ({
    status: 409,
    body: { ok: false, code: 'already_settled', state: 'denied', why: 'This approval was already denied.' },
  }))

  const result = await surface.decide({ approvalId: 'apv_1234567890', decision: 'approve' })
  assert.equal(result.ok, false)
  assert.match(result.error, /already denied/)
})

test('a dead relay is an error the caller can read, not a throw', async () => {
  const surface = createApprovalsSurface({
    relayUrl: 'https://relay.test',
    credential: CREDENTIAL,
    fetchImpl: async () => {
      throw new Error('socket hang up')
    },
  })
  const listed = await surface.listPending()
  assert.equal(listed.ok, false)
  assert.match(listed.error, /socket hang up/)
  const decided = await surface.decide({ approvalId: 'apv_x', decision: 'deny' })
  assert.equal(decided.ok, false)
})

/* ------------------------------------------------------------ the routes */

/* The express stand-in every route test here uses; see handleThisRoutes.test.js. */
function fakeApp() {
  const routes = new Map()
  const register = (method) => (route, handler) => routes.set(`${method} ${route}`, handler)
  return {
    get: register('GET'),
    post: register('POST'),
    async call(method, route, { params = {}, body = {} } = {}) {
      const handler = routes.get(`${method} ${route}`)
      if (!handler) throw new Error(`No route registered for ${method} ${route}`)
      let statusCode = 200
      let payload = null
      const response = {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        },
      }
      await handler({ params, body }, response)
      return { statusCode, payload }
    },
  }
}

test('GET /approvals/pending answers the frozen envelope exactly', async () => {
  const app = fakeApp()
  const stub = relayStub(async () => ({
    status: 200,
    body: { ok: true, approvals: [relayRecord({ expiresAt: new Date(Date.now() + 600_000).toISOString() })] },
  }))
  registerApprovalsSurfaceRoutes(app, {
    relayUrl: 'https://relay.test',
    credential: CREDENTIAL,
    fetchImpl: stub.fetchImpl,
  })

  const { statusCode, payload } = await app.call('GET', '/approvals/pending')
  assert.equal(statusCode, 200)
  assert.deepEqual(Object.keys(payload), ['approvals'], 'the success envelope is { approvals } and nothing else')
  assert.equal(payload.approvals.length, 1)
  assert.deepEqual(
    Object.keys(payload.approvals[0]).sort(),
    ['createdAt', 'detail', 'expiresAt', 'id', 'origin', 'risk', 'summary'],
  )
})

test('POST /approvals/:approvalId/decision validates before it forwards', async () => {
  const app = fakeApp()
  const stub = relayStub(async () => ({ status: 200, body: { ok: true, state: 'denied' } }))
  registerApprovalsSurfaceRoutes(app, {
    relayUrl: 'https://relay.test',
    credential: CREDENTIAL,
    fetchImpl: stub.fetchImpl,
  })

  const junk = await app.call('POST', '/approvals/:approvalId/decision', {
    params: { approvalId: 'apv_1' },
    body: { decision: 'perhaps' },
  })
  assert.equal(junk.statusCode, 400)
  assert.equal(junk.payload.ok, false)
  assert.ok(junk.payload.error)
  assert.equal(stub.calls.length, 0, 'junk never reaches the relay')

  const denied = await app.call('POST', '/approvals/:approvalId/decision', {
    params: { approvalId: 'apv_1' },
    body: { decision: 'deny' },
  })
  assert.equal(denied.statusCode, 200)
  assert.deepEqual(denied.payload, { ok: true, state: 'denied' })
})

test('a relay refusal surfaces as { ok:false, error } with the relay status', async () => {
  const app = fakeApp()
  registerApprovalsSurfaceRoutes(app, {
    relayUrl: 'https://relay.test',
    credential: CREDENTIAL,
    fetchImpl: relayStub(async () => ({
      status: 404,
      body: { ok: false, code: 'not_found', why: 'No approval is stored under that id.' },
    })).fetchImpl,
  })

  const { statusCode, payload } = await app.call('POST', '/approvals/:approvalId/decision', {
    params: { approvalId: 'apv_missing' },
    body: { decision: 'approve' },
  })
  assert.equal(statusCode, 404)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /No approval/)
})
