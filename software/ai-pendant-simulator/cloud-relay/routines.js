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

/*
 * RETRIES.
 *
 * Before this, a failed occurrence was terminal: the catch in runDueRoutines()
 * filed a "failed" receipt and called advanceRoutine(), which rearms for the
 * NEXT occurrence. For a daily briefing that costs one morning. For
 * {kind:'once'} — the shape of "queue this up and tell me when it's done" and
 * "remind me in an hour" — nextRunAt() returns null, so the task was gone. A
 * rate-limited web search, a five-second D1 blip, and the thing the owner
 * asked for silently never happened and nobody was told.
 *
 * Three attempts, doubling from a minute. The floor is a minute because the
 * relay's clock IS a one-minute cron: a shorter delay cannot be honoured and
 * would only make the retry land on the same tick. The ceiling matters less
 * than the total window, which planRetry() bounds against the next scheduled
 * occurrence — a routine must never accumulate retries into its own next run.
 */
export const RETRY_MAX_ATTEMPTS = 3
export const RETRY_BASE_MS = 60_000
export const RETRY_MAX_MS = 15 * 60 * 1000

/*
 * Deliberately no jitter. Jitter exists to spread a thundering herd across
 * many retrying clients; there is exactly one scheduler here, claiming under a
 * lease, and the only thing jitter would buy is receipts nobody can predict
 * and tests that assert on ranges.
 */
export function retryDelayMs(attempt = 1) {
  const step = Math.max(1, Math.floor(attempt))
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (step - 1))
}

/**
 * The idempotency key: one occurrence of one routine, whatever it takes.
 *
 * Every attempt at the same occurrence carries the same key, because
 * createRunReceipt() derives dueAt from `dueSince`, which retries preserve.
 * That is what lets a retry ask "did some earlier attempt already finish
 * this?" and get a true answer.
 */
export function occurrenceKey(routineId, dueAt) {
  return `${routineId}#${dueAt}`
}

/**
 * Retry, or stop and tell the owner?
 *
 * Pure so the tick pays nothing to decide, and so every stopping reason is
 * assertable. Order matters: the cheapest checks first, the schedule lookup
 * (which reparses the schedule) last.
 */
export function planRetry(routine, { now = Date.now(), attempt = 1 } = {}) {
  if (attempt >= RETRY_MAX_ATTEMPTS) {
    return { retry: false, at: null, reason: `it failed ${attempt} times` }
  }
  const at = now + retryDelayMs(attempt)

  /* Same twelve hours as DEFER_MAX_MS, for the same reason: an answer about
   * this morning is worthless tomorrow, and a backlog of stale retries would
   * all come due at once. */
  const dueSince = Number(routine?.dueSince) || now
  if (at - dueSince > DEFER_MAX_MS) {
    return { retry: false, at: null, reason: 'the occurrence is too old to retry' }
  }

  /*
   * Never retry past the next occurrence. An {interval, everyMs:60000} routine
   * retrying after a minute would be racing its own schedule — two claims for
   * what the owner thinks of as one job. When the schedule itself is the
   * sooner retry, let the schedule do it. A spent one-shot has no next
   * occurrence (null), which is exactly the case that needs the retry most.
   */
  const following = nextRunAt(routine?.schedule, now)
  if (following !== null && at >= following) {
    return {
      retry: false,
      at: null,
      reason: 'the next scheduled run arrives sooner than a retry would',
    }
  }
  return { retry: true, at, reason: null }
}

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

  const normalized = normalizeSchedule(schedule, now)
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
    /* Attempts already spent on the occurrence named by dueSince. Reset by
     * advanceRoutine(), so it can never leak into the next occurrence. */
    attempt: 0,
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
    const normalized = normalizeSchedule(patch.schedule, now)
    if (!normalized.ok) throw new Error(normalized.error)
    const due = nextRunAt(normalized.schedule, now)
    if (due === null) throw new Error('That schedule has no next occurrence.')
    next.schedule = normalized.schedule
    next.scheduleText = describeSchedule(normalized.schedule)
    next.nextRunAt = due
    next.deferredSince = null
    next.dueSince = null
    /* Rescheduling abandons whatever occurrence was mid-retry: the owner just
     * said when they want this, and that answer outranks a pending retry. */
    next.attempt = 0
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
  /* Which occurrence this run belongs to, so a deferred Monday 5pm run that
   * finally executes on Tuesday morning is not filed as Tuesday's. */
  const dueAt = new Date(
    routine.dueSince || routine.nextRunAt || now,
  ).toISOString()
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
    dueAt,
    /* 1-based: this receipt IS an attempt, and "attempt 0" reads as a run that
     * did not happen. The routine's own counter is 0-based (attempts spent). */
    attempt: Number(routine.attempt || 0) + 1,
    occurrenceKey: occurrenceKey(routine.routineId, dueAt),
    /* Whether the owner should read this as the end of the story. A failed
     * attempt with a retry queued is not; the receipt log keeps every attempt
     * so "it worked on the third try" is visible rather than inferred. */
    final: true,
    nextAttemptAt: null,
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
 *
 * Always measured from `now`, never from the occurrence that just fired.
 * Anchoring on the occurrence looks like it protects a 07:00 promise from
 * drifting to 07:04 after a slow run — but daily and weekly occurrences sit
 * on a fixed wall-clock grid, so "the first one after now" IS 07:00 tomorrow
 * either way. What anchoring on the occurrence actually does is hand back a
 * nextRunAt equal to the instant just processed whenever a routine fires
 * exactly on its second, and the next tick then runs it a second time.
 */
