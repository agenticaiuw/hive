/*
 * Scheduled work that survives the Mac going to sleep.
 *
 * local-agent/routines.js already runs routines well — durable store, 30 s
 * tick, straight through orchestratePlan/orchestrateExecute, so a routine can
 * do anything a spoken command can. Its own comment names the cost honestly:
 * "it only fires while the Mac is awake."
 *
 * That cost turns out to be the whole feature. The pendant is worn; the owner
 * is away from the desk; the Mac is closed. The single most common moment for
 * a routine to fire is exactly the moment the only thing that could fire it is
 * asleep. "Every morning send me the news" is unreachable from the Mac,
 * because at 7am the Mac is a lid.
 *
 * So the CLOCK moves to the relay and the WORK stays wherever it can be done:
 *
 *   declared once (here, in D1)  →  due  →  which venue can do this now?
 *                                            ├─ Mac awake  → enqueue a plan
 *                                            │               job; the bridge
 *                                            │               already polls
 *                                            └─ Mac asleep → run it server-
 *                                                            side if it only
 *                                                            needs the public
 *                                                            web, else hold it
 *                                                            for the Mac
 *
 * Not relay-only: the relay cannot read Calendar, Mail, Notes, or the screen,
 * and never will — those live on the owner's machine. Not Mac-only: that is
 * the bug. Declared once and dispatched to whichever half is awake, with the
 * relay owning the clock because the relay is the half that never sleeps.
 *
 * BUDGET NOTE, load-bearing: this runs from a Cron Trigger, and a cron
 * invocation on the Workers Free plan gets 10 ms of CPU (wall clock is 15
 * minutes — awaiting I/O is free). Every expensive thing is therefore either
 * an awaited fetch/D1 call or deferred to somewhere else entirely. Audio in
 * particular is rendered at delivery time inside the WebSocket invocation,
 * never here. Keep it that way: JSON.parse over a big blob in this file is a
 * production outage, not a slow function.
 */
import crypto from 'node:crypto'

import {
  describeSchedule,
  nextRunAt,
  normalizeSchedule,
} from './routineSchedule.js'
import { createAnnouncement } from './announce.js'

export const ROUTINE_VENUES = ['auto', 'mac', 'relay']

/* How long a lease on a due routine is honoured. Long enough that a slow web
 * search cannot let a second tick double-run it, short enough that a Worker
 * killed mid-run frees the routine before the next daily occurrence. */
export const ROUTINE_LEASE_MS = 5 * 60 * 1000

/* A Mac-only routine that came due while the Mac was asleep retries on this
 * cadence rather than burning its occurrence. */
export const DEFER_RETRY_MS = 60_000

/*
 * ...but not forever. "Summarize what I did today" is worth running an hour
 * late when the owner reopens the lid; it is worth nothing three days later,
 * and a queue of stale deferrals would fire all at once the moment the Mac
 * woke up. Twelve hours is one working day of lid-closed time.
 */
export const DEFER_MAX_MS = 12 * 60 * 60 * 1000

/* A dispatched Mac job that never comes back stops being interesting. */
export const MAC_RESULT_MAX_WAIT_MS = 30 * 60 * 1000

export function createRoutineId() {
  return `rtn_${crypto.randomUUID()}`
}

function normalizeVenue(value) {
  const venue = String(value || 'auto').trim().toLowerCase()
  return ROUTINE_VENUES.includes(venue) ? venue : 'auto'
}

function normalizeSources(value) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list
    .map((entry) => String(entry || '').trim())
    .filter((entry) => /^https?:\/\//i.test(entry))
    .slice(0, 4)
}

/**
 * Validate and build a routine record. Throws with the reason rather than
 * storing something that will silently never fire.
 */
export function createRoutine({
  name,
  command,
  schedule,
  venue = 'auto',
  sources = [],
  deviceId = 'nrf9160-pendant',
  announce = true,
  enabled = true,
  now = Date.now(),
}) {
  const text = String(command || '').trim()
  if (!text) throw new Error('A routine needs a command to run.')

  const normalized = normalizeSchedule(schedule)
  if (!normalized.ok) throw new Error(normalized.error)

  const due = nextRunAt(normalized.schedule, now)
  if (due === null) {
    throw new Error('That schedule has no next occurrence.')
  }

  const createdAt = new Date(now).toISOString()
  return {
    routineId: createRoutineId(),
    name: String(name || text).slice(0, 120),
    command: text.slice(0, 600),
    schedule: normalized.schedule,
    scheduleText: describeSchedule(normalized.schedule),
    venue: normalizeVenue(venue),
    sources: normalizeSources(sources),
    deviceId: String(deviceId || 'nrf9160-pendant').trim(),
    announce: Boolean(announce),
    enabled: Boolean(enabled),
    createdAt,
    updatedAt: createdAt,
    nextRunAt: due,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    runCount: 0,
    deferredSince: null,
    dueSince: null,
  }
}

