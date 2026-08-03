import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_TOKEN, PORT, FULL_CONTROL_MODE } from './config.js'
import {
  completeBrowserCommand,
  getBrowserStatus,
  pollBrowserCommand,
  registerBrowserHeartbeat,
} from './browserBridge.js'
import { orchestrateExecute, orchestratePlan } from './orchestrator.js'
import { purgeAllCaptures, stripImageBytes } from './screenCapture.js'
import { appendLog, logLocation, readLogs } from './logger.js'
import {
  isFullControlPlanner,
  isLlmPlannerEnabled,
  isVisionConfigured,
} from './llmPlanner.js'
import {
  computerUseEnabled,
  MAX_STEPS_CEILING,
  visionUploadConsented,
} from './computerUseLoop.js'
import {
  addContextRelation,
  contextGraphLocation,
  deleteContextEntity,
  deleteContextRelation,
  getLatestContext,
  loadDemoContextGraph,
  readContextGraph,
  resetContextGraph,
  retrieveLongTermMemory,
  upsertContextEntity,
} from './contextGraph.js'
import {
  getActiveProject,
  listProjects,
  projectsLocation,
  readProjectStore,
  setActiveProject,
  updateActiveProject,
} from './projectMemory.js'
import {
  clearSessionTurns,
  createSession,
  deleteSession,
  getSession,
  readSessions,
  sessionsLocation,
  updateSession,
} from './sessionStore.js'
import {
  clearJobs,
  getJob,
  jobsLocation,
  markJobUndone,
  readJobs,
  recordJobFinish,
  recordJobStart,
} from './jobTracker.js'
import {
  cancelActiveJob,
  clearActiveJob,
  registerActiveJob,
} from './jobControl.js'
import { describeUndoability, undoJobResults } from './undo.js'
import {
  getMachineContext,
  refreshMachineContext,
  warmMachineContext,
} from './machineContext.js'
import {
  onThinkingChange,
  readTraces,
  tracesLocation,
} from './thinkingTrace.js'
import {
  clearPipelineRuns,
  onPipelineChange,
  pipelineLocation,
  readPipelineRuns,
  recordPipelineEvent,
} from './pipelineTrace.js'
import {
  readPipelineAudio,
  savePipelineAudio,
} from './pipelineAudio.js'
import { RELAY_API_KEY, RELAY_URL } from './bridgeConfig.js'
import { startBridge } from './bridge.js'
import {
  ensurePermissions,
  formatPermissionHelp,
} from './macos/permissions.js'
import { isPublicPath, publicHealthPayload } from './httpPolicy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

const app = express()
warmMachineContext()

app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/health', (_request, response) => {
  response.json(publicHealthPayload())
})

app.use((request, response, next) => {
  if (isPublicPath(request.path)) {
    next()
    return
  }

  if (!AGENT_TOKEN) {
    response.status(503).json({
      ok: false,
      status: 'blocked',
      error:
        'Blocked for safety: AGENT_TOKEN is not configured on the Mac local agent.',
    })
    return
  }

  const authorization = request.get('authorization') ?? ''
  const token = authorization.replace(/^Bearer\s+/i, '')

  if (token !== AGENT_TOKEN) {
    response.status(401).json({
      ok: false,
      status: 'blocked',
      error: 'Blocked for safety: invalid or missing agent token.',
    })
    return
  }

  next()
})

app.post('/plan', async (request, response) => {
  const command = String(request.body?.command ?? '')
  const sessionId = String(request.body?.sessionId ?? '').trim() || null
  const tracked = recordJobStart({
    type: 'plan',
    command,
    sessionId,
    source: request.body?.source || 'local',
  })
  const abortController = new AbortController()
  registerActiveJob(tracked.jobId, { abortController, kind: 'plan' })

  try {
    const plan = await orchestratePlan({
      command,
      sessionId,
      source: request.body?.source || 'local',
      signal: abortController.signal,
    })

    if (plan.status === 'unsupported') {
      recordJobFinish(tracked.jobId, {
        status: 'failed',
        error: plan.error,
        result: plan,
        thinking: plan.thinking ?? null,
      })
      response.status(422).json({
        ...plan,
        error: `Blocked for safety: ${plan.error}`,
        jobId: tracked.jobId,
      })
      return
    }

    recordJobFinish(tracked.jobId, {
      status: plan.status === 'instant' ? 'completed' : 'plan_ready',
      result: plan,
      thinking: plan.thinking ?? null,
    })
    response.json({ ...plan, jobId: tracked.jobId })
  } catch (error) {
    const cancelled =
      error?.name === 'JobCancelledError' ||
      error?.code === 'JOB_CANCELLED' ||
      abortController.signal.aborted
    recordJobFinish(tracked.jobId, {
      status: cancelled ? 'cancelled' : 'failed',
      error: error.message,
      thinking: error.thinking ?? null,
    })
    response.status(cancelled ? 409 : 500).json({
      ok: false,
      error: error.message,
      cancelled,
      jobId: tracked.jobId,
    })
  } finally {
    clearActiveJob(tracked.jobId)
  }
})

