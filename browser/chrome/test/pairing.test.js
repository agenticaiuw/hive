import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_PAIR_LIFETIME,
  PAIR_LIFETIMES,
  PAIR_WIPE_KEYS,
  credentialExpiryCheck,
  defaultPairDeviceId,
  lifetimeTtlMs,
  normalizePairLifetime,
  pairOutcomeRecord,
  escrowRestorePlan,
  pairRequest,
  pairStoragePatch,
  shouldEscrow,
} from '../src/pairing.js'
import { RELAY_STORAGE_KEYS } from '../src/relay-peer.js'

test('the pair request goes to the agent, code, identity and lifetime in the body', () => {
  const request = pairRequest('http://127.0.0.1:8000/', {
    code: 'sesame',
    deviceId: 'browser-a1b2c3',
    deviceName: 'Safari on MacIntel',
    lifetime: '7d',
  })
  assert.equal(request.url, 'http://127.0.0.1:8000/pair/browser')
  assert.deepEqual(JSON.parse(request.init.body), {
    code: 'sesame',
    deviceId: 'browser-a1b2c3',
    deviceName: 'Safari on MacIntel',
    lifetime: '7d',
  })
  assert.equal(pairRequest('', { code: 'x' }), null)

  /* No lifetime supplied means the owner's default, forever — spelled out on
   * the wire so the agent never has to guess. */
  const bare = pairRequest('http://127.0.0.1:8000', { code: 'sesame', deviceId: 'browser-1' })
  assert.equal(JSON.parse(bare.init.body).lifetime, 'forever')
})

/*
 * The lifetime menu, exactly as the owner ordered it (2026-08-12): "7 days/
 * 30 days/forever until revoked ... or forget right after this browser is
 * closed" — four canonical values, forever the default, garbage normalized
 * to the default rather than invented.
 */
test('lifetimes: four canonical values, forever by default, honest TTLs', () => {
  assert.deepEqual([...PAIR_LIFETIMES], ['session', '7d', '30d', 'forever'])
  assert.equal(DEFAULT_PAIR_LIFETIME, 'forever')

  for (const value of PAIR_LIFETIMES) assert.equal(normalizePairLifetime(value), value)
  assert.equal(normalizePairLifetime(''), 'forever')
  assert.equal(normalizePairLifetime(undefined), 'forever')
  assert.equal(normalizePairLifetime('90d'), 'forever')

  assert.equal(lifetimeTtlMs('7d'), 7 * 24 * 60 * 60 * 1_000)
  assert.equal(lifetimeTtlMs('30d'), 30 * 24 * 60 * 60 * 1_000)
  /* session is enforced by the storage.session sentinel, forever by nothing:
   * neither carries a TTL. */
  assert.equal(lifetimeTtlMs('session'), null)
  assert.equal(lifetimeTtlMs('forever'), null)
})

test('a stored identity wins; a fresh browser gets a generated one', () => {
  /* Re-pairing must rotate the SAME device, not litter the relay's table. */
  assert.equal(defaultPairDeviceId('safari-evan-mac', 'ffffff'), 'safari-evan-mac')
  assert.equal(defaultPairDeviceId('', 'a1b2c3'), 'browser-a1b2c3')
  assert.equal(defaultPairDeviceId(null, 'A1B2C3D4'), 'browser-a1b2c3')
  /* Degenerate randomness still yields a legal id, not an empty one. */
  assert.equal(defaultPairDeviceId('', ''), 'browser-000000')
})

