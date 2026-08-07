/*
 * The relay's clock: what a Cron Trigger actually does when it fires.
 *
 * Kept separate from routines.js (which is pure policy, fully injectable) and
 * from server.js (which would drag Express into a scheduled invocation) so
 * that the one thing running under the tightest budget in this codebase is
 * also the smallest file.
 *
 * THE BUDGET, because it explains every odd choice below: a Cron Trigger on
 * the Workers Free plan gets **10 ms of CPU** per invocation. Wall clock is 15
 * minutes and awaiting I/O costs no CPU, so a tick may spend a minute waiting
 * on a web search — but it may not spend 10 ms *computing*. Consequences:
 *
 *   1. Nothing heavy is imported at module scope. openaiRealtimeVoice.js is
 *      56 KB of source; evaluating it on a cold isolate is CPU the tick does
 *      not have. Both heavy modules load lazily, and only when a routine
 *      that needs them is actually due — which, 1,439 minutes out of 1,440,
 *      is never.
 *   2. The empty tick is one indexed D1 query and a heartbeat write.
 *   3. No audio is rendered here. Announcements carry text; the PCM and the
 *      Opus encoding happen at delivery time inside the WebSocket
 *      invocation, which has a real CPU budget and is the only place that
 *      knows whether anyone is listening.
 */
import { getStore } from './store/index.js'
import { createPlanJob } from './jobs.js'
import { runDueRoutines, reapDispatchedRuns } from './routines.js'

export const SCHEDULER_STATE_KEY = 'scheduler'

/* Matches isDeviceOnline() in server.js — one definition of "awake" for the
 * whole relay, or the dashboard and the scheduler will disagree about the Mac. */
const DEVICE_ONLINE_MS = 90_000

async function macIsOnline(store) {
  const devices = await store.listDevices().catch(() => [])
  return devices.some(
    (device) =>
      device?.deviceType === 'mac_bridge' &&
      Date.now() - new Date(device.lastSeenAt || 0).getTime() < DEVICE_ONLINE_MS,
  )
}

/*
 * Lazy because of budget rule 1. serverBrowser.js and openaiRealtimeVoice.js
 * are only reachable from a relay-venue routine, and a tick with nothing due
 * must never pay to parse them.
 */
async function relayReadPage(url, options) {
  const { readPublicPage } = await import('./serverBrowser.js')
  return readPublicPage(url, options)
}

async function relayWebSearch(query) {
  const { runWebSearch } = await import('./openaiRealtimeVoice.js')
  return runWebSearch(query)
}

/*
 * A Mac-venue routine becomes an ordinary queued plan job. No plannerHint, so
 * local-agent/bridge.js takes the same branch a typed dashboard command takes
 * — callLocalAgent('/plan') then execute — which is exactly what
 * local-agent/routines.js does with orchestratePlan/orchestrateExecute. The
 * routine therefore behaves identically whichever side declared it; only the
 * clock moved.
 */
async function enqueueRoutineMacJob(store, { routine, receipt }) {
  const job = createPlanJob({
    command: routine.command,
    deviceId: 'relay-scheduler',
    sessionId: null,
    inputTelemetry: {
      storage: 'routine',
      inputMode: 'routine',
      routineId: routine.routineId,
      routineName: routine.name,
      runId: receipt.runId,
    },
  })
  await store.createJob(job)
  return job
}

/**
 * One tick. Safe to call from the cron, from the manual admin route, or from
 * a test — `trigger` is the only thing that differs, and it lands on every
 * receipt so a run's provenance is never a guess.
 */
export async function runScheduledTick({
  trigger = 'cron',
  now = Date.now(),
  limit = 8,
  logger = console,
} = {}) {
  const store = await getStore()
  const started = Date.now()

  const { runs, macOnline, claimedCount } = await runDueRoutines({
    store,
    now,
    trigger,
    limit,
    isMacOnline: () => macIsOnline(store),
    readPage: relayReadPage,
    webSearch: relayWebSearch,
    enqueueMacJob: (input) => enqueueRoutineMacJob(store, input),
    logger,
  })

  /* Mac-dispatched runs finish asynchronously; this is where their answers
   * become announcements. Cheap when there are none (one indexed query). */
  const closed = await reapDispatchedRuns({ store, now }).catch((error) => {
    logger?.warn?.(`[scheduler] reap failed: ${error?.message || error}`)
    return []
  })

  /*
   * Retries are counted separately from failures on purpose. A tick reporting
   * ranCount=1 failed=1 looks like a broken schedule; the same tick reporting
   * retryingCount=1 is a schedule doing its job. Without the distinction the
   * heartbeat cannot tell "it will be fine in a minute" from "the owner was
   * just told it will never happen" — and those want opposite reactions.
   */
  const attempted = [...runs, ...closed]
  const retryingCount = attempted.filter(
    (run) => run.status === 'failed' && run.final === false,
  ).length
  const failedCount = attempted.filter(
    (run) => ['failed', 'missed'].includes(run.status) && run.final !== false,
  ).length

  const summary = {
    trigger,
    tickedAt: new Date(now).toISOString(),
    durationMs: Date.now() - started,
    dueCount: claimedCount,
    ranCount: runs.length,
    closedCount: closed.length,
    retryingCount,
    failedCount,
    macOnline,
    statuses: runs.map((run) => `${run.routineId}:${run.status}`),
  }

  /*
   * The liveness record. Without it "did the Cron Trigger actually fire?" can
   * only be answered by waiting for a routine to be due, which is a terrible
   * way to find out the schedule is broken.
   */
  await store
    .saveState(SCHEDULER_STATE_KEY, summary, { updatedBy: `scheduler:${trigger}` })
    .catch(() => {})

  if (claimedCount || closed.length) {
    logger?.log?.(
      `[scheduler] tick trigger=${trigger} due=${claimedCount} ran=${runs.length}` +
        ` closed=${closed.length} retrying=${retryingCount} failed=${failedCount}` +
        ` macOnline=${macOnline} in ${summary.durationMs}ms`,
    )
  }
  return { ...summary, runs, closed }
}

