import fs from 'node:fs'
import path from 'node:path'
import { workspacePath } from './config.js'
import {
  mergeProductSync,
  normalizeProductSync,
  PRODUCT_SYNC_LIMITS,
  visibleProductSync,
} from '../shared/productSync.js'

export const LOCAL_SESSION_SCHEMA_VERSION = 'local-session-store.v2'
export const SINGLE_OWNER_ACCOUNT_ID =
  process.env.PENDANT_ACCOUNT_ID || 'single-owner'
export const LOCAL_SESSION_LIMITS = PRODUCT_SYNC_LIMITS

const sessionsPath = path.join(workspacePath, 'pendant-sessions.json')
const LOCAL_DEVICE_ID =
  process.env.PENDANT_DEVICE_ID ||
  process.env.BRIDGE_DEVICE_ID ||
  'local-mac-agent'

export function sessionsLocation() {
  ensureStore(sessionsPath)
  return sessionsPath
}

export function readSessionDocument({ filePath = sessionsPath } = {}) {
  ensureStore(filePath)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return emptyDocument()
  }
  // Validation failures (including size limits) are intentionally surfaced.
  // Treating an oversized valid store as empty could overwrite recoverable data.
  return normalizeLocalDocument(parsed, LOCAL_DEVICE_ID)
}

export function readSessions() {
  const document = readSessionDocument()
  return visibleSessions(document.sessions)
}

export function getSession(sessionId) {
  return (
    readSessions().find((session) => session.sessionId === sessionId) ?? null
  )
}

export function createSession({ title = 'New session' } = {}) {
  const now = new Date().toISOString()
  const session = {
    sessionId: crypto.randomUUID(),
    title: normalizeTitle(title),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    sourceDeviceId: LOCAL_DEVICE_ID,
    turns: [],
  }
  const document = readSessionDocument()
  document.sessions = enforceSessionLimits([session, ...document.sessions], now)
  writeSessionDocumentAtomic(document)
  return visibleSession(session)
}

export function appendTurn(sessionId, turn) {
  const document = readSessionDocument()
  let session = document.sessions.find(
    (item) => item.sessionId === sessionId && !item.deletedAt,
  )
  const now = new Date().toISOString()

  if (!session) {
    session = {
      sessionId: sessionId || crypto.randomUUID(),
      title: deriveTitle(turn.content),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      sourceDeviceId: LOCAL_DEVICE_ID,
      turns: [],
    }
    document.sessions.push(session)
  }

  const nextTurn = {
    id: turn.id || crypto.randomUUID(),
    createdAt: turn.createdAt || now,
    updatedAt: turn.updatedAt || turn.createdAt || now,
    deletedAt: null,
    sourceDeviceId: turn.sourceDeviceId || LOCAL_DEVICE_ID,
    ...turn,
  }
  nextTurn.id ||= crypto.randomUUID()
  nextTurn.createdAt = normalizeIsoOrNow(nextTurn.createdAt)
  nextTurn.updatedAt = normalizeIsoOrNow(nextTurn.updatedAt)
  nextTurn.deletedAt = null
  nextTurn.sourceDeviceId ||= LOCAL_DEVICE_ID

  session.turns = enforceTurnLimits([...session.turns, nextTurn], now)
  session.updatedAt = nextTurn.updatedAt
  session.sourceDeviceId = LOCAL_DEVICE_ID
  if (visibleTurns(session.turns).length === 1 && turn.role === 'user') {
    session.title = deriveTitle(turn.content)
  }

  document.updatedAt = now
  document.sessions = enforceSessionLimits(document.sessions, now)
  writeSessionDocumentAtomic(document)
  return { session: visibleSession(session), turn: nextTurn }
}

export function getRecentTurns(sessionId, limit = 8) {
  const session = getSession(sessionId)
  return session ? session.turns.slice(-limit) : []
}

export function updateSession(sessionId, { title } = {}) {
  const document = readSessionDocument()
  const session = document.sessions.find(
    (item) => item.sessionId === sessionId && !item.deletedAt,
  )
  if (!session) return null

  if (title !== undefined) {
    session.title = normalizeTitle(title) || session.title
  }
  session.updatedAt = new Date().toISOString()
  session.sourceDeviceId = LOCAL_DEVICE_ID
  document.updatedAt = session.updatedAt
  writeSessionDocumentAtomic(document)
  return visibleSession(session)
}

