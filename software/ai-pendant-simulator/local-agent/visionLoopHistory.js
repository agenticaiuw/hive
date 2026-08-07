import { getLedger, ledgerLocation, listLedgers, presentLedger } from './actionLedger.js'
import { getJob } from './jobTracker.js'
import { describeUndoability } from './undo.js'
import { VISION_LOOP_SOURCE } from './visionLoop.js'
import { describeStep } from './visionLoopPolicy.js'

/*
 * "A history of recent actions taken by mac-vision in automation loops, with
 * human-readable explanations and an option to undo."
 *
 * All three of those already exist somewhere in this project, and the correct
 * amount of new storage for this feature is none:
 *
 *   the actions   actionLedger.js writes a manifest before a run and settles
 *                 each step as it lands, with risk tier, effect, reversibility
 *                 and what it touched. That is the history.
 *   the undo      undo.js decides what can be taken back and does it;
 *                 POST /jobs/:jobId/undo in server.js is the route that runs it
 *                 AND marks the job undone. Both halves matter.
 *   the words     planPreview.foreseeAction produced the step labels the ledger
 *                 stored, and visionLoopPolicy.describeStep produced the
 *                 sentence shown before the run.
 *
 * So this module adds exactly one thing: the EXPLANATION. A ledger step says
 * `{ type: 'ui_click', riskTier: 'uncontained', reversible: false }`, which is
 * true, complete, and not what a person asked for. This turns that row into
 * "Pressed “Send” in Mail. Nothing in this run can be taken back automatically —
 * pressing a button in an app leaves no snapshot to restore."
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO:
 *
 * It does not write. Every function here reads the ledger and the job store and
 * returns text; a history that mutates the thing it describes is a history you
 * cannot trust twice.
 *
 * It does not undo. It reports the undo POSITION — available or not, why, and
 * the route that performs it — and stops there. Calling undoJobResults() from
 * here would skip markJobUndone(), and a job that was undone but not marked can
 * be undone again; the second pass would "restore" a snapshot over content the
 * owner has since edited. The one true undo path is the existing route, so this
 * points at it rather than growing a second one beside it.
 */

/* How far back to look for this loop's runs before giving up. The ledger store
 * is capped at 1 MB and a manifest at 64 KB, so this cannot be reached in
 * practice — it is here so a future, larger store cannot turn one history read
 * into an unbounded scan. */
const MAX_SCAN = 200

/* Explanations are written for the tier the step is in, not for its type, so a
 * step type added later gets a sentence rather than a blank. */
const RISK_SENTENCES = Object.freeze({
  observe: 'It only looked; nothing in the app changed.',
  setting: 'It changed a system setting, which can be put straight back.',
  'reversible-write': 'It wrote something that can be restored from the snapshot taken first.',
  'irreversible-write': 'It wrote something that cannot be restored automatically.',
  'off-machine': 'It reached something outside this Mac, so it cannot be recalled from here.',
  uncontained:
    'It acted inside another app’s interface, and what happens next is that app’s business — there is no snapshot of an app’s internal state to restore.',
})

/**
 * One ledger step as a sentence a person can act on.
 *
 * The verb tense is the honest one for the phase: a step that never ran is
 * described as something that WOULD have happened, and an in-flight step is
 * described as unknown rather than as done. Reading a manifest row as history
 * is the mistake actionLedger's whole resume path exists to prevent, and the
 * narration must not undo that by writing everything in the past tense.
 */
