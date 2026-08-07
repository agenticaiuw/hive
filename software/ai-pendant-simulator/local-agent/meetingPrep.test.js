import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  discriminatingTerms,
  extractFromText,
  looksLikeMeeting,
  matchMail,
  meetingTerms,
  prepareForNextMeeting,
  rankDocuments,
  scanDocuments,
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

test('meeting terms drop the words every meeting has', () => {
  const terms = meetingTerms({
    title: 'Weekly sync about the Pendant firmware',
    attendees: ['Mateo Neri Morales'],
  })
  assert.ok(terms.includes('pendant'))
  assert.ok(terms.includes('firmware'))
  assert.ok(terms.includes('mateo'))
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
      "Action item: Mateo to send the BOM by Friday.",
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
  assert.ok(actions.some((item) => item.text.includes('Mateo to send the BOM')))
  assert.ok(
    actions.some((item) => item.text === '[ ] confirm the antenna vendor'),
    'an unchecked box is structurally an action item',
  )
  assert.ok(!decisions.some((item) => item.text.includes('weather')))
})

test('mail is matched on the envelope only', () => {
  const matched = matchMail(
    [
      { subject: 'Pendant firmware review', sender: 'mateo@example.com', receivedAt: 'x' },
      { subject: 'Your parking permit', sender: 'transport@example.com', receivedAt: 'x' },
    ],
    ['pendant', 'firmware'],
  )
  assert.equal(matched.length, 1)
  assert.equal(matched[0].subject, 'Pendant firmware review')
})

test('an empty calendar says so instead of preparing for nothing', async () => {
  const result = await prepareForNextMeeting(
    { now: NOW, collect: false },
    { readEvents: async () => [], readMail: async () => [] },
  )
  assert.equal(result.meeting, null)
  assert.match(result.spoken, /Nothing on your calendar/)
})

test('prep pulls the agenda, the documents and the quotes into one brief', async (t) => {
  const directory = docs(t, {
    'pendant-firmware-decisions.md': [
      'We agreed to keep libopus at 24 kHz.',
      'Action item: Evan to rerun the two-agent harness.',
    ].join('\n'),
    'unrelated-taxes.md': 'We decided to file late.',
  })

  const result = await prepareForNextMeeting(
    { now: NOW, roots: [directory], collect: false, maxDocuments: 3 },
    {
      readEvents: async () => [
        {
          uid: 'e1',
          title: 'Pendant firmware review',
          start: '2026-08-07T09:30:00',
          end: '2026-08-07T10:00:00',
          allDay: false,
          location: 'https://zoom.us/j/1',
          notes: 'Agenda: 1. audio path 2. enclosure',
          attendees: ['Mateo'],
        },
      ],
      readMail: async () => [
        { subject: 'Re: pendant firmware', sender: 'mateo@example.com', receivedAt: 'today' },
      ],
    },
  )

  assert.equal(result.meeting.title, 'Pendant firmware review')
  assert.equal(result.agenda, 'Agenda: 1. audio path 2. enclosure')
  assert.equal(result.documents.length, 1, 'the tax note matched nothing and stayed out')
  assert.equal(result.decisions[0].text, 'We agreed to keep libopus at 24 kHz.')
  assert.ok(result.actions.some((item) => item.text.includes('rerun the two-agent harness')))
  assert.equal(result.mail.length, 1)
  assert.match(result.brief, /## Open decisions/)
  assert.match(result.spoken, /in 30 minutes/)
})

test('Mail being unreachable still leaves the owner their documents', async (t) => {
  const directory = docs(t, { 'pendant-firmware-decisions.md': 'We decided to ship.' })

  const result = await prepareForNextMeeting(
    { now: NOW, roots: [directory], collect: false },
    {
      readEvents: async () => [
        {
          uid: 'e1',
          title: 'Pendant firmware review',
          start: '2026-08-07T09:30:00',
          end: '2026-08-07T10:00:00',
          allDay: false,
          location: null,
          notes: null,
          attendees: [],
        },
      ],
      readMail: async () => {
        throw new Error('Mail is not running')
      },
    },
  )

  assert.equal(result.mail.length, 0)
  assert.equal(result.documents.length, 1)
  assert.equal(result.decisions.length, 1)
})

test('collecting copies the documents rather than moving them', async (t) => {
  const directory = docs(t, { 'pendant-firmware-decisions.md': 'We decided to ship.' })

  const result = await prepareForNextMeeting(
    { now: NOW, roots: [directory], collect: true },
    {
      readEvents: async () => [
        {
          uid: 'e1',
          title: 'Pendant firmware review',
          start: '2026-08-07T09:30:00',
          end: '2026-08-07T10:00:00',
          allDay: false,
          location: null,
          notes: null,
          attendees: [],
        },
      ],
      readMail: async () => [],
    },
  )
  t.after(() => fs.rmSync(result.folder, { force: true, recursive: true }))

  assert.ok(fs.existsSync(path.join(result.folder, 'pendant-firmware-decisions.md')))
  assert.ok(fs.existsSync(path.join(result.folder, 'BRIEF.md')))
  assert.ok(
    fs.existsSync(path.join(directory, 'pendant-firmware-decisions.md')),
    'the original must survive: something else is probably using it',
  )
})

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
    attendees: ['Mateo'],
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
    {
      readEvents: async () => [
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
          title: 'Summer Interview with Mateo',
          start: '2026-08-07T20:00:00',
          end: '2026-08-07T21:00:00',
          allDay: false,
          attendees: ['Mateo Neri Morales'],
          location: 'https://zoom.us/j/1',
          notes: null,
        },
      ],
      readMail: async () => [],
    },
  )

  assert.equal(result.meeting.title, 'Summer Interview with Mateo')
})

test('the organiser’s own name is dropped when it matches everything they own', () => {
  const candidates = Array.from({ length: 20 }, (_unused, index) => ({
    path: `/Users/evan/Documents/hive-owner-file-${index}.md`,
  }))
  candidates[0].path = '/Users/evan/Documents/hive-owner-pendant-firmware.md'

  const terms = discriminatingTerms(['evan', 'liu', 'pendant', 'firmware'], candidates)
  assert.deepEqual(terms, ['pendant', 'firmware'], 'a term in every file names nothing')
})

test('a small corpus keeps its terms — frequency needs something to measure', () => {
  const candidates = [{ path: '/a/evan-notes.md' }, { path: '/a/evan-other.md' }]
  assert.deepEqual(discriminatingTerms(['evan', 'notes'], candidates), ['evan', 'notes'])
})

test('conversational future tense is not a prior action item', () => {
  const { actions } = extractFromText(
    [
      "Oh, um, so basically, we're just… I guess I'm just trying to assemble, like, a core team of people during the summer, and then we'll see how it goes from there.",
      "I'll rerun the latency probe tonight.",
      'Action item: Mateo to send the BOM by Friday.',
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
  assert.ok(actions.some((item) => item.text.includes('Mateo to send the BOM')))
})
