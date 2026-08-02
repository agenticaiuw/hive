export function loadLocalSessions() {
  try {
    return JSON.parse(localStorage.getItem('pendantSessions') ?? '[]')
  } catch {
    return []
  }
}

export function saveLocalSessions(sessions) {
  localStorage.setItem('pendantSessions', JSON.stringify(sessions.slice(0, 100)))
}

export function upsertLocalSession(session) {
  const sessions = loadLocalSessions().filter(
    (item) => item.sessionId !== session.sessionId,
  )
  saveLocalSessions([session, ...sessions])
}

export function appendLocalTurn(sessionId, turn) {
  const sessions = loadLocalSessions()
  let session = sessions.find((item) => item.sessionId === sessionId)

  if (!session) {
    session = {
      sessionId,
      title: turn.content?.slice(0, 42) ?? 'Session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turns: [],
    }
  }

  session.turns = [...session.turns, turn].slice(-80)
  session.updatedAt = turn.createdAt ?? new Date().toISOString()
  upsertLocalSession(session)
  return session
}

export function getActiveSessionId() {
  return localStorage.getItem('pendantActiveSessionId') ?? ''
}

export function setActiveSessionId(sessionId) {
  localStorage.setItem('pendantActiveSessionId', sessionId)
}
