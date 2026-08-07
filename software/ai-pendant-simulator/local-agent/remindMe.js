import { createReminder, parseDueDate } from './reminders.js'
import { createRecurringAlarm, RRULE_DAY_CODES } from './appleData.js'

/*
 * "Remind me to do X at 6 pm" and "Every weekday at 9, remind me to stand up"
 * arrive in the same breath and end up in two different places, because they
 * are two different promises.
 *
 *   one-off    -> Apple Reminders. It is the list the owner already checks and
 *                 it syncs to the phone they are actually holding at 6 pm.
 *   recurring  -> a repeating calendar event with an alarm. macOS owns the
 *                 recurrence rule, so "every weekday" stays true across
 *                 reboots and across this agent being asleep at 09:00.
 *
 * routines.js was the obvious home for the repeat and is the wrong one. It
 * knows two schedule shapes, daily and interval, and neither can say "not on
 * Saturday"; expressing weekdays there would mean a daily routine plus a guard
 * the payload has to remember to check, and a reminder that fires on Sunday
 * because a guard was skipped is worse than no reminder. It also only fires
 * while this process is up, which is the wrong dependency for a promise the
 * owner will not be watching. routines stays for recurring *work* the agent
 * has to be awake for anyway — see downloadsTidy.js.
 *
 * SEAM / UNVERIFIED: both writers are injectable and both are stubbed in the
 * tests. Neither has been exercised against live Reminders or Calendar in this
 * session — each named app fires its own macOS Automation prompt and the owner
 * was being interrupted by them.
 */

const WEEKDAY_NAMES = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
}

const WEEKDAYS = [1, 2, 3, 4, 5]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

const LEAD_INS = [
  /^(?:hey\s+)?(?:pendant|assistant)[,:\s]+/i,
  /^(?:please\s+)?remind\s+me\s+(?:to|that|about)\s+/i,
  /^(?:please\s+)?remind\s+me\s+/i,
  /^set\s+a\s+reminder\s+(?:to|for|about)\s+/i,
  /^set\s+a\s+reminder\s+/i,
]

/**
 * Split "every weekday at 9" out of an utterance into a schedule plus the thing
 * being asked for. Returns null for `repeat` when the ask is one-off.
 */
export function parseReminderRequest(utterance, { now = new Date() } = {}) {
  const raw = String(utterance ?? '').trim()
  if (!raw) throw new Error('Nothing to be reminded about.')

  const repeat = parseRecurrence(raw)
  /* Strip the recurrence phrase before the title so the reminder reads
   * "Stand up", not "Every weekday at 9 stand up". */
  const withoutRepeat = repeat ? raw.replace(repeat.matched, ' ') : raw
  const title = cleanTitle(withoutRepeat, repeat)

  if (!title) throw new Error('Could not tell what to be reminded about.')

  if (repeat) {
    return { title, repeat: { days: repeat.days, at: repeat.at }, due: null }
  }

  const due = parseDueDate(raw, now)
  return { title, repeat: null, due }
}

/**
 * Create the reminder the owner asked for. One-off items land in Reminders now;
 * repeats become a routine that will create the same kind of item on each fire.
 */
export async function scheduleReminder(
  { text, title = null, notes = '', listName = null, now = new Date() } = {},
  { create = createReminder, addRecurring = createRecurringAlarm } = {},
) {
  const parsed = parseReminderRequest(text, { now })
  const reminderTitle = String(title || parsed.title)

  if (!parsed.repeat) {
    const created = await create({
      title: reminderTitle,
      due: parsed.due,
      notes,
      listName,
    })
    return {
      ok: true,
      kind: 'one-off',
      title: reminderTitle,
      due: created.due,
      reminderId: created.id,
      spoken: created.due
        ? `Reminder set: ${reminderTitle}, ${speakTime(created.due)}.`
        : `Reminder set: ${reminderTitle}.`,
    }
  }

  const { days, at } = parsed.repeat
  const created = await addRecurring({
    title: reminderTitle,
    at,
    byDay: toRruleDays(days),
    notes,
    now,
  })

  return {
    ok: true,
    kind: 'recurring',
    title: reminderTitle,
    eventUid: created.uid,
    days,
    at,
    recurrence: created.recurrence,
    firstOccurrence: created.firstOccurrence,
    spoken: `I'll remind you to ${lowerFirst(reminderTitle)} ${describeDays(days)} at ${speakClock(at)}.`,
  }
}

