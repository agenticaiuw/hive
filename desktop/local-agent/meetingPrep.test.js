import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/* Before meetingPrep.js. `collect: true` copies the matched documents into
 * workspacePath/meeting-prep/<date>-<slug>/ and writes BRIEF.md there, and
 * collectIntoFolder() has neither a { filePath } argument nor a store-path env
 * var — it closes over the workspacePath that config.js fixes at import time.
 * Without this redirect those folders land in the owner's real workspace,
 * alongside the meeting prep the agent app on :8000 is writing for real. */
import './testWorkspace.js'

import {
  attendeeRoster,
  briefBlindSpots,
  cleanMeetingName,
  discriminatingTerms,
  extractFromText,
  extractMeetingMaterial,
  extractOpenQuestions,
  looksLikeMeeting,
  matchMail,
  matchMeetingName,
  matchMeetingPrepCommand,
  meetingTerms,
  nameTokens,
  prepareForNamedMeeting,
  prepareForNextMeeting,
  rankDocuments,
  readUpcomingEvents,
  registerMeetingPrepRoutes,
  scanDocuments,
  upcomingMeetings,
} from './meetingPrep.js'

const NOW = new Date('2026-08-07T09:00:00')

function docs(t, files = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-prep-test-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(directory, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return directory
}

/* The Mac's three readers, faked. A test may have a calendar and a mailbox, but
 * it may never have THIS Mac's calendar and mailbox. */
function readers({ events = [], reminders = [{ title: 'buy milk' }], history = null } = {}) {
  return {
    readEvents: async () => events,
    readReminders: async () => reminders,
    readThreads: async () =>
      history ?? { threads: [], ownerAddresses: [], sentReadable: true, limits: [] },
  }
}

function thread(overrides = {}) {
  return {
    key: 'pendant firmware',
    subject: 'Re: pendant firmware',
    messageCount: 3,
    firstAt: '2026-08-01T09:00:00',
    lastAt: '2026-08-05T09:00:00',
    spanDays: 4,
    participants: [
      { name: 'Jorge Roji', email: 'jorge@example.com', isOwner: false, messageCount: 2, lastAt: '2026-08-05T09:00:00' },
    ],
    lastFrom: { name: 'Jorge Roji', email: 'jorge@example.com' },
    lastFromOwner: false,
    ownerReplied: false,
    awaitingOwner: true,
    matchedPeople: ['Jorge Roji'],
    matchedTerms: ['pendant'],
    score: 10,
    messages: [
      {
        subject: 'Re: pendant firmware',
        sender: 'Jorge Roji <jorge@example.com>',
        sentAt: '2026-08-05T09:00:00',
        mailbox: 'inbox',
      },
    ],
    ...overrides,
  }
}

const MEETING = {
  uid: 'e1',
  title: 'Pendant firmware review',
  start: '2026-08-07T09:30:00',
  end: '2026-08-07T10:00:00',
  allDay: false,
  location: 'https://zoom.us/j/1',
  notes: 'Agenda: 1. audio path 2. enclosure',
  attendees: ['Jorge Roji <jorge@example.com>'],
}

/* ------------------------------------------------------------- retrieval */

test('meeting terms drop the words every meeting has', () => {
  const terms = meetingTerms({
    title: 'Weekly sync about the Pendant firmware',
    attendees: ['Jorge Roji Pezzoli'],
  })
  assert.ok(terms.includes('pendant'))
  assert.ok(terms.includes('firmware'))
  assert.ok(terms.includes('jorge'))
  assert.ok(!terms.includes('weekly'), '"weekly" matches every document you own')
  assert.ok(!terms.includes('sync'))
})

test('documents are found by name match, and unmatched freshness does not win', (t) => {
  const directory = docs(t, {
    'pendant-firmware-notes.md': '# notes',
    'grocery-list.md': 'milk',
  })

  const ranked = rankDocuments(scanDocuments([directory], { now: NOW }), ['pendant', 'firmware'])
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].name, 'pendant-firmware-notes.md')
  assert.deepEqual(ranked[0].matchedTerms.sort(), ['firmware', 'pendant'])
})

test('binary formats are surfaced by name even though their bytes are not text', (t) => {
  const directory = docs(t, { 'Pendant Roadmap.pdf': '%PDF-1.4 binary junk' })
  const [found] = scanDocuments([directory], { now: NOW })
  assert.equal(found.readable, false, 'a PDF is a reference, not a source of quotes')
  assert.equal(found.name, 'Pendant Roadmap.pdf')
})