export function deleteSession(sessionId) {
  const document = readSessionDocument()
  const session = document.sessions.find(
    (item) => item.sessionId === sessionId && !item.deletedAt,
  )
  if (!session) return false

  const deletedAt = new Date().toISOString()
  tombstoneSession(session, deletedAt)
  document.updatedAt = deletedAt
  document.sessions = enforceSessionLimits(document.sessions, deletedAt)
  writeSessionDocumentAtomic(document)
  return true
}

export function clearSessionTurns(sessionId) {
  const document = readSessionDocument()
  const session = document.sessions.find(
    (item) => item.sessionId === sessionId && !item.deletedAt,
  )
  if (!session) return null

  const deletedAt = new Date().toISOString()
  for (const turn of session.turns) {
    if (!turn.deletedAt) tombstoneTurn(turn, deletedAt)
  }
  session.turns = enforceTurnLimits(session.turns, deletedAt)
  session.updatedAt = deletedAt
  session.sourceDeviceId = LOCAL_DEVICE_ID
  document.updatedAt = deletedAt
  writeSessionDocumentAtomic(document)
  return visibleSession(session)
}

export function exportSessionState({
  accountId = SINGLE_OWNER_ACCOUNT_ID,
  sourceDeviceId = LOCAL_DEVICE_ID,
  filePath = sessionsPath,
} = {}) {
  const document = readSessionDocument({ filePath })
  return normalizeProductSync({
    accountId,
    sourceDeviceId,
    generatedAt: document.updatedAt,
    sessions: document.sessions,
    memory: {},
  })
}

export function mergeSessionState(
  remoteState,
  {
    accountId = SINGLE_OWNER_ACCOUNT_ID,
    sourceDeviceId = LOCAL_DEVICE_ID,
    filePath = sessionsPath,
  } = {},
) {
  const localState = exportSessionState({
    accountId,
    sourceDeviceId,
    filePath,
  })
  const remote = normalizeProductSync(remoteState)
  if (remote.accountId !== accountId) {
    throw new TypeError('Remote session state belongs to a different account')
  }
  const merged = mergeProductSync(localState, remote)
  writeSessionDocumentAtomic(
    {
      schemaVersion: LOCAL_SESSION_SCHEMA_VERSION,
      updatedAt: merged.generatedAt,
      sessions: merged.sessions,
    },
    { filePath },
  )
  return {
    state: merged,
    sessions: visibleProductSync(merged).sessions,
  }
}

export function restoreSessionState(
  remoteState,
  {
    accountId = SINGLE_OWNER_ACCOUNT_ID,
    sourceDeviceId = LOCAL_DEVICE_ID,
    filePath = sessionsPath,
  } = {},
) {
  const remote = normalizeProductSync(remoteState)
  if (remote.accountId !== accountId) {
    throw new TypeError('Remote session state belongs to a different account')
  }
  const normalized = normalizeProductSync({
    ...remote,
    sourceDeviceId,
    memory: {},
  })
  writeSessionDocumentAtomic(
    {
      schemaVersion: LOCAL_SESSION_SCHEMA_VERSION,
      updatedAt: normalized.generatedAt,
      sessions: normalized.sessions,
    },
    { filePath },
  )
  return {
    state: normalized,
    sessions: visibleProductSync(normalized).sessions,
  }
}

export function writeSessionDocumentAtomic(
  input,
  { filePath = sessionsPath } = {},
) {
  const document = normalizeLocalDocument(input, LOCAL_DEVICE_ID)
  const serialized = `${JSON.stringify(document, null, 2)}\n`
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > PRODUCT_SYNC_LIMITS.maxPayloadBytes) {
    throw new RangeError(
      `Local session store exceeds ${PRODUCT_SYNC_LIMITS.maxPayloadBytes} bytes`,
    )
  }

  ensureDirectory(filePath)
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, serialized, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, filePath)
    fs.chmodSync(filePath, 0o600)
    fsyncDirectory(path.dirname(filePath))
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // A successful rename removes the temporary path.
    }
  }
  return document
}

function normalizeLocalDocument(input, sourceDeviceId) {
  const legacySessions = Array.isArray(input) ? input : input?.sessions
  const sessions = (Array.isArray(legacySessions) ? legacySessions : []).map(
    (session) => migrateLegacySession(session, sourceDeviceId),
  )
  const updatedAt =
    (!Array.isArray(input) && normalizeIso(input?.updatedAt)) ||
    newestTimestamp(sessions) ||
    new Date().toISOString()
  const normalized = normalizeProductSync({
    accountId: SINGLE_OWNER_ACCOUNT_ID,
    sourceDeviceId,
    generatedAt: updatedAt,
    sessions: enforceSessionLimits(sessions, updatedAt),
    memory: {},
  })
  return {
    schemaVersion: LOCAL_SESSION_SCHEMA_VERSION,
    updatedAt: normalized.generatedAt,
    sessions: normalized.sessions,
  }
}

