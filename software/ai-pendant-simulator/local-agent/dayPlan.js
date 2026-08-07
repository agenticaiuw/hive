import { listEvents, listOpenReminders } from './appleData.js'

/*
 * "Plan my day. Pull my calendar, summarize critical tasks and travel time, and
 * give me a 30-second briefing."
 *
 * The hard constraint is the 30 seconds, not the pulling. A calendar and a task
 * list are trivially dumped and uselessly long; the whole job is deciding what
 * to leave out. So the briefing is built against a word budget (~165 words per
 * minute of speech) and the sections are ordered by what changes the owner's
 * next hour: what is next, what will make them late, what is overdue.
 *
 * Travel is reported as the gap the owner actually has, not as a routing
 * estimate dressed up as fact. A meeting whose location is a Zoom URL has no
 * travel time at all, and treating "https://uwmadison.zoom.us/..." as an
 * address is how briefings end up telling people to leave for a video call.
 */

/* Speech, not reading: 165 wpm is an unhurried spoken pace. */
const WORDS_PER_MINUTE = 165

const VIRTUAL_LOCATION =
  /^(https?:\/\/|zoom|meet\.google|teams\.microsoft|webex|hangout|phone|call\b|tel:)/i

/* Below this between two places you are physically moving, not "free". */
const TIGHT_TRANSITION_MINUTES = 20

export function isVirtualLocation(location) {
  const text = String(location || '').trim()
  if (!text) return true
  return VIRTUAL_LOCATION.test(text)
}

/**
 * Everything the day is made of, in one shape the briefing and the pendant can
 * both render. Readers are injectable so the shaping is testable without the
 * owner's calendar.
 */
export async function buildDayPlan(
  { now = new Date(), horizonHours = 18 } = {},
  { readEvents = listEvents, readReminders = listOpenReminders } = {},
) {
  const start = new Date(now)
  const endOfWindow = new Date(now.getTime() + horizonHours * 60 * 60 * 1000)
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)

  const [events, reminders] = await Promise.all([
    readEvents({ from: start, to: endOfWindow > endOfDay ? endOfWindow : endOfDay }),
    readReminders({}),
  ])

  const timed = (events || [])
    .filter((event) => !event.allDay)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
  const allDay = (events || []).filter((event) => event.allDay)

  return {
    generatedAt: new Date(now).toISOString(),
    events: timed,
    allDayEvents: allDay,
    next: timed[0] ?? null,
    transitions: findTransitions(timed),
    conflicts: findConflicts(timed),
    tasks: rankTasks(reminders || [], now),
    briefing: null,
  }
}

/**
 * Turn the plan into something that fits in the promised seconds. Returns the
 * text plus the measurement, so a briefing that overran is visible rather than
 * merely long.
 */
export function formatBriefing(plan, { seconds = 30, now = new Date() } = {}) {
  const budget = Math.max(20, Math.round((seconds / 60) * WORDS_PER_MINUTE))
  const lines = []

  const timed = plan.events
  if (!timed.length && !plan.tasks.length) {
    return finishBriefing(['Your calendar is clear and nothing is overdue.'], budget, seconds)
  }

  if (timed.length) {
    const next = timed[0]
    const minutesAway = Math.round((Date.parse(next.start) - now.getTime()) / 60_000)
    lines.push(
      `${timed.length} thing${timed.length === 1 ? '' : 's'} on today. First is ${next.title} ${
        minutesAway <= 0 ? 'now' : minutesAway < 90 ? `in ${minutesAway} minutes` : `at ${clock(next.start)}`
      }${next.location && !isVirtualLocation(next.location) ? ` at ${shortLocation(next.location)}` : ''}.`,
    )
    const last = timed.at(-1)
    if (timed.length > 1) lines.push(`You are done after ${last.title} at ${clock(last.end)}.`)
  }

  for (const transition of plan.transitions.filter((item) => item.tight).slice(0, 2)) {
    lines.push(
      `Tight one: ${transition.gapMinutes} minutes between ${transition.from} and ${transition.to}, and they are in different places.`,
    )
  }

  for (const conflict of plan.conflicts.slice(0, 1)) {
    lines.push(`${conflict.a} and ${conflict.b} overlap at ${clock(conflict.at)}.`)
  }

  const critical = plan.tasks.filter((task) => task.critical).slice(0, 3)
  if (critical.length) {
    lines.push(
      `Critical: ${critical.map((task) => task.title).join(', ')}.`,
    )
  } else if (plan.tasks.length) {
    lines.push(`${plan.tasks.length} open tasks, none overdue.`)
  }

  if (plan.allDayEvents.length) {
    lines.push(`All day: ${plan.allDayEvents.map((event) => event.title).join(', ')}.`)
  }

  return finishBriefing(lines, budget, seconds)
}

