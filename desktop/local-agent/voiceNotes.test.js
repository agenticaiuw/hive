import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  VOICE_NOTE_DEFAULT_MAX_AGE_MS,
  attachVoiceNotePlace,
  captureVoiceNote,
  deviceClockFromRun,
  forgetVoiceNote,
  getVoiceNote,
  listVoiceNotes,
  markVoiceNoteMoment,
  parseDeviceClock,
  pinVoiceNote,
  planVoiceNoteSweep,
  registerVoiceNotesRoutes,
  remindFromVoiceNote,
  resolveVoiceNotePlace,
  summariseVoiceNotes,
  sweepVoiceNotes,
  tagVoiceNote,
  voiceNoteContext,
  voiceNoteFromPipelineRun,
  voiceNoteIntent,
  voiceNotesLocation,
} from './voiceNotes.js'

/*
 * Every test writes to a temp store. The default path is
 * ~/AI-Pendant-Workspace/.pendant-voice-notes.json — the owner's real notes —
 * and a suite that touched it would be writing the owner's own words as a side
 * effect of `node --test`. audioRetention.js makes the same complaint about
 * audioBrief.js and pipelineTrace.js hard-coding their paths; this module takes
 * a filePath everywhere so the complaint does not apply to it.
 */
function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-voice-notes-test-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return { filePath: path.join(directory, 'voice-notes.json') }
}

const MADISON = 'America/Chicago'
const NOW = Date.parse('2026-08-07T18:00:00.000Z')

/*
 * The real bookmark from ~/AI-Pendant-Workspace/pendant-pipeline.json, copied
 * verbatim on 2026-08-07. Hand-written fixtures drift away from the wire; this
 * one is what the nRF9160 actually produced.
 */
const REAL_BOOKMARK_RUN = {
  pipelineId: 'job_cdbb858b-62e9-4364-af81-ff558bd5ec33',
  kind: 'plan',
  command: '',
  sessionId: null,
  source: 'nrf9160',
  status: 'processing',
  events: [
    {
      stage: 'bookmark',
      status: 'done',
      label: 'Moment bookmark',
      detail:
        'Moment bookmark held on the pendant. captured_at=26/08/07,07:09:45 uptime_s=98 link_at_capture=down',
      text: '',
      source: 'nrf9160',
      meta: { storage: 'microSD', origin: 'pendant-offline-store' },
      at: '2026-08-07T07:12:02.787Z',
    },
  ],
  createdAt: '2026-08-07T07:12:02.787Z',
}

/* A real transcription run, same store, same day. */
const REAL_COMMAND_RUN = {
  pipelineId: 'job_bd572d23-5aa1-4c49-a493-bbcc02dbc870',
  kind: 'plan',
  command: 'open Safari',
  sessionId: '05d27783-6632-4e56-bd55-9b6a876b8ce1',
  source: 'cloud-relay',
  events: [
    {
      stage: 'transcription',
      status: 'done',
      text: 'open Safari',
      source: 'cloud-relay',
      meta: {
        inputTelemetry: {
          audioBytes: 64000,
          format: 'pcm-s16le',
          sampleRate: 15625,
          storage: 'live_lte',
          uploadState: 'uploaded',
          transcriptionModel: 'gpt-audio-1.5',
        },
      },
      at: '2026-08-03T07:12:38.340Z',
    },
  ],
  createdAt: '2026-08-03T07:12:38.340Z',
}

function noteRun(text) {
  return {
    ...REAL_COMMAND_RUN,
    pipelineId: 'job_note_1',
    command: text,
    events: [{ ...REAL_COMMAND_RUN.events[0], text }],
  }
}

/* ------------------------------------------------------------------ intent */

test('a note is recognised by what the owner said, and a command is left alone', () => {
  assert.equal(voiceNoteIntent('Note to self: the porch gutter is loose').isNote, true)
  assert.equal(
    voiceNoteIntent('Note to self: the porch gutter is loose').text,
    'the porch gutter is loose',
  )
  assert.equal(voiceNoteIntent('Make a voice note that the tenant called back').isNote, true)
  assert.equal(voiceNoteIntent('For the record, the invoice was already paid').isNote, true)

  // The 23 transcripts measured on this disk are commands. None of them may
  // become a permanent record of the owner's voice by accident.
  assert.equal(voiceNoteIntent('open Safari').isNote, false)
  assert.equal(voiceNoteIntent("What's the battery level of my MacBook?").isNote, false)
  assert.equal(voiceNoteIntent('Open Outlook.').isNote, false)
})

