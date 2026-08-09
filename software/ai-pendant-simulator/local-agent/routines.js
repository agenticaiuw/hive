import path from 'node:path'
import crypto from 'node:crypto'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { executeFinishStatus } from './jobTracker.js'
import { orchestratePlan, orchestrateExecute } from './orchestrator.js'

/*
 * Work the owner is not waiting for.
 *
 * Nothing in this stack could run later: no cron, no queue, no delayed job.
 * That single absence blocked most of what the agents proposed once they were
 * asked what would be useful — "every morning brief me", "summarize today's
 * notes at 5pm", "research this and tell me later" all need the same thing.
 *
 * It lives on the Mac agent rather than the Worker because this is where the
 * planner and the executor already are; a routine is just a plan-and-execute
 * that nobody is waiting on. The cost is that it only fires while the Mac is
 * awake, which is the honest trade for something that acts on the Mac anyway.
 */
const STORE_PATH = path.join(workspacePath, '.pendant-routines.json')
const TICK_MS = Number(process.env.PENDANT_ROUTINE_TICK_MS || 30_000)

const isValidStore = (value) => value && Array.isArray(value.routines)

function load() {
  ensureJsonStore(STORE_PATH, { routines: [] }, { validate: isValidStore })
  return readJsonWithRecovery(STORE_PATH, {
    fallback: { routines: [] },
    validate: isValidStore,
  })
}

function save(store) {
  writeJsonAtomic(STORE_PATH, store)
}

/*
 * Three shapes, because they answer different questions: "every morning at 7"
 * is a wall-clock promise the owner can rely on, "every 30 minutes" is a
 * polling loop, and "every weekday morning" is the first one with days it must
 * skip. Anything more expressive than this is a cron parser nobody asked for
 * yet.
 *
 * `weekly` exists because the alternative was worse. Eleven rounds asked for
 * "every weekday morning", and with only `daily` available the choice was to
 * store it as daily and fire on Saturday — a routine that breaks its promise
 * twice a week, silently, forever. cloud-relay/routineSchedule.js already had
 * { kind: 'weekly', days }, so this is the local store catching up to a shape
 * the relay could already express, not a new idea.
 *
 * Days are 0-6 from Date#getDay, Sunday first, matching the relay's spelling so
 * a routine means the same thing on either side.
 */
const DAY_MS = 86_400_000

export function nextRunAt(schedule, from = Date.now()) {
  if (schedule?.kind === 'interval') {
    const every = Math.max(60_000, Number(schedule.everyMs) || 0)
    return from + every
  }

  if (schedule?.kind === 'daily' || schedule?.kind === 'weekly') {
    const [hour, minute] = String(schedule.at || '08:00')
      .split(':')
      .map((n) => Number(n) || 0)
    const next = new Date(from)
    next.setSeconds(0, 0)
    next.setHours(hour, minute)
    /* Already gone today: the owner means tomorrow, not immediately. */
    if (next.getTime() <= from) next.setTime(next.getTime() + DAY_MS)

    if (schedule.kind === 'daily') return next.getTime()

    /* Coerce deliberately rather than with Number(), which maps null, false
     * and '' all to 0 — so a caller passing a null day would silently get a
     * routine that fires on Sunday. A day nobody named must be dropped, not
     * guessed. */
    const days = [
      ...new Set(
        (Array.isArray(schedule.days) ? schedule.days : [])
          .map((raw) => {
            if (typeof raw === 'number') return raw
            if (typeof raw === 'string' && raw.trim()) return Number(raw)
            return NaN
          })
          .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      ),
    ]
    /* A weekly schedule naming no valid day can never fire. Returning null says
     * so, where defaulting to daily would quietly hand back the Saturday bug
     * this shape exists to prevent. */
    if (!days.length) return null

    /* At most seven steps: one of the seven days is in the set. Stepping by a
     * whole day rather than adding a computed offset keeps this correct across
     * the DST boundary, where a day is 23 or 25 hours and the wall-clock time
     * is what the owner was promised. */
    for (let i = 0; i < 7; i += 1) {
      if (days.includes(next.getDay())) return next.getTime()
      next.setDate(next.getDate() + 1)
      next.setHours(hour, minute, 0, 0)
    }
    return null
  }

  return null
}

/** Monday to Friday, for the phrasing that asked for this. */
export const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5])

export function listRoutines() {
  return load().routines
}

export function createRoutine({ name, command, schedule, enabled = true }) {
  const text = String(command || '').trim()
  if (!text) throw new Error('A routine needs a command to run.')
  const due = nextRunAt(schedule)
  if (due === null) {
    throw new Error(
      'schedule must be {kind:"daily", at:"HH:MM"} or {kind:"interval", everyMs:N}.',
    )
  }

  const store = load()
  const routine = {
    id: `rtn_${crypto.randomUUID()}`,
    name: String(name || text).slice(0, 120),
    command: text,
    schedule,
    enabled: Boolean(enabled),
    createdAt: new Date().toISOString(),
    nextRunAt: due,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    runCount: 0,
  }
  store.routines.push(routine)
  save(store)
  return routine
}

