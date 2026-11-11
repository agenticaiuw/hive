import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/* Prepared follow-ups are written under workspace/meeting-followup, a module
 * constant with no override, and this file reads workspacePath itself — so the
 * redirect has to land before config.js is evaluated. */
import './testWorkspace.js'

import { workspacePath } from './config.js'
import {
  formatSummary,
  matchMeetingFollowupCommand,
  mostRecentlyEnded,
  pickNotes,
  prepareMeetingFollowup,
  withoutAgentOutput,
} from './meetingFollowup.js'

const NOW = new Date('2026-08-07T15:30:00Z')

function meeting(overrides = {}) {
  return {
    uid: 'evt-1',
    title: 'Pendant enclosure review',
    start: '2026-08-07T14:00:00.000Z',
    end: '2026-08-07T15:00:00.000Z',
    allDay: false,
    location: 'Room 3187',
    notes: 'Agenda: gasket, antenna cutout',
    attendees: ['Dana Vogel', 'Jorge Peralta'],
    ...overrides,
  }
}

/* ---------- which meeting ---------- */

test('the meeting that just ended wins, and one still running is left alone', () => {
  const picked = mostRecentlyEnded(
    [
      meeting({ uid: 'old', title: 'Standup', end: '2026-08-07T13:00:00.000Z' }),
      meeting({ uid: 'done', title: 'Enclosure review', end: '2026-08-07T15:00:00.000Z' }),
      meeting({
        uid: 'running',
        title: 'Office hours',
        start: '2026-08-07T15:00:00.000Z',
        end: '2026-08-07T16:00:00.000Z',
      }),
    ],
    { now: NOW },
  )
  assert.equal(picked.uid, 'done')
})

test("the owner's own recurring nudge is not a meeting to write up", () => {
  const picked = mostRecentlyEnded(
    [
      {
        uid: 'nudge',
        title: 'Stand up',
        start: '2026-08-07T15:00:00.000Z',
        end: '2026-08-07T15:05:00.000Z',
        allDay: false,
        location: '',
        attendees: [],
      },
    ],
    { now: NOW },
  )
  assert.equal(picked, null)
})

test('nothing in the window is reported, not invented', async () => {
  const result = await prepareMeetingFollowup(
    { now: NOW, lookbackHours: 4 },
    { readEvents: async () => [], readUnread: async () => [] },
  )
  assert.equal(result.meeting, null)
  assert.match(result.spoken, /No meeting ended in the last 4 hours/)
})

/* ---------- which file is "the notes" ---------- */

test('the file touched during the meeting is the notes, not the best-named one', () => {
  const notes = pickNotes(
    [
      {
        path: '/x/enclosure-review-agenda.md',
        name: 'enclosure-review-agenda.md',
        readable: true,
        modifiedAt: '2026-07-10T09:00:00.000Z',
      },
      {
        path: '/x/scratch.md',
        name: 'scratch.md',
        readable: true,
        modifiedAt: '2026-08-07T14:40:00.000Z',
      },
    ],
    meeting(),
  )
  assert.equal(notes.name, 'scratch.md')
})

/*
 * From the first real run: Zoom saved the chat for a 22:00 meeting at 21:46,
 * so a window that opened at the nominal start found nothing and fell back to
 * a transcript of a different meeting four days earlier.
 */
test('a file written just before the nominal start still counts as the notes', () => {
  const notes = pickNotes(
    [
      {
        path: '/x/summer-interview-agenda.md',
        name: 'summer-interview-agenda.md',
        readable: true,
        modifiedAt: '2026-07-10T09:00:00.000Z',
      },
      {
        path: '/x/2026-08-07 13.46 Interview/meeting_saved_new_chat.txt',
        name: 'meeting_saved_new_chat.txt',
        readable: true,
        /* 14 minutes before the invite says the meeting began. */
        modifiedAt: '2026-08-07T13:46:00.000Z',
      },
    ],
    meeting(),
  )
  assert.equal(notes.name, 'meeting_saved_new_chat.txt')
})

test('when two files were both written during it, the later one is the notes', () => {
  const notes = pickNotes(
    [
      { path: '/x/early.md', name: 'early.md', readable: true, modifiedAt: '2026-08-07T14:05:00.000Z' },
      { path: '/x/late.md', name: 'late.md', readable: true, modifiedAt: '2026-08-07T14:55:00.000Z' },
    ],
    meeting(),
  )
  assert.equal(notes.name, 'late.md')
})

