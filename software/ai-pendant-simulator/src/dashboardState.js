import {
  getActiveSessionId,
  loadLocalSessions,
  setActiveSessionId,
} from './sessionStorage'

export function hydrateDashboardState() {
  const sessions = loadLocalSessions()
  const activeSessionId = getActiveSessionId() || sessions[0]?.sessionId || ''
  return { sessions, activeSessionId }
}

export function rememberDashboardSession(session) {
  if (session?.sessionId) {
    setActiveSessionId(session.sessionId)
  }
}