test('a full pairing stores both credentials under the live storage keys', () => {
  const outcome = pairStoragePatch(
    {
      ok: true,
      agentToken: 'agent-secret',
      relay: {
        url: 'https://relay.example',
        deviceId: 'browser-a1b2c3',
        deviceToken: 'pdt_x.y',
        scopes: ['llm:infer'],
      },
    },
    { agentUrl: 'http://127.0.0.1:8000' },
  )

  assert.equal(outcome.ok, true)
  assert.equal(outcome.values.agentToken, 'agent-secret')
  assert.equal(outcome.values.relayEnabled, true)
  assert.equal(outcome.values.deviceToken, 'pdt_x.y')
  assert.equal(outcome.values.relayDeviceId, 'browser-a1b2c3')
  assert.match(outcome.note, /brain is on/)

  /*
   * The keys are the contract with background.js's onChanged handlers: every
   * relay key this patch writes must be one the worker watches, or the socket
   * never restarts and "paired" sits dead until the next browser launch.
   */
  for (const key of ['relayEnabled', 'relayUrl', 'relayDeviceId', 'deviceToken']) {
    assert.ok(RELAY_STORAGE_KEYS.includes(key), `${key} is watched by the worker`)
    assert.ok(key in outcome.values, `${key} is written`)
  }
})

test('a failed relay leg keeps the Mac half and never half-enables the relay', () => {
  const outcome = pairStoragePatch(
    {
      ok: true,
      agentToken: 'agent-secret',
      relay: null,
      relayError: 'The relay could not be reached: fetch failed',
    },
    { agentUrl: 'http://127.0.0.1:8000' },
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.values.agentToken, 'agent-secret')
  /* relayEnabled untouched: aiming the drain loop at a relay this browser
   * cannot authenticate to turns "unfinished setup" into a fake outage. */
  assert.equal('relayEnabled' in outcome.values, false)
  assert.equal('deviceToken' in outcome.values, false)
  assert.match(outcome.note, /Relay half failed/)

  const refused = pairStoragePatch({ ok: false, error: 'Wrong or missing pairing code' })
  assert.equal(refused.ok, false)
  assert.match(refused.error, /pairing code/)
})

test('the patch records the lifetime beside the credentials it governs', () => {
  const now = Date.UTC(2026, 7, 12)
  const timed = pairStoragePatch(
    { ok: true, agentToken: 'agent-secret' },
    { agentUrl: 'http://127.0.0.1:8000', lifetime: '30d', now },
  )
  assert.equal(timed.values.pairLifetime, '30d')
  assert.equal(timed.values.pairExpiresAt, new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString())

  /* session and forever store no wall-clock expiry: session dies with the
   * storage.session sentinel, forever dies only by revocation. */
  for (const lifetime of ['session', 'forever', undefined]) {
    const open = pairStoragePatch({ ok: true, agentToken: 't' }, { lifetime, now })
    assert.equal(open.values.pairLifetime, lifetime ?? 'forever')
    assert.equal(open.values.pairExpiresAt, null)
  }
})

/*
 * The outcome record is the popup's ONLY trustworthy pairing channel — the
 * sendMessage reply is the thing Safari drops. Shape matters: `at` lets the
 * popup ignore stale records from earlier sessions.
 */
test('outcome records carry ok/note or ok/error plus a timestamp', () => {
  const won = pairOutcomeRecord({ ok: true, note: 'Paired.' }, 123)
  assert.deepEqual(won, { ok: true, note: 'Paired.', at: 123 })
  const lost = pairOutcomeRecord({ ok: false, error: 'nope' }, 456)
  assert.deepEqual(lost, { ok: false, error: 'nope', at: 456 })
  assert.equal(pairOutcomeRecord(undefined, 1).ok, false)
})

/*
 * The expiry policy, whole. The wipe list is asserted here because the worker
 * removes exactly PAIR_WIPE_KEYS: credentials and lifetime bookkeeping go,
 * identity (relayUrl, relayDeviceId) stays so re-pairing rotates the same
 * device.
 */
