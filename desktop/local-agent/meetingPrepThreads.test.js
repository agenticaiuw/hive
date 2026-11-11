import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildThreads,
  meetingThreadHistory,
  normalizeSubject,
  ownerAddressesFrom,
  parseAddress,
  parseThreadEnvelopes,
  readThreadEnvelopes,
  samePerson,
  summarizeThread,
  threadsForMeeting,
} from './meetingPrepThreads.js'

const FIELD = String.fromCharCode(31)
const RECORD = String.fromCharCode(30)

function envelope({ mailbox = 'inbox', sender, subject, sentAt, account = 'iCloud' }) {
  return { account, mailbox, sentAt, sender, messageId: `${subject}@${sentAt}`, subject }
}

const CONVERSATION = [
  envelope({
    sender: 'Jorge Roji <jorge@example.com>',
    subject: 'Pendant firmware',
    sentAt: '2026-08-01T09:00:00',
  }),
  envelope({
    mailbox: 'sent',
    sender: 'Evan Liu <evan@example.com>',
    subject: 'Re: Pendant firmware',
    sentAt: '2026-08-02T09:00:00',
  }),
  envelope({
    sender: 'Jorge Roji <jorge@example.com>',
    subject: 'Re: Re: Pendant firmware',
    sentAt: '2026-08-05T09:00:00',
  }),
]

test('reply and forward prefixes do not fork one conversation into three', () => {
  assert.equal(normalizeSubject('Re: Re: Fwd: Pendant firmware'), 'pendant firmware')
  assert.equal(normalizeSubject('AW: [pendant-dev] Pendant firmware'), 'pendant firmware')
  assert.equal(
    normalizeSubject('Pendant firmware'),
    normalizeSubject('RE: Pendant firmware'),
  )
})

test('an attendee and a correspondent are parsed by the same reader', () => {
  assert.deepEqual(parseAddress('Jorge Roji <jorge@example.com>'), {
    name: 'Jorge Roji',
    email: 'jorge@example.com',
  })
  assert.deepEqual(parseAddress('mailto:jorge@example.com'), {
    name: 'jorge',
    email: 'jorge@example.com',
  })
  assert.deepEqual(parseAddress('Dana Wu'), { name: 'Dana Wu', email: '' })
})

test('a thread knows who spoke last and whether the owner answered', () => {
  const [thread] = buildThreads(CONVERSATION, { sentReadable: true })

  assert.equal(thread.messageCount, 3)
  assert.equal(thread.spanDays, 4)
  assert.equal(thread.lastFrom.email, 'jorge@example.com')
  assert.equal(thread.ownerReplied, true, 'the owner did reply, earlier in the thread')
  assert.equal(thread.awaitingOwner, true, 'but Jorge wrote after that and is still waiting')
  assert.deepEqual(ownerAddressesFrom(CONVERSATION), ['evan@example.com'])
})

test('the owner writing last closes the loop', () => {
  const [thread] = buildThreads(
    [
      ...CONVERSATION,
      envelope({
        mailbox: 'sent',
        sender: 'Evan Liu <evan@example.com>',
        subject: 'Re: Pendant firmware',
        sentAt: '2026-08-06T09:00:00',
      }),
    ],
    { sentReadable: true },
  )
  assert.equal(thread.awaitingOwner, false)
  assert.match(summarizeThread(thread), /you replied last/)
})

test('an unreadable Sent mailbox produces "I cannot tell", never "they are waiting"', () => {
  const inboxOnly = CONVERSATION.filter((message) => message.mailbox === 'inbox')
  const [thread] = buildThreads(inboxOnly, { sentReadable: false })

  assert.equal(thread.awaitingOwner, null, 'unknown is a value; it is not rounded down to no')
  assert.equal(thread.ownerReplied, null)
  assert.match(summarizeThread(thread), /could not read your Sent mail/)
})