export function deleteRoutine(id) {
  const store = load()
  const before = store.routines.length
  store.routines = store.routines.filter((r) => r.id !== id)
  if (store.routines.length === before) return false
  save(store)
  return true
}

export function updateRoutine(id, patch) {
  const store = load()
  const routine = store.routines.find((r) => r.id === id)
  if (!routine) return null
  if (typeof patch.enabled === 'boolean') routine.enabled = patch.enabled
  if (patch.command) routine.command = String(patch.command)
  if (patch.name) routine.name = String(patch.name)
  if (patch.schedule) {
    const due = nextRunAt(patch.schedule)
    if (due === null) throw new Error('Invalid schedule.')
    routine.schedule = patch.schedule
    routine.nextRunAt = due
  }
  save(store)
  return routine
}

/**
 * Plan and execute one routine. Same path a spoken command takes, so a routine
 * can do anything the owner could ask for directly.
 */
/*
 * A routine run's persisted status, from the outcome runRoutine built.
 *
 * A routine IS a plan-and-execute nobody is waiting on, so it must be judged
 * exactly the way the job store judges an /execute — jobTracker.executeFinishStatus,
 * reused here rather than re-derived so the two can never drift. The bug this
 * fixes: the old code stamped 'completed' whenever orchestrateExecute did not
 * THROW, but it returns { ok:false, status:'failed'|'blocked'|'incomplete' }
 * without throwing. A routine whose steps failed, or whose goal was never met
 * (goalVerdict.js), was recorded 'completed' and read as green on the dashboard.
 *
 *   - no executed step (an instant plan, or a plan with no actions) → 'completed':
 *     nothing ran, so the plan itself is the whole outcome
 *   - executed present → exactly executeFinishStatus of it: 'completed',
 *     'incomplete' (steps ran, goal not met), or 'failed' (steps failed/blocked)
 *
 * lastError carries the run's own sentence on any non-completed status:
 * executed.error is set only for 'incomplete', and executed.response carries
 * the summary for a plain failure, so `error ?? response` names what happened
 * either way.
 */
export function routineFinishStatus(outcome) {
  const executed = outcome?.executed
  if (!executed) return { status: 'completed', error: null }
  const status = executeFinishStatus(executed)
  if (status === 'completed') return { status, error: null }
  return { status, error: executed.error ?? executed.response ?? null }
}

export async function runRoutine(id, { force = false } = {}) {
  const store = load()
  const routine = store.routines.find((r) => r.id === id)
  if (!routine) throw new Error(`No routine ${id}`)
  if (!routine.enabled && !force) return { skipped: 'disabled' }

  const startedAt = Date.now()
  let outcome
  try {
    const plan = await orchestratePlan({
      command: routine.command,
      source: 'routine',
    })
    outcome =
      plan.status === 'instant' || !plan.actions?.length
        ? { ok: true, plan }
        : {
            ok: true,
            plan,
            executed: await orchestrateExecute({
              command: routine.command,
              actions: plan.actions,
              source: 'routine',
            }),
          }
    /* Not a hardcoded 'completed': an execute that returned ok:false without
     * throwing (failed, blocked, or goal-not-met) must record its real status. */
    const finish = routineFinishStatus(outcome)
    routine.lastStatus = finish.status
    routine.lastError = finish.error
  } catch (error) {
    outcome = { ok: false, error: String(error?.message || error) }
    routine.lastStatus = 'failed'
    routine.lastError = outcome.error
  }

  routine.lastRunAt = new Date(startedAt).toISOString()
  routine.runCount += 1
  routine.nextRunAt = nextRunAt(routine.schedule, Date.now())
  /* Re-read before writing: a create during a long run must not be lost. */
  const fresh = load()
  const index = fresh.routines.findIndex((r) => r.id === id)
  if (index >= 0) fresh.routines[index] = routine
  save(fresh)
  return outcome
}

let timer = null

/** Fire anything due. One at a time: routines share the Mac with the owner. */
export async function tickRoutines(now = Date.now()) {
  const due = load().routines.filter(
    (r) => r.enabled && r.nextRunAt && r.nextRunAt <= now,
  )
  const results = []
  for (const routine of due) {
    try {
      results.push({ id: routine.id, ...(await runRoutine(routine.id)) })
    } catch (error) {
      results.push({ id: routine.id, ok: false, error: String(error?.message || error) })
    }
  }
  return results
}

export function startRoutineScheduler() {
  if (timer) return
  timer = setInterval(() => {
    tickRoutines().catch(() => {
      /* A failing routine is recorded on the routine itself; the loop lives. */
    })
  }, TICK_MS)
  /* Never hold the process open on account of the scheduler. */
  timer.unref?.()
}

export function stopRoutineScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}