test('expiry: timed pairings die at their hour, session pairings die with the browser', () => {
  const now = Date.UTC(2026, 7, 12)

  /* Nothing stored → nothing to wipe. */
  assert.equal(credentialExpiryCheck({ agentToken: '', pairLifetime: '7d' }).wipe, false)

  /* A live timed pairing survives; a past one is wiped. */
  const future = new Date(now + 60_000).toISOString()
  const past = new Date(now - 60_000).toISOString()
  assert.equal(
    credentialExpiryCheck({ agentToken: 't', pairLifetime: '7d', pairExpiresAt: future, now }).wipe,
    false,
  )
  const expired = credentialExpiryCheck({
    agentToken: 't',
    pairLifetime: '30d',
    pairExpiresAt: past,
    now,
  })
  assert.equal(expired.wipe, true)
  assert.match(expired.reason, /30-day/)

  /* Session-only: alive sentinel keeps it, missing sentinel (browser was
   * closed) wipes it — this IS "forget right after this browser is closed". */
  assert.equal(
    credentialExpiryCheck({ agentToken: 't', pairLifetime: 'session', sessionAlive: true, now })
      .wipe,
    false,
  )
  const closed = credentialExpiryCheck({
    agentToken: 't',
    pairLifetime: 'session',
    sessionAlive: false,
    now,
  })
  assert.equal(closed.wipe, true)
  assert.match(closed.reason, /closed/)

  /* Forever (and pre-lifetime pairings with no recorded choice) never wipe. */
  assert.equal(credentialExpiryCheck({ agentToken: 't', now }).wipe, false)
  assert.equal(
    credentialExpiryCheck({ agentToken: 't', pairLifetime: 'forever', now }).wipe,
    false,
  )

  assert.deepEqual(
    [...PAIR_WIPE_KEYS],
    ['agentToken', 'deviceToken', 'relayEnabled', 'pairLifetime', 'pairExpiresAt'],
  )
})

/*
 * CREDENTIAL ESCROW POLICY. The owner, 2026-08-12: "we likely gonna keep
 * updating the extension, make sure this issue doesn't happen again" — after
 * two updates (08-10, 08-12) wiped the stored pairing. The wrapper app holds
 * an escrow copy; these are the pure decisions about what goes in and what
 * comes back out.
 */
test('session-only pairings are never escrowed; everything else is', () => {
  /* Escrow outliving a browser quit would promote "forget after close" into
   * "forever" — the one lifetime that must never reach the escrow. */
  assert.equal(shouldEscrow('session'), false)
  assert.equal(shouldEscrow('7d'), true)
  assert.equal(shouldEscrow('30d'), true)
  assert.equal(shouldEscrow('forever'), true)
  /* Corruption normalizes to the default (forever), which escrows. */
  assert.equal(shouldEscrow('garbage'), true)
  assert.equal(shouldEscrow(undefined), true)
})

test('escrow restore: only intact, unexpired, non-session credentials come back', () => {
  const now = Date.parse('2026-08-12T12:00:00Z')
  const future = new Date(now + 60_000).toISOString()
  const past = new Date(now - 60_000).toISOString()

  /* Nothing escrowed (or a blob missing its token) restores nothing. */
  assert.equal(escrowRestorePlan(null, now).restore, false)
  assert.equal(escrowRestorePlan(undefined, now).restore, false)
  assert.equal(escrowRestorePlan({}, now).restore, false)
  assert.equal(escrowRestorePlan('not-an-object', now).restore, false)

  /* A forever pairing restores, values passed through untouched. */
  const forever = {
    agentUrl: 'http://127.0.0.1:8000',
    agentToken: 'tok',
    pairLifetime: 'forever',
    pairExpiresAt: null,
    relayEnabled: true,
    deviceToken: 'pdt_x',
  }
  const plan = escrowRestorePlan(forever, now)
  assert.equal(plan.restore, true)
  assert.deepEqual(plan.values, forever)

  /* Timed pairings honor the same expiry the live credential faces —
   * escrow must not be a back door around credentialExpiryCheck. */
  assert.equal(
    escrowRestorePlan({ agentToken: 'tok', pairLifetime: '7d', pairExpiresAt: future }, now)
      .restore,
    true,
  )
  const expired = escrowRestorePlan(
    { agentToken: 'tok', pairLifetime: '30d', pairExpiresAt: past },
    now,
  )
  assert.equal(expired.restore, false)
  assert.match(expired.reason, /expired/)

  /* Defense in depth: even if a session blob somehow reached the escrow,
   * it is refused on the way out. */
  const session = escrowRestorePlan({ agentToken: 'tok', pairLifetime: 'session' }, now)
  assert.equal(session.restore, false)
  assert.match(session.reason, /session/i)
})
