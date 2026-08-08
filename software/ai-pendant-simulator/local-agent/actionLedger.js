import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { actionIdFor } from './actionReceipts.js'
import { classifyAction } from './actionRisk.js'
import { foreseeAction } from './planPreview.js'
import { classifySensitivity, maskSecretValue, stripImageBytes } from './redaction.js'
import {
  capturePreState,
  planResume,
  replaySafetyFor,
  riskTierFor,
} from './actionLedgerVerify.js'

/*
 * The plan manifest: what a multi-step run intends to do, written down and
 * fsynced BEFORE the first step is dispatched.
 *
 * Everything this project records about execution is recorded AFTERWARDS. A
 * receipt is written once the action has returned (actionReceipts.js); the
 * journal is derived on read from receipts that already exist
 * (executionJournal.js — "DERIVED, never hand-maintained"); undo reads the
 * results of a job that completed. All of that is correct, and all of it has
 * the same blind spot: if the agent dies mid-plan, the steps that ran left
 * receipts, the steps that did not left nothing, and the step that was IN
 * FLIGHT — the only one that matters — left nothing either. Absence of a
 * receipt cannot distinguish "never dispatched" from "dispatched and we
 * crashed before it answered", and those two demand opposite recoveries.
 *
 * This file closes that one gap and nothing else. It does NOT re-derive
 * reversibility (planPreview.foreseeAction), touched refs (actionReceipts),
 * hands-free risk (actionRisk.classifyAction), or the history of a completed
 * job (executionJournal, /jobs/:id/receipts, /journal). It calls all of them
 * and stores what they say, at the one moment none of them are able to run:
 * before anything has happened.
 *
 * THE ORDERING INVARIANT, on which the whole recovery rests:
 *
 *     the "started" record is fsynced BEFORE the executor is handed the action
 *
 * so a crash after dispatch always leaves the step `inflight`, never `pending`.
 * atomicJsonStore.writeJsonAtomic fsyncs the file and its directory, which is
 * what makes that a durability claim rather than a hope. If you ever move the
 * markStepStarted call to after execute(), delete the resume path with it —
 * "pending means it never ran" becomes a lie and the resume starts re-running
 * completed work.
 *
 * IT CANNOT BLOCK. Recording a manifest does not gate, delay, refuse, or alter
 * an action; ledgerStepObserver swallows every one of its own failures rather
 * than let a bookkeeping error stop the owner's plan. That is the same position
 * actionReceipts.js, planPreview.js, evidenceCapsules.js and
 * executionJournal.js take about themselves, and the five files should keep
 * agreeing. The one thing this module WILL do is decline to answer: a resume
 * that cannot establish what happened returns a question instead of a plan.
 */

export const LEDGER_VERSION = 1

/*
 * BOUNDED BY BYTES, NOT BY COUNT.
 *
 * jobTracker.js caps the job store at 120 jobs — a count — and that store
 * reached 129 MB because a job's `result` is whatever the orchestrator
 * returned, and something started returning live snapshots of other stores.
 * Every write re-serialised and fsynced the whole array three times and the
 * agent stopped answering. jobTracker now carries a byte budget as well; this
 * store was born with one.
 *
 * The number is small on purpose, and it is a LATENCY budget as much as a disk
 * budget: every step transition rewrites and fsyncs this entire file, twice
 * per step, because that is what makes the record survive a crash. A megabyte
 * of JSON re-serialised forty times during a twenty-step plan is already the
 * upper end of what should sit in the execution path.
 */
export const MAX_STORE_BYTES = 1024 * 1024
export const MAX_LEDGER_BYTES = 64 * 1024

/*
 * HOW LONG A LIVE RUN MAY GO WITHOUT TOUCHING THIS FILE.
 *
 * Every step transition rewrites and fsyncs the whole store, twice per step, so
 * a run that is still being driven leaves fingerprints continuously. Silence for
 * longer than this means nobody is driving it.
 *
 * Five minutes is not a guess pulled from nowhere: it is the number
 * catchupSources.INFLIGHT_STALE_MS already uses for exactly this judgement
 * (itself borrowed from routines.ROUTINE_LEASE_MS), and it is more than double
 * config.SHELL_TIMEOUT_MS — the longest a single step is allowed to block before
 * the executor gives up on it. Two surfaces answering "is this run dead" with
 * two different numbers is how the dashboard and the digest start disagreeing
 * about the same run, so this one is deliberately the same number.
 *
 * It is only ever the FALLBACK. When the ledger names a process that is provably
 * gone, the run is abandoned the moment that is observed and nothing waits five
 * minutes to say so — see ownerIsGone().
 */
export const INTERRUPTED_AFTER_MS = 5 * 60 * 1000

/* Deep enough for the nested params real actions carry, shallow enough that a
 * pathological structure cannot turn persisting a manifest into a walk. */
const MAX_PARAM_DEPTH = 6

