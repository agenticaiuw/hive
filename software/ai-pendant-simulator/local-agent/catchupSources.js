import {
  MAC_RESULT_MAX_WAIT_MS,
  ROUTINE_LEASE_MS,
} from '../cloud-relay/routines.js'
import { fingerprintFinding } from './briefingTriage.js'
import { instantOf } from './catchupClock.js'

/*
 * Every surface that knows something about the gap, reduced to one shape.
 *
 * THE ONE JOB OF THIS FILE is to answer, for each record it is handed, the
 * question no existing surface answers: did this OCCUR, is it QUEUED, did it
 * EXPIRE, did it FAIL — or is it INDETERMINATE. Every other field is
 * bookkeeping in service of that.
 *
 * WHY INDETERMINATE IS A FIRST-CLASS LABEL AND NOT A ROUNDING ERROR
 * -----------------------------------------------------------------
 * The brief asked for four labels. There are five, and the fifth is the one
 * with teeth. Three separate places in this codebase record an action that was
 * HANDED OVER and never answered:
 *
 *   - actionLedger.js exists entirely for this: "absence of a receipt cannot
 *     distinguish 'never dispatched' from 'dispatched and we crashed before it
 *     answered', and those two demand opposite recoveries."
 *   - browserBridge.js spools a lease-expired command with the words "it may
 *     already have run, and running it twice would act on the page twice."
 *   - routines.js dispatches to the Mac and reaps later; between those two
 *     moments the relay genuinely does not know.
 *
 * Filing any of those under `occurred` is a lie the owner would act on. Filing
 * them under `failed` is a different lie they would also act on — they would
 * redo something that may already have happened. Filing them under `queued`
 * says "relax, it is coming", which is the worst of the three. The honest label
 * is the fifth one, and the digest routes every one of them to the owner,
 * because an indeterminate outcome is by definition the one thing only a human
 * can settle.
 *
 * WHAT THIS FILE MAY NOT DO. It imports actionLedger, browserSpool,
 * briefingQueue, briefingTriage and jobTracker READ-ONLY. Nothing here writes,
 * retries, replays, clears, acknowledges or resolves anything. A catch-up
 * digest that acts is not a digest, and browserSpool.js in particular states
 * the rule for its own contents: "A replay is a thing the owner asks for, in
 * the moment they ask for it, from a list they can see."
 */

export const CATCHUP_LABELS = Object.freeze([
  'occurred',
  'queued',
  'expired',
  'failed',
  'indeterminate',
])

/*
 * How long an untouched in-flight record stops meaning "busy" and starts
 * meaning "we do not know".
 *
 * Borrowed from routines.ROUTINE_LEASE_MS rather than chosen: five minutes is
 * already this project's answer to "a run that stopped touching things is
 * dead", and a second, different number for the same judgement is how two
 * surfaces come to disagree about the same run. A live plan rewrites its ledger
 * twice per step, so five minutes of silence is a long silence.
 */
export const INFLIGHT_STALE_MS = 5 * 60 * 1000

