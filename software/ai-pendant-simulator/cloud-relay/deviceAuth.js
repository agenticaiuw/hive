import crypto from 'node:crypto'

const TOKEN_PREFIX = 'pdt'
const TOKEN_ID_BYTES = 12
const TOKEN_SECRET_BYTES = 32
const LAST_USED_WRITE_INTERVAL_MS = 60_000

export const DEVICE_SCOPES = Object.freeze({
  mobile: Object.freeze([
    'device:heartbeat:self',
    'device:status:read',
    'mac:plan',
    'mac:execute',
    'mac:jobs:read',
    'speech:transcribe',
    'speech:synthesize',
    'product:read',
    'product:write',
    'state:read',
    /* Node mesh: hold its own relay socket and exchange addressed messages
     * with any other node. Before this, a phone could only reach another node
     * by queueing a mac:* job — i.e. only while the Mac was awake. */
    'node:message:send',
    'node:message:receive',
    /*
     * A brain, not a remote control. Every other model path a phone could
     * reach queues a bridge job and is dead when the Mac sleeps, which made
     * "the iOS app can live without the Mac" false in the one way that
     * mattered. Metered per device in nodeInference.js — this is the only
     * scope in this file whose abuse costs money rather than access.
     */
    'llm:infer',
  ]),
  mac_bridge: Object.freeze([
    'device:heartbeat:self',
    'device:status:read',
    'bridge:work:claim',
    'bridge:work:complete',
    'product:read',
    'product:write',
    'state:read',
    'state:write',
    'pendant:event:write',
    'speech:synthesize',
    /* Pull a migrated reasoning thread by handle, and store one for the next
     * body. Read is the one the bridge actually uses today; write is here so a
     * Mac→Mac or Mac→relay hop does not need a re-pair to exist. */
    'context:read',
    'context:write',
    /* The Mac keeps mesh access it already had de facto — it was the hub. It
     * is now one node among several, and these are the scopes that say so. */
    'node:message:send',
    'node:message:receive',
  ]),
  /*
   * The browser extension, which until now had NO relay credential at all: it
   * knew one URL, http://127.0.0.1:8000, and everything it did went through
   * the Mac agent. Deliberately NOT mac_bridge, which the extension could
   * otherwise have been handed for convenience — that role carries
   * `state:write` (it owns agent-snapshot and fleet, the Mac's whole world
   * model) and `bridge:work:claim`, so an extension running on a compromised
   * page could have drained the Mac's work queue.
   *
   * browser:work:claim / browser:work:complete are declared here with no
   * relay route requiring them yet: the extension's own work queue is being
   * built separately, and an unlisted route is closed to everyone anyway
   * (requiredScopesForRoute → null → deny), so pre-declaring costs nothing
   * and saves a re-pair of every installed extension later. Same reasoning as
   * mac_bridge's context:write above.
   */
  browser_node: Object.freeze([
    'device:heartbeat:self',
    'device:status:read',
    'browser:work:claim',
    'browser:work:complete',
    'context:read',
    'node:message:send',
    'node:message:receive',
    /* Same argument as mobile: an extension that can hold a socket but cannot
     * think is half a node. */
    'llm:infer',
  ]),
  nrf_pendant: Object.freeze([
    'device:heartbeat:self',
    'pendant:announce',
    'pendant:audio:upload',
    'pendant:speech:read',
    'pendant:event:write',
    'mac:plan',
    'mac:jobs:read',
    'speech:transcribe',
    /* The alert inbox (firmware CONFIG_PENDANT_ALERT_INBOX, default y) polls
     * one persistent-state key for alerts raised while the owner was
     * unreachable — pendant_store.c:567. This role predates that feature and
     * had no way to read it, so the first pendant to run on a scoped token
     * would have taken a silent 403 on every poll. Deliberately NOT the blanket
     * `state:read` the mac_bridge holds: that key space also contains the Mac's
     * agent-snapshot and fleet world-model, and a chest-worn device that can be
     * lost is the last principal that should be able to read them. */
    'pendant:alerts:read',
    /*
     * NO node:message:* here, and that is a decision, not an oversight. The
     * pendant already holds one socket (/v1/pendant/converse) and the modem
     * has no budget for a second; its receive buffer is 640 B, so it could
     * not read an inbox page even if it drained one. A scope firmware cannot
     * exercise is a lie in the credential table. Reaching the pendant is what
     * the announcement queue is for (POST /v1/pendant/announce, which this
     * role does hold) — a mesh node addressing the pendant should announce.
     */
  ]),
})

