/*
 * The relay peer, tested as a pure module.
 *
 * These assert the two things the review of this change should care about:
 * the origin boundary is an allowlist rather than "https is enough", and the
 * peer policy is a table rather than an emergent property of two loops.
 *
 * Nothing here touches the filesystem, the network or a workspace — the module
 * under test has no impure edge to reach one with.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeAgentUrl } from '../src/bridge-core.js'
import {
  DEFAULT_TRUSTED_SENDERS,
  MAX_MESH_COMMAND_AGE_MS,
  MAX_RESULT_PAYLOAD_BYTES,
  MESH_RESULT_KIND,
  RELAY_NODE_ADDRESS,
  RELAY_ORIGIN_ALLOWLIST,
  RELAY_POLL_ACTIVE_MS,
  RELAY_POLL_IDLE_MS,
  RELAY_STORAGE_KEYS,
  acceptEnvelopes,
  ackRequest,
  choosePeer,
  createEnvelopeLedger,
  envelopeToCommand,
  fitResultPayload,
  inboxRequest,
  normalizeRelayConfig,
  normalizeRelayUrl,
  pruneEnvelopeLedger,
  relayOriginPattern,
  resultMessageFor,
  sendRequest,
} from '../src/relay-peer.js'

const NOW = Date.parse('2026-08-09T04:00:00.000Z')

const config = normalizeRelayConfig({
  relayEnabled: true,
  relayUrl: RELAY_ORIGIN_ALLOWLIST[0],
  relayDeviceId: 'evan-safari-bridge',
  deviceToken: 'pdt_not_a_real_token',
})

function envelope(overrides = {}) {
  return {
    v: 1,
    id: 'nmsg_AAAAAAAAAAAAAAAAAAAAAA',
    from: RELAY_NODE_ADDRESS,
    to: 'evan-safari-bridge',
    kind: 'browser.command',
    payload: { type: 'list_tabs', params: {} },
    corr: null,
    createdAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 600_000).toISOString(),
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * The origin boundary.
 * ------------------------------------------------------------------ */

test('the relay URL is an allowlist, not "any https"', () => {
  for (const origin of RELAY_ORIGIN_ALLOWLIST) {
    assert.equal(normalizeRelayUrl(origin), origin, `${origin} must be accepted`)
  }

  /* The exact shape of the attack the loopback rule exists to stop: an https
   * URL that is simply not ours. */
  assert.equal(normalizeRelayUrl('https://evil.example.com'), '')
  assert.equal(normalizeRelayUrl('https://ai-pendant-relay.your-subdomain.workers.dev.evil.com'), '')
  assert.equal(normalizeRelayUrl('http://ai-pendant-relay.your-subdomain.workers.dev'), '')
  assert.equal(normalizeRelayUrl(''), '')
  assert.equal(normalizeRelayUrl('not a url'), '')
  assert.equal(normalizeRelayUrl('file:///etc/passwd'), '')
})

test('a relay URL may not smuggle credentials, a path, a query or a hash', () => {
  const relay = RELAY_ORIGIN_ALLOWLIST[0]
  assert.equal(normalizeRelayUrl(`${relay}/v1/node/inbox`), '')
  assert.equal(normalizeRelayUrl(`${relay}/?token=abc`), '')
  assert.equal(normalizeRelayUrl(`${relay}/#frag`), '')
  assert.equal(normalizeRelayUrl(relay.replace('https://', 'https://user:pass@')), '')
  /* A bare origin and an origin with a trailing slash are the same origin. */
  assert.equal(normalizeRelayUrl(`${relay}/`), relay)
})

