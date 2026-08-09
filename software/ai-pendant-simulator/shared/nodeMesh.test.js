/*
 * The envelope's rules, pinned. Fixtures only: no network, no store, no key.
 *
 * The two that matter most are the two an attacker reaches for: whether an
 * address can be forged into the relay's own mailbox, and whether a payload
 * can be made big enough to break the store that holds it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createNodeEnvelope,
  DEFAULT_TTL_MS,
  envelopeBytes,
  envelopeIsLive,
  isReservedNodeAddress,
  MAX_ENVELOPE_BYTES,
  MAX_TTL_MS,
  normalizeNodeAddress,
  normalizeNodeKind,
  parseNodeEnvelope,
  RELAY_NODE_ADDRESS,
} from './nodeMesh.js'

const NOW = Date.parse('2026-08-08T12:00:00.000Z')

function envelope(overrides = {}) {
  return createNodeEnvelope({
    from: 'mac-bridge-1',
    to: 'browser-node-1',
    kind: 'browser.tab.open',
    payload: { url: 'https://example.com' },
    now: NOW,
    ...overrides,
  })
}

test('a device address and a reserved address are both routable', () => {
  assert.equal(normalizeNodeAddress('browser-node-1'), 'browser-node-1')
  assert.equal(normalizeNodeAddress('  mac-bridge-1  '), 'mac-bridge-1')
  assert.equal(normalizeNodeAddress(RELAY_NODE_ADDRESS), '@relay')
  assert.equal(isReservedNodeAddress('@relay'), true)
  assert.equal(isReservedNodeAddress('relay'), false)
})

test('no device can register the relay’s own address', () => {
  /*
   * This is why the relay is '@relay' and not 'relay'. deviceAuth's
   * normalizeDeviceId charset is [A-Za-z0-9_.:-] — '@' is not in it, so a
   * device literally cannot hold an address that starts with one. If the
   * relay were called 'relay', a device could have paired under that name and
   * silently received the relay brain's mail.
   */
  const deviceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/
  assert.equal(deviceIdPattern.test(RELAY_NODE_ADDRESS), false)
  assert.equal(deviceIdPattern.test('relay'), true)
})

test('junk addresses and junk kinds are refused', () => {
  for (const bad of ['', '  ', 'ab', '@', '@X', 'has space', 'has/slash', null]) {
    assert.equal(normalizeNodeAddress(bad), '', `must reject ${bad}`)
  }
  for (const bad of ['', 'Browser.Tab', 'browser..tab', 'a'.repeat(80), '../x']) {
    assert.equal(normalizeNodeKind(bad), '', `must reject ${bad}`)
  }
  assert.equal(normalizeNodeKind('browser.tab.open'), 'browser.tab.open')
})

test('an envelope carries who, what and a deadline', () => {
  const message = envelope()
  assert.equal(message.v, 1)
  assert.match(message.id, /^nmsg_[A-Za-z0-9_-]+$/)
  assert.equal(message.from, 'mac-bridge-1')
  assert.equal(message.to, 'browser-node-1')
  assert.equal(message.kind, 'browser.tab.open')
  assert.deepEqual(message.payload, { url: 'https://example.com' })
  assert.equal(message.corr, null)
  assert.equal(
    Date.parse(message.expiresAt) - Date.parse(message.createdAt),
    DEFAULT_TTL_MS,
  )
})

test('ttl is clamped rather than trusted', () => {
  const forever = envelope({ ttlMs: MAX_TTL_MS * 10 })
  assert.equal(
    Date.parse(forever.expiresAt) - Date.parse(forever.createdAt),
    MAX_TTL_MS,
  )
  /* Nonsense falls back to the default rather than producing an already-dead
   * message, which would be delivered to nobody and reported as sent. */
  for (const bad of [0, -1, 'soon', NaN, null]) {
    const message = envelope({ ttlMs: bad })
    assert.equal(
      Date.parse(message.expiresAt) - Date.parse(message.createdAt),
      DEFAULT_TTL_MS,
    )
  }
})

test('a node cannot address itself', () => {
  assert.throws(
    () => envelope({ from: 'node-a', to: 'node-a' }),
    /cannot address itself/,
  )
})

test('an oversized payload is refused, not truncated', () => {
  /* D1 rejects a value over ~1 MB with SQLITE_TOOBIG, and an inbox page holds
   * up to 50 of these. A message that got stored and then broke the read is
   * strictly worse than one that never sent. */
  const big = { blob: 'x'.repeat(MAX_ENVELOPE_BYTES) }
  assert.throws(() => envelope({ payload: big }), /Envelope is \d+ B/)

  /* And the ceiling is measured on the serialized envelope, not the payload,
   * so headers cannot push a just-legal payload over the line unnoticed. */
  const nearLimit = envelope({ payload: { blob: 'x'.repeat(60_000) } })
  assert.ok(envelopeBytes(nearLimit) <= MAX_ENVELOPE_BYTES)
})

test('a non-object payload is refused', () => {
  for (const bad of ['text', 42, [1, 2], null]) {
    assert.throws(() => envelope({ payload: bad }), /must be a JSON object/)
  }
})

test('expiry is a fact about the envelope, not about the store', () => {
  const message = envelope({ ttlMs: 60_000 })
  assert.equal(envelopeIsLive(message, NOW), true)
  assert.equal(envelopeIsLive(message, NOW + 59_000), true)
  assert.equal(envelopeIsLive(message, NOW + 61_000), false)
  assert.equal(envelopeIsLive({}, NOW), false)
})

test('parse refuses anything a receiver would have to guess about', () => {
  const good = envelope()
  assert.deepEqual(parseNodeEnvelope(JSON.stringify(good)), good)
  assert.deepEqual(parseNodeEnvelope(good), good)

  assert.equal(parseNodeEnvelope('not json'), null)
  assert.equal(parseNodeEnvelope({ ...good, v: 2 }), null)
  assert.equal(parseNodeEnvelope({ ...good, id: 'nope' }), null)
  assert.equal(parseNodeEnvelope({ ...good, from: 'has space' }), null)
  assert.equal(parseNodeEnvelope({ ...good, kind: 'NOPE' }), null)
  assert.equal(parseNodeEnvelope({ ...good, payload: 'text' }), null)
})

test('a correlation id survives the round trip and is bounded', () => {
  const reply = envelope({ correlationId: 'nmsg_abcdefgh' })
  assert.equal(reply.corr, 'nmsg_abcdefgh')
  const absurd = envelope({ correlationId: 'z'.repeat(500) })
  assert.equal(absurd.corr.length, 128)
})
