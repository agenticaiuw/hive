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

  const summary = {
    trigger,
    tickedAt: new Date(now).toISOString(),
    durationMs: Date.now() - started,
    dueCount: claimedCount,
    ranCount: runs.length,
    closedCount: closed.length,
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
        ` closed=${closed.length} macOnline=${macOnline} in ${summary.durationMs}ms`,
    )
  }
  return { ...summary, runs, closed }
}