/* Order matters: the fattest, least load-bearing field goes first. `params` is
 * shed before `preState` because losing params costs the ability to REPLAY a
 * step, while losing preState costs the ability to KNOW whether it ran — and a
 * step we cannot check is worse than a step we cannot repeat, since the first
 * blocks the whole resume and the second only blocks itself. */
const SHED_ORDER = ['params', 'postState', 'preState', 'touches']

const isValidStore = (value) =>
  Boolean(value) && typeof value === 'object' && Array.isArray(value.ledgers)

export function ledgerLocation() {
  return (
    process.env.PENDANT_ACTION_LEDGER_PATH ||
    path.join(workspacePath, '.pendant-action-ledger.json')
  )
}

function emptyStore() {
  return { version: LEDGER_VERSION, droppedLedgers: 0, droppedThrough: null, ledgers: [] }
}

function load(filePath) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  return readJsonWithRecovery(filePath, { fallback: emptyStore(), validate: isValidStore })
}

/*
 * The budget is overridable per call for the same reason browserProvenance's is:
 * the undercount this store used to have is proportional, so a small budget
 * catches it in forty writes instead of a thousand. The defaults are what
 * production uses and are asserted separately.
 */
function save(store, filePath, budget = {}) {
  const pruned = pruneLedgers(store.ledgers, budget)
  const next = {
    ...store,
    version: LEDGER_VERSION,
    ledgers: pruned.ledgers,
    droppedLedgers: (store.droppedLedgers ?? 0) + pruned.dropped,
    droppedThrough: pruned.droppedThrough ?? store.droppedThrough ?? null,
  }
  writeJsonAtomic(filePath, next, { validate: isValidStore })
  return next
}

/**
 * The size of a value AS THE STORE WRITES IT.
 *
 * atomicJsonStore.writeJsonAtomic serialises with an indent of two. This file
 * used to measure with `JSON.stringify(value)` — no indent — and compare the
 * answer to a budget describing a file, which is not a budget, it is a hope with
 * a number on it. Measured: one small manifest reported 1 378 bytes while the
 * file it produced was 2 148, a 56% undercount, and browserSpool's sibling of
 * the same bug put a store stated at 256 KB on disk at 306 682 bytes.
 *
 * browserProvenance.storeBytesOf is the same function for the same reason; if
 * atomicJsonStore ever changes how it serialises, all three have to move
 * together.
 */
export function storeBytesOf(value) {
  try {
    const serialized = JSON.stringify(value ?? null, null, 2)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8')
  } catch {
    /* Unserialisable means unstorable, so treat it as maximally expensive and
     * let it be shed first — jobTracker.jsonBytes reaches the same conclusion
     * the same way. */
    return Number.MAX_SAFE_INTEGER
  }
}

/*
 * What one manifest costs INSIDE the store, which is not what it costs alone.
 *
 * A ledger sits two levels down — store object, then `ledgers` array — so every
 * line of it gains the four spaces of that nesting, plus the comma and newline
 * separating it from the next. The second half of the same undercount: summing
 * records measured at the top level understates an array of many small records
 * by well over ten percent even once the indent is right.
 */
function nestedBytesOf(ledger) {
  const serialized = JSON.stringify(ledger ?? null, null, 2)
  if (serialized === undefined) return Number.MAX_SAFE_INTEGER
  return Buffer.byteLength(serialized, 'utf8') + 4 * serialized.split('\n').length + 2
}

/* The store as it will be written, with the counters at their widest so a budget
 * checked while they are small does not overrun once they grow. */
const envelope = (ledgers) => ({
  version: LEDGER_VERSION,
  droppedLedgers: Number.MAX_SAFE_INTEGER,
  droppedThrough: '0000-00-00T00:00:00.000Z',
  ledgers,
})

const sha256 = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex')

/* ------------------------------------------------------------ liveness */

/*
 * WHO IS DRIVING THIS RUN.
 *
 * A ledger is closed by the process that ran it, so the interesting failure —
 * the one this whole file exists for — is the process that cannot: killed,
 * panicked, or taken down with the machine. Nothing it left behind says "I am
 * gone", because saying so is exactly what it did not get to do.
 *
 * Stamping the owner turns that into an observable fact instead of an inference
 * from a clock. `pid` is checked with signal 0, which asks the kernel whether
 * the process exists and sends nothing. `host` is recorded because this store
 * lives in a workspace folder that may be synced between machines, and a pid
 * from another machine is a number that means nothing here.
 *
 * IT CAN ONLY EVER SAY "GONE" WHEN IT IS SURE. A recycled pid reads as alive, an
 * unstamped ledger (written before this field existed) reads as alive, and a
 * ledger from another host reads as alive — all of which fall through to the
 * staleness bound rather than producing a false "your run died". The reverse
 * mistake is the expensive one: telling the owner a run was abandoned while it
 * is still typing into their window.
 */
