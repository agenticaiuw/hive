import assert from 'node:assert/strict'
import test from 'node:test'

/* runBriefing() writes a note into workspace/briefings and records the run in
 * audioBrief.js's .pendant-briefings.json. Both paths are module constants off
 * config.workspacePath, so the workspace is redirected before briefing.js is
 * evaluated rather than each store being injected. */
import './testWorkspace.js'

import {
  BRIEFING_KINDS,
  assertNeverSends,
  composeBriefing,
  deriveNextActions,
  fitSpoken,
  formatClock,
  gatherSources,
  isBulkMail,
  isBriefingNote,
  matchBriefingCommand,
  needsPreparation,
  parseAppleScriptDate,
  parseMacState,
  parseCalendarEvents,
  parseMailMessages,
  parseNotesList,
  summarizeFiles,
  runBriefing,
} from './briefing.js'

/* Real osascript output captured from this Mac, so the parsers are tested
 * against the format Calendar and Mail actually emit. */
const CALENDAR_STDOUT = `台灣節日|Friday, August 7, 2026 at 00:00:00|Friday, August 7, 2026 at 23:59:59|立秋
Extracurricular|Friday, August 7, 2026 at 22:00:00|Friday, August 7, 2026 at 23:00:00|Summer Interview with Evan between Evan Liu and Ching Wei Kang
Extracurricular|Friday, August 7, 2026 at 21:00:00|Friday, August 7, 2026 at 22:00:00|Summer Interview with Evan between Evan Liu and Jorge Roji Pezzoli
Scheduled Reminders|Friday, August 7, 2026 at 09:00:00|Friday, August 7, 2026 at 09:00:00|Ask Jorge to change meeting time
`

const MAIL_STDOUT = `false|Thursday, August 6, 2026 at 08:12:00|"Rappi" <rappi_at_hello_rappi_com_mx_6s8c57w82c_21669c14@privaterelay.appleid.com>|La comida mejor rankeada de tu zona
false|Thursday, August 6, 2026 at 09:30:00|Dana Whitfield <dana@northwind.example>|Contract redlines before Friday
true|Thursday, August 6, 2026 at 10:00:00|Evan Liu via TestFlight <testflight_no_reply@email.apple.com>|Evan Liu has invited you to test AI Pendant.
`

const NOW = new Date(2026, 7, 7, 7, 30, 0)

test('parses the locale date string AppleScript actually emits', () => {
  const parsed = parseAppleScriptDate('Friday, August 7, 2026 at 22:00:00')

  assert.equal(parsed.getFullYear(), 2026)
  assert.equal(parsed.getMonth(), 7)
  assert.equal(parsed.getDate(), 7)
  assert.equal(parsed.getHours(), 22)
  /* Date.parse reads this string as Invalid Date, which is why the parser exists. */
  assert.ok(Number.isNaN(new Date('Friday, August 7, 2026 at 22:00:00').getTime()))
})

test('parses a 12-hour locale rendering too', () => {
  const parsed = parseAppleScriptDate('Friday, August 7, 2026 at 10:05:00 PM')

  assert.equal(parsed.getHours(), 22)
  assert.equal(parsed.getMinutes(), 5)
})

test('calendar rows sort by start time and flag all-day entries', () => {
  const events = parseCalendarEvents(CALENDAR_STDOUT)

  assert.equal(events.length, 4)
  assert.equal(events[0].title, '立秋')
  assert.equal(events[0].allDay, true)
  assert.equal(events.at(-1).title.startsWith('Summer Interview'), true)
  assert.equal(events.at(-1).startsAt.getHours(), 22)
})

test('a title containing the delimiter is not truncated', () => {
  const [event] = parseCalendarEvents(
    'Work|Friday, August 7, 2026 at 09:00:00|Friday, August 7, 2026 at 10:00:00|Ship v2 | then celebrate\n',
  )

  assert.equal(event.title, 'Ship v2 | then celebrate')
})

