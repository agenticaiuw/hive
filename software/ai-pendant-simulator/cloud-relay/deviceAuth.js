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