function ownerStamp() {
  return { pid: process.pid, host: os.hostname() }
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    /* EPERM means it exists and belongs to somebody else. Only ESRCH is death. */
    return error?.code === 'EPERM'
  }
}

function ownerIsGone(owner, { pid = process.pid, host = os.hostname(), isAlive = pidIsAlive } = {}) {
  if (!owner || !Number.isInteger(owner.pid)) return false
  if (owner.host && owner.host !== host) return false
  if (owner.pid === pid) return false
  return !isAlive(owner.pid)
}

/* ------------------------------------------------------------- identity */

/**
 * A fingerprint of the plan as a whole, so "is this the same plan I wrote down"
 * is answerable before anything is resumed against it.
 */
export function planKeyFor(actions) {
  const list = Array.isArray(actions) ? actions : []
  return `plan_${sha256(
    JSON.stringify(list.map((action) => ({ type: action?.type ?? '', params: action?.params ?? {} }))),
  ).slice(0, 16)}`
}

/**
 * Per-step idempotency keys.
 *
 * actionReceipts.actionIdFor is content-addressed, which is exactly right for
 * "has this exact step ever run" and exactly wrong for "which of these steps
 * am I looking at": two identical `press_keys` steps in one plan hash to the
 * same id, and the second one is precisely what a resume has to tell apart
 * from the first. The occurrence ordinal fixes that without giving up
 * stability — re-planning the same command produces the same actions in the
 * same order, so the same step gets the same key across runs, which is what
 * makes it an idempotency key rather than a row number.
 */
export function stepKeysFor(actions) {
  const seen = new Map()
  return (Array.isArray(actions) ? actions : []).map((action) => {
    const actionId = actionIdFor(action)
    const ordinal = seen.get(actionId) ?? 0
    seen.set(actionId, ordinal + 1)
    return { actionId, ordinal, stepKey: `${actionId}#${ordinal}` }
  })
}

/* ---------------------------------------------------------- sensitivity */

/**
 * What of a step's parameters may be written to disk.
 *
 * redaction.classifySensitivity is the project's one answer to "is this a
 * credential", and it is consulted here rather than at read time for a reason
 * this file cannot dodge: a manifest is a NEW durable copy of the plan. The
 * pendant hears "remember, the bike lock code is 4829" and a plan built from it
 * should not leave a second copy of that string in a second file.
 *
 * So a `secret` value is masked and the step is marked unreplayable. That is a
 * real loss of convenience — a write_file whose body happens to contain the
 * word "token:" can no longer be resumed automatically — and it is the correct
 * trade. The resume asks instead of replaying; it never silently does less.
 *
 * `sensitive` values (an email address, a phone number) are KEPT. A send_email
 * that cannot name its recipient cannot be resumed at all, and the same string
 * is already in the job store's `command` next door — the rule is "do not open
 * a new hole", not "be stricter than the file beside you and useless with it".
 */
export function persistableParams(rawParams) {
  const withheld = []
  const sensitiveKeys = []

  const walk = (value, trail, depth) => {
    if (depth > MAX_PARAM_DEPTH) return value
    if (Array.isArray(value)) {
      return value.map((entry, index) => walk(entry, [...trail, index], depth + 1))
    }
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, entry] of Object.entries(value)) {
        out[key] = walk(entry, [...trail, key], depth + 1)
      }
      return out
    }
    if (typeof value !== 'string' || !value) return value

    const label = classifySensitivity(value)
    const name = trail.join('.') || '(value)'
    if (label === 'secret') {
      withheld.push(name)
      return maskSecretValue(value)
    }
    if (label === 'sensitive') sensitiveKeys.push(name)
    return value
  }

  /* Image bytes never reach a store that persists — the same strip the job
   * store, the session store and the cloud upload all do, at the same boundary
   * and with the same function. A base64 screenshot in a manifest would blow
   * the byte budget on step one. */
  const params = walk(stripImageBytes(rawParams ?? {}), [], 0)

  return {
    params,
    withheld,
    sensitiveKeys,
    sensitivity: withheld.length ? 'secret' : sensitiveKeys.length ? 'sensitive' : 'normal',
  }
}

/**
 * The parts of a step's intent that must survive its parameters being withheld
 * or shed. A hash is thirty-two bytes and answers "did this land"; the body it
 * was taken over may be a megabyte we decline to keep.
 */
function intentOf(action) {
  const type = String(action?.type ?? '')
  if (type === 'write_file' && typeof action?.params?.content === 'string') {
    return { contentSha256: sha256(action.params.content), contentBytes: Buffer.byteLength(action.params.content) }
  }
  return null
}

/* ------------------------------------------------------------- manifest */