app.post('/execute', async (request, response) => {
  const actions = Array.isArray(request.body?.actions)
    ? request.body.actions
    : []
  const command = String(request.body?.command ?? '')
  const sessionId = String(request.body?.sessionId ?? '').trim() || null
  const planMeta = request.body?.planMeta ?? null
  const tracked = recordJobStart({
    type: 'execute',
    command,
    sessionId,
    source: request.body?.source || 'local',
  })
  const abortController = new AbortController()
  registerActiveJob(tracked.jobId, { abortController, kind: 'execute' })

  if (!actions.length) {
    clearActiveJob(tracked.jobId)
    recordJobFinish(tracked.jobId, {
      status: 'failed',
      error: 'No actions provided.',
    })
    response.status(400).json({
      ok: false,
      error: 'No actions provided.',
      jobId: tracked.jobId,
    })
    return
  }

  try {
    const payload = await orchestrateExecute({
      command,
      actions,
      sessionId,
      planMeta,
      source: request.body?.source || 'local',
      signal: abortController.signal,
    })

    recordJobFinish(tracked.jobId, {
      status: payload.ok ? 'completed' : 'failed',
      // pendant-jobs.json is durable and is rendered in the ops dashboard, so
      // the image bytes are stripped before it is written. The HTTP response
      // still carries them for the immediate caller.
      result: stripImageBytes(payload),
      error: payload.ok ? null : payload.error || payload.status,
      thinking: payload.thinking ?? null,
    })
    response.json({ ...payload, jobId: tracked.jobId })
  } catch (error) {
    const cancelled =
      error?.name === 'JobCancelledError' ||
      error?.code === 'JOB_CANCELLED' ||
      abortController.signal.aborted
    const logs = appendLog({
      command,
      actions,
      status: cancelled ? 'cancelled' : 'failed',
      error: error.message,
    })

    recordJobFinish(tracked.jobId, {
      status: cancelled ? 'cancelled' : 'failed',
      error: error.message,
      thinking: error.thinking ?? null,
    })
    response.status(cancelled ? 409 : 400).json({
      ok: false,
      cancelled,
      error: error.message,
      logs,
      jobId: tracked.jobId,
    })
  } finally {
    clearActiveJob(tracked.jobId)
  }
})

app.get('/sessions', (_request, response) => {
  response.json({
    sessions: readSessions(),
  })
})

app.post('/sessions', (request, response) => {
  const title = String(request.body?.title ?? 'New session').trim()
  response.json({
    session: createSession({ title }),
  })
})

app.get('/sessions/:sessionId', (request, response) => {
  const session = getSession(request.params.sessionId)

  if (!session) {
    response.status(404).json({ ok: false, error: 'Session not found.' })
    return
  }

  response.json({ session })
})

app.patch('/sessions/:sessionId', (request, response) => {
  const session = updateSession(request.params.sessionId, {
    title: request.body?.title,
  })

  if (!session) {
    response.status(404).json({ ok: false, error: 'Session not found.' })
    return
  }

  response.json({ session })
})

app.delete('/sessions/:sessionId', (request, response) => {
  const removed = deleteSession(request.params.sessionId)

  if (!removed) {
    response.status(404).json({ ok: false, error: 'Session not found.' })
    return
  }

  response.json({ ok: true })
})

app.post('/sessions/:sessionId/clear', (request, response) => {
  const session = clearSessionTurns(request.params.sessionId)

  if (!session) {
    response.status(404).json({ ok: false, error: 'Session not found.' })
    return
  }

  response.json({ session })
})

app.get('/logs', (_request, response) => {
  response.json({
    logs: readLogs(),
  })
})

