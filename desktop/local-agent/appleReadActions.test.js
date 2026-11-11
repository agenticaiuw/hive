import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeEvents,
  describeReminders,
  listCalendarEventsAction,
  listRemindersAction,
  normalizeEventQuery,
  normalizeReminderQuery,
  relativeDue,
  selectEvents,
  selectReminders,
} from './appleReadActions.js'
import { SUPPORTED_ACTION_TYPES } from './computerControl.js'
import { isKnownActionType } from './llmPlanner.js'
import { classifyAction, effectTierFor } from './actionRisk.js'
import { domainForAction } from './toolDiscovery.js'
import { replaySafetyFor } from './actionLedgerVerify.js'
import { staticReversibility } from './actionReceipts.js'
import { stepTier } from './goalVerdict.js'

/*
 * The reads that job local_bd15c683-ba80-4079-9498-925112883bcd proved were
 * missing. Nothing here touches Reminders.app or Calendar.app: the reader is
 * injected, because what these actions get wrong is filtering, ordering,
 * capping and phrasing — not EventKit, which appleData.js already owns.
 */

const NOW = new Date('2026-08-12T09:00:00-07:00')

const REMINDERS = [
  { id: 'r1', title: 'Pay rent', list: 'Home', due: '2026-08-01T09:00:00-07:00', priority: 1 },
  { id: 'r2', title: 'Call Sam', list: 'Work', due: '2026-08-12T16:00:00-07:00', priority: 0 },
  { id: 'r3', title: 'Book flights', list: 'Work', due: '2026-08-13T09:00:00-07:00', priority: 0 },
  { id: 'r4', title: 'Buy milk', list: 'Groceries', due: null, priority: 0 },
  { id: 'r5', title: 'Renew passport', list: 'Home', due: '2026-09-30T09:00:00-07:00', priority: 0 },
]

test('reminders come back soonest first, with undated items last', () => {
  const query = normalizeReminderQuery({}, NOW)
  const rows = selectReminders(REMINDERS, query, NOW)

  assert.deepEqual(
    rows.items.map((row) => row.title),
    ['Pay rent', 'Call Sam', 'Book flights', 'Renew passport', 'Buy milk'],
  )
  assert.equal(rows.items[0].overdue, true)
  assert.equal(rows.items[1].overdue, false)
  assert.equal(rows.truncated, false)
})

test('a list filter reads that list and not the others', () => {
  const query = normalizeReminderQuery({ list: 'work' }, NOW)
  const rows = selectReminders(REMINDERS, query, NOW)

  assert.deepEqual(
    rows.items.map((row) => row.title),
    ['Call Sam', 'Book flights'],
  )
})

/* The alias exists because sanitizeActions hands params through untouched: a
 * planner that writes `listName` would otherwise have its filter silently
 * dropped and the owner would hear every list read back. */
test('listName is honoured the same as list', () => {
  const query = normalizeReminderQuery({ listName: 'Groceries' }, NOW)
  assert.equal(query.list, 'Groceries')
  assert.deepEqual(
    selectReminders(REMINDERS, query, NOW).items.map((row) => row.title),
    ['Buy milk'],
  )
})

test('a day window keeps the overdue and drops the undated', () => {
  const query = normalizeReminderQuery({ dueWithinDays: 2 }, NOW)
  const rows = selectReminders(REMINDERS, query, NOW)

  assert.deepEqual(
    rows.items.map((row) => row.title),
    ['Pay rent', 'Call Sam', 'Book flights'],
  )
  assert.equal(query.includeUndated, false)
})

test('the cap is a cap, and says so rather than lying about the total', () => {
  const query = normalizeReminderQuery({ limit: 2 }, NOW)
  const rows = selectReminders(REMINDERS, query, NOW)

  assert.equal(rows.items.length, 2)
  assert.equal(rows.total, 5)
  assert.equal(rows.truncated, true)
})

test('limit defaults to 50 and cannot be pushed past 200 or below one', () => {
  assert.equal(normalizeReminderQuery({}, NOW).limit, 50)
  assert.equal(normalizeReminderQuery({ limit: 5000 }, NOW).limit, 200)
  assert.equal(normalizeReminderQuery({ limit: 0 }, NOW).limit, 50)
  assert.equal(normalizeReminderQuery({ limit: 'lots' }, NOW).limit, 50)
})

test('a garbage params object reads as no filter rather than throwing', () => {
  const query = normalizeReminderQuery(null, NOW)
  assert.equal(query.list, null)
  assert.equal(selectReminders(REMINDERS, query, NOW).total, 5)
  assert.equal(selectReminders(null, query, NOW).total, 0)
})

test('the spoken line names a few items and counts the rest', () => {
  const query = normalizeReminderQuery({}, NOW)
  const message = describeReminders(selectReminders(REMINDERS, query, NOW), query, NOW)

  assert.match(message, /^5 open reminders: /)
  assert.match(message, /Pay rent \(overdue\)/)
  assert.match(message, /and 1 more\.$/)
  assert.equal(message.includes('Buy milk'), false)
})

test('an empty read says nothing is open instead of reading as a failure', () => {
  const query = normalizeReminderQuery({ list: 'Home' }, NOW)
  assert.equal(
    describeReminders(selectReminders([], query, NOW), query, NOW),
    'Nothing open in Reminders in Home.',
  )
})

test('relative due dates are spoken, never ISO', () => {
  assert.equal(relativeDue('2026-08-01T09:00:00-07:00', NOW), 'overdue')
  assert.match(relativeDue('2026-08-12T16:00:00-07:00', NOW), /^today /)
  assert.match(relativeDue('2026-08-13T09:00:00-07:00', NOW), /^tomorrow /)
  assert.equal(relativeDue('2026-08-15T09:00:00-07:00', NOW), 'Saturday')
  assert.equal(relativeDue('not a date', NOW), 'no date')
})