test('threads are selected by who is in them, and a single shared word is not enough', () => {
  const threads = buildThreads(
    [
      ...CONVERSATION,
      envelope({
        sender: 'Payroll <no-reply@example.com>',
        subject: 'Your pendant expense claim',
        sentAt: '2026-08-04T09:00:00',
      }),
      envelope({
        sender: 'Dana Wu <dana@example.com>',
        subject: 'Pendant firmware enclosure tooling',
        sentAt: '2026-08-03T09:00:00',
      }),
    ],
    { sentReadable: true },
  )

  const matched = threadsForMeeting(threads, {
    attendees: ['Jorge Roji <jorge@example.com>'],
    terms: ['pendant', 'firmware'],
    ownerAddresses: ['evan@example.com'],
  })

  assert.equal(matched.length, 2)
  assert.equal(matched[0].key, 'pendant firmware', 'the attendee thread outranks a term match')
  assert.deepEqual(matched[0].matchedPeople, ['Jorge Roji'])
  assert.ok(
    !matched.some((thread) => thread.key.includes('expense claim')),
    'one shared word is context, not a claim',
  )
})

test('the owner is dropped from the attendee list before threads are matched', () => {
  const threads = buildThreads(
    [
      envelope({
        sender: 'Unrelated <someone@example.com>',
        subject: 'Lunch',
        sentAt: '2026-08-04T09:00:00',
      }),
      envelope({
        mailbox: 'sent',
        sender: 'Evan Liu <evan@example.com>',
        subject: 'Re: Lunch',
        sentAt: '2026-08-04T10:00:00',
      }),
    ],
    { sentReadable: true },
  )

  const matched = threadsForMeeting(threads, {
    attendees: ['Evan Liu <evan@example.com>'],
    terms: [],
    ownerAddresses: ['evan@example.com'],
  })
  assert.equal(matched.length, 0, 'matching on the owner selects every thread they were ever in')
})

test('a first name on an invite reaches a full name in the mailbox', () => {
  assert.equal(samePerson({ name: 'Jorge', email: '' }, { name: 'Jorge Roji', email: '' }), true)
  assert.equal(samePerson({ name: 'Dana', email: '' }, { name: 'Jorge Roji', email: '' }), false)
  assert.equal(
    samePerson({ name: 'Someone', email: 'a@x.com' }, { name: 'Other', email: 'a@x.com' }),
    true,
    'an address settles it whatever the display names say',
  )
})

test('the envelope parser survives a subject containing the delimiter it is not using', () => {
  const stdout = [
    ['iCloud', 'inbox', '2026-08-05T09:00:00', 'Jorge <jorge@x.com>', 'mid-1', 'Re: budget, v2'].join(FIELD),
    ['iCloud', 'sent', '2026-08-06T09:00:00', 'Evan <evan@x.com>', 'mid-2', 'Re: budget, v2'].join(FIELD),
  ].join(RECORD)

  const parsed = parseThreadEnvelopes(stdout)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].subject, 'Re: budget, v2')
  assert.equal(parsed[1].mailbox, 'sent')
})

test('the mailbox read never contains Mail’s send verb', async () => {
  let seen = ''
  await readThreadEnvelopes({}, {
    osascript: async (script) => {
      seen = script
      return ''
    },
  })
  assert.ok(seen.includes('date sent'), 'both mailboxes are ordered by one clock')
  assert.ok(!/\bsend\b/i.test(seen), 'mailTriage.js refuses any Mail script containing "send"')
})

test('no sent mail at all is reported as a limit, in the owner’s words', async () => {
  const history = await meetingThreadHistory(
    { attendees: ['Jorge Roji <jorge@example.com>'], terms: ['pendant'] },
    {
      readEnvelopes: async () => ({
        messages: CONVERSATION.filter((message) => message.mailbox === 'inbox'),
        sentReadable: false,
      }),
    },
  )

  assert.equal(history.threads[0].awaitingOwner, null)
  assert.equal(history.limits.length, 1)
  assert.match(history.limits[0], /could not read your Sent mail/)
})