export function advanceRoutine(routine, { now = Date.now(), status, error = null }) {
  return {
    ...routine,
    nextRunAt: nextRunAt(routine.schedule, now),
    lastRunAt: new Date(now).toISOString(),
    lastStatus: status,
    lastError: error,
    runCount: Number(routine.runCount || 0) + 1,
    deferredSince: null,
    dueSince: null,
    /* The occurrence is over however it ended, so its retry budget resets.
     * Carrying it forward would let one bad morning spend tomorrow's. */
    attempt: 0,
    updatedAt: new Date(now).toISOString(),
  }
}

/**
 * Keep the occurrence alive for another attempt.
 *
 * The opposite of advanceRoutine: `dueSince` is preserved so the next attempt
 * files against the same occurrence (and therefore the same occurrenceKey),
 * and `nextRunAt` is the retry instant rather than the schedule's next slot.
 * runCount is NOT incremented — the owner declared one run, not three.
 */
export function retryRoutineRecord(routine, { now = Date.now(), attempt, at, error = null }) {
  return {
    ...routine,
    nextRunAt: at,
    dueSince: routine.dueSince || routine.nextRunAt || now,
    attempt,
    lastStatus: 'retrying',
    lastError: error,
    deferredSince: null,
    updatedAt: new Date(now).toISOString(),
  }
}

/**
 * Say out loud what happened — including, especially, when it did not work.
 *
 * runOnRelay() announced successes from the start; every failure path filed a
 * receipt and stopped. So "tell me exactly what happened when it's done" held
 * only when nothing went wrong, which is the half the owner can already guess.
 * A failure the owner is never told about is indistinguishable from a routine
 * that was never scheduled.
 *
 * Never throws: an announcement is the last thing that happens to a run, and
 * losing the receipt because the speech was empty would be a worse trade.
 */
async function announceOutcome({ store, routine, run, now, logger }) {
  if (!routine || routine.announce === false) return null
  const label = run.routineName || routine.name || 'A scheduled task'
  const reason = String(run.error || '').trim()
  const speech =
    run.status === 'missed'
      ? `${label} did not run. ${reason}`
      : `${label} did not finish. ${reason || 'No reason was recorded.'}`
  try {
    const announcement = createAnnouncement({
      deviceId: routine.deviceId,
      title: label,
      speech,
      routineId: run.routineId,
      runId: run.runId,
      now,
    })
    await store.createAnnouncement(announcement)
    return announcement.announcementId
  } catch (error) {
    logger?.warn?.(
      `[routines] could not announce ${run.runId}: ${error?.message || error}`,
    )
    return null
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

    /*
     * THE RETRY/COMPLETION RACE.
     *
     * A Mac dispatch is fire-and-forget: dispatchToMac() hands the bridge a
     * job and reapDispatchedRuns() closes it out later. When the reaper gives
     * up on a slow job (MAC_RESULT_MAX_WAIT_MS) it rearms the occurrence — and
     * a job the reaper stopped waiting for is not a job the Mac stopped
     * running. Without this check the retry enqueues the same command while
     * the first one is still in flight, and "send the email" sends it twice.
     *
     * Only on retries: a first attempt cannot be a duplicate, because the
     * store's lease IS the claim and only one tick can hold it. That keeps
     * this extra indexed read off the 1,439 minutes a day when nothing is due
     * — the cron's 10 ms of CPU has no room for a query per claimed routine.
     */
    if (Number(withDue.attempt || 0) > 0) {
      const settled = await findSettledOccurrence(store, receipt)
      if (settled) {
        runs.push(
          await supersedeRun({ store, routine: withDue, receipt, settled, now, logger }),
        )
        continue
      }
    }

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
      runs.push(
        await failRun({ store, routine: withDue, receipt, now, error: message, logger }),
      )
    }
  }

  return { runs, macOnline: macOnline === true, claimedCount: claimed.length }
}

/**
 * One failed attempt: file it, then either queue another go or stop and say so.
 */