test('decisions and action items are quoted, never paraphrased', () => {
  const { decisions, actions } = extractFromText(
    [
      '# Pendant sync',
      'We decided to ship the 24 kHz path before the enclosure.',
      'The weather was nice.',
      'Action item: Jorge to send the BOM by Friday.',
      "I'll rerun the latency probe tonight.",
      '[ ] confirm the antenna vendor',
      'Open question: do we keep the ESP32 bridge?',
    ].join('\n'),
    'sync.md',
  )

  assert.equal(decisions.length, 2)
  assert.equal(decisions[0].text, 'We decided to ship the 24 kHz path before the enclosure.')
  assert.equal(decisions[0].source, 'sync.md')
  assert.equal(decisions[1].text, 'Open question: do we keep the ESP32 bridge?')

  assert.equal(actions.length, 3)
  assert.ok(actions.some((item) => item.text.includes('Jorge to send the BOM')))
  assert.ok(
    actions.some((item) => item.text === '[ ] confirm the antenna vendor'),
    'an unchecked box is structurally an action item',
  )
  assert.ok(!decisions.some((item) => item.text.includes('weather')))
})

test('mail is matched on the envelope only', () => {
  const matched = matchMail(
    [
      { subject: 'Pendant firmware review', sender: 'jorge@example.com', receivedAt: 'x' },
      { subject: 'Your parking permit', sender: 'transport@example.com', receivedAt: 'x' },
    ],
    ['pendant', 'firmware'],
  )
  assert.equal(matched.length, 1)
  assert.equal(matched[0].subject, 'Pendant firmware review')
})

test('conversational future tense is not a prior action item', () => {
  const { actions } = extractFromText(
    [
      "Oh, um, so basically, we're just… I guess I'm just trying to assemble, like, a core team of people during the summer, and then we'll see how it goes from there.",
      "I'll rerun the latency probe tonight.",
      'Action item: Jorge to send the BOM by Friday.',
      'all the raw components are extremely cheap.',
    ].join('\n'),
    'transcript.txt',
  )

  assert.equal(actions.length, 2)
  assert.ok(
    !actions.some((item) => item.text.startsWith('all the raw')),
    '"a" + "ll" is not somebody promising something',
  )
  assert.ok(!actions.some((item) => item.text.includes('core team of people')), 'that is someone talking')
  assert.ok(actions.some((item) => item.text === "I'll rerun the latency probe tonight."))
  assert.ok(actions.some((item) => item.text.includes('Jorge to send the BOM')))
})

test('the organiser’s own name is dropped when it matches everything they own', () => {
  const candidates = Array.from({ length: 20 }, (_unused, index) => ({
    path: `/Users/evan/Documents/evan-liu-file-${index}.md`,
  }))
  candidates[0].path = '/Users/evan/Documents/evan-liu-pendant-firmware.md'

  const terms = discriminatingTerms(['evan', 'liu', 'pendant', 'firmware'], candidates)
  assert.deepEqual(terms, ['pendant', 'firmware'], 'a term in every file names nothing')
})

test('a small corpus keeps its terms — frequency needs something to measure', () => {
  const candidates = [{ path: '/a/evan-notes.md' }, { path: '/a/evan-other.md' }]
  assert.deepEqual(discriminatingTerms(['evan', 'notes'], candidates), ['evan', 'notes'])
})

/* ------------------------------------------------------- open questions */

test('an unsettled question is not filed as a decision', () => {
  const { decisions, questions } = extractMeetingMaterial(
    [
      'We decided to ship the 24 kHz path before the enclosure.',
      'Open question: do we keep the ESP32 bridge?',
      'The antenna vendor is still undecided.',
    ].join('\n'),
    'sync.md',
  )

  assert.equal(decisions.length, 1, 'only the settled thing is a decision')
  assert.equal(decisions[0].text, 'We decided to ship the 24 kHz path before the enclosure.')
  assert.equal(questions.length, 2)
  assert.ok(questions.some((item) => item.text.includes('ESP32 bridge')))
  assert.ok(
    questions.some((item) => item.text.includes('antenna vendor')),
    'walking in believing a live question is closed is the expensive direction of this error',
  )
})

test('bullets under an open-questions heading are questions even without the words', () => {
  const questions = extractOpenQuestions(
    [
      '# Pendant sync',
      'Some prose that mentions nothing in particular at all.',
      '## Open questions',
      '- Do we keep the ESP32 bridge?',
      '- Who owns the enclosure tooling?',
      '',
      'And then the meeting moved on to other business entirely.',
      '## Notes',
      '- This bullet is under a different heading.',
    ].join('\n'),
    'sync.md',
  )

  assert.equal(questions.length, 2)
  assert.deepEqual(
    questions.map((item) => item.text),
    ['Do we keep the ESP32 bridge?', 'Who owns the enclosure tooling?'],
  )
  assert.equal(questions[0].origin, 'heading')
})