test('a PDF is never opened as the notes file', () => {
  const notes = pickNotes(
    [
      {
        path: '/x/deck.pdf',
        name: 'deck.pdf',
        readable: false,
        modifiedAt: '2026-08-07T14:40:00.000Z',
      },
      {
        path: '/x/notes.md',
        name: 'notes.md',
        readable: true,
        modifiedAt: '2026-07-01T09:00:00.000Z',
      },
    ],
    meeting(),
  )
  assert.equal(notes.name, 'notes.md')
})

/*
 * From the first real run: it opened meeting-prep's own COPY of a transcript —
 * from a different meeting — because copying a file gives it a fresh mtime,
 * which made it look like the file someone typed into during this meeting.
 */
test("the agent's own output folders are not the owner's notes", () => {
  const original = {
    path: path.join(os.homedir(), 'Documents/Zoom/2026-08-02 Meetup/transcript.txt'),
    name: 'transcript.txt',
    readable: true,
    modifiedAt: '2026-08-02T21:18:34.000Z',
  }
  const agentCopy = {
    path: path.join(workspacePath, 'meeting-prep/2026-08-07-something/transcript.txt'),
    name: 'transcript.txt',
    readable: true,
    modifiedAt: '2026-08-07T14:40:00.000Z',
  }

  const kept = withoutAgentOutput([agentCopy, original])
  assert.deepEqual(kept, [original])

  /* Without the filter the copy wins on mtime, which is exactly what happened. */
  assert.equal(pickNotes([agentCopy, original], meeting()).path, agentCopy.path)
  assert.equal(pickNotes(kept, meeting()).path, original.path)
})

test('a briefing the agent wrote is not read back as meeting material', () => {
  const kept = withoutAgentOutput([
    { path: path.join(workspacePath, 'Briefings/morning-2026-08-07.md'), name: 'x', readable: true, modifiedAt: '' },
    { path: path.join(workspacePath, 'mail-triage/triage_1/REVIEW.md'), name: 'y', readable: true, modifiedAt: '' },
    { path: path.join(os.homedir(), 'Documents/real-notes.md'), name: 'z', readable: true, modifiedAt: '' },
  ])
  assert.deepEqual(kept.map((entry) => entry.name), ['z'])
})

test('no readable candidate means no notes, rather than a wrong guess', () => {
  assert.equal(
    pickNotes([{ path: '/x/d.pdf', name: 'd.pdf', readable: false, modifiedAt: '2026-08-07T14:40:00.000Z' }], meeting()),
    null,
  )
})

/* ---------- the draft summary ---------- */

test('the summary carries the attendees and marks itself a draft', () => {
  const summary = formatSummary({
    meeting: meeting(),
    notes: { path: '/x/notes.md', name: 'notes.md' },
    actions: [{ text: 'Action item: Jorge will send the BOM', source: 'notes.md' }],
    decisions: [{ text: 'We decided to keep the gasket at 1.2mm', source: 'notes.md' }],
    mail: [],
    now: NOW,
  })

  assert.match(summary, /summary \(DRAFT\)/)
  assert.match(summary, /Nothing here has been sent to anyone/)
  assert.match(summary, /Dana Vogel, Jorge Peralta/)
  assert.match(summary, /- \[ \] Action item: Jorge will send the BOM/)
  assert.match(summary, /We decided to keep the gasket at 1\.2mm/)
  /* The quote names the file it came from — the reader has to be able to
   * check it against the notes. */
  assert.match(summary, /_notes\.md_/)
})

test('an empty section says it is empty instead of quietly disappearing', () => {
  const summary = formatSummary({ meeting: meeting(), notes: null, mail: [], now: NOW })
  assert.match(summary, /Nothing in the notes is written as an action item/)
  assert.match(summary, /no local file looked like notes/)
  assert.match(summary, /No unread mail matches this meeting/)
})

test('mail being unreachable is reported in the file, not swallowed', () => {
  const summary = formatSummary({
    meeting: meeting(),
    notes: null,
    mail: [],
    mailError: 'Mail is not running',
    now: NOW,
  })
  assert.match(summary, /Mail could not be read: Mail is not running/)
})

/* ---------- the whole run ---------- */