function buildStep(action, seq, key, now) {
  const type = String(action?.type ?? '')
  /* Every label below comes from a module that already owns the question.
   * foreseeAction is the same derivation the receipt will use after the fact,
   * which is what keeps the manifest line and the history line describing the
   * same action in the same words. */
  const foresight = foreseeAction(action)
  const approval = classifyAction(action)
  const scrubbed = persistableParams(action?.params)

  return {
    seq,
    stepKey: key.stepKey,
    actionId: key.actionId,
    type,
    label: foresight.label,
    effect: foresight.effect,
    touches: foresight.touches,
    reversible: foresight.reversible,
    reversedBy: foresight.reversedBy,
    irreversibleReason: foresight.irreversibleReason,
    /* Where the damage lands if this one is wrong, and what a second run of it
     * would do. Neither is derivable from the other, and the resume turns on
     * the second one. */
    riskTier: riskTierFor(action, {
      effect: foresight.effect,
      reversible: foresight.reversible,
    }),
    replaySafety: replaySafetyFor(type),
    needsApproval: !approval.safe,
    approvalReason: approval.safe ? null : (approval.reason ?? null),
    sensitivity: scrubbed.sensitivity,
    withheldParams: scrubbed.withheld,
    sensitiveParams: scrubbed.sensitiveKeys,
    intent: intentOf(action),
    params: scrubbed.params,
    preState: capturePreState(action, { now }),
    resumable: scrubbed.withheld.length === 0,
    notResumableReason: scrubbed.withheld.length
      ? `Its ${scrubbed.withheld.join(', ')} parameter(s) were classified as secret and were not written to the ledger, so this step cannot be replayed from this record.`
      : null,
    phase: 'pending',
    startedAt: null,
    finishedAt: null,
    ok: null,
    status: null,
    message: null,
    receiptId: null,
    postState: null,
  }
}

function summarizeRisk(steps) {
  const tiers = {}
  for (const step of steps) tiers[step.riskTier] = (tiers[step.riskTier] ?? 0) + 1
  return {
    tiers,
    steps: steps.length,
    writes: steps.filter((step) => step.effect === 'write').length,
    needsApproval: steps.filter((step) => step.needsApproval).length,
    irreversible: steps.filter((step) => step.reversible === false).length,
    /* The steps a resume would have to ask about if this run were interrupted,
     * known before it starts. This is the number worth showing on an approval
     * screen: not "is this risky" but "if this dies halfway, how much of it
     * will I have to sort out by hand". */
    unverifiableOnResume: steps.filter(
      (step) =>
        step.effect === 'write' &&
        step.replaySafety !== 'idempotent' &&
        step.preState?.kind === 'unobservable',
    ).length,
  }
}

/**
 * Write the manifest. Returns it; nothing has run.
 *
 * This is the "prepare" half of the prepare/approve split two agents asked for
 * independently — a durable, addressable description of a plan that has not
 * executed, which an approval can point at later from a device with no screen.
 * The "approve" half is the existing /execute path taking these actions. This
 * module deliberately owns neither the approval nor the execution.
 */
export function openLedger({
  command = '',
  actions = [],
  jobId = null,
  sessionId = null,
  source = 'local',
  title = null,
  now = Date.now(),
  filePath = ledgerLocation(),
  maxStoreBytes = MAX_STORE_BYTES,
  maxLedgerBytes = MAX_LEDGER_BYTES,
} = {}) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) throw new Error('A plan manifest needs at least one action.')

  const keys = stepKeysFor(list)
  const steps = list.map((action, seq) => buildStep(action, seq, keys[seq], now))
  const at = new Date(now).toISOString()

  const manifest = {
    version: LEDGER_VERSION,
    ledgerId: `ldg_${crypto.randomUUID()}`,
    planKey: planKeyFor(list),
    jobId,
    sessionId,
    source,
    command: String(command ?? ''),
    title: title ? String(title) : null,
    status: 'open',
    /* The process that will close this. Read back by interruptedLedgers() to
     * tell a run nobody is driving from one that is simply slow. */
    owner: ownerStamp(),
    createdAt: at,
    updatedAt: at,
    closedAt: null,
    outcome: null,
    risk: summarizeRisk(steps),
    steps,
  }

  const store = load(filePath)
  /* Return what was PERSISTED, not what was built. A manifest over the byte
   * budget is compacted on the way to disk, and a caller holding the fat
   * in-memory version would be reading fields the resume will never see. The
   * new ledger is open and newest, so pruneLedgers ranks it first and it
   * survives its own write. */
  const written = save(
    { ...store, ledgers: [manifest, ...store.ledgers] },
    filePath,
    { maxStoreBytes, maxLedgerBytes },
  )
  return written.ledgers.find((entry) => entry?.ledgerId === manifest.ledgerId) ?? manifest
}

function mutate(ledgerId, filePath, change, budget = {}) {
  const store = load(filePath)
  const index = store.ledgers.findIndex((entry) => entry?.ledgerId === ledgerId)
  if (index === -1) return null

  const updated = change(store.ledgers[index])
  if (!updated) return null

  const ledgers = [...store.ledgers]
  ledgers[index] = updated
  const written = save({ ...store, ledgers }, filePath, budget)
  return written.ledgers.find((entry) => entry?.ledgerId === ledgerId) ?? null
}

