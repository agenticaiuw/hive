import assert from 'node:assert/strict'
import test from 'node:test'

import {
  scoreEvent,
  scoreMail,
  scoreReminder,
  triageNotifications,
  TRIAGE_THRESHOLD,
} from './notificationTriage.js'

const NOW = new Date('2026-08-07T09:00:00')

const mail = (subject, sender, receivedAt = '2026-08-07T08:30:00') => ({
  subject,
  sender,
  receivedAt,
  read: false,
})

test('a plain unread note from a person is not important on its own', () => {
  const { score } = scoreMail(mail('Lunch sometime?', 'Dana Ruiz <dana@example.com>'), { now: NOW })
  assert.ok(
    score < TRIAGE_THRESHOLD,
    `"only what's important" means the default is silence (scored ${score})`,
  )
})

test('a deadline in the subject clears the bar', () => {
  const { score, reasons } = scoreMail(
    mail('Action required: lease renewal deadline Friday', 'Property Mgmt <ops@example.com>'),
    { now: NOW },
  )
  assert.ok(score >= TRIAGE_THRESHOLD)
  assert.ok(reasons.includes('names a deadline or an action'))
})

test('marketing is pushed below the bar even when it shouts', () => {
  const { score } = scoreMail(
    mail('URGENT: 50% off ends tonight — unsubscribe', 'no-reply@deals.example.com'),
    { now: NOW },
  )
  assert.ok(score < TRIAGE_THRESHOLD, `a bulk sender outweighs its own urgency (scored ${score})`)
})

test('someone the owner actually knows gets through', () => {
  const { score, reasons } = scoreMail(
    mail('Re: can you send the slides?', 'Jorge Roji Pezzoli <jorge@example.com>'),
    { now: NOW, knownPeople: ['jorge'] },
  )
  assert.ok(score >= TRIAGE_THRESHOLD)
  assert.ok(reasons.includes('someone you know'))
})

test('three days unread is the owner’s own verdict on it', () => {
  const fresh = scoreMail(mail('Contract for signature', 'legal@example.com', '2026-08-07T08:00:00'), { now: NOW })
  const stale = scoreMail(mail('Contract for signature', 'legal@example.com', '2026-08-01T08:00:00'), { now: NOW })
  assert.ok(stale.score < fresh.score)
})

test('a meeting inside the hour outranks everything else', () => {
  const soon = scoreEvent(
    { title: 'Interview', start: '2026-08-07T09:30:00', end: '2026-08-07T10:00:00', attendees: ['a', 'b'] },
    { now: NOW },
  )
  assert.ok(soon.score >= TRIAGE_THRESHOLD)
  assert.equal(soon.minutesAway, 30)

  const later = scoreEvent(
    { title: 'Lab meeting', start: '2026-08-07T16:00:00', end: '2026-08-07T17:00:00', attendees: [] },
    { now: NOW },
  )
  assert.ok(later.score < TRIAGE_THRESHOLD, 'this afternoon is not an interruption')
})

test('past due is important, someday is not', () => {
  assert.ok(scoreReminder({ title: 'Pay rent', due: '2026-08-05T09:00:00', priority: 0 }, { now: NOW }).score >= TRIAGE_THRESHOLD)
  assert.ok(scoreReminder({ title: 'Learn Rust', due: null, priority: 0 }, { now: NOW }).score < TRIAGE_THRESHOLD)
})

test('triage reports what it suppressed, so silence is accountable', async () => {
  const result = await triageNotifications(
    { now: NOW, knownPeople: ['jorge'] },
    {
      readMail: async () => [
        mail('Action required: sign the lease by Friday', 'ops@example.com'),
        mail('50% off everything', 'no-reply@deals.example.com'),
        mail('Weekly digest', 'newsletter@example.com'),
        mail('Lunch sometime?', 'Dana <dana@example.com>'),
      ],
      readEvents: async () => [
        { title: 'Interview', start: '2026-08-07T09:30:00', end: '2026-08-07T10:00:00', allDay: false, attendees: ['a', 'b'], location: '' },
      ],
      readReminders: async () => [{ title: 'Pay rent', due: '2026-08-05T09:00:00', priority: 0 }],
    },
  )

  assert.equal(result.important.length, 3)
  assert.equal(result.suppressed, 3)
  assert.equal(result.important[0].kind, 'calendar', 'the thing starting in 30 minutes leads')
  assert.ok(!result.spoken.includes('50% off'))
  assert.match(result.spoken, /skipped 3/)
})

test('one dead source does not take the others down', async () => {
  const result = await triageNotifications(
    { now: NOW },
    {
      readMail: async () => {
        throw new Error('Mail is not running')
      },
      readEvents: async () => [
        { title: 'Interview', start: '2026-08-07T09:15:00', end: '2026-08-07T10:00:00', allDay: false, attendees: ['a', 'b'], location: '' },
      ],
      readReminders: async () => [],
    },
  )

  assert.equal(result.important.length, 1)
  assert.deepEqual(result.unavailable, ['Mail is not running'])
})

test('nothing important says nothing important', async () => {
  const result = await triageNotifications(
    { now: NOW },
    {
      readMail: async () => [mail('Weekly digest', 'newsletter@example.com')],
      readEvents: async () => [],
      readReminders: async () => [],
    },
  )
  assert.equal(result.important.length, 0)
  assert.match(result.spoken, /Nothing important/)
})

test('every source empty at once is reported as blind, not as a quiet morning', async () => {
  /*
   * Mail and EventKit both answer [] when the process has no Automation grant
   * rather than throwing, so `unavailable` stays empty and the read looks
   * successful. This Mac has no grant today, which makes it the live case and
   * not a hypothetical. "Nothing waiting for you" is the reassuring reading,
   * and the reassuring reading is the one that gets an owner in trouble.
   */
  const blind = await triageNotifications(
    { now: NOW },
    { readMail: async () => [], readEvents: async () => [], readReminders: async () => [] },
  )

  assert.equal(blind.important.length, 0)
  assert.match(blind.spoken, /came back empty at once|could not read/i)
  assert.doesNotMatch(
    blind.spoken,
    /\bnothing waiting for you\b|\bnone of them need you\b/i,
    `an unreadable scan must not be announced as a clear one: ${blind.spoken}`,
  )
})

test('a genuinely quiet scan still says so', async () => {
  /* The fix must not turn every empty result into an alarm: something was read,
   * it just did not matter. That is a real answer and stays one. */
  const quiet = await triageNotifications(
    { now: NOW },
    {
      readMail: async () => [
        { subject: 'Your receipt', sender: 'noreply@shop.example', receivedAt: NOW.toISOString() },
      ],
      readEvents: async () => [],
      readReminders: async () => [],
    },
  )

  assert.equal(quiet.important.length, 0)
  assert.doesNotMatch(quiet.spoken, /came back empty at once/i)
})