app.get('/jobs', (_request, response) => {
  const jobs = readJobs().map((job) => ({
    ...job,
    undo: describeUndoability(job),
    cancellable: job.status === 'processing',
  }))
  response.json({
    jobs,
    path: jobsLocation(),
  })
})

app.delete('/jobs', (_request, response) => {
  response.json({
    jobs: clearJobs(),
  })
})

app.post('/jobs/undo-last', async (_request, response) => {
  const candidate = readJobs().find(
    (job) =>
      (job.status === 'completed' || job.status === 'success') &&
      !job.undoneAt &&
      describeUndoability(job).canUndo,
  )

  if (!candidate) {
    response.status(404).json({
      ok: false,
      error: 'No reversible completed job to undo.',
    })
    return
  }

  try {
    const undoResult = await undoJobResults(candidate)
    const job = markJobUndone(candidate.jobId, undoResult)
    response.json({
      ok: true,
      job,
      undo: undoResult,
    })
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error.message,
      jobId: candidate.jobId,
    })
  }
})

app.post('/jobs/:jobId/cancel', (request, response) => {
  const jobId = String(request.params.jobId || '')
  const job = getJob(jobId)
  if (!job) {
    response.status(404).json({ ok: false, error: 'Job not found.' })
    return
  }

  if (job.status !== 'processing') {
    response.status(409).json({
      ok: false,
      error: `Job is not in progress (status: ${job.status}).`,
      job,
    })
    return
  }

  const result = cancelActiveJob(jobId)
  if (!result.ok) {
    // Process may have restarted — still mark cancelled in the store.
    recordJobFinish(jobId, {
      status: 'cancelled',
      error: 'Cancelled from dashboard (job was no longer active in-memory).',
    })
    response.json({
      ok: true,
      job: getJob(jobId),
      note: 'Marked cancelled in history; in-memory worker was already gone.',
    })
    return
  }

  response.json({
    ok: true,
    cancelling: true,
    jobId,
    message: 'Cancel signal sent. The running step will stop before the next one.',
  })
})

app.post('/jobs/:jobId/undo', async (request, response) => {
  const jobId = String(request.params.jobId || '')
  const job = getJob(jobId)
  if (!job) {
    response.status(404).json({ ok: false, error: 'Job not found.' })
    return
  }

  try {
    const undoResult = await undoJobResults(job)
    const updated = markJobUndone(jobId, undoResult)
    response.json({
      ok: true,
      job: updated,
      undo: undoResult,
    })
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error.message,
      undo: describeUndoability(job),
      jobId,
    })
  }
})

app.get('/thinking', (_request, response) => {
  response.json({
    traces: readTraces(),
    path: tracesLocation(),
  })
})

app.get('/thinking/latest', (_request, response) => {
  const traces = readTraces()
  response.json({
    trace: traces[0] ?? null,
  })
})

app.get('/thinking/stream', (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders?.()

  const send = (traces) => {
    response.write(
      `data: ${JSON.stringify({
        traces,
        latest: traces[0] ?? null,
        at: new Date().toISOString(),
      })}\n\n`,
    )
  }

  send(readTraces())

  const unsubscribe = onThinkingChange((traces) => {
    send(traces)
  })

  const heartbeat = setInterval(() => {
    response.write(': ping\n\n')
  }, 15000)

  request.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
})

app.get('/pipeline', (_request, response) => {
  response.json({
    runs: readPipelineRuns(),
    path: pipelineLocation(),
  })
})

app.post('/pipeline/events', (request, response) => {
  try {
    const run = recordPipelineEvent(request.body ?? {})
    response.status(201).json({ ok: true, run })
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error.message || 'Pipeline event was rejected.',
    })
  }
})

app.post('/pipeline/audio', (request, response) => {
  try {
    const audio = savePipelineAudio(request.body ?? {})
    response.status(201).json({ ok: true, audio })
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error.message || 'Pipeline audio was rejected.',
    })
  }
})

app.get('/pipeline/:pipelineId/audio/:direction', (request, response) => {
  try {
    const audio = readPipelineAudio(
      request.params.pipelineId,
      request.params.direction,
    )
    if (!audio) {
      response.status(404).json({
        ok: false,
        error: 'Pipeline audio was not found.',
      })
      return
    }

    response.setHeader('Content-Type', audio.mimeType)
    response.setHeader('Content-Length', String(audio.buffer.length))
    response.setHeader('Cache-Control', 'private, no-store')
    response.setHeader('Content-Disposition', 'inline')
    response.status(200).send(audio.buffer)
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error.message || 'Pipeline audio could not be read.',
    })
  }
})