test('quickCapture\'s shared lead-ins mean the same thing spoken as typed', () => {
  // Delegated rather than copied: two lists would drift and the owner would
  // find a phrase that works in one place and not the other.
  assert.equal(voiceNoteIntent('Remember this: the bike is in the shed').isNote, true)
  assert.equal(
    voiceNoteIntent('Save this idea for later: a pendant that files its own tickets').text,
    'a pendant that files its own tickets',
  )
  assert.equal(voiceNoteIntent('jot this down, the landlord agreed to the repair').isNote, true)
})

test('the longer lead-in wins, so no verb is left dangling', () => {
  assert.equal(
    voiceNoteIntent('Make a voice note to self about the roof').text,
    'the roof',
    '"voice note" must not be matched before "make a voice note to self about"',
  )
})

test('an empty utterance is not a note', () => {
  assert.equal(voiceNoteIntent('   ').isNote, false)
  assert.equal(voiceNoteIntent(null).isNote, false)
})

/* ------------------------------------------------------------------ clocks */

test('the NITZ offset is quarter-hours, not minutes and not hours', () => {
  // 3GPP 27.007: "+32" is eight hours, the single most mis-read field in the
  // string. Reading it as minutes gives UTC+00:32; as hours, UTC+32.
  const parsed = parseDeviceClock('26/08/07,07:09:45+32')
  assert.equal(parsed.offsetMinutes, 480)
  assert.equal(parsed.at, '2026-08-06T23:09:45.000Z')
  assert.equal(parsed.quality, 'wall')

  assert.equal(parseDeviceClock('26/08/07,07:09:45-20').offsetMinutes, -300)
})

test('digits with no offset are not an instant, and are not given one', () => {
  // This is the measured case: the one bookmark on this disk has no offset
  // because the device has never registered with a tower that sends NITZ.
  const parsed = parseDeviceClock('26/08/07,07:09:45')
  assert.equal(parsed.local, '2026-08-07T07:09:45')
  assert.equal(parsed.at, null, 'assuming this Mac\'s zone would be wrong by however far the owner travelled')
  assert.equal(parsed.quality, 'unknown')
  assert.match(parsed.why, /no UTC offset/)
})

test('an unparseable or missing device clock is reported, never guessed', () => {
  for (const bad of ['', null, 'not a clock', '2026-08-07T07:09:45Z']) {
    const parsed = parseDeviceClock(bad)
    assert.equal(parsed.at, null)
    assert.equal(parsed.quality, 'unknown')
  }
})

test('the real bookmark yields its device clock, uptime and link state', () => {
  const clock = deviceClockFromRun(REAL_BOOKMARK_RUN)
  assert.equal(clock.raw, '26/08/07,07:09:45')
  assert.equal(clock.uptimeSeconds, 98)
  assert.equal(clock.linkAtCapture, 'down')
  assert.equal(clock.heldOnDevice, true, 'the link was down, so this sat on the card')
  assert.equal(clock.at, null)
  // A bookmark run has no transcription event; its storage is stamped on the
  // bookmark's own meta. Reading only inputTelemetry reported null for a run
  // that plainly said microSD.
  assert.equal(clock.storage, 'microsd')
})

test('the same sentence makes the same note whichever door it came through', (t) => {
  const at = store(t)
  // The dashboard POST stored the lead-in verbatim while the pipeline path
  // stripped it, so "Note to self: X" and "X" became two different notes.
  const typed = captureVoiceNote(
    { text: 'Note to self: the porch gutter is loose', now: NOW },
    at,
  )
  const spoken = voiceNoteFromPipelineRun(
    'job_note_1',
    { runs: [noteRun('Note to self: the porch gutter is loose')], now: NOW },
    at,
  )

  assert.equal(typed.text, 'the porch gutter is loose')
  assert.equal(spoken.text, typed.text)
  assert.equal(spoken.title, typed.title)
})

test('a live_lte transcription reports the link up and nothing held on the card', () => {
  const clock = deviceClockFromRun(REAL_COMMAND_RUN)
  assert.equal(clock.storage, 'live_lte')
  assert.equal(clock.linkAtCapture, 'up')
  assert.equal(clock.heldOnDevice, false)
})

test('the Mac clock and the device clock are never merged into one number', (t) => {
  const at = store(t)
  const note = captureVoiceNote(
    { text: 'the tenant called back', run: REAL_BOOKMARK_RUN, now: NOW, timeZone: MADISON },
    at,
  )
  // The measured gap is 137 s of store-and-forward. A single timestamp would
  // silently attribute the Mac's clock to the owner's press.
  assert.equal(note.recordedAt, new Date(NOW).toISOString())
  assert.equal(note.context.device.local, '2026-08-07T07:09:45')
  assert.equal(note.context.device.at, null)
  assert.notEqual(note.recordedAt, note.context.device.local)
})

