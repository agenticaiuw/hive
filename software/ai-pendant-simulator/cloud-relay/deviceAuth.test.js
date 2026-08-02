import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authenticateRelayRequest,
  createDeviceCredential,
  DEVICE_SCOPES,
  parseDeviceToken,
  principalHasScopes,
  principalOwnsDevice,
  publicCredential,
  verifyDeviceToken,
  verifyPairingCode,
} from './deviceAuth.js'
import { createMemoryStore } from './store/memoryStore.js'

const deterministicRandom = (size) => Buffer.alloc(size, size)

test('creates an opaque credential and stores only its hash', () => {
  const created = createDeviceCredential({
    deviceId: 'mobile-test-1',
    deviceType: 'mobile',
    now: '2026-08-02T20:00:00.000Z',
    randomBytes: deterministicRandom,
  })

  assert.match(created.token, /^pdt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.equal(created.record.deviceId, 'mobile-test-1')
  assert.deepEqual(created.record.scopes, [...DEVICE_SCOPES.mobile])
  assert.equal(created.record.tokenHash.length, 64)
  assert.equal(JSON.stringify(created.record).includes(created.token), false)
  assert.equal(publicCredential(created.record).tokenHash, undefined)
  assert.equal(verifyDeviceToken(created.token, created.record), true)
})

test('rejects malformed, altered, expired, and revoked device tokens', () => {
  const created = createDeviceCredential({
    deviceId: 'nrf-001',
    deviceType: 'nrf_pendant',
    randomBytes: deterministicRandom,
  })
  const parsed = parseDeviceToken(created.token)
  assert.ok(parsed)

  assert.equal(verifyDeviceToken(`${created.token}x`, created.record), false)
  assert.equal(
    verifyDeviceToken(created.token, {
      ...created.record,
      expiresAt: '2026-08-02T19:59:00.000Z',
    }, new Date('2026-08-02T20:00:00.000Z').getTime()),
    false,
  )
  assert.equal(
    verifyDeviceToken(created.token, {
      ...created.record,
      revokedAt: '2026-08-02T19:59:00.000Z',
    }),
    false,
  )
})

test('authenticates admin fallback and device credentials', async () => {
  const store = createMemoryStore()
  const created = createDeviceCredential({
    deviceId: 'mac-home',
    deviceType: 'mac_bridge',
    now: '2026-08-02T20:00:00.000Z',
    randomBytes: deterministicRandom,
  })
  await store.saveDeviceCredential(created.record)

  const admin = await authenticateRelayRequest({
    authorization: 'Bearer admin-secret',
    adminApiKey: 'admin-secret',
    credentialStore: store,
  })
  assert.equal(admin.ok, true)
  assert.equal(admin.principal.kind, 'admin')

  const device = await authenticateRelayRequest({
    authorization: `Bearer ${created.token}`,
    adminApiKey: 'admin-secret',
    credentialStore: store,
    now: new Date('2026-08-02T20:01:00.000Z').getTime(),
  })
  assert.equal(device.ok, true)
  assert.equal(device.principal.deviceId, 'mac-home')
  assert.equal(
    principalHasScopes(device.principal, 'bridge:work:claim'),
    true,
  )
  assert.equal(principalHasScopes(device.principal, 'mac:execute'), false)
  assert.equal(principalOwnsDevice(device.principal, 'mac-home'), true)
  assert.equal(principalOwnsDevice(device.principal, 'mac-other'), false)

  const stored = await store.getDeviceCredential(created.record.tokenId)
  assert.equal(stored.lastUsedAt, '2026-08-02T20:01:00.000Z')

  await authenticateRelayRequest({
    authorization: `Bearer ${created.token}`,
    credentialStore: store,
    now: new Date('2026-08-02T20:01:30.000Z').getTime(),
  })
  const throttled = await store.getDeviceCredential(created.record.tokenId)
  assert.equal(throttled.lastUsedAt, '2026-08-02T20:01:00.000Z')
})

test('revoking a stored credential prevents further authentication', async () => {
  const store = createMemoryStore()
  const created = createDeviceCredential({
    deviceId: 'mobile-revoked',
    deviceType: 'mobile',
    randomBytes: deterministicRandom,
  })
  await store.saveDeviceCredential(created.record)
  await store.revokeDeviceCredential(
    created.record.tokenId,
    '2026-08-02T20:02:00.000Z',
  )

  const result = await authenticateRelayRequest({
    authorization: `Bearer ${created.token}`,
    credentialStore: store,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid_or_revoked_device_token')
})

test('pairing codes use exact constant-time comparison semantics', () => {
  assert.equal(verifyPairingCode('pair-me', 'pair-me'), true)
  assert.equal(verifyPairingCode('pair-me ', 'pair-me'), false)
  assert.equal(verifyPairingCode('', ''), false)
})
