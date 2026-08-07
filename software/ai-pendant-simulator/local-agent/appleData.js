import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/*
 * Calendar, Reminders and Mail, read once and shared.
 *
 * Three capabilities need the same three answers — what is on today, what is
 * due, what is unread — and each of them reaching for its own AppleScript would
 * mean three different definitions of "today" and three different failure
 * modes. So the reads live here and the capabilities compose them.
 *
 * Reads go through EventKit rather than Calendar.app's AppleScript dictionary.
 * `every event whose start date > X` makes Calendar.app walk every event in
 * every calendar in the client process; on this Mac (16 calendars, one of them
 * a subscribed holiday feed) that is tens of seconds. EventKit answers the same
 * question with an indexed predicate in milliseconds, and it is the same store,
 * so the TCC grant Calendar.app already has covers it.
 *
 * Writes go the other way. EventKit's save path wants a live run loop and
 * commit semantics that osascript's JXA bridge does not reliably give it, and a
 * write that silently no-ops is worse than a slow one — so recurring events are
 * created through Calendar.app, which returns the uid it actually stored.
 */

const JXA_TIMEOUT_MS = 20_000

/** Run a JXA snippet and parse its JSON result. */
export async function runJxa(script, { timeoutMs = JXA_TIMEOUT_MS } = {}) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-l', 'JavaScript'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Apple data read timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.trim() || `osascript exited ${code}`))
    })

    child.stdin.end(script)
  })

  const text = String(stdout).trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Apple data read returned non-JSON: ${text.slice(0, 200)}`)
  }
}

/*
 * EventKit's authorization callback never completes under osascript — there is
 * no app run loop to deliver it on. The store still answers reads once the
 * host app holds the TCC grant, so the request is fired and the poll is only
 * there to give a genuinely un-granted machine a chance to prompt.
 */
const EK_PREAMBLE = `
ObjC.import('EventKit')
ObjC.import('Foundation')
function eventStore(kind) {
  const store = $.EKEventStore.alloc.init
  let done = false
  if (kind === 'reminders') store.requestFullAccessToRemindersWithCompletion(() => { done = true })
  else store.requestFullAccessToEventsWithCompletion(() => { done = true })
  const deadline = Date.now() + 1500
  while (!done && Date.now() < deadline) {
    $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.05))
  }
  return store
}
function iso(date) { return date.isNil() ? null : ObjC.unwrap($.NSISO8601DateFormatter.stringFromDate(date)) }
function str(value) { return value && !value.isNil() ? ObjC.unwrap(value) : null }
`

/**
 * Calendar events overlapping [from, to). All-day events are flagged rather
 * than dropped: "Family in town" changes the shape of a day even though it has
 * no clock time.
 */
export async function listEvents({ from, to } = {}) {
  const start = toDate(from)
  const end = toDate(to)

  const events = await runJxa(`${EK_PREAMBLE}
const store = eventStore('events')
const pred = store.predicateForEventsWithStartDateEndDateCalendars(
  $.NSDate.dateWithTimeIntervalSince1970(${Math.floor(start.getTime() / 1000)}),
  $.NSDate.dateWithTimeIntervalSince1970(${Math.floor(end.getTime() / 1000)}),
  $()
)
const found = store.eventsMatchingPredicate(pred)
const out = []
for (let i = 0; i < found.count; i++) {
  const e = found.objectAtIndex(i)
  out.push({
    uid: str(e.eventIdentifier),
    title: str(e.title) || '(untitled)',
    start: iso(e.startDate),
    end: iso(e.endDate),
    allDay: !!e.isAllDay,
    location: str(e.location),
    notes: str(e.notes),
    url: e.URL && !e.URL.isNil() ? str(e.URL.absoluteString) : null,
    calendar: e.calendar && !e.calendar.isNil() ? str(e.calendar.title) : null,
    attendees: (() => {
      const list = e.attendees
      if (!list || list.isNil()) return []
      const names = []
      for (let j = 0; j < list.count && j < 30; j++) {
        const a = list.objectAtIndex(j)
        names.push(str(a.name) || str(a.URL.absoluteString))
      }
      return names.filter(Boolean)
    })(),
  })
}
JSON.stringify(out)
`)

  return (events || []).sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
}

/** Open reminders, with the overdue ones kept — those are today's real work. */
export async function listOpenReminders({ dueBefore = null } = {}) {
  const reminders = await runJxa(`${EK_PREAMBLE}
