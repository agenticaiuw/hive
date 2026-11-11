import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDayPlan,
  findConflicts,
  findTransitions,
  formatBriefing,
  isVirtualLocation,
  rankTasks,
} from './dayPlan.js'

const NOW = new Date('2026-08-07T08:00:00')

const event = (title, start, end, location = null, extra = {}) => ({
  uid: title,
  title,
  start: new Date(`2026-08-07T${start}:00`).toISOString(),
  end: new Date(`2026-08-07T${end}:00`).toISOString(),
  allDay: false,
  location,
  notes: null,
  attendees: [],
  ...extra,
})

test('a Zoom link is not a place you travel to', () => {
  assert.equal(isVirtualLocation('https://uwmadison.zoom.us/j/96172295958'), true)
  assert.equal(isVirtualLocation('Google Meet'), false, 'only the link form is unambiguous')
  assert.equal(isVirtualLocation('meet.google.com/abc-defg'), true)
  assert.equal(isVirtualLocation(''), true, 'no location means nowhere to go')
  assert.equal(isVirtualLocation('Union South, Madison'), false)
})

test('a tight gap between two real places is flagged; two video calls are not', () => {
  const transitions = findTransitions([
    event('Standup', '09:00', '09:15', 'https://zoom.us/j/1'),
    event('Design review', '09:20', '10:00', 'https://zoom.us/j/2'),
    event('Lunch with Dana', '10:10', '11:00', 'Graze, 1 S Pinckney St'),
  ])

  assert.equal(transitions[0].tight, false, 'zoom to zoom is a click, not a commute')
  assert.equal(transitions[1].tight, true)
  assert.equal(transitions[1].gapMinutes, 10)
  assert.equal(transitions[1].movesPlace, true)
})

test('a generous gap to a real place is not flagged as tight', () => {
  const [transition] = findTransitions([
    event('Standup', '09:00', '09:15', 'https://zoom.us/j/1'),
    event('Lunch', '12:00', '13:00', 'Graze'),
  ])
  assert.equal(transition.tight, false)
  assert.equal(transition.gapMinutes, 165)
})

test('overlapping events are reported as conflicts', () => {
  const conflicts = findConflicts([
    event('Interview', '09:00', '10:00'),
    event('Dentist', '09:30', '10:30'),
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].a, 'Interview')
  assert.equal(conflicts[0].b, 'Dentist')
})

test('critical means overdue, due today, or explicitly prioritised — not merely open', () => {
  const ranked = rankTasks(
    [
      { title: 'Pay rent', due: '2026-08-05T09:00:00', priority: 0 },
      { title: 'Move trash cans', due: null, priority: 0 },
      { title: 'Ask Dan for interview', due: '2026-08-07T17:00:00', priority: 0 },
      { title: 'Someday learn Rust', due: null, priority: 9 },
    ],
    NOW,
  )

  assert.equal(ranked[0].title, 'Pay rent')
  assert.equal(ranked[0].overdue, true)
  assert.equal(ranked[1].title, 'Ask Dan for interview')
  assert.equal(ranked[1].dueToday, true)
  assert.equal(
    ranked.find((task) => task.title === 'Move trash cans').critical,
    false,
    'an open task with no date is not a crisis',
  )
  assert.equal(
    ranked.find((task) => task.title === 'Someday learn Rust').critical,
    false,
    'priority 9 is low priority in EventKit',
  )
})

test('the briefing fits inside the seconds it was promised', async () => {
  const plan = await buildDayPlan(
    { now: NOW },
    {
      readEvents: async () => [
        event('Standup', '09:00', '09:15', 'https://zoom.us/j/1'),
        event('Interview with Jorge', '10:00', '11:00', 'https://zoom.us/j/2'),
        event('Lunch with Dana', '11:10', '12:00', 'Graze, 1 S Pinckney St'),
        event('Lab meeting', '14:00', '15:00', 'Discovery Building'),
      ],
      readReminders: async () => [
        { title: 'Pay rent', due: '2026-08-05T09:00:00', priority: 0 },
        { title: 'Ask Dan for interview', due: '2026-08-07T17:00:00', priority: 0 },
      ],
    },
  )

  const briefing = formatBriefing(plan, { seconds: 30, now: NOW })
  assert.ok(briefing.words <= briefing.budgetWords, `${briefing.words} > ${briefing.budgetWords}`)
  assert.ok(briefing.estimatedSeconds <= 30)
  assert.match(briefing.text, /Standup/)
  assert.match(briefing.text, /Pay rent/)
})

test('a briefing never stops mid-sentence — it drops whole lines', async () => {
  const plan = await buildDayPlan(
    { now: NOW },
    {
      readEvents: async () =>
        Array.from({ length: 8 }, (_unused, index) => {
          const hour = String(9 + index).padStart(2, '0')
          return event(`Meeting number ${index}`, `${hour}:00`, `${hour}:45`, 'Somewhere Real')
        }),
      readReminders: async () => [],
    },
  )

  // Eight seconds does not fit two sentences; the second must be dropped whole.
  const briefing = formatBriefing(plan, { seconds: 8, now: NOW })
  assert.ok(briefing.droppedLines > 0, JSON.stringify(briefing))
  assert.ok(briefing.text.endsWith('.'), briefing.text)
  assert.ok(!briefing.text.includes('You are done after'), 'the dropped line went whole')
})

test('both sources empty is reported as unreadable, never as a free day', async () => {
  /*
   * This used to assert /clear/ and passed for the wrong reason even after the
   * behaviour was corrected — the replacement sentence contains the word in
   * "I am not going to tell you the day is clear when I cannot see it". A test
   * that a regression would also satisfy is not pinning anything, so this
   * asserts the distinction itself.
   *
   * The distinction is the point: appleData.js cannot tell an unauthorised
   * EventKit read from an empty one, because both return []. Answering in the
   * reassuring direction is how an owner skips a meeting they were told they
   * did not have.
   */
  const plan = await buildDayPlan(
    { now: NOW },
    { readEvents: async () => [], readReminders: async () => [] },
  )
  const briefing = formatBriefing(plan, { now: NOW })

  assert.match(briefing.text, /could not read/i)
  assert.doesNotMatch(
    briefing.text,
    /\b(?:your calendar is clear|nothing is overdue|you are free|nothing needs you)\b/i,
    `an unreadable calendar must not be announced as an empty one: ${briefing.text}`,
  )
})

test('all-day events shape the day without pretending to have a time', async () => {
  const plan = await buildDayPlan(
    { now: NOW },
    {
      readEvents: async () => [
        { ...event('父親節', '00:00', '23:59'), allDay: true },
        event('Standup', '09:00', '09:15'),
      ],
      readReminders: async () => [],
    },
  )

  assert.equal(plan.events.length, 1, 'the timed list stays timed')
  assert.equal(plan.allDayEvents.length, 1)
  assert.match(formatBriefing(plan, { now: NOW }).text, /All day/)
})
