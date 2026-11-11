import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authenticateRelayRequest,
  createDeviceCredential,
  credentialNarrowedBelowRole,
  DEVICE_SCOPES,
  effectiveScopesForCredential,
  parseDeviceToken,
  principalHasScopes,
  principalOwnsDevice,
  publicCredential,
  verifyDeviceToken,
  verifyPairingCode,
} from './deviceAuth.js'
import { createMemoryStore } from './store/memoryStore.js'

const deterministicRandom = (size) => Buffer.alloc(size, size)

/*
 * How the scope-policy tests below simulate an edit to DEVICE_SCOPES.
 *
 * DEVICE_SCOPES is frozen, so a test cannot literally add or remove a scope
 * from a role. It does not need to. The only thing a policy edit changes about
 * an ALREADY PAIRED device is the relationship between its stored row and the
 * live table, and that relationship is fully reproducible:
 *
 *   - after a scope is REMOVED from a role, the rows of devices paired before
 *     the edit still list it while the live table no longer grants it. A stored
 *     list holding a scope the role does not currently grant IS that state.
 *   - after a scope is ADDED, the rows of devices paired before the edit are
 *     missing it while the live table grants it. A stored list missing a scope
 *     the role currently grants IS that state.
 *
 * Nothing in the relay can tell those rows apart from rows produced any other
 * way — there is no "policy version" recorded anywhere — so a test built this
 * way exercises exactly the code path a real deploy would, through the real
 * authenticateRelayRequest, against a real store.
 */
async function storedCredential(store, { deviceId, deviceType, ...overrides }) {
  const created = createDeviceCredential({
    deviceId,
    deviceType,
    now: '2026-07-01T00:00:00.000Z',
    randomBytes: deterministicRandom,
  })
  const record = { ...created.record, ...overrides }
  await store.saveDeviceCredential(record)
  return { ...created, record }
}

async function principalFrom(store, token) {
  const auth = await authenticateRelayRequest({
    authorization: `Bearer ${token}`,
    credentialStore: store,
  })
  assert.equal(auth.ok, true, 'the token itself must still authenticate')
  return auth.principal
}

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

/*
 * The browser extension's 7d/30d pairing choices land here as ttlMs, and the
 * expiry has to be REAL — stamped on the record that verifyDeviceToken
 * already refuses past its expiresAt — so the credential dies server-side
 * even if the browser that minted it never wakes again.
 */
