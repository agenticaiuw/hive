const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const PRODUCT_SYNC_SCHEMA_VERSION = 'product-sync.v1'
export const PRODUCT_SYNC_LIMITS = Object.freeze({
  maxPayloadBytes: 8 * 1024 * 1024,
  maxSessions: 100,
  maxDeletedSessions: 1_000,
  maxTurnsPerSession: 80,
  maxDeletedTurnsPerSession: 400,
  maxTurnBytes: 64 * 1024,
  maxSessionMetadataBytes: 32 * 1024,
  maxMemoryEntities: 5_000,
  maxMemoryRelations: 10_000,
  maxMemoryRecordBytes: 64 * 1024,
})

export function normalizeProductSync(input, { limits = PRODUCT_SYNC_LIMITS } = {}) {
  assertObject('sync', input)
  const accountId = normalizeId('sync.accountId', input.accountId)
  const sourceDeviceId = normalizeId(
    'sync.sourceDeviceId',
    input.sourceDeviceId || 'unknown-device',
  )
  const generatedAt = normalizeTimestamp(
    'sync.generatedAt',
    input.generatedAt || new Date().toISOString(),
  )
  const sessions = normalizeSessions(input.sessions || [], {
    sourceDeviceId,
    limits,
  })
  const memory = normalizeMemory(input.memory || {}, {
    sourceDeviceId,
    limits,
  })

  const normalized = {
    schemaVersion: PRODUCT_SYNC_SCHEMA_VERSION,
    accountId,
    sourceDeviceId,
    revision: normalizeRevision(input.revision),
    generatedAt,
    sessions,
    memory,
  }
  assertByteLimit('sync payload', normalized, limits.maxPayloadBytes)
  return normalized
}

export function mergeProductSync(leftInput, rightInput, options = {}) {
  const left = normalizeProductSync(leftInput, options)
  const right = normalizeProductSync(rightInput, options)
  if (left.accountId !== right.accountId) {
    throw new TypeError('Cannot merge product state from different accounts')
  }

  const sessions = mergeSessions(left.sessions, right.sessions)
  const memory = {
    entities: mergeRecords(left.memory.entities, right.memory.entities, 'id'),
    relations: mergeRecords(left.memory.relations, right.memory.relations, 'id'),
  }
  const winner = compareVersionedRecords(left, right) >= 0 ? left : right

  return normalizeProductSync(
    {
      schemaVersion: PRODUCT_SYNC_SCHEMA_VERSION,
      accountId: left.accountId,
      sourceDeviceId: winner.sourceDeviceId,
      revision: Math.max(left.revision, right.revision),
      generatedAt:
        compareIso(left.generatedAt, right.generatedAt) >= 0
          ? left.generatedAt
          : right.generatedAt,
      sessions,
      memory,
    },
    options,
  )
}

export function visibleProductSync(input, options = {}) {
  const normalized = normalizeProductSync(input, options)
  return {
    ...normalized,
    sessions: normalized.sessions
      .filter((session) => !session.deletedAt)
      .map((session) => ({
        ...session,
        turns: session.turns.filter((turn) => !turn.deletedAt),
      })),
    memory: {
      entities: normalized.memory.entities.filter((entity) => !entity.deletedAt),
      relations: normalized.memory.relations.filter(
        (relation) => !relation.deletedAt,
      ),
    },
  }
}

export function compareVersionedRecords(left, right) {
  const updatedComparison = compareIso(left?.updatedAt, right?.updatedAt)
  if (updatedComparison !== 0) return updatedComparison

  const deletedComparison =
    Number(Boolean(left?.deletedAt)) - Number(Boolean(right?.deletedAt))
  if (deletedComparison !== 0) return deletedComparison

  const sourceComparison = String(left?.sourceDeviceId || '').localeCompare(
    String(right?.sourceDeviceId || ''),
  )
  if (sourceComparison !== 0) return sourceComparison

  return stableFingerprint(left).localeCompare(stableFingerprint(right))
}

export function recordVersionKey(record) {
  const timestamp = normalizeTimestamp(
    'record.updatedAt',
    record?.updatedAt || record?.createdAt,
  )
  const deleted = record?.deletedAt ? '1' : '0'
  const sourceDeviceId = normalizeId(
    'record.sourceDeviceId',
    record?.sourceDeviceId || 'unknown-device',
  )
  return `${timestamp}|${deleted}|${sourceDeviceId}|${stableFingerprint(record)}`
}