test('a questions heading does not swallow the rest of the document', () => {
  const questions = extractOpenQuestions(
    ['Questions were raised about the budget and nobody wrote them down.', '- a bullet'].join('\n'),
    'notes.md',
  )
  assert.equal(questions.length, 0, 'a sentence about questions is not a heading')
})

/* --------------------------------------------------- the unreadable calendar */

test('an empty calendar with open reminders is a clear day', async () => {
  const result = await prepareForNextMeeting({ now: NOW, collect: false }, readers())
  assert.equal(result.meeting, null)
  assert.equal(result.calendarReadable, true)
  assert.match(result.spoken, /Nothing on your calendar/)
})

test('both EventKit reads empty is reported as unreadable, not as a clear day', async () => {
  const result = await prepareForNextMeeting(
    { now: NOW, collect: false },
    readers({ events: [], reminders: [] }),
  )

  assert.equal(result.meeting, null)
  assert.equal(result.calendarReadable, false)
  assert.doesNotMatch(
    result.spoken,
    /Nothing on your calendar/,
    'an unauthorised read must never be spoken as an empty day',
  )
  assert.match(result.spoken, /could not read your calendar/)
  assert.deepEqual(result.unavailable, ['your calendar'])
  assert.match(result.problems[0], /unauthorised read/)
})

test('a failed corroborating read is still unreadable — failing to corroborate is not corroboration', async () => {
  const { events, calendarReadable, problems } = await readUpcomingEvents(
    { from: NOW, to: NOW },
    {
      readEvents: async () => [],
      readReminders: async () => {
        throw new Error('Reminders is not running')
      },
    },
  )
  assert.deepEqual(events, [])
  assert.equal(calendarReadable, false)
  assert.match(problems[0], /Reminders is not running/)
})

/* --------------------------------------------------------------- the brief */