function withStep(manifest, stepKey, change, now) {
  const index = manifest.steps.findIndex((step) => step?.stepKey === stepKey)
  if (index === -1) return null
  const steps = [...manifest.steps]
  steps[index] = change(steps[index])
  return { ...manifest, steps, updatedAt: new Date(now).toISOString() }
}

/**
 * "About to dispatch." MUST be durable before the executor sees the action —
 * see the ordering invariant at the top of this file.
 */
export function markStepStarted(
  ledgerId,
  stepKey,
  { now = Date.now(), filePath = ledgerLocation(), ...budget } = {},
) {
  return mutate(
    ledgerId,
    filePath,
    (manifest) =>
      withStep(
        manifest,
        stepKey,
        (step) => ({ ...step, phase: 'inflight', startedAt: new Date(now).toISOString() }),
        now,
      ),
    budget,
  )
}

/**
 * "It answered." The post-state is captured here rather than derived later
 * because the filesystem moves on: by the time a resume runs, another program
 * may have touched the same file, and a reading taken now is the only one that
 * describes what THIS step left behind.
 */
export function settleStep(
  ledgerId,
  stepKey,
  { result = null, receipt = null, now = Date.now(), filePath = ledgerLocation(), ...budget } = {},
) {
  return mutate(
    ledgerId,
    filePath,
    (manifest) =>
      withStep(
        manifest,
        stepKey,
        (step) => ({
        ...step,
        phase: 'done',
        finishedAt: new Date(now).toISOString(),
        ok: result?.ok !== false,
        status: String(result?.status ?? (result?.ok === false ? 'failed' : 'success')),
        message: truncate(result?.message ?? result?.error ?? result?.reason ?? null),
        /* The join back to the record that already exists. The receipt, the
         * job, the journal entry and the undo verdict all hang off this id;
         * copying any of their contents in here would be a second copy waiting
         * to disagree with the first. */
          receiptId: receipt?.receiptId ?? result?.receipt?.receiptId ?? null,
          postState: capturePreState({ type: step.type, params: step.params ?? {} }, { now }),
        }),
        now,
      ),
    budget,
  )
}

/*
 * The statuses a run can end in. All of them mean the same thing to
 * interruptedLedgers() — a process was still alive to say what happened — and
 * they differ only in WHAT it said. `abandoned` is the odd one: it is a close
 * performed on behalf of a run by something that outlived it, and it is
 * deliberately not reachable from the run itself.
 */
export const TERMINAL_STATUSES = ['settled', 'failed', 'blocked', 'cancelled', 'abandoned']

/**
 * Say that the run is over, whatever "over" turned out to mean.
 *
 * THIS IS NOT OPTIONAL AND IT IS NOT A SUCCESS PATH. Every terminating branch of
 * an execution — returned, threw, was cancelled — has to reach this, because the
 * only thing distinguishing "finished" from "died" in this store is whether
 * anybody came back to write it down. For eight months nothing on the /execute
 * path did, and `GET /ledger/interrupted` answered with every plan ever run.
 *
 * It does NOT touch the steps. A run closed while a step is still `inflight`
 * keeps that step inflight: the process knows it stopped, and it still does not
 * know whether the step landed. Marking it settled to tidy the record would be
 * inventing the one fact the resume exists to establish.
 */
export function closeLedger(
  ledgerId,
  { status = 'settled', outcome = null, now = Date.now(), filePath = ledgerLocation(), ...budget } = {},
) {
  return mutate(
    ledgerId,
    filePath,
    (manifest) => ({
      ...manifest,
      status,
      outcome: outcome ? truncate(String(outcome)) : null,
      closedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }),
    budget,
  )
}

/* ---------------------------------------------------------------- reads */

export function getLedger(ledgerId, { filePath = ledgerLocation() } = {}) {
  return load(filePath).ledgers.find((entry) => entry?.ledgerId === ledgerId) ?? null
}

export function listLedgers({ filePath = ledgerLocation(), limit = 20, status = null } = {}) {
  const store = load(filePath)
  const matched = store.ledgers.filter((entry) => !status || entry?.status === status)
  return {
    ok: true,
    storePath: filePath,
    budget: {
      maxStoreBytes: MAX_STORE_BYTES,
      maxLedgerBytes: MAX_LEDGER_BYTES,
      usedBytes: storeBytesOf(store),
      note: 'Measured with the same indentation atomicJsonStore writes, so this is the size of the file rather than a proxy for it.',
    },
    /* Said out loud rather than left as a silent gap: a bounded store drops
     * things, and a reader who does not know that reads an absence as "the
     * agent never did it". */
    dropped: { ledgers: store.droppedLedgers ?? 0, through: store.droppedThrough ?? null },
    total: matched.length,
    ledgers: matched.slice(0, Math.max(1, Number(limit) || 20)).map(summarizeLedger),
  }
}

