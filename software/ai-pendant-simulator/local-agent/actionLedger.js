import crypto from 'node:crypto'
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

function save(store, filePath) {
  const pruned = pruneLedgers(store.ledgers)
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

function jsonBytes(value) {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized)
  } catch {
    /* Unserialisable means unstorable, so treat it as maximally expensive and
     * let it be shed first — jobTracker.jsonBytes reaches the same conclusion
     * the same way. */
    return Number.MAX_SAFE_INTEGER
  }
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex')

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
  const written = save({ ...store, ledgers: [manifest, ...store.ledgers] }, filePath)
  return written.ledgers.find((entry) => entry?.ledgerId === manifest.ledgerId) ?? manifest
}

function mutate(ledgerId, filePath, change) {
  const store = load(filePath)
  const index = store.ledgers.findIndex((entry) => entry?.ledgerId === ledgerId)
  if (index === -1) return null

  const updated = change(store.ledgers[index])
  if (!updated) return null

  const ledgers = [...store.ledgers]
  ledgers[index] = updated
  const written = save({ ...store, ledgers }, filePath)
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
export function markStepStarted(ledgerId, stepKey, { now = Date.now(), filePath = ledgerLocation() } = {}) {
  return mutate(ledgerId, filePath, (manifest) =>
    withStep(
      manifest,
      stepKey,
      (step) => ({ ...step, phase: 'inflight', startedAt: new Date(now).toISOString() }),
      now,
    ),
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
  { result = null, receipt = null, now = Date.now(), filePath = ledgerLocation() } = {},
) {
  return mutate(ledgerId, filePath, (manifest) =>
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
  )
}

export function closeLedger(
  ledgerId,
  { status = 'settled', outcome = null, now = Date.now(), filePath = ledgerLocation() } = {},
) {
  return mutate(ledgerId, filePath, (manifest) => ({
    ...manifest,
    status,
    outcome: outcome ? truncate(String(outcome)) : null,
    closedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }))
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
    budget: { maxStoreBytes: MAX_STORE_BYTES, maxLedgerBytes: MAX_LEDGER_BYTES, usedBytes: jsonBytes(store) },
    /* Said out loud rather than left as a silent gap: a bounded store drops
     * things, and a reader who does not know that reads an absence as "the
     * agent never did it". */
    dropped: { ledgers: store.droppedLedgers ?? 0, through: store.droppedThrough ?? null },
    total: matched.length,
    ledgers: matched.slice(0, Math.max(1, Number(limit) || 20)).map(summarizeLedger),
  }
}

/**
 * The runs nobody closed.
 *
 * This is the entry point for "the last automation may have been interrupted".
 * A ledger is closed when the plan finishes, in the same process that ran it —
 * so a ledger still `open` at startup is, by construction, a run that did not
 * get to finish saying so.
 */
export function interruptedLedgers({ filePath = ledgerLocation() } = {}) {
  const store = load(filePath)
  const open = store.ledgers.filter(
    (entry) => entry?.status === 'open' || entry?.steps?.some((step) => step?.phase === 'inflight'),
  )
  return {
    ok: true,
    readOnly: true,
    count: open.length,
    note: 'A ledger is closed by the process that ran it. One still open is a run that did not get to finish saying so — it may simply be running right now.',
    ledgers: open.map(summarizeLedger),
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
  if (jsonBytes(ledger) <= maxBytes) return ledger

  let steps = Array.isArray(ledger?.steps) ? [...ledger.steps] : []
  const shed = []

  for (const field of SHED_ORDER) {
    if (jsonBytes({ ...ledger, steps }) <= maxBytes) break

    const ranked = steps
      .map((step, index) => ({ index, bytes: jsonBytes(step?.[field]) }))
      .filter((entry) => entry.bytes > 0)
      .sort((left, right) => right.bytes - left.bytes)

    for (const { index, bytes } of ranked) {
      if (jsonBytes({ ...ledger, steps }) <= maxBytes) break
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
  let used = 0

  for (const ledger of ranked) {
    const bytes = jsonBytes(ledger)
    if (used + bytes <= maxStoreBytes) {
      kept.push(ledger)
      used += bytes
    } else {
      dropped.push(ledger)
    }
  }

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
