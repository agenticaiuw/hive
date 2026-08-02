import { useEffect, useMemo, useState } from 'react'
import {
  createOpsClient,
  loadOpsSettings,
  saveOpsSettings,
} from './api.js'

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'chats', label: 'Chats' },
  { id: 'memory', label: 'Memory' },
  { id: 'work', label: 'Work' },
  { id: 'history', label: 'History' },
]

const MEMORY_TYPES = [
  { value: 'Person', label: 'Person' },
  { value: 'EmailDraft', label: 'Email' },
  { value: 'Task', label: 'Task' },
  { value: 'File', label: 'File' },
  { value: 'Project', label: 'Project' },
  { value: 'Note', label: 'Note' },
]

const TAB_STORAGE_KEY = 'opsDashboardTab'

function isValidTab(id) {
  return TABS.some((tab) => tab.id === id)
}

function loadInitialTab() {
  try {
    const hash = window.location.hash.replace(/^#/, '').trim()
    if (isValidTab(hash)) {
      return hash
    }
    const saved = localStorage.getItem(TAB_STORAGE_KEY)
    if (isValidTab(saved)) {
      return saved
    }
  } catch {
    // ignore
  }
  return 'home'
}

function persistTab(id) {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, id)
    if (window.location.hash.replace(/^#/, '') !== id) {
      window.history.replaceState(null, '', `#${id}`)
    }
  } catch {
    // ignore
  }
}

