/*
 * When a routine is next due, in the owner's clock rather than the Worker's.
 *
 * local-agent/routines.js does this arithmetic with plain Date methods, which
 * is correct there: the Mac's process timezone IS the owner's timezone. A
 * Cloudflare Worker runs in UTC everywhere, so `next.setHours(7)` would fire
 * "every morning at 7" at 2am Central. Every schedule therefore carries an
 * IANA timezone and the wall-clock math is done through Intl.
 *
 * The two shapes local-agent already accepts are kept byte-compatible so a
 * routine can be declared once and understood by either side:
 *   {kind:'daily',    at:'HH:MM'}
 *   {kind:'interval', everyMs:N}
 * and two more the relay needs because it is the side that survives sleep:
 *   {kind:'weekly',   at:'HH:MM', days:['mon',...]}   "every weekday at 5"
 *   {kind:'once',     at:'<ISO>'}                     "tell me in an hour"
 */

export const DEFAULT_TIMEZONE = 'America/Chicago'

/* Anything faster than a minute is a poll, not a routine, and the Worker cron
 * that drives this cannot resolve it anyway (one minute is Cloudflare's floor). */
export const MIN_INTERVAL_MS = 60_000

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_ALIASES = new Map([
  ['sunday', 'sun'],
  ['monday', 'mon'],
  ['tuesday', 'tue'],
  ['tues', 'tue'],
  ['wednesday', 'wed'],
  ['weds', 'wed'],
  ['thursday', 'thu'],
  ['thur', 'thu'],
  ['thurs', 'thu'],
  ['friday', 'fri'],
  ['saturday', 'sat'],
])
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri']

const partsFormatterCache = new Map()

function partsFormatter(timeZone) {
  let formatter = partsFormatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    partsFormatterCache.set(timeZone, formatter)
  }
  return formatter
}

export function isValidTimezone(value) {
  const name = String(value || '').trim()
  if (!name) return false
  try {
    partsFormatter(name).format(0)
    return true
  } catch {
    return false
  }
}

/** Wall-clock calendar fields for an instant, in the given zone. */
export function zonedParts(instantMs, timeZone = DEFAULT_TIMEZONE) {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instantMs))
  const field = {}
  for (const part of parts) {
    if (part.type !== 'literal') field[part.type] = part.value
  }
  /* hour12:false answers midnight as '24' in some ICU builds. */
  const hour = Number(field.hour) % 24
  return {
    year: Number(field.year),
    month: Number(field.month),
    day: Number(field.day),
    hour,
    minute: Number(field.minute),
    second: Number(field.second),
    weekday: String(field.weekday || '').slice(0, 3).toLowerCase(),
  }
}

/**
 * The instant at which the given wall clock reads this in the given zone.
 *
 * Two passes: the first uses the offset in force at the naive-UTC guess, the
 * second re-reads the offset at that corrected instant. Without the second
 * pass a 7am routine drifts by an hour for the whole week after a DST change,
 * because the offset was sampled on the wrong side of the transition.
 */
export function instantForZonedTime(
  { year, month, day, hour = 0, minute = 0 },
  timeZone = DEFAULT_TIMEZONE,
) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const offsetAt = (instant) => {
    const local = zonedParts(instant, timeZone)
    return (
      Date.UTC(
        local.year,
        local.month - 1,
        local.day,
        local.hour,
        local.minute,
        local.second,
      ) - instant
    )
  }
  const firstGuess = wall - offsetAt(wall)
  return wall - offsetAt(firstGuess)
}

