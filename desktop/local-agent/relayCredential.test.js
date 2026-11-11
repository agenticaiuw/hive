/*
 * Which credential the bridge presents, and whether the fallback is visible.
 *
 * Fixtures only: 'pdt_…' strings here are shaped like device tokens and are
 * not real; 'admin-key-fixture' is not the admin key.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_DEVICE_TOKEN_FILE,
  looksLikeDeviceToken,
  migrationNotice,
  resolveRelayCredential,
} from './relayCredential.js'

const FIXTURE_TOKEN = `pdt_${'a'.repeat(16)}.${'b'.repeat(43)}`
const ADMIN_KEY = 'admin-key-fixture'
const noFiles = () => {
  throw new Error('ENOENT')
}

test('a device token in the environment wins', () => {
  const resolved = resolveRelayCredential({
    deviceToken: FIXTURE_TOKEN,
    adminKey: ADMIN_KEY,
    readFile: noFiles,
  })
  assert.equal(resolved.kind, 'device')
  assert.equal(resolved.token, FIXTURE_TOKEN)
  assert.equal(resolved.source, 'RELAY_DEVICE_TOKEN')
  assert.equal(resolved.malformed, false)
  assert.equal(migrationNotice(resolved), null)
})

test('a token file is used when the environment is empty', () => {
  const resolved = resolveRelayCredential({
    deviceTokenFile: '/fixture/mac-bridge-token',
    adminKey: ADMIN_KEY,
    readFile: (filePath) => {
      assert.equal(filePath, '/fixture/mac-bridge-token')
      return `# home-macbook-bridge\n${FIXTURE_TOKEN}\n`
    },
  })
  assert.equal(resolved.kind, 'device')
  assert.equal(resolved.token, FIXTURE_TOKEN)
  assert.match(resolved.source, /RELAY_DEVICE_TOKEN_FILE/)
})

test('the default token file is consulted before falling back', () => {
  const resolved = resolveRelayCredential({
    adminKey: ADMIN_KEY,
    readFile: (filePath) => {
      if (filePath === DEFAULT_DEVICE_TOKEN_FILE) return FIXTURE_TOKEN
      throw new Error('ENOENT')
    },
  })
  assert.equal(resolved.kind, 'device')
  assert.equal(resolved.token, FIXTURE_TOKEN)
})

test('with no device token it falls back to the admin key, loudly, once', () => {
  const resolved = resolveRelayCredential({
    adminKey: ADMIN_KEY,
    readFile: noFiles,
  })
  assert.equal(resolved.kind, 'admin')
  assert.equal(resolved.token, ADMIN_KEY)
  assert.equal(resolved.source, 'RELAY_API_KEY')

  /* The fallback must announce itself, name the fix, and never carry the
   * secret it is describing. */
  const notice = migrationNotice(resolved)
  assert.ok(notice)
  assert.match(notice, /admin/i)
  assert.match(notice, /pendant-credentials\.mjs pair/)
  assert.equal(notice.includes(ADMIN_KEY), false)
})

test('a malformed device token is reported, not silently sent as admin', () => {
  const resolved = resolveRelayCredential({
    deviceToken: 'not-a-device-token',
    adminKey: ADMIN_KEY,
    readFile: noFiles,
  })
  assert.equal(resolved.kind, 'device')
  assert.equal(resolved.malformed, true)
  const notice = migrationNotice(resolved)
  assert.ok(notice)
  assert.match(notice, /not a pdt_/)
  assert.equal(notice.includes('not-a-device-token'), false)
})

test('no credential at all is distinguishable from a fallback', () => {
  const resolved = resolveRelayCredential({ adminKey: '', readFile: noFiles })
  assert.equal(resolved.kind, 'none')
  assert.equal(resolved.token, '')
  assert.equal(migrationNotice(resolved), null)
})

test('token shape recognition', () => {
  assert.equal(looksLikeDeviceToken(FIXTURE_TOKEN), true)
  assert.equal(looksLikeDeviceToken(`  ${FIXTURE_TOKEN}  `), true)
  assert.equal(looksLikeDeviceToken('pdt_short.short'), false)
  assert.equal(looksLikeDeviceToken(ADMIN_KEY), false)
  assert.equal(looksLikeDeviceToken(''), false)
})
