import path from 'node:path'
import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import {
  deliveryRunStatus,
  gradeAudioDelivery,
} from '../shared/audioDelivery.js'

const pipelinePath = path.join(workspacePath, 'pendant-pipeline.json')
const MAX_RUNS = 80
const MAX_EVENTS_PER_RUN = 80
const listeners = new Set()
const ARRAY_STORE = { validate: Array.isArray }

/*
 * A run status of its own, rather than a flag hung off 'processing'.
 *
 * Every reader of `status` — the dashboard's headline chip, the jobs list, the
 * relay's own view — asks "how is this run doing" and gets one word back. While
 * "needs approval" was not one of those words, the honest answer had nowhere to
 * go, and the run rendered as whatever the delivery grade happened to imply.
 */
export const NEEDS_APPROVAL_STATUS = 'needs_approval'

export function pipelineLocation() {
  ensureStore()
  return pipelinePath
}

/**
 * The approval this run is still waiting on, or null.
 *
 * bridge.js writes exactly one shape for a held plan: an `agent` event with
 * status `waiting`, carrying the blocked actions in `meta.blocked` and the
 * reason in `detail`. Any LATER agent event means the agent moved again —
 * the plan was approved and executed, or it failed — so the hold is answered
 * and this returns null. Approving from the dashboard opens a fresh relay job
 * and therefore a fresh pipeline id, so a parked run usually keeps this
 * record: it is the history of a run that did need a person, which is true.
 */
export function pendingApproval(events) {
  const list = Array.isArray(events) ? events : []
  let waiting = null

  for (const event of list) {
    if (event?.stage !== 'agent') continue
    if (event.status === 'waiting') {
      waiting = event
      continue
    }
    waiting = null
  }

  if (!waiting) return null

  const blocked = Array.isArray(waiting.meta?.blocked) ? waiting.meta.blocked : []
  return {
    since: waiting.at ?? null,
    /* The effect-worded sentences from actionRisk.js, joined by bridge.js. */
    reason: waiting.detail || waiting.text || 'This plan needs your approval.',
    blocked,
    actionCount: blocked.length,
    routine: waiting.meta?.routineJob === true,
  }
}

export function readPipelineRuns() {
  ensureStore()
  return readJsonWithRecovery(pipelinePath, {
    fallback: [],
    ...ARRAY_STORE,
  })
}

export function onPipelineChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function recordPipelineEvent({
  pipelineId,
  stage,
  status = 'done',
  label = '',
  detail = '',
  text = '',
  source = 'mac',
  kind = 'voice_command',
  command = '',
  sessionId = null,
  meta = null,
  at = null,
}) {
  const id = String(pipelineId || '').trim()
  const eventStage = String(stage || '').trim()

  if (!id) {
    throw new Error('pipelineId is required.')
  }
  if (!eventStage) {
    throw new Error('pipeline stage is required.')
  }

  const timestamp = normalizeTimestamp(at)
  const runs = readPipelineRuns()
  let run = runs.find((item) => item.pipelineId === id)

  if (!run) {
    run = {
      pipelineId: id,
      kind: String(kind || 'voice_command'),
      command: cleanText(command, 4000),
      sessionId: sessionId ? cleanText(sessionId, 240) : null,
      source: cleanText(source, 80) || 'mac',
      status: 'processing',
      events: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    runs.unshift(run)
  }

  if (command && !run.command) {
    run.command = cleanText(command, 4000)
  }
  if (sessionId && !run.sessionId) {
    run.sessionId = cleanText(sessionId, 240)
  }

  const event = {
    eventId: `pipe_evt_${crypto.randomUUID()}`,
    stage: eventStage,
    status: normalizeEventStatus(status),
    label: cleanText(label || eventStage, 240),
    detail: cleanText(detail, 4000),
    text: cleanText(text, 12000),
    source: cleanText(source, 80) || 'mac',
    meta: sanitizeMeta(meta),
    at: timestamp,
  }

  run.events = [...(Array.isArray(run.events) ? run.events : []), event].slice(
    -MAX_EVENTS_PER_RUN,
  )
  run.updatedAt = timestamp
  run.status = deriveRunStatus(run.events)
  /*
   * The same reasoning as `delivery` below, for the other end of the run: a
   * held plan is a QUESTION ADDRESSED TO THE OWNER, and it has to be legible as
   * one wherever the owner is actually looking. Stored as structure rather than
   * left buried in one event's meta so a reader gets the blocked actions and
   * the reason without walking the event list.
   */
  run.approval = pendingApproval(run.events)
  /*
   * Stored beside the status rather than folded into it, because they answer
   * different questions: `status` is how the run went, `delivery` is who
   * witnessed what on the way to the pendant's speaker. Collapsing the second
   * into the first is how "the Mac finished" started reading as "the owner
   * heard it".
   */
  run.delivery = gradeAudioDelivery(run.events)

  const nextRuns = [
    run,
    ...runs.filter((item) => item.pipelineId !== id),
  ].slice(0, MAX_RUNS)
  writeRuns(nextRuns)
  return run
}

export function clearPipelineRuns() {
  writeRuns([])
  return []
}

function normalizeTimestamp(value) {
  const parsed = value ? new Date(value) : new Date()
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString()
}

function normalizeEventStatus(value) {
  const status = String(value || '').toLowerCase()
  if (status === 'active' || status === 'processing') return 'active'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'waiting' || status === 'queued') return 'waiting'
  return 'done'
}