export function OpsApp() {
  const [settings, setSettings] = useState(loadOpsSettings)
  const [tab, setTab] = useState(loadInitialTab)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [status, setStatus] = useState(null)
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [context, setContext] = useState(null)
  const [jobs, setJobs] = useState([])
  const [pipelineRuns, setPipelineRuns] = useState([])
  const [traces, setTraces] = useState([])
  const [logs, setLogs] = useState([])
  const [error, setError] = useState('')
  const [entityDraft, setEntityDraft] = useState({
    type: 'Person',
    name: '',
    note: '',
  })
  const [renameDraft, setRenameDraft] = useState('')
  const [selectedTraceId, setSelectedTraceId] = useState(null)
  const [selectedPipelineId, setSelectedPipelineId] = useState(null)

  const client = useMemo(() => createOpsClient(settings), [settings])
  const activeSession =
    sessions.find((session) => session.sessionId === activeSessionId) ??
    sessions[0] ??
    null

  function selectTab(nextTab) {
    if (!isValidTab(nextTab)) return
    setTab(nextTab)
    persistTab(nextTab)
  }

  useEffect(() => {
    persistTab(tab)
  }, [tab])

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace(/^#/, '').trim()
      if (isValidTab(hash)) {
        setTab(hash)
        try {
          localStorage.setItem(TAB_STORAGE_KEY, hash)
        } catch {
          // ignore
        }
      }
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  const latestTrace = traces[0] ?? null
  const selectedTrace =
    traces.find((trace) => trace.traceId === selectedTraceId) ?? latestTrace
  const selectedPipeline =
    pipelineRuns.find((run) => run.pipelineId === selectedPipelineId) ??
    pipelineRuns[0] ??
    null

  async function refreshAll() {
    setError('')
    try {
      if (client.useRelayProxy) {
        const snap = await client.getSnapshot()
        setStatus(snap.status ?? null)
        setSessions(snap.sessions ?? [])
        setContext(snap.context ?? null)
        setJobs(snap.jobs ?? [])
        setPipelineRuns(snap.pipeline ?? [])
        setTraces(snap.traces ?? [])
        setLogs(snap.logs ?? [])
        if (!activeSessionId && snap.sessions?.[0]) {
          setActiveSessionId(snap.sessions[0].sessionId)
        }
        if (
          snap.traces?.[0] &&
          (!selectedTraceId ||
            !snap.traces.some((trace) => trace.traceId === selectedTraceId))
        ) {
          setSelectedTraceId(snap.traces[0].traceId)
        }
        if (
          snap.pipeline?.[0] &&
          (!selectedPipelineId ||
            !snap.pipeline.some(
              (run) => run.pipelineId === selectedPipelineId,
            ))
        ) {
          setSelectedPipelineId(snap.pipeline[0].pipelineId)
        }
        return
      }

      const [
        nextStatus,
        sessionsPayload,
        contextPayload,
        jobsPayload,
        pipelinePayload,
        thinkingPayload,
        logsPayload,
      ] = await Promise.all([
        client.getStatus(),
        client.getSessions(),
        client.getContext(),
        client.getJobs(),
        client.getPipeline(),
        client.getThinking(),
        client.getLogs(),
      ])
      setStatus(nextStatus)
      setSessions(sessionsPayload.sessions ?? [])
      setContext(contextPayload)
      setJobs(jobsPayload.jobs ?? [])
      setPipelineRuns(pipelinePayload.runs ?? [])
      setTraces(thinkingPayload.traces ?? [])
      setLogs(logsPayload.logs ?? [])
      if (!activeSessionId && sessionsPayload.sessions?.[0]) {
        setActiveSessionId(sessionsPayload.sessions[0].sessionId)
      }
      if (
        thinkingPayload.traces?.[0] &&
        (!selectedTraceId ||
          !thinkingPayload.traces.some((trace) => trace.traceId === selectedTraceId))
      ) {
        setSelectedTraceId(thinkingPayload.traces[0].traceId)
      }
      if (
        pipelinePayload.runs?.[0] &&
        (!selectedPipelineId ||
          !pipelinePayload.runs.some(
            (run) => run.pipelineId === selectedPipelineId,
          ))
      ) {
        setSelectedPipelineId(pipelinePayload.runs[0].pipelineId)
      }
    } catch (err) {
      setError(friendlyError(err.message))
    }
  }

  useEffect(() => {
    const initial = window.setTimeout(refreshAll, 0)
    const intervalMs = client.useRelayProxy ? 10_000 : 4_000
    const timer = setInterval(refreshAll, intervalMs)
    return () => {
      window.clearTimeout(initial)
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  useEffect(() => {
    let closed = false
    let reconnectTimer = null
    let stream = null

    const connect = () => {
      if (closed) return
      stream = client.openThinkingStream({
        onMessage: (payload) => {
          const nextTraces = payload.traces ?? []
          setTraces(nextTraces)
          const latest = nextTraces[0]
          if (latest?.status === 'thinking') {
            setTab((current) => {
              if (current !== 'home') return current
              persistTab('thinking')
              return 'thinking'
            })
            setSelectedTraceId(latest.traceId)
          } else if (
            latest &&
            (!selectedTraceId ||
              !nextTraces.some((trace) => trace.traceId === selectedTraceId))
          ) {
            setSelectedTraceId(latest.traceId)
          }
        },
        onError: () => {
          if (closed) return
          reconnectTimer = window.setTimeout(connect, 1500)
        },
      })
    }

    connect()

    return () => {
      closed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      stream?.close?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  useEffect(() => {
    let closed = false
    let reconnectTimer = null
    let stream = null

    const connect = () => {
      if (closed) return
      stream = client.openPipelineStream({
        onMessage: (payload) => {
          const nextRuns = payload.runs ?? []
          setPipelineRuns(nextRuns)
          const latest = nextRuns[0]
          if (
            latest &&
            (!selectedPipelineId ||
              !nextRuns.some(
                (run) => run.pipelineId === selectedPipelineId,
              ))
          ) {
            setSelectedPipelineId(latest.pipelineId)
          }
        },
        onError: () => {
          if (closed) return
          reconnectTimer = window.setTimeout(connect, 1500)
        },
      })
    }

    connect()

    return () => {
      closed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      stream?.close?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  useEffect(() => {
    const timer = window.setTimeout(
      () => setRenameDraft(activeSession?.title ?? ''),
      0,
    )
    return () => window.clearTimeout(timer)
  }, [activeSession?.sessionId, activeSession?.title])

  function handleSaveSettings(event) {
    event.preventDefault()
    saveOpsSettings(settings)
    setShowAdvanced(false)
    refreshAll()
  }

  async function cancelMatchingJob(trace) {
    const match =
      jobs.find(
        (job) =>
          job.status === 'processing' &&
          job.command === trace?.command,
      ) || jobs.find((job) => job.status === 'processing')

    if (!match) {
      setError('No in-progress job found to cancel.')
      return
    }

    try {
      await client.cancelJob(match.jobId)
      setError('')
      refreshAll()
    } catch (err) {
      setError(friendlyError(err.message))
    }
  }

  const homeReady = Boolean(status?.ok)
  const bridgeOnline = Boolean(status?.relay?.payload?.macBridgeOnline)
  const relayReachable = Boolean(status?.relay?.reachable)
  const browserOnline = Boolean(status?.browser?.online)

  const headline = !homeReady
    ? 'Home is not connected'
    : bridgeOnline
      ? 'Home is ready'
      : 'Mac is on · remote resting'

  return (
    <div className="app">
      <div className="app-wash" aria-hidden="true" />

      <div className="app-frame">
        <header className="top">
          <div className="brand">
            <p className="eyebrow">Pendant</p>
            <h1>{headline}</h1>
          </div>
          <p className="status-line" aria-label="Status">
            <StatusDot on={homeReady} label="Mac" />
            <StatusDot on={relayReachable} label="Cloud" />
            <StatusDot on={bridgeOnline} label="Remote" />
            <StatusDot on={browserOnline} label="Browser" />
          </p>
        </header>

        <nav className="tabs" aria-label="Sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? 'tab is-on' : 'tab'}
              onClick={() => selectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {error ? <p className="alert">{error}</p> : null}

        <main className="stage">
          {tab === 'home' ? (
            <HomeView
              latestTrace={latestTrace}
              memory={status?.memory ?? {}}
              machine={status?.machine}
              workingProject={status?.workingProject || context?.workingProject}
              onOpenThinking={() => selectTab('thinking')}
              onCancelThinking={
                latestTrace?.status === 'thinking'
                  ? () => cancelMatchingJob(latestTrace)
                  : null
              }
            />
          ) : null}

          {tab === 'pipeline' ? (
            <PipelineView
              client={client}
              runs={pipelineRuns}
              selected={selectedPipeline}
              onSelect={setSelectedPipelineId}
              onOpenThinking={(traceId) => {
                if (traceId) setSelectedTraceId(traceId)
                selectTab('thinking')
              }}
              onClear={async () => {
                if (!window.confirm('Clear the saved pipeline traces?')) return
                await client.clearPipeline()
                setPipelineRuns([])
                setSelectedPipelineId(null)
              }}
            />
          ) : null}

          {tab === 'thinking' ? (
            <ThinkingView
              traces={traces}
              selected={selectedTrace}
              onSelect={setSelectedTraceId}
              onCancelThinking={
                selectedTrace?.status === 'thinking'
                  ? () => cancelMatchingJob(selectedTrace)
                  : null
              }
            />
          ) : null}

          {tab === 'chats' ? (
            <ChatsView
              sessions={sessions}
              activeSession={activeSession}
              renameDraft={renameDraft}
              setRenameDraft={setRenameDraft}
              onSelect={setActiveSessionId}
              onCreate={async () => {
                const payload = await client.createSession('New chat')
                setSessions((current) => [payload.session, ...current])
                setActiveSessionId(payload.session.sessionId)
              }}
              onRename={async () => {
                if (!activeSession) return
                const payload = await client.renameSession(
                  activeSession.sessionId,
                  renameDraft,
                )
                setSessions((current) =>
                  current.map((session) =>
                    session.sessionId === payload.session.sessionId
                      ? payload.session
                      : session,
                  ),
                )
              }}
              onClear={async () => {
                if (!activeSession) return
                if (!window.confirm('Clear all messages in this chat?')) return
                const payload = await client.clearSession(activeSession.sessionId)
                setSessions((current) =>
                  current.map((session) =>
                    session.sessionId === payload.session.sessionId
                      ? payload.session
                      : session,
                  ),
                )
              }}
              onDelete={async () => {
                if (!activeSession) return
                if (!window.confirm(`Delete “${activeSession.title}”?`)) return
                await client.deleteSession(activeSession.sessionId)
                setSessions((current) =>
                  current.filter(
                    (session) => session.sessionId !== activeSession.sessionId,
                  ),
                )
                setActiveSessionId(null)
              }}
            />
          ) : null}

          {tab === 'memory' ? (
            <MemoryView
              context={context}
              status={status}
              entityDraft={entityDraft}
              setEntityDraft={setEntityDraft}
              onAdd={async (event) => {
                event.preventDefault()
                await client.upsertEntity({
                  type: entityDraft.type,
                  name: entityDraft.name,
                  attributes: entityDraft.note.trim()
                    ? { note: entityDraft.note.trim(), importance: 0.8 }
                    : { importance: 0.8 },
                })
                setEntityDraft((current) => ({ ...current, name: '', note: '' }))
                refreshAll()
              }}
              onDeleteEntity={async (entityId) => {
                if (!window.confirm('Forget this item?')) return
                await client.deleteEntity(entityId)
                refreshAll()
              }}
              onSaveProject={async (summary) => {
                await client.updateActiveProject({ summary })
                refreshAll()
              }}
              onReset={async () => {
                if (!window.confirm('Clear everything remembered?')) return
                await client.resetContext()
                refreshAll()
              }}
            />
          ) : null}

          {tab === 'work' ? (
            <section className="stack">
              <div className="section-label row-between">
                <span>Work</span>
                <button
                  type="button"
                  className="text-btn"
                  onClick={async () => {
                    try {
                      const payload = await client.undoLastJob()
                      setError('')
                      await refreshAll()
                      window.alert(payload.undo?.summary || 'Undone.')
                    } catch (err) {
                      setError(friendlyError(err.message))
                    }
                  }}
                >
                  Undo last
                </button>
              </div>
              <ListView
                empty="No requests yet."
                items={jobs.map((job) => ({
                  id: job.jobId,
                  title: job.command || 'Request',
                  meta: `${statusLabel(job.status)}${job.undoneAt ? ' · Undone' : ''} · ${formatWhen(job.updatedAt || job.createdAt)}`,
                  body: job.result?.response || job.result?.summary || job.error || '',
                  tone: job.undoneAt ? 'busy' : simpleStatus(job.status),
                  actions: [
                    job.status === 'processing' || job.cancellable
                      ? {
                          label: 'Cancel',
                          onClick: async () => {
                            try {
                              await client.cancelJob(job.jobId)
                              setError('')
                              refreshAll()
                            } catch (err) {
                              setError(friendlyError(err.message))
                            }
                          },
                        }
                      : null,
                    job.undo?.canUndo
                      ? {
                          label: 'Undo',
                          onClick: async () => {
                            try {
                              const payload = await client.undoJob(job.jobId)
                              setError('')
                              await refreshAll()
                              window.alert(payload.undo?.summary || 'Undone.')
                            } catch (err) {
                              setError(friendlyError(err.message))
                            }
                          },
                        }
                      : null,
                  ].filter(Boolean),
                }))}
              />
            </section>
          ) : null}

          {tab === 'history' ? (
            <ListView
              title="History"
              empty="No finished actions yet."
              items={logs
                .slice()
                .sort(
                  (a, b) =>
                    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
                )
                .map((entry) => ({
                  id: entry.id,
                  title: entry.command || 'Action',
                  meta: `${statusLabel(entry.status)} · ${formatWhen(entry.createdAt)}`,
                  body: entry.error || '',
                  tone: simpleStatus(entry.status),
                }))}
            />
          ) : null}
        </main>

        <footer className="foot">
          <button
            type="button"
            className="linkish"
            onClick={() => setShowAdvanced((current) => !current)}
          >
            {showAdvanced ? 'Hide connection settings' : 'Connection settings'}
          </button>
          {showAdvanced ? (
            <form className="settings" onSubmit={handleSaveSettings}>
              <label>
                Mac address
                <input
                  value={settings.agentUrl}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      agentUrl: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={settings.agentToken}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      agentToken: event.target.value,
                    }))
                  }
                />
              </label>
              <button type="submit">Save</button>
            </form>
          ) : null}
        </footer>
      </div>
    </div>
  )
}

function StatusDot({ on, label }) {
  return (
    <span className={on ? 'dot is-on' : 'dot'}>
      <i />
      {label}
    </span>
  )
}

function HomeView({
  latestTrace,
  memory,
  machine,
  workingProject,
  onOpenThinking,
  onCancelThinking,
}) {
  const remembered = [
    memory.latestPerson?.name && `Person · ${memory.latestPerson.name}`,
    memory.latestEmailDraft?.name && `Email · ${memory.latestEmailDraft.name}`,
    memory.latestFile?.name && `File · ${memory.latestFile.name}`,
    memory.latestTask?.name && `Task · ${memory.latestTask.name}`,
  ].filter(Boolean)

  return (
    <section className="home-view">
      {latestTrace ? (
        <>
          <div className="section-label">
            <span>Latest thinking</span>
            <button type="button" className="linkish" onClick={onOpenThinking}>
              All flows
            </button>
          </div>
          <ThinkingFlow trace={latestTrace} onCancel={onCancelThinking} />
        </>
      ) : (
        <p className="quiet-lead">
          When you give the pendant a command, the thinking steps will appear here.
        </p>
      )}

      <div className="meta-strip">
        <div>
          <p className="meta-label">Remembering</p>
          <p className="meta-value">
            {remembered.length ? remembered.join('  ·  ') : 'Nothing yet'}
          </p>
        </div>
        <div>
          <p className="meta-label">Working project</p>
          <p className="meta-value">
            {workingProject
              ? `${workingProject.name}${
                  workingProject.summary
                    ? ` · ${String(workingProject.summary).slice(0, 80)}`
                    : ''
                }`
              : 'None set'}
          </p>
        </div>
        <div>
          <p className="meta-label">This Mac</p>
          <p className="meta-value">
            {machine
              ? `${shortHost(machine.hostname)} · ${machine.appCount} apps`
              : 'Unavailable'}
          </p>
        </div>
      </div>
    </section>
  )
}

const PIPELINE_STAGES = [
  { id: 'transcription', label: 'Speech → text' },
  { id: 'agent', label: 'Agent + LLM' },
  { id: 'tts', label: 'Text → speech' },
  { id: 'relay_result', label: 'Cloud handoff' },
  { id: 'reply_downloaded', label: 'nRF download' },
  { id: 'device_playback', label: 'I²S playback' },
]

function PipelineView({
  client,
  runs,
  selected,
  onSelect,
  onOpenThinking,
  onClear,
}) {
  return (
    <section className="split-view">
      <aside className="split-rail">
        <div className="section-label row-between pipeline-rail-head">
          <span>Voice runs</span>
          {runs.length ? (
            <button type="button" className="text-btn" onClick={onClear}>
              Clear
            </button>
          ) : null}
        </div>
        <div className="rail-scroll">
          {runs.length ? (
            runs.map((run) => (
              <button
                key={run.pipelineId}
                type="button"
                className={
                  run.pipelineId === selected?.pipelineId
                    ? 'rail-item is-on'
                    : 'rail-item'
                }
                onClick={() => onSelect(run.pipelineId)}
              >
                <strong>{truncate(run.command || 'Voice request', 42)}</strong>
                <span>
                  {statusLabel(run.status)} · {formatWhen(run.updatedAt)}
                </span>
              </button>
            ))
          ) : (
            <p className="quiet-lead">
              No pendant voice request has reached this Mac yet.
            </p>
          )}
        </div>
      </aside>

      <div className="split-main">
        {selected ? (
          <PipelineFlow
            client={client}
            run={selected}
            onOpenThinking={onOpenThinking}
          />
        ) : (
          <div className="pipeline-empty">
            <p className="eyebrow">Live voice pipeline</p>
            <h2>Waiting for the pendant</h2>
            <p className="quiet-lead">
              Record and submit a voice request. Each observed handoff will
              appear here as it happens.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

function PipelineFlow({ client, run, onOpenThinking }) {
  const events = Array.isArray(run.events) ? run.events : []
  const totalMs = elapsedBetween(run.createdAt, run.updatedAt)
  const inputTelemetry =
    events.find((event) => event.stage === 'transcription')?.meta
      ?.inputTelemetry ?? null

  return (
    <article
      className={`pipeline-flow ${
        run.status === 'processing' ? 'is-live' : ''
      }`}
    >
      <header className="flow-head">
        <p className="eyebrow">
          {run.status === 'processing' ? 'Live pipeline' : 'Pipeline trace'}
        </p>
        <h2>{run.command || 'Voice request'}</h2>
        <p className={`pill is-${simpleStatus(run.status)}`}>
          {statusLabel(run.status)}
          {totalMs ? ` · ${formatDuration(totalMs)}` : ''}
          {run.status === 'processing' ? ' · updating live' : ''}
        </p>
      </header>

      <div className="pipeline-stage-map" aria-label="Voice processing stages">
        {PIPELINE_STAGES.map((stage) => {
          const state = pipelineStageState(events, stage.id)
          return (
            <div
              key={stage.id}
              className={`pipeline-stage is-${state}`}
              title={stage.label}
            >
              <span className="pipeline-stage-dot" />
              <strong>{stage.label}</strong>
            </div>
          )
        })}
      </div>

      <div className="pipeline-input-card">
        <p className="meta-label">Recorded audio input</p>
        {inputTelemetry ? (
          <MetaGrid meta={inputTelemetry} />
        ) : (
          <p>
            Transcript observed. Raw mic bytes and waveform were not forwarded
            by the currently deployed relay/firmware build.
          </p>
        )}
      </div>

      <ol className="pipeline-events">
        {events.map((event, index) => (
          <PipelineEvent
            key={event.eventId || `${event.stage}-${event.at}-${index}`}
            event={event}
            index={index}
            client={client}
            pipelineId={run.pipelineId}
            live={
              event.status === 'active' &&
              !events
                .slice(index + 1)
                .some(
                  (later) =>
                    later.stage === event.stage &&
                    later.status !== 'active',
                )
            }
            onOpenThinking={onOpenThinking}
          />
        ))}
      </ol>

      <p className="pipeline-note">
        “Thinking” shows streamed model-visible output and tool decisions. It
        does not expose private hidden chain-of-thought.
      </p>
    </article>
  )
}

function PipelineEvent({
  client,
  pipelineId,
  event,
  index,
  live,
  onOpenThinking,
}) {
  const traceId = event.meta?.thinkingTraceId
  const meta = event.meta && typeof event.meta === 'object' ? event.meta : null
  const displayStatus =
    event.status === 'active' && !live ? 'started' : event.status

  return (
    <li className={`pipeline-event is-${displayStatus || 'done'}`}>
      <span className="pipeline-event-index">
        {live ? '' : index + 1}
      </span>
      <div className="pipeline-event-body">
        <div className="pipeline-event-head">
          <div>
            <p className="meta-label">
              {pipelineStageLabel(event.stage)} · {formatClock(event.at)}
            </p>
            <strong>
              {event.label || pipelineStageLabel(event.stage)}
              {live ? (
                <span className="live-dot" aria-hidden="true" />
              ) : null}
            </strong>
          </div>
          <span className={`pill is-${simpleStatus(displayStatus)}`}>
            {statusLabel(displayStatus)}
          </span>
        </div>
        {event.detail ? <p>{event.detail}</p> : null}
        {event.text ? (
          <div className="pipeline-text">
            <p className="meta-label">
              {event.stage === 'transcription'
                ? 'Transcript'
                : event.stage === 'tts'
                  ? 'Spoken text'
                  : 'Agent response'}
            </p>
            <ReadableText text={event.text} />
          </div>
        ) : null}
        {meta ? <MetaGrid meta={meta} /> : null}
        {event.stage === 'tts' &&
        event.status === 'done' &&
        meta?.previewAvailable ? (
          <PipelineAudioPreview client={client} pipelineId={pipelineId} />
        ) : null}
        {traceId ? (
          <button
            type="button"
            className="text-btn pipeline-thinking-link"
            onClick={() => onOpenThinking(traceId)}
          >
            Open streamed model trace
          </button>
        ) : null}
      </div>
    </li>
  )
}

function PipelineAudioPreview({ client, pipelineId }) {
  const [audioUrl, setAudioUrl] = useState('')
  const [audioError, setAudioError] = useState('')

  useEffect(() => {
    let disposed = false
    let objectUrl = ''

    client
      .getPipelineAudio(pipelineId, 'output')
      .then((blob) => {
        if (disposed) return
        objectUrl = URL.createObjectURL(blob)
        setAudioUrl(objectUrl)
        setAudioError('')
      })
      .catch((error) => {
        if (disposed) return
        setAudioError(error.message)
      })

    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [client, pipelineId])

  return (
    <div className="pipeline-audio">
      <p className="meta-label">Exact outgoing TTS waveform</p>
      {audioUrl ? (
        <audio controls preload="metadata" src={audioUrl}>
          Your browser does not support audio playback.
        </audio>
      ) : (
        <p>{audioError || 'Loading audio preview…'}</p>
      )}
    </div>
  )
}

function MetaGrid({ meta }) {
  const entries = Object.entries(meta || {}).filter(
    ([, value]) =>
      value !== null &&
      value !== undefined &&
      value !== '' &&
      typeof value !== 'object',
  )
  if (!entries.length) return null

  return (
    <dl className="pipeline-meta">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{humanizeKey(key)}</dt>
          <dd>{formatMetaValue(key, value)}</dd>
        </div>
      ))}
    </dl>
  )
}

function ThinkingView({ traces, selected, onSelect, onCancelThinking }) {
  return (
    <section className="split-view">
      <aside className="split-rail">
        <div className="rail-scroll">
          {traces.length ? (
            traces.map((trace) => (
              <button
                key={trace.traceId}
                type="button"
                className={
                  trace.traceId === selected?.traceId
                    ? 'rail-item is-on'
                    : 'rail-item'
                }
                onClick={() => onSelect(trace.traceId)}
              >
                <strong>{truncate(trace.command || 'Request', 42)}</strong>
                <span>
                  {statusLabel(trace.status)} · {formatWhen(trace.updatedAt)}
                </span>
              </button>
            ))
          ) : (
            <p className="quiet-lead">No thinking yet.</p>
          )}
        </div>
      </aside>
      <div className="split-main">
        {selected ? (
          <ThinkingFlow trace={selected} onCancel={onCancelThinking} />
        ) : (
          <p className="quiet-lead">Pick a request.</p>
        )}
      </div>
    </section>
  )
}

function ThinkingFlow({ trace, onCancel }) {
  const summary = friendlySummary(trace.summary || '')
  const steps = trace.steps ?? []
  const isLive = trace.status === 'thinking'

  return (
    <article className={`flow ${isLive ? 'is-live' : ''}`}>
      <header className="flow-head">
        <p className="eyebrow">
          {isLive
            ? 'Live thinking'
            : trace.kind === 'execute'
              ? 'Doing the work'
              : 'Understanding'}
        </p>
        <h2>{trace.command || 'Request'}</h2>
        <p className={`pill is-${simpleStatus(trace.status)}`}>
          {statusLabel(trace.status)}
          {isLive ? ' · streaming' : ''}
        </p>
        {isLive && onCancel ? (
          <button type="button" className="text-btn" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </header>

      <ol className="steps">
        {steps.map((step, index) => (
          <StepRow key={`${step.id}-${index}`} step={step} index={index} />
        ))}
      </ol>

      {summary ? (
        <div className="flow-result">
          <p className="meta-label">Result</p>
          <ReadableText text={summary} />
        </div>
      ) : null}
    </article>
  )
}

function StepRow({ step, index }) {
  const chunks = Array.isArray(step.chunks) ? step.chunks : []
  const streamText = String(step.streamText || '').trim()
  const isActive = step.status === 'active'

  return (
    <li className={`step is-${step.status || 'done'}`}>
      <span className="step-mark">{isActive ? '' : index + 1}</span>
      <div className="step-body">
        <strong>
          {step.label}
          {isActive ? <span className="live-dot" aria-hidden="true" /> : null}
        </strong>
        {step.detail ? (
          isActive ? (
            <p className="step-detail">{friendlySummary(step.detail)}</p>
          ) : (
            <ReadableText text={step.detail} />
          )
        ) : null}

        {chunks.length ? <ChunkStream chunks={chunks} live={isActive} /> : null}

        {streamText ? (
          <StreamDraft text={streamText} live={isActive} />
        ) : null}
      </div>
    </li>
  )
}

function ChunkStream({ chunks, live }) {
  const visible = chunks.slice(-40)

  return (
    <div className={`chunk-stream ${live ? 'is-live' : ''}`}>
      <p className="meta-label">
        Stream chunks{live ? ' · live' : ''} · {chunks.length}
      </p>
      <ul className="chunk-list">
        {visible.map((chunk) => (
          <li key={chunk.id || `${chunk.phase}-${chunk.at}-${chunk.text}`}>
            <span className="chunk-phase">{chunk.phase || 'stream'}</span>
            <code>{chunk.text}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StreamDraft({ text, live }) {
  const [open, setOpen] = useState(live)
  const pretty = text
  const preview = pretty.length > 420 ? `${pretty.slice(-420)}` : pretty

  return (
    <div className={`stream-draft ${live ? 'is-live' : ''}`}>
      <div className="stream-draft-head">
        <p className="meta-label">
          {live ? 'Raw draft (streaming)' : 'Raw draft'} · {pretty.length} chars
        </p>
        {!live ? (
          <button type="button" className="linkish" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show'}
          </button>
        ) : null}
      </div>
      {open || live ? (
        <pre className="stream-draft-body">{live ? pretty : open ? pretty : preview}</pre>
      ) : null}
    </div>
  )
}

function ReadableText({ text }) {
  const [open, setOpen] = useState(false)
  const pretty = friendlySummary(text)
  const isLong = pretty.length > 220 || pretty.includes('\n')

  if (!pretty) return null

  if (!isLong) {
    return <p className="step-detail">{pretty}</p>
  }

  return (
    <div className="step-detail-wrap">
      <p className="step-detail">{open ? pretty : `${pretty.slice(0, 220).trim()}…`}</p>
      <button type="button" className="linkish" onClick={() => setOpen((v) => !v)}>
        {open ? 'Show less' : 'Show more'}
      </button>
    </div>
  )
}

function ChatsView({
  sessions,
  activeSession,
  renameDraft,
  setRenameDraft,
  onSelect,
  onCreate,
  onRename,
  onClear,
  onDelete,
}) {
  return (
    <section className="split-view">
      <aside className="split-rail">
        <button type="button" className="rail-action" onClick={onCreate}>
          New chat
        </button>
        <div className="rail-scroll">
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              className={
                session.sessionId === activeSession?.sessionId
                  ? 'rail-item is-on'
                  : 'rail-item'
              }
              onClick={() => onSelect(session.sessionId)}
            >
              <strong>{session.title}</strong>
              <span>
                {session.turns?.length ?? 0} messages · {formatWhen(session.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="split-main">
        {activeSession ? (
          <>
            <header className="chat-head">
              <h2>{activeSession.title}</h2>
              <div className="chat-actions">
                <button type="button" className="ghost-btn" onClick={onClear}>
                  Clear
                </button>
                <button type="button" className="danger-btn" onClick={onDelete}>
                  Delete
                </button>
              </div>
            </header>

            <div className="rename-row">
              <input
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                placeholder="Rename chat"
                aria-label="Rename chat"
              />
              <button type="button" onClick={onRename}>
                Save name
              </button>
            </div>

            <div className="messages">
              {(activeSession.turns ?? [])
                .slice()
                .reverse()
                .map((turn) => (
                  <article
                    key={turn.id ?? `${turn.createdAt}-${turn.role}`}
                    className="message"
                  >
                    <p className="meta-label">
                      {turn.role === 'user' ? 'You' : 'Pendant'} ·{' '}
                      {formatWhen(turn.createdAt)}
                    </p>
                    <p>{turn.content}</p>
                  </article>
                ))}
            </div>
          </>
        ) : (
          <p className="quiet-lead">Select a chat.</p>
        )}
      </div>
    </section>
  )
}

function MemoryView({
  context,
  status,
  entityDraft,
  setEntityDraft,
  onAdd,
  onDeleteEntity,
  onSaveProject,
  onReset,
}) {
  const [projectSummary, setProjectSummary] = useState('')
  const workingProject =
    context?.workingProject || status?.workingProject || null
  const longTermEntities =
    context?.longTerm ||
    (context?.graph?.entities ?? []).filter(
      (entity) => !['Action', 'Tool', 'Device', 'Model'].includes(entity.type),
    )

  useEffect(() => {
    const timer = window.setTimeout(
      () => setProjectSummary(workingProject?.summary || ''),
      0,
    )
    return () => window.clearTimeout(timer)
  }, [workingProject?.id, workingProject?.summary])

  return (
    <section className="stack">
      <div className="section-label">
        <span>Working project</span>
      </div>
      {workingProject ? (
        <div className="project-card">
          <p className="meta-label">Active</p>
          <strong>{workingProject.name}</strong>
          {workingProject.path ? (
            <p className="meta-label">{workingProject.path}</p>
          ) : null}
          <textarea
            className="project-summary"
            rows={3}
            value={projectSummary}
            onChange={(event) => setProjectSummary(event.target.value)}
            placeholder="Working summary"
            aria-label="Working project summary"
          />
          <div className="inline-tools">
            <button
              type="button"
              onClick={() => onSaveProject?.(projectSummary.trim())}
            >
              Save summary
            </button>
          </div>
          {(workingProject.openThreads || []).length ? (
            <ul className="plain-list compact">
              {(workingProject.openThreads || []).slice(0, 5).map((thread) => (
                <li key={thread.id}>
                  <div>
                    <strong>{thread.title}</strong>
                    <p className="meta-label">
                      {thread.status}
                      {thread.lastNote ? ` · ${thread.lastNote}` : ''}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {(workingProject.people || []).length ? (
            <p className="meta-value">
              People · {(workingProject.people || []).join(', ')}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="quiet-lead">No active project yet.</p>
      )}

      <div className="section-label">
        <span>Long-term memory</span>
        <button type="button" className="linkish" onClick={onReset}>
          Clear all
        </button>
      </div>

      <form className="inline-tools" onSubmit={onAdd}>
        <select
          value={entityDraft.type}
          onChange={(event) =>
            setEntityDraft((current) => ({ ...current, type: event.target.value }))
          }
        >
          {MEMORY_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
        <input
          required
          placeholder="Name"
          value={entityDraft.name}
          onChange={(event) =>
            setEntityDraft((current) => ({ ...current, name: event.target.value }))
          }
        />
        <input
          placeholder="Note"
          value={entityDraft.note}
          onChange={(event) =>
            setEntityDraft((current) => ({ ...current, note: event.target.value }))
          }
        />
        <button type="submit">Add</button>
      </form>

      <ul className="plain-list">
        {longTermEntities.length ? (
          longTermEntities
            .slice()
            .reverse()
            .map((entity) => (
              <li key={entity.id}>
                <div>
                  <p className="meta-label">{typeLabel(entity.type)}</p>
                  <strong>{entity.name}</strong>
                  {entity.attributes?.note ? <p>{entity.attributes.note}</p> : null}
                </div>
                <button
                  type="button"
                  className="linkish"
                  onClick={() => onDeleteEntity(entity.id)}
                >
                  Forget
                </button>
              </li>
            ))
        ) : (
          <li className="quiet-lead">Nothing remembered yet.</li>
        )}
      </ul>
    </section>
  )
}

function ListView({ title, empty, items }) {
  return (
    <section className="stack">
      {title ? (
        <div className="section-label">
          <span>{title}</span>
        </div>
      ) : null}
      <ul className="plain-list">
        {items.length ? (
          items.map((item) => (
            <li key={item.id} className={`tone-${item.tone || 'busy'}`}>
              <div className="list-row">
                <div>
                  <strong>{item.title}</strong>
                  <p className="meta-label">{item.meta}</p>
                  {item.body ? <ReadableText text={String(item.body)} /> : null}
                </div>
                {item.actions?.length ? (
                  <div className="list-actions">
                    {item.actions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        className="text-btn"
                        onClick={action.onClick}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          ))
        ) : (
          <li className="quiet-lead">{empty}</li>
        )}
      </ul>
    </section>
  )
}

function typeLabel(type) {
  return MEMORY_TYPES.find((item) => item.value === type)?.label || type
}

function statusLabel(status) {
  switch (status) {
    case 'thinking':
    case 'processing':
    case 'queued':
    case 'active':
      return 'In progress'
    case 'waiting':
      return 'Waiting'
    case 'started':
      return 'Started'
    case 'plan_ready':
      return 'Waiting'
    case 'completed':
    case 'success':
    case 'done':
      return 'Done'
    case 'cancelled':
      return 'Cancelled'
    case 'failed':
    case 'blocked':
      return 'Failed'
    default:
      return status || 'Unknown'
  }
}

function simpleStatus(status) {
  if (
    status === 'completed' ||
    status === 'success' ||
    status === 'plan_ready' ||
    status === 'done'
  ) {
    return 'ok'
  }
  if (status === 'failed' || status === 'blocked') return 'bad'
  if (status === 'cancelled') return 'busy'
  return 'busy'
}

function friendlyError(message = '') {
  if (/invalid or missing agent token|401/i.test(message)) {
    return 'Password does not match. Open connection settings below.'
  }
  if (/Failed to fetch|NetworkError|fetch/i.test(message)) {
    return 'Could not reach this Mac.'
  }
  if (/Mac bridge is offline|bridge is offline/i.test(message)) {
    return 'Home Mac bridge is offline. On the Mac run: npm run agent && npm run bridge'
  }
  if (/Unexpected token|<!DOCTYPE|non-JSON|HTML page instead/i.test(message)) {
    return 'Dashboard was pointing at the website instead of the home Mac relay. Refresh once — it should reconnect.'
  }
  if (/Timed out|504|502/i.test(message)) {
    return 'Home Mac is slow or busy. Keep agent + bridge running, then refresh.'
  }
  return message
}

function friendlySummary(text = '') {
  const raw = String(text).trim()
  if (!raw) return ''

  // Disk usage (df -h) → short human line
  if (/Filesystem\s+Size\s+Used\s+Avail/i.test(raw) || /\/dev\/disk/.test(raw)) {
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean)
    const dataLine =
      lines.find((line) => /\/System\/Volumes\/Data\b/.test(line)) ||
      lines.find((line) => /\s\/$/.test(line)) ||
      lines.find((line) => /\/dev\//.test(line))

    if (dataLine) {
      const parts = dataLine.split(/\s+/)
      // filesystem size used avail capacity mount
      if (parts.length >= 5) {
        const avail = parts[3]
        const capacity = parts[4]
        return `Storage: ${capacity} used · ${avail} free (of ${parts[1]})`
      }
    }
    return 'Checked disk storage on this Mac'
  }

  // Collapse whitespace-heavy shell dumps
  if (raw.length > 220 && (raw.match(/\n/g) || []).length > 3) {
    const first = raw.split('\n').map((line) => line.trim()).find(Boolean)
    return first || raw
  }

  return raw
}

function shortHost(hostname = '') {
  return String(hostname).replace(/\.local$/i, '')
}

function formatWhen(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return String(value)
  }
}

function formatClock(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    }).format(new Date(value))
  } catch {
    return String(value)
  }
}

function elapsedBetween(start, end) {
  const startMs = Date.parse(start || '')
  const endMs = Date.parse(end || '')
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0
  return Math.max(0, endMs - startMs)
}

function formatDuration(value) {
  const milliseconds = Number(value || 0)
  if (milliseconds < 1000) return `${milliseconds} ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`
  return `${(milliseconds / 60_000).toFixed(1)} min`
}

function pipelineStageState(events, stageId) {
  const matching = events.filter((event) => event.stage === stageId)
  if (!matching.length) return 'pending'
  const latest = matching[matching.length - 1]
  if (latest.status === 'failed') return 'failed'
  if (latest.status === 'active' || latest.status === 'waiting') {
    return 'active'
  }
  return 'done'
}

function pipelineStageLabel(stage) {
  return (
    PIPELINE_STAGES.find((item) => item.id === stage)?.label ||
    String(stage || 'event').replaceAll('_', ' ')
  )
}

function humanizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function formatMetaValue(key, value) {
  if (/bytes$/i.test(key) && Number.isFinite(Number(value))) {
    const bytes = Number(value)
    return bytes < 1024
      ? `${bytes} B`
      : `${(bytes / 1024).toFixed(1)} KiB`
  }
  if (/durationms$/i.test(key) && Number.isFinite(Number(value))) {
    return formatDuration(Number(value))
  }
  if (/samplerate$/i.test(key) && Number.isFinite(Number(value))) {
    return `${Number(value).toLocaleString()} Hz`
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}