function finishBriefing(lines, budget, seconds) {
  /* Trim by sentence, never mid-sentence: a briefing that stops in the middle
   * of a word is worse than one that leaves the last item out. */
  const kept = []
  let words = 0
  for (const line of lines) {
    const count = countWords(line)
    if (words + count > budget && kept.length) break
    kept.push(line)
    words += count
  }

  const text = kept.join(' ')
  return {
    text,
    words,
    budgetWords: budget,
    estimatedSeconds: Math.round((words / WORDS_PER_MINUTE) * 60),
    targetSeconds: seconds,
    droppedLines: lines.length - kept.length,
  }
}

/**
 * The gap between one event ending and the next starting, and whether that gap
 * has to absorb a change of place.
 */
export function findTransitions(events) {
  const transitions = []
  for (let index = 0; index < events.length - 1; index += 1) {
    const current = events[index]
    const next = events[index + 1]
    const gapMinutes = Math.round((Date.parse(next.start) - Date.parse(current.end)) / 60_000)
    if (gapMinutes < 0) continue

    const currentVirtual = isVirtualLocation(current.location)
    const nextVirtual = isVirtualLocation(next.location)
    const movesPlace =
      !nextVirtual &&
      normalizePlace(current.location) !== normalizePlace(next.location) &&
      !(currentVirtual && nextVirtual)

    transitions.push({
      from: current.title,
      to: next.title,
      gapMinutes,
      movesPlace,
      fromLocation: current.location || null,
      toLocation: next.location || null,
      tight: movesPlace && gapMinutes <= TIGHT_TRANSITION_MINUTES,
    })
  }
  return transitions
}

export function findConflicts(events) {
  const conflicts = []
  for (let index = 0; index < events.length - 1; index += 1) {
    for (let other = index + 1; other < events.length; other += 1) {
      const a = events[index]
      const b = events[other]
      if (Date.parse(b.start) >= Date.parse(a.end)) break
      conflicts.push({ a: a.title, b: b.title, at: b.start })
    }
  }
  return conflicts
}

/*
 * "Critical" is a claim about consequence, and the only consequence signal in a
 * reminders list that is not the owner's own guess is a due date that has
 * passed. Priority is honoured when set because setting it was a deliberate act.
 */
export function rankTasks(reminders, now = new Date()) {
  const nowMs = new Date(now).getTime()
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)

  return reminders
    .map((task) => {
      const dueMs = task.due ? Date.parse(task.due) : null
      const overdue = Boolean(dueMs && dueMs < nowMs)
      const dueToday = Boolean(dueMs && dueMs >= nowMs && dueMs <= endOfDay.getTime())
      /* EventKit priorities: 1-4 high, 5 medium, 6-9 low, 0 unset. */
      const highPriority = task.priority > 0 && task.priority <= 4
      return {
        ...task,
        overdue,
        dueToday,
        critical: overdue || dueToday || highPriority,
        score: (overdue ? 100 : 0) + (dueToday ? 50 : 0) + (highPriority ? 25 : 0),
      }
    })
    .sort((left, right) => right.score - left.score || compareDue(left, right))
}

function compareDue(left, right) {
  const leftDue = left.due ? Date.parse(left.due) : Infinity
  const rightDue = right.due ? Date.parse(right.due) : Infinity
  return leftDue - rightDue
}

function normalizePlace(location) {
  return String(location || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function shortLocation(location) {
  const text = String(location || '').split(/[,\n]/)[0].trim()
  return text.length > 40 ? `${text.slice(0, 37)}...` : text
}

function clock(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'later'
  const hours = at.getHours()
  const minutes = at.getMinutes()
  const suffix = hours >= 12 ? 'pm' : 'am'
  const twelve = hours % 12 === 0 ? 12 : hours % 12
  return minutes ? `${twelve}:${String(minutes).padStart(2, '0')} ${suffix}` : `${twelve} ${suffix}`
}

function countWords(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length
}