function normalizeSessions(input, { sourceDeviceId, limits }) {
  if (!Array.isArray(input)) {
    throw new TypeError('sync.sessions must be an array')
  }

  const normalized = mergeRecords(
    input.map((session, index) =>
      normalizeSession(session, {
        name: `sync.sessions[${index}]`,
        sourceDeviceId,
        limits,
      }),
    ),
    [],
    'sessionId',
  )
  const activeCount = normalized.filter((session) => !session.deletedAt).length
  const deletedCount = normalized.length - activeCount
  if (activeCount > limits.maxSessions) {
    throw new RangeError(`sync.sessions exceeds ${limits.maxSessions} active sessions`)
  }
  if (deletedCount > limits.maxDeletedSessions) {
    throw new RangeError(
      `sync.sessions exceeds ${limits.maxDeletedSessions} session tombstones`,
    )
  }
  return normalized.sort(compareSessionOrder)
}

function normalizeSession(input, { name, sourceDeviceId, limits }) {
  assertObject(name, input)
  const sessionId = normalizeId(`${name}.sessionId`, input.sessionId)
  const createdAt = normalizeTimestamp(
    `${name}.createdAt`,
    input.createdAt || input.updatedAt,
  )
  const updatedAt = normalizeTimestamp(
    `${name}.updatedAt`,
    input.updatedAt || createdAt,
  )
  const deletedAt = input.deletedAt
    ? normalizeTimestamp(`${name}.deletedAt`, input.deletedAt)
    : null
  const recordSource = normalizeId(
    `${name}.sourceDeviceId`,
    input.sourceDeviceId || sourceDeviceId,
  )
  const title = String(input.title || 'New session').trim().slice(0, 240)
  const turns = mergeRecords(
    (Array.isArray(input.turns) ? input.turns : []).map((turn, index) =>
      normalizeTurn(turn, {
        name: `${name}.turns[${index}]`,
        sourceDeviceId: recordSource,
        limits,
      }),
    ),
    [],
    'id',
  )
  const activeTurnCount = turns.filter((turn) => !turn.deletedAt).length
  const deletedTurnCount = turns.length - activeTurnCount
  if (activeTurnCount > limits.maxTurnsPerSession) {
    throw new RangeError(
      `${name}.turns exceeds ${limits.maxTurnsPerSession} active turns`,
    )
  }
  if (deletedTurnCount > limits.maxDeletedTurnsPerSession) {
    throw new RangeError(
      `${name}.turns exceeds ${limits.maxDeletedTurnsPerSession} turn tombstones`,
    )
  }

  const normalized = {
    ...copyJson(input),
    sessionId,
    title: title || 'New session',
    createdAt,
    updatedAt,
    deletedAt,
    sourceDeviceId: recordSource,
    turns: turns.sort(compareTurnOrder),
  }
  assertByteLimit(
    `${name} metadata`,
    { ...normalized, turns: undefined },
    limits.maxSessionMetadataBytes,
  )
  return normalized
}

function normalizeTurn(input, { name, sourceDeviceId, limits }) {
  assertObject(name, input)
  const id = normalizeId(`${name}.id`, input.id || input.turnId)
  const createdAt = normalizeTimestamp(
    `${name}.createdAt`,
    input.createdAt || input.updatedAt,
  )
  const updatedAt = normalizeTimestamp(
    `${name}.updatedAt`,
    input.updatedAt || createdAt,
  )
  const deletedAt = input.deletedAt
    ? normalizeTimestamp(`${name}.deletedAt`, input.deletedAt)
    : null
  const recordSource = normalizeId(
    `${name}.sourceDeviceId`,
    input.sourceDeviceId || sourceDeviceId,
  )
  const normalized = {
    ...copyJson(input),
    id,
    createdAt,
    updatedAt,
    deletedAt,
    sourceDeviceId: recordSource,
  }
  if (!deletedAt) {
    normalized.role = String(input.role || 'assistant').slice(0, 40)
    normalized.content = String(input.content ?? '')
  }
  assertByteLimit(name, normalized, limits.maxTurnBytes)
  return normalized
}

function normalizeMemory(input, { sourceDeviceId, limits }) {
  assertObject('sync.memory', input)
  const entities = normalizeMemoryRecords(input.entities || [], {
    kind: 'entity',
    sourceDeviceId,
    maxRecords: limits.maxMemoryEntities,
    maxRecordBytes: limits.maxMemoryRecordBytes,
  })
  const relations = normalizeMemoryRecords(input.relations || [], {
    kind: 'relation',
    sourceDeviceId,
    maxRecords: limits.maxMemoryRelations,
    maxRecordBytes: limits.maxMemoryRecordBytes,
  })
  return { entities, relations }
}

