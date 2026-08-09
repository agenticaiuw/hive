/*
 * The commissioning lifecycle end to end, at the level the pairing CLI drives
 * it: mint → store → authenticate → list → revoke → refuse.
 *
 * deviceAuth.test.js already covers the primitives. What was never covered is
 * the part that made the scheme unusable: nothing could enumerate or kill a
 * credential, so nothing was ever issued and every node kept the admin key.
 *
 * Fixtures only — the admin key here is the literal string 'admin-key-fixture'.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authenticateRelayRequest,
  createDeviceCredential,
  principalHasScopes,
  principalOwnsDevice,
  publicCredential,
  verifyPairingCode,
} from './deviceAuth.js'
import { createMemoryStore } from './store/memoryStore.js'
import { requiredScopesForRoute } from './relayScopes.js'

const ADMIN_KEY = 'admin-key-fixture'

/* What POST /v1/devices/pair does, in the order server.js does it. */
async function pair(store, { deviceId, deviceType, pairingCode = 'code' }) {
  assert.equal(verifyPairingCode(pairingCode, 'code'), true)
  const now = new Date().toISOString()
  const issued = createDeviceCredential({ deviceId, deviceType, now })
  await store.saveDevice({
    deviceId,
    deviceType,
    name: deviceId,
    registeredAt: now,
    lastSeenAt: now,
    updatedAt: now,
  })
  await store.saveDeviceCredential(issued.record)
  return issued
}

test('pairing mints a token and stores only its hash', async () => {
  const store = createMemoryStore()
  const issued = await pair(store, {
    deviceId: 'home-macbook-bridge',
    deviceType: 'mac_bridge',
  })

  const stored = await store.getDeviceCredential(issued.record.tokenId)
  assert.ok(stored)
  /* The secret half must be nowhere in what was persisted. */
  const secret = issued.token.split('.')[1]
  assert.equal(JSON.stringify(stored).includes(secret), false)
  assert.equal(JSON.stringify(stored).includes(issued.token), false)
  assert.equal(stored.tokenHash.length, 64)
  /* And the shape that leaves over HTTP carries no hash at all. */
  assert.equal(publicCredential(stored).tokenHash, undefined)
  assert.equal(publicCredential(stored).token, undefined)
})

test('a paired token authenticates with exactly its role scopes', async () => {
  const store = createMemoryStore()
  const issued = await pair(store, {
    deviceId: 'home-macbook-bridge',
    deviceType: 'mac_bridge',
  })

  const auth = await authenticateRelayRequest({
    authorization: `Bearer ${issued.token}`,
    adminApiKey: ADMIN_KEY,
    credentialStore: store,
  })
  assert.equal(auth.ok, true)
  assert.equal(auth.principal.kind, 'device')
  assert.equal(auth.principal.role, 'mac_bridge')
  assert.equal(auth.principal.scopes.includes('*'), false)

  /* Its own route: allowed. An ops route: refused. */
  assert.equal(
    principalHasScopes(
      auth.principal,
      ...requiredScopesForRoute('GET', '/v1/bridge/work'),
    ),
    true,
  )
  assert.equal(
    principalHasScopes(
      auth.principal,
      ...requiredScopesForRoute('GET', '/v1/ops/credentials'),
    ),
    false,
  )
})

test('listing shows credentials without exposing any secret', async () => {
  const store = createMemoryStore()
  const bridge = await pair(store, {
    deviceId: 'home-macbook-bridge',
    deviceType: 'mac_bridge',
  })
  const pendant = await pair(store, {
    deviceId: 'nrf9160-pendant',
    deviceType: 'nrf_pendant',
  })

  const all = await store.listDeviceCredentials()
  assert.equal(all.length, 2)

  const listed = all.map((record) => publicCredential(record))
  const serialized = JSON.stringify(listed)
  for (const token of [bridge.token, pendant.token]) {
    assert.equal(serialized.includes(token.split('.')[1]), false)
  }
  assert.equal(serialized.includes('tokenHash'), false)

  const filtered = await store.listDeviceCredentials({
    deviceId: 'nrf9160-pendant',
  })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].tokenId, pendant.record.tokenId)
})

