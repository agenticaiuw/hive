import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OPPORTUNISTIC_TICK_MIN_INTERVAL_MS,
  SCHEDULER_STATE_KEY,
} from './scheduler.js'
import { getStore } from './store/index.js'

/*
 * These run against the in-memory store (no D1 binding in tests), which is the
 * same code path `npm run relay` takes locally.
 */
test('the tick records a heartbeat so a dead schedule is visible', async () => {
  const { runScheduledTick } = await import('./scheduler.js')
  const before = Date.parse('2026-08-07T12:00:00Z')
  const result = await runScheduledTick({ trigger: 'manual', now: before })

  assert.equal(result.trigger, 'manual')
  assert.equal(result.tickedAt, new Date(before).toISOString())
  assert.equal(result.dueCount, 0)

  const store = await getStore()
  const state = await store.getState(SCHEDULER_STATE_KEY)
  // Without this row the only way to notice the clock stopped is to miss a
  // briefing, which is exactly how long a broken schedule stays invisible.
  assert.equal(state.data.tickedAt, new Date(before).toISOString())
  assert.equal(state.updatedBy, 'scheduler:manual')
})

test('an empty tick claims nothing and asks nothing about the Mac', async () => {
  const { runScheduledTick } = await import('./scheduler.js')
  const result = await runScheduledTick({ trigger: 'cron' })
  assert.equal(result.ranCount, 0)
  assert.equal(result.macOnline, false)
  // The Free plan gives a cron invocation 10 ms of CPU. The 1,439 minutes a
  // day with nothing due must stay one indexed query and a heartbeat write.
  assert.ok(result.durationMs < 500, `empty tick took ${result.durationMs}ms`)
})

test('a routine due right now is picked up and run by the tick', async () => {
  const { runScheduledTick } = await import('./scheduler.js')
  const { createRoutine } = await import('./routines.js')
  const store = await getStore()

  const routine = createRoutine({
    name: 'Status check',
    command: 'is the site up?',
    schedule: { kind: 'interval', everyMs: 3_600_000 },
    venue: 'relay',
  })
  await store.saveRoutine({ ...routine, nextRunAt: Date.now() - 1 })

  const result = await runScheduledTick({ trigger: 'cron' })
  assert.equal(result.dueCount, 1)
  assert.equal(result.runs.length, 1)
  // No OPENAI_API_KEY in the test environment, so the compose step fails —
  // what matters is that the tick claimed it, ran it, and filed a receipt
  // rather than losing the occurrence.
  assert.ok(['completed', 'failed'].includes(result.runs[0].status))
  const runs = await store.listRoutineRuns({ limit: 5 })
  assert.equal(runs[0].routineId, routine.routineId)
  const stored = await store.getRoutine(routine.routineId)
  assert.ok(stored.nextRunAt > Date.now(), 'the routine rearmed itself')

  await store.deleteRoutine(routine.routineId)
})

test('traffic ticks rate-limit themselves off the shared heartbeat', async () => {
  const { maybeTickOnTraffic, runScheduledTick } = await import('./scheduler.js')
  // A fresh tick means the next request must not spend a second one: the Mac
  // bridge polls every few seconds and this hook is on that path.
  await runScheduledTick({ trigger: 'manual' })
  assert.equal(await maybeTickOnTraffic({ now: Date.now() }), null)

  // Far enough past the heartbeat, a request does drive the schedule — this
  // is the cover for a cron that stops firing without any other symptom.
  const later = Date.now() + OPPORTUNISTIC_TICK_MIN_INTERVAL_MS + 1
  const ticked = await maybeTickOnTraffic({ now: later })
  assert.equal(ticked?.trigger, 'traffic')
})

test('the heartbeat separates "will be fine in a minute" from "the owner was told"', async () => {
  const { runScheduledTick } = await import('./scheduler.js')
  const { createRoutine, RETRY_MAX_ATTEMPTS, occurrenceKey } = await import('./routines.js')
  const store = await getStore()

  const routine = createRoutine({
    name: 'Nightly build check',
    command: 'check whether the nightly build passed',
    schedule: { kind: 'interval', everyMs: 3_600_000 },
    venue: 'mac',
  })
  // Parked in the future: this exercises the reaper, which needs no network
  // and no API key, so the counts are the same on every machine.
  await store.saveRoutine({ ...routine, nextRunAt: Date.now() + 3_600_000 })
  await store.createJob({
    jobId: 'job_sched_fail',
    type: 'plan',
    status: 'failed',
    error: 'the build server refused the connection',
    createdAt: new Date().toISOString(),
  })
  const dueAt = new Date().toISOString()
  const run = {
    runId: 'run_sched_1',
    routineId: routine.routineId,
    routineName: routine.name,
    status: 'dispatched',
    startedAt: dueAt,
    dueAt,
    attempt: 1,
    macJobId: 'job_sched_fail',
    occurrenceKey: occurrenceKey(routine.routineId, dueAt),
  }
  await store.recordRoutineRun(run)

  const retrying = await runScheduledTick({ trigger: 'manual' })
  assert.equal(retrying.retryingCount, 1)
  assert.equal(retrying.failedCount, 0)

  // Same failure with the retry budget spent: now it is news.
  await store.recordRoutineRun({ ...run, status: 'dispatched', attempt: RETRY_MAX_ATTEMPTS })
  const done = await runScheduledTick({ trigger: 'manual' })
  assert.equal(done.retryingCount, 0)
  assert.equal(done.failedCount, 1)

  const state = await store.getState(SCHEDULER_STATE_KEY)
  assert.equal(state.data.failedCount, 1)

  await store.deleteRoutine(routine.routineId)
})

