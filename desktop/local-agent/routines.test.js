import assert from 'node:assert/strict'
import test from 'node:test'

/* Importing routines.js pulls in config.js, which resolves the workspace path
 * at import time; the shim points it at a throwaway dir first, per convention.
 * nextRunAt and routineFinishStatus are both pure and touch no store. */
import './testWorkspace.js'
import { WEEKDAYS, nextRunAt, routineFinishStatus } from './routines.js'

/*
 * These are all about nextRunAt, which is pure — no store, no workspace.
 * routineFinishStatus is exercised at the bottom; the routine store itself is
 * exercised through capabilityGaps.test.js with injected deps.
 *
 * Local time is deliberate: a routine is a wall-clock promise ("every weekday
 * at 7"), so every expectation below is written in the machine's own zone the
 * way the owner would say it.
 */
const at = (iso) => new Date(iso).getTime()
const local = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]
  }`
}

test('a weekday routine skips the weekend instead of firing on Saturday', () => {
  /* The bug this shape exists to prevent: stored as `daily`, a Friday evening
   * "every weekday at 7" fires Saturday morning about a work portal nobody is
   * looking at, and the owner believes it is correct. */
  const friday = at('2026-08-07T18:00:00')
  assert.equal(
    local(nextRunAt({ kind: 'weekly', at: '07:00', days: WEEKDAYS }, friday)),
    '2026-08-10 07:00 Mon',
  )

  const saturday = at('2026-08-08T09:00:00')
  assert.equal(
    local(nextRunAt({ kind: 'weekly', at: '07:00', days: WEEKDAYS }, saturday)),
    '2026-08-10 07:00 Mon',
  )
})

test('later today still counts, and a time already gone does not', () => {
  const thursdayEarly = at('2026-08-06T05:00:00')
  assert.equal(
    local(nextRunAt({ kind: 'weekly', at: '07:00', days: WEEKDAYS }, thursdayEarly)),
    '2026-08-06 07:00 Thu',
  )

  const thursdayLate = at('2026-08-06T09:00:00')
  assert.equal(
    local(nextRunAt({ kind: 'weekly', at: '07:00', days: WEEKDAYS }, thursdayLate)),
    '2026-08-07 07:00 Fri',
  )
})

test('the wall-clock hour survives a DST change', () => {
  /*
   * 2026-11-01 is the US fall-back Sunday, so the day it steps over is 25 hours
   * long. Adding a fixed number of milliseconds would land at 06:00 and quietly
   * move a promise the owner made in wall-clock terms.
   */
  const beforeFallBack = at('2026-10-31T18:00:00')
  assert.equal(
    local(nextRunAt({ kind: 'weekly', at: '07:00', days: WEEKDAYS }, beforeFallBack)),
    '2026-11-02 07:00 Mon',
  )

  /* 2026-03-08 is the spring-forward Sunday: a 23-hour day. */
  const beforeSpringForward = at('2026-03-06T18:00:00')
  assert.equal(
    local(nextRunAt({ kind: 'weekly', at: '07:00', days: WEEKDAYS }, beforeSpringForward)),
    '2026-03-09 07:00 Mon',
  )
})

test('a single day works, and the search wraps the week', () => {
  const monday = at('2026-08-10T12:00:00')
  /* Sunday is the furthest point from Monday afternoon: six steps forward. */
  assert.equal(
    local(nextRunAt({ kind: 'weekly', at: '07:00', days: [0] }, monday)),
    '2026-08-16 07:00 Sun',
  )
})

test('a weekly schedule naming no usable day returns null rather than guessing', () => {
  /* Silently falling back to daily is exactly the Saturday bug, reintroduced
   * through the error path. */
  const friday = at('2026-08-07T18:00:00')
  for (const days of [[], undefined, [9], ['mon'], [null]]) {
    assert.equal(nextRunAt({ kind: 'weekly', at: '07:00', days }, friday), null, String(days))
  }
})

test('duplicate days do not change the answer', () => {
  const friday = at('2026-08-07T18:00:00')
  assert.equal(
    nextRunAt({ kind: 'weekly', at: '07:00', days: [1, 1, 1, 2] }, friday),
    nextRunAt({ kind: 'weekly', at: '07:00', days: [1, 2] }, friday),
  )
})

test('daily and interval are unchanged', () => {
  const saturday = at('2026-08-08T09:00:00')
  assert.equal(local(nextRunAt({ kind: 'daily', at: '07:00' }, saturday)), '2026-08-09 07:00 Sun')

  const now = at('2026-08-07T12:00:00')
  assert.equal(nextRunAt({ kind: 'interval', everyMs: 300_000 }, now), now + 300_000)
  /* The one-minute floor is what keeps a bad number from becoming a spin. */
  assert.equal(nextRunAt({ kind: 'interval', everyMs: 1 }, now), now + 60_000)

  assert.equal(nextRunAt({ kind: 'nonsense' }, now), null)
  assert.equal(nextRunAt(null, now), null)
})

/*
 * routineFinishStatus — the persisted status a routine run gets.
 *
 * The incident this pins: orchestrateExecute returns { ok:false, status } for
 * a failed, blocked, or goal-not-met run WITHOUT throwing, so the old
 * "did not throw → completed" recorded those as completed. This must mirror
 * jobTracker.executeFinishStatus exactly, including 'incomplete' by name.
 */
test('an instant plan (no execute step) completes: nothing ran to fail', () => {
  assert.deepEqual(routineFinishStatus({ ok: true, plan: {} }), {
    status: 'completed',
    error: null,
  })
})

test('a successful execute completes with no error', () => {
  assert.deepEqual(
    routineFinishStatus({ ok: true, executed: { ok: true, status: 'success' } }),
    { status: 'completed', error: null },
  )
})

test('a goal-not-met run is incomplete by name, with the run’s sentence', () => {
  const executed = {
    ok: false,
    status: 'incomplete',
    error: 'Opened the page and looked at it — nothing was cancelled.',
    response: 'Opened the page and looked at it — nothing was cancelled.',
  }
  assert.deepEqual(routineFinishStatus({ ok: true, executed }), {
    status: 'incomplete',
    error: 'Opened the page and looked at it — nothing was cancelled.',
  })
})

test('a failed run is failed, with lastError from the response summary', () => {
  /* A plain failure carries no `error` field (only 'incomplete' does), so the
   * summary in `response` is what names it. */
  const executed = { ok: false, status: 'failed', response: 'The step could not run.' }
  assert.deepEqual(routineFinishStatus({ ok: true, executed }), {
    status: 'failed',
    error: 'The step could not run.',
  })
})

test('a blocked run is failed too — it is not done', () => {
  const executed = { ok: false, status: 'blocked', response: 'Blocked for safety.' }
  assert.deepEqual(routineFinishStatus({ ok: true, executed }), {
    status: 'failed',
    error: 'Blocked for safety.',
  })
})

test('a non-completed run with neither error nor response still records null, not undefined', () => {
  const executed = { ok: false, status: 'failed' }
  assert.deepEqual(routineFinishStatus({ ok: true, executed }), {
    status: 'failed',
    error: null,
  })
})
