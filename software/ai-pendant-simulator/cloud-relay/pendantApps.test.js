import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyAction, effectTierFor } from '../local-agent/actionRisk.js'
import {
  CALENDAR_SCRIPT,
  REMINDERS_SCRIPT,
  appBriefSpeech,
  appFetchingSpeech,
  appMacPlan,
  calendarBriefSpeech,
  eventClock,
  macFailure,
  macStdout,
  parseEventLines,
  parseReminderLines,
  remindersBriefSpeech,
  timeSpeech,
} from './pendantApps.js'

const T0 = Date.parse('2026-08-12T22:42:00.000Z')

/* ------------------------------------------------------------------ Time */

test('Time answers from the pendant’s own LTE clock when it has one', () => {
  /* 15:42 local on a UTC-7 pendant. The Mac could be asleep, off, or in
   * another city; the thing on the owner’s chest knows what time it is. */
  const deviceTime = { utcMs: T0, offsetMinutes: -420 }
  assert.equal(timeSpeech({ now: T0, timezone: 'Europe/Berlin', deviceTime }), "It's 3:42 PM.")
})

test('Time falls back to the Mac’s timezone, then to UTC, and always answers', () => {
  assert.equal(timeSpeech({ now: T0, timezone: 'America/Los_Angeles' }), "It's 3:42 PM.")
  assert.equal(timeSpeech({ now: T0, timezone: 'Asia/Tokyo' }), "It's 7:42 AM.")
  assert.equal(timeSpeech({ now: T0 }), "It's 10:42 PM, UTC.")
  /* A junk timezone must not throw on the one app whose whole job is to
   * always have an answer. */
  assert.match(timeSpeech({ now: T0, timezone: 'Mars/Olympus' }), /^It's \d/)
})

test('Time never reads the timezone name out loud', () => {
  const spoken = timeSpeech({ now: T0, timezone: 'America/Los_Angeles' })
  assert.ok(!/Pacific|PDT|America/.test(spoken), spoken)
})

test('midnight and noon are spoken as 12, not 0', () => {
  const midnight = Date.parse('2026-08-12T00:05:00.000Z')
  assert.equal(timeSpeech({ now: midnight, timezone: 'UTC' }), "It's 12:05 AM.")
  const noon = Date.parse('2026-08-12T12:00:00.000Z')
  assert.equal(timeSpeech({ now: noon, timezone: 'UTC' }), "It's 12:00 PM.")
})

/* ------------------------------------------------ the hands-free contract */

/*
 * THE LOAD-BEARING TEST OF THIS FILE.
 *
 * Both app scripts must classify as READS on the Mac's own risk model, or
 * entering Reminders parks an approval in front of a question the owner asked
 * out loud — on a device with no screen to approve it on. This test imports
 * the real local-agent/actionRisk.js rather than asserting a belief about it,
 * because the two modules ship independently and the failure is silent: the
 * brief simply never speaks.
 */
test('both app scripts execute hands-free on the Mac, as reads', () => {
  for (const app of ['reminders', 'calendar']) {
    const plan = appMacPlan(app)
    for (const action of plan.actions) {
      assert.deepEqual(classifyAction(action), { safe: true }, `${app}/${action.type} is not hands-free`)
    }
    const script = plan.actions.find((action) => action.type === 'run_applescript')
    assert.ok(script, `${app} has no script`)
    assert.equal(effectTierFor(script), 'read', `${app} is not a read`)
  }
  /* Calendar's plan opens the app FIRST — measured: with Calendar quit, every
   * form of the query fails instantly with "Application isn't running (-600)",
   * and an in-script `launch` is classified as an app launch and would need
   * approval. open_app is on the hands-free allowlist, so the pair still runs
   * without a prompt. */
  assert.deepEqual(
    appMacPlan('calendar').actions.map((action) => action.type),
    ['open_app', 'run_applescript'],
  )
  assert.deepEqual(
    appMacPlan('reminders').actions.map((action) => action.type),
    ['run_applescript'],
  )
  assert.equal(appMacPlan('time'), null)
})

test('the calendar script bounds itself to today without assigning to a date property', () => {
  /* `set hours of dayStart to 0` is the exact line that makes actionRisk call
   * this a WRITE against Calendar. Subtracting the time-of-day gets the same
   * midnight and stays a read. */
  assert.ok(!/set\s+hours\s+of/i.test(CALENDAR_SCRIPT))
  assert.match(CALENDAR_SCRIPT, /time of \(current date\)/)
  assert.ok(!/system events/i.test(REMINDERS_SCRIPT))
})

/* ------------------------------------------------------------- Reminders */

test('reminder lines parse, and "missing value" is not a due date', () => {
  const items = parseReminderLines(
    'Call the vet|Wednesday, August 12, 2026 at 5:00:00 PM\nBuy tickets|missing value\n\n  \n',
  )
  assert.deepEqual(items, [
    { title: 'Call the vet', due: 'Wednesday, August 12, 2026 at 5:00:00 PM' },
    { title: 'Buy tickets', due: null },
  ])
})

test('an empty Reminders app gets an honest sentence, not silence', () => {
  assert.equal(remindersBriefSpeech([]), 'No open reminders.')
  assert.equal(remindersBriefSpeech(parseReminderLines('')), 'No open reminders.')
})

test('the reminders brief speaks three and counts the rest', () => {
  const one = remindersBriefSpeech([{ title: 'Call the vet' }])
  assert.equal(one, 'One open reminder: Call the vet.')

  const many = remindersBriefSpeech(
    ['Call the vet', 'Buy tickets', 'Renew passport', 'Fix the bike', 'Email Sam'].map((title) => ({ title })),
  )
  /* Five titles read out is a list nobody can hold; three plus a count is a
   * brief, which is what the owner asked for by entering the app. */
  assert.equal(many, '5 open reminders: Call the vet, Buy tickets and Renew passport, and 2 more.')
})

/* -------------------------------------------------------------- Calendar */

test('the event clock reads both Mac locales', () => {
  assert.equal(eventClock('Wednesday, August 12, 2026 at 3:00:00 PM'), '3 PM')
  assert.equal(eventClock('12 August 2026 at 15:30:00'), '3:30 PM')
  assert.equal(eventClock('12 August 2026 at 09:05:00'), '9:05 AM')
  assert.equal(eventClock('Wednesday, August 12, 2026 at 12:00:00 AM'), '12 AM')
  assert.equal(eventClock('no time in here'), null)
})

test('an empty day gets an honest sentence too', () => {
  assert.equal(calendarBriefSpeech([]), 'Nothing on your calendar today.')
})

test('the calendar brief leads with the clock, because that is what is asked', () => {
  const events = parseEventLines(
    [
      'Wednesday, August 12, 2026 at 9:00:00 AM|Standup',
      'Wednesday, August 12, 2026 at 1:30:00 PM|Design review',
      'Wednesday, August 12, 2026 at 4:00:00 PM|1:1 with Sam',
      'Wednesday, August 12, 2026 at 6:00:00 PM|Dinner',
    ].join('\n'),
  )
  assert.equal(
    calendarBriefSpeech(events),
    '4 things today: 9 AM, Standup, 1:30 PM, Design review and 4 PM, 1:1 with Sam, and 1 more.',
  )
})

test('an event title containing a pipe survives the split', () => {
  const events = parseEventLines('12 August 2026 at 10:00:00|Ops | oncall handoff')
  assert.deepEqual(events, [{ when: '12 August 2026 at 10:00:00', title: 'Ops | oncall handoff' }])
})

/* ---------------------------------------------------- what the Mac posted */

test('the AppleScript output is found in every shape the Mac posts back', () => {
  assert.equal(macStdout({ results: [{ ok: true, stdout: 'a|b\n', message: 'done' }] }), 'a|b\n')
  assert.equal(macStdout({ results: [{ ok: true, message: 'a|b\n' }] }), 'a|b\n')
  /* trimMacResultForModel stringifies long entries; a brief must still read
   * them rather than reporting the Mac silent. */
  assert.equal(macStdout({ results: [JSON.stringify({ ok: true, stdout: 'a|b\n' })] }), 'a|b\n')
  assert.equal(macStdout({ response: 'plain answer' }), 'plain answer')
})

test('"the Mac answered nothing" and "the Mac did not answer" are different facts', () => {
  /* null means no answer; empty-string stdout means an answer that is empty,
   * and those two get different sentences below. */
  assert.equal(macStdout({ results: [] }), null)
  assert.equal(macStdout({ results: [{ ok: false, message: 'no access' }] }), null)
  assert.equal(macStdout({ results: [{ ok: true, stdout: '' }], response: '' }), '')
  assert.equal(macFailure({ executionError: 'Reminders is not running' }), 'Reminders is not running')
  assert.equal(macFailure({ results: [{ ok: false, message: 'no access' }] }), 'no access')
  assert.equal(macFailure({ results: [{ ok: true, stdout: 'x' }] }), null)
})

test('a sleeping Mac is said out loud, and a failure is said differently', () => {
  assert.match(appBriefSpeech('reminders', null), /Your Mac hasn't answered yet/)
  assert.match(appBriefSpeech('calendar', null), /calendar when it wakes up/)
  assert.equal(
    appBriefSpeech('reminders', { executionError: 'Reminders is not running' }),
    "I couldn't read your reminders from your Mac.",
  )
})

test('the whole reminders path, from posted result to spoken sentence', () => {
  const result = {
    executed: true,
    results: [{ ok: true, status: 'success', stdout: 'Call the vet|missing value\nBuy tickets|missing value\n' }],
  }
  assert.equal(appBriefSpeech('reminders', result), '2 open reminders: Call the vet and Buy tickets.')
})

test('the whole calendar path, including a genuinely empty day', () => {
  const empty = { executed: true, results: [{ ok: true, status: 'success', stdout: '   \n' }] }
  /* An empty stdout is an ANSWER: the day is clear. Reporting "your Mac
   * hasn't answered" here would be the relay lying about a working read. */
  assert.equal(appBriefSpeech('calendar', empty), 'Nothing on your calendar today.')
})

/*
 * The Calendar plan runs open_app BEFORE the script, so its results array now
 * leads with a receipt that has no stdout. A single-pass reader would return
 * "Opened Calendar" and the owner would hear that parsed as their schedule.
 */
test('an open_app receipt is never mistaken for the script’s answer', () => {
  const result = {
    executed: true,
    results: [
      { ok: true, status: 'success', message: 'Opened Calendar' },
      {
        ok: true,
        status: 'success',
        stdout: 'Wednesday, August 12, 2026 at 9:00:00 AM|Standup\n',
        message: 'AppleScript completed.',
      },
    ],
  }
  assert.equal(appBriefSpeech('calendar', result), 'One thing today: 9 AM, Standup.')
})

test('a clear day is still read from the script, not from the app-launch receipt', () => {
  const result = {
    executed: true,
    results: [
      { ok: true, status: 'success', message: 'Opened Calendar' },
      { ok: true, status: 'success', stdout: '', message: 'AppleScript completed.' },
    ],
  }
  assert.equal(appBriefSpeech('calendar', result), 'Nothing on your calendar today.')
})

/*
 * Sixteen seconds is the MEASURED Reminders round trip on the owner's Mac.
 * Sixteen seconds of silence on a screenless device is indistinguishable from
 * a dead knob, and the grammar's rule is that nothing lands silently.
 */
test('entering a Mac-backed app says where it is looking before it waits', () => {
  /*
   * "Checking your Mac", not "Checking your reminders" (2026-08-13). The ring
   * now speaks the app's name and its how-to on entry — "Reminders. Yellow to
   * check again." — so naming the app again here made it the third mention in
   * four seconds. What this line has to add is the part the owner cannot
   * guess: the wait belongs to ANOTHER MACHINE, and the pendant has not
   * frozen. Both apps say the same thing for the same reason, which is why
   * they are asserted equal rather than separately.
   */
  assert.equal(appFetchingSpeech('reminders'), 'Checking your Mac.')
  assert.equal(appFetchingSpeech('calendar'), 'Checking your Mac.')
})

test('the reminders script bulk-fetches instead of looping over app objects', () => {
  /* The per-item form (`repeat with r in (every reminder …)` then `name of r`)
   * never returned on the owner's Mac — killed at 40 s. One bulk property read
   * plus a LOCAL loop returns the same data in ~16 s. */
  assert.match(REMINDERS_SCRIPT, /set titles to name of \(every reminder whose completed is false\)/)
  assert.ok(!/repeat with r in \(every reminder/.test(REMINDERS_SCRIPT))
})
