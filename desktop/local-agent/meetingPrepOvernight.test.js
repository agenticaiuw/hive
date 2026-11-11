import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  OVERNIGHT_COMMAND,
  OVERNIGHT_SINKS,
  ensureOvernightRoutine,
  meetingFingerprint,
  narrateMeeting,
  overnightHeadline,
  overnightRoutine,
  renderOvernightNote,
  runOvernightMeetingPrep,
  tomorrowWindow,
} from './meetingPrepOvernight.js'
import { matchMeetingPrepCommand } from './meetingPrep.js'
import { QUEUE_BUDGET } from './meetingPrepQueue.js'
import { readBriefingQueueStore } from './briefingQueue.js'

/* 22:30 on the 6th: the run happens tonight, the meetings are tomorrow. */
const NOW = new Date('2026-08-06T22:30:00')

/*
 * The `file` sink is off in every test here, and finding out why cost the
 * owner a file: briefing.js's writeBriefingFile writes into the real
 * ~/AI-Pendant-Workspace/briefings and rewrites latest.json, which is what GET
 * /briefing/latest serves. A test run with the default sinks left the owner's
 * "latest briefing" pointing at a fabricated meeting with a fabricated
 * attendee. A test may compose a brief; it may not publish one.
 */
const SPEECH_ONLY = ['speech']

function meeting(overrides = {}) {
  return {
    uid: 'e1',
    title: 'Pendant firmware review',
    start: '2026-08-07T09:00:00',
    end: '2026-08-07T10:00:00',
    allDay: false,
    location: 'https://zoom.us/j/1',
    notes: 'Agenda: audio path.\n\n## Open questions\n- Do we keep the ESP32 bridge?',
    attendees: ['Jorge Roji <jorge@example.com>', 'Evan Liu <evan@example.com>'],
    ...overrides,
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
    messages: [],
    ...overrides,
  }
}

/* Every Mac-shaped dependency, faked: the calendar, the mailbox, the audio
 * shelf and the review-queue file. A test may not write to the owner's
 * workspace, and it may certainly not invoke `say`. */
function harness(t, { events = [meeting()], reminders = [{ title: 'milk' }], threads = [thread()] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-overnight-test-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))

  const shelf = []
  const rendered = []

  return {
    directory,
    shelf,
    rendered,
    deps: {
      readEvents: async () => events,
      readReminders: async () => reminders,
      readThreads: async () => ({
        threads,
        ownerAddresses: ['evan@example.com'],
        sentReadable: true,
        limits: [],
      }),
      listShelf: () => [...shelf],
      render: ({ text }) => {
        rendered.push(text)
        return {
          wavPath: path.join(directory, `${rendered.length}.wav`),
          opusPath: path.join(directory, `${rendered.length}.opus`),
          seconds: 30,
          pcmBytes: 1,
          opusBytes: 1,
          truncated: false,
        }
      },
      saveShelf: (entry) => {
        const row = { id: `brf_${shelf.length}`, createdAt: NOW.toISOString(), played: false, ...entry }
        shelf.unshift(row)
        return row
      },
      deleteShelf: (id) => {
        const before = shelf.length
        const index = shelf.findIndex((row) => row.id === id)
        if (index >= 0) shelf.splice(index, 1)
        return shelf.length !== before
      },
      queueFilePath: path.join(directory, 'queue.json'),
    },
  }
}

test('tomorrow is a wall-clock day, not the next 24 hours', () => {
  const { from, to } = tomorrowWindow({ now: NOW })
  assert.equal(from.getDate(), 7)
  assert.equal(from.getHours(), 0)
  assert.equal(to.getDate(), 8)
})

test('this feature owns no clock — the schedule is a routine in routines.js', async () => {
  const routine = overnightRoutine()
  assert.equal(routine.schedule.kind, 'daily')
  assert.deepEqual(matchMeetingPrepCommand(OVERNIGHT_COMMAND), { kind: 'overnight' })

  const created = []
  const first = await ensureOvernightRoutine({
    list: () => created,
    create: (input) => {
      created.push({ id: 'rtn_1', ...input })
      return created[0]
    },
  })
  assert.equal(first.created, true)

  const second = await ensureOvernightRoutine({ list: () => created, create: () => assert.fail('duplicate') })
  assert.equal(second.created, false, 'registering on every boot must not accumulate a routine per boot')
})