/* ----------------------------------------------------------------- context */

test('the Mac timezone is recorded as where the note was written down, not where the owner was', () => {
  const context = voiceNoteContext({ now: NOW, timeZone: MADISON })
  assert.equal(context.writtenDownIn, MADISON)
  assert.equal(context.localDay, '2026-08-07')
  assert.equal(context.place, null)
  assert.ok(
    !('location' in context) && !('gps' in context) && !('coordinates' in context),
    'no field may exist that could only ever be null',
  )
})

test('a missing place comes with the reason and what was checked', () => {
  const { placeUnavailable } = voiceNoteContext({ now: NOW, timeZone: MADISON })
  assert.deepEqual(placeUnavailable.checked, [
    'gnss',
    'cell-identity',
    'nitz-utc-offset',
    'wifi-ssid',
    'mac-host',
  ])
  assert.match(placeUnavailable.reason, /GNSS is configured but never started/)
  assert.match(placeUnavailable.available, /calendar/i)
})

test('local day is the owner\'s day, not the UTC day', () => {
  // 2026-08-08T01:00Z is 20:00 on the 7th in Madison. Filing it under the 8th
  // is wrong in the one way the owner will notice.
  const context = voiceNoteContext({
    now: Date.parse('2026-08-08T01:00:00.000Z'),
    timeZone: MADISON,
  })
  assert.equal(context.localDay, '2026-08-07')
})

/* ----------------------------------------------------------------- capture */

test('a note survives the pipeline store that produced it', (t) => {
  const at = store(t)
  const note = captureVoiceNote(
    { text: 'the porch gutter is loose', pipelineId: 'job_x', now: NOW, timeZone: MADISON },
    at,
  )

  // pendant-pipeline.json caps at 80 runs and was measured taking 14.6/day, so
  // the source transcript is gone in ~5.5 days. The note must not be.
  const sixDaysLater = NOW + 6 * 24 * 60 * 60 * 1000
  assert.equal(listVoiceNotes({ now: sixDaysLater }, at).length, 1)
  assert.equal(getVoiceNote(note.id, at).text, 'the porch gutter is loose')
})

test('a note is created unpinned — nothing becomes permanent by default', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'buy oat milk', now: NOW }, at)
  assert.equal(note.pinned, false)
})

test('an empty note is refused rather than stored blank', (t) => {
  const at = store(t)
  assert.throws(() => captureVoiceNote({ text: '   ' }, at), /needs something to say/)
})

test('the recording deadline is audioRetention\'s 6 hours, and this module never copies the audio', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'the roof leaks', pipelineId: 'job_x', now: NOW }, at)

  assert.equal(note.recording.linked, true)
  assert.equal(
    Date.parse(note.recording.expiresAt) - NOW,
    6 * 60 * 60 * 1000,
    'captured speech is the shortest-lived thing on disk',
  )
  assert.equal(note.recording.retainedBy, 'audioRetention.js')

  // No VALUE in the record may be a path to audio this module wrote. A copy
  // outside pipeline-audio/ would be invisible to audioRetention's sweeper and
  // would silently defeat deleteAudioForJob().
  const values = []
  const walk = (value) => {
    if (typeof value === 'string') values.push(value)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(note)
  for (const value of values) {
    assert.ok(
      !/\.(wav|opus)$/.test(value.trim()),
      `no field may hold an audio path, found: ${value}`,
    )
  }
  assert.ok(!('audioPath' in note.recording) && !('copiedTo' in note.recording))
})

test('a note read after the deadline says the recording is gone', (t) => {
  const at = store(t)
  captureVoiceNote({ text: 'the roof leaks', pipelineId: 'job_x', now: NOW }, at)

  const [fresh] = listVoiceNotes({ now: NOW + 60_000 }, at)
  assert.equal(fresh.recording.available, true)

  const [stale] = listVoiceNotes({ now: NOW + 7 * 60 * 60 * 1000 }, at)
  assert.equal(stale.recording.expired, true)
  assert.equal(stale.recording.available, false, '"play that back" must fail honestly, not surprisingly')

  // And by id, not only through the list — the two paths must not disagree.
  const byId = getVoiceNote(stale.id, at, { now: NOW + 7 * 60 * 60 * 1000 })
  assert.equal(byId.recording.available, false)
})

test('a note with no run has no recording to promise', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'typed from the dashboard', now: NOW }, at)
  assert.equal(note.recording.linked, false)
  assert.equal(note.recording.expiresAt, null)
})