/*
 * This used to end with "the relay took the audio, so we're done" for any run
 * whose input telemetry did not literally say microSD. `device_playback` was
 * read here and never written by anything, so the check for it could only ever
 * fail, and every live-LTE pendant run quietly finished on Mac-side evidence.
 *
 * Now the last mile is graded against the body that witnessed it. When the
 * pendant has the bytes and has said nothing, that is reported as
 * PLAYBACK_UNKNOWN_STATUS — not 'completed' (which would round an unknown up to
 * a success) and not an endless 'processing' (which would round it up to "still
 * working" on a run that will never resolve on its own).
 */
function deriveRunStatus(events) {
  const latest = events[events.length - 1]
  if (!latest) return 'processing'
  if (latest.status === 'failed') return 'failed'

  const delivery = gradeAudioDelivery(events)
  if (delivery.playbackFailed) return 'failed'

  /*
   * A plan held for the owner is not "still working" and it is not "done".
   *
   * This is the second half of the 2026-08-09 incident. bridge.js parked a
   * plan, recorded `stage: agent, status: waiting`, and then went on to render
   * and upload speech as usual — so the LAST event was a perfectly ordinary
   * `relay_result / done`, the delivery grade sat at `held_by_relay`, and this
   * function returned 'processing'. The dashboard drew "Running" over a run
   * that had stopped and would never move again, while the only announcement
   * of the hold was spoken to a pendant with no speaker attached. Nobody was
   * told anything.
   *
   * Checked ahead of every delivery rung, including provesPlayback, because
   * whether the pendant played "waiting for your approval" does not change the
   * fact that the plan is still waiting. The question outranks its own audio.
   */
  if (pendingApproval(events)) return NEEDS_APPROVAL_STATUS

  if (delivery.provesPlayback) return 'completed'

  /* Nothing is settled until the Mac has handed the reply to the relay. */
  const macDone = events.some(
    (event) => event.stage === 'relay_result' && event.status === 'done',
  )
  if (!macDone) return 'processing'

  return deliveryRunStatus(delivery, { macDone: true })
}

function cleanText(value, maxLength) {
  return String(value ?? '').split('\u0000').join('').slice(0, maxLength)
}

function sanitizeMeta(value, depth = 0) {
  if (value == null || depth > 4) return null
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return cleanText(value, 1000)
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeMeta(item, depth + 1))
  }
  if (typeof value !== 'object') return cleanText(value, 1000)

  const result = {}
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (/base64|authorization|api.?key|token|secret|password/i.test(key)) {
      continue
    }
    result[cleanText(key, 120)] = sanitizeMeta(item, depth + 1)
  }
  return result
}

function ensureStore() {
  ensureJsonStore(pipelinePath, [], ARRAY_STORE)
}

function writeRuns(runs) {
  writeJsonAtomic(pipelinePath, runs, ARRAY_STORE)
  for (const listener of listeners) {
    try {
      listener(runs)
    } catch {
      // A disconnected dashboard must never break the pipeline.
    }
  }
}
