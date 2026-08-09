/*
 * The scope table had never been exercised by a scoped client. Every node
 * authenticated with the admin key, whose '*' scope short-circuits
 * principalHasScopes before the table is consulted at all — so "the roles are
 * correct" was an untested claim about dead code. This pins the matrix.
 *
 * Fixtures only: no real key, no real token, no network.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  requiredScopesForRequest,
  requiredScopesForRoute,
  SOCKET_SCOPES,
} from './relayScopes.js'
import {
  createDeviceCredential,
  DEVICE_SCOPES,
  principalHasScopes,
} from './deviceAuth.js'

const deterministicRandom = (size) => Buffer.alloc(size, size)

function principalFor(role) {
  const { record } = createDeviceCredential({
    deviceId: `${role}-fixture`,
    deviceType: role,
    randomBytes: deterministicRandom,
  })
  return { kind: 'device', role, deviceId: record.deviceId, scopes: record.scopes }
}

function allows(role, method, path) {
  const required = requiredScopesForRoute(method, path)
  return Boolean(required) && principalHasScopes(principalFor(role), ...required)
}

/* Every relay route the Mac bridge actually calls, read off bridge.js and
 * productSyncClient.js. If one of these flips to false the bridge cannot run
 * on its own credential and would silently need the admin key back. */
const MAC_BRIDGE_ROUTES = [
  ['POST', '/v1/devices/heartbeat'],
  ['GET', '/v1/bridge/work'],
  ['POST', '/v1/bridge/work/job-123/result'],
  ['PUT', '/v1/state/agent-snapshot'],
  ['PUT', '/v1/state/fleet'],
  ['GET', '/v1/product/state/single-owner'],
  ['PUT', '/v1/product/state'],
]

/* Every relay route the pendant firmware calls (pendant_cloud.c). */
const NRF_PENDANT_ROUTES = [
  ['POST', '/v1/pendant/command'],
  ['POST', '/v1/pendant/announce'],
  ['POST', '/v1/pendant/jobs/job-123/events'],
  ['GET', '/v1/pendant/jobs/job-123/speech'],
  ['POST', '/v1/mac/plan'],
  ['GET', '/v1/mac/jobs/job-123'],
  ['POST', '/v1/transcribe'],
  /* pendant_store.c polls this when CONFIG_PENDANT_ALERT_INBOX is on. */
  ['GET', '/v1/state/pendant-alerts'],
]

test('a mac_bridge token is accepted for every route the bridge uses', () => {
  for (const [method, path] of MAC_BRIDGE_ROUTES) {
    assert.equal(
      allows('mac_bridge', method, path),
      true,
      `mac_bridge must be allowed ${method} ${path}`,
    )
  }
})

test('an nrf_pendant token is accepted for every route the firmware uses', () => {
  for (const [method, path] of NRF_PENDANT_ROUTES) {
    assert.equal(
      allows('nrf_pendant', method, path),
      true,
      `nrf_pendant must be allowed ${method} ${path}`,
    )
  }
})

test('a scoped token is refused everything outside its role', () => {
  /* The blast radius the admin key hands every node today, denied per role. */
  const forbiddenForBridge = [
    ['POST', '/v1/devices/register'],
    ['POST', '/v1/ops/proxy'],
    ['GET', '/v1/ops/credentials'],
    ['POST', '/v1/ops/credentials/tok/revoke'],
    ['POST', '/v1/routines'],
    ['POST', '/v1/announcements'],
    ['POST', '/v1/mac/execute'],
    ['POST', '/v1/pendant/command'],
  ]
  for (const [method, path] of forbiddenForBridge) {
    assert.equal(
      allows('mac_bridge', method, path),
      false,
      `mac_bridge must NOT be allowed ${method} ${path}`,
    )
  }

  const forbiddenForPendant = [
    ['GET', '/v1/bridge/work'],
    ['POST', '/v1/bridge/work/job-1/result'],
    ['PUT', '/v1/state/fleet'],
    ['POST', '/v1/mac/execute'],
    ['GET', '/v1/ops/credentials'],
    ['POST', '/v1/routines'],
    /* Its one alert key must not have widened into the whole key space: the
     * Mac's world model lives next door under the same prefix. */
    ['GET', '/v1/state/fleet'],
    ['GET', '/v1/state/agent-snapshot'],
    ['PUT', '/v1/state/pendant-alerts'],
  ]
  for (const [method, path] of forbiddenForPendant) {
    assert.equal(
      allows('nrf_pendant', method, path),
      false,
      `nrf_pendant must NOT be allowed ${method} ${path}`,
    )
  }

  /* mobile is the role a phone or browser node would hold. */
  for (const [method, path] of [
    ['GET', '/v1/bridge/work'],
    ['POST', '/v1/pendant/command'],
    ['GET', '/v1/ops/history'],
    ['PUT', '/v1/state/fleet'],
  ]) {
    assert.equal(
      allows('mobile', method, path),
      false,
      `mobile must NOT be allowed ${method} ${path}`,
    )
  }
})

test('an unlisted route is closed to everyone, admin included', () => {
  /* server.js treats a null table result as DENY, so this is the real
   * behaviour for any path nobody declared — including the admin principal. */
  assert.equal(requiredScopesForRoute('GET', '/v1/not-a-route'), null)
  assert.equal(requiredScopesForRoute('DELETE', '/v1/devices/heartbeat'), null)
})

test('requiredScopesForRequest reads method and path off a request', () => {
  assert.deepEqual(
    requiredScopesForRequest({ method: 'get', path: '/v1/bridge/work' }),
    ['bridge:work:claim'],
  )
})

test('the two socket routes demand scopes their role actually holds', () => {
  /* Neither socket passes through Express, so their requirements live in
   * SOCKET_SCOPES and are asserted by bridgeHub.js / pendantConverse.js. */
  assert.equal(
    principalHasScopes(
      principalFor('mac_bridge'),
      ...SOCKET_SCOPES['/v1/bridge/socket'],
    ),
    true,
  )
  assert.equal(
    principalHasScopes(
      principalFor('nrf_pendant'),
      ...SOCKET_SCOPES['/v1/pendant/converse'],
    ),
    true,
  )
  /* And a bridge cannot open a pendant conversation. */
  assert.equal(
    principalHasScopes(
      principalFor('mac_bridge'),
      ...SOCKET_SCOPES['/v1/pendant/converse'],
    ),
    false,
  )
})

test('no role is a de facto admin', () => {
  for (const role of Object.keys(DEVICE_SCOPES)) {
    assert.equal(
      DEVICE_SCOPES[role].includes('*'),
      false,
      `${role} must not carry the wildcard scope`,
    )
    assert.equal(
      DEVICE_SCOPES[role].includes('admin'),
      false,
      `${role} must not carry the admin scope`,
    )
  }
})
