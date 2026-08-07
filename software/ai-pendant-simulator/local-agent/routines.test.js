import assert from 'node:assert/strict'
import test from 'node:test'

import { WEEKDAYS, nextRunAt } from './routines.js'

/*
 * These are all about nextRunAt, which is pure — no store, no workspace, so no
 * isolation shim is needed here. The routine store itself is exercised through
 * capabilityGaps.test.js with injected deps.
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