test('list_reminders returns a success result built from the injected reader', async () => {
  let asked = null
  const result = await listRemindersAction(
    { type: 'list_reminders', params: { list: 'Work' } },
    {
      readReminders: async (args) => {
        asked = args
        return REMINDERS
      },
      now: NOW,
    },
  )

  assert.deepEqual(asked, {})
  assert.equal(result.ok, true)
  assert.equal(result.status, 'success')
  assert.equal(result.count, 2)
  assert.equal(result.total, 2)
  assert.equal(result.query.list, 'Work')
  assert.match(result.message, /Call Sam/)
})

/* ------------------------------------------------------------- calendar */

const EVENTS = [
  { uid: 'e1', title: 'Standup', start: '2026-08-12T09:30:00-07:00', end: '2026-08-12T09:45:00-07:00', calendar: 'Work' },
  { uid: 'e2', title: 'Family in town', start: '2026-08-12T00:00:00-07:00', end: '2026-08-13T00:00:00-07:00', allDay: true, calendar: 'Home' },
  { uid: 'e3', title: 'Design review', start: '2026-08-12T14:00:00-07:00', end: '2026-08-12T15:00:00-07:00', calendar: 'Work' },
]

test('the default calendar window is the rest of today', () => {
  const query = normalizeEventQuery({}, NOW)
  assert.equal(query.from.getTime(), NOW.getTime())
  assert.equal(query.to.getTime() > NOW.getTime(), true)
  assert.equal(query.to.getDate(), NOW.getDate())
  assert.equal(query.to.getHours(), 23)
})

test('days widens the window and explicit from/to wins over it', () => {
  const week = normalizeEventQuery({ days: 7 }, NOW)
  assert.equal(Math.round((week.to - week.from) / 86_400_000), 7)

  const explicit = normalizeEventQuery(
    { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' },
    NOW,
  )
  assert.equal(explicit.from.toISOString(), '2026-09-01T00:00:00.000Z')
  assert.equal(explicit.to.toISOString(), '2026-09-02T00:00:00.000Z')
})

/* A window that ends before it starts would ask EventKit for nothing and
 * report "nothing on the calendar", which is a wrong answer wearing an
 * ordinary one's clothes. */
test('an inverted window is widened rather than answered', () => {
  const query = normalizeEventQuery(
    { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' },
    NOW,
  )
  assert.equal(query.to.getTime() > query.from.getTime(), true)
})

test('events sort by start, all-day included, and filter by calendar', () => {
  const all = selectEvents(EVENTS, normalizeEventQuery({}, NOW))
  assert.deepEqual(
    all.items.map((row) => row.title),
    ['Family in town', 'Standup', 'Design review'],
  )
  assert.equal(all.items[0].allDay, true)

  const work = selectEvents(EVENTS, normalizeEventQuery({ calendar: 'Work' }, NOW))
  assert.deepEqual(
    work.items.map((row) => row.title),
    ['Standup', 'Design review'],
  )
})

test('the spoken calendar line marks all-day rather than inventing a time', () => {
  const query = normalizeEventQuery({}, NOW)
  const message = describeEvents(selectEvents(EVENTS, query), query, NOW)

  assert.match(message, /^3 events: /)
  assert.match(message, /Family in town \(all day\)/)
  assert.match(message, /Standup at /)

  const empty = describeEvents(selectEvents([], query), query, NOW)
  assert.equal(empty, 'Nothing on the calendar in that window.')
})

test('list_calendar_events asks the reader for the window it computed', async () => {
  let asked = null
  const result = await listCalendarEventsAction(
    { type: 'list_calendar_events', params: { days: 2, limit: 1 } },
    {
      readEvents: async (args) => {
        asked = args
        return EVENTS
      },
      now: NOW,
    },
  )

  assert.equal(asked.from.getTime(), NOW.getTime())
  assert.equal(asked.to.getTime() > NOW.getTime(), true)
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.equal(result.total, 3)
  assert.equal(result.truncated, true)
})

/* ------------------------------------------------------- registration */

/*
 * The registries that have to agree, checked together.
 *
 * The bug being fixed here was not a broken function — it was a capability the
 * executor could dispatch existing nowhere the planner could see it. Adding
 * the action to the switch and stopping there would reproduce the same class
 * of failure one layer down, so every list that has an opinion about an action
 * type is asserted on at once.
 */
for (const type of ['list_reminders', 'list_calendar_events']) {
  test(`${type} is registered everywhere an action type is known`, () => {
    assert.ok(SUPPORTED_ACTION_TYPES.includes(type), 'executor cannot dispatch it')
    assert.ok(isKnownActionType(type), 'the planner would strip it out of a plan')
    assert.equal(domainForAction(type), 'calendar')
    assert.equal(classifyAction({ type, params: {} }).safe, true)
    assert.equal(effectTierFor({ type, params: {} }), 'read')
    assert.equal(stepTier({ type, params: {} }), 'observe')
    assert.equal(replaySafetyFor(type), 'idempotent')
    assert.equal(staticReversibility(type).reversible, 'not-needed')
  })
}

/* The whole point of the pair: the planner is now told what to use instead of
 * AppleScript, in the place it looks when it is choosing. */
test('the reminders tools tell the planner to use them for reads', async () => {
  const { actionDescription } = await import('./llmPlanner.js')
  assert.match(actionDescription('list_reminders'), /reminders READ/i)
  assert.match(actionDescription('list_calendar_events'), /calendar READ/i)
  assert.match(actionDescription('run_applescript'), /list_reminders/)
})