/** Day indexes as the RRULE codes macOS stores them under. */
export function toRruleDays(days) {
  const allowed = Array.isArray(days) && days.length ? days : EVERY_DAY
  return allowed.map((day) => RRULE_DAY_CODES[day]).filter(Boolean)
}

function parseRecurrence(text) {
  const lower = text.toLowerCase()

  const everyClause = lower.match(
    /\b(?:every|each)\s+(weekday|weekdays|weekend|day|morning|evening|night|[a-z]+day|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)s?\b/,
  )
  if (!everyClause) return null

  const unit = everyClause[1]
  let days
  if (unit === 'weekday' || unit === 'weekdays') days = WEEKDAYS
  else if (unit === 'weekend') days = [0, 6]
  else if (['day', 'morning', 'evening', 'night'].includes(unit)) days = EVERY_DAY
  else if (WEEKDAY_NAMES[unit] !== undefined) days = [WEEKDAY_NAMES[unit]]
  else return null

  const at = parseClock(lower) || defaultClockFor(unit)
  /* Keep the exact matched span so the caller can cut it out of the title. */
  const timeClause = lower.match(TIME_CLAUSE)
  const matched = [everyClause[0], timeClause?.[0]].filter(Boolean).join('|')

  return {
    days,
    at,
    matched: new RegExp(
      matched
        .split('|')
        .map(escapeRegExp)
        .join('|'),
      'ig',
    ),
  }
}

const TIME_CLAUSE =
  /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?|\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/

function parseClock(lower) {
  const match = lower.match(TIME_CLAUSE)
  if (!match) return null

  const hourText = match[1] ?? match[4]
  const minuteText = match[2] ?? match[5] ?? '0'
  const meridiem = match[3] ?? match[6] ?? ''
  let hour = Number(hourText)
  if (!Number.isFinite(hour)) return null

  if (/p/i.test(meridiem)) hour = hour === 12 ? 12 : hour + 12
  else if (/a/i.test(meridiem)) hour = hour === 12 ? 0 : hour
  /* "every weekday at 9" means 09:00 — a standing morning promise, not 21:00. */

  return `${String(hour % 24).padStart(2, '0')}:${String(Number(minuteText) || 0).padStart(2, '0')}`
}

function defaultClockFor(unit) {
  if (unit === 'evening' || unit === 'night') return '20:00'
  return '09:00'
}

function cleanTitle(text, repeat) {
  let title = String(text)
  if (repeat) title = title.replace(repeat.matched, ' ')

  for (const pattern of LEAD_INS) {
    const stripped = title.replace(pattern, '')
    if (stripped !== title) {
      title = stripped
      break
    }
  }

  return title
    .replace(/^\s*(?:,|to|that|about)\s+/i, '')
    .replace(/\bremind\s+me\s+(?:to|that|about)?\s*/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.-]+|[\s,.-]+$/g, '')
    .slice(0, 120)
}

function describeDays(days) {
  if (days.length === 7) return 'every day'
  if (days.length === 5 && days.every((day) => WEEKDAYS.includes(day))) {
    return 'every weekday'
  }
  if (days.length === 2 && days.includes(0) && days.includes(6)) {
    return 'every weekend'
  }
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return `every ${days.map((day) => names[day]).join(' and ')}`
}

function speakClock(at) {
  const [hour, minute] = String(at).split(':').map(Number)
  const suffix = hour >= 12 ? 'pm' : 'am'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return minute ? `${twelve}:${String(minute).padStart(2, '0')} ${suffix}` : `${twelve} ${suffix}`
}

function speakTime(due) {
  const at = new Date(due)
  if (Number.isNaN(at.getTime())) return 'soon'
  const today = new Date()
  const sameDay = at.toDateString() === today.toDateString()
  const clock = speakClock(
    `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
  )
  return sameDay ? `today at ${clock}` : `${at.toDateString()} at ${clock}`
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