export const SUPPORTED_DEVICE_TYPES = Object.freeze(
  Object.keys(DEVICE_SCOPES),
)

/**
 * What this credential may do RIGHT NOW — the only scope list any authorization
 * decision may consult.
 *
 *   effective = record.narrowed ? (stored ∩ DEVICE_SCOPES[role]) : DEVICE_SCOPES[role]
 *
 * WHY AN UN-NARROWED CREDENTIAL TRACKS LIVE POLICY IN BOTH DIRECTIONS
 * ------------------------------------------------------------------
 * Until this existed, scopes were snapshotted into the record at pair time and
 * nothing ever updated a stored list — no route, no migration, no sweep. Both
 * directions were silently broken. Adding a scope to a role reached nothing
 * already paired (every node 403'd until re-paired). Removing one withdrew
 * nothing either: every token issued before the edit kept the privilege
 * forever, which made revoking the credential not the fastest way to withdraw a
 * capability from a paired device but the ONLY way.
 *
 * Treating those snapshots as intentional per-device ceilings would have bought
 * exactly zero safety, because until now createDeviceCredential accepted no
 * scopes parameter at all: no credential has ever been deliberately narrowed,
 * so every stored list is a pure copy of role policy as it stood that day.
 * Honouring them as ceilings would only have imposed a permanent
 * re-pair-the-whole-fleet burden on every widening, in exchange for a
 * restriction nobody ever asked for.
 *
 * So: an un-narrowed credential follows the live table up AND down. Editing
 * DEVICE_SCOPES is now a real capability grant and a real capability
 * withdrawal, effective on the next request, with no re-pair. A credential that
 * was deliberately narrowed keeps its ceiling and never silently re-widens. A
 * stolen token is still bounded by revocation, which is unchanged.
 *
 * NO MIGRATION, NO BACKFILL, DELIBERATELY. `narrowed` is absent on every
 * credential that existed before this function, and absent is exactly right —
 * those records are policy snapshots, not ceilings, and the un-narrowed branch
 * is what they should get. Do not "fix" this later with a sweep that sets
 * narrowed:true from stored lists; that would re-freeze the whole fleet at
 * whatever policy happened to be live on its pairing day and reinstate the bug
 * this function exists to remove.
 *
 * A role that is no longer in DEVICE_SCOPES intersects to the EMPTY SET — deny
 * everything. Not a throw (one deleted role must not 500 the relay for the
 * devices that still hold that token) and emphatically not a fall-through to
 * the stored list, which would make deleting a role the one edit that grants
 * its holders permanent frozen privileges.
 */
export function effectiveScopesForCredential(record) {
  const roleScopes = DEVICE_SCOPES[record?.role]
  if (!roleScopes) {
    return []
  }

  if (!record.narrowed) {
    return [...roleScopes]
  }

  /* Iterating role policy rather than the stored list is the fail-closed
   * direction: the result cannot contain anything the role does not currently
   * grant, whatever a corrupted or hand-edited row happens to hold. */
  const ceiling = new Set(record.scopes || [])
  return roleScopes.filter((scope) => ceiling.has(scope))
}