function normalizeMemoryRecords(
  input,
  { kind, sourceDeviceId, maxRecords, maxRecordBytes },
) {
  if (!Array.isArray(input)) {
    throw new TypeError(`sync.memory.${kind}s must be an array`)
  }
  if (input.length > maxRecords) {
    throw new RangeError(`sync.memory.${kind}s exceeds ${maxRecords} records`)
  }

  return mergeRecords(
    input.map((record, index) => {
      const name = `sync.memory.${kind}s[${index}]`
      assertObject(name, record)
      const id = normalizeId(`${name}.id`, record.id)
      const createdAt = normalizeTimestamp(
        `${name}.createdAt`,
        record.createdAt || record.updatedAt,
      )
      const updatedAt = normalizeTimestamp(
        `${name}.updatedAt`,
        record.updatedAt || createdAt,
      )
      const deletedAt = record.deletedAt
        ? normalizeTimestamp(`${name}.deletedAt`, record.deletedAt)
        : null
      const normalized = {
        ...copyJson(record),
        id,
        createdAt,
        updatedAt,
        deletedAt,
        sourceDeviceId: normalizeId(
          `${name}.sourceDeviceId`,
          record.sourceDeviceId || sourceDeviceId,
        ),
      }
      if (kind === 'entity') {
        normalized.type = String(record.type || 'Note').trim().slice(0, 80)
        normalized.name = String(record.name || 'Untitled').trim().slice(0, 240)
      } else {
        normalized.from = normalizeId(`${name}.from`, record.from)
        normalized.to = normalizeId(`${name}.to`, record.to)
        normalized.type = String(record.type || 'related_to').trim().slice(0, 80)
      }
      assertByteLimit(name, normalized, maxRecordBytes)
      return normalized
    }),
    [],
    'id',
  ).sort(compareMemoryOrder)
}

function mergeSessions(left, right) {
  const leftById = new Map(left.map((session) => [session.sessionId, session]))
  const rightById = new Map(right.map((session) => [session.sessionId, session]))
  const ids = [...new Set([...leftById.keys(), ...rightById.keys()])].sort()

  return ids
    .map((sessionId) => {
      const leftSession = leftById.get(sessionId)
      const rightSession = rightById.get(sessionId)
      if (!leftSession) return rightSession
      if (!rightSession) return leftSession
      const winner =
        compareVersionedRecords(leftSession, rightSession) >= 0
          ? leftSession
          : rightSession
      return {
        ...winner,
        turns: mergeRecords(leftSession.turns, rightSession.turns, 'id').sort(
          compareTurnOrder,
        ),
      }
    })
    .sort(compareSessionOrder)
}

function mergeRecords(left, right, idKey) {
  const records = new Map()
  for (const record of [...left, ...right]) {
    const id = record[idKey]
    const current = records.get(id)
    if (!current || compareVersionedRecords(record, current) > 0) {
      records.set(id, record)
    }
  }
  return [...records.values()]
}

function compareSessionOrder(left, right) {
  return (
    compareIso(right.updatedAt, left.updatedAt) ||
    left.sessionId.localeCompare(right.sessionId)
  )
}

function compareTurnOrder(left, right) {
  return (
    compareIso(left.createdAt, right.createdAt) ||
    left.id.localeCompare(right.id)
  )
}

function compareMemoryOrder(left, right) {
  return left.id.localeCompare(right.id)
}

function compareIso(left, right) {
  return String(left || '').localeCompare(String(right || ''))
}

function normalizeId(name, value) {
  const text = String(value || '').trim()
  if (!ID_PATTERN.test(text)) {
    throw new TypeError(`${name} must be a stable identifier`)
  }
  return text
}

function normalizeTimestamp(name, value) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) {
    throw new TypeError(`${name} must be an ISO timestamp`)
  }
  return date.toISOString()
}

function normalizeRevision(value) {
  const number = Number(value || 0)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError('sync.revision must be a non-negative integer')
  }
  return number
}

function assertObject(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
}

function assertByteLimit(name, value, maxBytes) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  if (bytes > maxBytes) {
    throw new RangeError(`${name} exceeds ${maxBytes} bytes`)
  }
}

function copyJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function stableStringify(value) {
  return JSON.stringify(sortObject(value))
}

function stableFingerprint(value) {
  const text = stableStringify(value)
  let left = 0x811c9dc5
  let right = 0x9e3779b1
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193)
    right = Math.imul(right ^ code, 0x85ebca6b)
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0)
    .toString(16)
    .padStart(8, '0')}`
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]),
  )
}