function migrateLegacySession(input, sourceDeviceId) {
  const fallback = new Date().toISOString()
  const createdAt = normalizeIso(input?.createdAt) || normalizeIso(input?.updatedAt) || fallback
  const updatedAt = normalizeIso(input?.updatedAt) || createdAt
  return {
    ...input,
    sessionId: input?.sessionId || crypto.randomUUID(),
    title: normalizeTitle(input?.title),
    createdAt,
    updatedAt,
    deletedAt: normalizeIso(input?.deletedAt),
    sourceDeviceId: input?.sourceDeviceId || sourceDeviceId,
    turns: (Array.isArray(input?.turns) ? input.turns : []).map((turn) => {
      const turnCreatedAt =
        normalizeIso(turn?.createdAt) || normalizeIso(turn?.updatedAt) || createdAt
      return {
        ...turn,
        id: turn?.id || turn?.turnId || crypto.randomUUID(),
        createdAt: turnCreatedAt,
        updatedAt: normalizeIso(turn?.updatedAt) || turnCreatedAt,
        deletedAt: normalizeIso(turn?.deletedAt),
        sourceDeviceId: turn?.sourceDeviceId || sourceDeviceId,
      }
    }),
  }
}

function enforceSessionLimits(sessions, now) {
  const active = sessions
    .filter((session) => !session.deletedAt)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  for (const session of active.slice(PRODUCT_SYNC_LIMITS.maxSessions)) {
    tombstoneSession(session, now)
  }

  const deleted = sessions
    .filter((session) => session.deletedAt)
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
    .slice(0, PRODUCT_SYNC_LIMITS.maxDeletedSessions)
  return [
    ...active.slice(0, PRODUCT_SYNC_LIMITS.maxSessions),
    ...deleted,
  ].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.sessionId.localeCompare(right.sessionId),
  )
}

function enforceTurnLimits(turns, now) {
  const active = turns
    .filter((turn) => !turn.deletedAt)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
  for (const turn of active.slice(0, -PRODUCT_SYNC_LIMITS.maxTurnsPerSession)) {
    tombstoneTurn(turn, now)
  }
  const keptActive = active.slice(-PRODUCT_SYNC_LIMITS.maxTurnsPerSession)
  const deleted = turns
    .filter((turn) => turn.deletedAt)
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
    .slice(0, PRODUCT_SYNC_LIMITS.maxDeletedTurnsPerSession)
  return [...keptActive, ...deleted].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  )
}

function tombstoneSession(session, deletedAt) {
  session.deletedAt = deletedAt
  session.updatedAt = deletedAt
  session.sourceDeviceId = LOCAL_DEVICE_ID
  for (const turn of session.turns || []) {
    if (!turn.deletedAt) tombstoneTurn(turn, deletedAt)
  }
}

function tombstoneTurn(turn, deletedAt) {
  turn.deletedAt = deletedAt
  turn.updatedAt = deletedAt
  turn.sourceDeviceId = LOCAL_DEVICE_ID
}

function visibleSessions(sessions) {
  return sessions.filter((session) => !session.deletedAt).map(visibleSession)
}

function visibleSession(session) {
  return {
    ...session,
    turns: visibleTurns(session.turns || []),
  }
}

function visibleTurns(turns) {
  return turns.filter((turn) => !turn.deletedAt)
}

function normalizeTitle(title) {
  const text = String(title || 'New session').trim().replace(/\s+/g, ' ')
  return (text || 'New session').slice(0, 240)
}

function deriveTitle(content = '') {
  const trimmed = String(content).trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'New session'
  return trimmed.length > 42 ? `${trimmed.slice(0, 39)}...` : trimmed
}

function normalizeIso(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeIsoOrNow(value) {
  return normalizeIso(value) || new Date().toISOString()
}

function newestTimestamp(sessions) {
  return sessions
    .map((session) => session.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1)
}

function emptyDocument() {
  return {
    schemaVersion: LOCAL_SESSION_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    sessions: [],
  }
}

function ensureStore(filePath) {
  ensureDirectory(filePath)
  if (!fs.existsSync(filePath)) {
    writeSessionDocumentAtomic(emptyDocument(), { filePath })
  }
}

function ensureDirectory(filePath) {
  const directory = path.dirname(filePath)
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true })
  }
}

function fsyncDirectory(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch {
    // Some filesystems do not allow fsync on a directory.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}
