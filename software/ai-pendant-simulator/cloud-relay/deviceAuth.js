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

export function createDeviceCredential({
  deviceId,
  deviceType,
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
  const scopes = [...DEVICE_SCOPES[normalizedDeviceType]]
  const record = {
    tokenId,
    tokenHash: hashTokenSecret(secret),
    deviceId: normalizedDeviceId,
    role: normalizedDeviceType,
    scopes,
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

  return {
    ok: true,
    principal: {
      kind: 'device',
      tokenId: record.tokenId,
      deviceId: record.deviceId,
      role: record.role,
      scopes: [...(record.scopes || [])],
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

export function publicCredential(record) {
  if (!record) {
    return null
  }

  return {
    tokenId: record.tokenId,
    deviceId: record.deviceId,
    role: record.role,
    scopes: [...(record.scopes || [])],
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