/* ------------------------------------------------------- from the pipeline */

test('a note is lifted out of a finished run — nothing is re-recorded', (t) => {
  const at = store(t)
  const run = noteRun('Note to self: the landlord agreed to fix the gutter')

  const note = voiceNoteFromPipelineRun('job_note_1', { runs: [run], now: NOW }, at)

  assert.equal(note.text, 'the landlord agreed to fix the gutter', 'the lead-in is not part of the note')
  assert.equal(note.pipelineId, 'job_note_1')
  assert.equal(note.sessionId, REAL_COMMAND_RUN.sessionId)
})

test('a command run is refused as a note unless the owner insists', (t) => {
  const at = store(t)
  assert.throws(
    () => voiceNoteFromPipelineRun('job_bd572d23-5aa1-4c49-a493-bbcc02dbc870', { runs: [REAL_COMMAND_RUN] }, at),
    /reads as a command, not a note/,
  )

  const kept = voiceNoteFromPipelineRun(
    'job_bd572d23-5aa1-4c49-a493-bbcc02dbc870',
    { runs: [REAL_COMMAND_RUN], requireIntent: false, now: NOW },
    at,
  )
  assert.equal(kept.text, 'open Safari')
})

test('a bookmark press has no transcript, and is not turned into an empty note', (t) => {
  const at = store(t)
  assert.throws(
    () => voiceNoteFromPipelineRun(REAL_BOOKMARK_RUN.pipelineId, { runs: [REAL_BOOKMARK_RUN] }, at),
    /no transcript.*markVoiceNoteMoment/s,
  )
})

test('an unknown run is an error, not a blank note', (t) => {
  const at = store(t)
  assert.throws(() => voiceNoteFromPipelineRun('job_nope', { runs: [] }, at), /No pipeline run/)
  assert.throws(() => voiceNoteFromPipelineRun('', { runs: [] }, at), /pipelineId is required/)
})

test('a bookmark becomes a note about the moment, with the device clock it really had', (t) => {
  const at = store(t)
  const note = markVoiceNoteMoment(
    { pipelineId: REAL_BOOKMARK_RUN.pipelineId, run: REAL_BOOKMARK_RUN, now: NOW, timeZone: MADISON },
    at,
  )

  assert.ok(note.tags.includes('bookmark'))
  assert.match(note.text, /held on the pendant — the link was down/)
  assert.equal(note.context.device.uptimeSeconds, 98)
})

/* ------------------------------------------------------------- sensitivity */

test('a spoken secret does not become the label printed in every digest', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'my bike lock code is 4829', now: NOW }, at)

  assert.equal(note.sensitivity, 'secret')
  assert.equal(note.title, 'a private note')
  assert.ok(!note.title.includes('4829'))
})

test('the owner reads their own secret back in full', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'my bike lock code is 4829', now: NOW }, at)
  assert.equal(
    getVoiceNote(note.id, at).text,
    'my bike lock code is 4829',
    'withholding is about what leaves the house, not about the owner',
  )
})

/* --------------------------------------------------------------- searching */

test('notes are searchable by what was said, newest first', (t) => {
  const at = store(t)
  captureVoiceNote({ text: 'the porch gutter is loose', now: NOW - 60_000 }, at)
  captureVoiceNote({ text: 'call the roofer about the gutter', now: NOW }, at)
  captureVoiceNote({ text: 'buy oat milk', now: NOW - 120_000 }, at)

  const found = listVoiceNotes({ query: 'gutter', now: NOW }, at)
  assert.equal(found.length, 2)
  assert.equal(found[0].text, 'call the roofer about the gutter')

  assert.equal(listVoiceNotes({ query: 'submarine', now: NOW }, at).length, 0)
  assert.equal(listVoiceNotes({ now: NOW }, at).length, 3, 'no query means everything')
})

test('notes filter by date range and by tag', (t) => {
  const at = store(t)
  const old = captureVoiceNote({ text: 'last week thing', now: NOW - 7 * 24 * 60 * 60 * 1000 }, at)
  captureVoiceNote({ text: 'today thing', tags: ['House'], now: NOW }, at)

  assert.equal(listVoiceNotes({ since: '2026-08-07T00:00:00.000Z', now: NOW }, at).length, 1)
  assert.equal(listVoiceNotes({ until: '2026-08-02T00:00:00.000Z', now: NOW }, at).length, 1)
  assert.equal(listVoiceNotes({ tag: 'house', now: NOW }, at).length, 1, 'tags are case-folded')
  assert.ok(old.id)
})

