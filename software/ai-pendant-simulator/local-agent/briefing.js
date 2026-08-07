import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

import { workspacePath } from './config.js'
import { createReminder } from './reminders.js'

const execFileAsync = promisify(execFile)

/*
 * Read the day, say it out loud, write it down. Never send it.
 *
 * Six of the eight capability requests that produced this module are the same
 * shape: look at what already happened (calendar, inbox, files, notes) and hand
 * back a short spoken summary. They differ only in which sources they read and
 * where the result lands, so they are one composer with a `kind`, not six
 * features.
 *
 * The "never send" rule is the owner's product ask, not a safety gate: a brief
 * is something you leave for someone, and a briefing that could mail itself is
 * a different, scarier product. It is enforced structurally — the sink table
 * below is the complete set of things a briefing can do, and none of them
 * transmit. There is no code path from here to Mail's `send`.
 */

/* Calendar's whose-clause walks every event in every calendar; on a real
 * account that is tens of seconds, so it gets its own budget. */
const CALENDAR_TIMEOUT_MS = 90_000
const OSASCRIPT_TIMEOUT_MS = 30_000
const MAIL_LOOKBACK_HOURS = 24
const FILE_LOOKBACK_HOURS = 24
const MAX_MAIL_LINES = 60
const MAX_FILE_LINES = 25
const MAX_NOTE_LINES = 40
/* pendantSpeech hard-slices at 180 characters. Compose to fit so the pendant
 * never says half a word and stops. */
const SPOKEN_LIMIT = 180
const MAX_NEXT_ACTIONS = 3

const briefingDirectory = path.join(workspacePath, 'briefings')
const latestPointerPath = path.join(briefingDirectory, 'latest.json')

/*
 * Which adapters talk to a named macOS app.
 *
 * Every distinct app an `osascript` targets — Calendar, Mail, Notes, Reminders
 * — needs its own Automation (AppleEvents) grant, and the first unapproved
 * call pops a dialog that steals the foreground. This Mac has all of them
 * granted, so the app-backed adapters are ON here.
 *
 * The switch stays because the grants are per-machine and cannot be scripted:
 * on a Mac that has not been through setup, PENDANT_BRIEFING_AUTOMATION=0
 * composes the brief from the sources that need no grant instead of walking
 * the owner through four consent dialogs. It is not an approval step — nothing
 * here asks the owner to confirm anything — it only decides which adapters run.
 */
export const AUTOMATION_ENABLED = process.env.PENDANT_BRIEFING_AUTOMATION !== '0'

/** Adapters that drive a named app, and therefore trigger a consent dialog. */
export const AUTOMATION_ADAPTERS = Object.freeze([
  'calendar',
  'mail',
  'notes',
  'macnote',
  'reminder',
])

export function needsAutomation(adapter) {
  return AUTOMATION_ADAPTERS.includes(String(adapter || '').toLowerCase())
}

/**
 * Everything a briefing is allowed to do with its result. Storage and speech
 * only. Adding a sink that transmits would be a product change, and
 * assertNeverSends is what makes that change impossible to make by accident.
 */
export const BRIEFING_SINKS = Object.freeze([
  'file',
  'speech',
  'macnote',
  'reminder',
])

export const SENDING_SINKS = Object.freeze([
  'email',
  'mail',
  'imessage',
  'message',
  'sms',
  'slack',
  'webhook',
  'post',
])

export function assertNeverSends(sinks = []) {
  for (const sink of sinks) {
    const name = String(sink || '').toLowerCase()
    if (SENDING_SINKS.includes(name)) {
      throw new Error(
        `A briefing composes and stores; it never sends. Refusing sink "${sink}".`,
      )
    }
    if (!BRIEFING_SINKS.includes(name)) {
      throw new Error(`Unknown briefing sink "${sink}".`)
    }
  }
  return true
}

/**
 * The five shapes the owner actually asked for. `sources` is what gets read,
 * `sinks` is where the result lands.
 */