export function explainStep(step, { app = null } = {}) {
  const type = String(step?.type ?? '')
  const intent = describeStep({ type, params: paramsFor(step) }, { app })
  const phase = step?.phase ?? 'pending'

  if (phase === 'pending') {
    return {
      seq: step?.seq ?? null,
      type,
      phase,
      outcome: 'not started',
      text: `Would have: ${lowerFirst(intent)} It never started.`,
      undoable: false,
    }
  }

  if (phase === 'inflight') {
    return {
      seq: step?.seq ?? null,
      type,
      phase,
      outcome: 'unknown',
      /* The single most important row in any history this project produces. */
      text: `Started but never reported back: ${lowerFirst(intent)} Whether it happened is genuinely unknown — the run was interrupted between dispatch and the answer.`,
      undoable: false,
    }
  }

  const failed = step?.ok === false
  const risk = RISK_SENTENCES[step?.riskTier] ?? null

  return {
    seq: step?.seq ?? null,
    type,
    phase,
    outcome: failed ? 'failed' : 'succeeded',
    text: failed
      ? `Tried to: ${lowerFirst(intent)} It failed${step?.message ? ` — ${step.message}` : ''}.`
      : `${intent}${risk ? ` ${risk}` : ''}`,
    /* Reversibility is the ledger's answer, taken from planPreview at manifest
     * time. Recomputing it here would be a second opinion that can disagree
     * with the one the owner was shown before the run. */
    undoable: step?.reversible === true,
    reversedBy: step?.reversedBy ?? null,
    irreversibleReason: step?.irreversibleReason ?? null,
    receiptId: step?.receiptId ?? null,
  }
}

/* presentLedger drops raw params by design (see its comment), so a presented
 * step carries `touches` and a `label` instead. Both narrations feed the same
 * describeStep, so this reconstitutes just enough for it. */
function paramsFor(step) {
  if (step?.params && typeof step.params === 'object') return step.params
  const touches = Array.isArray(step?.touches) ? step.touches : []
  const app = touches.find((touch) => touch?.kind === 'app')?.ref ?? null
  const other = touches.find((touch) => touch?.kind !== 'app')?.ref ?? null
  return { ...(app ? { app } : {}), ...(other ? { title: other } : {}) }
}

/**
 * The undo position for a run, and the one route that performs it.
 *
 * `describeUndoability` is undo.js's own verdict over the job's results — the
 * same function /jobs and /ops/snapshot already call — so this cannot say a run
 * is undoable when the undo route would refuse it.
 */
export function undoPosition(job, { ledger = null } = {}) {
  if (!job) {
    return {
      available: false,
      reason: ledger?.jobId
        ? `Job ${ledger.jobId} is no longer in the job store, so there is nothing left to reverse from. The job store is bounded and drops the oldest runs.`
        : 'This run was not recorded against a job, so there is no result set for undo to reverse.',
      via: null,
      undoneAt: null,
    }
  }

  const verdict = describeUndoability(job)

  return {
    available: Boolean(verdict.canUndo),
    reason: verdict.reason,
    /* Named, not called. This module never performs the undo — see the header. */
    via: verdict.canUndo ? `POST /jobs/${job.jobId}/undo` : null,
    steps: verdict.steps ?? [],
    irreversible: verdict.irreversible ?? [],
    undoneAt: job.undoneAt ?? null,
    /*
     * The sentence that is true of essentially every accessibility-mode run and
     * that a bare `canUndo: false` fails to convey. Pressing a button is not a
     * file write; there is no vault entry and there never was going to be. An
     * owner told only "cannot undo" reasonably assumes something broke.
     */
    plainly: verdict.canUndo
      ? `${verdict.count} step${verdict.count === 1 ? '' : 's'} can be reversed automatically.`
      : 'Nothing here can be taken back automatically. Pressing a control in another app leaves no snapshot — the app’s own Undo is the thing that can reverse it, not this agent.',
  }
}

/**
 * One run, narrated.
 *
 * `job` is injected rather than looked up so a caller that already has it does
 * not fetch it twice, and so tests never touch the real job store.
 */
export function narrateRun(manifest, { job = null } = {}) {
  const presented = presentLedger(manifest)
  if (!presented) return null

  const app = appOf(manifest)
  const lines = (presented.steps ?? []).map((step) => explainStep(step, { app }))
  const progress = presented.progress ?? {}
  const inflight = lines.filter((line) => line.phase === 'inflight')

  return {
    ledgerId: presented.ledgerId,
    jobId: presented.jobId,
    app,
    command: presented.command,
    title: presented.title,
    status: presented.status,
    startedAt: presented.createdAt,
    finishedAt: presented.closedAt,
    risk: presented.risk,
    steps: lines,
    /* A run whose ledger never closed is reported as unfinished rather than as
     * complete-with-fewer-steps. actionLedger.interruptedLedgers is the
     * authority on that; this only phrases it. */
    interrupted: presented.status === 'open' || inflight.length > 0,
    headline: headlineFor({ presented, progress, app, inflight }),
    undo: undoPosition(job, { ledger: presented }),
    /* Where to get the machine-readable version, so a reader who wants the risk
     * tiers and the receipts is not stuck parsing prose. */
    detail: `GET /ledger/${presented.ledgerId}`,
    resume: presented.status === 'open' ? `GET /ledger/${presented.ledgerId}/resume` : null,
  }
}