test('tags are added, folded and deduplicated', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'the roof leaks', tags: ['House'], now: NOW }, at)
  const tagged = tagVoiceNote(note.id, ['house', 'REPAIR'], { now: NOW }, at)
  assert.deepEqual(tagged.tags, ['house', 'repair'])
})

/* ------------------------------------------------------------ summarising */

test('a summary groups by the owner\'s local day and names what recurs', (t) => {
  const at = store(t)
  captureVoiceNote({ text: 'the porch gutter is loose', now: NOW, timeZone: MADISON }, at)
  captureVoiceNote({ text: 'call the roofer about the gutter', now: NOW - 60_000, timeZone: MADISON }, at)
  captureVoiceNote({
    text: 'the tenant called back',
    now: NOW - 2 * 24 * 60 * 60 * 1000,
    timeZone: MADISON,
  }, at)

  const digest = summariseVoiceNotes({ now: NOW }, at)

  assert.equal(digest.count, 3)
  assert.equal(digest.days.length, 2)
  assert.equal(digest.days[0].day, '2026-08-07', 'newest day first')
  assert.equal(digest.days[0].count, 2)
  assert.ok(digest.themes.includes('gutter'), 'a term in two notes is a theme')
  assert.equal(digest.generatedBy, 'deterministic')
})

test('the summary works with no model, because that is when it is most wanted', (t) => {
  const at = store(t)
  captureVoiceNote({ text: 'the roof leaks', now: NOW }, at)
  const digest = summariseVoiceNotes({ now: NOW }, at)
  assert.match(digest.text, /1 voice note/)
  assert.ok(digest.spoken.length > 0)
})

test('a secret is counted in the summary but never quoted in it', (t) => {
  const at = store(t)
  captureVoiceNote({ text: 'my bike lock code is 4829', now: NOW }, at)
  captureVoiceNote({ text: 'the porch gutter is loose', now: NOW - 1000 }, at)

  const digest = summariseVoiceNotes({ now: NOW }, at)

  assert.equal(digest.count, 2)
  assert.equal(digest.withheld, 1)
  assert.ok(!digest.text.includes('4829'), 'a digest is the most likely thing to be read aloud')
  assert.ok(!digest.spoken.includes('4829'))
  assert.ok(!digest.themes.includes('4829'))
  assert.match(digest.text, /stored privately, not repeated here/)
})

test('the spoken digest fits what the pendant can actually say', (t) => {
  const at = store(t)
  for (let index = 0; index < 40; index += 1) {
    captureVoiceNote({ text: `a long note about the gutter number ${index}`, now: NOW - index * 1000 }, at)
  }
  // pendantSpeech.js truncates at 180 characters; a digest built past that is
  // cut off mid-word by the renderer instead of ending.
  assert.ok(summariseVoiceNotes({ now: NOW }, at).spoken.length <= 180)
})

test('an empty search summarises to a sentence, not a crash', (t) => {
  const at = store(t)
  const digest = summariseVoiceNotes({ query: 'nothing here', now: NOW }, at)
  assert.equal(digest.count, 0)
  assert.equal(digest.spoken, 'No voice notes match that.')
})

test('a caller may inject a real summariser', (t) => {
  const at = store(t)
  captureVoiceNote({ text: 'the roof leaks', now: NOW }, at)
  const digest = summariseVoiceNotes({ now: NOW }, at, {
    summarise: (notes) => ({ text: `LLM saw ${notes.length}`, spoken: 'done' }),
  })
  assert.equal(digest.generatedBy, 'injected')
  assert.equal(digest.text, 'LLM saw 1')
})

/* -------------------------------------------------------------- reminding */

test('a reminder is raised from a note and recorded on it', async (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'call the roofer tomorrow at 9', now: NOW }, at)

  const asked = []
  const result = await remindFromVoiceNote(
    note.id,
    { now: new Date(NOW) },
    at,
    {
      schedule: async (request) => {
        asked.push(request)
        return { ok: true, kind: 'one-off', title: 'call the roofer', due: null, reminderId: 'rem_1' }
      },
    },
  )

  assert.equal(result.noteId, note.id)
  assert.equal(result.reminder.reminderId, 'rem_1')
  assert.equal(getVoiceNote(note.id, at).reminders.length, 1)
  assert.match(asked[0].notes, /From pendant voice note/)
  assert.match(asked[0].notes, /call the roofer tomorrow at 9/)
})

