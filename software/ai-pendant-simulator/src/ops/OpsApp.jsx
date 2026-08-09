import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PLAYBACK_UNKNOWN_STATUS,
  stageIsReportable,
} from '../../shared/audioDelivery.js'
import {
  createOpsClient,
  loadOpsSettings,
  saveOpsSettings,
} from './api.js'

const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'chats', label: 'Chats' },
  { id: 'memory', label: 'Memory' },
  { id: 'history', label: 'History' },
]

/* The Work tab became Jobs; keep bookmarks and saved state pointing somewhere. */
const TAB_ALIASES = { work: 'jobs' }

const MEMORY_TYPES = [
  { value: 'Person', label: 'Person' },
  { value: 'EmailDraft', label: 'Email' },
  { value: 'Task', label: 'Task' },
  { value: 'File', label: 'File' },
  { value: 'Project', label: 'Project' },
  { value: 'Note', label: 'Note' },
]

const TAB_STORAGE_KEY = 'opsDashboardTab'

function resolveTab(id) {
  const wanted = TAB_ALIASES[id] ?? id
  return TABS.some((tab) => tab.id === wanted) ? wanted : null
}

function loadInitialTab() {
  try {
    const hash = window.location.hash.replace(/^#/, '').trim()
    return (
      resolveTab(hash) ??
      resolveTab(localStorage.getItem(TAB_STORAGE_KEY)) ??
      'home'
    )
  } catch {
    return 'home'
  }
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
  const [routines, setRoutines] = useState([])
  const [pipelineRuns, setPipelineRuns] = useState([])
  const [traces, setTraces] = useState([])
  const [logs, setLogs] = useState([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [entityDraft, setEntityDraft] = useState({
    type: 'Person',
    name: '',
    note: '',
  })
  const [renameDraft, setRenameDraft] = useState('')
  const [selectedTraceId, setSelectedTraceId] = useState(null)
  const [selectedPipelineId, setSelectedPipelineId] = useState(null)
  const [selectedWorkId, setSelectedWorkId] = useState(null)
  const [jobSourceFilter, setJobSourceFilter] = useState('all')

  const client = useMemo(() => createOpsClient(settings), [settings])
  const activeSession =
    sessions.find((session) => session.sessionId === activeSessionId) ??
    sessions[0] ??
    null

  function selectTab(nextTab) {
    const resolved = resolveTab(nextTab)
    if (!resolved) return
    setTab(resolved)
    persistTab(resolved)
  }

  useEffect(() => {
    persistTab(tab)
  }, [tab])

  useEffect(() => {
    const onHashChange = () => {
      const resolved = resolveTab(window.location.hash.replace(/^#/, '').trim())
      if (resolved) {
        setTab(resolved)
        try {
          localStorage.setItem(TAB_STORAGE_KEY, resolved)
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

      /*
       * Settled, not all: one slow or failing route used to throw away every
       * other route's data, which is why Home reported "This Mac ·
       * Unavailable" while /machine-context was answering perfectly well.
       * Each panel now keeps whatever actually arrived.
       */
      const results = await Promise.allSettled([
        client.getStatus(),
        client.getSessions(),
        client.getContext(),
        client.getJobs(),
        client.getPipeline(),
        client.getThinking(),
        client.getLogs(),
        client.getRoutines(),
      ])
      const [
        nextStatus,
        sessionsPayload,
        contextPayload,
        jobsPayload,
        pipelinePayload,
        thinkingPayload,
        logsPayload,
        routinesPayload,
      ] = results.map((entry) =>
        entry.status === 'fulfilled' ? entry.value : null,
      )

      if (nextStatus) setStatus(nextStatus)
      if (sessionsPayload) setSessions(sessionsPayload.sessions ?? [])
      if (contextPayload) setContext(contextPayload)
      if (jobsPayload) setJobs(jobsPayload.jobs ?? [])
      if (pipelinePayload) setPipelineRuns(pipelinePayload.runs ?? [])
      if (thinkingPayload) setTraces(thinkingPayload.traces ?? [])
      if (logsPayload) setLogs(logsPayload.logs ?? [])
      if (routinesPayload) setRoutines(routinesPayload.routines ?? [])
      setLoaded(true)

      if (!activeSessionId && sessionsPayload?.sessions?.[0]) {
        setActiveSessionId(sessionsPayload.sessions[0].sessionId)
      }
      if (
        thinkingPayload?.traces?.[0] &&
        (!selectedTraceId ||
          !thinkingPayload.traces.some((trace) => trace.traceId === selectedTraceId))
      ) {
        setSelectedTraceId(thinkingPayload.traces[0].traceId)
      }
      if (
        pipelinePayload?.runs?.[0] &&
        (!selectedPipelineId ||
          !pipelinePayload.runs.some(
            (run) => run.pipelineId === selectedPipelineId,
          ))
      ) {
        setSelectedPipelineId(pipelinePayload.runs[0].pipelineId)
      }

      const failure = results.find((entry) => entry.status === 'rejected')
      setError(failure ? friendlyError(failure.reason?.message) : '')
    } catch (err) {
      setError(friendlyError(err.message))
    }
  }

  /*
   * The job list has no stream of its own, so the thinking and pipeline
   * streams stand in for one: every step an agent takes pushes an event, and
   * that is exactly when the Jobs view is stale. Coalesced so a burst of token
   * chunks costs one refetch, not fifty.
   */
  const workTimer = useRef(null)
  const refreshWork = useCallback(() => {
    if (workTimer.current) return
    workTimer.current = window.setTimeout(() => {
      workTimer.current = null
      Promise.allSettled([client.getJobs(), client.getRoutines()]).then(
        ([jobsPayload, routinesPayload]) => {
          if (jobsPayload.status === 'fulfilled') {
            setJobs(jobsPayload.value.jobs ?? [])
          }
          if (routinesPayload.status === 'fulfilled') {
            setRoutines(routinesPayload.value.routines ?? [])
          }
        },
      )
    }, 900)
  }, [client])

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
          refreshWork()
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
          refreshWork()
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
              loaded={loaded}
              runningJobs={jobs.filter((job) => isRunningStatus(job.status)).length}
              nextRoutine={nextRoutineDue(routines)}
              onOpenJobs={() => selectTab('jobs')}
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

          {tab === 'jobs' ? (
            <JobsView
              jobs={jobs}
              routines={routines}
              traces={traces}
              loaded={loaded}
              selectedId={selectedWorkId}
              onSelect={setSelectedWorkId}
              sourceFilter={jobSourceFilter}
              onSourceFilter={setJobSourceFilter}
              onOpenThinking={(traceId) => {
                if (traceId) setSelectedTraceId(traceId)
                selectTab('thinking')
              }}
              onCancel={async (jobId) => {
                try {
                  await client.cancelJob(jobId)
                  setError('')
                  refreshAll()
                } catch (err) {
                  setError(friendlyError(err.message))
                }
              }}
              onUndo={async (jobId) => {
                try {
                  const payload = await client.undoJob(jobId)
                  setError('')
                  await refreshAll()
                  window.alert(payload.undo?.summary || 'Undone.')
                } catch (err) {
                  setError(friendlyError(err.message))
                }
              }}
              onRunRoutine={async (routineId) => {
                try {
                  await client.runRoutine(routineId)
                  setError('')
                  refreshAll()
                } catch (err) {
                  setError(friendlyError(err.message))
                }
              }}
            />
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
  loaded,
  runningJobs,
  nextRoutine,
  onOpenJobs,
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

      <div className="home-jobs-strip">
        <div>
          <p className="meta-label">Work right now</p>
          <p className="meta-value">
            {runningJobs
              ? `${runningJobs} job${runningJobs === 1 ? '' : 's'} running`
              : 'Nothing running'}
            {nextRoutine
              ? ` · next scheduled ${formatWhen(nextRoutine.nextRunAt)}`
              : ''}
          </p>
        </div>
        <button type="button" className="text-btn" onClick={onOpenJobs}>
          Open Jobs
        </button>
      </div>

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
              : loaded
                ? 'Unavailable'
                : 'Checking…'}
          </p>
        </div>
      </div>
    </section>
  )
}

/*
 * Who asked for this work. The owner's own pendant commands, work the agent
 * started on its own, and work a schedule fired are indistinguishable in the
 * job list without this — and telling them apart is the whole point of the
 * view.
 */
const JOB_SOURCES = {
  pendant: { label: 'Pendant', hint: 'You asked for this from the pendant' },
  routine: { label: 'Routine', hint: 'Fired on a schedule, not by you' },
  recon: { label: 'Recon', hint: 'The agent started this on its own' },
  'harness-task': { label: 'Harness', hint: 'Automated harness run' },
  'mac-planner': { label: 'Planner', hint: 'Planned on this Mac' },
  measure: { label: 'Measure', hint: 'Benchmark / measurement run' },
  probe: { label: 'Probe', hint: 'Health probe' },
  local: { label: 'Local', hint: 'Sent from this dashboard or local API' },
  'user-test': { label: 'Manual', hint: 'Hand-run test from the owner' },
  test: { label: 'Test', hint: 'Automated test run' },
}

const RUNNING_STATUSES = ['processing', 'queued', 'active', 'thinking', 'running']

/* Values that should never be read off a shared screen. */
const SENSITIVE_KEY = /token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|bearer|private[-_]?key/i

function isRunningStatus(status) {
  return RUNNING_STATUSES.includes(String(status))
}

function sourceMeta(source) {
  const key = String(source || 'unknown')
  return (
    JOB_SOURCES[key] || {
      label: key === 'unknown' ? 'Unknown' : humanizeKey(key),
      hint: 'Origin not recorded',
    }
  )
}

function nextRoutineDue(routines = []) {
  return (
    routines
      .filter((routine) => routine.enabled && routine.nextRunAt)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)[0] || null
  )
}

function describeSchedule(schedule) {
  if (schedule?.kind === 'daily') return `Every day at ${schedule.at || '08:00'}`
  if (schedule?.kind === 'interval') {
    return `Every ${formatDuration(Number(schedule.everyMs) || 0)}`
  }
  return 'No schedule'
}

function redactInline(text) {
  return String(text).replace(
    /\b(bearer|token|secret|password|api[-_]?key)([=:"'\s]+)(\S{6,})/gi,
    (_match, label, separator) => `${label}${separator}•••••••`,
  )
}

/** Params stay visible; only the values that are credentials get hidden. */
function redactParams(params) {
  if (!params || typeof params !== 'object') return []
  return Object.entries(params).map(([key, value]) => {
    if (SENSITIVE_KEY.test(key)) return [key, '••••••• hidden']
    if (value == null) return [key, '—']
    if (typeof value === 'object') {
      return [key, redactInline(JSON.stringify(value))]
    }
    return [key, redactInline(value)]
  })
}

/* What the run actually reached for, read back off the recorded actions. */
function summarizeTouches(entries) {
  const apps = new Set()
  const urls = new Set()
  let shell = 0
  let browser = 0

  for (const entry of entries) {
    const action = entry.action || entry || {}
    const params = action.params || {}
    if (params.appName) apps.add(params.appName)
    if (params.url) urls.add(String(params.url))
    if (action.type === 'run_shell' || action.type === 'run_applescript') shell += 1
    if (String(action.type || '').startsWith('browser_')) browser += 1
  }

  return [
    apps.size ? `Apps · ${[...apps].join(', ')}` : null,
    urls.size ? `Web · ${[...urls].slice(0, 3).join(', ')}` : null,
    shell ? `Shell/AppleScript · ${shell}` : null,
    browser ? `Browser control · ${browser}` : null,
  ].filter(Boolean)
}

function JobsView({
  jobs,
  routines,
  traces,
  loaded,
  selectedId,
  onSelect,
  sourceFilter,
  onSourceFilter,
  onOpenThinking,
  onCancel,
  onUndo,
  onRunRoutine,
}) {
  const sources = useMemo(() => {
    const counts = new Map()
    for (const job of jobs) {
      const key = String(job.source || 'unknown')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [jobs])

  const byRecency = (a, b) =>
    Date.parse(b.updatedAt || b.createdAt || 0) -
    Date.parse(a.updatedAt || a.createdAt || 0)

  const visible =
    sourceFilter === 'all'
      ? jobs
      : jobs.filter((job) => String(job.source || 'unknown') === sourceFilter)
  const running = visible.filter((job) => isRunningStatus(job.status)).sort(byRecency)
  const finished = visible
    .filter((job) => !isRunningStatus(job.status))
    .sort(byRecency)
  /* A source filter filters everything, or the group counts stop adding up. */
  const scheduled =
    sourceFilter === 'all' || sourceFilter === 'routine'
      ? [...routines].sort(
          (a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity),
        )
      : []

  const selectedJob =
    visible.find((job) => `job:${job.jobId}` === selectedId) ?? null
  const selectedRoutine =
    routines.find((routine) => `routine:${routine.id}` === selectedId) ?? null
  const fallbackJob = running[0] ?? finished[0] ?? null
  const job = selectedJob ?? (selectedRoutine ? null : fallbackJob)
  const routine = selectedRoutine

  const traceIdFor = (target) =>
    target?.result?.thinking?.traceId ??
    traces.find(
      (trace) =>
        trace.command === target?.command && trace.source === target?.source,
    )?.traceId ??
    null

  return (
    <section className="split-view">
      <aside className="split-rail">
        <div className="job-filters" role="group" aria-label="Filter by source">
          <button
            type="button"
            className={sourceFilter === 'all' ? 'job-chip is-on' : 'job-chip'}
            onClick={() => onSourceFilter('all')}
          >
            All · {jobs.length}
          </button>
          {sources.map(([key, count]) => (
            <button
              key={key}
              type="button"
              className={sourceFilter === key ? 'job-chip is-on' : 'job-chip'}
              onClick={() => onSourceFilter(key)}
              title={sourceMeta(key).hint}
            >
              {sourceMeta(key).label} · {count}
            </button>
          ))}
        </div>

        <div className="rail-scroll">
          <JobRailGroup label="Running" count={running.length}>
            {running.map((item) => (
              <JobRailItem
                key={item.jobId}
                job={item}
                active={item.jobId === job?.jobId}
                onSelect={() => onSelect(`job:${item.jobId}`)}
              />
            ))}
            {running.length ? null : (
              <p className="rail-empty">Nothing running.</p>
            )}
          </JobRailGroup>

          <JobRailGroup label="Scheduled" count={scheduled.length}>
            {scheduled.map((item) => (
              <button
                key={item.id}
                type="button"
                className={
                  item.id === routine?.id ? 'rail-item is-on' : 'rail-item'
                }
                onClick={() => onSelect(`routine:${item.id}`)}
              >
                <strong>{truncate(item.name || item.command, 40)}</strong>
                <span>
                  <em className="job-source">Routine</em>
                  {item.enabled && item.nextRunAt
                    ? ` · next ${formatWhen(item.nextRunAt)}`
                    : ' · paused'}
                </span>
              </button>
            ))}
            {scheduled.length ? null : (
              <p className="rail-empty">No routines scheduled.</p>
            )}
          </JobRailGroup>

          <JobRailGroup label="Finished" count={finished.length}>
            {finished.slice(0, 60).map((item) => (
              <JobRailItem
                key={item.jobId}
                job={item}
                active={item.jobId === job?.jobId}
                onSelect={() => onSelect(`job:${item.jobId}`)}
              />
            ))}
            {finished.length ? null : (
              <p className="rail-empty">
                {loaded ? 'No finished jobs yet.' : 'Loading…'}
              </p>
            )}
          </JobRailGroup>
        </div>
      </aside>

      <div className="split-main">
        {routine ? (
          <RoutineDetail routine={routine} onRun={onRunRoutine} />
        ) : job ? (
          <JobDetail
            job={job}
            traceId={traceIdFor(job)}
            onOpenThinking={onOpenThinking}
            onCancel={onCancel}
            onUndo={onUndo}
          />
        ) : (
          <div className="pipeline-empty">
            <p className="eyebrow">Jobs</p>
            <h2>Nothing to show yet</h2>
            <p className="quiet-lead">
              Every request — yours, scheduled, or agent-initiated — lands here
              with the actions it ran and what each one returned.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

function JobRailGroup({ label, count, children }) {
  return (
    <div className="job-rail-group">
      <p className="job-rail-head">
        {label} <span>{count}</span>
      </p>
      {children}
    </div>
  )
}

function JobRailItem({ job, active, onSelect }) {
  return (
    <button
      type="button"
      className={active ? 'rail-item is-on' : 'rail-item'}
      onClick={onSelect}
    >
      <strong>{truncate(job.command || 'Job', 40)}</strong>
      <span>
        <em className={`job-source src-${String(job.source || 'unknown')}`}>
          {sourceMeta(job.source).label}
        </em>{' '}
        · {statusLabel(job.status)} · {formatWhen(job.updatedAt || job.createdAt)}
      </span>
    </button>
  )
}

function JobDetail({ job, traceId, onOpenThinking, onCancel, onUndo }) {
  const result = job.result && typeof job.result === 'object' ? job.result : null
  const ran = Array.isArray(result?.results) ? result.results : []
  const planned = Array.isArray(result?.actions) ? result.actions : []
  const source = sourceMeta(job.source)
  const live = isRunningStatus(job.status)
  const summary = result?.response || result?.summary || job.error || ''
  const duration = elapsedBetween(job.createdAt, job.updatedAt)
  const succeeded = ran.filter((entry) => entry.ok !== false).length
  const touches = summarizeTouches(ran.length ? ran : planned)

  return (
    <article className={`job-detail ${live ? 'is-live' : ''}`}>
      <header className="flow-head">
        <p className="eyebrow">
          {job.type === 'plan' ? 'Plan' : 'Execution'} · {source.label}
        </p>
        <h2>{job.command || 'Job'}</h2>
        <p className={`pill is-${simpleStatus(job.status)}`}>
          {statusLabel(job.status)}
          {duration ? ` · ${formatDuration(duration)}` : ''}
          {live ? ' · updating live' : ''}
        </p>
      </header>

      <dl className="pipeline-meta">
        <div>
          <dt>Asked by</dt>
          <dd>
            {source.label} — {source.hint}
          </dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatWhen(job.createdAt) || '—'}</dd>
        </div>
        <div>
          <dt>Last update</dt>
          <dd>{formatWhen(job.updatedAt) || '—'}</dd>
        </div>
        <div>
          <dt>Actions</dt>
          <dd>
            {ran.length
              ? `${succeeded}/${ran.length} succeeded`
              : planned.length
                ? `${planned.length} planned`
                : live
                  ? 'Starting…'
                  : 'None recorded'}
          </dd>
        </div>
      </dl>

      {touches.length ? (
        <div className="job-touches">
          <p className="meta-label">Touched</p>
          <ul>
            {touches.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary ? (
        <div className="pipeline-text">
          <p className="meta-label">{job.error ? 'Error' : 'Result'}</p>
          <ReadableText text={summary} />
        </div>
      ) : null}

      {ran.length ? (
        <>
          <p className="section-label job-evidence-head">Evidence</p>
          <ol className="pipeline-events">
            {ran.map((entry, index) => (
              <JobAction
                key={`${entry.action?.type || 'action'}-${index}`}
                entry={entry}
                index={index}
              />
            ))}
          </ol>
        </>
      ) : null}

      {!ran.length && planned.length ? (
        <>
          <p className="section-label job-evidence-head">Planned steps</p>
          <ol className="pipeline-events">
            {planned.map((action, index) => (
              <JobAction
                key={`${action.type || 'action'}-${index}`}
                entry={{ action }}
                index={index}
              />
            ))}
          </ol>
        </>
      ) : null}

      <div className="job-tools">
        {job.cancellable || live ? (
          <button
            type="button"
            className="text-btn"
            onClick={() => onCancel(job.jobId)}
          >
            Cancel
          </button>
        ) : null}
        {job.undo?.canUndo ? (
          <button
            type="button"
            className="text-btn"
            onClick={() => onUndo(job.jobId)}
          >
            Undo
          </button>
        ) : null}
        {traceId ? (
          <button
            type="button"
            className="text-btn"
            onClick={() => onOpenThinking(traceId)}
          >
            Open thinking
          </button>
        ) : null}
      </div>
    </article>
  )
}

/*
 * How a shell run ended, in the words the record uses.
 *
 * "Failed" alone was the whole story here, because the exit code was thrown
 * away before it ever reached a job. A reader auditing what the agent did on
 * their Mac could not tell a command that exited 1 from one the timeout killed.
 */
function describeShellOutcome(shell) {
  if (!shell) return null
  if (shell.cancelled) return `cancelled · killed with ${shell.signal || 'a signal'}`
  if (shell.timedOut) return `timed out after ${shell.timeoutMs}ms · killed with ${shell.signal || 'a signal'}`
  if (shell.exitCode === null) return `killed by ${shell.signal || 'a signal'}`
  return `exit ${shell.exitCode}`
}

function JobAction({ entry, index }) {
  const [open, setOpen] = useState(false)
  const action = entry.action || {}
  const params = redactParams(action.params)
  const failed = entry.ok === false || entry.status === 'failed'
  const state = entry.ok === undefined ? 'pending' : failed ? 'failed' : 'done'
  const output = [
    entry.stdout ? ['stdout', entry.stdout] : null,
    entry.stderr ? ['stderr', entry.stderr] : null,
  ].filter(Boolean)
  const shellOutcome = describeShellOutcome(entry.shell)
  /* Some actions deliberately do not run as submitted. When one of those is on
   * the record, the submitted form is shown beside the executed one rather than
   * left out — the panel used to show only what ran, under the label of a step
   * nobody had asked for. */
  const rewrite = entry.rewrite || null

  return (
    <li className={`pipeline-event is-${state}`}>
      <span className="pipeline-event-index">{index + 1}</span>
      <div className="pipeline-event-body">
        <div className="pipeline-event-head">
          <div>
            <p className="meta-label">
              {String(action.type || 'action').replaceAll('_', ' ')}
            </p>
            <strong>{action.label || action.type || 'Action'}</strong>
          </div>
          <p className={`pill is-${failed ? 'bad' : state === 'done' ? 'ok' : 'busy'}`}>
            {entry.ok === undefined
              ? 'Planned'
              : failed
                ? 'Failed'
                : 'Done'}
            {shellOutcome ? ` · ${shellOutcome}` : ''}
          </p>
        </div>

        {rewrite ? (
          <dl className="pipeline-meta">
            <div>
              <dt>Submitted</dt>
              <dd>
                {rewrite.submitted?.type || 'unknown'}
                {rewrite.submitted?.params?.command
                  ? ` — ${truncate(redactInline(rewrite.submitted.params.command), 200)}`
                  : ''}
              </dd>
            </div>
            <div>
              <dt>Actually ran</dt>
              <dd>{rewrite.executed?.type || 'unknown'}</dd>
            </div>
            <div>
              <dt>Why</dt>
              <dd>{rewrite.note || rewrite.reason}</dd>
            </div>
          </dl>
        ) : null}

        {params.length ? (
          <dl className="pipeline-meta">
            {params.map(([key, value]) => (
              <div key={key}>
                <dt>{humanizeKey(key)}</dt>
                <dd>{truncate(String(value), 300)}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {entry.message ? <ReadableText text={String(entry.message)} /> : null}

        {output.length ? (
          <div className="stream-draft">
            <div className="stream-draft-head">
              <p className="meta-label">
                Output · {output.map(([name]) => name).join(' + ')}
              </p>
              <button
                type="button"
                className="linkish"
                onClick={() => setOpen((value) => !value)}
              >
                {open ? 'Hide' : 'Show'}
              </button>
            </div>
            {open
              ? output.map(([name, text]) => (
                  <pre key={name} className="stream-draft-body">
                    {redactInline(text)}
                  </pre>
                ))
              : null}
          </div>
        ) : null}
      </div>
    </li>
  )
}

function RoutineDetail({ routine, onRun }) {
  return (
    <article className="job-detail">
      <header className="flow-head">
        <p className="eyebrow">Scheduled routine</p>
        <h2>{routine.name || routine.command}</h2>
        <p className={`pill is-${routine.enabled ? 'ok' : 'busy'}`}>
          {routine.enabled ? describeSchedule(routine.schedule) : 'Paused'}
        </p>
      </header>

      <dl className="pipeline-meta">
        <div>
          <dt>Runs</dt>
          <dd>{routine.command}</dd>
        </div>
        <div>
          <dt>Next run</dt>
          <dd>
            {routine.enabled && routine.nextRunAt
              ? formatWhen(routine.nextRunAt)
              : 'Not scheduled'}
          </dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd>
            {routine.lastRunAt
              ? `${formatWhen(routine.lastRunAt)} · ${statusLabel(routine.lastStatus)}`
              : 'Never'}
          </dd>
        </div>
        <div>
          <dt>Times run</dt>
          <dd>{routine.runCount ?? 0}</dd>
        </div>
      </dl>

      {routine.lastError ? (
        <div className="pipeline-text">
          <p className="meta-label">Last error</p>
          <ReadableText text={String(routine.lastError)} />
        </div>
      ) : null}

      <p className="pipeline-note">
        Routines run whether or not this dashboard is open. Each run shows up in
        the job list above with its own evidence.
      </p>

      <div className="job-tools">
        <button
          type="button"
          className="text-btn"
          onClick={() => onRun(routine.id)}
        >
          Run now
        </button>
      </div>
    </article>
  )
}

/*
 * Each step is named for what is actually observed, not for what it would be
 * nice to have observed. `device_downlink` is new and is the last step any body
 * on this side of the wire can witness; the two after it can only be reported by
 * the pendant, which currently reports neither, so stageIsReportable() draws
 * them as unknown rather than as merely pending.
 */
const PIPELINE_STAGES = [
  { id: 'transcription', label: 'Speech → text' },
  { id: 'agent', label: 'Agent + LLM' },
  { id: 'tts', label: 'Text → speech' },
  { id: 'relay_result', label: 'Cloud handoff' },
  { id: 'device_downlink', label: 'Bytes to pendant' },
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

/*
 * The part of a run that used to be invisible: who witnessed the reply getting
 * to the pendant, and what they did not witness.
 *
 * `heard` is printed on its own line because it is the question the owner is
 * actually asking, and on this build the answer is always "unknown" for a
 * pendant run. Better an uncomfortable constant than a green tick that means
 * "the Mac finished".
 */
function DeliveryEvidenceCard({ delivery }) {
  if (!delivery) return null

  const heardLabel =
    delivery.heard === 'yes'
      ? 'Yes — the pendant reported playing it'
      : delivery.heard === 'no-audio'
        ? 'Nothing was waiting to hear it'
        : 'Unknown — nothing on this system can say'

  return (
    <div className="pipeline-input-card">
      <p className="meta-label">Reply delivery</p>
      <p>
        <strong>{delivery.label}</strong>
        {delivery.witness ? ` · witnessed by ${delivery.witness}` : ''}
      </p>
      <p>{delivery.evidence}</p>
      {delivery.doesNotProve ? (
        <p className="quiet-lead">Does not prove: {delivery.doesNotProve}</p>
      ) : null}
      <p>
        <strong>Did the owner hear it?</strong> {heardLabel}
      </p>
    </div>
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

      <DeliveryEvidenceCard delivery={run.delivery} />

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
    /*
     * Deliberately not "Done" and deliberately not "Sent". The Mac's part
     * finished, the audio went out, and nothing on this system can say whether
     * the pendant played it. Saying so is the whole point.
     */
    case PLAYBACK_UNKNOWN_STATUS:
      return 'Playback unknown'
    /*
     * Deliberately not "Done" and deliberately not "Failed": the steps ran,
     * the goal was not met (goalVerdict.js). Same word the SvelteKit
     * dashboard shows for this status.
     */
    case 'incomplete':
      return 'Incomplete'
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
  /*
   * An unknown last mile is explicitly not 'ok'. It is not 'bad' either —
   * nothing failed — so it shares the neutral tone with everything else that has
   * not resolved. What it must never do is fall into the green.
   */
  if (status === PLAYBACK_UNKNOWN_STATUS) return 'busy'
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
  if (!matching.length) {
    /*
     * 'pending' means "not yet". For a stage whose only possible witness never
     * speaks, "not yet" is a promise the system cannot keep, so it reads as
     * unknown instead. This is what made a run look like it was still on its way
     * to the speaker when in fact nothing was ever going to say whether it got
     * there.
     */
    return stageIsReportable(stageId) ? 'pending' : 'unknown'
  }
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