function headlineFor({ presented, progress, app, inflight }) {
  const where = app ? ` in ${app}` : ''
  if (inflight.length) {
    return `Interrupted${where}: ${progress.done ?? 0} of ${progress.steps ?? 0} steps finished and ${inflight.length} was dispatched without an answer. ${presented.ledgerId} — ask before continuing.`
  }
  if (presented.status === 'open') {
    return `Still running or abandoned${where}: ${progress.done ?? 0} of ${progress.steps ?? 0} steps finished and the run never closed.`
  }
  if (progress.failed) {
    return `${progress.done ?? 0} of ${progress.steps ?? 0} steps ran${where}, ${progress.failed} of them failed.`
  }
  return `${progress.done ?? 0} step${progress.done === 1 ? '' : 's'} completed${where}.`
}

function appOf(manifest) {
  for (const step of Array.isArray(manifest?.steps) ? manifest.steps : []) {
    const named = step?.params?.app
    if (typeof named === 'string' && named) return named
    const touched = (Array.isArray(step?.touches) ? step.touches : []).find(
      (touch) => touch?.kind === 'app',
    )
    if (touched?.ref) return touched.ref
  }
  return null
}

/**
 * Recent accessibility-mode runs, newest first.
 *
 * Filtered on the ledger's own `source` field rather than on a private index.
 * `all: true` widens it to every run in the ledger, because "what has this
 * agent been doing to my screen" is a fair question that does not stop at one
 * module's boundary.
 */
export function recentActions({
  filePath = ledgerLocation(),
  limit = 10,
  all = false,
  jobLookup = getJob,
} = {}) {
  const listed = listLedgers({ filePath, limit: MAX_SCAN })

  /* One read per candidate, not two. `source` is not carried by
   * summarizeLedger, so the manifest has to be fetched to filter on it — and
   * the same manifest is then narrated rather than fetched again. The store is
   * a single bounded JSON file, but "bounded" is not "free". */
  const matched = []
  for (const entry of listed.ledgers) {
    const manifest = getLedger(entry?.ledgerId, { filePath })
    if (!manifest) continue
    if (!all && manifest.source !== VISION_LOOP_SOURCE) continue
    matched.push(manifest)
  }

  const runs = matched.slice(0, Math.max(1, Number(limit) || 10)).map((manifest) => {
    const job = manifest.jobId ? safeLookup(jobLookup, manifest.jobId) : null
    return narrateRun(manifest, { job })
  })

  return {
    ok: true,
    readOnly: true,
    mode: all ? 'all-runs' : 'accessibility',
    total: matched.length,
    runs: runs.filter(Boolean),
    /* Said out loud, the way listLedgers says it: a bounded store drops things,
     * and a reader who does not know that reads an absence as "it never did
     * that". */
    dropped: listed.dropped,
    undoNote:
      'Undo is performed by POST /jobs/:jobId/undo, which both reverses the reversible steps and marks the job undone. This history reports the position and never performs it.',
  }
}

function safeLookup(lookup, jobId) {
  try {
    return lookup(jobId) ?? null
  } catch {
    /* A missing or unreadable job store must not take the history down with
     * it; undoPosition already has a sentence for "the job is gone". */
    return null
  }
}

/** The history as spoken lines, for a device with no screen. */
export function speakHistory(history) {
  if (!history?.runs?.length) {
    return 'There are no recorded accessibility-mode runs yet.'
  }
  return history.runs
    .map((run) => `${run.headline} ${run.undo.plainly}`)
    .join(' ')
}

function lowerFirst(text) {
  const value = String(text ?? '')
  return value ? value[0].toLowerCase() + value.slice(1) : value
}