export const BRIEFING_KINDS = Object.freeze({
  morning: {
    title: 'Morning brief',
    sources: ['calendar', 'mail', 'files', 'system'],
    sinks: ['file', 'speech', 'macnote'],
  },
  workday: {
    title: 'Workday brief',
    sources: ['calendar', 'mail', 'files'],
    sinks: ['file', 'macnote'],
  },
  wrapup: {
    title: 'Evening wrap-up',
    sources: ['notes', 'calendar', 'files'],
    sinks: ['file', 'macnote', 'reminder'],
  },
  mail: {
    title: 'Mail brief',
    sources: ['mail'],
    sinks: ['file', 'speech'],
  },
  schedule: {
    title: "Today's schedule",
    sources: ['calendar'],
    sinks: ['file', 'speech'],
  },
})

/*
 * Spoken commands reach this module two ways: the LLM planner emits a
 * compose_briefing action, or this matcher recognises the phrasing first. The
 * matcher exists because a 7am routine that depends on a model round-trip is a
 * routine that silently does nothing during an API outage — and "every morning"
 * is a promise the owner is relying on.
 */
/* Order is the disambiguation. "Every morning, check my calendar and unread
 * email" mentions unread mail but is a morning brief, so the morning patterns
 * are consulted before the single-source ones. */
const COMMAND_PATTERNS = [
  [/\bprepare\s+(?:my\s+)?workday\b|\bprep\s+(?:my\s+)?workday\b|\bstart\s+my\s+workday\b/i, 'workday'],
  [/\b(?:three|3)\s+next\s+actions\b|\bnext\s+actions\b|\bwrap[\s-]?up\b|\bsummar\w+\s+(?:the\s+)?notes\b/i, 'wrapup'],
  [/\b(?:morning|daily)\s+brief\w*\b|\bbrief\s+me\b|\bevery\s+(?:week)?day?\s*morning\b|\bevery\s+morning\b|\bgive\s+me\s+(?:a\s+)?(?:short\s+|concise\s+)?(?:spoken\s+)?brief\w*\b/i, 'morning'],
  [/\bwhat\s+(?:did\s+)?i\s+miss\w*\b.*\b(?:e-?mail|inbox|mail)\b|\b(?:e-?mail|inbox)\b.*\bwhat\s+(?:did\s+)?i\s+miss\w*\b|\bsummar\w+\s+(?:what\s+i\s+missed\s+in\s+)?(?:my\s+)?(?:e-?mail|inbox)\b|\bunread\s+(?:e-?mail|mail)\b/i, 'mail'],
  [/\b(?:read|what'?s?\s+on|check)\b.*\b(?:schedule|calendar|agenda)\b|\bupcoming\s+schedule\b|\bmy\s+schedule\b|\bschedule\s+for\s+(?:the\s+|to)?day\b/i, 'schedule'],
]

/** The briefing kind a spoken command asks for, or null if it asks for something else. */
export function matchBriefingCommand(command) {
  const text = String(command || '').trim()
  if (!text) return null
  for (const [pattern, kind] of COMMAND_PATTERNS) {
    if (pattern.test(text)) return kind
  }
  return null
}

/* ---------- parsing ---------- */

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
}

/**
 * AppleScript renders dates in the user's locale — "Friday, August 7, 2026 at
 * 22:00:00" here, but 12-hour elsewhere. Parse both rather than trusting
 * Date.parse, which reads that string as Invalid Date.
 */
export function parseAppleScriptDate(value) {
  const text = String(value || '').trim()
  if (!text) return null

  const match = text.match(
    /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i,
  )
  if (!match) {
    const parsed = new Date(text)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const month = MONTHS[match[1].toLowerCase()]
  if (month === undefined) return null

  let hour = Number(match[4])
  const meridiem = match[7]
  if (meridiem) {
    hour %= 12
    if (/pm/i.test(meridiem)) hour += 12
  }

  return new Date(
    Number(match[3]),
    month,
    Number(match[2]),
    hour,
    Number(match[5]),
    Number(match[6] || 0),
  )
}

function splitRows(stdout, fieldCount) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('|'))
    .filter((fields) => fields.length >= fieldCount)
}

