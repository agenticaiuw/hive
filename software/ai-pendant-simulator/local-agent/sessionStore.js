import fs from 'node:fs'
import path from 'node:path'
import { workspacePath } from './config.js'

const sessionsPath = path.join(workspacePath, 'pendant-sessions.json')
const MAX_SESSIONS = 100
const MAX_TURNS_PER_SESSION = 80

export function sessionsLocation() {
  ensureStore()
  return sessionsPath
}

export function readSessions() {
  ensureStore()

  try {
    return JSON.parse(fs.readFileSync(sessionsPath, 'utf8'))
  } catch {
    return []
  }
}

export function getSession(sessionId) {
  return readSessions().find((session) => session.sessionId === sessionId) ?? null
}

export function createSession({ title = 'New session' } = {}) {
  const now = new Date().toISOString()
  const session = {
    sessionId: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    turns: [],
  }

  const sessions = [session, ...readSessions()].slice(0, MAX_SESSIONS)
  writeSessions(sessions)
  return session
}

export function appendTurn(sessionId, turn) {
  const sessions = readSessions()
  let session = sessions.find((item) => item.sessionId === sessionId)

  if (!session) {
    const now = new Date().toISOString()
    session = {
      sessionId: sessionId || crypto.randomUUID(),
      title: deriveTitle(turn.content),
      createdAt: now,
      updatedAt: now,
      turns: [],
    }
  }

  const nextTurn = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...turn,
  }

  session.turns = [...session.turns, nextTurn].slice(-MAX_TURNS_PER_SESSION)
  session.updatedAt = nextTurn.createdAt

  if (session.turns.length === 1 && turn.role === 'user') {
    session.title = deriveTitle(turn.content)
  }

  const nextSessions = [
    session,
    ...sessions.filter((item) => item.sessionId !== session.sessionId),
  ].slice(0, MAX_SESSIONS)

  writeSessions(nextSessions)
  return { session, turn: nextTurn }
}

export function getRecentTurns(sessionId, limit = 8) {
  const session = getSession(sessionId)

  if (!session) {
    return []
  }

  return session.turns.slice(-limit)
}

export function updateSession(sessionId, { title } = {}) {
  const sessions = readSessions()
  const session = sessions.find((item) => item.sessionId === sessionId)

  if (!session) {
    return null
  }

  if (title !== undefined) {
    const nextTitle = String(title).trim()
    session.title = nextTitle || session.title
  }

  session.updatedAt = new Date().toISOString()
  writeSessions(sessions)
  return session
}

export function deleteSession(sessionId) {
  const sessions = readSessions()
  const next = sessions.filter((item) => item.sessionId !== sessionId)

  if (next.length === sessions.length) {
    return false
  }

  writeSessions(next)
  return true
}

export function clearSessionTurns(sessionId) {
  const sessions = readSessions()
  const session = sessions.find((item) => item.sessionId === sessionId)

  if (!session) {
    return null
  }

  session.turns = []
  session.updatedAt = new Date().toISOString()
  writeSessions(sessions)
  return session
}

function deriveTitle(content = '') {
  const trimmed = String(content).trim().replace(/\s+/g, ' ')

  if (!trimmed) {
    return 'New session'
  }

  return trimmed.length > 42 ? `${trimmed.slice(0, 39)}...` : trimmed
}

function ensureStore() {
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true })
  }

  if (!fs.existsSync(sessionsPath)) {
    fs.writeFileSync(sessionsPath, '[]')
  }
}

function writeSessions(sessions) {
  ensureStore()
  fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2))
}