async function failRun({ store, routine, receipt, now, error, logger }) {
  const attempt = Number(receipt.attempt || 1)
  const plan = planRetry(routine, { now, attempt })
  const finished = {
    ...receipt,
    status: 'failed',
    error,
    final: !plan.retry,
    nextAttemptAt: plan.retry ? new Date(plan.at).toISOString() : null,
    /* Why the retries stopped, on the row that stopped them. Otherwise "it
     * gave up" and "it was never retried" look identical in the log. */
    stoppedBecause: plan.retry ? null : plan.reason,
    finishedAt: new Date(now).toISOString(),
  }

  if (plan.retry) {
    await store.recordRoutineRun(finished)
    await store.saveRoutine(
      retryRoutineRecord(routine, { now, attempt, at: plan.at, error }),
    )
    logger?.log?.(
      `[routines] ${routine.routineId} attempt ${attempt} failed; retrying in ` +
        `${Math.round((plan.at - now) / 1000)}s`,
    )
    return finished
  }

  finished.announcementId = await announceOutcome({
    store,
    routine,
    run: finished,
    now,
    logger,
  })
  await store.recordRoutineRun(finished)
  await store.saveRoutine(advanceRoutine(routine, { now, status: 'failed', error }))
  return finished
}

/**
 * A retry that arrived after an earlier attempt already settled the occurrence.
 *
 * Recorded rather than silently dropped: "the retry fired and was refused"
 * is the only evidence that the guard did its job, and a duplicate run that
 * DID happen would otherwise look identical in the log to one that did not.
 */
async function supersedeRun({ store, routine, receipt, settled, now, logger }) {
  const done = settled.status === 'completed'
  const finished = {
    ...receipt,
    status: 'superseded',
    error:
      `Attempt ${receipt.attempt} was dropped: this occurrence ` +
      (done
        ? `already completed as ${settled.runId}.`
        : `is still running on the Mac as ${settled.runId}.`),
    finishedAt: new Date(now).toISOString(),
  }
  await store.recordRoutineRun(finished)
  /* Advance either way. If it completed, the occurrence is over; if it is
   * still dispatched, the reaper owns it and will announce the result — what
   * must not happen is this routine staying armed for the same occurrence. */
  await store.saveRoutine(
    advanceRoutine(routine, { now, status: done ? 'completed' : 'dispatched' }),
  )
  logger?.log?.(`[routines] ${routine.routineId} retry suppressed: ${finished.error}`)
  return finished
}

async function findSettledOccurrence(store, receipt) {
  /* Bounded at eight: a single occurrence can produce at most
   * RETRY_MAX_ATTEMPTS receipts, and the index is (routine_id, started_at
   * DESC), so the rows that could match are the newest ones. */
  const recent = await store
    .listRoutineRuns({ routineId: receipt.routineId, limit: 8 })
    .catch(() => [])
  return (
    recent.find(
      (run) =>
        run.runId !== receipt.runId &&
        run.occurrenceKey === receipt.occurrenceKey &&
        ['completed', 'dispatched'].includes(String(run.status || '')),
    ) ?? null
  )
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
    /* Told, not just logged. A briefing that quietly never happened because
     * the lid stayed shut is the failure the owner is least able to notice on
     * their own — there is no error anywhere they would think to look. */
    finished.announcementId = await announceOutcome({
      store,
      routine,
      run: finished,
      now,
      logger,
    })
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
        closed.push(
          await closeFailedDispatch({
            store,
            run,
            now,
            error: 'The Mac claimed this routine but never returned a result.',
          }),
        )
      }
      continue
    }

    if (failed) {
      closed.push(
        await closeFailedDispatch({
          store,
          run,
          now,
          error: String(job.error || 'The Mac could not run this routine.'),
        }),
      )
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
      final: true,
      finishedAt: new Date(now).toISOString(),
    }
    await store.recordRoutineRun(finished)
    closed.push(finished)
  }

  return closed
}

/**
 * A Mac dispatch that came back broken, or never came back at all.
 *
 * dispatchToMac() advanced the routine the moment it handed the job over, so
 * the schedule has already moved on and a retry has to put the occurrence
 * back. That is safe precisely because advanceRoutine() recomputes from the
 * wall-clock grid rather than from the retry: a 07:00 daily rearmed for
 * 07:01, retried, and finished at 07:03 still lands on 07:00 tomorrow.
 */
async function closeFailedDispatch({ store, run, now, error }) {
  const routine = await store.getRoutine(run.routineId).catch(() => null)
  const attempt = Number(run.attempt || 1)
  const dueSince = Date.parse(run.dueAt || '') || now
  const plan =
    routine && routine.enabled !== false
      ? planRetry({ ...routine, dueSince }, { now, attempt })
      : {
          retry: false,
          at: null,
          /* A routine the owner deleted or switched off mid-flight: report the
           * failure, do not resurrect the schedule to chase it. */
          reason: routine ? 'the routine is disabled' : 'the routine is gone',
        }

  const finished = {
    ...run,
    status: 'failed',
    error,
    final: !plan.retry,
    nextAttemptAt: plan.retry ? new Date(plan.at).toISOString() : null,
    stoppedBecause: plan.retry ? null : plan.reason,
    finishedAt: new Date(now).toISOString(),
  }

  if (plan.retry) {
    await store.saveRoutine(
      retryRoutineRecord(
        { ...routine, dueSince },
        { now, attempt, at: plan.at, error },
      ),
    )
  } else {
    finished.announcementId = await announceOutcome({ store, routine, run: finished, now })
  }
  await store.recordRoutineRun(finished)
  return finished
}