function parseClock(value, fallback = '08:00') {
  const text = String(value ?? fallback).trim()
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function normalizeDays(value) {
  const raw = Array.isArray(value) ? value : [value]
  const days = []
  for (const entry of raw) {
    const text = String(entry || '').trim().toLowerCase()
    if (!text) continue
    if (text === 'weekdays' || text === 'weekday') {
      for (const day of WEEKDAYS) if (!days.includes(day)) days.push(day)
      continue
    }
    if (text === 'weekends' || text === 'weekend') {
      for (const day of ['sat', 'sun']) if (!days.includes(day)) days.push(day)
      continue
    }
    const short = DAY_ALIASES.get(text) || text.slice(0, 3)
    if (DAY_NAMES.includes(short) && !days.includes(short)) days.push(short)
  }
  return days.sort((a, b) => DAY_NAMES.indexOf(a) - DAY_NAMES.indexOf(b))
}

/**
 * Reject early and say why. A routine with a schedule nobody can compute is
 * worse than no routine: it looks armed on the dashboard and never fires.
 */
export function normalizeSchedule(input) {
  const schedule = input && typeof input === 'object' ? input : {}
  const kind = String(schedule.kind || '').trim().toLowerCase()
  const timezone = isValidTimezone(schedule.timezone)
    ? String(schedule.timezone).trim()
    : DEFAULT_TIMEZONE

  if (kind === 'interval') {
    const everyMs = Number(schedule.everyMs)
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      return { ok: false, error: 'interval schedules need a positive everyMs.' }
    }
    return {
      ok: true,
      schedule: {
        kind: 'interval',
        everyMs: Math.max(MIN_INTERVAL_MS, Math.floor(everyMs)),
        timezone,
      },
    }
  }

  if (kind === 'daily') {
    const clock = parseClock(schedule.at)
    if (!clock) return { ok: false, error: 'daily schedules need at:"HH:MM".' }
    return {
      ok: true,
      schedule: {
        kind: 'daily',
        at: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
        timezone,
      },
    }
  }

  if (kind === 'weekly') {
    const clock = parseClock(schedule.at)
    if (!clock) return { ok: false, error: 'weekly schedules need at:"HH:MM".' }
    const days = normalizeDays(schedule.days)
    if (!days.length) {
      return {
        ok: false,
        error: 'weekly schedules need days, e.g. ["mon","tue"] or ["weekdays"].',
      }
    }
    return {
      ok: true,
      schedule: {
        kind: 'weekly',
        at: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
        days,
        timezone,
      },
    }
  }

  if (kind === 'once') {
    const at = Date.parse(String(schedule.at || ''))
    if (!Number.isFinite(at)) {
      return { ok: false, error: 'once schedules need at:"<ISO timestamp>".' }
    }
    return {
      ok: true,
      schedule: { kind: 'once', at: new Date(at).toISOString(), timezone },
    }
  }

  return {
    ok: false,
    error:
      'schedule must be {kind:"daily"|"weekly"|"interval"|"once"} — see routineSchedule.js.',
  }
}

/**
 * Next fire time in epoch ms, or null when the schedule is spent (a `once`
 * that already ran) or unusable.
 *
 * `from` is exclusive: a routine that just fired at exactly 07:00 gets
 * tomorrow, not an immediate second run.
 */
export function nextRunAt(schedule, from = Date.now()) {
  const normalized = normalizeSchedule(schedule)
  if (!normalized.ok) return null
  const spec = normalized.schedule
  const timezone = spec.timezone

  if (spec.kind === 'interval') return from + spec.everyMs
  if (spec.kind === 'once') {
    const at = Date.parse(spec.at)
    return at > from ? at : null
  }

  const clock = parseClock(spec.at)
  const allowed = spec.kind === 'weekly' ? spec.days : null
  const today = zonedParts(from, timezone)

  /*
   * Walk forward a day at a time from the owner's today. Eight steps covers a
   * full week plus the day a DST jump can push a candidate back across.
   */
  for (let step = 0; step < 8; step += 1) {
    const probe = instantForZonedTime(
      { year: today.year, month: today.month, day: today.day + step, hour: 12 },
      timezone,
    )
    const dayParts = zonedParts(probe, timezone)
    if (allowed && !allowed.includes(dayParts.weekday)) continue
    const candidate = instantForZonedTime(
      {
        year: dayParts.year,
        month: dayParts.month,
        day: dayParts.day,
        hour: clock.hour,
        minute: clock.minute,
      },
      timezone,
    )
    if (candidate > from) return candidate
  }
  return null
}

/** One line for a receipt or a spoken confirmation. */
export function describeSchedule(schedule) {
  const normalized = normalizeSchedule(schedule)
  if (!normalized.ok) return 'an invalid schedule'
  const spec = normalized.schedule
  if (spec.kind === 'interval') {
    const minutes = Math.round(spec.everyMs / 60_000)
    return minutes % 60 === 0 && minutes >= 60
      ? `every ${minutes / 60} hour${minutes === 60 ? '' : 's'}`
      : `every ${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  if (spec.kind === 'once') return `once at ${spec.at}`
  if (spec.kind === 'weekly') {
    const isWeekdays =
      spec.days.length === 5 && WEEKDAYS.every((day) => spec.days.includes(day))
    return `every ${isWeekdays ? 'weekday' : spec.days.join(', ')} at ${spec.at} ${spec.timezone}`
  }
  return `every day at ${spec.at} ${spec.timezone}`
}
