import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { workspacePath } from './config.js'
import { linkedCapsuleIds } from './evidenceCapsules.js'
import { resolveUserPath } from './security.js'
import { annotateInputReachability, getInputReachability } from './inputReachability.js'

/*
 * A receipt for every executed action: what it touched, and whether it can be
 * taken back.
 *
 * The agent had full control of the Mac and no record of what it had actually
 * done. A job stored a summary string; undo.js re-derived reversibility from
 * whatever fields the handler happened to return, and got it wrong in the one
 * case that costs data — write_file over an existing file was treated as
 * "reversible" and undone by DELETING the file, destroying content the agent
 * never wrote.
 *
 * Nothing here can refuse an action. observeBeforeAction() runs before the
 * executor dispatches, records what is about to be touched, and returns; if it
 * throws, the action still runs. It is a camera, not a gate.
 *
 * The snapshot vault is what turns "you can see it" into "you can undo it":
 * a bounded copy of a file about to be overwritten or deleted, so undo can
 * restore instead of guess.
 */

const UNDO_VAULT = path.join(workspacePath, '.undo')

/* A snapshot is a safety net, not a backup system. Anything larger is
 * recorded as irreversible with the reason, which is more honest than a
 * silent half-copy. */
export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024

/* Actions that only observe. Split out so a receipt can say "read" without
 * every caller re-deriving it from the type name. */
const READ_ONLY_TYPES = new Set([
  'read_file',
  'list_directory',
  'search_file',
  'get_clipboard',
  'get_brightness',
  'get_volume',
  'get_battery',
  'get_mac_status',
  'get_weather',
  'get_time',
  'get_input_source',
  'translate_text',
  'screenshot',
  'zoom',
  'cursor_position',
  'list_displays',
  'check_input_permissions',
  'ui_snapshot',
  'ui_find',
  'ui_wait_for',
  'ui_hit_test',
  'browser_read_page',
  'browser_snapshot',
  'browser_list_tabs',
  'browser_capture',
  'browser_wait_for',
  'browser_list_sessions',
])

/*
 * Type-level reversibility, for the capability manifest — before any action
 * has run there is nothing to inspect, so this answers "could this ever be
 * undone", not "can this one be undone". describeReversibility() answers the
 * second question from a real result.
 */
const REVERSIBILITY = {
  set_brightness: { reversible: 'conditional', reversedBy: 'set_brightness' },
  set_volume: { reversible: 'conditional', reversedBy: 'set_volume' },
  set_mute: { reversible: 'conditional', reversedBy: 'set_mute' },
  show_screen_overlay: { reversible: 'conditional', reversedBy: 'kill overlay process' },
  write_file: { reversible: 'conditional', reversedBy: 'restore snapshot or delete created file' },
  create_note: { reversible: 'conditional', reversedBy: 'delete created file' },
  delete_path: { reversible: 'conditional', reversedBy: 'restore snapshot' },
  copy_path: { reversible: 'conditional', reversedBy: 'remove the copy' },
  move_path: { reversible: 'conditional', reversedBy: 'move it back' },
  open_app: { reversible: 'always', reversedBy: 'close the front window' },
  open_url: { reversible: 'always', reversedBy: 'close the front window' },
  open_path: { reversible: 'always', reversedBy: 'close the front window' },
  open_folder: { reversible: 'always', reversedBy: 'close the front window' },
}

/* Params that name something outside the agent, so a receipt can list what was
 * touched without a per-type table for all 70+ action types. Types whose
 * params mean something else are corrected in TOUCH_OVERRIDES. */
const PARAM_TOUCH_KINDS = {
  path: 'path',
  from: 'path',
  to: 'path',
  root: 'path',
  cwd: 'path',
  filename: 'path',
  url: 'url',
  appName: 'app',
  application: 'app',
  command: 'shell',
  script: 'applescript',
  session: 'browser-session',
  sessionId: 'browser-session',
  query: 'query',
  title: 'title',
}

const TOUCH_OVERRIDES = {
  send_email: (action) => [
    { kind: 'email-recipient', ref: String(action?.params?.to ?? '') },
    { kind: 'email-subject', ref: String(action?.params?.subject ?? '') },
  ],
  create_reminder: (action) => [
    { kind: 'reminder', ref: String(action?.params?.title ?? action?.params?.name ?? '') },
  ],
  copy_to_clipboard: () => [{ kind: 'clipboard', ref: 'system clipboard' }],
  set_clipboard: () => [{ kind: 'clipboard', ref: 'system clipboard' }],
  type_text: (action) => [
    { kind: 'keyboard', ref: `${String(action?.params?.text ?? '').length} characters into the frontmost app` },
  ],
  press_keys: (action) => [
    { kind: 'keyboard', ref: String(action?.params?.keys ?? '') },
  ],
  set_volume: () => [{ kind: 'audio-output', ref: 'system output volume' }],
  set_mute: () => [{ kind: 'audio-output', ref: 'system output mute' }],
  set_brightness: () => [{ kind: 'display', ref: 'main display brightness' }],
}