test('mail read status is inverted into unread, newest first', () => {
  const messages = parseMailMessages(MAIL_STDOUT)

  assert.equal(messages.length, 3)
  /* `read status is true` means the owner already saw it. */
  assert.equal(messages[0].unread, false)
  assert.equal(messages[0].senderName, 'Evan Liu via TestFlight')
  assert.equal(messages.at(-1).unread, true)
})

test('display name falls back to the local part of a bare address', () => {
  const [message] = parseMailMessages(
    'false|Thursday, August 6, 2026 at 09:30:00|dana@northwind.example|Redlines\n',
  )

  assert.equal(message.senderName, 'dana')
})

test('relay and no-reply senders are treated as bulk, humans are not', () => {
  const messages = parseMailMessages(MAIL_STDOUT)

  assert.equal(isBulkMail(messages.find((m) => m.senderName === 'Rappi')), true)
  assert.equal(
    isBulkMail(messages.find((m) => m.senderName === 'Dana Whitfield')),
    false,
  )
})

test('a marketing subject is bulk even from an unremarkable address', () => {
  assert.equal(
    isBulkMail({ sender: 'hello@shop.example', subject: '90% off, last chance' }),
    true,
  )
})

test('only real meetings need preparation', () => {
  const events = parseCalendarEvents(CALENDAR_STDOUT)

  const interview = events.find((event) => /Ching Wei/.test(event.title))
  const holiday = events.find((event) => event.allDay)
  const nudge = events.find((event) => event.calendar === 'Scheduled Reminders')

  assert.equal(needsPreparation(interview), true)
  assert.equal(needsPreparation(holiday), false)
  /* A calendar-backed reminder is a nudge, not something to prepare for. */
  assert.equal(needsPreparation(nudge), false)
})

test('spoken text drops whole sentences rather than cutting a word', () => {
  const spoken = fitSpoken(
    ['Good morning.', 'Two meetings today.', 'A'.repeat(200)],
    60,
  )

  assert.equal(spoken, 'Good morning. Two meetings today.')
  assert.ok(spoken.length <= 60)
})

test('a single oversized sentence is still returned, clipped', () => {
  const spoken = fitSpoken(['A'.repeat(200)], 40)

  assert.equal(spoken.length, 40)
})

test('clock formatting is 12-hour with a padded minute', () => {
  assert.equal(formatClock(new Date(2026, 7, 7, 9, 5)), '9:05 AM')
  assert.equal(formatClock(new Date(2026, 7, 7, 0, 0)), '12:00 AM')
  assert.equal(formatClock(new Date(2026, 7, 7, 13, 0)), '1:00 PM')
})