test('the Mac field still refuses the relay, so one token cannot reach two hosts', () => {
  /* The reason normalizeAgentUrl was NOT widened: its output is the base URL
   * the Mac's agentToken is sent to. */
  assert.throws(() => normalizeAgentUrl(RELAY_ORIGIN_ALLOWLIST[0]), /127\.0\.0\.1/)
  assert.equal(normalizeAgentUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000')
})

test('the host_permissions pattern is derived from the allowlist, never from input', () => {
  assert.equal(
    relayOriginPattern(RELAY_ORIGIN_ALLOWLIST[0]),
    `${RELAY_ORIGIN_ALLOWLIST[0]}/*`,
  )
  assert.equal(relayOriginPattern('https://evil.example.com'), '')
})

/* ------------------------------------------------------------------ *
 * Configuration: half-configured must behave exactly like absent.
 * ------------------------------------------------------------------ */

test('the relay peer stays off until origin, address and credential all exist', () => {
  assert.equal(normalizeRelayConfig().ready, false)
  assert.match(normalizeRelayConfig().reason, /switched off/)

  const enabled = { relayEnabled: true }
  assert.match(normalizeRelayConfig(enabled).reason, /relayUrl/)
  assert.match(
    normalizeRelayConfig({ ...enabled, relayUrl: RELAY_ORIGIN_ALLOWLIST[0] }).reason,
    /relayDeviceId/,
  )
  assert.match(
    normalizeRelayConfig({
      ...enabled,
      relayUrl: RELAY_ORIGIN_ALLOWLIST[0],
      relayDeviceId: 'evan-safari-bridge',
    }).reason,
    /deviceToken/,
  )
  assert.equal(config.ready, true)
  assert.equal(config.reason, '')
})

test('deviceToken is the storage key the inert brain scaffold already declared', () => {
  assert.ok(RELAY_STORAGE_KEYS.includes('deviceToken'))
})

/* ------------------------------------------------------------------ *
 * Requests: no credential in a URL, no client-supplied `from`.
 * ------------------------------------------------------------------ */

test('no request this module can build puts a credential in a URL', () => {
  const requests = [
    inboxRequest(config),
    ackRequest(config, ['nmsg_a']),
    sendRequest(config, { to: '@relay', kind: 'browser.hello', payload: {} }),
  ]
  for (const request of requests) {
    assert.equal(request.auth, 'device')
    assert.ok(!request.path.includes(config.deviceToken))
    assert.ok(!request.path.includes('token'))
  }
  assert.equal(
    inboxRequest(config).path,
    '/v1/node/inbox?deviceId=evan-safari-bridge',
  )
})

test('a send never claims a `from` — the relay stamps it from the credential', () => {
  const request = sendRequest(config, {
    to: '@relay',
    kind: 'browser.hello',
    payload: { probe: true },
  })
  assert.ok(!('from' in request.body))
  assert.deepEqual(Object.keys(request.body).sort(), ['kind', 'payload', 'to'])
})

/* ------------------------------------------------------------------ *
 * At-least-once.
 * ------------------------------------------------------------------ */

test('a redelivered envelope is acked again but never run twice', () => {
  const first = acceptEnvelopes([envelope()], { config, now: NOW })
  assert.equal(first.run.length, 1)
  assert.deepEqual(first.ackIds, ['nmsg_AAAAAAAAAAAAAAAAAAAAAA'])

  const second = acceptEnvelopes([envelope()], {
    ledger: first.ledger,
    config,
    now: NOW + 1_000,
  })
  assert.equal(second.run.length, 0)
  assert.match(second.ignored[0].reason, /already handled/)
  /* Still acked: an unacked refusal comes back every 60s forever. */
  assert.deepEqual(second.ackIds, ['nmsg_AAAAAAAAAAAAAAAAAAAAAA'])
})

test('the dedupe ledger survives a round trip through storage', () => {
  const { ledger } = acceptEnvelopes([envelope()], { config, now: NOW })
  const persisted = JSON.parse(JSON.stringify(pruneEnvelopeLedger(ledger, NOW)))
  const rehydrated = createEnvelopeLedger(persisted)

  const again = acceptEnvelopes([envelope()], {
    ledger: rehydrated,
    config,
    now: NOW + 5_000,
  })
  assert.equal(again.run.length, 0, 'a worker restart must not re-run a command')
})

test('the ledger forgets ids that could no longer be delivered', () => {
  const ledger = { 'nmsg_dead': NOW - 1, 'nmsg_live': NOW + 60_000 }
  assert.deepEqual(Object.keys(pruneEnvelopeLedger(ledger, NOW)), ['nmsg_live'])
})

test('the ledger is bounded, keeping the entries furthest from expiry', () => {
  const ledger = {}
  for (let index = 0; index < 50; index += 1) {
    ledger[`nmsg_${index}`] = NOW + 1_000 + index
  }
  const pruned = pruneEnvelopeLedger(ledger, NOW, 10)
  assert.equal(Object.keys(pruned).length, 10)
  assert.ok('nmsg_49' in pruned)
  assert.ok(!('nmsg_0' in pruned))
})

/* ------------------------------------------------------------------ *
 * Who may drive this browser.
 * ------------------------------------------------------------------ */

test('only @relay is trusted by default; another node is received, not obeyed', () => {
  assert.deepEqual(DEFAULT_TRUSTED_SENDERS, ['@relay'])

  const accepted = acceptEnvelopes(
    [envelope({ from: 'someone-elses-browser', id: 'nmsg_BBBBBBBBBBBBBBBBBBBBBB' })],
    { config, now: NOW },
  )
  assert.equal(accepted.run.length, 0)
  assert.match(accepted.ignored[0].reason, /not a trusted sender/)
  assert.equal(accepted.ackIds.length, 1)
})

test('a named sender may drive tabs', () => {
  const trusting = normalizeRelayConfig({
    relayEnabled: true,
    relayUrl: RELAY_ORIGIN_ALLOWLIST[0],
    relayDeviceId: 'evan-safari-bridge',
    deviceToken: 'pdt_not_a_real_token',
    meshTrustedSenders: 'home-macbook-bridge',
  })
  assert.deepEqual(trusting.trustedSenders, ['@relay', 'home-macbook-bridge'])

  const accepted = acceptEnvelopes([envelope({ from: 'home-macbook-bridge' })], {
    config: trusting,
    now: NOW,
  })
  assert.equal(accepted.run.length, 1)
})

test('mail addressed to another node is never run, however it arrived', () => {
  const accepted = acceptEnvelopes([envelope({ to: 'evans-iphone' })], {
    config,
    now: NOW,
  })
  assert.equal(accepted.run.length, 0)
  assert.match(accepted.ignored[0].reason, /not to this node/)
})

test('an unknown kind is received and acked, not run', () => {
  const accepted = acceptEnvelopes([envelope({ kind: 'pendant.audio.ready' })], {
    config,
    now: NOW,
  })
  assert.equal(accepted.run.length, 0)
  assert.match(accepted.ignored[0].reason, /no handler/)
  assert.equal(accepted.ackIds.length, 1)
})

test('junk on the wire is neither run nor acked — there is no id to ack', () => {
  const accepted = acceptEnvelopes([{ v: 99, id: 'nope' }, null, 'garbage'], {
    config,
    now: NOW,
  })
  assert.equal(accepted.run.length, 0)
  assert.equal(accepted.ackIds.length, 0)
  assert.equal(accepted.ignored.length, 3)
})

/* ------------------------------------------------------------------ *
 * Freshness: the mesh's clock, with a receiver-side ceiling.
 * ------------------------------------------------------------------ */

test('mail queued while the browser slept still runs — that is the point', () => {
  /* Five minutes old: past bridge-core's 90s rule for Mac-queued commands, and
   * deliberately NOT refused here, because queue-while-you-sleep is the whole
   * property the mesh exists to provide. */
  const accepted = acceptEnvelopes(
    [envelope({ createdAt: new Date(NOW - 5 * 60_000).toISOString() })],
    { config, now: NOW },
  )
  assert.equal(accepted.run.length, 1)
})

test('but the receiver keeps its own ceiling against a 24h TTL', () => {
  const accepted = acceptEnvelopes(
    [
      envelope({
        createdAt: new Date(NOW - MAX_MESH_COMMAND_AGE_MS - 1_000).toISOString(),
        expiresAt: new Date(NOW + 23 * 3_600_000).toISOString(),
      }),
    ],
    { config, now: NOW },
  )
  assert.equal(accepted.run.length, 0)
  assert.match(accepted.ignored[0].reason, /refuses mesh mail older than/)
})

test('an envelope past its own expiry is dropped', () => {
  const accepted = acceptEnvelopes(
    [envelope({ expiresAt: new Date(NOW - 1).toISOString() })],
    { config, now: NOW },
  )
  assert.equal(accepted.run.length, 0)
  assert.match(accepted.ignored[0].reason, /expired/)
})

test('delivery, not creation, is what the executor sees as createdAt', () => {
  /* bridge-core.validateCommand refuses anything older than 90s. If the
   * envelope's own createdAt were copied through, every message the durable
   * queue held would be refused a second time by a rule that already ran. */
  const command = envelopeToCommand(
    envelope({ createdAt: new Date(NOW - 5 * 60_000).toISOString() }),
    NOW,
  )
  assert.equal(command.createdAt, new Date(NOW).toISOString())
  assert.equal(command.source, 'node-mesh')
  assert.equal(command.commandId, 'nmsg_AAAAAAAAAAAAAAAAAAAAAA')
  assert.equal(command.action.type, 'list_tabs')
})

test('a mesh payload naming a command this extension cannot run is refused', () => {
  assert.throws(
    () => envelopeToCommand(envelope({ payload: { type: 'exec_shell' } }), NOW),
    /not a browser command/,
  )
  assert.throws(() => envelopeToCommand(envelope({ payload: {} }), NOW), /\(none\)/)
})

/* ------------------------------------------------------------------ *
 * Answering: the 64 KiB ceiling is real and the truncation is admitted.
 * ------------------------------------------------------------------ */

test('a result that fits is passed through untouched', () => {
  const payload = { ok: true, result: { message: 'Clicked #go' } }
  const fitted = fitResultPayload(payload)
  assert.equal(fitted.truncated, false)
  assert.deepEqual(fitted.payload, payload)
})

test('an oversized read is trimmed and SAYS it was trimmed', () => {
  const fitted = fitResultPayload({
    ok: true,
    result: { mode: 'text', content: 'x'.repeat(200_000) },
  })
  assert.equal(fitted.truncated, true)
  assert.equal(fitted.payload.truncated, true)
  assert.match(fitted.payload.result.content, /truncated to fit/)
  assert.ok(
    Buffer.byteLength(JSON.stringify(fitted.payload)) <= MAX_RESULT_PAYLOAD_BYTES,
  )
})

test('a blob with no text to trim becomes an explicit refusal, not a silent drop', () => {
  const fitted = fitResultPayload({
    ok: true,
    result: { mimeType: 'image/png', imageDataUrl: `data:image/png;base64,${'A'.repeat(200_000)}` },
  })
  assert.equal(fitted.truncated, true)
  assert.match(fitted.payload.error, /cannot cross the mesh/)
  assert.ok(
    Buffer.byteLength(JSON.stringify(fitted.payload)) <= MAX_RESULT_PAYLOAD_BYTES,
  )
})

test('a result is addressed back at the sender and correlated to the request', () => {
  const request = resultMessageFor(
    envelope(),
    { ok: true, result: { message: '3 open web tab(s)' } },
    config,
  )
  assert.equal(request.method, 'POST')
  assert.equal(request.path, '/v1/node/messages')
  assert.equal(request.body.to, RELAY_NODE_ADDRESS)
  assert.equal(request.body.kind, MESH_RESULT_KIND)
  assert.equal(request.body.correlationId, 'nmsg_AAAAAAAAAAAAAAAAAAAAAA')
})

/* ------------------------------------------------------------------ *
 * The policy, as a table.
 * ------------------------------------------------------------------ */

test('both peers are LISTENED to whenever both are usable', () => {
  const choice = choosePeer({
    macConfigured: true,
    macLastOkAt: NOW,
    relayReady: true,
    now: NOW,
  })
  /* The point of the change: an extension that only drained its inbox while
   * the Mac was down would leave relay mail unread for as long as the Mac
   * stayed up, and mesh mail is silent — nothing announces it. */
  assert.deepEqual(choice.inbound, ['mac', 'relay'])
})

test('the Mac is preferred for outbound while it is fresh', () => {
  const choice = choosePeer({
    macConfigured: true,
    macLastOkAt: NOW,
    relayReady: true,
    now: NOW,
  })
  assert.equal(choice.outbound, 'mac')
  assert.equal(choice.macFresh, true)
  assert.equal(choice.relayPollMs, RELAY_POLL_IDLE_MS)
})

test('a silent Mac hands the node to the relay, and speeds the drain up', () => {
  const choice = choosePeer({
    macConfigured: true,
    macLastOkAt: NOW - 120_000,
    relayReady: true,
    now: NOW,
  })
  assert.equal(choice.outbound, 'relay')
  assert.equal(choice.macFresh, false)
  assert.equal(choice.relayPollMs, RELAY_POLL_ACTIVE_MS)
  assert.match(choice.reason, /has not answered/)
})

test('with no relay configured the Mac keeps the node, exactly as today', () => {
  const choice = choosePeer({
    macConfigured: true,
    macLastOkAt: NOW - 120_000,
    relayReady: false,
    now: NOW,
  })
  assert.deepEqual(choice.inbound, ['mac'])
  assert.equal(choice.outbound, 'mac')
})

test('with no Mac at all the relay is the whole node', () => {
  const choice = choosePeer({ macConfigured: false, relayReady: true, now: NOW })
  assert.deepEqual(choice.inbound, ['relay'])
  assert.equal(choice.outbound, 'relay')
  assert.equal(choice.relayPollMs, RELAY_POLL_ACTIVE_MS)
})

test('a worker that has just started treats the Mac as unproven', () => {
  /* macLastOkAt is 0 on every incarnation, so the relay carries the node until
   * a heartbeat actually succeeds rather than because a config said so. */
  const choice = choosePeer({ macConfigured: true, macLastOkAt: 0, relayReady: true, now: NOW })
  assert.equal(choice.macFresh, false)
  assert.equal(choice.outbound, 'relay')
})

test('neither peer configured is reported as unreachable, not as healthy', () => {
  const choice = choosePeer({ now: NOW })
  assert.deepEqual(choice.inbound, [])
  assert.equal(choice.outbound, null)
  assert.match(choice.reason, /unreachable/)
})
