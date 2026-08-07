import './loadEnv.js'

/*
 * Timestamp every log line. The launchd log files have no other time source,
 * which made the 2026-08-05 latency stalls unattributable after the fact.
 */
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console)
  console[level] = (...parts) =>
    original(new Date().toISOString(), ...parts)
}

import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_TOKEN, PORT, FULL_CONTROL_MODE } from './config.js'
import {
  cancelBrowserCommands,
  completeBrowserCommand,
  getBrowserStatus,
  pollBrowserCommand,
  registerBrowserBridgeRoutes,
  registerBrowserHeartbeat,
  startBrowserBridgeSupervisor,
} from './browserBridge.js'
import { registerActionLedgerRoutes } from './actionLedgerRoutes.js'
import { registerAudioRetentionRoutes } from './audioRetention.js'
import { registerCatchupRoutes } from './catchupDigest.js'
import { registerFormPreviewRoutes } from './formPreview.js'
import { registerBriefingTriageRoutes } from './briefingTriage.js'
import { registerPrepareApproveRoutes } from './prepareApprove.js'
import { registerPageWatchRoutes } from './pageWatchRoutes.js'
import {
  browserSessionsLocation,
  forgetBrowserSession,
  listBrowserSessions,
  openBrowserSession,
} from './browserSessions.js'
import {
  BRIEFING_KINDS,
  matchBriefingCommand,
  readLatestBriefing,
  runBriefing,
} from './briefing.js'
import {
  buildEvidenceLedger,
  getCapsule,
  presentCapsule,
  revokeCapsules,
  sweepCapsules,
} from './evidenceCapsules.js'
import { fillForm, formFillLocation, getFill, listFills } from './formFill.js'
import { orchestrateExecute, orchestratePlan } from './orchestrator.js'
import { readOrigins, relayBudgetRemainingMs } from './originFanOut.js'
import {
  acknowledgeReports,
  checkWatch,
  createWatch,
  deleteWatch,
  getWatch,
  listWatches,
  pageWatchLocation,
  pendingReports,
  startPageWatchScheduler,
  updateWatch,
} from './pageWatch.js'
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  runRoutine,
  startRoutineScheduler,
  updateRoutine,
} from './routines.js'
import { researchTopic } from './research.js'
import {
  briefingsLocation,
  deliverBriefing,
  getBriefing,
  listBriefings,
  markBriefingPlayed,
  pendantSpeechForBriefing,
  playBriefingOnMac,
} from './audioBrief.js'
import { readRoutingStats } from './routingStats.js'
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
  forgetFact,
  listFacts,
  memoryLocation,
  pruneFacts,
  rememberBrowserFindings,
  rememberFact,
  syncFactsFromContextGraph,
  touchFacts,
} from './memoryService.js'
import { projectContext } from './contextProjection.js'
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
import { receiptsForJob, undoVaultLocation } from './actionReceipts.js'
import {
  buildExecutionJournal,
  journalEntry,
  observeHost,
} from './executionJournal.js'
import {
  getInputReachability,
  probeInputReachability,
  startInputReachabilityMonitor,
} from './inputReachability.js'
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
import {
  buildCapabilityManifest,
  isKnownRoutePath,
} from './capabilityManifest.js'
import {
  hasDashboardSession,
  issueDashboardSession,
} from './dashboardSession.js'
import { captureNote, forgetCapture, recallCaptures } from './quickCapture.js'
import { scheduleReminder } from './remindMe.js'
import {
  applyTidy,
  formatPreview,
  listPlans,
  planTidy,
  tidyPlansLocation,
  undoTidy,
} from './downloadsTidy.js'
import {
  applySweep,
  formatSweep,
  getSweep,
  listSweeps,
  planSweep,
  surveyFolder,
  sweepPlansLocation,
  undoSweep,
} from './folderSweep.js'
import { foreseePlan, formatPlanPreview } from './planPreview.js'
import {
  actOnInspection,
  formatInspection,
  getInspection,
  inspectPage,
  inspectionsLocation,
  listInspections,
} from './browserInspect.js'
import {
  endFocusSession,
  focusStatus,
  resumeFocusSessions,
  startFocusSession,
} from './focusSession.js'
import { buildDayPlan, formatBriefing } from './dayPlan.js'
import { prepareForNextMeeting, registerMeetingPrepRoutes } from './meetingPrep.js'
import { prepareMeetingFollowup } from './meetingFollowup.js'
import {
  listTriageRuns,
  mailTriageLocation,
  readTriageRun,
  triageInbox,
} from './mailTriage.js'
import { triageNotifications } from './notificationTriage.js'
import { registerGoalRouterRoutes } from './goalRouter.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

/*
 * The dashboard is one SvelteKit app with two hosts: the Cloudflare Worker and
 * this agent. Serving the very same build here is what stops the local and the
 * deployed dashboards drifting apart — they were separate codebases, and every
 * change had to be written twice. Produced by `npm run build:agent` in
 * software/dashboard-sveltekit.
 */