test('revocation refuses the token on the very next request', async () => {
  const store = createMemoryStore()
  const issued = await pair(store, {
    deviceId: 'home-macbook-bridge',
    deviceType: 'mac_bridge',
  })

  const before = await authenticateRelayRequest({
    authorization: `Bearer ${issued.token}`,
    adminApiKey: ADMIN_KEY,
    credentialStore: store,
  })
  assert.equal(before.ok, true)

  /* What POST /v1/ops/credentials/:tokenId/revoke does. */
  const revoked = await store.revokeDeviceCredential(issued.record.tokenId)
  assert.ok(revoked.revokedAt)

  const after = await authenticateRelayRequest({
    authorization: `Bearer ${issued.token}`,
    adminApiKey: ADMIN_KEY,
    credentialStore: store,
  })
  assert.equal(after.ok, false)
  assert.equal(after.status, 401)
  assert.equal(after.code, 'invalid_or_revoked_device_token')

  /* Revoking twice stays revoked and stays refused (the route is idempotent). */
  await store.revokeDeviceCredential(issued.record.tokenId)
  const again = await authenticateRelayRequest({
    authorization: `Bearer ${issued.token}`,
    adminApiKey: ADMIN_KEY,
    credentialStore: store,
  })
  assert.equal(again.ok, false)

  /* Revoking one device must not touch its sibling. */
  const pendant = await pair(store, {
    deviceId: 'nrf9160-pendant',
    deviceType: 'nrf_pendant',
  })
  const sibling = await authenticateRelayRequest({
    authorization: `Bearer ${pendant.token}`,
    adminApiKey: ADMIN_KEY,
    credentialStore: store,
  })
  assert.equal(sibling.ok, true)
})

test('principalOwnsDevice blocks cross-device access', async () => {
  const store = createMemoryStore()
  const bridge = await pair(store, {
    deviceId: 'home-macbook-bridge',
    deviceType: 'mac_bridge',
  })
  await pair(store, { deviceId: 'other-mac-bridge', deviceType: 'mac_bridge' })

  const auth = await authenticateRelayRequest({
    authorization: `Bearer ${bridge.token}`,
    adminApiKey: ADMIN_KEY,
    credentialStore: store,
  })

  /* Same scopes as the sibling, so the scope check alone would pass — this is
   * the second gate, the one that keeps one bridge out of another's queue. */
  assert.equal(principalOwnsDevice(auth.principal, 'home-macbook-bridge'), true)
  assert.equal(principalOwnsDevice(auth.principal, 'other-mac-bridge'), false)
  assert.equal(principalOwnsDevice(auth.principal, 'nrf9160-pendant'), false)

  /* The admin key owns everything, which is exactly the problem being retired. */
  const admin = await authenticateRelayRequest({
    authorization: `Bearer ${ADMIN_KEY}`,
    adminApiKey: ADMIN_KEY,
    credentialStore: store,
  })
  assert.equal(principalOwnsDevice(admin.principal, 'other-mac-bridge'), true)
})

test('a forged or truncated token never authenticates', async () => {
  const store = createMemoryStore()
  const issued = await pair(store, {
    deviceId: 'home-macbook-bridge',
    deviceType: 'mac_bridge',
  })
  const [tokenId] = issued.token.split('.')

  for (const forged of [
    `${tokenId}.${'A'.repeat(43)}`,
    issued.token.slice(0, -1),
    `${issued.token}x`,
    'pdt_notreal.notreal',
  ]) {
    const result = await authenticateRelayRequest({
      authorization: `Bearer ${forged}`,
      adminApiKey: ADMIN_KEY,
      credentialStore: store,
    })
    assert.equal(result.ok, false, `must refuse ${forged.slice(0, 12)}…`)
  }
})