test('the overnight run assembles tomorrow, writes one brief and queues the audio', async (t) => {
  const { deps, shelf, rendered } = harness(t)

  const result = await runOvernightMeetingPrep(
    { now: NOW, collect: false, roots: [], sinks: SPEECH_ONLY },
    deps,
  )

  assert.equal(result.ok, true)
  assert.equal(result.calendarReadable, true)
  assert.equal(result.counts.meetings, 1)
  assert.equal(result.counts.awaitingReply, 1)
  assert.ok(result.counts.questions >= 1, 'the invite carried an open-questions list')

  assert.match(result.note, /Tomorrow's meetings/)
  assert.match(result.note, /## About this run/)
  assert.match(result.note, /Nothing was sent, replied to, accepted, declined, or changed/)
  assert.match(result.spoken, /1 meeting tomorrow/)
  assert.match(result.spoken, /waiting on your reply/)

  assert.equal(shelf.length, 1, 'one track per meeting')
  assert.equal(shelf[0].producer, 'meetingPrep')
  assert.match(rendered[0], /Pendant firmware review/)
  assert.equal(result.sent, false)
  assert.equal(result.acted, false)
})

test('running twice before breakfast renders nothing the second time', async (t) => {
  const { deps, shelf, rendered } = harness(t)

  await runOvernightMeetingPrep({ now: NOW, collect: false, roots: [], sinks: SPEECH_ONLY }, deps)
  const second = await runOvernightMeetingPrep({ now: NOW, collect: false, roots: [], sinks: SPEECH_ONLY }, deps)

  assert.equal(rendered.length, 1, 'the shelf was destroyed once by exactly this')
  assert.equal(shelf.length, 1)
  assert.equal(second.queue.reused.length, 1)
  assert.equal(second.queue.rendered.length, 0)
})

test('the findings land in the review queue the owner already opens', async (t) => {
  const { deps } = harness(t)

  await runOvernightMeetingPrep({ now: NOW, collect: false, roots: [], sinks: SPEECH_ONLY }, deps)
  const store = readBriefingQueueStore({ filePath: deps.queueFilePath })

  assert.equal(store.queue.length, 1)
  assert.equal(store.queue[0].source, 'meeting-prep')
  assert.equal(store.queue[0].title, 'Pendant firmware review')
  assert.equal(store.queue[0].acted, false)
  assert.equal(store.queue[0].draft, null, 'meeting prep composes nothing addressed to anybody')
  assert.equal(
    store.told.length,
    0,
    'meeting prep is work left where you will look, not one of the three things you are told',
  )
  assert.equal(store.queue[0].actionableUntil, '2026-08-07T09:00:00')
})

test('re-running the same night bumps the queue row instead of adding a second', async (t) => {
  const { deps } = harness(t)

  await runOvernightMeetingPrep({ now: NOW, collect: false, roots: [], sinks: SPEECH_ONLY }, deps)
  await runOvernightMeetingPrep({ now: NOW, collect: false, roots: [], sinks: SPEECH_ONLY }, deps)

  const store = readBriefingQueueStore({ filePath: deps.queueFilePath })
  assert.equal(store.queue.length, 1)
  assert.equal(store.queue[0].seenCount, 2)
})

test('a moved meeting is a different row, because a moved meeting is news', () => {
  const base = { meetingKey: 'e1', meeting: { start: '2026-08-07T09:00:00' } }
  const moved = { meetingKey: 'e1', meeting: { start: '2026-08-07T11:00:00' } }
  assert.notEqual(meetingFingerprint(base), meetingFingerprint(moved))
  assert.equal(meetingFingerprint(base), meetingFingerprint({ ...base }))
})

test('an unreadable calendar overnight never reports a clear day', async (t) => {
  const { deps, shelf } = harness(t, { events: [], reminders: [] })

  const result = await runOvernightMeetingPrep({ now: NOW, collect: false, roots: [], sinks: SPEECH_ONLY }, deps)

  assert.equal(result.calendarReadable, false)
  assert.equal(result.counts.meetings, 0)
  assert.doesNotMatch(result.spoken, /Nothing on your calendar/)
  assert.match(result.spoken, /could not read your calendar/)
  assert.match(result.note, /I could not read your calendar/)
  assert.match(result.note, /not because you have nothing on/)
  assert.equal(shelf.length, 0, 'there is nothing to say, so nothing is put on the pendant')
})

test('a genuinely empty day is said as an empty day', async (t) => {
  const { deps } = harness(t, { events: [], reminders: [{ title: 'milk' }] })
  const result = await runOvernightMeetingPrep({ now: NOW, collect: false, roots: [], sinks: SPEECH_ONLY }, deps)

  assert.equal(result.calendarReadable, true)
  assert.match(result.spoken, /Nothing on your calendar/)
})

test('one meeting failing to assemble does not cost the owner the others', async (t) => {
  const { deps } = harness(t, {
    events: [meeting(), meeting({ uid: 'e2', title: 'Board review', start: '2026-08-07T14:00:00', end: '2026-08-07T15:00:00' })],
  })

  let calls = 0
  const result = await runOvernightMeetingPrep(
    { now: NOW, collect: false, roots: [], sinks: SPEECH_ONLY },
    {
      ...deps,
      readThreads: async () => {
        calls += 1
        if (calls === 1) throw new Error('Mail is not running')
        return { threads: [thread()], ownerAddresses: [], sentReadable: true, limits: [] }
      },
    },
  )

  assert.equal(result.counts.meetings, 2, 'a mailbox failure is degraded, not fatal')
  assert.ok(result.briefs[0].blindSpots.some((gap) => /could not read Mail/i.test(gap)))
})

test('the audio queue is capped however many meetings tomorrow holds', async (t) => {
  const events = Array.from({ length: 6 }, (_unused, index) =>
    meeting({
      uid: `e${index}`,
      title: `Meeting ${index}`,
      start: `2026-08-07T${String(8 + index).padStart(2, '0')}:00:00`,
      end: `2026-08-07T${String(9 + index).padStart(2, '0')}:00:00`,
    }),
  )
  const { deps, shelf } = harness(t, { events })

  await runOvernightMeetingPrep(
    { now: NOW, collect: false, roots: [], maxMeetings: 6, sinks: SPEECH_ONLY },
    deps,
  )

  assert.ok(
    shelf.length <= QUEUE_BUDGET.maxItems,
    'meeting prep’s footprint on the shared shelf is constant, so it can never evict another producer',
  )
  assert.equal(shelf.at(-1).topic, 'Meeting 0', 'the earliest meetings are the ones that fit')
})

test('the narration leads with the person who is waiting', () => {
  const spoken = narrateMeeting({
    meeting: { title: 'Pendant firmware review', start: '2026-08-07T09:00:00' },
    attendees: [{ name: 'Jorge Roji', isOwner: false }],
    threads: [thread()],
    questions: [{ text: 'Do we keep the ESP32 bridge?' }],
    actions: [],
    documents: [],
  })

  assert.ok(spoken.indexOf('have not replied') < spoken.indexOf('Still open'))
  assert.ok(spoken.split(/\s+/).length <= QUEUE_BUDGET.wordsPerItem)
})

test('the overnight brief never accepts a sink that transmits', async (t) => {
  const { deps } = harness(t)
  await assert.rejects(
    () => runOvernightMeetingPrep({ now: NOW, sinks: ['file', 'email'] }, deps),
    /never sends/,
  )
  assert.deepEqual([...OVERNIGHT_SINKS], ['file', 'speech'])
})

test('the written brief demotes each meeting so the day keeps the only H1', () => {
  const note = renderOvernightNote({
    title: "Tomorrow's meetings",
    briefs: [{ brief: '# Pendant firmware review\n\n## Documents\n' }],
  })
  assert.match(note, /^# Tomorrow's meetings/)
  assert.match(note, /## Pendant firmware review/)
  assert.match(note, /### Documents/)
})

test('the headline says which meeting, not just how many', () => {
  const lines = overnightHeadline({
    briefs: [
      {
        meeting: { title: 'Pendant firmware review', start: '2026-08-07T09:00:00' },
        threads: [thread()],
        questions: [{ text: 'x' }],
      },
    ],
    forDate: 'Friday',
  })
  assert.match(lines[0], /Pendant firmware review/)
  assert.match(lines[1], /waiting on your reply/)
})