export function undoVaultLocation() {
  return UNDO_VAULT
}

export function staticReversibility(type) {
  return (
    REVERSIBILITY[type] ?? {
      reversible: READ_ONLY_TYPES.has(type) ? 'not-needed' : 'never',
      reversedBy: null,
    }
  )
}

/**
 * Content-addressed so the same step in a re-run of the same plan carries the
 * same id. The orchestrator hands the executor one action at a time, so a
 * positional index would not be stable across a retry — the content is.
 */
export function actionIdFor(action) {
  const digest = crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        type: String(action?.type ?? ''),
        params: action?.params ?? {},
      }),
    )
    .digest('hex')
  return `act_${digest.slice(0, 12)}`
}

/**
 * Record what is about to be touched. Runs before dispatch, never blocks, and
 * swallows every error: a failure to observe must not stop the owner's work.
 */
export function observeBeforeAction(action) {
  const type = String(action?.type ?? '')
  const observedAt = new Date().toISOString()

  try {
    switch (type) {
      case 'write_file':
      case 'create_note':
        return { observedAt, target: snapshotTarget(action?.params?.path) }
      case 'delete_path':
        return { observedAt, target: snapshotTarget(action?.params?.path) }
      case 'copy_path':
      case 'move_path':
        return {
          observedAt,
          // Only the destination can be clobbered; the source is either copied
          // (untouched) or renamed (recorded in the receipt for the move back).
          target: snapshotTarget(action?.params?.to),
          source: String(action?.params?.from ?? ''),
        }
      default:
        return { observedAt }
    }
  } catch (error) {
    return { observedAt, observeError: String(error?.message ?? error) }
  }
}

function snapshotTarget(rawPath) {
  const requested = String(rawPath ?? '')
  if (!requested) return null

  let resolved
  try {
    resolved = resolveUserPath(requested)
  } catch {
    return { path: requested, existed: false, unresolved: true }
  }

  let stats
  try {
    stats = fs.statSync(resolved)
  } catch {
    return { path: resolved, existed: false }
  }

  if (stats.isDirectory()) {
    return {
      path: resolved,
      existed: true,
      directory: true,
      snapshotPath: null,
      snapshotSkipped: 'directory',
    }
  }

  if (stats.size > SNAPSHOT_MAX_BYTES) {
    return {
      path: resolved,
      existed: true,
      bytes: stats.size,
      snapshotPath: null,
      snapshotSkipped: `larger than ${SNAPSHOT_MAX_BYTES} bytes`,
    }
  }

  try {
    fs.mkdirSync(UNDO_VAULT, { recursive: true })
    const snapshotPath = path.join(
      UNDO_VAULT,
      `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${path.basename(resolved)}`,
    )
    fs.copyFileSync(resolved, snapshotPath)
    return { path: resolved, existed: true, bytes: stats.size, snapshotPath }
  } catch (error) {
    return {
      path: resolved,
      existed: true,
      bytes: stats.size,
      snapshotPath: null,
      snapshotSkipped: String(error?.message ?? error),
    }
  }
}

/**
 * Can this specific result be taken back, and by what?
 *
 * Reads the receipt when the result carries one and falls back to the raw
 * result fields, because pendant-jobs.json holds jobs recorded before receipts
 * existed and those must still be undoable.
 */