export function createDeviceCredential({
  deviceId,
  deviceType,
  scopes: requestedScopes,
  now = new Date().toISOString(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const normalizedDeviceId = normalizeDeviceId(deviceId)
  const normalizedDeviceType = String(deviceType || '').trim()

  if (!normalizedDeviceId) {
    throw new TypeError('A valid deviceId is required.')
  }

  if (!SUPPORTED_DEVICE_TYPES.includes(normalizedDeviceType)) {
    throw new TypeError(
      `deviceType must be one of: ${SUPPORTED_DEVICE_TYPES.join(', ')}.`,
    )
  }

  const tokenId = toBase64Url(randomBytes(TOKEN_ID_BYTES))
  const secret = toBase64Url(randomBytes(TOKEN_SECRET_BYTES))
  const token = `${TOKEN_PREFIX}_${tokenId}.${secret}`
  const roleScopes = DEVICE_SCOPES[normalizedDeviceType]
  /*
   * Omitting `scopes` is the ordinary case and keeps the old behaviour exactly:
   * a copy of role policy, with `narrowed` ABSENT from the record rather than
   * false, so a credential minted today is byte-identical in shape to one
   * minted last month. Passing `scopes` is the deliberate act — it is the only
   * thing in the system that can set the flag, and it can only ever restrict.
   */
  const narrowing = requestedScopes !== undefined && requestedScopes !== null
  const record = {
    tokenId,
    tokenHash: hashTokenSecret(secret),
    deviceId: normalizedDeviceId,
    role: normalizedDeviceType,
    scopes: narrowing
      ? narrowedScopes(requestedScopes, roleScopes, normalizedDeviceType)
      : [...roleScopes],
    ...(narrowing ? { narrowed: true } : {}),
    createdAt: now,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    updatedAt: now,
  }

  return {
    token,
    record,
    credential: publicCredential(record),
  }
}

/*
 * A narrowing may only ever subtract. Anything outside the role is rejected
 * rather than silently dropped: a caller asking for a scope the role does not
 * grant is confused about what it is minting, and quietly handing back a
 * smaller credential than requested is how a device gets commissioned that
 * 403s in the field for reasons nobody wrote down.
 *
 * An empty narrowing is refused for the same reason — a credential that can do
 * nothing is indistinguishable at auth time from a deleted role, and is far
 * more likely to be a mangled argument than an intent. "This device may do
 * nothing" is spelled by not pairing it, or by revoking it.
 */
function narrowedScopes(requested, roleScopes, role) {
  if (!Array.isArray(requested)) {
    throw new TypeError(
      'scopes must be an array of scope strings when it is supplied at all.',
    )
  }

  const asked = new Set(
    requested.map((scope) => String(scope ?? '').trim()).filter(Boolean),
  )
  const granted = new Set(roleScopes)
  const outside = [...asked].filter((scope) => !granted.has(scope))
  if (outside.length) {
    throw new TypeError(
      `scopes must be a subset of the ${role} role; it does not grant: ` +
        `${outside.join(', ')}.`,
    )
  }

  if (!asked.size) {
    throw new TypeError(
      'scopes must name at least one scope of the role. A credential that ' +
        'holds none is a revocation, not a narrowing.',
    )
  }

  /* Stored in role-policy order so two credentials narrowed to the same set
   * compare equal by eye in an inventory listing. */
  return roleScopes.filter((scope) => asked.has(scope))
}

export function parseDeviceToken(token) {
  const match = /^pdt_([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{40,128})$/.exec(
    String(token || '').trim(),
  )
  if (!match) {
    return null
  }

  return {
    tokenId: match[1],
    secret: match[2],
  }
}

export function verifyDeviceToken(token, record, now = Date.now()) {
  const parsed = parseDeviceToken(token)
  if (!parsed || !record || parsed.tokenId !== record.tokenId) {
    return false
  }

  if (record.revokedAt) {
    return false
  }

  if (
    record.expiresAt &&
    Number.isFinite(new Date(record.expiresAt).getTime()) &&
    new Date(record.expiresAt).getTime() <= now
  ) {
    return false
  }

  return safeEqual(hashTokenSecret(parsed.secret), record.tokenHash)
}

export async function authenticateRelayRequest({
  authorization,
  adminApiKey,
  credentialStore,
  now = Date.now(),
} = {}) {
  const token = bearerToken(authorization)
  if (!token) {
    return authFailure('missing_bearer_token')
  }

  if (adminApiKey && safeEqual(token, adminApiKey)) {
    return {
      ok: true,
      principal: {
        kind: 'admin',
        role: 'admin',
        scopes: ['*'],
      },
    }
  }

  const parsed = parseDeviceToken(token)
  if (!parsed || !credentialStore?.getDeviceCredential) {
    return authFailure('invalid_bearer_token')
  }

  const record = await credentialStore.getDeviceCredential(parsed.tokenId)
  if (!verifyDeviceToken(token, record, now)) {
    return authFailure('invalid_or_revoked_device_token')
  }

  const lastUsedAt = new Date(record.lastUsedAt || 0).getTime()
  if (
    credentialStore.touchDeviceCredential &&
    (!Number.isFinite(lastUsedAt) ||
      now - lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS)
  ) {
    await credentialStore.touchDeviceCredential(
      record.tokenId,
      new Date(now).toISOString(),
    )
  }

  /*
   * Effective scopes are computed HERE, on every request, and never at pair
   * time. That placement is the entire fix and it is easy to undo by accident:
   * intersecting once in createDeviceCredential and storing the result would
   * look correct, pass a scope-matrix test, and withdraw nothing from anything
   * already in the field — which is precisely the bug. `record.scopes` must not
   * reach a principal.
   */
  return {
    ok: true,
    principal: {
      kind: 'device',
      tokenId: record.tokenId,
      deviceId: record.deviceId,
      role: record.role,
      narrowed: Boolean(record.narrowed),
      scopes: effectiveScopesForCredential(record),
    },
  }
}

export function principalHasScopes(principal, ...requiredScopes) {
  if (!principal) {
    return false
  }

  const scopes = new Set(principal.scopes || [])
  return (
    scopes.has('*') ||
    requiredScopes.flat().every((requiredScope) => scopes.has(requiredScope))
  )
}

/**
 * Would this principal's ROLE allow the request its own ceiling just refused?
 *
 * ------------------------------------------------------------------------
 * This used to answer "was this credential paired before the capability
 * shipped", which was worth answering because scopes were frozen at pair time
 * and a role widening reached nothing already in the field. It is no longer
 * worth answering in that form: effectiveScopesForCredential now derives an
 * un-narrowed credential's scopes from the live table on every request, so a
 * widening reaches every un-narrowed credential — which is all of them — on the
 * next request. For those, this can never fire, and it must not pretend to.
 *
 * What remains genuinely reachable is the narrowed case, and only that. A
 * credential minted with an explicit `scopes` list keeps its ceiling forever:
 * if the role later gains a scope, or if the operator simply left one out, that
 * credential is refused it permanently and no amount of waiting or redeploying
 * changes it. That is a real denial with a real remedy — re-pair with a wider
 * explicit list — and it deserves to be distinguishable from "your role is not
 * allowed here at all", which has no remedy.
 *
 * The two sub-cases (narrowed before the scope existed / narrowed deliberately
 * around it) are indistinguishable from the record and are not worth
 * distinguishing, so the message this drives says what is provable — the
 * credential is narrower than its role — rather than guessing at intent.
 *
 * A genuine role denial still gets the generic message on purpose: a token
 * probing routes must not get a scope-enumeration oracle out of the difference.
 */
export function credentialNarrowedBelowRole(principal, requiredScopes = []) {
  if (principal?.kind !== 'device') return false
  /* Un-narrowed credentials hold their whole role by construction, so there is
   * nothing here to report and asking is the caller's bug, not a state. */
  if (!principal.narrowed) return false

  const roleScopes = DEVICE_SCOPES[principal.role]
  if (!roleScopes) return false

  const held = new Set(principal.scopes || [])
  const granted = new Set(roleScopes)
  const missing = requiredScopes
    .flat()
    .filter((scope) => !held.has(scope) && granted.has(scope))

  return missing.length > 0 ? missing : false
}

export function principalOwnsDevice(principal, deviceId) {
  return (
    principal?.kind === 'admin' ||
    (principal?.kind === 'device' &&
      principal.deviceId === normalizeDeviceId(deviceId))
  )
}

export function verifyPairingCode(providedCode, configuredCode) {
  const expected = String(configuredCode || '')
  return Boolean(expected) && safeEqual(String(providedCode || ''), expected)
}

/*
 * The inventory shape. `scopes` is EFFECTIVE scopes — what this credential can
 * do right now — because the only reason anyone reads this listing is to decide
 * whether to revoke, and that decision is about present capability. Reporting
 * the stored snapshot would be a quiet lie in both directions: it would keep
 * showing a scope the role no longer grants, and hide one the role just gained.
 *
 * `storedScopes` and `narrowed` ride alongside so the difference is inspectable
 * rather than merely asserted — for an un-narrowed credential storedScopes is
 * the historical snapshot from its pairing day and has no authority over
 * anything. tokenHash never appears here; this object is built key by key
 * rather than spread from the record precisely so that a field added to the
 * record cannot leak by default.
 */
export function publicCredential(record) {
  if (!record) {
    return null
  }

  return {
    tokenId: record.tokenId,
    deviceId: record.deviceId,
    role: record.role,
    scopes: effectiveScopesForCredential(record),
    storedScopes: [...(record.scopes || [])],
    narrowed: Boolean(record.narrowed),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || null,
    expiresAt: record.expiresAt || null,
    revokedAt: record.revokedAt || null,
    updatedAt: record.updatedAt,
  }
}

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim()
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/.test(deviceId)
    ? deviceId
    : ''
}

function hashTokenSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex')
}

function safeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest()
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest()
  return crypto.timingSafeEqual(leftDigest, rightDigest)
}

function bearerToken(authorization) {
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(String(authorization || ''))
  return match?.[1] || ''
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function authFailure(code) {
  return {
    ok: false,
    status: 401,
    code,
    error: 'Blocked for safety: invalid or missing relay credential.',
  }
}
