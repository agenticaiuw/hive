import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isLoopbackAddress,
  normalizeDeviceId,
  pairLifetimeTtl,
  pairResponseBody,
  pairingCodeMatches,
  relayPairRequest,
} from './pairBrowser.js'

test('only real loopback addresses pass — the server binds 0.0.0.0', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.0.0.53'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  /* IPv4-mapped IPv6 is how a dual-stack Node listener usually reports it. */
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)

  assert.equal(isLoopbackAddress('192.168.1.20'), false)
  assert.equal(isLoopbackAddress('::ffff:192.168.1.20'), false)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
  /* Absence is not loopback. */
  assert.equal(isLoopbackAddress(''), false)
  assert.equal(isLoopbackAddress(undefined), false)
  /* And a public address that merely CONTAINS 127 is not either. */
  assert.equal(isLoopbackAddress('212.7.0.1'), false)
})

test('an unset pairing code means pairing is OFF, not open', () => {
  assert.equal(pairingCodeMatches('anything', ''), false)
  assert.equal(pairingCodeMatches('', ''), false)
  assert.equal(pairingCodeMatches(undefined, undefined), false)

  assert.equal(pairingCodeMatches('sesame', 'sesame'), true)
  assert.equal(pairingCodeMatches('sesame ', 'sesame'), false)
  assert.equal(pairingCodeMatches('SESAME', 'sesame'), false)
})

test('device ids are bounded, not repaired', () => {
  assert.equal(normalizeDeviceId('safari-evan-mac'), 'safari-evan-mac')
  assert.equal(normalizeDeviceId('  Safari-Evan-Mac  '), 'safari-evan-mac')
  assert.equal(normalizeDeviceId('a.b_c-9'), 'a.b_c-9')

  /* Garbage is refused rather than guessed at — the id lands in the relay's
   * device table and every record this node writes. */
  assert.equal(normalizeDeviceId('has spaces'), '')
  assert.equal(normalizeDeviceId('ab'), '')
  assert.equal(normalizeDeviceId('-leading-dash'), '')
  assert.equal(normalizeDeviceId('x'.repeat(65)), '')
  assert.equal(normalizeDeviceId(''), '')
})

test('the relay call is the credential script’s request, role pinned to browser_node', () => {
  const request = relayPairRequest({
    relayUrl: 'https://relay.example/',
    pairingCode: 'sesame',
    deviceId: 'safari-evan-mac',
    deviceName: 'Safari on the MacBook Air',
  })
  assert.equal(request.url, 'https://relay.example/v1/devices/pair')
  const body = JSON.parse(request.init.body)
  assert.deepEqual(body, {
    deviceId: 'safari-evan-mac',
    deviceType: 'browser_node',
    name: 'Safari on the MacBook Air',
    pairingCode: 'sesame',
  })
  /* A route that pairs browsers must not be talked into pairing a Mac:
   * the role is pinned, not read from the caller. */
  assert.equal(body.deviceType, 'browser_node')

  assert.equal(relayPairRequest({ relayUrl: '', pairingCode: 'x', deviceId: 'y' }), null)
})

/*
 * The owner's lifetime menu (2026-08-12): session / 7d / 30d / forever, and
 * ONLY those — a typo must be a 400, never a silent forever. session and
 * forever both map to no relay TTL: forever by definition, session because
 * "until this browser closes" is enforced by the browser itself.
 */
test('lifetimes: four canonical values in, refusals for everything else', () => {
  assert.deepEqual(pairLifetimeTtl('7d'), { ok: true, lifetime: '7d', ttlMs: 7 * 24 * 60 * 60 * 1_000 })
  assert.deepEqual(pairLifetimeTtl('30d'), { ok: true, lifetime: '30d', ttlMs: 30 * 24 * 60 * 60 * 1_000 })
  assert.deepEqual(pairLifetimeTtl('session'), { ok: true, lifetime: 'session', ttlMs: null })
  assert.deepEqual(pairLifetimeTtl('forever'), { ok: true, lifetime: 'forever', ttlMs: null })

  /* Absent means forever — pre-lifetime extensions send no field at all. */
  assert.deepEqual(pairLifetimeTtl(undefined), { ok: true, lifetime: 'forever', ttlMs: null })
  assert.deepEqual(pairLifetimeTtl(''), { ok: true, lifetime: 'forever', ttlMs: null })

  assert.equal(pairLifetimeTtl('90d').ok, false)
  assert.equal(pairLifetimeTtl('FOREVER').ok, false)
  assert.match(pairLifetimeTtl('week').error, /session, 7d, 30d, forever/)
})

test('a timed lifetime rides to the relay as ttlMs; an open one is omitted', () => {
  const timed = relayPairRequest({
    relayUrl: 'https://relay.example',
    pairingCode: 'sesame',
    deviceId: 'safari-evan-mac',
    ttlMs: 7 * 24 * 60 * 60 * 1_000,
  })
  assert.equal(JSON.parse(timed.init.body).ttlMs, 7 * 24 * 60 * 60 * 1_000)

  for (const ttlMs of [null, undefined, 0, -5, NaN]) {
    const open = relayPairRequest({
      relayUrl: 'https://relay.example',
      pairingCode: 'sesame',
      deviceId: 'safari-evan-mac',
      ttlMs,
    })
    assert.equal('ttlMs' in JSON.parse(open.init.body), false)
  }
})

test('a relay failure still delivers the working half, named', () => {
  const whole = pairResponseBody({
    agentToken: 'agent-secret',
    relayUrl: 'https://relay.example',
    deviceId: 'safari-evan-mac',
    relayPayload: {
      ok: true,
      credential: { token: 'pdt_x.y', tokenId: 't1', scopes: ['llm:infer'] },
    },
  })
  assert.equal(whole.agentToken, 'agent-secret')
  assert.equal(whole.relay.deviceToken, 'pdt_x.y')
  assert.equal(whole.relay.deviceId, 'safari-evan-mac')
  assert.equal('relayError' in whole, false)

  /* Captive wifi, worker down: the browser leaves setup with the Mac bridge
   * working and an honest note — not with nothing. */
  const half = pairResponseBody({
    agentToken: 'agent-secret',
    relayUrl: 'https://relay.example',
    deviceId: 'safari-evan-mac',
    relayPayload: null,
    relayError: 'The relay could not be reached: fetch failed',
  })
  assert.equal(half.agentToken, 'agent-secret')
  assert.equal(half.relay, null)
  assert.match(half.relayError, /could not be reached/)
})