test('a secret note is never copied into a Reminders item', async (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'my bike lock code is 4829', now: NOW }, at)

  const asked = []
  await remindFromVoiceNote(
    note.id,
    { text: 'check the bike', now: new Date(NOW) },
    at,
    {
      schedule: async (request) => {
        asked.push(request)
        return { ok: true, kind: 'one-off', title: 'check the bike', reminderId: 'rem_2' }
      },
    },
  )

  // A Reminders item syncs to a phone, a watch and a lock screen — the widest
  // audience anything in this store gets.
  assert.ok(!JSON.stringify(asked[0]).includes('4829'))
  assert.match(asked[0].notes, /was not copied/)
})

test('reminding from a note that is gone is an error, not a silent no-op', async (t) => {
  const at = store(t)
  await assert.rejects(() => remindFromVoiceNote('vn_nope', {}, at, { schedule: async () => ({}) }), /No voice note/)
})

/* -------------------------------------------------------------- retention */

test('an unpinned note expires; a pinned one does not', (t) => {
  const at = store(t)
  const ordinary = captureVoiceNote({ text: 'buy oat milk', now: NOW }, at)
  const kept = captureVoiceNote({ text: 'the deed is in the blue folder', now: NOW }, at)
  pinVoiceNote(kept.id, { reason: 'I will need this', now: NOW }, at)

  const later = NOW + VOICE_NOTE_DEFAULT_MAX_AGE_MS + 1000
  const plan = planVoiceNoteSweep({ now: later }, at)

  assert.deepEqual(plan.remove.map((entry) => entry.id), [ordinary.id])
  assert.equal(plan.keep.notes, 1)

  const swept = sweepVoiceNotes({ apply: true, now: later }, at)
  assert.equal(swept.applied, true)
  assert.equal(listVoiceNotes({ now: later }, at).length, 1)
  assert.equal(getVoiceNote(kept.id, at).pinned, true)
})

test('pinning is explicit — a note is never exempted just for being a note', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'buy oat milk', now: NOW }, at)
  assert.equal(note.pinned, false)

  const pinned = pinVoiceNote(note.id, { reason: 'keep', now: NOW }, at)
  assert.equal(pinned.pinned, true)
  assert.equal(pinned.pinnedReason, 'keep')
  assert.equal(pinned.pinnedAt, new Date(NOW).toISOString())

  const unpinned = pinVoiceNote(note.id, { pinned: false, now: NOW }, at)
  assert.equal(unpinned.pinned, false)
  assert.equal(unpinned.pinnedReason, null)
})

test('a sweep is a dry run unless it is told otherwise', (t) => {
  const at = store(t)
  captureVoiceNote({ text: 'buy oat milk', now: NOW }, at)
  const later = NOW + VOICE_NOTE_DEFAULT_MAX_AGE_MS + 1000

  const dry = sweepVoiceNotes({ now: later }, at)
  assert.equal(dry.dryRun, true)
  assert.equal(dry.removed.length, 0)
  assert.equal(listVoiceNotes({ now: later }, at).length, 1, 'a GET-shaped mistake must not erase anything')
})

test('the budget is bytes, and it evicts the oldest unpinned note first', (t) => {
  const at = store(t)
  const oldest = captureVoiceNote({ text: 'first thing said', now: NOW - 3000 }, at)
  captureVoiceNote({ text: 'second thing said', now: NOW - 2000 }, at)
  captureVoiceNote({ text: 'third thing said', now: NOW - 1000 }, at)

  const total = planVoiceNoteSweep({ now: NOW }, at).scanned.bytes
  const plan = planVoiceNoteSweep({ now: NOW, maxBytes: total - 1 }, at)

  assert.equal(plan.policy.unit, 'bytes')
  assert.deepEqual(plan.remove.map((entry) => entry.id), [oldest.id])
  assert.equal(plan.remove[0].reason, 'over-budget')
  assert.ok(plan.overBudgetBy > 0)
})

test('the byte budget never evicts what the owner explicitly pinned', (t) => {
  const at = store(t)
  const pinned = captureVoiceNote({ text: 'the deed is in the blue folder', now: NOW - 3000 }, at)
  pinVoiceNote(pinned.id, { now: NOW }, at)
  const ordinary = captureVoiceNote({ text: 'buy oat milk', now: NOW - 2000 }, at)

  // The pinned note is both the oldest and the largest — it would go first
  // under a naive oldest-out rule.
  const plan = planVoiceNoteSweep({ now: NOW, maxBytes: 1 }, at)
  assert.deepEqual(plan.remove.map((entry) => entry.id), [ordinary.id])
  assert.equal(plan.keep.notes, 1)
  assert.equal(plan.pinnedShare, 0.5)
})