export function updateRoutineRecord(routine, patch = {}, now = Date.now()) {
  const next = { ...routine }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (patch.name) next.name = String(patch.name).slice(0, 120)
  if (patch.command) next.command = String(patch.command).slice(0, 600)
  if (patch.venue) next.venue = normalizeVenue(patch.venue)
  if (patch.sources) next.sources = normalizeSources(patch.sources)
  if (typeof patch.announce === 'boolean') next.announce = patch.announce
  if (patch.schedule) {
    const normalized = normalizeSchedule(patch.schedule)
    if (!normalized.ok) throw new Error(normalized.error)
    const due = nextRunAt(normalized.schedule, now)
    if (due === null) throw new Error('That schedule has no next occurrence.')
    next.schedule = normalized.schedule
    next.scheduleText = describeSchedule(normalized.schedule)
    next.nextRunAt = due
    next.deferredSince = null
    next.dueSince = null
  }
  next.updatedAt = new Date(now).toISOString()
  return next
}

/**
 * Which half of the stack runs this occurrence.
 *
 * `mac` and `relay` are the owner saying it outright. `auto` is the useful
 * case: prefer the Mac, because the Mac can act (open an app, read Mail, run
 * a shell command) while the relay can only read the public web — but fall
 * back to the relay rather than lose the occurrence, because a briefing the
 * owner hears at 7am beats a perfect one they never hear.
 */
export function chooseVenue(routine, { macOnline = false } = {}) {
  const venue = normalizeVenue(routine?.venue)
  if (venue === 'mac') return macOnline ? 'mac' : 'defer'
  if (venue === 'relay') return 'relay'
  if (macOnline) return 'mac'
  /* Nothing to read and nobody awake to act: hold it for the Mac. */
  return routineCanRunOnRelay(routine) ? 'relay' : 'defer'
}

/*
 * The relay's whole toolkit is the public web: Browser Run for pages the owner
 * named, and a web search for everything else. Anything that reaches into the
 * owner's own machine — their calendar, their mail, their files, their screen
 * — is not something a Worker can fake, so those wait for the Mac instead of
 * producing a confidently wrong briefing.
 */
const MAC_ONLY_HINTS =
  /\b(calendar|meeting|email|e-mail|inbox|mail|note|notes|reminder|file|folder|download|screen|desktop|app|application|open|launch|shut ?down|quit|close|volume|brightness|wifi|bluetooth|clipboard|screenshot|terminal|shell|finder|xcode|slack|message)\b/i

export function routineCanRunOnRelay(routine) {
  if (normalizeVenue(routine?.venue) === 'relay') return true
  if (normalizeVenue(routine?.venue) === 'mac') return false
  if (normalizeSources(routine?.sources).length > 0) return true
  return !MAC_ONLY_HINTS.test(String(routine?.command || ''))
}

export function createRunReceipt({
  routine,
  trigger,
  venue,
  now = Date.now(),
}) {
  return {
    runId: `run_${crypto.randomUUID()}`,
    routineId: routine.routineId,
    routineName: routine.name,
    command: routine.command,
    trigger,
    venue,
    status: 'running',
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
    macJobId: null,
    announcementId: null,
    summary: null,
    error: null,
    /* Which occurrence this run belongs to, so a deferred Monday 5pm run that
     * finally executes on Tuesday morning is not filed as Tuesday's. */
    dueAt: new Date(routine.dueSince || routine.nextRunAt || now).toISOString(),
  }
}

/**
 * Compose an announcement server-side from the public web.
 *
 * Deliberately thin. The relay is not trying to be the Mac's planner; it is
 * trying to answer one question — "what should the owner hear about this?" —
 * using the two tools a Worker actually has.
 */