app.delete('/pipeline', (_request, response) => {
  response.json({
    ok: true,
    runs: clearPipelineRuns(),
  })
})

app.get('/pipeline/stream', (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders?.()

  const send = (runs) => {
    response.write(
      `data: ${JSON.stringify({
        runs,
        latest: runs[0] ?? null,
        at: new Date().toISOString(),
      })}\n\n`,
    )
  }

  send(readPipelineRuns())

  const unsubscribe = onPipelineChange((runs) => {
    send(runs)
  })

  const heartbeat = setInterval(() => {
    response.write(': ping\n\n')
  }, 15000)

  request.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
})

app.get('/context-graph', (_request, response) => {
  const latest = getLatestContext()
  const activeProject = getActiveProject()
  response.json({
    graph: latest.graph,
    memory: {
      latestEmailDraft: latest.latestEmailDraft,
      latestPerson: latest.latestPerson,
      latestResource: latest.latestResource,
      latestFile: latest.latestFile,
      latestTask: latest.latestTask,
    },
    workingProject: activeProject,
    longTerm: retrieveLongTermMemory({
      projectId: activeProject?.id ?? null,
      limit: 24,
    }),
  })
})

app.get('/projects', (_request, response) => {
  response.json({
    ...readProjectStore(),
    activeProject: getActiveProject(),
    path: projectsLocation(),
  })
})

app.get('/projects/active', (_request, response) => {
  response.json({
    project: getActiveProject(),
  })
})

app.post('/projects/active', (request, response) => {
  try {
    const project = setActiveProject(String(request.body?.projectId || ''))
    response.json({ project, store: readProjectStore() })
  } catch (error) {
    response.status(400).json({ error: error.message })
  }
})

app.patch('/projects/active', (request, response) => {
  try {
    const project = updateActiveProject({
      name: request.body?.name,
      path: request.body?.path,
      summary: request.body?.summary,
      goals: request.body?.goals,
      people: request.body?.people,
      openThreads: request.body?.openThreads,
    })
    response.json({ project })
  } catch (error) {
    response.status(400).json({ error: error.message })
  }
})

app.post('/context-graph/reset', (_request, response) => {
  response.json({
    graph: resetContextGraph(),
  })
})

app.post('/context-graph/demo', (_request, response) => {
  response.json({
    graph: loadDemoContextGraph(),
  })
})

app.post('/context-graph/entities', (request, response) => {
  const { graph, entity } = upsertContextEntity({
    id: request.body?.id,
    type: request.body?.type,
    name: request.body?.name,
    attributes: request.body?.attributes ?? {},
  })
  response.json({ graph, entity })
})

app.patch('/context-graph/entities/:entityId', (request, response) => {
  const existing = readContextGraph().entities.find(
    (entity) => entity.id === request.params.entityId,
  )

  if (!existing) {
    response.status(404).json({ ok: false, error: 'Entity not found.' })
    return
  }

  const { graph, entity } = upsertContextEntity({
    id: request.params.entityId,
    type: request.body?.type ?? existing.type,
    name: request.body?.name ?? existing.name,
    attributes: request.body?.attributes ?? existing.attributes,
  })
  response.json({ graph, entity })
})

app.delete('/context-graph/entities/:entityId', (request, response) => {
  const graph = deleteContextEntity(request.params.entityId)

  if (!graph) {
    response.status(404).json({ ok: false, error: 'Entity not found.' })
    return
  }

  response.json({ graph })
})

app.post('/context-graph/relations', (request, response) => {
  const from = String(request.body?.from ?? '').trim()
  const to = String(request.body?.to ?? '').trim()
  const type = String(request.body?.type ?? 'related_to').trim()

  if (!from || !to) {
    response.status(400).json({ ok: false, error: 'from and to are required.' })
    return
  }

  response.json({
    graph: addContextRelation({
      from,
      to,
      type,
      attributes: request.body?.attributes ?? {},
    }),
  })
})

app.delete('/context-graph/relations/:relationId', (request, response) => {
  const graph = deleteContextRelation(request.params.relationId)

  if (!graph) {
    response.status(404).json({ ok: false, error: 'Relation not found.' })
    return
  }

  response.json({ graph })
})

