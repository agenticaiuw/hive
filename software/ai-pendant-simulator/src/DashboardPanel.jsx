export function DashboardPanel({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onRefresh,
}) {
  const activeSession =
    sessions.find((session) => session.sessionId === activeSessionId) ??
    sessions[0] ??
    null

  return (
    <section className="dashboard-panel" aria-label="Session Dashboard">
      <div className="dashboard-header">
        <div>
          <h2>Dashboard</h2>
          <p>Previous sessions, turns, and instant builtin responses.</p>
        </div>
        <div className="dashboard-actions">
          <button className="ghost-button" type="button" onClick={onRefresh}>
            Refresh
          </button>
          <button className="ghost-button" type="button" onClick={onNewSession}>
            New Session
          </button>
        </div>
      </div>

      <div className="dashboard-grid">
        <aside className="session-list">
          <h3>Sessions</h3>
          {sessions.length ? (
            sessions.map((session) => (
              <button
                key={session.sessionId}
                type="button"
                className={
                  session.sessionId === activeSession?.sessionId
                    ? 'session-card is-active'
                    : 'session-card'
                }
                onClick={() => onSelectSession(session.sessionId)}
              >
                <strong>{session.title}</strong>
                <span>{formatWhen(session.updatedAt)}</span>
                <span>{session.turns?.length ?? 0} turns</span>
              </button>
            ))
          ) : (
            <p>No sessions yet.</p>
          )}
        </aside>

        <div className="session-detail">
          <h3>Conversation</h3>
          {activeSession?.turns?.length ? (
            <div className="turn-list">
              {activeSession.turns.slice().reverse().map((turn) => (
                <article key={turn.id ?? `${turn.createdAt}-${turn.role}`} className={`turn turn-${turn.role}`}>
                  <header>
                    <strong>{turn.role}</strong>
                    <span>{turn.source ?? 'message'}</span>
                    <time>{formatWhen(turn.createdAt)}</time>
                  </header>
                  <p>{turn.content}</p>
                  {turn.result ? <pre>{truncate(turn.result, 320)}</pre> : null}
                </article>
              ))}
            </div>
          ) : (
            <p>Select or start a session to see history here.</p>
          )}
        </div>
      </div>
    </section>
  )
}

function formatWhen(value) {
  if (!value) {
    return ''
  }

  return new Date(value).toLocaleString()
}

function truncate(value, maxLength) {
  const text = String(value ?? '')

  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 3)}...`
}