const iso = (value) => (value ? String(value) : null)
const trim = (value, max = 200) => {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * One row of the digest.
 *
 * `why` is not a description of the thing — `title` is that. `why` is the
 * evidence for the LABEL, in the owner's words, because a label without its
 * reason is exactly the blur this feature exists to remove.
 */
function event({
  id,
  surface,
  label,
  title,
  why,
  at,
  detail = null,
  causedBy = [],
  /* Other names this same fact is known by on other surfaces, so an edge
   * written in one surface's vocabulary still lands. See orderByCausality. */
  aliases = [],
  joins = {},
  needsOwner = false,
  needsOwnerReason = null,
  suggestion = null,
  where = null,
  fingerprintInputs = null,
}) {
  return {
    id,
    surface,
    label,
    title: trim(title, 160),
    why: trim(why, 320),
    detail: detail === null ? null : trim(detail, 400),
    at,
    causedBy: causedBy.filter(Boolean),
    aliases: aliases.filter(Boolean),
    joins,
    needsOwner,
    needsOwnerReason: needsOwnerReason === null ? null : trim(needsOwnerReason, 240),
    suggestion: suggestion === null ? null : trim(suggestion, 240),
    where,
    fingerprintInputs,
    /* Filled in by the digest once it knows what the owner has already been
     * told; a source cannot answer that and must not pretend to. */
    fingerprint: null,
    alreadyTold: null,
  }
}

/* --------------------------------------------------------- action ledger */

/*
 * Plan manifests. The only surface that can tell "never dispatched" from
 * "dispatched then crashed", because it is the only one that writes the
 * intention down BEFORE the executor is handed the action.
 *
 * One event per plan, plus one per in-flight step and one per failed step. Not
 * one per step: the owner asked what happened while they were away, and twenty
 * keystrokes are one thing that happened. The steps that get their own row are
 * the ones the plan-level row cannot speak for.
 */
export function eventsFromLedgers(ledgers = [], { now = Date.now() } = {}) {
  const events = []

  for (const manifest of ledgers) {
    if (!manifest?.ledgerId) continue
    const steps = Array.isArray(manifest.steps) ? manifest.steps : []
    const done = steps.filter((step) => step.phase === 'done')
    const failed = done.filter((step) => step.ok === false)
    const inflight = steps.filter((step) => step.phase === 'inflight')
    const pending = steps.filter((step) => step.phase === 'pending')
    const planId = `ledger:${manifest.ledgerId}`
    const title = trim(manifest.title || manifest.command || 'An automation ran', 160)

    /* The ledger's own updatedAt is the liveness signal: every step transition
     * rewrites and fsyncs the file, so a stale file is a dead run. */
    const touchedAt = Date.parse(manifest.updatedAt ?? manifest.createdAt ?? '') || 0
    const stale = now - touchedAt > INFLIGHT_STALE_MS

    let label = 'occurred'
    let why = `All ${steps.length} step(s) ran and none reported an error.`
    let needsOwner = false
    let needsOwnerReason = null
    let suggestion = null

    if (inflight.length) {
      if (stale) {
        label = 'indeterminate'
        why =
          `Step ${inflight[0].seq + 1} was handed to the executor and never answered. ` +
          'The record was written before dispatch, so it definitely started; nothing recorded whether it finished.'
        needsOwner = true
        needsOwnerReason =
          'Only you can tell whether this step took effect. Re-running it blindly could do it twice.'
        suggestion = `Check GET /ledger/${manifest.ledgerId}/resume — it stops at this step and asks rather than replaying it.`
      } else {
        label = 'queued'
        why = `Step ${inflight[0].seq + 1} is in flight and the record was touched moments ago — this looks like it is still running.`
      }
    } else if (manifest.status === 'open' && pending.length && stale) {
      label = 'failed'
      why =
        `The run stopped after ${done.length} of ${steps.length} step(s) and never came back. ` +
        `The ${pending.length} remaining step(s) were never dispatched — the manifest is written before dispatch, so a step still marked pending definitively never ran.`
      needsOwner = true
      needsOwnerReason = 'Part of a plan you asked for was never carried out.'
      suggestion = `GET /ledger/${manifest.ledgerId}/resume lists what is safe to continue.`
    } else if (manifest.status === 'open' && pending.length) {
      label = 'queued'
      why = `${done.length} of ${steps.length} step(s) are done; the rest have not been dispatched yet.`
    } else if (failed.length) {
      label = 'failed'
      why = `${failed.length} of ${steps.length} step(s) returned an error.`
      needsOwner = true
      needsOwnerReason = 'Something you asked for did not work.'
    }

    events.push(
      event({
        id: planId,
        surface: 'action-ledger',
        label,
        title,
        why,
        detail: manifest.command ? `Command: ${trim(manifest.command, 200)}` : null,
        at: instantOf({ domain: 'mac', at: manifest.createdAt }),
        joins: { ledgerId: manifest.ledgerId, jobId: manifest.jobId ?? null },
        /* The job row is the cause of the plan, not the other way round: the
         * job is created when the command arrives, the manifest when the plan
         * is built from it. */
        causedBy: manifest.jobId ? [`job:${manifest.jobId}`] : [],
        needsOwner,
        needsOwnerReason,
        suggestion,
        where: `/ledger/${manifest.ledgerId}`,
        fingerprintInputs: {
          source: 'action-ledger',
          key: manifest.planKey ?? manifest.ledgerId,
          title,
          actionableUntil: null,
        },
      }),
    )

    for (const step of inflight) {
      events.push(
        event({
          id: `ledger-step:${manifest.ledgerId}:${step.stepKey}`,
          surface: 'action-ledger',
          label: stale ? 'indeterminate' : 'queued',
          title: step.label || step.type || 'A step',
          why: stale
            ? 'It was dispatched and nothing recorded an answer. Whether it took effect is unknown.'
            : 'It is running now.',
          detail:
            step.replaySafety === 'idempotent'
              ? 'Running this one twice is safe, so it can be settled by simply doing it again.'
              : step.preStateKind === 'unobservable' || step.preState?.kind === 'unobservable'
                ? 'Nothing about the world before it ran was observable, so there is no after-the-fact check that could settle it.'
                : 'There is a pre-state recorded, so comparing against it can settle whether it landed.',
          at: instantOf({ domain: 'mac', at: step.startedAt }),
          causedBy: [planId],
          joins: { ledgerId: manifest.ledgerId, stepKey: step.stepKey },
          needsOwner: stale,
          needsOwnerReason: stale
            ? 'This is the one kind of item nobody but you can settle: it may have happened, and doing it again may do it twice.'
            : null,
          where: `/ledger/${manifest.ledgerId}/resume`,
          fingerprintInputs: {
            source: 'action-ledger',
            key: step.stepKey,
            title: step.label || step.type || 'A step',
            actionableUntil: null,
          },
        }),
      )
    }

    for (const step of failed) {
      events.push(
        event({
          id: `ledger-step:${manifest.ledgerId}:${step.stepKey}`,
          surface: 'action-ledger',
          label: 'failed',
          title: step.label || step.type || 'A step',
          why: trim(step.message || `It returned ${step.status ?? 'an error'}.`, 240),
          at: instantOf({ domain: 'mac', at: step.finishedAt ?? step.startedAt }),
          causedBy: [planId],
          joins: { ledgerId: manifest.ledgerId, stepKey: step.stepKey, receiptId: step.receiptId ?? null },
          needsOwner: true,
          needsOwnerReason: 'It was attempted and it did not work.',
          where: `/ledger/${manifest.ledgerId}`,
          fingerprintInputs: {
            source: 'action-ledger',
            key: step.stepKey,
            title: step.label || step.type || 'A step',
            actionableUntil: null,
          },
        }),
      )
    }
  }

  return events
}

/* ----------------------------------------------------------- browser spool */

/*
 * The browser tier's dead letters — and the sharpest illustration of why one
 * word for "it did not happen" is not enough.
 *
 * browserBridge.js spools for three different reasons and they carry three
 * different truths:
 *
 *   expired              the TTL ran out with no extension online. Nobody ever
 *                        saw it. EXPIRED, and certainly not failed.
 *   lease-expired        an extension CLAIMED it and never answered. The
 *                        bridge's own words: "it may already have run, and
 *                        running it twice would act on the page twice."
 *                        INDETERMINATE.
 *   extension-restarted  claimed, then the extension went away. Same shape.
 *                        INDETERMINATE.
 *
 * Rolling those into one bucket would tell the owner a tab was never opened
 * when it may be open in front of them.
 */
const SPOOL_LABELS = {
  expired: {
    label: 'expired',
    why: 'Its 90-second window closed with no browser extension online to run it. Nothing ever saw it.',
    needsOwner: false,
  },
  'lease-expired': {
    label: 'indeterminate',
    why: 'A browser extension took this command and never answered. It may already have run.',
    needsOwner: true,
    needsOwnerReason:
      'Running it again could act on the page twice, so the bridge deliberately did not retry it.',
  },
  'extension-restarted': {
    label: 'indeterminate',
    why: 'The browser extension that had taken this command restarted before answering. It may already have run.',
    needsOwner: true,
    needsOwnerReason:
      'Running it again could act on the page twice, so the bridge deliberately did not retry it.',
  },
}

export function eventsFromBrowserSpool(spool = {}) {
  const entries = Array.isArray(spool.entries) ? spool.entries : []

  const events = entries.map((entry) => {
    const verdict = SPOOL_LABELS[entry.reason] ?? {
      label: 'indeterminate',
      why: `The bridge retired it for a reason this digest does not recognise (${trim(entry.reason, 60)}).`,
      needsOwner: true,
      needsOwnerReason: 'An outcome nobody can name is one only you can settle.',
    }
    const what = entry.action?.type ?? 'a browser command'

    return event({
      id: `spool:${entry.commandId ?? `${entry.spooledAt}:${what}`}`,
      surface: 'browser-spool',
      label: verdict.label,
      title: `Browser: ${what}`,
      why: verdict.why,
      detail: entry.detail ? trim(entry.detail, 200) : null,
      /* Queued-at, not spooled-at: the owner asked for it when it was queued.
       * Both are this Mac's clock, so no conversion is involved. */
      at: instantOf({ domain: 'mac', at: entry.queuedAt ?? entry.spooledAt }),
      joins: { commandId: entry.commandId ?? null, sessionId: entry.sessionId ?? null },
      needsOwner: Boolean(verdict.needsOwner),
      needsOwnerReason: verdict.needsOwnerReason ?? null,
      suggestion:
        verdict.label === 'expired'
          ? 'If you still want it, ask again with a browser window open — nothing will replay it on its own.'
          : null,
      where: '/browser/spool',
      fingerprintInputs: {
        source: 'browser-spool',
        key: entry.commandId ?? '',
        title: `Browser: ${what}`,
        actionableUntil: null,
      },
    })
  })

  /*
   * A spool that silently overflowed reads exactly like a spool nothing was
   * ever written to. browserSpool.js reports its own losses for that reason,
   * and a digest that dropped the report would re-open the hole one layer up:
   * the owner would be told about four dead commands when there were nine.
   */
  const dropped = spool.dropped ?? {}
  if (Number(dropped.entries) > 0) {
    events.push(
      event({
        id: 'spool:dropped',
        surface: 'browser-spool',
        label: 'expired',
        title: `${dropped.entries} more browser command(s) were dropped from the record`,
        why:
          'The spool is bounded in bytes and these were evicted, so this digest cannot say what they were. ' +
          'They are counted here rather than left invisible.',
        detail: dropped.lastAt ? `The most recent loss was at ${iso(dropped.lastAt)}.` : null,
        at: instantOf({ domain: 'mac', at: dropped.lastAt }),
        needsOwner: false,
        where: '/browser/spool',
      }),
    )
  }

  return events
}

/* -------------------------------------------------------------- Mac jobs */

/**
 * The job store: one row per command the agent was given.
 *
 * Deliberately shallow. /jobs and /journal already expand a job into its steps
 * and receipts, and re-deriving that here would produce a second account of the
 * same run that can disagree with the first. This asks the one question the
 * digest needs — did it finish — and links to the surface that answers the
 * rest.
 */
export function eventsFromJobs(jobs = [], { now = Date.now() } = {}) {
  return jobs
    .filter((job) => job?.jobId)
    .map((job) => {
      const running = job.status === 'processing'
      const stale = now - (Date.parse(job.updatedAt ?? job.createdAt ?? '') || 0) > INFLIGHT_STALE_MS
      const failed = job.status === 'failed' || Boolean(job.error)

      let label = 'occurred'
      let why = 'It finished.'
      let needsOwner = false
      let needsOwnerReason = null

      if (running && stale) {
        label = 'indeterminate'
        why =
          'It was accepted and never reached a terminal state. The process that was running it is no longer updating the row.'
        needsOwner = true
        needsOwnerReason = 'Nothing recorded whether this finished, so nothing but you can close it out.'
      } else if (running) {
        label = 'queued'
        why = 'It is still running.'
      } else if (failed) {
        label = 'failed'
        why = trim(job.error || 'It ended with an error.', 240)
        needsOwner = true
        needsOwnerReason = 'You asked for this and it did not work.'
      } else if (job.undoneAt) {
        /* An undone job DID occur and was then reversed. Both facts are true
         * and the second one does not erase the first — a digest that showed
         * only "occurred" would have the owner believing a change is in place
         * that is not. */
        label = 'occurred'
        why = 'It ran, and it was undone afterwards.'
      }

      return event({
        id: `job:${job.jobId}`,
        surface: 'mac-job',
        label,
        title: trim(job.command || job.type || 'A command', 160),
        why,
        detail: job.type ? `Type: ${job.type}` : null,
        at: instantOf({ domain: 'mac', at: job.createdAt }),
        joins: { jobId: job.jobId, sessionId: job.sessionId ?? null },
        needsOwner,
        needsOwnerReason,
        where: `/jobs/${job.jobId}/receipts`,
        fingerprintInputs: {
          source: 'mac-job',
          key: job.jobId,
          title: trim(job.command || job.type || 'A command', 160),
          actionableUntil: null,
        },
      })
    })
}

/* ------------------------------------------------------- relay routine runs */

/*
 * Scheduled occurrences, folded from attempts.
 *
 * THE UNIT IS THE OCCURRENCE, NOT THE ATTEMPT. cloud-relay/scheduler.js already
 * says why, at the route that groups them: "Three receipts for one 7am briefing
 * is one thing that happened, not three — flattening them reads as a routine
 * that fired three times." The owner declared one 7am briefing; a digest that
 * reports three rows has told them something false about their own schedule.
 *
 * And the labels turn on the distinction scheduler.js draws in the same file:
 * a receipt with status 'failed' and `final: false` is a RETRY PENDING, which
 * is a schedule doing its job, not a failure. It is `queued`.
 */
const OCCURRENCE_LABELS = {
  completed: {
    label: 'occurred',
    why: 'It ran and finished.',
  },
  missed: {
    label: 'expired',
    why: 'Its window closed before anything could run it, so the occurrence was dropped rather than queued up to fire late.',
    needsOwner: true,
    needsOwnerReason: 'This one is not coming back on its own — the occurrence is gone.',
  },
  deferred: {
    label: 'queued',
    why: 'It needs this Mac, which was asleep, so the occurrence is being held rather than burned.',
  },
  dispatched: {
    label: 'indeterminate',
    why: 'It was handed to this Mac as a job and no result ever came back to the relay.',
    needsOwner: true,
    needsOwnerReason: 'The two halves disagree about whether this ran; only you can say which is right.',
  },
  running: {
    label: 'indeterminate',
    why: 'A run claimed this occurrence and never filed an outcome — the worker that had it is gone.',
    needsOwner: true,
    needsOwnerReason: 'Nothing recorded how this ended.',
  },
}

export function eventsFromRoutineRuns(runs = [], { now = Date.now() } = {}) {
  const occurrences = new Map()

  for (const run of runs) {
    if (!run?.routineId) continue
    const key = run.occurrenceKey || `${run.routineId}#${run.dueAt || run.startedAt}`
    const bucket = occurrences.get(key) ?? { key, attempts: [] }
    bucket.attempts.push(run)
    occurrences.set(key, bucket)
  }

  const events = []

  for (const { key, attempts } of occurrences.values()) {
    attempts.sort((left, right) => Number(left.attempt || 1) - Number(right.attempt || 1))

    /*
     * A superseded attempt is a duplicate the guard refused. It is real
     * evidence that the guard worked, and it is NOT a thing that happened to
     * the owner — the occurrence it belongs to is settled by another attempt.
     * So it is counted in the detail and never given a row of its own.
     */
    const superseded = attempts.filter((run) => run.status === 'superseded')
    const settling = [...attempts].reverse().find((run) => run.status !== 'superseded') ?? attempts.at(-1)
    if (!settling) continue

    const retrying = settling.status === 'failed' && settling.final === false
    const sinceStart = now - (Date.parse(settling.startedAt ?? '') || now)
    /*
     * The two windows are imported from routines.js rather than restated, so
     * the digest and the scheduler cannot come to disagree about the same run.
     * Inside MAC_RESULT_MAX_WAIT_MS the reaper still intends to close a
     * dispatched run, and inside ROUTINE_LEASE_MS a claimed run is still
     * honoured as somebody's; past either, nobody is coming.
     */
    const dispatchedRecently =
      settling.status === 'dispatched' && sinceStart < MAC_RESULT_MAX_WAIT_MS
    const leaseAlive = settling.status === 'running' && sinceStart < ROUTINE_LEASE_MS

    let verdict
    if (leaseAlive) {
      verdict = {
        label: 'queued',
        why: 'It is running right now.',
        needsOwner: false,
      }
    } else if (retrying) {
      verdict = {
        label: 'queued',
        why: `Attempt ${settling.attempt} did not work and another is scheduled${
          settling.nextAttemptAt ? ` for ${iso(settling.nextAttemptAt)}` : ''
        }. Nothing has been lost yet.`,
        needsOwner: false,
      }
    } else if (dispatchedRecently) {
      verdict = {
        label: 'queued',
        why: 'It was handed to this Mac as a job and the answer has not come back yet.',
        needsOwner: false,
      }
    } else if (settling.status === 'failed') {
      verdict = {
        label: 'failed',
        why: trim(settling.error || 'It failed and no further attempt is scheduled.', 240),
        needsOwner: true,
        needsOwnerReason: 'It has run out of attempts, so it will not happen unless you ask again.',
      }
    } else {
      verdict = OCCURRENCE_LABELS[settling.status] ?? {
        label: 'indeterminate',
        why: `The relay recorded a status this digest does not recognise (${trim(settling.status, 40)}).`,
        needsOwner: true,
        needsOwnerReason: 'An outcome nobody can name is one only you can settle.',
      }
    }

    const title = trim(settling.routineName || settling.command || 'A scheduled task', 160)
    const detailParts = []
    if (attempts.length > 1) detailParts.push(`${attempts.length} attempt(s)`)
    if (superseded.length) {
      detailParts.push(
        `${superseded.length} duplicate attempt(s) were refused because this occurrence was already settled`,
      )
    }

    events.push(
      event({
        id: `occurrence:${key}`,
        surface: 'relay-routine',
        label: verdict.label,
        title,
        why: verdict.why,
        detail: detailParts.length ? detailParts.join('; ') : null,
        /*
         * dueAt, not startedAt: the owner's mental model is "the 7am one", and
         * dueAt is the only field that survives a deferral — routines.js
         * derives it from `dueSince` precisely so "a deferred Monday 5pm run
         * that finally executes on Tuesday morning is not filed as Tuesday's".
         */
        at: instantOf({ domain: 'relay', at: settling.dueAt ?? settling.startedAt }),
        /*
         * Every attempt's runId, and the Mac job it dispatched. An announcement
         * records the runId of the individual attempt that produced it, not the
         * occurrence key — so without these the announcement would be filed as
         * an orphan and the one real causal link between the relay's two rows
         * would be lost.
         */
        aliases: [
          ...attempts.map((attempt) => `run:${attempt.runId}`),
          ...attempts.filter((attempt) => attempt.macJobId).map((attempt) => `job:${attempt.macJobId}`),
        ],
        joins: {
          occurrenceKey: key,
          routineId: settling.routineId,
          runId: settling.runId ?? null,
          macJobId: settling.macJobId ?? null,
          announcementId: settling.announcementId ?? null,
        },
        needsOwner: Boolean(verdict.needsOwner),
        needsOwnerReason: verdict.needsOwnerReason ?? null,
        where: `/v1/routines/${settling.routineId}/runs`,
        fingerprintInputs: {
          source: 'relay-routine',
          key,
          title,
          actionableUntil: settling.nextAttemptAt ?? null,
        },
      }),
    )
  }

  return events
}

/* ------------------------------------------------------ relay announcements */

/*
 * Words the system tried to put in the owner's ear.
 *
 * This is the surface where "queued" and "occurred" are most often blurred,
 * because both look like a row in the announcements table. `state: 'pending'`
 * past its expiresAt means nobody was listening and the words are gone:
 * EXPIRED, and worth saying out loud, because a briefing that expired unheard
 * is indistinguishable, from the owner's side, from one that was never
 * composed.
 *
 * `state: 'delivered'` used to be read here as "the pendant actually spoke it —
 * the owner HEARD this". It never meant that. It was set on `sentBytes > 0`:
 * bytes accepted by a WebSocket, on a device that reports nothing back about
 * its own speaker. So the digest was telling the owner they had heard something
 * that nothing in the system could witness.
 *
 * The queue state is now read for what it is — "the relay stopped offering this
 * one" — and the evidence beside it (`heard`, `deliveryEvidence`,
 * `deliveryComplete`, written by cloud-relay/announce.js) decides what may be
 * claimed. Records written before that evidence existed carry none of it; they
 * keep their dedupe weight, because re-reading every past briefing is its own
 * harm, but they no longer get to say the pendant spoke.
 */
export function eventsFromAnnouncements(announcements = [], { now = Date.now() } = {}) {
  return announcements
    .filter((entry) => entry?.announcementId)
    .map((entry) => {
      const expiresAt = Date.parse(entry.expiresAt ?? '')
      const expired = Number.isFinite(expiresAt) && expiresAt <= now
      const delivered = entry.state === 'delivered'
      const dismissed = entry.state === 'dismissed'

      let label = 'queued'
      let why = 'It is waiting for the pendant to be listening.'
      let needsOwner = false
      let needsOwnerReason = null

      if (delivered) {
        /*
         * Three different records wear this one queue state. Only the first has
         * a witness for the owner's ear, and on the current firmware nothing can
         * produce it — see PLAYBACK_REPORT_CONTRACT in shared/audioDelivery.js.
         */
        const heard = entry.heard
        const hasEvidence = heard != null || entry.deliveryEvidence != null

        if (heard === 'yes') {
          label = 'occurred'
          why = 'The pendant reported playing this to you.'
        } else if (hasEvidence && entry.deliveryComplete === false) {
          label = 'indeterminate'
          why =
            'Delivery stopped part-way through, so you may have heard the start and none of the rest.'
          needsOwner = true
          needsOwnerReason = 'You were meant to hear all of this and may not have.'
        } else if (hasEvidence) {
          label = 'indeterminate'
          why =
            'The whole briefing was written to the pendant’s open socket. The pendant does not report playback, so whether you heard it is not known.'
        } else {
          /* Written before any of this was recorded. Say only what survives. */
          label = 'occurred'
          why =
            'The relay finished sending this to the pendant. This record predates playback evidence, so it cannot say whether you heard it.'
        }
      } else if (dismissed) {
        label = 'occurred'
        why = 'It reached you and you dismissed it.'
      } else if (expired) {
        label = 'expired'
        why = 'Its delivery window closed before the pendant was listening, so it was never said out loud.'
        needsOwner = true
        needsOwnerReason = 'You were meant to hear this and did not.'
      } else if (entry.state === 'delivering') {
        label = 'indeterminate'
        why =
          'Delivery was claimed and never confirmed. It may have been spoken to a pendant that then dropped its link.'
      }

      const title = trim(entry.title || 'An announcement', 160)

      return event({
        id: `announcement:${entry.announcementId}`,
        surface: 'relay-announcement',
        label,
        title,
        why,
        detail: trim(entry.speech, 240),
        at: instantOf({ domain: 'relay', at: entry.createdAt }),
        /* The run that produced it is its cause, by identifier. */
        causedBy: entry.runId ? [`run:${entry.runId}`] : [],
        joins: {
          announcementId: entry.announcementId,
          runId: entry.runId ?? null,
          routineId: entry.routineId ?? null,
        },
        needsOwner,
        needsOwnerReason,
        where: '/v1/announcements',
        fingerprintInputs: {
          source: 'relay-announcement',
          key: entry.announcementId,
          title,
          actionableUntil: entry.expiresAt ?? null,
        },
      })
    })
}

/* ------------------------------------------------------- pendant offline items */

/*
 * What the worn device did while it had no link.
 *
 * THIS IS THE HARD CLOCK, and it is hard for a reason no software change can
 * fix. firmware/nrf9160/src/pendant_store.h stamps a bookmark with "the
 * timestamp the device has (modem NITZ clock when the tower ever gave us one,
 * uptime otherwise)". A NITZ stamp is a real, coarse wall-clock reading. An
 * uptime stamp is milliseconds since the device booted — a true statement about
 * an instant nobody can locate, and one that is often SMALLER than any epoch
 * time in the digest.
 *
 * So this normalizer does not repair the timestamp and does not drop the item.
 * It labels the clock (`quality: 'uptime'`), which makes catchupClock refuse to
 * place it, and it records the ONE thing that is definitely true about when it
 * happened: it was before the moment it reached the relay. That statement is
 * expressed as a causal edge to the forwarding event, never as a number.
 *
 * `forwardedAt` is a relay stamp, so the relay's own uncertainty applies to it
 * on top. An honest digest says "sometime before 14:02, relay time" and stops.
 */
export function eventsFromPendantItems(items = []) {
  const events = []

  for (const item of items) {
    if (!item?.itemId) continue

    const clockSource = String(item.clockSource ?? 'unknown').toLowerCase()
    const quality = clockSource === 'nitz' ? 'wall' : clockSource === 'uptime' ? 'uptime' : 'unknown'
    const forwardId = `pendant-forward:${item.itemId}`
    const kind = String(item.kind ?? '').toUpperCase()

    const shape =
      kind === 'M'
        ? { title: 'You marked a moment on the pendant', where: '/v1/ops/history' }
        : kind === 'V'
          ? { title: 'You left a voice memo on the pendant', where: '/v1/ops/history' }
          : kind === 'A'
            ? { title: 'You read the alerts the pendant was holding', where: '/v1/announcements' }
            : { title: 'The pendant held something for you', where: '/v1/ops/history' }

    /*
     * The press itself. It OCCURRED — the device wrote it to its card, which is
     * the definition of it having happened. What is unknown is only WHEN.
     */
    events.push(
      event({
        id: `pendant:${item.itemId}`,
        surface: 'pendant-offline',
        label: 'occurred',
        title: shape.title,
        why:
          quality === 'uptime'
            ? 'The device recorded it while offline. Its clock had never been set, so the only certain thing about the time is that it was before the item reached the relay.'
            : quality === 'wall'
              ? 'The device recorded it while offline, timed by the cell network clock, and forwarded it when the link came back.'
              : 'The device recorded it while offline. It carries no usable timestamp of its own.',
        detail: item.detail ? trim(item.detail, 240) : null,
        at: instantOf({ domain: 'pendant', at: item.deviceAt, quality }),
        joins: { itemId: item.itemId, jobId: item.jobId ?? null },
        needsOwner: false,
        where: shape.where,
        fingerprintInputs: {
          source: 'pendant-offline',
          key: item.itemId,
          title: shape.title,
          actionableUntil: null,
        },
      }),
    )

    /*
     * The forwarding. A separate event because it is a separate fact stamped by
     * a separate clock — and because it is the anchor that gives the press an
     * upper bound. Merging the two would silently attribute the relay's
     * timestamp to the device's action.
     */
    if (item.forwardedAt) {
      events.push(
        event({
          id: forwardId,
          surface: 'pendant-offline',
          label: 'occurred',
          title: `${shape.title} — it reached the relay`,
          why: 'The link came back and the device handed this over. The relay confirmed it before the device dropped it.',
          at: instantOf({ domain: 'relay', at: item.forwardedAt }),
          causedBy: [`pendant:${item.itemId}`],
          joins: { itemId: item.itemId, jobId: item.jobId ?? null },
          needsOwner: false,
          where: shape.where,
        }),
      )
    }
  }

  /*
   * An item with no `forwardedAt` is one the device is still holding. Its press
   * still OCCURRED — the card write is the press having happened — and the
   * absence of a forwarding row is the honest way to say it has not reached
   * anything else yet. Manufacturing a forwarding time would be inventing the
   * one fact the pendant has not yet supplied.
   */
  return events
}

/** Alerts sitting on the device's card, unread. */
export function eventsFromPendantInbox({ heldAlerts = 0, observedAt = null } = {}) {
  if (!Number(heldAlerts)) return []
  return [
    event({
      id: 'pendant-inbox',
      surface: 'pendant-offline',
      label: 'queued',
      title: `${heldAlerts} alert(s) are held on the pendant, unread`,
      why: 'The relay handed them to the device and the device is holding them until you interact with it. Nothing has been lost.',
      detail: 'Press the pendant to hear them; it works with the radio off.',
      at: instantOf({ domain: 'relay', at: observedAt }),
      needsOwner: false,
      where: '/v1/announcements',
    }),
  ]
}

/* ------------------------------------------------------------- briefings */

/*
 * Briefings the agent composed for the owner.
 *
 * The interesting row here is the one nobody would think to write: a briefing
 * that was COMPOSED and never PLAYED. briefingQueue.js was built after that
 * exact failure — "run one said '2 things need you' and went unplayed, run
 * three minutes later found both fingerprints in the ledger, said 'nothing
 * needs you right now', and replaced the audio the owner had not heard". The
 * findings were marked told; the owner heard nothing.
 *
 * So an unplayed briefing is `queued`, it counts as NOT TOLD (the digest passes
 * its runId to toldFingerprints as an exclusion), and it is surfaced as
 * something waiting for the owner. Anything else re-opens the same hole.
 */
export function eventsFromBriefingRuns(runs = [], { unheardRunIds = [] } = {}) {
  const unheard = new Set(unheardRunIds.filter(Boolean))

  return runs
    .filter((run) => run?.id)
    .map((run) => {
      const waiting = unheard.has(run.id)
      const title = trim(run.spoken || 'A briefing was prepared for you', 160)

      return event({
        id: `briefing:${run.id}`,
        surface: 'briefing',
        label: waiting ? 'queued' : 'occurred',
        title,
        why: waiting
          ? 'It was written and the audio is still sitting unplayed, so nothing in it has actually reached you.'
          : 'It was delivered.',
        detail: `${run.told ?? 0} item(s) spoken, ${run.queued ?? 0} put in the review queue.`,
        at: instantOf({ domain: 'mac', at: run.generatedAt }),
        joins: { runId: run.id, briefingId: run.briefingId ?? null },
        needsOwner: waiting,
        needsOwnerReason: waiting ? 'A briefing was prepared for you and you have not heard it.' : null,
        where: '/briefings',
        fingerprintInputs: {
          source: 'briefing',
          key: run.id,
          title,
          actionableUntil: null,
        },
      })
    })
}

/**
 * Open findings the owner was asked to look at rather than told about.
 *
 * These are `queued` by construction: briefingQueue.js keeps a row for exactly
 * as long as the thing is open, and a row whose evidence was revoked keeps its
 * title and loses its body — which is passed through here untouched, because
 * re-deriving the detail would defeat the revocation.
 */
export function eventsFromReviewQueue(items = []) {
  return items
    .filter((item) => item?.id)
    .map((item) => ({
      ...event({
        id: `review:${item.id}`,
        surface: 'review-queue',
        label: 'queued',
        title: trim(item.title || 'An open finding', 160),
        why:
          item.seenCount > 1
            ? `It has been open across ${item.seenCount} briefings and is still waiting for you.`
            : 'It was found and queued for you rather than acted on. Nothing was sent or changed.',
        detail: trim(item.detail || item.summary || '', 240) || null,
        at: instantOf({ domain: 'mac', at: item.openedAt }),
        /*
         * The one `queued` row that DOES need the owner. Everything else
         * labelled queued is the system still working on it; this one is the
         * system having deliberately stopped and handed it over.
         */
        needsOwner: true,
        needsOwnerReason: 'Nothing acts on these; they wait for you.',
        where: '/briefing/queue',
        fingerprintInputs: {
          source: item.source ?? 'review-queue',
          key: item.id,
          title: item.title ?? '',
          actionableUntil: item.actionableUntil ?? null,
        },
      }),
      /*
       * The row's OWN fingerprint, straight off briefingQueue.js, rather than
       * one recomputed here. It was minted by briefingTriage.fingerprintFinding
       * over the original finding, and recomputing it from the queue row would
       * hash a different `key` and quietly never match the told-ledger — so
       * every already-heard item would be told again, which is the one thing
       * this digest was asked not to do.
       */
      fingerprint: item.fingerprint ?? null,
    }))
}

/* ---------------------------------------------------------- fingerprinting */

/*
 * The same function briefingTriage.js uses, called with the same inputs.
 *
 * Not a lookalike: `fingerprintFinding` is imported from that module so the
 * two features cannot drift into computing different hashes for the same
 * finding — which would silently turn every dedupe check into a miss, and the
 * symptom would be the owner hearing everything twice.
 */
export function fingerprintEvent(row, band = 'none') {
  if (row.fingerprint) return row.fingerprint
  if (!row.fingerprintInputs) return null
  return fingerprintFinding(
    {
      source: row.fingerprintInputs.source,
      key: row.fingerprintInputs.key,
      title: row.fingerprintInputs.title,
      actionableUntil: row.fingerprintInputs.actionableUntil,
    },
    band,
  )
}