app.get('/machine-context', async (_request, response) => {
  response.json({
    machine: await getMachineContext(),
  })
})

app.post('/machine-context/refresh', async (_request, response) => {
  response.json({
    machine: await refreshMachineContext(),
  })
})

app.get('/ops/status', async (_request, response) => {
  response.json(await buildOpsStatus())
})

app.get('/ops/snapshot', async (_request, response) => {
  const [status, latest] = await Promise.all([
    buildOpsStatus(),
    Promise.resolve(getLatestContext()),
  ])

  // Keep remote relay payloads under D1 / request size limits.
  const sessions = readSessions()
    .slice(0, 40)
    .map((session) => ({
      ...session,
      turns: Array.isArray(session.turns) ? session.turns.slice(-12) : [],
    }))

  response.json({
    ok: true,
    status,
    sessions,
    context: {
      graph: {
        entities: (latest.graph?.entities || []).slice(0, 80),
        relations: (latest.graph?.relations || []).slice(0, 80),
      },
      memory: {
        latestEmailDraft: latest.latestEmailDraft,
        latestPerson: latest.latestPerson,
        latestResource: latest.latestResource,
        latestFile: latest.latestFile,
        latestTask: latest.latestTask,
      },
      workingProject: getActiveProject(),
      longTerm: retrieveLongTermMemory({ limit: 24 }),
    },
    jobs: readJobs()
      .slice(0, 50)
      .map((job) => ({
        jobId: job.jobId,
        type: job.type,
        status: job.status,
        command: job.command,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        undoneAt: job.undoneAt || null,
        cancellable: job.status === 'processing',
        undo: describeUndoability(job),
        result: job.result
          ? {
              summary: job.result.summary,
              response: job.result.response,
              status: job.result.status,
              ok: job.result.ok,
              results: Array.isArray(job.result.results)
                ? job.result.results.map((item) => ({
                    ok: item.ok,
                    status: item.status,
                    message: item.message,
                    action: item.action,
                    before: item.before,
                    after: item.after,
                    percent: item.percent,
                    pid: item.pid,
                    path: item.path,
                    region: item.region,
                  }))
                : [],
            }
          : null,
      })),
    traces: readTraces()
      .slice(0, 25)
      .map((trace) => ({
        ...trace,
        // Drop bulky nested payloads if present
        raw: undefined,
        llm: undefined,
      })),
    pipeline: readPipelineRuns().slice(0, 40),
    logs: readLogs()
      .slice(0, 50)
      .map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        command: entry.command,
        status: entry.status,
        error: entry.error,
        summary: entry.summary || entry.result?.summary || entry.result?.response,
      })),
  })
})

app.get('/browser/status', (_request, response) => {
  response.json(getBrowserStatus())
})

app.post('/browser/heartbeat', (request, response) => {
  response.json(
    registerBrowserHeartbeat({
      extensionId: String(request.body?.extensionId ?? 'home-chrome'),
      tabId: request.body?.tabId ?? null,
      windowId: request.body?.windowId ?? null,
      tabUrl: request.body?.tabUrl ?? '',
      userAgent: request.body?.userAgent ?? '',
      deviceName: request.body?.deviceName ?? '',
      browserName: request.body?.browserName ?? '',
      extensionVersion: request.body?.extensionVersion ?? '',
    }),
  )
})

app.get('/browser/poll', (request, response) => {
  const extensionId = String(request.query.extensionId ?? 'home-chrome')
  const command = pollBrowserCommand(extensionId)

  if (!command) {
    response.status(204).end()
    return
  }

  response.json({ command })
})

app.post('/browser/result/:commandId', (request, response) => {
  const result = completeBrowserCommand(
    request.params.commandId,
    {
      ok: Boolean(request.body?.ok),
      result: request.body?.result ?? null,
      error: String(request.body?.error ?? ''),
    },
    request.body?.extensionId ?? null,
  )

  if (!result) {
    response.status(404).json({ ok: false, error: 'Browser command not found.' })
    return
  }

  response.json({ ok: true, result })
})