test('the receipt log answers "what happened to the thing I asked for"', async () => {
  const { registerSchedulerRoutes } = await import('./scheduler.js')
  const { createRoutine, occurrenceKey } = await import('./routines.js')
  const store = await getStore()

  const routine = createRoutine({
    name: 'Summarize the contract',
    command: 'summarize the contract in my downloads folder',
    schedule: { kind: 'once', inMs: 60_000 },
  })
  await store.saveRoutine(routine)

  const dueAt = new Date(Date.now() - 60_000).toISOString()
  const key = occurrenceKey(routine.routineId, dueAt)
  for (const [index, attempt] of [1, 2].entries()) {
    await store.recordRoutineRun({
      runId: `run_receipt_${attempt}`,
      routineId: routine.routineId,
      status: attempt === 2 ? 'completed' : 'failed',
      startedAt: new Date(Date.now() - 60_000 + index).toISOString(),
      dueAt,
      attempt,
      occurrenceKey: key,
      final: attempt === 2,
    })
  }

  // A route table stand-in: the real one is wired in server.js, which this
  // module deliberately does not import (it would drag Express into the cron).
  const routes = new Map()
  registerSchedulerRoutes({
    get(path, handler) {
      routes.set(path, handler)
    },
  })

  let body = null
  await routes.get('/v1/routines/:routineId/runs')(
    { params: { routineId: routine.routineId }, query: {} },
    {
      json(payload) {
        body = payload
      },
      status() {
        return this
      },
    },
  )

  assert.equal(body.ok, true)
  // Two attempts, one occurrence. Flattened, this reads as a task that ran
  // twice — which is the opposite of what the retry guarantees.
  assert.equal(body.occurrences.length, 1)
  assert.deepEqual(
    body.occurrences[0].attempts.map((run) => run.attempt),
    [1, 2],
  )
  assert.equal(body.occurrences[0].status, 'completed')
  assert.equal(body.occurrences[0].settled, true)

  let missing = null
  await routes.get('/v1/routines/:routineId/runs')(
    { params: { routineId: 'rtn_nope' }, query: {} },
    {
      json(payload) {
        missing = payload
      },
      status(code) {
        missing = { code }
        return this
      },
    },
  )
  assert.equal(missing.ok, false)

  await store.deleteRoutine(routine.routineId)
})

test('a parked run is neither a failure nor a retry on the heartbeat, and it is announced', async () => {
  const { runScheduledTick } = await import('./scheduler.js')
  const { createRoutine, occurrenceKey } = await import('./routines.js')
  const store = await getStore()

  const routine = createRoutine({
    name: 'Morning news',
    command: 'give me the top headlines',
    schedule: { kind: 'daily', at: '07:00' },
    venue: 'mac',
  })
  const rearmedFor = Date.now() + 3_600_000
  await store.saveRoutine({ ...routine, nextRunAt: rearmedFor })
  /* The Mac produced a plan and parked it for approval (new bridge dialect). */
  await store.createJob({
    jobId: 'job_sched_parked',
    type: 'plan',
    status: 'plan_ready',
    result: {
      executed: false,
      parked: true,
      phase: 'parked_for_approval',
      awaitingApproval: [
        { type: 'send_email', reason: 'Sending email acts on your behalf and needs approval.' },
      ],
    },
    createdAt: new Date().toISOString(),
  })
  const dueAt = new Date().toISOString()
  await store.recordRoutineRun({
    runId: 'run_sched_parked',
    routineId: routine.routineId,
    routineName: routine.name,
    status: 'dispatched',
    startedAt: dueAt,
    dueAt,
    attempt: 1,
    macJobId: 'job_sched_parked',
    occurrenceKey: occurrenceKey(routine.routineId, dueAt),
  })

  const tick = await runScheduledTick({ trigger: 'manual' })
  /* The incident heartbeat read failed=1 retrying=1 for a plan that was
   * simply waiting on its owner. Each number now answers its own question. */
  assert.equal(tick.awaitingApprovalCount, 1)
  assert.equal(tick.failedCount, 0)
  assert.equal(tick.retryingCount, 0)
  assert.equal(tick.closed[0].status, 'awaiting-approval')
  assert.equal(tick.closed[0].final, true)

  const state = await store.getState(SCHEDULER_STATE_KEY)
  assert.equal(state.data.awaitingApprovalCount, 1)

  // Announced loudly, and the routine was left armed for its schedule — no
  // backoff, no second planner call.
  const announcements = await store.listAnnouncements({ limit: 50 })
  const parked = announcements.find((entry) => entry.runId === 'run_sched_parked')
  assert.ok(parked, 'the parked routine must be announced')
  assert.match(parked.speech, /needs your approval/)
  assert.equal(parked.priority, 'high')
  const stored = await store.getRoutine(routine.routineId)
  assert.equal(stored.nextRunAt, rearmedFor)

  // A second tick must not announce or close it again: the run is settled.
  const again = await runScheduledTick({ trigger: 'manual', now: Date.now() + 61_000 })
  assert.equal(again.awaitingApprovalCount, 0)
  assert.equal(
    (await store.listAnnouncements({ limit: 50 })).filter(
      (entry) => entry.runId === 'run_sched_parked',
    ).length,
    1,
  )

  await store.deleteRoutine(routine.routineId)
})
