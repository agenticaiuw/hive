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
  credentialNarrowedBelowRole,
  DEVICE_SCOPES,
  effectiveScopesForCredential,
  principalHasScopes,
} from './deviceAuth.js'

const deterministicRandom = (size) => Buffer.alloc(size, size)

/* Built the way authenticateRelayRequest builds one: scopes DERIVED from the
 * record, never read off it. The two are equal for a freshly minted credential,
 * which is exactly why reading record.scopes here would look correct forever
 * while testing a path the relay no longer takes. */
function principalFor(role) {
  const { record } = createDeviceCredential({
    deviceId: `${role}-fixture`,
    deviceType: role,
    randomBytes: deterministicRandom,
  })
  return {
    kind: 'device',
    role,
    deviceId: record.deviceId,
    narrowed: Boolean(record.narrowed),
    scopes: effectiveScopesForCredential(record),
  }
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

/* The browser extension's role. It had NO relay credential at all before the
 * mesh landed — it knew one URL, 127.0.0.1:8000 — so this list is what the
 * extension must be able to do to be a node rather than a Mac accessory. */
const BROWSER_NODE_ROUTES = [
  ['POST', '/v1/devices/heartbeat'],
  ['GET', '/v1/devices/status'],
  ['POST', '/v1/node/messages'],
  ['GET', '/v1/node/inbox'],
  ['POST', '/v1/node/inbox/ack'],
  ['GET', '/v1/node/presence'],
  ['POST', '/v1/infer'],
  ['POST', '/v1/context/resume'],
]

test('a browser_node token is accepted for every route the extension needs', () => {
  for (const [method, path] of BROWSER_NODE_ROUTES) {
    assert.equal(
      allows('browser_node', method, path),
      true,
      `browser_node must be allowed ${method} ${path}`,
    )
  }
})

test('browser_node is NOT the Mac, which is why it is a separate role', () => {
  /*
   * The tempting shortcut was to hand the extension a mac_bridge token. That
   * role holds state:write — it owns agent-snapshot and fleet, the Mac's whole
   * world model — and bridge:work:claim, so an extension running inside a
   * compromised page could have drained the Mac's work queue. These are the
   * assertions that keep the shortcut from being taken later.
   */
  for (const [method, path] of [
    ['GET', '/v1/bridge/work'],
    ['POST', '/v1/bridge/work/job-1/result'],
    ['PUT', '/v1/state/fleet'],
    ['PUT', '/v1/state/agent-snapshot'],
    ['GET', '/v1/state/agent-snapshot'],
    ['POST', '/v1/mac/execute'],
    ['POST', '/v1/pendant/command'],
    ['GET', '/v1/ops/credentials'],
    ['DELETE', '/v1/devices/browser-node-1'],
  ]) {
    assert.equal(
      allows('browser_node', method, path),
      false,
      `browser_node must NOT be allowed ${method} ${path}`,
    )
  }
})

test('every node that can hold a mesh socket can also use the mesh', () => {
  /* A role that can be told mail is waiting but cannot drain it would hold a
   * socket that does nothing — the failure mode a scope table catches only if
   * someone asserts the pairing. */
  for (const role of ['mobile', 'mac_bridge', 'browser_node']) {
    assert.equal(allows(role, 'GET', '/v1/node/inbox'), true, role)
    assert.equal(allows(role, 'POST', '/v1/node/inbox/ack'), true, role)
    assert.equal(allows(role, 'POST', '/v1/node/messages'), true, role)
    assert.equal(
      principalHasScopes(principalFor(role), ...SOCKET_SCOPES['/v1/node/socket']),
      true,
      `${role} must be able to open /v1/node/socket`,
    )
  }
})

test('the pendant is deliberately not on the mesh', () => {
  /*
   * Not an oversight. The nRF9160 already holds one socket and has no modem
   * budget for a second; its receive buffer is 640 B, so it could not read an
   * inbox page even if it drained one. A scope firmware cannot exercise is a
   * lie in the credential table. Reaching the pendant is what
   * POST /v1/pendant/announce is for, which this role does hold.
   */
  assert.equal(allows('nrf_pendant', 'GET', '/v1/node/inbox'), false)
  assert.equal(allows('nrf_pendant', 'POST', '/v1/node/messages'), false)
  assert.equal(
    principalHasScopes(
      principalFor('nrf_pendant'),
      ...SOCKET_SCOPES['/v1/node/socket'],
    ),
    false,
  )
  assert.equal(allows('nrf_pendant', 'POST', '/v1/pendant/announce'), true)
})

test('inference is metered by role, and the pendant has no brain budget', () => {
  /* The one route where a leaked token costs money rather than access. */
  assert.equal(allows('mobile', 'POST', '/v1/infer'), true)
  assert.equal(allows('browser_node', 'POST', '/v1/infer'), true)
  assert.equal(allows('nrf_pendant', 'POST', '/v1/infer'), false)
  assert.equal(allows('mac_bridge', 'POST', '/v1/infer'), false)
})

test('retiring a device is owner work', () => {
  /* No node may unregister another, or itself: deleting a device revokes its
   * credentials and drops its mail, which is not a thing a lost phone should
   * be able to do to the fleet. */
  for (const role of Object.keys(DEVICE_SCOPES)) {
    assert.equal(
      allows(role, 'DELETE', '/v1/devices/anything'),
      false,
      `${role} must not be able to retire a device`,
    )
  }
  assert.deepEqual(
    requiredScopesForRoute('DELETE', '/v1/devices/some-node'),
    ['admin'],
  )
})

test('the vision route is no longer unreachable', () => {
  /*
   * local-agent/visionLoopRelay.js has named /v1/vision/classify-ui-state
   * since it was written and it was never in this table, which meant it was
   * not merely unimplemented — an unlisted path denies universally, so it was
   * 403 for every principal including the owner's admin key. Its module flag
   * ENDPOINT_IMPLEMENTED=false is still the honest signal for the missing
   * handler; this only removes the second, invisible reason.
   */
  assert.deepEqual(
    requiredScopesForRoute('POST', '/v1/vision/classify-ui-state'),
    ['mac:plan'],
  )
  assert.equal(allows('nrf_pendant', 'POST', '/v1/vision/classify-ui-state'), true)
  assert.equal(allows('mac_bridge', 'POST', '/v1/vision/classify-ui-state'), false)
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

test('only a NARROWED credential gets the re-pair diagnostic', () => {
  /*
   * This used to answer "was this credential paired before the capability
   * shipped", which mattered when scopes were frozen at pair time and a role
   * widening reached nothing already in the field. It no longer happens:
   * effective scopes are derived from the live table on every request, so an
   * un-narrowed credential — every credential in the fleet — picks a new scope
   * up on its next request and has nothing to re-pair for.
   *
   * A credential minted with an explicit ceiling is the case that survives, and
   * it survives permanently: no deploy ever widens it. That denial has a remedy
   * (re-pair with a wider list) and stays distinguishable from a role denial,
   * which has none.
   */
  const { record } = createDeviceCredential({
    deviceId: 'phone-paired-last-month',
    deviceType: 'mobile',
    randomBytes: deterministicRandom,
  })

  /* An old un-narrowed row missing the newer scopes: no diagnostic, because
   * there is no denial — it holds them. */
  const untouched = {
    kind: 'device',
    role: 'mobile',
    deviceId: record.deviceId,
    narrowed: false,
    scopes: effectiveScopesForCredential({
      role: 'mobile',
      scopes: record.scopes.filter(
        (scope) => !['llm:infer', 'node:message:send', 'node:message:receive'].includes(scope),
      ),
    }),
  }
  assert.equal(principalHasScopes(untouched, 'llm:infer'), true)
  assert.equal(credentialNarrowedBelowRole(untouched, ['llm:infer']), false)

  /*
   * The same answer for a principal that is un-narrowed AND short of its role.
   * authenticateRelayRequest cannot produce this — an un-narrowed credential is
   * given its whole role by construction — so this is not a claim that the
   * state occurs. It pins the function's contract: the answer is about whether
   * an explicit CEILING is withholding the scope, not about the gap between
   * some scope list and role policy. Answering from the gap alone would put
   * "re-pair to pick it up" in front of anyone who ever builds a principal from
   * a stored row, where it would be false.
   */
  assert.equal(
    credentialNarrowedBelowRole(
      { kind: 'device', role: 'mobile', narrowed: false, scopes: ['state:read'] },
      ['llm:infer'],
    ),
    false,
  )

  /* The same missing scopes, on a credential that was narrowed on purpose. */
  const narrowed = { ...untouched, narrowed: true, scopes: ['state:read'] }
  assert.equal(principalHasScopes(narrowed, 'llm:infer'), false)
  assert.deepEqual(credentialNarrowedBelowRole(narrowed, ['llm:infer']), ['llm:infer'])
  assert.deepEqual(
    credentialNarrowedBelowRole(narrowed, ['node:message:receive']),
    ['node:message:receive'],
  )

  /* A scope the role does not grant is a real denial either way: the pendant is
   * not one re-pair away from claiming the Mac's work, and no re-pair ever
   * turns a device into an admin. */
  assert.equal(
    credentialNarrowedBelowRole(principalFor('nrf_pendant'), ['bridge:work:claim']),
    false,
  )
  assert.equal(credentialNarrowedBelowRole(narrowed, ['admin']), false)
  /* Nor does it fire for the admin principal, which holds '*' and is never a
   * device. */
  assert.equal(
    credentialNarrowedBelowRole({ kind: 'admin', role: 'admin', scopes: ['*'] }, ['admin']),
    false,
  )
})

test('editing DEVICE_SCOPES withdraws from paired devices, in both directions', () => {
  /*
   * The route table's half of the credential-model change. A role's entry in
   * DEVICE_SCOPES is now the live answer for every un-narrowed credential, so
   * these two statements — which were false before — are what the matrix above
   * is actually asserting about the fleet, not merely about fresh tokens.
   *
   * The rows here are what a paired device's row looks like on either side of a
   * policy edit; DEVICE_SCOPES is frozen, and it does not need to be mutable,
   * because the only thing an edit changes for an existing device is whether
   * its stored list still matches the table.
   */
  const wideRow = {
    role: 'mobile',
    /* A row from before mac:execute would have been withdrawn from phones. */
    scopes: [...DEVICE_SCOPES.mobile, 'bridge:work:claim', 'state:write'],
  }
  const narrowRow = {
    role: 'mobile',
    /* A row from before the mesh and the relay brain shipped. */
    scopes: ['device:heartbeat:self', 'state:read'],
  }

  for (const row of [wideRow, narrowRow]) {
    const principal = {
      kind: 'device',
      role: row.role,
      narrowed: false,
      scopes: effectiveScopesForCredential(row),
    }
    assert.deepEqual(principal.scopes, [...DEVICE_SCOPES.mobile])
    /* A route mobile is not entitled to stays shut no matter what the row said. */
    assert.equal(
      principalHasScopes(principal, ...requiredScopesForRoute('GET', '/v1/bridge/work')),
      false,
    )
    /* A route mobile IS entitled to opens no matter what the row said. */
    assert.equal(
      principalHasScopes(principal, ...requiredScopesForRoute('POST', '/v1/infer')),
      true,
    )
  }
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