test('an optional ttlMs stamps a hard expiresAt; garbage is refused, not clamped', () => {
  const now = '2026-08-12T00:00:00.000Z'
  const week = 7 * 24 * 60 * 60 * 1_000

  const timed = createDeviceCredential({
    deviceId: 'safari-evan-mac',
    deviceType: 'browser_node',
    ttlMs: week,
    now,
    randomBytes: deterministicRandom,
  })
  assert.equal(timed.record.expiresAt, '2026-08-19T00:00:00.000Z')
  /* Alive the moment before, dead the moment after — through the same
   * verifier every authenticated request already passes. */
  const expiry = new Date(timed.record.expiresAt).getTime()
  assert.equal(verifyDeviceToken(timed.token, timed.record, expiry - 1), true)
  assert.equal(verifyDeviceToken(timed.token, timed.record, expiry), false)

  /* No ttl (or explicit null) keeps the historical no-expiry mint. */
  for (const ttlMs of [undefined, null]) {
    const open = createDeviceCredential({
      deviceId: 'safari-evan-mac',
      deviceType: 'browser_node',
      ttlMs,
      now,
      randomBytes: deterministicRandom,
    })
    assert.equal(open.record.expiresAt, null)
  }

  /* A pre-auth route feeds this, so a mangled lifetime must be an error the
   * pairer hears about now — not a token that 401s later or lives forever. */
  for (const ttlMs of [0, -1, 1.5, NaN, Infinity, '604800000', 400 * 24 * 60 * 60 * 1_000]) {
    assert.throws(
      () =>
        createDeviceCredential({
          deviceId: 'safari-evan-mac',
          deviceType: 'browser_node',
          ttlMs,
          now,
          randomBytes: deterministicRandom,
        }),
      TypeError,
    )
  }
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

/* ------------------------------------------------------------------------ *
 * Effective scopes: the stored list is a snapshot, live policy is the truth.
 * ------------------------------------------------------------------------ */

test('a scope REMOVED from a role stops working for an existing token, at once', async () => {
  /*
   * The direction that had no workaround at all. Before this, editing
   * DEVICE_SCOPES withdrew nothing from anything already paired — revoking the
   * credential was the only way to take a capability back from a device.
   *
   * The row below is what a device's row looks like after the owner removes
   * two scopes from its role: the row still lists them, the live table no
   * longer grants them. No re-pair, no migration, no sweep has touched it.
   */
  const store = createMemoryStore()
  const { token, record } = await storedCredential(store, {
    deviceId: 'phone-from-the-permissive-era',
    deviceType: 'mobile',
    scopes: [...DEVICE_SCOPES.mobile, 'state:write', 'bridge:work:claim'],
  })

  /* The row really does still carry them — the withdrawal is not happening in
   * the store, which is the point. */
  assert.equal(record.scopes.includes('state:write'), true)

  const principal = await principalFrom(store, token)
  assert.equal(principalHasScopes(principal, 'state:write'), false)
  assert.equal(principalHasScopes(principal, 'bridge:work:claim'), false)
  /* And nothing was withdrawn that policy still grants. */
  assert.equal(principalHasScopes(principal, 'mac:execute'), true)
  assert.deepEqual(principal.scopes, [...DEVICE_SCOPES.mobile])

  /* An operator deciding whether to revoke must see the same thing. */
  const listed = publicCredential(record)
  assert.equal(listed.scopes.includes('state:write'), false)
  assert.equal(listed.storedScopes.includes('state:write'), true)
  assert.equal(listed.narrowed, false)
})

test('a scope ADDED to a role DOES reach an existing un-narrowed token', async () => {
  /*
   * The owner's decision, pinned. This is the direction that costs a re-pair of
   * the entire fleet if it is not taken, and the reasoning for taking it is
   * that no stored list has ever been a deliberate restriction: until
   * createDeviceCredential grew a `scopes` parameter, every stored list was a
   * verbatim copy of role policy on the day of pairing.
   *
   * The row below is a phone paired before the mesh and the relay brain
   * shipped. It picks both up on its next request, with no re-pair.
   */
  const store = createMemoryStore()
  const laterScopes = ['llm:infer', 'node:message:send', 'node:message:receive']
  const { token } = await storedCredential(store, {
    deviceId: 'phone-paired-before-the-mesh',
    deviceType: 'mobile',
    scopes: DEVICE_SCOPES.mobile.filter((scope) => !laterScopes.includes(scope)),
  })

  const principal = await principalFrom(store, token)
  for (const scope of laterScopes) {
    assert.equal(
      principalHasScopes(principal, scope),
      true,
      `an un-narrowed credential must pick up ${scope} without a re-pair`,
    )
  }
  assert.deepEqual(principal.scopes, [...DEVICE_SCOPES.mobile])

  /*
   * And because it picks them up, the stale-credential diagnostic can no longer
   * fire for it. Leaving that in place would have meant shipping a 403 branch
   * asserting a condition the model no longer produces.
   */
  assert.equal(principal.narrowed, false)
  assert.equal(credentialNarrowedBelowRole(principal, ['llm:infer']), false)
})

test('a scope added to a role does NOT reach a narrowed credential', async () => {
  /*
   * The exception that makes the flag worth having. This credential was minted
   * with an explicit ceiling, so a role widening must not silently re-widen it
   * — that is the difference between "the stored list was a snapshot" and "the
   * stored list was a decision".
   */
  const store = createMemoryStore()
  const ceiling = ['device:heartbeat:self', 'device:status:read', 'state:read']
  const { token } = await storedCredential(store, {
    deviceId: 'phone-on-a-short-leash',
    deviceType: 'mobile',
    scopes: ceiling,
    narrowed: true,
  })

  const principal = await principalFrom(store, token)
  assert.deepEqual(principal.scopes, ceiling)
  assert.equal(principal.narrowed, true)
  for (const scope of ['llm:infer', 'mac:execute', 'node:message:send']) {
    assert.equal(
      principalHasScopes(principal, scope),
      false,
      `a narrowed credential must not pick up ${scope} from its role`,
    )
  }

  /* This is the one case where the re-pair diagnostic is still true, so it is
   * the one case where it still fires. */
  assert.deepEqual(credentialNarrowedBelowRole(principal, ['llm:infer']), [
    'llm:infer',
  ])
  /* A scope no role grants is a real denial, not a narrowing — no re-pair
   * turns a device into an admin. */
  assert.equal(credentialNarrowedBelowRole(principal, ['admin']), false)
})

test('a narrowed credential cannot exceed its ceiling, and the ceiling cannot exceed the role', async () => {
  /*
   * Both halves of the intersection. The stored list here claims a scope the
   * mobile role does not grant — a hand-edited row, a restored backup, a role
   * that lost a scope after this credential was narrowed. It is dropped: the
   * ceiling can only ever be intersected DOWN with live policy, never used to
   * reach outside it.
   */
  const store = createMemoryStore()
  const { token, record } = await storedCredential(store, {
    deviceId: 'phone-with-an-impossible-ceiling',
    deviceType: 'mobile',
    scopes: ['state:read', 'bridge:work:claim', 'llm:infer'],
    narrowed: true,
  })

  const principal = await principalFrom(store, token)
  assert.deepEqual(principal.scopes, ['state:read', 'llm:infer'])
  assert.equal(principalHasScopes(principal, 'bridge:work:claim'), false)
  /* Nor does the wider role leak in around the ceiling. */
  assert.equal(principalHasScopes(principal, 'mac:execute'), false)
  assert.deepEqual(effectiveScopesForCredential(record), ['state:read', 'llm:infer'])
})

test('a role that no longer exists in DEVICE_SCOPES denies everything', async () => {
  /*
   * Deleting a role must not be the one edit that grants its holders permanent
   * frozen privileges. The token still authenticates — it is a valid,
   * unrevoked secret and pretending otherwise would hide the situation — but it
   * intersects to the empty set and every route is closed to it, since every
   * entry in the scope table demands at least one scope and an unlisted route
   * denies universally.
   */
  const store = createMemoryStore()
  const { token, record } = await storedCredential(store, {
    deviceId: 'node-of-a-retired-kind',
    deviceType: 'mobile',
    role: 'retired_role',
    scopes: ['mac:execute', 'llm:infer', 'state:write'],
  })

  assert.deepEqual(effectiveScopesForCredential(record), [])

  const principal = await principalFrom(store, token)
  assert.deepEqual(principal.scopes, [])
  for (const scope of ['mac:execute', 'llm:infer', 'state:write', 'device:heartbeat:self']) {
    assert.equal(principalHasScopes(principal, scope), false, scope)
  }
  /* No diagnostic either: there is no role to re-pair into, so "re-pair to
   * pick it up" would be advice that cannot work. */
  assert.equal(credentialNarrowedBelowRole(principal, ['mac:execute']), false)
  /* Same for a narrowed credential of a deleted role: still nothing. */
  assert.deepEqual(
    effectiveScopesForCredential({ ...record, narrowed: true }),
    [],
  )
})

test('effective scopes are computed at auth time, not frozen at pair time', async () => {
  /*
   * The regression this whole change exists to prevent. Intersecting once in
   * createDeviceCredential and storing the answer looks correct, passes a scope
   * matrix, and withdraws nothing from anything already in the field.
   *
   * So: the record is written ONCE, and the same untouched row is authenticated
   * twice. Both principals must equal live policy, and neither may equal the
   * row. If effective scopes were ever computed at creation, the row and the
   * principal would agree here.
   */
  const store = createMemoryStore()
  const { token, record } = await storedCredential(store, {
    deviceId: 'phone-from-another-era',
    deviceType: 'mobile',
    scopes: ['state:read', 'state:write'],
  })

  const first = await principalFrom(store, token)
  const second = await principalFrom(store, token)
  assert.deepEqual(first.scopes, [...DEVICE_SCOPES.mobile])
  assert.deepEqual(second.scopes, [...DEVICE_SCOPES.mobile])

  const reread = await store.getDeviceCredential(record.tokenId)
  assert.deepEqual(
    reread.scopes,
    ['state:read', 'state:write'],
    'authentication must not rewrite the stored list either',
  )
  assert.notDeepEqual(first.scopes, reread.scopes)
})

/* ------------------------------------------------------------------------ *
 * Minting a narrowed credential — the only thing that can set the flag.
 * ------------------------------------------------------------------------ */

test('createDeviceCredential without scopes leaves narrowed unset', () => {
  const created = createDeviceCredential({
    deviceId: 'ordinary-phone',
    deviceType: 'mobile',
    randomBytes: deterministicRandom,
  })

  /* Unset, not false: a credential minted today must be shape-identical to the
   * ones already in the fleet, so that "absent means un-narrowed" is a claim
   * about one shape rather than two. */
  assert.equal(Object.hasOwn(created.record, 'narrowed'), false)
  assert.deepEqual(created.record.scopes, [...DEVICE_SCOPES.mobile])
  assert.equal(created.credential.narrowed, false)
  assert.deepEqual(created.credential.scopes, [...DEVICE_SCOPES.mobile])
})

test('createDeviceCredential with scopes narrows, and can only ever subtract', () => {
  const created = createDeviceCredential({
    deviceId: 'phone-that-may-not-execute',
    deviceType: 'mobile',
    /* Deliberately out of policy order and with a duplicate, to pin that the
     * stored ceiling is normalised rather than echoed. */
    scopes: ['state:read', 'device:heartbeat:self', 'state:read'],
    randomBytes: deterministicRandom,
  })

  assert.equal(created.record.narrowed, true)
  assert.deepEqual(created.record.scopes, ['device:heartbeat:self', 'state:read'])
  assert.equal(created.credential.narrowed, true)
  assert.deepEqual(created.credential.scopes, ['device:heartbeat:self', 'state:read'])
  assert.equal(
    principalHasScopes({ scopes: created.credential.scopes }, 'mac:execute'),
    false,
  )

  /* A scope outside the role is refused rather than silently dropped: quietly
   * minting a smaller credential than asked for is how a device ends up 403ing
   * in the field for a reason nobody wrote down. */
  assert.throws(
    () =>
      createDeviceCredential({
        deviceId: 'phone-reaching-upward',
        deviceType: 'mobile',
        scopes: ['state:read', 'bridge:work:claim'],
        randomBytes: deterministicRandom,
      }),
    /bridge:work:claim/,
  )
  /* Not even the wildcard. */
  assert.throws(
    () =>
      createDeviceCredential({
        deviceId: 'phone-reaching-for-admin',
        deviceType: 'mobile',
        scopes: ['*'],
        randomBytes: deterministicRandom,
      }),
    TypeError,
  )
  /* An empty or malformed narrowing is a mangled argument, not an intent. */
  for (const scopes of [[], [''], 'state:read', {}]) {
    assert.throws(
      () =>
        createDeviceCredential({
          deviceId: 'phone-with-nothing',
          deviceType: 'mobile',
          scopes,
          randomBytes: deterministicRandom,
        }),
      TypeError,
      `scopes=${JSON.stringify(scopes)} must be refused`,
    )
  }
})

test('publicCredential reports what the credential can do now, and never a hash', async () => {
  const store = createMemoryStore()
  const { record } = await storedCredential(store, {
    deviceId: 'phone-under-inspection',
    deviceType: 'mobile',
    scopes: ['state:read', 'bridge:work:claim'],
    narrowed: true,
  })

  const listed = publicCredential(record)
  assert.deepEqual(listed.scopes, ['state:read'])
  assert.deepEqual(listed.storedScopes, ['state:read', 'bridge:work:claim'])
  assert.equal(listed.narrowed, true)
  assert.equal(listed.tokenHash, undefined)
  assert.equal(listed.token, undefined)
  assert.equal(JSON.stringify(listed).includes(record.tokenHash), false)
})