test('the workspace is written, the notes are opened, and nothing is sent', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  const notesPath = path.join(workspace, 'enclosure-review-notes.md')
  fs.writeFileSync(
    notesPath,
    [
      '# Enclosure review',
      'We decided to move the antenna cutout 4mm inboard.',
      'Action item: Dana to rerun the drop test by Tuesday.',
      'Random chatter that is not a commitment.',
    ].join('\n'),
  )
  /* Modified during the meeting, which is what makes it the notes. */
  fs.utimesSync(notesPath, new Date('2026-08-07T14:40:00Z'), new Date('2026-08-07T14:40:00Z'))

  const opened = []
  const result = await prepareMeetingFollowup(
    { now: NOW, roots: [workspace] },
    {
      readEvents: async () => [meeting({ title: 'Enclosure review' })],
      readUnread: async () => [
        {
          subject: 'Enclosure gasket sample',
          sender: 'Dana Vogel <dana@lab.example>',
          receivedAt: '2026-08-07T15:10:00',
        },
        { subject: 'Lunch?', sender: 'Ana <ana@x.example>', receivedAt: '2026-08-07T15:12:00' },
      ],
      openTarget: async (target) => opened.push(target),
    },
  )

  assert.equal(result.ok, true)
  assert.equal(result.sent, false)
  assert.equal(result.notes.path, notesPath)
  assert.deepEqual(result.meeting.attendees, ['Dana Vogel', 'Jorge Peralta'])

  /* Both the notes and the draft come forward: a draft the owner has to go
   * looking for is a draft they will not edit. */
  assert.deepEqual(opened, [notesPath, result.summaryPath])
  assert.ok(fs.existsSync(result.summaryPath))

  const written = fs.readFileSync(result.summaryPath, 'utf8')
  assert.match(written, /Dana to rerun the drop test by Tuesday/)
  assert.match(written, /antenna cutout 4mm inboard/)
  assert.ok(!/Random chatter/.test(written))

  /* Only the mail that matches this meeting's terms. */
  assert.deepEqual(result.mail.map((entry) => entry.subject), ['Enclosure gasket sample'])
  assert.match(result.spoken, /Nothing was sent/)

  fs.rmSync(result.folder, { recursive: true, force: true })
})

test('a follow-up refuses a sink that transmits', async () => {
  await assert.rejects(
    prepareMeetingFollowup(
      { sinks: ['file', 'imessage'] },
      { readEvents: async () => [], readUnread: async () => [] },
    ),
    /never sends/i,
  )
})

test('open:false writes the workspace without touching the foreground', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-quiet-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  let openedCount = 0
  const result = await prepareMeetingFollowup(
    { now: NOW, roots: [workspace], open: false },
    {
      readEvents: async () => [meeting()],
      readUnread: async () => [],
      openTarget: async () => {
        openedCount += 1
      },
    },
  )
  assert.equal(openedCount, 0)
  assert.deepEqual(result.opened, [])
  fs.rmSync(result.folder, { recursive: true, force: true })
})

test('a mailbox that will not answer still leaves the owner a workspace', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-nomail-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))

  const result = await prepareMeetingFollowup(
    { now: NOW, roots: [workspace], open: false },
    {
      readEvents: async () => [meeting()],
      readUnread: async () => {
        throw new Error('Mail is not running')
      },
    },
  )
  assert.equal(result.ok, true)
  assert.match(result.mailError, /Mail is not running/)
  assert.ok(fs.existsSync(result.summaryPath))
  fs.rmSync(result.folder, { recursive: true, force: true })
})

/* ---------- routing ---------- */

test('post-meeting phrasings reach the follow-up', () => {
  for (const command of [
    'after each meeting prepare a follow-up workspace',
    'after my meeting',
    'meeting follow-up',
    'post-meeting followup',
    'write up that meeting',
  ]) {
    assert.notEqual(matchMeetingFollowupCommand(command), null, command)
  }
})

test('"follow up" about a person or an email is not a meeting follow-up', () => {
  /* The deterministic path runs with no model behind it, so a matcher that
   * claims this utterance runs the wrong capability outright. */
  for (const command of [
    'follow up with Dana about the BOM',
    'remind me to follow up on that email',
    'prepare me for my next meeting',
    'what did I miss in email',
  ]) {
    assert.equal(matchMeetingFollowupCommand(command), null, command)
  }
})