const svelteDashboardDir = path.resolve(
  rootDir,
  '../dashboard-sveltekit/build-agent',
)
const svelteDashboardIndex = path.join(svelteDashboardDir, 'index.html')
const hasSvelteDashboard = fs.existsSync(svelteDashboardIndex)

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

  /*
   * Answer "no such route" before "wrong token".
   *
   * This middleware sits in front of routing, so every typo used to come back
   * 401 — indistinguishable from a real route with a bad token. Callers read
   * that as "it exists but I am not allowed", and reconnaissance rounds were
   * spent chasing endpoints that were never here. A missing or wrong token on
   * a route that DOES exist is still 401; nothing about auth is relaxed.
   */
  if (!isKnownRoutePath(app, request.path, { staticDir: distDir })) {
    response.status(404).json({
      ok: false,
      error: `No such route on this agent: ${request.method} ${request.path}`,
      hint: 'GET /capabilities lists every route this process has.',
    })
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

  // The dashboard runs in a browser and cannot hold a bearer token; a
  // loopback-only session cookie stands in for one.
  if (hasDashboardSession(request)) {
    next()
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

/*
 * The one place that answers "what can this agent do, and where does it live".
 * Derived from the running router and the executor's dispatch table — see
 * capabilityManifest.js for why none of it is written by hand.
 */
app.get('/capabilities', async (_request, response) => {
  let permissions
  try {
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

  response.json(
    buildCapabilityManifest(app, {
      permissions,
      staticDir: distDir,
      relayUrl: RELAY_URL || null,
    }),
  )
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
      contextHandle: request.body?.contextHandle ?? null,
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
    /*
     * "Make every Mac plan two-phase by default: first return a concise preview
     * with affected apps/files/URLs."
     *
     * Attached, not enforced. The plan is unchanged and /execute will still run
     * it as-is without ever reading this field; `preview` is the affected
     * apps/files/URLs and the undo story, computed from the same receipt logic
     * that will describe the run afterwards, so the owner can see it before
     * they say go. It carries `bulk: true` when the plan is the sort worth
     * pausing on — advice for whatever is rendering it, never a condition.
     */
    const preview = Array.isArray(plan.actions) && plan.actions.length
      ? foreseePlan(plan.actions, { title: command })
      : null
    response.json({ ...plan, preview, jobId: tracked.jobId })
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

/*
 * A stored job's `result` carries the whole contextGraph and the log ring —
 * once per job. With 120 jobs that made this route 27 MB, of which 29 MB
 * measured: contextGraph 49%, logs 47%, and everything the dashboard actually
 * renders 2.4%. The Jobs view polls every 4 s, so the agent was serialising
 * ~7 MB/s to display 700 kB. Only these five result fields are ever read;
 * GET /jobs/:jobId still returns the record untouched.
 */
function projectJobForList(job) {
  const result = job.result
  return {
    ...job,
    result: result
      ? {
          results: result.results,
          actions: result.actions,
          response: result.response,
          summary: result.summary,
          /* The view follows this id to /thinking/:traceId; the trace itself
           * is far too big to ride along on every poll. */
          thinking: result.thinking?.traceId
            ? { traceId: result.thinking.traceId }
            : undefined,
        }
      : result,
    undo: describeUndoability(job),
    receipts: receiptsForJob(job),
    cancellable: job.status === 'processing',
  }
}

app.get('/jobs', (request, response) => {
  const all = readJobs()
  const limit = Number.parseInt(String(request.query.limit ?? ''), 10)
  /* recordJobStart unshifts, so the store is already newest-first and the most
   * recent jobs are at the head. Taking the tail and reversing it returned the
   * OLDEST jobs in oldest-last order -- wrong twice over, and it made the
   * dashboard's Jobs view look frozen an hour in the past. */
  const slice = Number.isFinite(limit) && limit > 0 ? all.slice(0, limit) : all

  response.json({
    jobs: slice.map(projectJobForList),
    total: all.length,
    path: jobsLocation(),
  })
})

/* The untrimmed record, for when something needs what the list drops. */
app.get('/jobs/:jobId', (request, response) => {
  const job = getJob(String(request.params.jobId || ''))
  if (!job) {
    response.status(404).json({ ok: false, error: 'Job not found.' })
    return
  }
  response.json({
    ok: true,
    job: {
      ...job,
      undo: describeUndoability(job),
      receipts: receiptsForJob(job),
      cancellable: job.status === 'processing',
    },
  })
})

/* What a single job actually touched, and what of it can still be taken back. */
app.get('/jobs/:jobId/receipts', (request, response) => {
  const job = getJob(String(request.params.jobId || ''))
  if (!job) {
    response.status(404).json({ ok: false, error: 'Job not found.' })
    return
  }

  const receipts = receiptsForJob(job)
  response.json({
    ok: true,
    jobId: job.jobId,
    command: job.command,
    status: job.status,
    undoneAt: job.undoneAt ?? null,
    undo: describeUndoability(job),
    counts: {
      total: receipts.length,
      wrote: receipts.filter((receipt) => receipt.effect === 'write').length,
      reversible: receipts.filter((receipt) => receipt.reversible).length,
      /* Steps that posted a synthesized event while reachability was failed or
       * unproven. Not a failure count — a "this success may not mean what it
       * looks like" count. */
      inputMayHaveBeenNoOp: receipts.filter(
        (receipt) => receipt.inputReachability?.warning,
      ).length,
    },
    receipts,
    snapshotVault: undoVaultLocation(),
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
  try {
    response.json({
      machine: await getMachineContext(),
    })
  } catch (error) {
    response.json({
      machine: null,
      error: `${error?.message || error}`,
      stack: String(error?.stack || '').split('\n').slice(0, 4),
    })
  }
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
        // The snapshot is what the dashboard and the relay actually render, so
        // receipts have to travel with it or "see what it touched" stops at the
        // Mac's own /jobs.
        receipts: receiptsForJob(job),
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
                    receipt: item.receipt ?? null,
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
    routing: readRoutingStats(),
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

/*
 * Which tier answered, and what it cost. Every /plan response already carries
 * its own `routing` receipt; this is the rollup across the process, including
 * the measured planner baseline the cheap tiers are compared against.
 */
app.get('/routing', (_request, response) => {
  response.json({ ok: true, routing: readRoutingStats() })
})

/*
 * The execution journal: what ran, in what order, what it touched, how long it
 * took, which tier planned it, and whether it can still be taken back.
 *
 * Every fact here already existed — in the job store, in the receipts, in
 * undo.js, in routingStats — and was never joined, so answering "what did the
 * agent do to my Mac, and can I take it back" meant reading four endpoints and
 * matching them by eye. Derived on read, like /capabilities: nothing in the
 * execution path writes to a journal, so there is no journal to fall behind.
 *
 * GET only, and inert by construction. It reports on work that has already
 * happened; it cannot block, refuse, or delay anything.
 *
 *   /journal?limit=25&type=execute&status=failed&idempotencyKey=act_...
 */
app.get('/journal', (request, response) => {
  const limit = Number.parseInt(String(request.query.limit ?? ''), 10)

  response.json(
    buildExecutionJournal({
      jobs: readJobs(),
      routing: readRoutingStats(),
      limit: Number.isFinite(limit) && limit > 0 ? limit : 25,
      type: String(request.query.type ?? '').trim() || null,
      status: String(request.query.status ?? '').trim() || null,
      idempotencyKey: String(request.query.idempotencyKey ?? '').trim() || null,
      storePath: jobsLocation(),
    }),
  )
})

/* One job, every step, nothing trimmed for a list view. */
app.get('/journal/:jobId', (request, response) => {
  const jobs = readJobs()
  const job = jobs.find((item) => item.jobId === String(request.params.jobId || ''))
  if (!job) {
    response.status(404).json({ ok: false, error: 'Job not found.' })
    return
  }

  response.json({
    ok: true,
    readOnly: true,
    entry: journalEntry(job, { jobs, routing: readRoutingStats() }),
  })
})

/*
 * The host as the agent currently sees it: foreground app, running apps,
 * whether synthesized input actually reaches the screen, open browser sessions,
 * and the configured path roots.
 *
 * This is the context a journal entry happened in. A ui_click receipt says
 * "success" whenever the executor was told success — including when
 * Accessibility is granted to the wrong bundle and the event went nowhere, and
 * including when the frontmost app was not the one the plan assumed. Neither is
 * visible in the journal alone.
 *
 * `permissions` is read with the same quiet call /capabilities uses, so reading
 * this never raises a macOS permission dialog. That report answers "is the TCC
 * checkbox on", which is not the same question as "do synthesized events
 * actually post" — only posting one answers that.
 *
 * `inputReachability` carries the answer without asking for it: the monitor
 * posts a no-op event at startup and on a schedule, so the recorded fact —
 * verified/unverified/failed, the exact bundle tested, the timestamp — is
 * already there. `?probeInput=1` forces a fresh one, still opt-in because a
 * pollable GET should not spawn a helper binary every call.
 */
app.get('/observe', async (request, response) => {
  let permissions
  try {
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

  const wantsProbe = ['1', 'true', 'yes'].includes(
    String(request.query.probeInput ?? '').toLowerCase(),
  )

  /* Goes through the recorder rather than calling uiControl directly, so an
   * on-demand probe and the scheduled one leave the same kind of fact behind
   * instead of one of them being visible only in this response. */
  if (wantsProbe) {
    await probeInputReachability()
  }

  response.json(
    await observeHost({
      permissions,
      browserSessions: listBrowserSessions(),
      inputReachability: getInputReachability(),
    }),
  )
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
      tabTitle: request.body?.tabTitle ?? '',
      tabCount: request.body?.tabCount ?? null,
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

/* Draining the queue used to mean registering a fake extension and polling
 * each command through the real contract, which also left a phantom device in
 * the heartbeat registry. Cleanup should be an interface, not a trick. */
/*
 * The spool and the sweep. Every other sweep in this bridge is a side effect of
 * traffic, and an offline system has none — which is the state that produced a
 * queue of stale commands waiting to fire into the owner's Safari.
 */
registerBrowserBridgeRoutes(app)

/* Plan manifests, and the resume that reads them. Mounted read-mostly: the one
 * write route prepares a plan and explicitly does not execute it. */
registerActionLedgerRoutes(app)

/*
 * The morning brief, and the watches that feed it. Measured on the live shelf
 * before this landed: 50 briefings, all 50 unplayed, 44 of them byte-identical
 * copies rendered in a three-minute window — which had already evicted every
 * brief the owner had not heard.
 */
registerBriefingTriageRoutes(app)

/*
 * Audio expiry, and the sweeper that enforces it. Measured before this landed:
 * 60.4 MB of the owner's audio on disk with nothing expiring it, and 83% of it
 * unreachable by name because MAX_STORED_BRIEFINGS caps a COUNT — evicting the
 * metadata while leaving the file. A sweeper that walked the store would have
 * found one file and called the disk clean.
 */
registerAudioRetentionRoutes(app)

/* Prepare on the Mac, approve from the pendant. Neither route executes. */
registerPrepareApproveRoutes(app)

/*
 * One causal account of a gap. Three surfaces already recorded "handed over,
 * never answered for" and nothing read it: an inflight ledger step, a
 * lease-expired spool entry, a routine dispatched past the reaper window.
 * Filing those as occurred makes the owner skip work that never happened.
 */
registerCatchupRoutes(app)

/* The literal payload, and an approval that names the bytes it approves. */
registerFormPreviewRoutes(app)


registerPageWatchRoutes(app)

/* Give it the goal and let it work out which body should do each part. Decides
 * only — nothing here executes, so a wrong route costs a re-plan, not an
 * action on a real page. */
registerGoalRouterRoutes(app)

/* Named-meeting prep, and the overnight pass that has it ready before the
 * owner asks. Writes no `told` fingerprints, so it never spends one of the
 * morning brief's three spoken slots. */
registerMeetingPrepRoutes(app)

app.delete('/browser/commands/:commandId?', (request, response) => {
  response.json(cancelBrowserCommands(request.params.commandId ?? null))
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

/* Which tab each named browser session points at. See browserSessions.js. */
app.get('/browser/sessions', (_request, response) => {
  response.json({
    ok: true,
    sessions: listBrowserSessions(),
    storePath: browserSessionsLocation(),
  })
})

app.post('/browser/sessions', async (request, response) => {
  try {
    response.json({ ok: true, ...(await openBrowserSession(request.body || {})) })
  } catch (error) {
    response.status(error?.code === 'browser_offline' ? 503 : 409).json({
      ok: false,
      code: error?.code ?? 'browser_error',
      recoverable: Boolean(error?.recoverable),
      error: error.message,
    })
  }
})

app.delete('/browser/sessions/:id', (request, response) => {
  response.json({
    ok: true,
    released: forgetBrowserSession(request.params.id),
  })
})

/*
 * Briefings: read the day, say it, write it down, send nothing. See briefing.js.
 * Reachable directly here and as a compose_briefing action, so "prepare my
 * workday" behaves the same spoken, scheduled, or curled.
 */
app.post('/briefing', async (request, response) => {
  try {
    const kind =
      String(request.body?.kind || '').trim() ||
      matchBriefingCommand(request.body?.command || '') ||
      'morning'
    response.json(
      await runBriefing({ kind, sinks: request.body?.sinks || null }),
    )
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.get('/briefing/kinds', (_request, response) => {
  response.json({ ok: true, kinds: BRIEFING_KINDS })
})

app.get('/briefing/latest', (_request, response) => {
  const briefing = readLatestBriefing()
  if (!briefing) {
    response.status(404).json({ ok: false, error: 'No briefing has been composed yet.' })
    return
  }
  response.json({ ok: true, briefing })
})

/*
 * Research → audio brief. See research.js / audioBrief.js.
 *
 * Distinct from /briefing above: that one reads the owner's own day off this
 * Mac, this one goes out to the public web (or their open tabs), checks what
 * it finds, and leaves a cited note plus audio to play later. Both are here so
 * the capability behaves the same spoken, scheduled, or curled.
 */
app.post('/research', async (request, response) => {
  const topic = String(request.body?.topic || '').trim()
  if (!topic) {
    response.status(400).json({ ok: false, error: 'A topic is required.' })
    return
  }
  try {
    const research = await researchTopic({
      topic,
      mode: String(request.body?.mode || 'brief'),
      match: String(request.body?.match || ''),
      maxSources: Number(request.body?.maxSources) || undefined,
    })
    const { briefing, notePath, audio } = deliverBriefing({
      research,
      openNote: request.body?.openNote === true,
    })
    if (request.body?.playOnMac === true) playBriefingOnMac(briefing)
    /* Audio bytes are never in this body — they are megabytes, and the files
     * on disk are the artifact. /research/briefings/:id/speech serves them. */
    response.json({
      ok: true,
      briefingId: briefing.id,
      topic: briefing.topic,
      mode: briefing.mode,
      headline: briefing.headline,
      spoken: briefing.spoken,
      notePath,
      audioPath: audio.wavPath,
      opusPath: audio.opusPath,
      seconds: audio.seconds,
      sourcesRead: research.sourcesRead,
      sourcesSeen: research.sourcesSeen,
      sources: briefing.sources,
      queries: research.queries,
      durationMs: research.durationMs,
    })
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/research/briefings', (request, response) => {
  response.json({
    ok: true,
    location: briefingsLocation(),
    briefings: listBriefings({ limit: Number(request.query?.limit) || 20 }).map(
      ({ spoken, ...rest }) => rest,
    ),
  })
})

app.get('/research/briefings/:id', (request, response) => {
  const briefing = getBriefing(request.params.id)
  if (!briefing) {
    response.status(404).json({ ok: false, error: 'No such briefing.' })
    return
  }
  response.json({ ok: true, briefing })
})

/* The pendant-format payload, exactly as cloud-relay expects to forward it. */
app.post('/research/briefings/:id/speech', (request, response) => {
  const briefing = getBriefing(request.params.id)
  if (!briefing) {
    response.status(404).json({ ok: false, error: 'No such briefing.' })
    return
  }
  try {
    if (request.body?.onMac === true) playBriefingOnMac(briefing)
    const pendantSpeech = pendantSpeechForBriefing(briefing)
    markBriefingPlayed(briefing.id)
    response.json({
      ok: true,
      briefingId: briefing.id,
      response: briefing.spoken,
      pendantSpeech,
    })
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message })
  }
})

/* Routines: work the owner is not waiting for. See routines.js. */
app.get('/routines', (_request, response) => {
  response.json({ ok: true, routines: listRoutines() })
})

app.post('/routines', (request, response) => {
  try {
    response.json({ ok: true, routine: createRoutine(request.body || {}) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.patch('/routines/:routineId', (request, response) => {
  try {
    const routine = updateRoutine(request.params.routineId, request.body || {})
    if (!routine) {
      response.status(404).json({ ok: false, error: 'No such routine.' })
      return
    }
    response.json({ ok: true, routine })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.delete('/routines/:routineId', (request, response) => {
  response.json({ ok: deleteRoutine(request.params.routineId) })
})

app.post('/routines/:routineId/run', async (request, response) => {
  try {
    response.json({
      ok: true,
      result: await runRoutine(request.params.routineId, { force: true }),
    })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

/*
 * Quick capture, reminders and focus: the things the owner says to a worn
 * pendant in one breath. Each is one round trip on purpose — a capability that
 * needs two questions answered before it does anything has already failed the
 * person walking past a bike rack.
 */
app.post('/capture', (request, response) => {
  try {
    response.json({ ok: true, ...captureNote(request.body || {}) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.get('/capture', (request, response) => {
  response.json({
    ok: true,
    captures: recallCaptures({
      query: String(request.query.query ?? ''),
      limit: Number(request.query.limit) || 10,
    }),
  })
})

app.delete('/capture/:key', (request, response) => {
  response.json({ ok: forgetCapture(request.params.key) })
})

app.post('/reminders', async (request, response) => {
  try {
    response.json(await scheduleReminder(request.body || {}))
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

/*
 * Tidy is two routes because "show me what will be moved before doing it" is
 * two decisions. The plan id is the whole contract: apply cannot invent one,
 * so nothing moves that the owner has not been shown.
 */
app.post('/tidy/preview', (request, response) => {
  try {
    const plan = planTidy(request.body || {})
    response.json({ ok: true, plan, preview: formatPreview(plan) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.get('/tidy', (_request, response) => {
  response.json({ ok: true, plans: listPlans({}), storePath: tidyPlansLocation() })
})

app.post('/tidy/:planId/apply', (request, response) => {
  try {
    response.json(applyTidy(request.params.planId))
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.post('/tidy/:planId/undo', (request, response) => {
  try {
    response.json(undoTidy(request.params.planId))
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

/*
 * Two-phase, for the small class of operations where the owner asked for it:
 * bulk file moves, deletes, and the browser's inspect-before-act.
 *
 * Read this before adding to it. These routes are ADDITIVE. Nothing on this
 * server started requiring a preview today. POST /execute still runs every
 * action type the moment it arrives — move_path, delete_path, run_shell,
 * browser_click, all of it, with no token, no approval, no expiry. The preview
 * routes exist because the owner asked to be able to look at a bulk sweep
 * before it happens, and the apply routes take an id because "apply what you
 * showed me" only means something if the thing applied is the thing shown.
 *
 * If you are here to add a check that stops /execute until a preview has been
 * read: that is the confirmation broker, and it has been rejected three times.
 */

/* Just look: what is in this folder and what kind of thing is each file. */
app.get('/sweep/survey', (request, response) => {
  try {
    response.json({
      ok: true,
      survey: surveyFolder({
        directory: request.query.directory || undefined,
        staleDays: Number(request.query.staleDays) || undefined,
      }),
    })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

/* What a sweep would do. Writes a plan; moves nothing. */
app.post('/sweep/preview', (request, response) => {
  try {
    const plan = planSweep(request.body || {})
    response.json({ ok: true, plan, preview: formatSweep(plan) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.get('/sweep', (_request, response) => {
  response.json({ ok: true, plans: listSweeps({}), storePath: sweepPlansLocation() })
})

/* The plan the owner was shown, item for item — including what has since been
 * applied to it, so "what did I agree to" and "what happened" are one read. */
app.get('/sweep/:planId', (request, response) => {
  const plan = getSweep(request.params.planId)
  if (!plan) {
    response.status(404).json({ ok: false, error: 'No such sweep plan.' })
    return
  }
  response.json({ ok: true, plan, preview: formatSweep(plan) })
})

/*
 * Do exactly what the preview said. `only` names item ids for the owner who
 * read the list and wants three of the twelve — a selection, not a permission.
 */
app.post('/sweep/:planId/apply', async (request, response) => {
  try {
    response.json(
      await applySweep(request.params.planId, { only: request.body?.only ?? null }),
    )
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.post('/sweep/:planId/undo', async (request, response) => {
  try {
    response.json(await undoSweep(request.params.planId, { runId: request.body?.runId ?? null }))
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

/*
 * A preview of any action list at all, for the caller that wants the affected
 * apps/files/URLs before it commits. Pure description — POST /preview never
 * runs anything, and never records anything /execute consults.
 */
app.post('/preview', (request, response) => {
  const actions = Array.isArray(request.body?.actions) ? request.body.actions : []
  const preview = foreseePlan(actions, { title: request.body?.command || '' })
  response.json({ ok: true, preview, text: formatPlanPreview(preview) })
})

/* Browser phase one: read the page, cite what it says, propose one next step. */
app.post('/browser/inspect', async (request, response) => {
  try {
    const inspection = await inspectPage(request.body || {})
    response.json({ ok: true, inspection, text: formatInspection(inspection) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.get('/browser/inspections', (_request, response) => {
  response.json({
    ok: true,
    inspections: listInspections({}),
    storePath: inspectionsLocation(),
  })
})

app.get('/browser/inspections/:inspectionId', (request, response) => {
  const inspection = getInspection(request.params.inspectionId)
  if (!inspection) {
    response.status(404).json({ ok: false, error: 'No such inspection.' })
    return
  }
  response.json({ ok: true, inspection, text: formatInspection(inspection) })
})

/* Browser phase two: run the proposed step, on the element it described. */
app.post('/browser/inspections/:inspectionId/act', async (request, response) => {
  try {
    response.json(
      await actOnInspection(request.params.inspectionId, {
        text: request.body?.text ?? null,
      }),
    )
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

/*
 * Evidence: where every browser reading came from, and how to delete one.
 *
 * GET is derived on read — expiry and revocation take effect here rather than
 * in a purge someone has to remember to run. The one mutating route removes
 * content and leaves a tombstone; there is no route that removes a row.
 */
app.get('/evidence', (request, response) => {
  response.json(
    buildEvidenceLedger({
      limit: Number(request.query.limit) || 50,
      host: String(request.query.host || '') || null,
      jobs: readJobs(),
    }),
  )
})

app.get('/evidence/:capsuleId', (request, response) => {
  const capsule = presentCapsule(getCapsule(request.params.capsuleId))
  if (!capsule) {
    response.status(404).json({ ok: false, error: 'No such evidence capsule.' })
    return
  }
  response.json({ ok: true, capsule })
})

/* "Forget what you read there." By capsule, by page, or by whole host. */
app.post('/evidence/revoke', (request, response) => {
  try {
    response.json({ ok: true, ...revokeCapsules(request.body || {}) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

/* Housekeeping: drop the bodies of readings that expired long enough ago to be
 * useless to anyone. Explicit, never on a timer — "the text is gone" should
 * always be something somebody asked for. */
app.post('/evidence/sweep', (request, response) => {
  response.json({ ok: true, ...sweepCapsules(request.body || {}) })
})

app.post('/focus', async (request, response) => {
  try {
    response.json({ ok: true, session: await startFocusSession(request.body || {}) })
  } catch (error) {
    response.status(409).json({ ok: false, error: error.message })
  }
})

app.get('/focus', (_request, response) => {
  response.json({ ok: true, ...focusStatus({}) })
})

app.delete('/focus', async (_request, response) => {
  try {
    response.json({ ok: true, session: await endFocusSession({ reason: 'cancelled' }) })
  } catch (error) {
    response.status(404).json({ ok: false, error: error.message })
  }
})

app.get('/day-plan', async (request, response) => {
  try {
    const plan = await buildDayPlan({})
    response.json({
      ok: true,
      ...plan,
      briefing: formatBriefing(plan, { seconds: Number(request.query.seconds) || 30 }),
    })
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/meeting-prep', async (request, response) => {
  try {
    response.json(
      await prepareForNextMeeting({
        withinHours: Number(request.query.withinHours) || 24,
        collect: request.query.collect !== 'false',
      }),
    )
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message })
  }
})

/*
 * Mail triage is a POST because it is work, not a lookup: it reads the mailbox,
 * calls a model for the drafts and writes a folder. The GETs are for reading
 * back a run the owner has already had composed — the review list is a durable
 * artefact, not a response body that scrolls away.
 *
 * Nothing on this surface can send. See mailTriage.js: the sinks are asserted
 * against briefing.js's non-transmitting list and the AppleScript is refused if
 * it contains Mail's `send` verb.
 */
app.post('/mail/triage', async (request, response) => {
  try {
    const body = request.body || {}
    response.json({
      ok: true,
      ...(await triageInbox({
        sinceHours: Number(body.sinceHours) || undefined,
        limit: Number(body.limit) || undefined,
        maxDrafts: body.maxDrafts === undefined ? undefined : Number(body.maxDrafts),
        /* Someone already in the owner's graph is someone whose mail is more
         * likely to be a conversation than a broadcast. */
        knownPeople: readContextGraph()
          .entities.filter((entity) => entity.type === 'Person')
          .map((entity) => entity.name),
      })),
    })
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/mail/triage', (request, response) => {
  response.json({
    ok: true,
    runs: listTriageRuns({ limit: Number(request.query.limit) || 10 }),
    ...mailTriageLocation(),
  })
})

app.get('/mail/triage/:runId', (request, response) => {
  const run = readTriageRun(request.params.runId)
  if (!run) {
    response.status(404).json({ ok: false, error: 'No such triage run.' })
    return
  }
  response.json({ ok: true, run })
})

/* The other end of a meeting from /meeting-prep. See meetingFollowup.js. */
app.post('/meeting-followup', async (request, response) => {
  try {
    const body = request.body || {}
    response.json(
      await prepareMeetingFollowup({
        lookbackHours: Number(body.lookbackHours) || undefined,
        open: body.open !== false,
      }),
    )
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message })
  }
})

app.get('/notifications', async (request, response) => {
  try {
    response.json({
      ok: true,
      ...(await triageNotifications({
        /* People the owner already has in their graph are people whose mail is
         * more likely to matter than a stranger's. */
        knownPeople: readContextGraph()
          .entities.filter((entity) => entity.type === 'Person')
          .map((entity) => entity.name),
        threshold: Number(request.query.threshold) || undefined,
      })),
    })
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message })
  }
})

/*
 * Page watches: "tell me when the status, price, or availability changes" —
 * and stay quiet otherwise. See pageWatch.js.
 */
app.get('/watches', (_request, response) => {
  response.json({
    ok: true,
    watches: listWatches(),
    storePath: pageWatchLocation(),
  })
})

app.post('/watches', (request, response) => {
  try {
    response.json({ ok: true, watch: createWatch(request.body || {}) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

/* Before /watches/:watchId, or "reports" is read as a watch id. */
app.get('/watches/reports', (_request, response) => {
  const reports = pendingReports()
  response.json({
    ok: true,
    reports,
    summary: reports.length
      ? reports.map((report) => report.summary).join(' ')
      : 'Nothing you are watching has changed.',
  })
})

app.get('/watches/:watchId', (request, response) => {
  const watch = getWatch(request.params.watchId)
  if (!watch) {
    response.status(404).json({ ok: false, error: 'No such watch.' })
    return
  }
  response.json({ ok: true, watch })
})

app.patch('/watches/:watchId', (request, response) => {
  try {
    const watch = updateWatch(request.params.watchId, request.body || {})
    if (!watch) {
      response.status(404).json({ ok: false, error: 'No such watch.' })
      return
    }
    response.json({ ok: true, watch })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.delete('/watches/:watchId', (request, response) => {
  response.json({ ok: deleteWatch(request.params.watchId) })
})

app.post('/watches/:watchId/check', async (request, response) => {
  try {
    response.json({ ok: true, ...(await checkWatch(request.params.watchId)) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.post('/watches/:watchId/ack', (request, response) => {
  response.json({
    ok: true,
    acknowledged: acknowledgeReports(request.params.watchId),
  })
})

/*
 * One question, several of the owner's authenticated origins, read at once.
 *
 * The status hint is passed in rather than probed inside the fan-out: this
 * process is the one holding the extension's heartbeat, so it can say up front
 * that Safari is not answering instead of making the first origin discover it
 * by timing out. See originFanOut.js.
 */
app.post('/origins/read', async (request, response) => {
  try {
    response.json(
      await readOrigins({
        ...(request.body || {}),
        browserOnline: getBrowserStatus().online,
      }),
    )
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.get('/origins/budget', (_request, response) => {
  response.json({
    ok: true,
    browserExtension: getBrowserStatus(),
    relayBrowserRemainingMs: relayBudgetRemainingMs(),
  })
})

/*
 * Form fills: populate the page, then stop one click short and hand back the
 * envelope. Nothing here submits. See formFill.js.
 */
app.post('/forms/fill', async (request, response) => {
  try {
    response.json({ ok: true, fill: await fillForm(request.body || {}) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.get('/forms/fills', (_request, response) => {
  response.json({
    ok: true,
    fills: listFills(),
    storePath: formFillLocation(),
  })
})

app.get('/forms/fills/:fillId', (request, response) => {
  const fill = getFill(request.params.fillId)
  if (!fill) {
    response.status(404).json({ ok: false, error: 'No such form fill.' })
    return
  }
  response.json({ ok: true, fill })
})

/*
 * Scoped memory: facts with provenance, and the projection that decides which
 * of them are worth a prompt. See memoryService.js / contextProjection.js.
 */
app.get('/memory/facts', (request, response) => {
  response.json({
    ok: true,
    facts: listFacts({
      kind: request.query.kind || null,
      surface: request.query.surface || null,
      includeExpired: request.query.includeExpired === 'true',
    }),
    storePath: memoryLocation(),
  })
})

app.post('/memory/facts', (request, response) => {
  try {
    response.json({ ok: true, fact: rememberFact(request.body || {}) })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.delete('/memory/facts/:idOrKey', (request, response) => {
  const forgotten = forgetFact(request.params.idOrKey)
  if (!forgotten) {
    response.status(404).json({ ok: false, error: 'No such fact.' })
    return
  }
  response.json({ ok: true, forgotten })
})

/* Browser jobs report normalized claims here, never page text. */
app.post('/memory/browser-findings', (request, response) => {
  try {
    response.json({
      ok: true,
      facts: rememberBrowserFindings(request.body || {}),
    })
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message })
  }
})

app.post('/memory/prune', (request, response) => {
  response.json({ ok: true, ...pruneFacts(request.body || {}) })
})

app.post('/memory/sync-graph', (request, response) => {
  response.json({ ok: true, imported: syncFactsFromContextGraph().length })
})

/*
 * The prompt-facing front door: a surface asks what it needs to know for one
 * task and gets back text, not the store. Reading marks the facts used, which
 * is what lets pruning tell a load-bearing fact from one nobody has read.
 */
app.get('/memory/projection', (request, response) => {
  const projected = projectContext({
    surface: String(request.query.surface || 'voice'),
    task: String(request.query.task || ''),
    budgetTokens: Number(request.query.budgetTokens) || undefined,
    revealSensitive: request.query.revealSensitive === 'true',
    includeWeb: request.query.includeWeb === 'true',
  })
  touchFacts(projected.factIds)
  response.json({ ok: true, ...projected })
})

if (hasSvelteDashboard) {
  // Hashed assets first, so the SPA shell below never answers for /_app/*.
  // `redirect: false` keeps bare /dashboard from 301ing to /dashboard/ — the
  // shell route below answers both, and browsers cache that redirect.
  app.use(
    '/dashboard',
    express.static(svelteDashboardDir, { index: false, redirect: false }),
  )

  // Client-side routing means any path under /dashboard is the same document.
  app.get(['/dashboard', '/dashboard/', '/dashboard/{*splat}'], (request, response) => {
    issueDashboardSession(request, response)
    response.sendFile(svelteDashboardIndex)
  })
}

if (fs.existsSync(distDir)) {
  app.use('/assets', express.static(path.join(distDir, 'assets')))
  app.use(express.static(distDir, { index: false }))

  // Only when the SvelteKit build is absent — an agent on a tree that has not
  // run `build:agent` still gets a dashboard rather than a 404.
  if (!hasSvelteDashboard) {
    app.get(['/dashboard', '/dashboard/'], (request, response) => {
      issueDashboardSession(request, response)
      response.sendFile(path.join(distDir, 'dashboard.html'))
    })
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Pendant Mac Local Agent listening on http://localhost:${PORT}`)
  // Any screenshots left behind by a crashed run die with the old process.
  purgeAllCaptures()
  // Routines only fire while this process is up; start the loop with it.
  startRoutineScheduler()
  // A focus session the owner started before a restart is still owed its alarm.
  resumeFocusSessions().catch((error) => {
    console.warn(`[focus] Could not resume sessions: ${error.message}`)
  })
  // Same deal for page watches: nothing is polled while the Mac is asleep, and
  // the first poll after a restart re-establishes the baseline from the page.
  startPageWatchScheduler()
  // Accessibility trust is per-binary, so it can be lost by a rebuild that
  // nothing else notices — every ui_* step keeps reporting success into
  // nothing. Post a harmless no-op now and on a schedule so the answer is a
  // recorded fact with a bundle and a timestamp, not an inference. Annotation
  // only: this never gates an action.
  startInputReachabilityMonitor({
    onResult: (result) => {
      if (result.status === 'verified') return
      console.warn(
        `[input] Reachability ${result.status} for ${result.host?.bundleId ?? 'this binary'}: ${result.detail}`,
      )
    },
  })
  // Keep retrying: an agent booted during a relay outage must still end up
  // with a live work loop once the relay recovers.
  const launchBridge = () => {
    startBridge().catch((error) => {
      console.error(`[bridge] Fatal error: ${error.message} — retrying in 5s`)
      setTimeout(launchBridge, 5000)
    })
  }
  launchBridge()
  if (hasSvelteDashboard || fs.existsSync(path.join(distDir, 'dashboard.html'))) {
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
    dashboardAvailable:
      hasSvelteDashboard || fs.existsSync(path.join(distDir, 'dashboard.html')),
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
          // Full list for the Realtime fleet harness (capped in fleetContext).
          applications: machine.applications ?? [],
          topApps: (machine.applications ?? []).slice(0, 12),
          // Discovered automation environment (macOS version, Shortcuts,
          // installed CLIs) so the planner never guesses at missing tools.
          automation: machine.automation ?? null,
          timezone: machine.timezone ?? null,
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