if (fs.existsSync(distDir)) {
  app.use('/assets', express.static(path.join(distDir, 'assets')))
  app.use(express.static(distDir, { index: false }))

  app.get(['/dashboard', '/dashboard/'], (_request, response) => {
    response.sendFile(path.join(distDir, 'dashboard.html'))
  })
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Pendant Mac Local Agent listening on http://localhost:${PORT}`)
  // Any screenshots left behind by a crashed run die with the old process.
  purgeAllCaptures()
  startBridge().catch((error) => {
    console.error(`[bridge] Fatal error: ${error.message}`)
  })
  if (fs.existsSync(path.join(distDir, 'dashboard.html'))) {
    console.log(`Mac Ops dashboard: http://localhost:${PORT}/dashboard`)
  }

  // Silent status only — never re-prompt on normal starts.
  // Full one-shot grant for every app: npm run agent:setup
  ensurePermissions({
    prompt: false,
    openSettings: false,
    preflightAutomation: false,
    force: false,
  })
    .then((result) => {
      if (result.after.ready) {
        console.log(
          `[permissions] Ready for all required apps (host: ${result.after.hostApp}). No prompts.`,
        )
        return
      }
      console.warn('[permissions] Missing Mac privacy permissions.')
      if (result.after.requiredMissing?.length) {
        console.warn(
          `[permissions] Still need Automation for: ${result.after.requiredMissing.join(', ')}`,
        )
      }
      console.warn(formatPermissionHelp(result.after))
      console.warn('[permissions] Fix once with: npm run agent:setup')
    })
    .catch((error) => {
      console.warn(`[permissions] Could not verify permissions: ${error.message}`)
    })
})

async function buildHealthPayload() {
  let permissions
  try {
    // Health must never trigger Automation dialogs — use quiet ensurePermissions.
    const result = await ensurePermissions({
      prompt: false,
      openSettings: false,
      preflightAutomation: false,
      force: false,
    })
    permissions = result.after
  } catch (error) {
    permissions = { error: error.message }
  }

  return {
    ok: true,
    service: 'AI Pendant Mac Local Agent',
    version: '0.5.0',
    tokenRequired: true,
    tokenConfigured: Boolean(AGENT_TOKEN),
    fullControlMode: FULL_CONTROL_MODE,
    llmPlannerEnabled: isLlmPlannerEnabled(),
    fullControlPlanner: isFullControlPlanner(),
    computerUse: {
      loopEnabled: computerUseEnabled(),
      visionModelConfigured: isVisionConfigured(),
      visionUploadConsented: visionUploadConsented(),
      maxSteps: MAX_STEPS_CEILING,
    },
    browserExtension: getBrowserStatus(),
    permissions,
    logPath: logLocation(),
    contextGraphPath: contextGraphLocation(),
    sessionsPath: sessionsLocation(),
    jobsPath: jobsLocation(),
    pipelinePath: pipelineLocation(),
    dashboardAvailable: fs.existsSync(path.join(distDir, 'dashboard.html')),
  }
}

async function buildOpsStatus() {
  const health = await buildHealthPayload()
  let relay = {
    configured: Boolean(RELAY_URL),
    url: RELAY_URL || null,
    reachable: false,
    payload: null,
    error: null,
  }

  if (RELAY_URL) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const response = await fetch(`${RELAY_URL.replace(/\/$/, '')}/health`, {
        signal: controller.signal,
        headers: RELAY_API_KEY
          ? { Authorization: `Bearer ${RELAY_API_KEY}` }
          : undefined,
      })
      clearTimeout(timer)
      const payload = await response.json().catch(() => null)
      relay = {
        ...relay,
        reachable: response.ok,
        payload,
        error: response.ok ? null : `HTTP ${response.status}`,
      }
    } catch (error) {
      relay = {
        ...relay,
        reachable: false,
        error: error.message,
      }
    }
  }

  const machine = await getMachineContext().catch(() => null)
  const latest = getLatestContext()

  return {
    ok: true,
    agent: health,
    relay,
    browser: health.browserExtension,
    machine: machine
      ? {
          hostname: machine.hostname,
          home: machine.home,
          platform: machine.platform,
          appCount: machine.applications?.length ?? 0,
          topApps: (machine.applications ?? []).slice(0, 12),
        }
      : null,
    memory: {
      latestEmailDraft: latest.latestEmailDraft,
      latestPerson: latest.latestPerson,
      latestFile: latest.latestFile,
      latestTask: latest.latestTask,
    },
    workingProject: getActiveProject(),
    counts: {
      sessions: readSessions().length,
      jobs: readJobs().length,
      logs: readLogs().length,
      projects: listProjects().length,
      entities: latest.graph.entities.length,
      relations: latest.graph.relations.length,
      pipelineRuns: readPipelineRuns().length,
    },
  }
}
