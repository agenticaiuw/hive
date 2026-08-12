import { listEvents, listOpenReminders } from './appleData.js'

/*
 * Reading Reminders and Calendar, as planner-reachable actions.
 *
 * WHY THIS FILE EXISTS AT ALL — job local_bd15c683-ba80-4079-9498-925112883bcd.
 *
 * The command was "pendant: reminders brief". The planner had create_reminder,
 * whose description ends "Never use run_shell or raw AppleScript for
 * reminders", and it had no way to READ a reminder. Told not to write
 * AppleScript and given no alternative, it wrote AppleScript anyway:
 *
 *   repeat with r in (every reminder whose completed is false)
 *     set out to out & (name of r) & "|" & ((due date of r) as string) & …
 *
 * That never returns. Every `name of r` and `due date of r` inside the loop is
 * its own Apple Event round trip into Reminders.app, which answers each one
 * against an iCloud-backed store — measured by hand on this Mac: killed at 60s
 * with no output. A prohibition is not a capability. The fix is the tool, not
 * a firmer sentence in the prompt.
 *
 * The reads go through appleData.js (EventKit predicates) rather than through
 * Reminders.app's or Calendar.app's AppleScript dictionary. Even the bulk
 * AppleScript form — `name of (reminders of L whose completed is false)`, one
 * round trip per property per LIST instead of per item — measured ~21s here.
 * EventKit's indexed predicate answers the same question in well under a
 * second, from the same store, under the same TCC grant the Mac agent already
 * holds. briefingTriage.js, dayPlan.js and meetingPrep.js have been reading
 * that way for months; this only puts the same reader behind an action type.
 *
 * Everything below the two action handlers is pure: normalising params, then
 * shaping rows into something a pendant can say out loud. That split is what
 * lets the tests cover the behaviour without a live Reminders.app.
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/* Spoken replies are heard, not read: the pendant has no screen to scroll.
 * The full rows still ride on the result for the dashboard and the job store. */
const SPOKEN_ROWS = 4

/** Read open reminders. Fast, bounded, and never a per-item AppleScript loop. */
export async function listRemindersAction(
  action,
  { readReminders = listOpenReminders, now = new Date() } = {},
) {
  const query = normalizeReminderQuery(action?.params, now)
  const rows = selectReminders(await readReminders({}), query, now)

  return {
    action,
    ok: true,
    status: 'success',
    message: describeReminders(rows, query, now),
    reminders: rows.items,
    count: rows.items.length,
    total: rows.total,
    truncated: rows.truncated,
    query: { list: query.list, dueWithinDays: query.dueWithinDays, limit: query.limit },
  }
}

/** Read calendar events in a window. Same contract, same reasons. */
export async function listCalendarEventsAction(
  action,
  { readEvents = listEvents, now = new Date() } = {},
) {
  const query = normalizeEventQuery(action?.params, now)
  const found = await readEvents({ from: query.from, to: query.to })
  const rows = selectEvents(found, query)

  return {
    action,
    ok: true,
    status: 'success',
    message: describeEvents(rows, query, now),
    events: rows.items,
    count: rows.items.length,
    total: rows.total,
    truncated: rows.truncated,
    query: {
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      calendar: query.calendar,
      limit: query.limit,
    },
  }
}

/* ------------------------------------------------------------- reminders */

/**
 * Params as the planner might plausibly write them.
 *
 * The aliases are not politeness. sanitizeActions passes params through
 * untouched, so a plan that says `listName` instead of `list` reaches here
 * verbatim; treating that as an empty filter would silently widen the read
 * rather than fail it, and the owner would hear the wrong list's contents.
 */
export function normalizeReminderQuery(params = {}, now = new Date()) {
  const source = params && typeof params === 'object' ? params : {}
  const list = firstString(source.list, source.listName, source.name)
  const dueWithinDays = positiveNumber(
    source.dueWithinDays ?? source.withinDays ?? source.days,
  )

  return {
    list,
    dueWithinDays,
    limit: boundedLimit(source.limit ?? source.max ?? source.count),
    /* A day window is a question about deadlines, so an undated item is not a
     * quiet member of it — it is a different answer. Without a window every
     * open item counts, undated ones included. */
    includeUndated:
      source.includeUndated === undefined
        ? dueWithinDays == null
        : Boolean(source.includeUndated),
    cutoff:
      dueWithinDays == null
        ? null
        : new Date(now.getTime() + dueWithinDays * 86_400_000),
  }
}

/** Filter, sort and cap. Pure — `rows` is whatever the reader handed back. */
export function selectReminders(rows, query, now = new Date()) {
  const wanted = (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row) return false
    if (query.list && !sameName(row.list, query.list)) return false
    if (!row.due) return query.includeUndated
    if (query.cutoff && Date.parse(row.due) > query.cutoff.getTime()) return false
    return true
  })

  wanted.sort(compareByDue)

  return {
    total: wanted.length,
    truncated: wanted.length > query.limit,
    items: wanted.slice(0, query.limit).map((row) => ({
      id: row.id ?? null,
      title: String(row.title ?? '(untitled)'),
      list: row.list ?? null,
      due: row.due ?? null,
      overdue: Boolean(row.due && Date.parse(row.due) < now.getTime()),
      priority: Number(row.priority) || 0,
      notes: row.notes ?? null,
    })),
  }
}