export async function composeOnRelay({
  routine,
  readPage = null,
  webSearch = null,
}) {
  const notes = []
  const sources = normalizeSources(routine.sources)

  for (const url of sources) {
    if (!readPage) break
    try {
      const page = await readPage(url, { action: 'markdown' })
      if (page?.ok && page.text) {
        notes.push(`From ${url}: ${String(page.text).slice(0, 1500)}`)
      } else if (page && !page.ok) {
        notes.push(`${url} could not be read (${page.reason || 'unknown'}).`)
      }
    } catch (error) {
      notes.push(`${url} could not be read (${error?.message || error}).`)
    }
  }

  if (!webSearch) {
    if (!notes.length) {
      throw new Error(
        'The relay has no way to run this routine: no page sources and no web search.',
      )
    }
    return { speech: notes.join(' ').slice(0, 1800), source: 'browser-run' }
  }

  /* Page text is context for the search, not the answer: the search model is
   * what turns a wall of markdown into something worth hearing out loud. */
  const query = notes.length
    ? `${routine.command}\n\nContext already gathered:\n${notes.join('\n').slice(0, 4000)}`
    : routine.command
  const result = await webSearch(query)
  if (!result?.ok) {
    if (notes.length) {
      return { speech: notes.join(' ').slice(0, 1800), source: 'browser-run' }
    }
    throw new Error(result?.error || 'Web search failed.')
  }
  return {
    speech: String(result.summary || '').slice(0, 1800),
    source: sources.length ? 'browser-run+search' : result.source || 'web-search',
  }
}

/**
 * Advance a routine past the occurrence that just ran (or was abandoned).
 * Interval schedules count from now; wall-clock schedules from the occurrence,
 * so a run that took four minutes does not push 7:00 to 7:04 forever.
 */
export function advanceRoutine(routine, { now = Date.now(), status, error = null }) {
  const anchor =
    routine.schedule?.kind === 'interval' ? now : routine.dueSince || now
  return {
    ...routine,
    nextRunAt: nextRunAt(routine.schedule, Math.max(anchor, now - 1)),
    lastRunAt: new Date(now).toISOString(),
    lastStatus: status,
    lastError: error,
    runCount: Number(routine.runCount || 0) + 1,
    deferredSince: null,
    dueSince: null,
    updatedAt: new Date(now).toISOString(),
  }
}

/**
 * The tick. Claims everything due, runs each one, writes a receipt.
 *
 * Every dependency is injected so this is testable without a Worker, a
 * network, or a Mac — and so the Free plan's 10 ms of cron CPU is spent on
 * awaits rather than on anything this module computes itself.
 */
export async function runDueRoutines({
  store,
  now = Date.now(),
  trigger = 'cron',
  /*
   * Asked, not told, and asked at most once per tick — only after something
   * has actually been claimed. "Is the Mac awake?" is a second D1 round trip,
   * and on the ~1,439 minutes a day when nothing is due, nobody needs to know.
   */
  isMacOnline = async () => false,
  limit = 8,
  readPage = null,
  webSearch = null,
  enqueueMacJob = null,
  logger = console,
}) {
  const claimed = await store.claimDueRoutines({
    now,
    limit,
    leaseMs: ROUTINE_LEASE_MS,
  })
  const runs = []
  let macOnline = null

  for (const routine of claimed) {
    if (macOnline === null) macOnline = Boolean(await isMacOnline())
    /* Remember which occurrence this is before anything can move it. */
    const withDue = routine.dueSince
      ? routine
      : { ...routine, dueSince: routine.nextRunAt || now }
    const venue = chooseVenue(withDue, { macOnline })
    const receipt = createRunReceipt({ routine: withDue, trigger, venue, now })

    try {
      if (venue === 'defer') {
        runs.push(await deferRoutine({ store, routine: withDue, receipt, now, logger }))
        continue
      }
      if (venue === 'mac') {
        runs.push(
          await dispatchToMac({ store, routine: withDue, receipt, now, enqueueMacJob }),
        )
        continue
      }
      runs.push(
        await runOnRelay({ store, routine: withDue, receipt, now, readPage, webSearch }),
      )
    } catch (error) {
      const message = String(error?.message || error)
      logger?.warn?.(`[routines] ${withDue.routineId} failed: ${message}`)
      const finished = {
        ...receipt,
        status: 'failed',
        error: message,
        finishedAt: new Date(Date.now()).toISOString(),
      }
      await store.recordRoutineRun(finished)
      await store.saveRoutine(
        advanceRoutine(withDue, { now, status: 'failed', error: message }),
      )
      runs.push(finished)
    }
  }

  return { runs, macOnline: macOnline === true, claimedCount: claimed.length }
}

async function deferRoutine({ store, routine, receipt, now, logger }) {
  const deferredSince = routine.deferredSince || new Date(now).toISOString()
  const deferredForMs = now - Date.parse(deferredSince)

  if (deferredForMs > DEFER_MAX_MS) {
    /*
     * Give up on this occurrence rather than let it queue. The receipt says
     * "missed", which is a true and useful thing for the dashboard to show —
     * far better than a briefing about last Tuesday arriving on Thursday.
     */
    const finished = {
      ...receipt,
      status: 'missed',
      error: `The Mac stayed offline for ${Math.round(deferredForMs / 3_600_000)}h; this occurrence was dropped.`,
      finishedAt: new Date(now).toISOString(),
    }
    await store.recordRoutineRun(finished)
    await store.saveRoutine(
      advanceRoutine(routine, { now, status: 'missed', error: finished.error }),
    )
    return finished
  }

  logger?.log?.(
    `[routines] ${routine.routineId} deferred: needs the Mac and it is asleep`,
  )
  await store.saveRoutine({
    ...routine,
    deferredSince,
    nextRunAt: now + DEFER_RETRY_MS,
    lastStatus: 'deferred',
    updatedAt: new Date(now).toISOString(),
  })
  /* No receipt row: a routine waiting for the lid to open has not run, and
   * one row a minute would bury the runs that did. */
  return { ...receipt, status: 'deferred', finishedAt: null }
}