export function describeReversibility(result) {
  const type = String(result?.action?.type ?? '')

  if (result?.receipt?.reversible !== undefined) {
    return {
      reversible: Boolean(result.receipt.reversible),
      mechanism: result.receipt.reversedBy ?? null,
      reason: result.receipt.irreversibleReason ?? null,
    }
  }

  switch (type) {
    case 'set_brightness':
      return verdict(Number.isFinite(Number(result.before)), 'set_brightness')
    case 'set_volume':
      return verdict(
        Number.isFinite(Number(result.before?.percent ?? result.before)),
        'set_volume',
      )
    case 'set_mute':
      return verdict(
        typeof result.before?.muted === 'boolean' ||
          typeof result.before === 'boolean',
        'set_mute',
      )
    case 'show_screen_overlay':
      return verdict(Boolean(result.pid), 'kill overlay process')
    case 'write_file':
    case 'create_note':
      return verdict(
        Boolean(result.path || result.action?.params?.path),
        'delete created file',
      )
    case 'copy_path':
      return verdict(Boolean(result.action?.params?.to), 'remove the copy')
    case 'move_path':
      return verdict(
        Boolean(result.action?.params?.from && result.action?.params?.to),
        'move it back',
      )
    case 'open_app':
    case 'open_url':
    case 'open_path':
    case 'open_folder':
      return verdict(true, 'close the front window')
    default:
      return {
        reversible: false,
        mechanism: null,
        reason: READ_ONLY_TYPES.has(type)
          ? 'Read-only: nothing to undo'
          : `${type || 'This action'} leaves no reversible trace`,
      }
  }
}

function verdict(reversible, mechanism) {
  return {
    reversible: Boolean(reversible),
    mechanism: reversible ? mechanism : null,
    reason: reversible ? null : 'The step did not record enough state to reverse it',
  }
}

/**
 * The receipt itself. Built for every action, successful or not — a failed
 * shell command may still have written half a file, and the owner needs to see
 * that it was attempted.
 */
export function buildActionReceipt({
  action,
  result,
  before = null,
  startedAt,
  finishedAt = new Date().toISOString(),
  /* Read at receipt time, not at read time: "were events reaching the screen
   * when this ran" is a different question from "are they now", and a receipt
   * that answers the second one is dated the moment it is opened. */
  reachability = getInputReachability(),
}) {
  const type = String(action?.type ?? '')
  const reversibility = reversibilityFromExecution(type, action, result, before)

  return {
    receiptId: `rcpt_${crypto.randomUUID()}`,
    actionId: actionIdFor(action),
    type,
    label: String(action?.label ?? '') || null,
    effect: READ_ONLY_TYPES.has(type) ? 'read' : 'write',
    ok: result?.ok !== false,
    status: String(result?.status ?? (result?.ok === false ? 'failed' : 'success')),
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    touched: describeTouched(action, result),
    snapshot: before?.target?.snapshotPath
      ? {
          of: before.target.path,
          at: before.target.snapshotPath,
          bytes: before.target.bytes ?? null,
        }
      : null,
    preexisting: before?.target
      ? {
          path: before.target.path,
          existed: Boolean(before.target.existed),
          directory: Boolean(before.target.directory),
          snapshotSkipped: before.target.snapshotSkipped ?? null,
        }
      : null,
    reversible: reversibility.reversible,
    reversedBy: reversibility.reversedBy,
    irreversibleReason: reversibility.irreversibleReason,
    /* Annotation only. A ui_click whose reachability is `failed` still ran and
     * still reports whatever the executor reported; this says the success may
     * not mean what it looks like. Null for steps that post nothing. */
    inputReachability: annotateInputReachability(type, reachability),
    evidence: describeEvidence(action, result),
  }
}

/**
 * Which evidence capsules this step stood on.
 *
 * Two sources, and the receipt says which answered. A browser reading carries
 * its capsule in the result, so the link is a fact. Everything else — the
 * write_file whose contents came off a logged-in page — is only linked when the
 * caller tagged the action, so an untagged step reports `unlinked` rather than
 * being quietly attributed to whatever capsule was minted most recently. A
 * guessed provenance is worse than none.
 */
function describeEvidence(action, result) {
  /*
   * The executor echoes the whole action back inside its result, so walking the
   * result as-is finds the caller's own `capsuleIds` again and reports a
   * declaration as if the extension had supplied it. Measured live: a tagged
   * copy_to_clipboard came back `result+declared` with nothing on the browser
   * side at all. Dropping the echo is what keeps `source` worth reading.
   */
  const { action: _echoed, ...observed } = result ?? {}
  const fromResult = linkedCapsuleIds(observed)
  const declared = linkedCapsuleIds({
    capsuleIds: action?.capsuleIds,
    params: { capsuleIds: action?.params?.capsuleIds },
    evidence: action?.evidence ?? null,
  })
  const capsuleIds = [...new Set([...fromResult, ...declared])]

  return {
    capsuleIds,
    source: fromResult.length
      ? declared.length
        ? 'result+declared'
        : 'result'
      : declared.length
        ? 'declared'
        : 'unlinked',
  }
}

