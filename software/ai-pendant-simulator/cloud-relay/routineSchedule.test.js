import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TIMEZONE,
  MIN_INTERVAL_MS,
  describeSchedule,
  instantForZonedTime,
  isValidTimezone,
  nextRunAt,
  normalizeSchedule,
  zonedParts,
} from './routineSchedule.js'

const iso = (ms) => new Date(ms).toISOString()

test('daily schedules fire on the owner clock, not the Worker UTC clock', () => {
  // 2026-08-07 04:00 UTC is 2026-08-06 23:00 in Chicago (CDT, UTC-5).
  const from = Date.parse('2026-08-07T04:00:00Z')
  const due = nextRunAt({ kind: 'daily', at: '07:00' }, from)
  // The next 7am Chicago is 12:00 UTC on the 7th — a naive UTC setHours(7)
  // would have answered 07:00Z, two hours early and on the wrong local day.
  assert.equal(iso(due), '2026-08-07T12:00:00.000Z')
  assert.equal(zonedParts(due, DEFAULT_TIMEZONE).hour, 7)
})

test('a daily routine that just fired gets tomorrow, never an instant re-run', () => {
  const at7 = Date.parse('2026-08-07T12:00:00Z')
  const next = nextRunAt({ kind: 'daily', at: '07:00' }, at7)
  assert.equal(iso(next), '2026-08-08T12:00:00.000Z')
})

test('daily schedules keep their wall-clock hour across a DST transition', () => {
  // US DST ends 2026-11-01. A 07:00 Chicago routine is 12:00 UTC before and
  // 13:00 UTC after; sampling the offset once would drift the whole week.
  const before = nextRunAt(
    { kind: 'daily', at: '07:00' },
    Date.parse('2026-10-30T13:00:00Z'), // 08:00 Chicago, CDT
  )
  const after = nextRunAt(
    { kind: 'daily', at: '07:00' },
    Date.parse('2026-11-01T13:00:00Z'), // 07:00 Chicago, CST
  )
  assert.equal(iso(before), '2026-10-31T12:00:00.000Z')
  assert.equal(iso(after), '2026-11-02T13:00:00.000Z')
  assert.equal(zonedParts(before, DEFAULT_TIMEZONE).hour, 7)
  assert.equal(zonedParts(after, DEFAULT_TIMEZONE).hour, 7)
})

test('an explicit timezone overrides the default', () => {
  const due = nextRunAt(
    { kind: 'daily', at: '07:00', timezone: 'Asia/Tokyo' },
    Date.parse('2026-08-07T00:00:00Z'),
  )
  assert.equal(zonedParts(due, 'Asia/Tokyo').hour, 7)
  assert.equal(iso(due), '2026-08-07T22:00:00.000Z')
})

test('weekly schedules cover "every weekday at 5"', () => {
  // 2026-08-07 is a Friday. From Friday evening the next weekday 17:00 is
  // Monday, not Saturday.
  const fridayEvening = Date.parse('2026-08-07T23:00:00Z') // 18:00 Chicago
  const due = nextRunAt(
    { kind: 'weekly', at: '17:00', days: ['weekdays'] },
    fridayEvening,
  )
  const parts = zonedParts(due, DEFAULT_TIMEZONE)
  assert.equal(parts.weekday, 'mon')
  assert.equal(parts.hour, 17)
  assert.equal(iso(due), '2026-08-10T22:00:00.000Z')
})

test('weekday aliases and long day names normalize to the same schedule', () => {
  const long = normalizeSchedule({
    kind: 'weekly',
    at: '17:00',
    days: ['Monday', 'tuesday', 'WED', 'thurs', 'Friday'],
  })
  const alias = normalizeSchedule({ kind: 'weekly', at: '17:00', days: 'weekdays' })
  assert.ok(long.ok && alias.ok)
  assert.deepEqual(long.schedule.days, alias.schedule.days)
  assert.deepEqual(alias.schedule.days, ['mon', 'tue', 'wed', 'thu', 'fri'])
})

test('interval schedules are floored at a minute — the cron cannot resolve faster', () => {
  const normalized = normalizeSchedule({ kind: 'interval', everyMs: 5_000 })
  assert.equal(normalized.schedule.everyMs, MIN_INTERVAL_MS)
  assert.equal(nextRunAt({ kind: 'interval', everyMs: 5_000 }, 1_000), 61_000)
})

test('once schedules are spent after they fire', () => {
  const at = '2026-08-07T15:00:00.000Z'
  assert.equal(iso(nextRunAt({ kind: 'once', at }, Date.parse(at) - 1)), at)
  assert.equal(nextRunAt({ kind: 'once', at }, Date.parse(at)), null)
})

test('unusable schedules are rejected with a reason instead of silently never firing', () => {
  assert.match(normalizeSchedule({ kind: 'daily', at: '25:00' }).error, /HH:MM/)
  assert.match(normalizeSchedule({ kind: 'weekly', at: '07:00' }).error, /days/)
  assert.match(normalizeSchedule({ kind: 'interval' }).error, /everyMs/)
  assert.match(normalizeSchedule({ kind: 'yearly' }).error, /schedule must be/)
  assert.equal(nextRunAt({ kind: 'yearly' }), null)
})

test('an unknown timezone falls back to the default rather than throwing', () => {
  assert.equal(isValidTimezone('Not/AZone'), false)
  const normalized = normalizeSchedule({
    kind: 'daily',
    at: '07:00',
    timezone: 'Not/AZone',
  })
  assert.equal(normalized.schedule.timezone, DEFAULT_TIMEZONE)
})

test('zoned wall-clock round-trips through the instant it names', () => {
  const instant = instantForZonedTime(
    { year: 2026, month: 8, day: 7, hour: 7, minute: 30 },
    DEFAULT_TIMEZONE,
  )
  const parts = zonedParts(instant, DEFAULT_TIMEZONE)
  assert.deepEqual(
    [parts.year, parts.month, parts.day, parts.hour, parts.minute],
    [2026, 8, 7, 7, 30],
  )
})

test('schedules describe themselves for receipts', () => {
  assert.equal(
    describeSchedule({ kind: 'daily', at: '7:00' }),
    `every day at 07:00 ${DEFAULT_TIMEZONE}`,
  )
  assert.equal(
    describeSchedule({ kind: 'weekly', at: '17:00', days: ['weekdays'] }),
    `every weekday at 17:00 ${DEFAULT_TIMEZONE}`,
  )
  assert.equal(describeSchedule({ kind: 'interval', everyMs: 3_600_000 }), 'every 1 hour')
  assert.equal(describeSchedule({ kind: 'interval', everyMs: 1_800_000 }), 'every 30 minutes')
})
