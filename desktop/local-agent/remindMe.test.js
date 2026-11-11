import assert from 'node:assert/strict'
import test from 'node:test'

import { parseReminderRequest, scheduleReminder, toRruleDays } from './remindMe.js'

const MONDAY_NOON = new Date('2026-08-03T12:00:00')

function writers() {
  const calls = { reminders: [], recurring: [] }
  return {
    calls,
    seams: {
      create: async (spec) => {
        calls.reminders.push(spec)
        return { title: spec.title, due: spec.due?.toISOString?.() ?? spec.due, id: 'rem_1' }
      },
      addRecurring: async (spec) => {
        calls.recurring.push(spec)
        return {
          uid: 'evt_1',
          title: spec.title,
          recurrence: `FREQ=WEEKLY;INTERVAL=1;BYDAY=${spec.byDay.join(',')}`,
          firstOccurrence: '2026-08-04T09:00:00.000Z',
        }
      },
    },
  }
}

test('"Remind me to do X at 6 pm" is a one-off with a due time today', () => {
  const parsed = parseReminderRequest('Remind me to call the landlord at 6 pm', {
    now: MONDAY_NOON,
  })
  assert.equal(parsed.repeat, null)
  assert.equal(parsed.title, 'call the landlord')
  assert.equal(parsed.due.getHours(), 18)
  assert.equal(parsed.due.getDate(), MONDAY_NOON.getDate())
})

test('"Every weekday at 9" is a repeat, and the recurrence phrase is not part of the title', () => {
  const parsed = parseReminderRequest('Every weekday at 9, remind me to stand up', {
    now: MONDAY_NOON,
  })
  assert.deepEqual(parsed.repeat.days, [1, 2, 3, 4, 5])
  assert.equal(parsed.repeat.at, '09:00', 'a standing morning promise, not 21:00')
  assert.equal(parsed.title, 'stand up')
  assert.equal(parsed.due, null)
})

test('a single named day repeats only on that day', () => {
  const parsed = parseReminderRequest('Every Friday at 4pm remind me to file my timesheet', {
    now: MONDAY_NOON,
  })
  assert.deepEqual(parsed.repeat.days, [5])
  assert.equal(parsed.repeat.at, '16:00')
  assert.equal(parsed.title, 'file my timesheet')
})

test('"every day" with no clock lands on a sane default', () => {
  const parsed = parseReminderRequest('every day remind me to take my meds', { now: MONDAY_NOON })
  assert.deepEqual(parsed.repeat.days, [0, 1, 2, 3, 4, 5, 6])
  assert.equal(parsed.repeat.at, '09:00')
})

test('"every evening" defaults to the evening, not the morning', () => {
  const parsed = parseReminderRequest('every evening remind me to lock up', { now: MONDAY_NOON })
  assert.equal(parsed.repeat.at, '20:00')
})

test('a one-off goes to Reminders and nothing else', async () => {
  const { calls, seams } = writers()
  const result = await scheduleReminder(
    { text: 'Remind me to call the landlord at 6 pm', now: MONDAY_NOON },
    seams,
  )

  assert.equal(result.kind, 'one-off')
  assert.equal(calls.reminders.length, 1)
  assert.equal(calls.recurring.length, 0)
  assert.equal(calls.reminders[0].title, 'call the landlord')
  assert.match(result.spoken, /6 pm/)
})

test('a repeat goes to the OS recurrence rule and never creates a one-off', async () => {
  const { calls, seams } = writers()
  const result = await scheduleReminder(
    { text: 'Every weekday at 9, remind me to stand up', now: MONDAY_NOON },
    seams,
  )

  assert.equal(result.kind, 'recurring')
  assert.equal(calls.reminders.length, 0, 'a repeat must not also fire once now')
  assert.deepEqual(calls.recurring[0].byDay, ['MO', 'TU', 'WE', 'TH', 'FR'])
  assert.equal(result.recurrence, 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR')
  assert.match(result.spoken, /every weekday at 9 am/)
})

test('day indexes map to the codes macOS stores', () => {
  assert.deepEqual(toRruleDays([1, 2, 3, 4, 5]), ['MO', 'TU', 'WE', 'TH', 'FR'])
  assert.deepEqual(toRruleDays([5]), ['FR'])
  assert.deepEqual(toRruleDays([]), ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'])
})

test('an ask with no subject is refused rather than becoming an empty reminder', () => {
  assert.throws(() => parseReminderRequest('   '), /Nothing to be reminded/)
})