/** The sentence the pendant says. Bounded by SPOKEN_ROWS, never by luck. */
export function describeReminders(rows, query, now = new Date()) {
  const scope = query.list ? ` in ${query.list}` : ''
  if (!rows.total) {
    return query.dueWithinDays
      ? `Nothing due${scope} in the next ${plural(query.dueWithinDays, 'day')}.`
      : `Nothing open in Reminders${scope}.`
  }

  const spoken = rows.items
    .slice(0, SPOKEN_ROWS)
    .map((row) => `${row.title}${row.due ? ` (${relativeDue(row.due, now)})` : ''}`)
    .join(', ')
  const rest = rows.total - Math.min(SPOKEN_ROWS, rows.items.length)

  return `${plural(rows.total, 'open reminder')}${scope}: ${spoken}${
    rest > 0 ? `, and ${rest} more.` : '.'
  }`
}

/* -------------------------------------------------------------- calendar */

export function normalizeEventQuery(params = {}, now = new Date()) {
  const source = params && typeof params === 'object' ? params : {}
  const explicitFrom = toDateOrNull(source.from ?? source.start)
  const explicitTo = toDateOrNull(source.to ?? source.end)
  const days = positiveNumber(source.days ?? source.dayCount ?? source.withinDays)

  const from = explicitFrom ?? new Date(now)
  /* Default window is the rest of today. "What's on my calendar" asked at 4pm
   * means the meetings still ahead, not the ones already sat through — and a
   * window that ends at midnight is one every caller can predict. */
  const to = explicitTo ?? endOfDay(new Date(from.getTime() + (Math.max(1, days ?? 1) - 1) * 86_400_000))

  return {
    from,
    to: to.getTime() > from.getTime() ? to : new Date(from.getTime() + 3_600_000),
    calendar: firstString(source.calendar, source.calendarName),
    limit: boundedLimit(source.limit ?? source.max ?? source.count),
  }
}

export function selectEvents(rows, query) {
  const wanted = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && (!query.calendar || sameName(row.calendar, query.calendar)),
  )
  wanted.sort((left, right) => Date.parse(left.start) - Date.parse(right.start))

  return {
    total: wanted.length,
    truncated: wanted.length > query.limit,
    items: wanted.slice(0, query.limit).map((row) => ({
      uid: row.uid ?? null,
      title: String(row.title ?? '(untitled)'),
      start: row.start ?? null,
      end: row.end ?? null,
      allDay: Boolean(row.allDay),
      location: row.location ?? null,
      calendar: row.calendar ?? null,
    })),
  }
}

export function describeEvents(rows, query, now = new Date()) {
  const scope = query.calendar ? ` on ${query.calendar}` : ''
  if (!rows.total) return `Nothing on the calendar${scope} in that window.`

  const spoken = rows.items
    .slice(0, SPOKEN_ROWS)
    .map((row) =>
      row.allDay ? `${row.title} (all day)` : `${row.title} at ${clockTime(row.start, now)}`,
    )
    .join(', ')
  const rest = rows.total - Math.min(SPOKEN_ROWS, rows.items.length)

  return `${plural(rows.total, 'event')}${scope}: ${spoken}${
    rest > 0 ? `, and ${rest} more.` : '.'
  }`
}

/* ----------------------------------------------------------------- parts */

/* Undated last rather than first. An item with no due date is not urgent, and
 * sorting nulls to the front is how a list of them buries the overdue one. */
function compareByDue(left, right) {
  const a = left.due ? Date.parse(left.due) : Number.POSITIVE_INFINITY
  const b = right.due ? Date.parse(right.due) : Number.POSITIVE_INFINITY
  if (a !== b) return a - b
  return String(left.title ?? '').localeCompare(String(right.title ?? ''))
}

function sameName(value, wanted) {
  return String(value ?? '').trim().toLowerCase() === String(wanted).trim().toLowerCase()
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return null
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function boundedLimit(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(number), MAX_LIMIT)
}

function toDateOrNull(value) {
  if (value == null || value === '') return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function endOfDay(date) {
  const copy = new Date(date)
  copy.setHours(23, 59, 59, 999)
  return copy
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/* "overdue" / "today at 4pm" / "Thu" — what a person would say, because this
 * text is spoken. An ISO string read aloud is unusable. */
export function relativeDue(due, now = new Date()) {
  const when = new Date(due)
  if (Number.isNaN(when.getTime())) return 'no date'
  if (when.getTime() < now.getTime()) return 'overdue'

  const days = calendarDaysBetween(now, when)
  if (days === 0) return `today ${clockTime(when, now)}`
  if (days === 1) return `tomorrow ${clockTime(when, now)}`
  if (days < 7) return when.toLocaleDateString('en-US', { weekday: 'long' })
  return when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function clockTime(value, now) {
  const when = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(when.getTime())) return ''
  void now
  return when
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(':00', '')
    .toLowerCase()
}

function calendarDaysBetween(from, to) {
  const a = new Date(from)
  const b = new Date(to)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}