const store = eventStore('reminders')
const pred = store.predicateForIncompleteRemindersWithDueDateStartingEndingCalendars($(), $(), $())
let result = null
store.fetchRemindersMatchingPredicateCompletion(pred, (found) => { result = found })
const deadline = Date.now() + 8000
while (result === null && Date.now() < deadline) {
  $.NSRunLoop.currentRunLoop.runModeBeforeDate($.NSDefaultRunLoopMode, $.NSDate.dateWithTimeIntervalSinceNow(0.05))
}
const out = []
if (result !== null) {
  for (let i = 0; i < result.count; i++) {
    const r = result.objectAtIndex(i)
    const due = r.dueDateComponents
    out.push({
      id: str(r.calendarItemIdentifier),
      title: str(r.title) || '(untitled)',
      list: r.calendar && !r.calendar.isNil() ? str(r.calendar.title) : null,
      priority: Number(r.priority) || 0,
      notes: str(r.notes),
      due: due && !due.isNil() && !$.NSCalendar.currentCalendar.dateFromComponents(due).isNil()
        ? iso($.NSCalendar.currentCalendar.dateFromComponents(due))
        : null,
    })
  }
}
JSON.stringify(out)
`)

  const list = reminders || []
  if (!dueBefore) return list
  const cutoff = toDate(dueBefore).getTime()
  return list.filter((item) => item.due && Date.parse(item.due) <= cutoff)
}

/**
 * Create a repeating calendar event with an alarm at its start.
 *
 * This is what a recurring reminder actually is on a Mac: macOS owns the
 * recurrence rule, so "every weekday" stays true across reboots, across this
 * agent being asleep at 09:00, and on the phone the owner is holding instead.
 */
export async function createRecurringAlarm({
  title,
  at = '09:00',
  byDay = ['MO', 'TU', 'WE', 'TH', 'FR'],
  calendarName = null,
  notes = '',
  durationMinutes = 5,
  now = new Date(),
} = {}) {
  const summary = String(title || '').trim()
  if (!summary) throw new Error('A recurring reminder needs a title.')

  const start = firstOccurrence({ at, byDay, now })
  const target = calendarName
    ? `calendar "${escapeAppleScript(calendarName)}"`
    : 'first calendar whose writable is true'

  const script = `
tell application "Calendar"
  tell ${target}
    set startDate to current date
    set year of startDate to ${start.getFullYear()}
    set month of startDate to ${start.getMonth() + 1}
    set day of startDate to ${start.getDate()}
    set time of startDate to ${start.getHours() * 3600 + start.getMinutes() * 60}
    set newEvent to make new event with properties {summary:"${escapeAppleScript(summary)}", description:"${escapeAppleScript(notes)}", start date:startDate, end date:startDate + (${Math.max(1, Number(durationMinutes) || 5)} * minutes), recurrence:"FREQ=WEEKLY;INTERVAL=1;BYDAY=${byDay.join(',')}"}
    make new display alarm at end of display alarms of newEvent with properties {trigger interval:0}
    set createdUid to uid of newEvent
  end tell
end tell
return createdUid`

  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: 30_000,
  })
  const uid = String(stdout).trim()
  if (!uid) throw new Error('Calendar did not return an event id.')

  return {
    uid,
    title: summary,
    firstOccurrence: start.toISOString(),
    recurrence: `FREQ=WEEKLY;INTERVAL=1;BYDAY=${byDay.join(',')}`,
  }
}

export async function deleteEventByUid(uid) {
  const script = `
tell application "Calendar"
  repeat with cal in calendars
    tell cal
      set matches to (every event whose uid is "${escapeAppleScript(uid)}")
      if (count of matches) > 0 then
        delete item 1 of matches
        return "deleted"
      end if
    end tell
  end repeat
end tell
return "not found"`
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: 30_000,
  })
  return String(stdout).trim() === 'deleted'
}

/**
 * Recent inbox messages. Read status and sender are the only fields worth the
 * AppleScript round trip — the body is a different, much slower question, and
 * triage is decided on the envelope.
 */
export async function listRecentMail({ limit = 40, unreadOnly = true } = {}) {
  const script = `
set output to ""
tell application "Mail"
  set boxes to {}
  repeat with acct in accounts
    try
      set end of boxes to (mailbox "INBOX" of acct)
    end try
  end repeat
  if (count of boxes) is 0 then set boxes to {inbox}
  repeat with box in boxes
    set msgs to (messages of box)
    set total to count of msgs
    if total > ${Math.max(1, Number(limit) || 40)} then set total to ${Math.max(1, Number(limit) || 40)}
    repeat with i from 1 to total
      set msg to item i of msgs
      try
        set isRead to read status of msg
        if (${unreadOnly ? 'isRead is false' : 'true'}) then
          set output to output & (subject of msg) & tab & (sender of msg) & tab & ((date received of msg) as string) & tab & (isRead as string) & linefeed
        end if
      end try
    end repeat
  end repeat
end tell
return output`

  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: 60_000,
  })

  return String(stdout)
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 4)
    .map(([subject, sender, received, read]) => ({
      subject: subject.trim(),
      sender: sender.trim(),
      receivedAt: received.trim(),
      read: read.trim() === 'true',
    }))
}

/**
 * The first date at or after `now` that satisfies the recurrence, so the series
 * does not start on a day it excludes. Calendar clients disagree about whether
 * a DTSTART outside BYDAY counts as an occurrence; not creating one is the only
 * answer that reads the same everywhere.
 */
export function firstOccurrence({ at = '09:00', byDay = [], now = new Date() } = {}) {
  const [hour, minute] = String(at).split(':').map((part) => Number(part) || 0)
  const allowed = new Set(byDay.map((code) => RRULE_DAY_INDEX[code]).filter((day) => day !== undefined))

  const candidate = new Date(now)
  candidate.setSeconds(0, 0)
  candidate.setHours(hour, minute)
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1)

  for (let step = 0; step < 8; step += 1) {
    if (!allowed.size || allowed.has(candidate.getDay())) return candidate
    candidate.setDate(candidate.getDate() + 1)
  }
  return candidate
}

const RRULE_DAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

export const RRULE_DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function toDate(value) {
  if (value instanceof Date) return value
  const parsed = new Date(value ?? Date.now())
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`)
  return parsed
}

function escapeAppleScript(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