/**
 * The receipt log for one scheduled task: every attempt, in order, with why
 * the retries stopped.
 *
 * GET /v1/routines already returns the newest 25 receipts across ALL routines,
 * which answers "is the scheduler alive" and not "what happened to the thing I
 * asked for" — with a handful of routines the one you care about is off the
 * end of the list. The Mac agent has had /jobs/:jobId/receipts since the
 * beginning; this is the same question asked of the half that stays awake.
 *
 * Exported as a registration function rather than written into server.js so
 * the route table stays that file's business.
 */
export function registerSchedulerRoutes(app) {
  app.get('/v1/routines/:routineId/runs', async (request, response) => {
    const store = await getStore()
    const routineId = String(request.params.routineId || '')
    const routine = await store.getRoutine(routineId)
    if (!routine) {
      response.status(404).json({ ok: false, error: 'Routine not found.' })
      return
    }

    const limit = Math.min(Math.max(Number(request.query?.limit) || 25, 1), 100)
    const runs = await store.listRoutineRuns({ routineId, limit })

    /* Grouped by occurrence, because that is the unit the owner asked for.
     * Three receipts for one 7am briefing is one thing that happened, not
     * three — flattening them reads as a routine that fired three times. */
    const occurrences = new Map()
    for (const run of runs) {
      const key = run.occurrenceKey || `${routineId}#${run.dueAt || run.startedAt}`
      if (!occurrences.has(key)) {
        occurrences.set(key, { occurrenceKey: key, dueAt: run.dueAt ?? null, attempts: [] })
      }
      occurrences.get(key).attempts.push(run)
    }
    for (const occurrence of occurrences.values()) {
      occurrence.attempts.sort((a, b) => Number(a.attempt || 1) - Number(b.attempt || 1))
      const last = occurrence.attempts.at(-1)
      occurrence.status = last?.status ?? null
      occurrence.settled = last?.final !== false
      occurrence.nextAttemptAt = last?.nextAttemptAt ?? null
    }

    response.json({
      ok: true,
      routine,
      runs,
      occurrences: [...occurrences.values()],
      observedAt: new Date().toISOString(),
    })
  })

  return app
}

/*
 * A second clock, riding traffic the relay already serves.
 *
 * The Cron Trigger is the clock that works when nobody is around, and it is
 * the only one that can keep a 7am promise in a silent house. But it is a
 * single point of failure for the entire feature — a misconfigured trigger, a
 * plan limit, or a Cloudflare-side hiccup and every routine stops with no
 * symptom other than nothing happening. That failure mode is invisible, which
 * is the worst kind.
 *
 * So any request that reaches the relay also nudges the schedule. It costs no
 * extra invocation (it runs in waitUntil, after the response is already on its
 * way) and no extra latency. The Mac bridge alone polls every few seconds, so
 * in practice the schedule stays live whenever anything at all is awake.
 *
 * It does NOT replace the cron: an idle pendant holds a WebSocket and sends
 * no requests, so a quiet night produces no traffic to ride.
 */
export const OPPORTUNISTIC_TICK_MIN_INTERVAL_MS = 60_000
let lastOpportunisticAttemptAt = 0

export async function maybeTickOnTraffic({ now = Date.now(), logger = console } = {}) {
  /*
   * Isolate-local gate first: this runs on EVERY request, so the common case
   * must be a number comparison and nothing else. Without it a 5-second
   * bridge poll would put a D1 read on the relay's busiest path.
   */
  if (now - lastOpportunisticAttemptAt < OPPORTUNISTIC_TICK_MIN_INTERVAL_MS) {
    return null
  }
  lastOpportunisticAttemptAt = now

  try {
    const store = await getStore()
    /* Durable gate second: many isolates serve this Worker and each has its
     * own counter, so the shared heartbeat is what actually rate-limits. */
    const state = await store.getState(SCHEDULER_STATE_KEY)
    const lastTickAt = Date.parse(state?.data?.tickedAt || '') || 0
    if (now - lastTickAt < OPPORTUNISTIC_TICK_MIN_INTERVAL_MS) return null
    return await runScheduledTick({ trigger: 'traffic', now, logger })
  } catch (error) {
    logger?.warn?.(`[scheduler] traffic tick failed: ${error?.message || error}`)
    return null
  }
}