export function parseCalendarEvents(stdout) {
  return splitRows(stdout, 4)
    .map(([calendar, start, end, ...rest]) => {
      const startsAt = parseAppleScriptDate(start)
      const endsAt = parseAppleScriptDate(end)
      if (!startsAt) return null
      return {
        calendar: calendar.trim(),
        startsAt,
        endsAt,
        /* Titles can contain "|" — rejoin instead of losing the tail. */
        title: rest.join('|').trim(),
        allDay: isAllDay(startsAt, endsAt),
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.startsAt - right.startsAt)
}

function isAllDay(startsAt, endsAt) {
  if (!endsAt) return false
  const startsAtMidnight =
    startsAt.getHours() === 0 && startsAt.getMinutes() === 0
  return startsAtMidnight && endsAt - startsAt >= 23 * 60 * 60 * 1000
}

export function parseMailMessages(stdout) {
  return splitRows(stdout, 4)
    .map(([read, received, sender, ...rest]) => {
      const receivedAt = parseAppleScriptDate(received)
      return {
        /* AppleScript's `read status` is true when the owner has seen it. */
        unread: read.trim().toLowerCase() !== 'true',
        receivedAt,
        sender: sender.trim(),
        senderName: displayName(sender),
        subject: rest.join('|').trim(),
      }
    })
    .filter((message) => message.subject || message.sender)
    .sort((left, right) => (right.receivedAt || 0) - (left.receivedAt || 0))
}

export function parseNotesList(stdout) {
  return splitRows(stdout, 3)
    .map(([created, modified, ...rest]) => ({
      createdAt: parseAppleScriptDate(created),
      modifiedAt: parseAppleScriptDate(modified),
      title: rest.join('|').trim(),
    }))
    .filter((note) => note.title)
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
}

function displayName(sender) {
  const text = String(sender || '').trim()
  const named = text.match(/^"?([^"<]+?)"?\s*<[^>]+>$/)
  if (named) return named[1].trim()
  const local = text.match(/^([^@<]+)@/)
  return local ? local[1].trim() : text
}

/* ---------- judgement ---------- */

/*
 * Hide-My-Email relays and no-reply addresses are where signup mail lands, so
 * they are the strongest available signal for "this is a newsletter". Wrong
 * either way is cheap: a demoted message still appears in the note.
 */
const BULK_SENDER = /no-?reply|do-?not-?reply|newsletter|notification|mailer|marketing|@privaterelay\.appleid\.com|@email\.apple\.com|@mail\./i
const BULK_SUBJECT = /unsubscribe|% off|\bsale\b|\bdeal\b|last chance|last call|limited time|newsletter/i

export function isBulkMail(message) {
  return (
    BULK_SENDER.test(message?.sender || '') ||
    BULK_SUBJECT.test(message?.subject || '')
  )
}

/*
 * A meeting needs preparation when another human is expecting something from
 * you. All-day entries are holidays and birthdays; a calendar-backed reminder
 * is a nudge, not a meeting.
 */
const PREP_TITLE = /\binterview\b|\breview\b|\b1:1\b|\bone[\s-]on[\s-]one\b|\bpresentation\b|\bdemo\b|\bkickoff\b|\bsync\b|\bstandup\b|\bcall with\b|\bmeeting with\b|\bbetween\b.+\band\b/i

export function needsPreparation(event) {
  if (!event || event.allDay) return false
  if (/scheduled reminders|siri suggestions|holiday/i.test(event.calendar || '')) {
    return false
  }
  return PREP_TITLE.test(event.title || '')
}

/*
 * "25 files changed" is true and useless when 18 of them are one app's scratch
 * recordings. Grouping by the immediate folder is not enough — superwhisper
 * gives every clip its own directory, so each looked like a lone file. Group by
 * a bounded ancestor instead (~/Documents/superwhisper/recordings), which is
 * the level an app's output actually shares, and collapse anything busy there.
 */
const FILE_GROUP_DEPTH = 4
const FILES_PER_FOLDER_BEFORE_COLLAPSE = 2

function fileGroupKey(file) {
  const segments = file.split('/')
  segments.pop()
  return segments.slice(0, FILE_GROUP_DEPTH).join('/') || file
}

export function summarizeFiles(files = []) {
  const byFolder = new Map()
  for (const file of files) {
    const key = fileGroupKey(file)
    if (!byFolder.has(key)) byFolder.set(key, [])
    byFolder.get(key).push(file)
  }

  const lines = []
  for (const [folder, entries] of byFolder) {
    if (entries.length > FILES_PER_FOLDER_BEFORE_COLLAPSE) {
      lines.push(`${entries.length} files in ${folder}/`)
    } else {
      lines.push(...entries)
    }
  }
  return lines
}

export function formatClock(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const meridiem = hours >= 12 ? 'PM' : 'AM'
  return `${hours % 12 || 12}:${minutes} ${meridiem}`
}

function isSameDay(left, right) {
  return (
    left instanceof Date &&
    right instanceof Date &&
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

/**
 * Up to three things worth doing next. Deterministic on purpose: the 5pm
 * routine has to produce the same three actions whether or not a model is
 * reachable, and the note keeps the raw material so nothing is hidden.
 */
export function deriveNextActions({
  notes = [],
  events = [],
  mail = [],
  now = new Date(),
} = {}) {
  const actions = []
  const todaysNotes = notes.filter((note) => isSameDay(note.createdAt, now))

  for (const note of todaysNotes) {
    actions.push(`Follow up on "${note.title}"`)
  }

  for (const event of events.filter(needsPreparation)) {
    if (event.startsAt > now) {
      actions.push(`Prepare for ${event.title} at ${formatClock(event.startsAt)}`)
    }
  }

  for (const message of mail.filter(
    (item) => item.unread && !isBulkMail(item),
  )) {
    actions.push(`Reply to ${message.senderName} about "${message.subject}"`)
  }

  return actions.slice(0, MAX_NEXT_ACTIONS)
}

/* ---------- composition ---------- */

/**
 * Trim to whole sentences. Slicing mid-word is the difference between a brief
 * and a device that appears to have crashed.
 */
export function fitSpoken(sentences, limit = SPOKEN_LIMIT) {
  const kept = []
  let length = 0
  for (const sentence of sentences.filter(Boolean)) {
    const addition = kept.length ? sentence.length + 1 : sentence.length
    if (length + addition > limit) break
    kept.push(sentence)
    length += addition
  }
  if (!kept.length && sentences.length) {
    return sentences[0].slice(0, limit)
  }
  return kept.join(' ')
}

function greeting(now) {
  const hours = now.getHours()
  if (hours < 12) return 'Good morning.'
  if (hours < 18) return 'Good afternoon.'
  return 'Good evening.'
}

function countPhrase(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * The whole product, as a pure function: sources in, spoken line and note out.
 * Everything above it gathers, everything below it stores.
 */
export function composeBriefing({
  kind = 'morning',
  events = [],
  mail = [],
  files = [],
  notes = [],
  macState = null,
  skipped = [],
  now = new Date(),
} = {}) {
  const shape = BRIEFING_KINDS[kind] || BRIEFING_KINDS.morning
  const timed = events.filter((event) => !event.allDay)
  const upcoming = timed.filter((event) => event.startsAt >= now)
  const unread = mail.filter((message) => message.unread)
  const priorityMail = unread.filter((message) => !isBulkMail(message))
  const meetingsNeedingPrep = events.filter(needsPreparation)
  const todaysNotes = notes.filter((note) => isSameDay(note.createdAt, now))
  const nextActions = deriveNextActions({ notes, events, mail, now })

  const sentences = []
  const sections = []
  const read = (source) =>
    shape.sources.includes(source) && !skipped.includes(source)

  if (read('calendar')) {
    const next = upcoming[0]
    if (!timed.length) {
      sentences.push('Nothing on your calendar today.')
    } else {
      sentences.push(
        `${countPhrase(timed.length, 'meeting')} today` +
          (next ? `, next is ${next.title} at ${formatClock(next.startsAt)}.` : '.'),
      )
    }
    if (meetingsNeedingPrep.length) {
      sentences.push(
        `${countPhrase(meetingsNeedingPrep.length, 'needs', 'need')} preparation.`,
      )
    }
    sections.push({
      heading: 'Calendar',
      lines: events.length
        ? events.map(
            (event) =>
              `${event.allDay ? 'All day' : formatClock(event.startsAt)} — ${event.title}` +
              `${needsPreparation(event) ? '  *(prepare)*' : ''}` +
              `  _[${event.calendar}]_`,
          )
        : ['Nothing scheduled.'],
    })
  }

  if (read('mail')) {
    if (!unread.length) {
      sentences.push('No unread mail.')
    } else if (priorityMail.length) {
      sentences.push(
        `${countPhrase(unread.length, 'unread email')}, ` +
          `${priorityMail.length} worth reading — ` +
          `${priorityMail
            .slice(0, 2)
            .map((message) => message.senderName)
            .join(' and ')}.`,
      )
    } else {
      sentences.push(
        `${countPhrase(unread.length, 'unread email')}, all newsletters.`,
      )
    }
    sections.push({
      heading: `Unread mail (last ${MAIL_LOOKBACK_HOURS}h)`,
      lines: unread.length
        ? unread.map(
            (message) =>
              `${message.senderName} — ${message.subject}` +
              `${isBulkMail(message) ? '  _(bulk)_' : '  **(priority)**'}`,
          )
        : ['Nothing unread.'],
    })
  }

  if (read('files')) {
    const fileLines = summarizeFiles(files)
    if (files.length) {
      sentences.push(`${countPhrase(files.length, 'file')} changed since yesterday.`)
    }
    sections.push({
      heading: `Files touched (last ${FILE_LOOKBACK_HOURS}h)`,
      lines: fileLines.length ? fileLines : ['Nothing changed.'],
    })
  }

  if (read('notes')) {
    sentences.push(
      todaysNotes.length
        ? `You wrote ${countPhrase(todaysNotes.length, 'note')} today.`
        : 'You did not write any notes today.',
    )
    sections.push({
      heading: 'Notes created today',
      lines: todaysNotes.length
        ? todaysNotes.map((note) => note.title)
        : ['None.'],
    })
  }

  if (read('system') && macState) {
    sections.push({
      heading: 'Mac',
      lines: [
        `Battery ${macState.batteryPercent ?? '?'}%${macState.power ? `, ${macState.power}` : ''}`,
        macState.online ? 'Network up' : 'Network down',
      ],
    })
    /* Only worth saying out loud when it is about to become the owner's
     * problem; otherwise it is filler in a brief that has to stay short. */
    if (macState.batteryPercent !== null && macState.batteryPercent <= 20) {
      sentences.push(`Your Mac is at ${macState.batteryPercent} percent.`)
    }
  }

  if (skipped.length) {
    sections.push({
      heading: 'Not read',
      lines: skipped.map(
        (source) => `${source} — needs an Automation grant on this Mac`,
      ),
    })
  }

  if (nextActions.length && shape.sinks.includes('reminder')) {
    sentences.push(`Top next action: ${nextActions[0]}.`)
    sections.push({
      heading: 'Next actions',
      ordered: true,
      lines: nextActions,
    })
  }

  const headline = [greeting(now), ...sentences]
  const spoken = fitSpoken(headline)
  const title = `${shape.title} — ${now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })}`

  return {
    kind,
    title,
    generatedAt: now.toISOString(),
    /* Two lengths, two destinations: `spoken` is the reply the pendant plays
     * back when the owner asked (capped at 180 by pendantSpeech), `narration`
     * is the long-form audio saved for a brief nobody was waiting on. */
    spoken,
    narration: renderNarration(headline, {
      timed,
      meetingsNeedingPrep,
      priorityMail,
      nextActions,
    }),
    note: renderNote(title, sections, spoken),
    sections,
    nextActions,
    meetingsNeedingPrep,
    priorityMail,
    /* The owner asked for this twice, in those words. */
    sent: false,
  }
}

/*
 * What the brief sounds like read out in full. Bulk mail and calendar noise
 * stay in the note: a list of newsletters is skimmable on a screen and
 * unbearable through a speaker.
 */
function renderNarration(headline, {
  timed,
  meetingsNeedingPrep,
  priorityMail,
  nextActions,
}) {
  const parts = [headline.join(' ')]

  if (timed.length) {
    parts.push(
      `Your day: ${timed
        .map((event) => `${formatClock(event.startsAt)}, ${event.title}`)
        .join('. ')}.`,
    )
  }
  if (meetingsNeedingPrep.length) {
    parts.push(
      `Worth preparing for: ${meetingsNeedingPrep
        .map((event) => event.title)
        .join('. ')}.`,
    )
  }
  if (priorityMail.length) {
    parts.push(
      `Mail worth reading: ${priorityMail
        .map((message) => `${message.senderName}, ${message.subject}`)
        .join('. ')}.`,
    )
  }
  if (nextActions.length) {
    parts.push(`Next actions: ${nextActions.join('. ')}.`)
  }

  return parts.join(' ')
}

function renderNote(title, sections, spoken) {
  const body = [`# ${title}`, '', spoken, '']
  for (const section of sections) {
    body.push(`## ${section.heading}`, '')
    section.lines.forEach((line, index) => {
      body.push(section.ordered ? `${index + 1}. ${line}` : `- ${line}`)
    })
    body.push('')
  }
  body.push('_Composed and stored by the pendant. Nothing was sent._')
  return body.join('\n')
}

/* ---------- gathering ---------- */

async function runOsascript(script, timeoutMs = OSASCRIPT_TIMEOUT_MS) {
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
  })
  return stdout
}

async function runShell(command) {
  const { stdout } = await execFileAsync('/bin/sh', ['-c', command], {
    timeout: OSASCRIPT_TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
  })
  return stdout
}

const CALENDAR_SCRIPT = `
set dayStart to (current date)
set hours of dayStart to 0
set minutes of dayStart to 0
set seconds of dayStart to 0
set dayEnd to dayStart + (1 * days)
set out to ""
tell application "Calendar"
  repeat with cal in calendars
    set calName to name of cal
    tell cal
      set evs to (every event whose start date is greater than or equal to dayStart and start date is less than dayEnd)
      repeat with e in evs
        set out to out & calName & "|" & ((start date of e) as string) & "|" & ((end date of e) as string) & "|" & (summary of e) & linefeed
      end repeat
    end tell
  end repeat
end tell
return out
`

/*
 * Bounded by date on purpose. This inbox has thousands of unread messages, and
 * an unbounded `whose read status is false` walks all of them — the first
 * version of this query hung long enough to drop the HTTP connection.
 */
const MAIL_SCRIPT = `
set cutoff to (current date) - (${MAIL_LOOKBACK_HOURS} * hours)
tell application "Mail"
  set recents to (messages of inbox whose date received is greater than or equal to cutoff)
  set out to ""
  repeat with m in recents
    set out to out & (read status of m as string) & "|" & ((date received of m) as string) & "|" & (sender of m) & "|" & (subject of m) & linefeed
  end repeat
  return out
end tell
`

const NOTES_SCRIPT = `
set cutoff to (current date) - (2 * days)
tell application "Notes"
  set out to ""
  repeat with n in (notes whose modification date is greater than or equal to cutoff)
    set out to out & ((creation date of n) as string) & "|" & ((modification date of n) as string) & "|" & (name of n) & linefeed
  end repeat
  return out
end tell
`

/* Only where the owner keeps work. A home-wide mdfind returns browser caches
 * and sync logs, which is noise dressed up as a briefing. */
const FILES_COMMAND = `mdfind -onlyin "$HOME/Desktop" -onlyin "$HOME/Documents" -onlyin "$HOME/Downloads" 'kMDItemFSContentChangeDate >= $time.today(-1) && kMDItemContentType != public.folder' 2>/dev/null | head -${MAX_FILE_LINES}`

export async function gatherCalendarToday({ osascript = runOsascript } = {}) {
  return parseCalendarEvents(await osascript(CALENDAR_SCRIPT, CALENDAR_TIMEOUT_MS))
}

export async function gatherRecentMail({ osascript = runOsascript } = {}) {
  return parseMailMessages(await osascript(MAIL_SCRIPT)).slice(0, MAX_MAIL_LINES)
}

export async function gatherRecentNotes({ osascript = runOsascript } = {}) {
  return parseNotesList(await osascript(NOTES_SCRIPT)).slice(0, MAX_NOTE_LINES)
}

export async function gatherRecentFiles({ shell = runShell } = {}) {
  const stdout = await shell(FILES_COMMAND)
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => file.replace(process.env.HOME || '', '~'))
}

/* pmset and scutil are plain CLIs — no app is told anything, so no consent
 * dialog. Cheap, and it means a brief still has something to say when the
 * app-backed sources are off. */
export function parseMacState(stdout) {
  const text = String(stdout || '')
  const battery = text.match(/(\d{1,3})%/)
  const power = /AC Power/i.test(text)
    ? 'plugged in'
    : /Battery Power/i.test(text)
      ? 'on battery'
      : null
  const online = /Network: *\S/.test(text) || /address *: *\d/.test(text)
  return {
    batteryPercent: battery ? Number(battery[1]) : null,
    power,
    online,
  }
}

export async function gatherMacState({ shell = runShell } = {}) {
  return parseMacState(await shell('pmset -g batt; scutil --nwi'))
}

/**
 * Read only what this kind of briefing needs. A source that fails is reported
 * as an empty list plus a note in `problems`: a brief missing its mail section
 * is still worth hearing, and a silent 7am routine is not.
 */
export async function gatherSources(kind, deps = {}) {
  const shape = BRIEFING_KINDS[kind] || BRIEFING_KINDS.morning
  const automation = deps.automation ?? AUTOMATION_ENABLED
  const gathered = {
    events: [],
    mail: [],
    files: [],
    notes: [],
    macState: null,
    skipped: [],
    problems: [],
  }

  const jobs = {
    calendar: () => gatherCalendarToday(deps).then((v) => (gathered.events = v)),
    mail: () => gatherRecentMail(deps).then((v) => (gathered.mail = v)),
    files: () => gatherRecentFiles(deps).then((v) => (gathered.files = v)),
    notes: () => gatherRecentNotes(deps).then((v) => (gathered.notes = v)),
    system: () => gatherMacState(deps).then((v) => (gathered.macState = v)),
  }

  await Promise.all(
    shape.sources.map((source) => {
      /* Skipping beats prompting: reading this source would put a macOS
       * consent dialog in front of whatever the owner is doing. */
      if (needsAutomation(source) && !automation) {
        gathered.skipped.push(source)
        return Promise.resolve()
      }
      return jobs[source]().catch((error) => {
        gathered.problems.push(`${source}: ${String(error?.message || error)}`)
      })
    }),
  )

  return gathered
}

/* ---------- storage ---------- */

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * A real Notes.app note, which is what "a note on my Mac" means. Notes renders
 * its body as HTML, so the markdown is converted rather than pasted in raw.
 */
export async function writeMacNote(
  { title, body },
  { osascript = runOsascript } = {},
) {
  const html = String(body || '')
    .split('\n')
    .map((line) => `<div>${escapeHtml(line) || '<br>'}</div>`)
    .join('')

  const script = `
tell application "Notes"
  set newNote to make new note with properties {name:"${escapeAppleScript(title)}", body:"${escapeAppleScript(html)}"}
  return id of newNote
end tell
`
  return String(await osascript(script)).trim()
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function writeBriefingFile(briefing) {
  fs.mkdirSync(briefingDirectory, { recursive: true })
  const stamp = briefing.generatedAt.replace(/[:.]/g, '-')
  const filePath = path.join(briefingDirectory, `${briefing.kind}-${stamp}.md`)
  fs.writeFileSync(filePath, briefing.note)
  fs.writeFileSync(
    latestPointerPath,
    JSON.stringify({ ...briefing, path: filePath }, null, 2),
  )
  return filePath
}

export function readLatestBriefing() {
  if (!fs.existsSync(latestPointerPath)) return null
  try {
    return JSON.parse(fs.readFileSync(latestPointerPath, 'utf8'))
  } catch {
    return null
  }
}

/* ---------- delivery ---------- */

/**
 * The sink table. Storage and speech; there is deliberately no transport here.
 *
 * `speech` renders the long-form narration through audioBrief.js — the same
 * store, wire format and files the research briefs use, so one briefing shelf
 * holds both and `GET /briefings/latest` finds either.
 *
 * SEAM, still open: the pendant cannot be told a brief is waiting. The bridge
 * polls the relay for work and answers per-job (bridge.js pollForWork), so the
 * Mac has no way to push unsolicited audio to a device that did not ask. What
 * works today is pull and local playback — the audio is on disk and on the
 * shelf the moment the routine fires, `playBriefingOnMac` speaks it from the
 * Mac's own speakers, and a pendant that asks gets it from
 * pendantSpeechForBriefing. A 7am brief arriving in the owner's ear unprompted
 * needs an outbound announce channel on the relay, which is out of reach from
 * here.
 */
const SINKS = Object.freeze({
  /* The default "note on my Mac": a markdown file in the workspace, same
   * convention as computerControl's create_note, and no app is involved. */
  file: async (briefing) => ({ path: writeBriefingFile(briefing) }),

  macnote: async (briefing, deps) => ({
    noteId: await writeMacNote(
      { title: briefing.title, body: briefing.note },
      deps,
    ),
  }),

  reminder: async (briefing) => {
    const created = []
    for (const action of briefing.nextActions) {
      created.push(await createReminder({ title: action, notes: briefing.title }))
    }
    return { reminders: created }
  },

  speech: async (briefing, { play = false } = {}) => {
    const { briefingSlug, renderBriefAudio, saveBriefing, playBriefingOnMac } =
      await import('./audioBrief.js')

    const basename = briefingSlug(
      `${briefing.kind}-brief`,
      briefing.generatedAt,
    )
    const audio = renderBriefAudio({ text: briefing.narration, basename })
    const stored = saveBriefing({
      topic: briefing.title,
      mode: briefing.kind,
      headline: briefing.spoken,
      notePath: briefing.path ?? null,
      wavPath: audio.wavPath,
      opusPath: audio.opusPath,
      seconds: audio.seconds,
      pcmBytes: audio.pcmBytes,
      opusBytes: audio.opusBytes,
      truncated: audio.truncated,
      spoken: briefing.narration,
    })

    if (play) playBriefingOnMac(stored)

    /* Metadata only. renderBriefAudio hands back the PCM and Opus buffers it
     * just wrote; spreading those into the result made a routine's stored
     * outcome a 7.8 MB JSON blob. The bytes are on disk, and the pendant
     * payload is rebuilt from there by pendantSpeechForBriefing. */
    return {
      audio: {
        id: stored.id,
        wavPath: audio.wavPath,
        opusPath: audio.opusPath,
        seconds: audio.seconds,
        words: audio.words,
        pcmBytes: audio.pcmBytes,
        opusBytes: audio.opusBytes,
        truncated: audio.truncated,
      },
      briefingId: stored.id,
    }
  },
})

/**
 * Compose one briefing and put it where the owner will find it.
 *
 * Nothing here asks permission — the owner's standing instruction is maximum
 * access — and nothing here transmits, which is the behaviour they asked for.
 */
export async function runBriefing({
  kind = 'morning',
  sinks = null,
  play = false,
  now = new Date(),
  ...deps
} = {}) {
  const shape = BRIEFING_KINDS[kind]
  if (!shape) {
    throw new Error(
      `Unknown briefing kind "${kind}". Try one of: ${Object.keys(BRIEFING_KINDS).join(', ')}.`,
    )
  }

  const automation = deps.automation ?? AUTOMATION_ENABLED
  const requested = sinks || shape.sinks
  assertNeverSends(requested)

  const gathered = await gatherSources(kind, { ...deps, automation })
  const briefing = composeBriefing({ ...gathered, kind, now })

  const delivered = {}
  const skipped = [...gathered.skipped]
  const problems = [...gathered.problems]
  for (const sink of requested) {
    if (needsAutomation(sink) && !automation) {
      skipped.push(sink)
      continue
    }
    try {
      /* Later sinks read what earlier ones produced — `speech` records the
       * note path that `file` just wrote. */
      Object.assign(briefing, await SINKS[sink](briefing, { ...deps, play }))
    } catch (error) {
      problems.push(`${sink}: ${String(error?.message || error)}`)
    }
  }

  return {
    ok: true,
    status: 'success',
    ...briefing,
    ...delivered,
    response: briefing.spoken,
    summary: briefing.spoken,
    skipped,
    /* Say out loud what was not read, so a thin brief is never mistaken for a
     * quiet day. */
    automation,
    problems,
  }
}
