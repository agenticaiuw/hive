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