test('prep pulls the agenda, the attendees, the thread and the quotes into one brief', async (t) => {
  const directory = docs(t, {
    'pendant-firmware-decisions.md': [
      'We agreed to keep libopus at 24 kHz.',
      'Action item: Evan to rerun the two-agent harness.',
      'Open question: do we keep the ESP32 bridge?',
    ].join('\n'),
    'unrelated-taxes.md': 'We decided to file late.',
  })

  const result = await prepareForNextMeeting(
    { now: NOW, roots: [directory], collect: false, maxDocuments: 3 },
    readers({
      events: [MEETING],
      history: {
        threads: [thread()],
        ownerAddresses: ['evan@example.com'],
        sentReadable: true,
        limits: [],
      },
    }),
  )

  assert.equal(result.meeting.title, 'Pendant firmware review')
  assert.equal(result.agenda, 'Agenda: 1. audio path 2. enclosure')
  assert.equal(result.documents.length, 1, 'the tax note matched nothing and stayed out')
  assert.equal(result.decisions[0].text, 'We agreed to keep libopus at 24 kHz.')
  assert.ok(result.actions.some((item) => item.text.includes('rerun the two-agent harness')))
  assert.ok(result.questions.some((item) => item.text.includes('ESP32 bridge')))
  assert.equal(result.attendees.length, 1)
  assert.equal(result.attendees[0].name, 'Jorge Roji')
  assert.equal(result.attendees[0].awaitingYourReply, true)
  assert.equal(result.threads.length, 1)
  assert.equal(result.mail.length, 1, 'the flat mail list is derived from the threads')
  assert.match(result.brief, /## Open questions/)
  assert.match(result.brief, /## Who is in the room/)
  assert.match(result.brief, /They wrote last and you have not replied/)
  assert.match(result.spoken, /in 30 minutes/)
  assert.match(result.spoken, /waiting on your reply/)
})

test('Mail being unreachable still leaves the owner their documents', async (t) => {
  const directory = docs(t, { 'pendant-firmware-decisions.md': 'We decided to ship.' })

  const result = await prepareForNextMeeting(
    { now: NOW, roots: [directory], collect: false },
    {
      readEvents: async () => [{ ...MEETING, attendees: [], location: null, notes: null }],
      readReminders: async () => [],
      readThreads: async () => {
        throw new Error('Mail is not running')
      },
    },
  )

  assert.equal(result.mail.length, 0)
  assert.equal(result.documents.length, 1)
  assert.equal(result.decisions.length, 1)
  assert.match(result.mailError, /Mail is not running/)
  assert.ok(
    result.blindSpots.some((gap) => /could not read Mail/i.test(gap)),
    'a brief with no thread history has to say why it has none',
  )
})

test('every brief admits what it cannot see', () => {
  const gaps = briefBlindSpots({
    history: { limits: [] },
    documents: [{ readable: true }],
  })
  assert.ok(
    gaps.some((gap) => /chat app, on a call, or in person/.test(gap)),
    'the biggest blind spot is true every time and is stated every time',
  )
  assert.ok(gaps.some((gap) => /who was copied/.test(gap)))
})

test('collecting copies the documents rather than moving them', async (t) => {
  const directory = docs(t, { 'pendant-firmware-decisions.md': 'We decided to ship.' })

  const result = await prepareForNextMeeting(
    { now: NOW, roots: [directory], collect: true },
    readers({ events: [{ ...MEETING, attendees: [], location: null, notes: null }] }),
  )
  t.after(() => fs.rmSync(result.folder, { force: true, recursive: true }))

  assert.ok(fs.existsSync(path.join(result.folder, 'pendant-firmware-decisions.md')))
  assert.ok(fs.existsSync(path.join(result.folder, 'BRIEF.md')))
  assert.ok(
    fs.existsSync(path.join(directory, 'pendant-firmware-decisions.md')),
    'the original must survive: something else is probably using it',
  )
})

/* --------------------------------------------------------- which meeting */

test('a solo five-minute alarm on the calendar is not a meeting', () => {
  const alarm = {
    title: 'stand up',
    start: '2026-08-07T09:00:00',
    end: '2026-08-07T09:05:00',
    attendees: [],
    location: null,
  }
  const call = {
    title: 'Summer Interview',
    start: '2026-08-07T09:00:00',
    end: '2026-08-07T09:05:00',
    attendees: ['Jorge'],
    location: 'https://zoom.us/j/1',
  }
  const blocked = {
    title: 'Deep work',
    start: '2026-08-07T09:00:00',
    end: '2026-08-07T10:00:00',
    attendees: [],
    location: null,
  }

  assert.equal(looksLikeMeeting(alarm), false, 'nobody is invited and there is nowhere to be')
  assert.equal(looksLikeMeeting(call), true)
  assert.equal(looksLikeMeeting(blocked), true, 'an hour blocked out is a commitment')
})

test('prep skips the owner’s own alarms and finds the real next meeting', async () => {
  const result = await prepareForNextMeeting(
    { now: NOW, roots: [], collect: false },
    readers({
      events: [
        {
          uid: 'alarm',
          title: 'stand up',
          start: '2026-08-07T09:10:00',
          end: '2026-08-07T09:15:00',
          allDay: false,
          attendees: [],
          location: null,
          notes: null,
        },
        {
          uid: 'real',
          title: 'Summer Interview with Jorge',
          start: '2026-08-07T20:00:00',
          end: '2026-08-07T21:00:00',
          allDay: false,
          attendees: ['Jorge Roji Pezzoli'],
          location: 'https://zoom.us/j/1',
          notes: null,
        },
      ],
    }),
  )

  assert.equal(result.meeting.title, 'Summer Interview with Jorge')
})

test('a meeting already under way is still worth preparing for', () => {
  const running = {
    title: 'Board review',
    start: '2026-08-07T08:45:00',
    end: '2026-08-07T09:45:00',
    attendees: ['Someone'],
  }
  const finished = {
    title: 'Standup',
    start: '2026-08-07T08:00:00',
    end: '2026-08-07T08:15:00',
    attendees: ['Someone'],
  }
  const upcoming = upcomingMeetings([running, finished], { now: NOW })
  assert.equal(upcoming.length, 1)
  assert.equal(upcoming[0].title, 'Board review')
})

test('a named meeting is matched on its attendees and its location, not just its title', () => {
  const events = [
    { title: 'Deep work', start: '2026-08-07T10:00:00', attendees: [], location: null },
    {
      title: 'Q3 planning',
      start: '2026-08-08T10:00:00',
      attendees: ['Jorge Roji'],
      location: 'https://zoom.us/j/1',
    },
  ]
  const match = matchMeetingName(events, 'my meeting with Jorge')
  assert.equal(match.ambiguous, false)
  assert.equal(match.meeting.title, 'Q3 planning')
})

test('two meetings that match equally are reported, not guessed between', async () => {
  const events = [
    { title: 'Jorge 1:1', start: '2026-08-08T10:00:00', attendees: ['Jorge'], location: null },
    { title: 'Jorge sync', start: '2026-08-09T10:00:00', attendees: ['Jorge'], location: null },
  ]
  const match = matchMeetingName(events, 'the meeting with Jorge')
  assert.equal(match.ambiguous, true)
  assert.equal(match.meeting, null, 'picking the earlier one silently prepares the wrong meeting')

  const result = await prepareForNamedMeeting(
    { name: 'the meeting with Jorge', now: NOW, roots: [], collect: false },
    readers({ events }),
  )
  assert.equal(result.ambiguous, true)
  assert.match(result.spoken, /Jorge 1:1/)
  assert.match(result.spoken, /Jorge sync/)
})

test('a named meeting nobody has on the calendar says so without inventing one', async () => {
  const result = await prepareForNamedMeeting(
    { name: 'the board review', now: NOW, roots: [], collect: false },
    readers({ events: [MEETING] }),
  )
  assert.equal(result.meeting, null)
  assert.match(result.spoken, /could not find a meeting matching/)
})

test('a named meeting resolves to one brief', async () => {
  const result = await prepareForNamedMeeting(
    { name: 'pendant firmware review', now: NOW, roots: [], collect: false },
    readers({ events: [MEETING] }),
  )
  assert.equal(result.meeting.title, 'Pendant firmware review')
  assert.equal(result.requested, 'pendant firmware review')
})

test('the words that name the request are not matched against the calendar', () => {
  assert.deepEqual(nameTokens('get me ready for my next meeting'), [])
  assert.deepEqual(nameTokens('the pendant firmware review'), ['pendant', 'firmware', 'review'])
  assert.equal(cleanMeetingName('the pendant firmware review please'), 'pendant firmware review')
})

/* ------------------------------------------------------------- the command */

test('spoken phrasings route without a model in the loop', () => {
  assert.deepEqual(matchMeetingPrepCommand('Get me ready for my next meeting.'), { kind: 'next' })
  assert.deepEqual(matchMeetingPrepCommand('meeting prep'), { kind: 'next' })
  assert.deepEqual(matchMeetingPrepCommand('Brief me for the pendant firmware review'), {
    kind: 'named',
    name: 'pendant firmware review',
  })
  assert.deepEqual(
    matchMeetingPrepCommand("While I sleep, prepare tomorrow's meeting briefs."),
    { kind: 'overnight' },
  )
  assert.deepEqual(matchMeetingPrepCommand("prepare tomorrow's brief"), { kind: 'overnight' })
  assert.equal(matchMeetingPrepCommand('what is the weather'), null)
})

test('"my next meeting" is the next-meeting request, not a meeting called "next meeting"', () => {
  assert.deepEqual(matchMeetingPrepCommand('prepare me for my next call'), { kind: 'next' })
})

/* -------------------------------------------------------------- attendees */

test('an attendee with no mail history says so rather than looking uninvolved', () => {
  const roster = attendeeRoster(
    { attendees: ['Jorge Roji <jorge@example.com>', 'Dana Wu'] },
    { threads: [thread()], ownerAddresses: ['evan@example.com'] },
  )

  assert.equal(roster[0].messageCount, 2)
  assert.equal(roster[0].awaitingYourReply, true)
  assert.deepEqual(roster[0].knownFrom, ['the invite', 'your mail'])

  assert.equal(roster[1].name, 'Dana Wu')
  assert.equal(roster[1].messageCount, 0)
  assert.deepEqual(roster[1].knownFrom, ['the invite'])
})

test('"waiting on your reply" is never claimed from an unreadable Sent mailbox', () => {
  const roster = attendeeRoster(
    { attendees: ['Jorge Roji <jorge@example.com>'] },
    { threads: [thread({ awaitingOwner: null, ownerReplied: null, lastFromOwner: null })] },
  )
  assert.equal(roster[0].awaitingYourReply, false)
  assert.equal(roster[0].messageCount, 2, 'the thread is still reported; only the claim is withheld')
})

/* ----------------------------------------------------------------- routes */

test('routes register onto an Express-like app without touching server.js', () => {
  const registered = []
  const app = {
    get: (route) => registered.push(`GET ${route}`),
    post: (route) => registered.push(`POST ${route}`),
  }
  const declared = registerMeetingPrepRoutes(app)

  assert.ok(declared.includes('POST /meeting-prep/brief'))
  assert.ok(declared.includes('POST /meeting-prep/overnight'))
  assert.deepEqual(new Set(registered), new Set(declared))
  assert.throws(() => registerMeetingPrepRoutes({}), /Express-like app/)
})