async function dispatchToMac({ store, routine, receipt, now, enqueueMacJob }) {
  if (!enqueueMacJob) throw new Error('No Mac dispatch is configured.')
  const job = await enqueueMacJob({ routine, receipt })
  const finished = {
    ...receipt,
    status: 'dispatched',
    macJobId: job?.jobId || null,
    finishedAt: null,
  }
  await store.recordRoutineRun(finished)
  /*
   * The occurrence is spent even though the answer has not come back: the Mac
   * owns it now, and reapDispatchedRuns() turns its result into the
   * announcement. Advancing here is what stops the next tick, sixty seconds
   * later, from asking the Mac to do the same thing again.
   */
  await store.saveRoutine(advanceRoutine(routine, { now, status: 'dispatched' }))
  return finished
}

async function runOnRelay({ store, routine, receipt, now, readPage, webSearch }) {
  const composed = await composeOnRelay({ routine, readPage, webSearch })
  let announcementId = null

  if (routine.announce && composed.speech) {
    const announcement = createAnnouncement({
      deviceId: routine.deviceId,
      title: routine.name,
      speech: composed.speech,
      routineId: routine.routineId,
      runId: receipt.runId,
      now,
    })
    await store.createAnnouncement(announcement)
    announcementId = announcement.announcementId
  }

  const finished = {
    ...receipt,
    status: 'completed',
    summary: composed.speech.slice(0, 600),
    announcementId,
    finishedAt: new Date(now).toISOString(),
  }
  await store.recordRoutineRun(finished)
  await store.saveRoutine(advanceRoutine(routine, { now, status: 'completed' }))
  return finished
}

/**
 * Close the loop on runs the Mac took: turn a finished plan job into an
 * announcement, and stop waiting on jobs that never came back.
 *
 * This is the other half of dispatchToMac. Without it a Mac-run routine ends
 * as a job result nobody reads, which is the exact shape of the problem this
 * module exists to fix.
 */
export async function reapDispatchedRuns({
  store,
  now = Date.now(),
  limit = 10,
}) {
  const pending = await store.listRoutineRuns({ status: 'dispatched', limit })
  const closed = []

  for (const run of pending) {
    const startedMs = Date.parse(run.startedAt || '') || now
    if (!run.macJobId) continue
    const job = await store.getJob(run.macJobId).catch(() => null)
    const done =
      job && ['completed', 'plan_ready'].includes(String(job.status || ''))
    const failed = job && ['failed', 'cancelled'].includes(String(job.status || ''))

    if (!job || (!done && !failed)) {
      if (now - startedMs > MAC_RESULT_MAX_WAIT_MS) {
        const timedOut = {
          ...run,
          status: 'failed',
          error: 'The Mac claimed this routine but never returned a result.',
          finishedAt: new Date(now).toISOString(),
        }
        await store.recordRoutineRun(timedOut)
        closed.push(timedOut)
      }
      continue
    }

    if (failed) {
      const finished = {
        ...run,
        status: 'failed',
        error: String(job.error || 'The Mac could not run this routine.'),
        finishedAt: new Date(now).toISOString(),
      }
      await store.recordRoutineRun(finished)
      closed.push(finished)
      continue
    }

    const spoken = String(
      job.result?.response || job.result?.summary || '',
    ).trim()
    let announcementId = null
    if (spoken) {
      const routine = await store.getRoutine(run.routineId).catch(() => null)
      if (routine?.announce !== false) {
        const announcement = createAnnouncement({
          deviceId: routine?.deviceId || 'nrf9160-pendant',
          title: run.routineName || 'Routine',
          speech: spoken,
          routineId: run.routineId,
          runId: run.runId,
          now,
        })
        await store.createAnnouncement(announcement)
        announcementId = announcement.announcementId
      }
    }

    const finished = {
      ...run,
      status: 'completed',
      summary: spoken.slice(0, 600) || null,
      announcementId,
      finishedAt: new Date(now).toISOString(),
    }
    await store.recordRoutineRun(finished)
    closed.push(finished)
  }

  return closed
}