test('a zero or a typo in the environment never widens deletion', (t) => {
  const at = store(t)
  captureVoiceNote({ text: 'buy oat milk', now: NOW }, at)

  // PENDANT_VOICE_NOTE_MAX_AGE_DAYS=0 must mean "use the default", never
  // "erase everything" — audioRetention.js's rule, and its reason.
  const plan = planVoiceNoteSweep({ now: NOW, maxAgeMs: 0, maxBytes: 0 }, at)
  assert.equal(plan.policy.maxAgeMs, VOICE_NOTE_DEFAULT_MAX_AGE_MS)
  assert.equal(plan.remove.length, 0)
})

/* --------------------------------------------------------------- forgetting */

test('forgetting a note removes the words AND asks for the recording', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'the roof leaks', pipelineId: 'job_x', now: NOW }, at)

  const asked = []
  const report = forgetVoiceNote(note.id, { now: NOW }, at, {
    deleteAudio: (jobId) => {
      asked.push(jobId)
      return { jobId, complete: true, removed: [], unreachable: [] }
    },
  })

  // "Deleting the recording and keeping the words is not deletion."
  assert.equal(report.removed, true)
  assert.equal(getVoiceNote(note.id, at), null)
  assert.deepEqual(asked, ['job_x'])
  assert.equal(report.complete, true)
})

test('an incomplete audio deletion makes the whole forget incomplete', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'the roof leaks', pipelineId: 'job_x', now: NOW }, at)

  const report = forgetVoiceNote(note.id, { now: NOW }, at, {
    deleteAudio: () => ({
      complete: false,
      unreachable: [{ sink: 'pendant microSD store-and-forward journal', holdsCopy: 'likely' }],
    }),
  })

  assert.equal(report.removed, true, 'the words go either way')
  assert.equal(report.complete, false, 'a copy this process cannot reach must not be reported as gone')
  assert.equal(report.audio.unreachable[0].holdsCopy, 'likely')
})

test('a failing audio delete does not leave the note behind', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'the roof leaks', pipelineId: 'job_x', now: NOW }, at)

  const report = forgetVoiceNote(note.id, { now: NOW }, at, {
    deleteAudio: () => {
      throw new Error('disk on fire')
    },
  })

  assert.equal(getVoiceNote(note.id, at), null)
  assert.equal(report.complete, false)
  assert.match(report.audio.error, /disk on fire/)
})

test('forgetting a note with no run is complete on its own', (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'typed in', now: NOW }, at)
  const report = forgetVoiceNote(note.id, { now: NOW }, at, {
    deleteAudio: () => assert.fail('there is no recording to chase'),
  })
  assert.equal(report.complete, true)
})

test('forgetting something that is not there is a clean answer, not a throw', (t) => {
  const at = store(t)
  const report = forgetVoiceNote('vn_nope', {}, at, { deleteAudio: () => ({}) })
  assert.equal(report.ok, false)
  assert.equal(report.removed, false)
})

/* -------------------------------------------------------------------- place */

test('a calendar event with a real room is the place, labelled as scheduled', async () => {
  const place = await resolveVoiceNotePlace(
    { at: Date.parse('2026-08-07T15:30:00.000Z') },
    {
      readEvents: async () => [
        {
          uid: 'evt_1',
          title: 'Site visit',
          start: '2026-08-07T15:00:00.000Z',
          end: '2026-08-07T16:00:00.000Z',
          allDay: false,
          location: '1204 Williamson St',
          calendar: 'Work',
        },
      ],
    },
  )

  assert.equal(place.place, '1204 Williamson St')
  assert.equal(place.kind, 'calendar-event')
  // The single most important field: a calendar says where the owner was
  // SUPPOSED to be. Nothing on this device senses position.
  assert.equal(place.basis, 'scheduled')
  assert.match(place.detail, /schedule, not a position/)
})

test('a meeting link is not a place', async () => {
  const place = await resolveVoiceNotePlace(
    { at: Date.parse('2026-08-07T15:30:00.000Z') },
    {
      readEvents: async () => [
        {
          uid: 'evt_2',
          title: 'Standup',
          start: '2026-08-07T15:00:00.000Z',
          end: '2026-08-07T16:00:00.000Z',
          allDay: false,
          location: 'https://zoom.us/j/123',
        },
      ],
    },
  )

  assert.equal(place.place, null)
  assert.equal(place.kind, 'virtual')
  assert.match(place.detail, /call, not a room/)
})