/**
 * The runs that started and never came back.
 *
 * WHAT "INTERRUPTED" MEANS HERE, and why it is not simply "open".
 *
 * The first cut of this function was `status === 'open' || some step inflight`,
 * which is the right instinct and the wrong predicate, for two separate reasons
 * that both produce the same symptom — an answer that is 100% noise, in which
 * the one genuinely abandoned run is invisible among every plan ever run.
 *
 *   1. NOT EVERY OPEN LEDGER IS A RUN. POST /ledger, /prepare and the
 *      form-preview submit manifest all write a plan and deliberately do not
 *      execute it; that is the entire point of the prepare/approve split. Those
 *      manifests sit open for as long as the owner takes to answer, which is
 *      expected to be half an hour. A plan awaiting approval is not a crashed
 *      run, and calling it one puts a resume prompt in front of the owner for
 *      something that has not happened yet. So a ledger only qualifies once
 *      something was DISPATCHED — at least one step out of `pending`. The
 *      ordering invariant at the top of this file is what makes that readable:
 *      a step is marked started before the executor sees it, so "nothing left
 *      pending" is a durable fact rather than an inference.
 *
 *   2. AN OPEN LEDGER MAY BE A RUN THAT IS STILL RUNNING. This is the whole
 *      difficulty. The process that dies cannot say so, so absence of a close is
 *      ambiguous between "died" and "still working", and a definition that
 *      resolves that ambiguity by calling every crashed run interrupted forever
 *      is exactly as useless as one that calls none of them.
 *
 * So the run must also be UNATTENDED, established two ways, strongest first:
 *
 *   owner-gone   the manifest names the process that opened it, and that pid is
 *                not there any more. This is a fact, not a timeout: the run is
 *                reported the instant the agent restarts after a kill, with no
 *                waiting period at all. See ownerStamp().
 *   went-cold    the pid reads as alive — or could not be judged at all, being
 *                recycled, on another host, or written before owners were
 *                stamped — AND the file has not been touched for
 *                INTERRUPTED_AFTER_MS. Every step transition fsyncs this store,
 *                so silence is the only remaining evidence, and it also catches
 *                the case a pid cannot: a live agent process that dropped a run
 *                on the floor. This half is a heuristic and is labelled as one
 *                on every row it produces.
 *
 * `unresolved` is the signal the old predicate's second clause was really about,
 * kept rather than dropped. A run whose process DID come back and close the
 * ledger, but which left a step marked in flight, is not interrupted — somebody
 * was there to say what happened — yet nothing knows whether that step landed,
 * and it is the same resume question. It is reported separately because merging
 * the two is how "interrupted" stopped meaning anything.
 *
 * Everything excluded is counted, not silently dropped: a reader who asks this
 * question and gets `0` deserves to see that three runs are alive and two plans
 * are waiting for them.
 */
export function interruptedLedgers({
  filePath = ledgerLocation(),
  now = Date.now(),
  staleAfterMs = INTERRUPTED_AFTER_MS,
  isAlive = pidIsAlive,
} = {}) {
  const store = load(filePath)

  const interrupted = []
  const unresolved = []
  const excluded = { running: 0, prepared: 0, closed: 0 }

  for (const manifest of store.ledgers) {
    const steps = Array.isArray(manifest?.steps) ? manifest.steps : []
    const inflight = steps.some((step) => step?.phase === 'inflight')

    if (manifest?.status !== 'open') {
      excluded.closed += 1
      if (inflight) {
        unresolved.push({
          ...summarizeLedger(manifest),
          why: 'closed-with-a-step-in-flight',
          detail:
            'The process closed this run, so it was alive to say what happened — but a step it dispatched never answered, and nothing here knows whether it landed.',
        })
      }
      continue
    }

    if (!steps.some((step) => step?.phase !== 'pending')) {
      excluded.prepared += 1
      continue
    }

    const quietForMs = Math.max(0, now - (timeOf(manifest?.updatedAt) || timeOf(manifest?.createdAt)))
    const gone = ownerIsGone(manifest?.owner, { isAlive })
    const cold = quietForMs > staleAfterMs

    if (!gone && !cold) {
      excluded.running += 1
      continue
    }

    interrupted.push({
      ...summarizeLedger(manifest),
      why: gone ? 'owner-gone' : 'went-cold',
      quietForMs,
      detail: gone
        ? `The process that opened this run (pid ${manifest.owner.pid}) is no longer running, and it never closed the ledger.`
        : `Nothing has touched this record for ${Math.round(quietForMs / 1000)}s. Every step transition rewrites this file, so a run this quiet is not being driven — though a pid that could not be checked is why this is a judgement rather than an observation.`,
    })
  }

  return {
    ok: true,
    readOnly: true,
    at: new Date(now).toISOString(),
    staleAfterMs,
    count: interrupted.length,
    note: 'A run is interrupted when it dispatched a step and then stopped existing: the process that opened it is gone, or the record went quiet for longer than a live run ever does. A plan nobody has dispatched is prepared, not interrupted, and a run that is still writing is still running.',
    ledgers: interrupted,
    /* Closed, and still carrying a step that never answered. Same resume
     * question, different reason — see the note above. */
    unresolved,
    excluded,
  }
}