test('morning brief speaks calendar, mail and files inside the pendant limit', () => {
  const brief = composeBriefing({
    kind: 'morning',
    events: parseCalendarEvents(CALENDAR_STDOUT),
    mail: parseMailMessages(MAIL_STDOUT),
    files: ['~/Desktop/offer.pdf', '~/Documents/notes.md'],
    now: NOW,
  })

  assert.match(brief.spoken, /Good morning\./)
  assert.match(brief.spoken, /meetings today/)
  assert.ok(brief.spoken.length <= 180, `spoken was ${brief.spoken.length} chars`)
  assert.equal(brief.meetingsNeedingPrep.length, 2)
  assert.match(brief.note, /## Calendar/)
  assert.match(brief.note, /## Unread mail/)
  assert.match(brief.note, /## Files touched/)
  assert.match(brief.note, /Nothing was sent/)
})

test('a brief marks the meetings that need preparation in the note', () => {
  const brief = composeBriefing({
    kind: 'morning',
    events: parseCalendarEvents(CALENDAR_STDOUT),
    now: NOW,
  })

  assert.match(brief.note, /Summer Interview with Evan.*\*\(prepare\)\*/)
  /* The holiday must not be flagged. */
  assert.ok(!/立秋.*\(prepare\)/.test(brief.note))
})

test('an empty day says so instead of producing an empty brief', () => {
  const brief = composeBriefing({ kind: 'morning', now: NOW })

  assert.match(brief.spoken, /Nothing on your calendar today\./)
  assert.match(brief.spoken, /No unread mail\./)
  assert.ok(brief.spoken.length > 0)
})

test('an all-newsletter inbox is reported as such, not as work', () => {
  const brief = composeBriefing({
    kind: 'mail',
    mail: parseMailMessages(MAIL_STDOUT).filter((m) => m.senderName === 'Rappi'),
    now: NOW,
  })

  assert.match(brief.spoken, /all newsletters/)
})

test('the mail brief does not invent a calendar section it never read', () => {
  const brief = composeBriefing({
    kind: 'mail',
    mail: parseMailMessages(MAIL_STDOUT),
    events: parseCalendarEvents(CALENDAR_STDOUT),
    now: NOW,
  })

  assert.ok(!brief.sections.some((section) => section.heading === 'Calendar'))
})

test('notes created today drive at most three next actions', () => {
  const notes = parseNotesList(
    `Friday, August 7, 2026 at 09:10:00|Friday, August 7, 2026 at 09:20:00|Interview Questions
Friday, August 7, 2026 at 09:30:00|Friday, August 7, 2026 at 09:40:00|2nd Step
Friday, August 7, 2026 at 10:00:00|Friday, August 7, 2026 at 10:00:00|Pricing ideas
Friday, August 7, 2026 at 11:00:00|Friday, August 7, 2026 at 11:00:00|Fourth note
Tuesday, August 4, 2026 at 09:00:00|Tuesday, August 4, 2026 at 09:00:00|Old note
`,
  )

  const actions = deriveNextActions({ notes, now: new Date(2026, 7, 7, 17, 0) })

  assert.equal(actions.length, 3)
  assert.ok(actions.every((action) => action.startsWith('Follow up on')))
  /* A note from Tuesday is not something you wrote today. */
  assert.ok(!actions.some((action) => /Old note/.test(action)))
})

/*
 * Regression from the first live 5pm run: the brief writes a note, the wrap-up
 * reads today's notes, and it came back telling the owner to "Follow up on
 * 'Evening wrap-up'" — the agent assigning homework about its own output.
 */
test('the wrap-up ignores the notes the briefing itself wrote', () => {
  const notes = parseNotesList(
    `Friday, August 7, 2026 at 09:00:00|Friday, August 7, 2026 at 09:00:00|Interview Questions
Friday, August 7, 2026 at 10:00:00|Friday, August 7, 2026 at 10:00:00|Evening wrap-up — Friday, August 7
Friday, August 7, 2026 at 11:00:00|Friday, August 7, 2026 at 11:00:00|Workday brief — Friday, August 7
Friday, August 7, 2026 at 12:00:00|Friday, August 7, 2026 at 12:00:00|Morning brief — Friday, August 7
`,
  )

  const actions = deriveNextActions({ notes, now: new Date(2026, 7, 7, 17, 0) })

  assert.deepEqual(actions, ['Follow up on "Interview Questions"'])
  assert.equal(isBriefingNote({ title: 'Evening wrap-up — Friday, August 7' }), true)
  /* A note that merely mentions a brief is the owner's, and stays. */
  assert.equal(isBriefingNote({ title: 'Ideas for the morning brief' }), false)
})

test('the wrap-up count does not include its own notes', () => {
  const brief = composeBriefing({
    kind: 'wrapup',
    notes: parseNotesList(
      `Friday, August 7, 2026 at 09:00:00|Friday, August 7, 2026 at 09:00:00|Interview Questions
Friday, August 7, 2026 at 10:00:00|Friday, August 7, 2026 at 10:00:00|Morning brief — Friday, August 7
`,
    ),
    now: new Date(2026, 7, 7, 17, 0),
  })

  assert.match(brief.spoken, /You wrote 1 note today\./)
})

test('next actions fall back to meeting prep and human mail when no notes exist', () => {
  const actions = deriveNextActions({
    events: parseCalendarEvents(CALENDAR_STDOUT),
    mail: parseMailMessages(MAIL_STDOUT),
    now: NOW,
  })

  assert.equal(actions.length, 3)
  assert.match(actions[0], /^Prepare for Summer Interview/)
  assert.ok(actions.some((action) => /Dana Whitfield/.test(action)))
  /* Newsletters never become a next action. */
  assert.ok(!actions.some((action) => /Rappi/.test(action)))
})

test('past meetings are not proposed as things to prepare for', () => {
  const actions = deriveNextActions({
    events: parseCalendarEvents(CALENDAR_STDOUT),
    now: new Date(2026, 7, 7, 23, 30),
  })

  assert.deepEqual(actions, [])
})

test('the wrap-up brief carries its three actions in the note', () => {
  const brief = composeBriefing({
    kind: 'wrapup',
    notes: parseNotesList(
      `Friday, August 7, 2026 at 09:10:00|Friday, August 7, 2026 at 09:20:00|Interview Questions
Friday, August 7, 2026 at 09:30:00|Friday, August 7, 2026 at 09:40:00|2nd Step
`,
    ),
    now: new Date(2026, 7, 7, 17, 0),
  })

  assert.equal(brief.nextActions.length, 2)
  assert.match(brief.note, /## Next actions/)
  /* Newest note first, same convention as mail. */
  assert.match(brief.note, /1\. Follow up on "2nd Step"/)
  assert.match(brief.note, /2\. Follow up on "Interview Questions"/)
  assert.match(brief.spoken, /Good afternoon\./)
})

/*
 * Two lengths for two destinations: the pendant reply is capped at 180, the
 * saved audio is not. A narration clipped to the reply length would be a
 * ten-second brief, which is not a brief.
 */
test('narration carries the detail the 180-character reply cannot', () => {
  const brief = composeBriefing({
    kind: 'morning',
    events: parseCalendarEvents(CALENDAR_STDOUT),
    mail: parseMailMessages(MAIL_STDOUT),
    files: ['~/Desktop/offer.pdf'],
    now: NOW,
  })

  assert.ok(brief.narration.length > brief.spoken.length)
  assert.ok(brief.narration.startsWith(brief.spoken.slice(0, 40)))
  assert.match(brief.narration, /Your day:/)
  assert.match(brief.narration, /Worth preparing for: .*Summer Interview/)
  /* Newsletters are skimmable on a screen and unbearable through a speaker. */
  assert.ok(!/Rappi/.test(brief.narration))
  assert.match(brief.narration, /Mail worth reading: Dana Whitfield/)
})

test('every briefing is composed unsent, and says so', () => {
  const brief = composeBriefing({ kind: 'workday', now: NOW })

  assert.equal(brief.sent, false)
  assert.match(brief.note, /Nothing was sent\./)
})

/*
 * "don't send anything" / "never send messages" is the owner's product ask.
 * These are the tests that make it structural rather than a comment.
 */
test('sending sinks are refused by name', () => {
  for (const sink of ['email', 'imessage', 'slack', 'sms', 'webhook']) {
    assert.throws(() => assertNeverSends([sink]), /never sends/i, sink)
  }
})

test('an unknown sink is refused rather than silently ignored', () => {
  assert.throws(() => assertNeverSends(['telepathy']), /Unknown briefing sink/)
})

test('the sinks every declared kind uses are all non-sending', () => {
  for (const [kind, shape] of Object.entries(BRIEFING_KINDS)) {
    assert.equal(assertNeverSends(shape.sinks), true, kind)
  }
})

test('runBriefing refuses to start when asked to send', async () => {
  await assert.rejects(
    runBriefing({ kind: 'workday', sinks: ['macnote', 'email'] }),
    /never sends/i,
  )
})

test('spoken commands route to the kind the owner asked for', () => {
  const cases = [
    ['prepare my workday', 'workday'],
    ['Prepare My Workday please', 'workday'],
    ['Summarize what I missed in my email today.', 'mail'],
    ['Read my upcoming schedule for the day.', 'schedule'],
    ["what's on my calendar", 'schedule'],
    ['summarize the notes I created today into three next actions', 'wrapup'],
    ['give me a short brief', 'morning'],
    ['every morning check my calendar and unread email', 'morning'],
  ]

  for (const [command, kind] of cases) {
    assert.equal(matchBriefingCommand(command), kind, command)
  }
})

test('unrelated commands are not hijacked into a briefing', () => {
  for (const command of [
    'open Finder',
    'play some music',
    'remind me to call mom',
    'what is the weather',
    '',
  ]) {
    assert.equal(matchBriefingCommand(command), null, command)
  }
})

test('a briefing only reads the sources its kind declares', async () => {
  const seen = []
  const osascript = async (script) => {
    if (/Calendar/.test(script)) seen.push('calendar')
    if (/Mail/.test(script)) seen.push('mail')
    if (/Notes/.test(script)) seen.push('notes')
    return ''
  }
  const shell = async () => {
    seen.push('files')
    return ''
  }

  await gatherSources('schedule', { osascript, shell, automation: true })

  assert.deepEqual(seen, ['calendar'])
})

/*
 * Every app an osascript names needs its own Automation grant, and the first
 * ungranted call throws a dialog across whatever the owner is doing. On a Mac
 * that has not been set up, a briefing must degrade rather than provoke that.
 */
test('app-backed sources are skipped, not attempted, without Automation', async () => {
  const seen = []
  const osascript = async () => {
    seen.push('osascript')
    return ''
  }
  const shell = async () => {
    seen.push('shell')
    return ''
  }

  const gathered = await gatherSources('morning', {
    osascript,
    shell,
    automation: false,
  })

  /* No osascript ran at all — that is the whole point. */
  assert.ok(!seen.includes('osascript'))
  assert.deepEqual(gathered.skipped, ['calendar', 'mail'])
})

test('a brief says which sources it could not read', () => {
  const brief = composeBriefing({
    kind: 'morning',
    files: ['~/Desktop/offer.pdf'],
    skipped: ['calendar', 'mail'],
    now: NOW,
  })

  const notRead = brief.sections.find((section) => section.heading === 'Not read')
  assert.ok(notRead, 'expected a "Not read" section')
  assert.equal(notRead.lines.length, 2)
  /* A skipped source must not be reported as an empty one. */
  assert.ok(!/No unread mail/.test(brief.spoken))
  assert.ok(!/Nothing on your calendar/.test(brief.spoken))
})

test('app-backed sinks are skipped without Automation, storage still happens', async () => {
  const osascript = async () => {
    throw new Error('osascript must not run without Automation')
  }

  const result = await runBriefing({
    kind: 'workday',
    now: NOW,
    automation: false,
    osascript,
    shell: async () => '',
  })

  assert.equal(result.ok, true)
  assert.ok(result.skipped.includes('macnote'))
  assert.equal(result.noteId, undefined)
  /* The markdown note needs no grant, so the brief still lands somewhere. */
  assert.ok(result.path, 'expected the file sink to have written the brief')
})

/* A routine's outcome is stored in .pendant-routines.json on every run, so a
 * megabyte of audio on the result object is a durable-store problem. */
test('the speech sink returns audio metadata, never the samples', async () => {
  const result = await runBriefing({
    kind: 'schedule',
    sinks: ['speech'],
    now: NOW,
    automation: true,
    osascript: async () => CALENDAR_STDOUT,
  })

  assert.ok(result.audio.wavPath.endsWith('.wav'))
  assert.ok(result.audio.seconds > 0)
  assert.equal(result.audio.pcm, undefined)
  assert.equal(result.audio.opus, undefined)
  assert.ok(JSON.stringify(result).length < 200_000)
})

/*
 * Real output from this Mac: 18 superwhisper chunks buried one resume. Each
 * clip has its OWN directory, so grouping by immediate folder saw eighteen
 * lone files and collapsed nothing — hence grouping by a bounded ancestor.
 */
test('an app churning one-file-per-folder still collapses to one line', () => {
  const lines = summarizeFiles([
    '~/Documents/superwhisper/recordings/1786081805/output.wav',
    '~/Documents/superwhisper/recordings/1786081805/meta.json',
    '~/Documents/superwhisper/recordings/1786081886/output.wav',
    '~/Documents/superwhisper/recordings/1786081886/meta.json',
    '~/Downloads/resume.pdf',
    '~/Desktop/offer.pdf',
  ])

  assert.deepEqual(lines, [
    '4 files in ~/Documents/superwhisper/recordings/',
    '~/Downloads/resume.pdf',
    '~/Desktop/offer.pdf',
  ])
})

test('a folder with a couple of files is listed in full', () => {
  const lines = summarizeFiles(['~/Desktop/a.md', '~/Desktop/b.md'])

  assert.deepEqual(lines, ['~/Desktop/a.md', '~/Desktop/b.md'])
})

test('battery is only spoken when it is about to be a problem', () => {
  const low = composeBriefing({
    kind: 'morning',
    macState: { batteryPercent: 8, power: 'on battery', online: true },
    now: NOW,
  })
  const fine = composeBriefing({
    kind: 'morning',
    macState: { batteryPercent: 95, power: 'plugged in', online: true },
    now: NOW,
  })

  assert.match(low.spoken, /8 percent/)
  assert.ok(!/percent/.test(fine.spoken))
  /* Either way it belongs in the note. */
  assert.ok(fine.sections.some((section) => section.heading === 'Mac'))
})

test('mac state is parsed from plain CLIs that need no grant', () => {
  const state = parseMacState(
    'Now drawing from \'Battery Power\'\n -InternalBattery-0 (id=1234)\t42%; discharging; 3:11 remaining present: true\nNetwork: v4(en0)',
  )

  assert.equal(state.batteryPercent, 42)
  assert.equal(state.power, 'on battery')
  assert.equal(state.online, true)
})

test('one broken source degrades to a partial brief instead of no brief', async () => {
  const osascript = async (script) => {
    if (/Mail/.test(script)) throw new Error('Not authorized to send Apple events')
    return CALENDAR_STDOUT
  }

  const gathered = await gatherSources('workday', { osascript })

  assert.equal(gathered.events.length, 4)
  assert.deepEqual(gathered.mail, [])
  assert.equal(gathered.problems.length, 1)
  assert.match(gathered.problems[0], /^mail: .*Not authorized/)
})

test('runBriefing composes and stores without touching a sending path', async () => {
  /* The note script carries the whole brief as its body, so it mentions
   * "Calendar" too — match the write before the reads. */
  const osascript = async (script) => {
    if (/make new note/.test(script)) return 'x-coredata://note/42\n'
    if (/tell application "Calendar"/.test(script)) return CALENDAR_STDOUT
    if (/tell application "Mail"/.test(script)) return MAIL_STDOUT
    return ''
  }

  const result = await runBriefing({
    kind: 'workday',
    sinks: ['macnote'],
    now: NOW,
    automation: true,
    osascript,
  })

  assert.equal(result.ok, true)
  assert.equal(result.sent, false)
  assert.equal(result.noteId, 'x-coredata://note/42')
  assert.match(result.response, /Good morning\./)
  assert.deepEqual(result.problems, [])
})

test('an unknown kind names the kinds that exist', async () => {
  await assert.rejects(runBriefing({ kind: 'nonsense' }), /Try one of: morning/)
})