function reversibilityFromExecution(type, action, result, before) {
  // A step that never ran changed nothing; there is nothing to reverse.
  if (result?.ok === false) {
    return {
      reversible: false,
      reversedBy: null,
      irreversibleReason: 'The step did not complete, so nothing was changed',
    }
  }

  const target = before?.target ?? null

  if (type === 'write_file' || type === 'create_note') {
    if (!target?.existed) {
      return {
        reversible: true,
        reversedBy: 'delete created file',
        irreversibleReason: null,
      }
    }
    if (target.snapshotPath) {
      return {
        reversible: true,
        reversedBy: 'restore snapshot',
        irreversibleReason: null,
      }
    }
    // The old undo answered "yes" here and then deleted a file it had only
    // overwritten. Saying no is the correct answer, not a smaller capability.
    return {
      reversible: false,
      reversedBy: null,
      irreversibleReason: `Overwrote an existing file that could not be snapshotted (${
        target.snapshotSkipped ?? 'unknown reason'
      })`,
    }
  }

  if (type === 'delete_path') {
    if (target?.snapshotPath) {
      return {
        reversible: true,
        reversedBy: 'restore snapshot',
        irreversibleReason: null,
      }
    }
    return {
      reversible: false,
      reversedBy: null,
      irreversibleReason: target?.directory
        ? 'Deleted a directory; only single files are snapshotted'
        : `No snapshot was taken (${target?.snapshotSkipped ?? 'file did not exist or was unreadable'})`,
    }
  }

  const verdictFromResult = describeReversibility({ ...result, action, receipt: undefined })
  return {
    reversible: verdictFromResult.reversible,
    reversedBy: verdictFromResult.mechanism,
    irreversibleReason: verdictFromResult.reversible ? null : verdictFromResult.reason,
  }
}

function describeTouched(action, result) {
  const type = String(action?.type ?? '')
  const override = TOUCH_OVERRIDES[type]
  const touched = override
    ? override(action, result).filter((entry) => entry.ref)
    : []

  if (!override) {
    for (const [key, kind] of Object.entries(PARAM_TOUCH_KINDS)) {
      const value = action?.params?.[key]
      if (value === undefined || value === null || value === '') continue
      touched.push({ kind, ref: truncate(String(value)) })
    }
  }

  // Handlers resolve ~ and relative paths themselves, so the executed path can
  // differ from the requested one. Record what was actually touched.
  if (result?.path && !touched.some((entry) => entry.ref === result.path)) {
    touched.push({ kind: 'path', ref: truncate(String(result.path)) })
  }
  if (result?.pid) {
    touched.push({ kind: 'process', ref: String(result.pid) })
  }
  if (result?.before !== undefined && result?.percent !== undefined) {
    touched.push({
      kind: 'setting',
      ref: type,
      before: result.before?.percent ?? result.before,
      after: result.percent,
    })
  }

  return touched
}

/**
 * Every receipt in a job, for the dashboard and for `GET /jobs/:id/receipts`.
 *
 * Jobs written before receipts existed are still in pendant-jobs.json, so one
 * is synthesized from the raw result rather than showing the owner a blank
 * history — flagged `synthesized` so nobody mistakes it for a real record of
 * what was touched.
 *
 * A synthesized receipt carries no `inputReachability`. That fact is only true
 * of the moment the step ran, and stamping today's measurement onto last
 * week's job would be exactly the invented measurement this field exists to
 * stop.
 */
export function receiptsForJob(job) {
  const results = Array.isArray(job?.result?.results)
    ? job.result.results
    : Array.isArray(job?.result?.sideResults)
      ? job.result.sideResults
      : []

  return results.map((item) => {
    if (item?.receipt) return item.receipt

    const verdict = describeReversibility(item)
    return {
      receiptId: null,
      synthesized: true,
      actionId: item?.action ? actionIdFor(item.action) : null,
      type: String(item?.action?.type ?? 'unknown'),
      label: String(item?.action?.label ?? '') || null,
      effect: READ_ONLY_TYPES.has(String(item?.action?.type ?? '')) ? 'read' : 'write',
      ok: item?.ok !== false,
      status: String(item?.status ?? ''),
      touched: describeTouched(item?.action ?? {}, item),
      snapshot: null,
      preexisting: null,
      reversible: verdict.reversible,
      reversedBy: verdict.mechanism,
      irreversibleReason: verdict.reason,
      /* Recoverable even for a pre-capsule job: the ids live in the stored
       * result, not in the receipt that was never written. */
      evidence: describeEvidence(item?.action ?? {}, item),
    }
  })
}

function truncate(value, max = 400) {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function durationBetween(startedAt, finishedAt) {
  const start = new Date(startedAt ?? 0).getTime()
  const end = new Date(finishedAt ?? 0).getTime()
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : null
}