function summarizeLedger(manifest) {
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : []
  return {
    ledgerId: manifest?.ledgerId ?? null,
    planKey: manifest?.planKey ?? null,
    jobId: manifest?.jobId ?? null,
    sessionId: manifest?.sessionId ?? null,
    command: manifest?.command ?? '',
    title: manifest?.title ?? null,
    status: manifest?.status ?? null,
    createdAt: manifest?.createdAt ?? null,
    updatedAt: manifest?.updatedAt ?? null,
    closedAt: manifest?.closedAt ?? null,
    risk: manifest?.risk ?? null,
    compacted: manifest?.compacted ?? null,
    progress: {
      steps: steps.length,
      done: steps.filter((step) => step.phase === 'done').length,
      failed: steps.filter((step) => step.phase === 'done' && step.ok === false).length,
      inflight: steps.filter((step) => step.phase === 'inflight').length,
      pending: steps.filter((step) => step.phase === 'pending').length,
    },
  }
}

/**
 * A manifest as it may be read back over HTTP.
 *
 * `params` are dropped rather than masked. `touches` already names what each
 * step acts on, truncated, via the same derivation the receipt uses — which is
 * what a reader actually needs — and a masked parameter blob is a standing
 * invitation to widen it later. The one path that returns real parameters is
 * the resume plan's `runnable`, because those are actions destined for
 * /execute, which is where they came from.
 */
export function presentLedger(manifest) {
  if (!manifest) return null
  return {
    ...summarizeLedger(manifest),
    steps: (manifest.steps ?? []).map((step) => ({
      seq: step.seq,
      stepKey: step.stepKey,
      actionId: step.actionId,
      type: step.type,
      label: step.label,
      effect: step.effect,
      riskTier: step.riskTier,
      replaySafety: step.replaySafety,
      needsApproval: step.needsApproval,
      approvalReason: step.approvalReason,
      reversible: step.reversible,
      reversedBy: step.reversedBy,
      irreversibleReason: step.irreversibleReason,
      touches: step.touches ?? [],
      sensitivity: step.sensitivity,
      withheldParams: step.withheldParams ?? [],
      sensitiveParams: step.sensitiveParams ?? [],
      paramKeys: step.params ? Object.keys(step.params) : [],
      paramsElided: step.paramsElided ?? null,
      resumable: step.resumable,
      notResumableReason: step.notResumableReason,
      preStateKind: step.preState?.kind ?? null,
      preStateWhy: step.preState?.why ?? null,
      phase: step.phase,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      ok: step.ok,
      status: step.status,
      message: step.message,
      receiptId: step.receiptId,
    })),
  }
}

/** The resume plan for one ledger. Reads the filesystem; runs nothing. */
export function resumeLedger(ledgerId, { filePath = ledgerLocation(), now = Date.now() } = {}) {
  const manifest = getLedger(ledgerId, { filePath })
  if (!manifest) return null
  return planResume(manifest, { now })
}

/* ------------------------------------------------------------ observing */

/**
 * An `onStep` callback for focusCoordinator.runFocusSafePlan, which the
 * orchestrator already passes one of.
 *
 * This is the whole integration surface, and it is why nothing in executor.js,
 * jobTracker.js or focusPolicy.js has to change: the execution path already
 * awaits a `start` notification before handing an action to the executor and a
 * `done` notification after, which is exactly the crash boundary the ledger
 * needs to straddle. Compose it with the existing callback; do not replace it.
 *
 * IT SWALLOWS ITS OWN FAILURES. A ledger write that throws must not stop the
 * owner's plan — observeBeforeAction in actionReceipts.js takes the same
 * position. The cost is a record with a hole in it, and planResume is built to
 * notice: a step recorded `pending` with a later step recorded as run is
 * reported as a gap and asked about rather than replayed.
 */
export function ledgerStepObserver(manifestOrId, { filePath = ledgerLocation() } = {}) {
  const ledgerId =
    typeof manifestOrId === 'string' ? manifestOrId : (manifestOrId?.ledgerId ?? null)
  const source =
    typeof manifestOrId === 'string' ? getLedger(manifestOrId, { filePath }) : manifestOrId
  const keysBySeq = new Map(
    (source?.steps ?? []).map((step) => [step.seq, step.stepKey]),
  )

  return async ({ phase, seq, result } = {}) => {
    if (!ledgerId) return
    try {
      const stepKey = keysBySeq.get(seq)
      if (!stepKey) return
      if (phase === 'start') {
        markStepStarted(ledgerId, stepKey, { filePath })
        return
      }
      settleStep(ledgerId, stepKey, { result, filePath })
    } catch {
      // See the note above: bookkeeping never stops the work.
    }
  }
}