test('an all-day event does not say which room the owner was in', async () => {
  const place = await resolveVoiceNotePlace(
    { at: Date.parse('2026-08-07T15:30:00.000Z') },
    {
      readEvents: async () => [
        {
          uid: 'evt_3',
          title: 'Family in town',
          start: '2026-08-07T00:00:00.000Z',
          end: '2026-08-08T00:00:00.000Z',
          allDay: true,
          location: 'Chicago',
        },
      ],
    },
  )
  assert.equal(place.place, null)
  assert.equal(place.kind, 'none')
})

test('the shortest overlapping event wins, being the more specific claim', async () => {
  const place = await resolveVoiceNotePlace(
    { at: Date.parse('2026-08-07T15:30:00.000Z') },
    {
      readEvents: async () => [
        {
          uid: 'evt_long',
          title: 'Offsite',
          start: '2026-08-07T13:00:00.000Z',
          end: '2026-08-07T21:00:00.000Z',
          allDay: false,
          location: '',
        },
        {
          uid: 'evt_short',
          title: 'Breakout',
          start: '2026-08-07T15:15:00.000Z',
          end: '2026-08-07T15:45:00.000Z',
          allDay: false,
          location: 'Room 4021',
        },
      ],
    },
  )
  assert.equal(place.place, 'Room 4021')
  assert.equal(place.eventUid, 'evt_short')
})

test('an empty calendar is "no place", not an error', async () => {
  const place = await resolveVoiceNotePlace({ at: NOW }, { readEvents: async () => [] })
  assert.equal(place.place, null)
  assert.equal(place.kind, 'none')
  assert.match(place.detail, /Nothing was on the calendar/)
})

test('a refused Automation prompt costs the place tag, never the note', async (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'the tenant called back', now: NOW }, at)

  const updated = await attachVoiceNotePlace(note.id, { now: NOW }, at, {
    readEvents: async () => {
      throw new Error('Not authorized to send Apple events to Calendar')
    },
  })

  assert.equal(updated.context.place.kind, 'unavailable')
  assert.equal(updated.text, 'the tenant called back', 'the note itself is untouched')
  assert.ok(updated.context.placeUnavailable, 'and still explains itself')
})

test('a found place is attached after capture, not during it', async (t) => {
  const at = store(t)
  const note = captureVoiceNote({ text: 'the tenant called back', now: NOW }, at)
  assert.equal(note.context.place, null, 'capture must not wait on an osascript round-trip')

  const updated = await attachVoiceNotePlace(note.id, { now: NOW }, at, {
    readEvents: async () => [
      {
        uid: 'evt_1',
        title: 'Site visit',
        start: new Date(NOW - 600_000).toISOString(),
        end: new Date(NOW + 600_000).toISOString(),
        allDay: false,
        location: '1204 Williamson St',
      },
    ],
  })

  assert.equal(updated.context.place.place, '1204 Williamson St')
  assert.equal(updated.context.placeUnavailable, null)
})

test('attaching a place to a note that is gone returns null', async (t) => {
  const at = store(t)
  assert.equal(await attachVoiceNotePlace('vn_nope', {}, at, { readEvents: async () => [] }), null)
})

/* ------------------------------------------------------------------ routes */

test('the routes mount on an Express-shaped app and own their own paths', () => {
  const registered = []
  const app = {
    get: (route) => registered.push(`GET ${route}`),
    post: (route) => registered.push(`POST ${route}`),
    delete: (route) => registered.push(`DELETE ${route}`),
  }

  const { mounted } = registerVoiceNotesRoutes(app, { filePath: '/tmp/nope.json' })

  assert.ok(mounted.length > 0)
  assert.ok(registered.includes('GET /voice-notes'))
  assert.ok(registered.includes('POST /voice-notes/:noteId/pin'))
  assert.ok(registered.includes('DELETE /voice-notes/:noteId'))

  // Express matches in registration order: with /:noteId first, every fixed
  // route below it reads "summary" as an id and 404s. pageWatchRoutes.js
  // documents having shipped exactly that bug.
  const fixed = ['GET /voice-notes/summary', 'GET /voice-notes/context', 'GET /voice-notes/retention']
  for (const route of fixed) {
    assert.ok(
      registered.indexOf(route) < registered.indexOf('GET /voice-notes/:noteId'),
      `${route} must be registered before /voice-notes/:noteId`,
    )
  }
})

test('mounting on something that is not an app is refused loudly', () => {
  assert.throws(() => registerVoiceNotesRoutes(null), /Express-style app/)
  assert.throws(() => registerVoiceNotesRoutes({}), /Express-style app/)
})

test('the store path is the workspace by default and injectable for tests', (t) => {
  const at = store(t)
  assert.equal(voiceNotesLocation(at), at.filePath)
  assert.match(voiceNotesLocation(), /\.pendant-voice-notes\.json$/)
})