/* -------------------------------------------------------------- bounding */

function shedStepField(step, field, bytes) {
  const marker = { elided: `${field} exceeded the ledger byte budget`, bytes }

  if (field === 'params') {
    return {
      ...step,
      params: null,
      paramsElided: marker,
      resumable: false,
      notResumableReason:
        'Its parameters were shed to keep the ledger inside its byte budget, so it cannot be replayed from this record. Its intent hash was kept, so whether it landed can still be checked.',
    }
  }

  if (field === 'preState') {
    return {
      ...step,
      preState: {
        kind: 'unobservable',
        why: 'The pre-state capture was shed to keep the ledger inside its byte budget, so there is nothing left to compare against.',
      },
      preStateElided: marker,
    }
  }

  return { ...step, [field]: field === 'touches' ? [] : null, [`${field}Elided`]: marker }
}

/**
 * Shrink one manifest to its budget by shedding its largest step fields.
 *
 * Lossy, and it says so at the field it lost — a reader can tell an absent
 * value from an elided one, and a step whose parameters went is marked
 * unreplayable rather than quietly replayed as an empty action. jobTracker's
 * compactJobForStore does the same thing to a job's result, for the same
 * reason, and neither of them keeps a list of field NAMES to protect: fields
 * grow fat for reasons nobody predicts, so the rule is "a record has a size".
 */
export function compactLedgerForStore(ledger, { maxBytes = MAX_LEDGER_BYTES } = {}) {
  if (nestedBytesOf(ledger) <= maxBytes) return ledger

  let steps = Array.isArray(ledger?.steps) ? [...ledger.steps] : []
  const shed = []

  for (const field of SHED_ORDER) {
    if (nestedBytesOf({ ...ledger, steps }) <= maxBytes) break

    const ranked = steps
      .map((step, index) => ({ index, bytes: storeBytesOf(step?.[field]) }))
      .filter((entry) => entry.bytes > 0)
      .sort((left, right) => right.bytes - left.bytes)

    for (const { index, bytes } of ranked) {
      if (nestedBytesOf({ ...ledger, steps }) <= maxBytes) break
      steps[index] = shedStepField(steps[index], field, bytes)
      if (!shed.includes(field)) shed.push(field)
    }
  }

  return { ...ledger, steps, compacted: shed.length ? shed : null }
}

const timeOf = (value) => {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Fit the whole store inside its byte budget.
 *
 * Open ledgers are kept ahead of settled ones — an unfinished run is the only
 * record here that anything still needs — but they are NOT exempt. An exemption
 * is how a bounded store becomes an unbounded one: a hundred abandoned runs
 * would each be "the one we must keep". They compete on the same budget, and
 * what falls off is counted and dated in the store rather than vanishing.
 */
export function pruneLedgers(
  ledgers,
  { maxStoreBytes = MAX_STORE_BYTES, maxLedgerBytes = MAX_LEDGER_BYTES } = {},
) {
  const compacted = (Array.isArray(ledgers) ? ledgers : []).map((ledger) =>
    compactLedgerForStore(ledger, { maxBytes: maxLedgerBytes }),
  )

  const ranked = [...compacted].sort(
    (left, right) =>
      (left?.status === 'open' ? 0 : 1) - (right?.status === 'open' ? 0 : 1) ||
      timeOf(right?.createdAt) - timeOf(left?.createdAt),
  )

  const kept = []
  const dropped = []
  /* The store is more than its ledgers — the version and the drop counters are
   * written too — so the envelope is priced before anything is admitted.
   * Charging only for records is how a byte budget quietly overruns its file. */
  let used = storeBytesOf(envelope([]))

  for (const ledger of ranked) {
    const bytes = nestedBytesOf(ledger)
    if (used + bytes <= maxStoreBytes) {
      kept.push(ledger)
      used += bytes
    } else {
      dropped.push(ledger)
    }
  }

  /*
   * Then verify, because the pass above is an estimate.
   *
   * It is a close estimate and it is not a guarantee, and the difference is the
   * whole bug: a budget checked with a different serializer than the writer uses
   * is not a bound. So the loop below measures the store AS IT WILL BE WRITTEN
   * and drops from the tail — the lowest-ranked ledger — until it genuinely
   * fits. `kept` is still in rank order here, which is what makes popping the
   * right end of it the right thing to drop. It runs a handful of times at most.
   */
  while (kept.length && storeBytesOf(envelope(kept)) > maxStoreBytes) {
    dropped.push(kept.pop())
  }
  used = storeBytesOf(envelope(kept))

  kept.sort((left, right) => timeOf(right?.createdAt) - timeOf(left?.createdAt))

  return {
    ledgers: kept,
    bytes: used,
    dropped: dropped.length,
    droppedThrough: dropped.length
      ? dropped.map((ledger) => ledger?.createdAt ?? null).filter(Boolean).sort().pop()
      : null,
  }
}

function truncate(value, max = 400) {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}
