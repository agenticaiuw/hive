import crypto from 'node:crypto'
import fs from 'node:fs'

import { resolveUserPath } from './security.js'

/*
 * "Did this step actually happen?" — asked after the fact, of a run that was
 * interrupted, by a process that was not there when it ran.
 *
 * This is the half of resume that has to be honest. Everything else in a
 * resumable executor is bookkeeping; the only question that can destroy the
 * owner's data is whether to run step 4 again, and the only wrong answer that
 * looks like success is "probably not, go ahead".
 *
 * The failure this is built against is already recorded in this codebase.
 * actionReceipts.js exists because undo.js answered "is this reversible?" by
 * re-deriving it from whatever fields a handler happened to return, decided a
 * write_file over an existing file was reversible, and undid it by DELETING the
 * file — destroying content the agent never wrote. That was a confident guess
 * where the honest answer was "I do not know." A resume that re-runs a
 * `move_path` whose source is already gone, or re-sends an email that already
 * went out, is the same mistake with a different verb.
 *
 * So the verdict vocabulary here has FIVE values, not two, and three of them
 * mean stop:
 *
 *   applied            — the end state matches this step's intent AND differs
 *                        from what was there before it. It ran.
 *   already-satisfied  — the end state matches the intent, but so did the
 *                        pre-state. Running it again is a no-op either way.
 *   not-applied        — the state is byte-identical to the pre-state capture.
 *                        Nothing happened. Safe to run.
 *   indeterminate      — something changed, but not into the shape this step
 *                        meant to produce. A half-written file and an edit by
 *                        another program look identical from here. ASK.
 *   unverifiable       — there is no local state to compare at all. A sent
 *                        email, a typed keystroke, a shell command. ASK.
 *
 * There is deliberately no sixth value meaning "probably fine".
 *
 * NOTHING HERE MUTATES. Every function reads the filesystem and returns a
 * description. It cannot run, skip, undo, or repair a step — it produces the
 * evidence a person or a caller decides on. actionReceipts.js, planPreview.js
 * and executionJournal.js each say a version of this about themselves; this
 * file is the same kind of thing and should keep agreeing with them.
 */

/* Hashing is a read, not a copy, so this sits well above the 8 MB snapshot cap
 * in actionReceipts.js — we are not duplicating the bytes, only walking them.
 * It is still a cap: a resume that stalls for a minute hashing a disk image has
 * turned "tell me what finished" into a hang, and a file we decline to hash is
 * reported `unverifiable` rather than assumed either way. */
export const PRE_STATE_HASH_MAX_BYTES = 32 * 1024 * 1024

/*
 * Replay safety: what happens if this step runs a SECOND time.
 *
 * This is a different axis from actionRisk.classifyAction (may it run without
 * approval) and from actionReceipts reversibility (can it be taken back), and
 * it is the one a resume actually turns on. `set_volume 40` twice is `set_volume
 * 40`. `send_email` twice is two emails. `move_path` twice fails, or worse,
 * moves the wrong thing back over itself.
 *
 * When a step is idempotent the verification above does not need to answer:
 * re-running converges on the same end state whether or not the first attempt
 * landed. That is what keeps a resume from asking twenty questions about the
 * twenty harmless steps in front of the one that matters.
 */
const IDEMPOTENT_TYPES = new Set([
  // Reads converge trivially.
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
  'browser_inspect',
  'sweep_folder_preview',
  'tidy_downloads_preview',
  'preview_plan',
  'recall_capture',
  // Absolute-value settings: the parameter is the end state, not a delta.
  'set_volume',
  'set_brightness',
  'set_mute',
  // The clipboard holds one value; writing it twice leaves one value.
  'set_clipboard',
  'copy_to_clipboard',
  // Opening the same thing again shows the same thing. This is the same
  // judgement actionRisk.js already makes when it lets open_url run hands-free
  // from a device with no screen to confirm on — being stricter here than the
  // first run was would be an odd place to start.
  'open_app',
  'open_url',
  'open_path',
  'open_folder',
  // Content-addressed by definition: the file ends up holding params.content.
  'write_file',
  // Re-copying over the copy reproduces the copy.
  'copy_path',
])

/* Running it again does not repeat the effect — it ADDS one. The second run is
 * not a repair, it is a duplicate, and no amount of filesystem inspection makes
 * that safe to do on a guess. */
const ADDITIVE_TYPES = new Set([
  'create_note',
  'create_reminder',
  'remind_me',
  'quick_capture',
  'send_email',
  'send_message',
  'show_screen_overlay',
  'run_project',
  'play_youtube',
])

/* Running it again is wrong, destructive, or lands somewhere nobody can name.
 * These are the steps a resume must verify or refuse. */
const UNREPEATABLE_TYPES = new Set([
  'delete_path',
  'move_path',
  'run_shell',
  'run_applescript',
  'computer_use_task',
  // Synthesized input goes into whatever is frontmost NOW, which is not
  // necessarily what was frontmost when the run was interrupted. focusPolicy
  // and focusCoordinator exist because that drift is real.
  'type_text',
  'press_keys',
  'mouse_click',
  'mouse_move',
  'scroll',
  'ui_click',
  'ui_menu',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press_key',
  'browser_scroll',
  'browser_navigate',
  'browser_inspect_act',
  'tidy_downloads_apply',
  'sweep_folder_apply',
  'sweep_folder_undo',
])

export function replaySafetyFor(type) {
  const name = String(type ?? '')
  if (IDEMPOTENT_TYPES.has(name)) return 'idempotent'
  if (ADDITIVE_TYPES.has(name)) return 'additive'
  if (UNREPEATABLE_TYPES.has(name)) return 'unrepeatable'
  return 'unknown'
}

/*
 * Where the damage would land if this step is wrong. Ordered most-contained to
 * least, and evaluated in reverse: a `run_shell` that happens to write a file
 * is not a "reversible write", it is a shell command.
 */
const OFF_MACHINE_TYPES = new Set([
  'send_email',
  'send_message',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press_key',
  'browser_navigate',
])

const UNCONTAINED_TYPES = new Set([
  'run_shell',
  'run_project',
  'run_applescript',
  'computer_use_task',
  'type_text',
  'press_keys',
  'mouse_click',
  'ui_click',
  'ui_menu',
])

const SETTING_TYPES = new Set([
  'set_volume',
  'set_brightness',
  'set_mute',
  'show_screen_overlay',
])

/**
 * The per-action risk label, as a plan manifest can know it BEFORE the action
 * runs.
 *
 * executionJournal.js already labels risk, but it does so on the read path over
 * steps that have already happened — a label on history. The same label is
 * worth far more stamped into the manifest before dispatch, because that is
 * when an approval is still possible and when a crash boundary still matters.
 */
export function riskTierFor(action, { effect = null, reversible = null } = {}) {
  const type = String(action?.type ?? '')
  if (UNCONTAINED_TYPES.has(type)) return 'uncontained'
  if (OFF_MACHINE_TYPES.has(type)) return 'off-machine'
  if (effect === 'read') return 'observe'
  if (SETTING_TYPES.has(type)) return 'setting'
  if (reversible === false) return 'irreversible-write'
  if (reversible === true) return 'reversible-write'
  /* planPreview returns null where reversibility genuinely depends on how the
   * step goes. Rounding that to "reversible" is the optimistic read, and the
   * optimistic read is what deleted a file in the incident above. */
  return 'irreversible-write'
}

/* ---------------------------------------------------------------- pre-state */

function hashFile(resolved) {
  return crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
}

/**
 * What is at this path right now, in enough detail to recognise it later.
 *
 * `mtimeMs` is recorded and deliberately NEVER used for a verdict. A `touch`
 * moves it without changing a byte, and restoring from a snapshot can preserve
 * it; content is the only thing that answers "is this the same file". It is
 * carried because it is useful evidence for the person who ends up reading the
 * question this module asks.
 */
export function describePath(rawPath) {
  const requested = String(rawPath ?? '')
  if (!requested) return null

  let resolved
  try {
    resolved = resolveUserPath(requested)
  } catch {
    return { path: requested, resolvable: false, existed: false }
  }

  let stats
  try {
    stats = fs.statSync(resolved)
  } catch {
    return { path: resolved, resolvable: true, existed: false }
  }

  if (stats.isDirectory()) {
    let entries
    try {
      entries = fs.readdirSync(resolved).length
    } catch {
      /* An unreadable directory reports null entries rather than zero: "we
       * could not look" and "it is empty" are the two readings a delete
       * verdict must never confuse. */
      entries = null
    }
    return {
      path: resolved,
      resolvable: true,
      existed: true,
      directory: true,
      entries,
      sha256: null,
      hashSkipped: 'directory',
    }
  }

  const base = {
    path: resolved,
    resolvable: true,
    existed: true,
    directory: false,
    bytes: stats.size,
    mtimeMs: stats.mtimeMs,
  }

  if (stats.size > PRE_STATE_HASH_MAX_BYTES) {
    return { ...base, sha256: null, hashSkipped: `larger than ${PRE_STATE_HASH_MAX_BYTES} bytes` }
  }

  try {
    return { ...base, sha256: hashFile(resolved), hashSkipped: null }
  } catch (error) {
    return { ...base, sha256: null, hashSkipped: String(error?.message ?? error) }
  }
}

const UNOBSERVABLE_WHY = {
  send_email: 'A sent email leaves nothing on this Mac to compare against.',
  send_message: 'A sent message leaves nothing on this Mac to compare against.',
  run_shell: 'A shell command can touch anything; there is no target to snapshot in advance.',
  run_applescript: 'AppleScript can touch anything; there is no target to snapshot in advance.',
  computer_use_task: 'A computer-use task drives the screen; its effects are not enumerable in advance.',
  type_text: 'Keystrokes land in whatever app is frontmost and leave no addressable trace.',
  press_keys: 'Keystrokes land in whatever app is frontmost and leave no addressable trace.',
  create_note:
    'create_note never overwrites — it picks the next free filename — so a note created by an interrupted run cannot be told from one created before it by path alone.',
}

/**
 * Capture the state a step is about to change, where there is any.
 *
 * Only the four filesystem mutations have a target worth snapshotting. This
 * does NOT duplicate actionReceipts.observeBeforeAction: that one COPIES the
 * bytes into the undo vault so a completed action can be reversed, and it runs
 * inside the executor. This one records a content HASH so an INTERRUPTED action
 * can be recognised, and it runs at manifest time, before the plan starts. One
 * is for undo, one is for resume, and the resume one has to exist before the
 * first step runs rather than immediately before each.
 */
export function capturePreState(action, { now = Date.now() } = {}) {
  const type = String(action?.type ?? '')
  const params = action?.params ?? {}
  const at = new Date(now).toISOString()

  try {
    switch (type) {
      case 'write_file':
      case 'delete_path':
        return { kind: 'path', at, target: describePath(params.path) }
      case 'move_path':
      case 'copy_path':
        return {
          kind: 'path-pair',
          at,
          from: describePath(params.from),
          to: describePath(params.to),
        }
      default:
        return {
          kind: 'unobservable',
          at,
          why:
            UNOBSERVABLE_WHY[type] ??
            `${type || 'This action'} leaves no local state a later read could compare against.`,
        }
    }
  } catch (error) {
    /* Capture is observation. A failure to observe must not stop the owner's
     * work — actionReceipts.observeBeforeAction takes the same position, for
     * the same reason. It costs us a verdict, not a plan. */
    return {
      kind: 'unobservable',
      at,
      why: `Pre-state capture failed: ${String(error?.message ?? error)}`,
    }
  }
}

/* -------------------------------------------------------------- the verdict */

function verdict(value, why, observed = null) {
  return { verdict: value, why, observed }
}

/**
 * Can we prove the file is untouched?
 *
 * Only a matching content hash counts. A directory is never "proven unchanged"
 * here even when its entry count matches — a recursive delete that stopped
 * partway can leave the same count with different contents, and a weak proof
 * used to justify re-running a destructive step is exactly the class of guess
 * this module exists to refuse.
 */
function provablyUnchanged(before, after) {
  if (!before || !after) return false
  if (before.existed !== after.existed) return false
  if (!before.existed) return true
  if (before.directory || after.directory) return false
  if (!before.sha256 || !after.sha256) return false
  return before.sha256 === after.sha256
}

function verifyWrite(target, step) {
  if (!target) return verdict('unverifiable', 'The step named no path to compare.')

  /* The manifest stores the intended content HASH separately from the content
   * itself, which is what lets a step stay verifiable after its parameters have
   * been withheld as secret or shed to fit the store budget. Thirty-two bytes
   * buys "did this land?" for a write whose body we deliberately do not keep. */
  const params = step?.params ?? {}
  const intended =
    step?.intent?.contentSha256 ??
    (typeof params.content === 'string'
      ? crypto.createHash('sha256').update(params.content).digest('hex')
      : null)

  if (!intended) {
    return verdict(
      'unverifiable',
      'Neither the intended file contents nor their hash is in the ledger, so what is on disk cannot be compared against what this step meant to write.',
    )
  }

  const current = describePath(target.path)
  const observed = { before: target, now: current, intendedSha256: intended }

  if (!current?.existed) {
    return target.existed
      ? verdict(
          'indeterminate',
          'The file was there before the run and is gone now. This step writes, it does not delete, so something else changed it.',
          observed,
        )
      : verdict(
          'not-applied',
          'Nothing was written: the path is still absent, exactly as it was before the run.',
          observed,
        )
  }

  if (!current.sha256) {
    return verdict(
      'unverifiable',
      `The file is present but could not be hashed (${current.hashSkipped ?? 'unknown reason'}).`,
      observed,
    )
  }

  if (current.sha256 === intended) {
    return target.existed && target.sha256 === intended
      ? verdict(
          'already-satisfied',
          'The file already held exactly these bytes before the run, so whether the write landed cannot be told — and does not matter, because running it again changes nothing.',
          observed,
        )
      : verdict('applied', 'The file now holds exactly the bytes this step meant to write.', observed)
  }

  if (target.existed && target.sha256 && current.sha256 === target.sha256) {
    return verdict(
      'not-applied',
      'The file is byte-identical to the hash taken before the run.',
      observed,
    )
  }

  return verdict(
    'indeterminate',
    'The file changed, but not into what this step meant to write. A write that stopped partway and an edit by something else look the same from here.',
    observed,
  )
}

function verifyDelete(target) {
  if (!target) return verdict('unverifiable', 'The step named no path to compare.')
  const current = describePath(target.path)
  const observed = { before: target, now: current }

  if (!target.existed) {
    return current?.existed
      ? verdict(
          'indeterminate',
          'Nothing was at that path before the run, and something is there now. This step deletes; it did not put that there.',
          observed,
        )
      : verdict(
          'already-satisfied',
          'There was nothing at that path before the run and there is nothing now.',
          observed,
        )
  }

  if (!current?.existed) {
    return verdict('applied', 'The path existed before the run and is gone now.', observed)
  }

  if (target.directory) {
    return verdict(
      'indeterminate',
      `The folder is still there, and a recursive delete can stop partway. Entries before the run: ${
        target.entries ?? 'unknown'
      }; now: ${current.entries ?? 'unknown'}. An untouched folder and a half-emptied one are not distinguishable from a count.`,
      observed,
    )
  }

  if (!target.sha256 || !current.sha256) {
    return verdict(
      'unverifiable',
      `The file is still there but could not be compared (${
        current.hashSkipped ?? target.hashSkipped ?? 'no hash was taken'
      }).`,
      observed,
    )
  }

  if (current.sha256 === target.sha256) {
    return verdict('not-applied', 'The file is byte-identical to the hash taken before the run.', observed)
  }

  return verdict(
    'indeterminate',
    'The file is still there but its contents changed. This step deletes; it did not write that.',
    observed,
  )
}

function verifyMove(pre) {
  const from = pre?.from
  const to = pre?.to
  if (!from || !to) return verdict('unverifiable', 'The step did not name both a source and a destination.')

  const nowFrom = describePath(from.path)
  const nowTo = describePath(to.path)
  const observed = { from: { before: from, now: nowFrom }, to: { before: to, now: nowTo } }

  if (!from.existed) {
    /* "Source absent" is the END state of a successful move and also the state
     * of a move that never could have run. The two are indistinguishable, and
     * guessing either way is how you move a file back over itself. */
    return verdict(
      'unverifiable',
      'The source was already absent before the run, which is also what a completed move looks like. These two cannot be told apart.',
      observed,
    )
  }

  if (!nowFrom?.existed && nowTo?.existed) {
    return verdict(
      'applied',
      'The source is gone and the destination is there — the move landed.',
      observed,
    )
  }

  if (provablyUnchanged(from, nowFrom) && provablyUnchanged(to, nowTo)) {
    return verdict(
      'not-applied',
      'Source and destination are both byte-identical to the hashes taken before the run.',
      observed,
    )
  }

  return verdict(
    'indeterminate',
    'Neither "it moved" nor "nothing happened" fits what is on disk now.',
    observed,
  )
}

function verifyCopy(pre) {
  const from = pre?.from
  const to = pre?.to
  if (!from || !to) return verdict('unverifiable', 'The step did not name both a source and a destination.')

  const nowFrom = describePath(from.path)
  const nowTo = describePath(to.path)
  const observed = { from: { before: from, now: nowFrom }, to: { before: to, now: nowTo } }

  if (provablyUnchanged(to, nowTo) && provablyUnchanged(from, nowFrom)) {
    return verdict(
      'not-applied',
      'The destination is byte-identical to the hash taken before the run.',
      observed,
    )
  }

  if (nowTo?.sha256 && nowFrom?.sha256 && nowTo.sha256 === nowFrom.sha256) {
    return verdict('applied', 'The destination now holds the same bytes as the source.', observed)
  }

  return verdict('indeterminate', 'The destination changed, but not into a copy of the source.', observed)
}

/**
 * Did this step apply? Reads the filesystem; changes nothing.
 *
 * `step` is a manifest step: { type, params, effect, preState }.
 */
export function verifyStepApplied(step) {
  const type = String(step?.type ?? '')

  if (step?.effect === 'read') {
    return verdict('no-effect', 'Read-only: it changed nothing, so nothing can have half-applied.')
  }

  const pre = step?.preState ?? null
  if (!pre || pre.kind === 'unobservable') {
    return verdict(
      'unverifiable',
      pre?.why ?? 'No pre-state was captured for this step, so there is nothing to compare against.',
    )
  }

  switch (type) {
    case 'write_file':
      return verifyWrite(pre.target, step)
    case 'delete_path':
      return verifyDelete(pre.target)
    case 'move_path':
      return verifyMove(pre)
    case 'copy_path':
      return verifyCopy(pre)
    default:
      return verdict(
        'unverifiable',
        `${type || 'This action'} has no post-hoc check; a pre-state was captured but nothing knows how to read it back.`,
      )
  }
}

/* --------------------------------------------------------------- the resume */

const SKIP_VERDICTS = new Set(['applied', 'already-satisfied'])

function decideStep(step, { verify, gapped }) {
  if (step?.phase === 'done' && step?.ok) {
    return { decision: 'completed', why: 'It finished and reported success.', verification: null }
  }

  if (step?.resumable === false) {
    /* "Cannot be replayed" and "cannot be checked" are different failures, and
     * collapsing them costs the owner a question they did not need to answer.
     * A step whose parameters were withheld as secret can still be PROVEN to
     * have landed by its content hash — and a step that landed does not need
     * replaying, so the missing parameters stop mattering. */
    const verification = step?.effect === 'read' ? null : verify(step)
    if (verification && SKIP_VERDICTS.has(verification.verdict)) {
      return {
        decision: 'skip',
        why: `${verification.why} Its parameters are not in the ledger, but a step that already landed does not need them.`,
        verification,
      }
    }
    return {
      decision: 'ask',
      why:
        step?.notResumableReason ??
        'This step cannot be replayed from the ledger, so continuing past it would be a guess.',
      verification,
    }
  }

  if (step?.phase === 'pending') {
    if (gapped) {
      /* The record says this never started, but a LATER step is recorded as
       * having run — so the record has a hole in it, and the hole is exactly
       * where a lost write would be. A "never started" we cannot trust is not
       * a "never started". */
      return {
        decision: 'ask',
        why: 'The ledger records this step as never started, but a later step is recorded as run. The record has a gap, so "it never started" cannot be trusted here.',
        verification: verify(step),
      }
    }
    return {
      decision: 'rerun',
      /* The ordering invariant this rests on: the ledger fsyncs "started"
       * BEFORE the executor is handed the action. A crash after dispatch leaves
       * the step `inflight`, never `pending`. Break that ordering and this line
       * becomes a lie. */
      why: 'The ledger fsynced "started" before dispatch and this step never reached that state, so it was never handed to the executor.',
      verification: null,
    }
  }

  if (step?.effect === 'read') {
    return {
      decision: 'rerun',
      why: 'Read-only: reading it again changes nothing.',
      verification: verify(step),
    }
  }

  if (step?.replaySafety === 'idempotent') {
    return {
      decision: 'rerun',
      why: 'Running it again converges on the same end state whether or not the first attempt landed, so it does not matter which happened.',
      verification: verify(step),
    }
  }

  const verification = verify(step)

  if (SKIP_VERDICTS.has(verification.verdict)) {
    return { decision: 'skip', why: verification.why, verification }
  }

  if (verification.verdict === 'not-applied') {
    return { decision: 'rerun', why: verification.why, verification }
  }

  return {
    decision: 'ask',
    why: verification.why,
    verification,
  }
}

/**
 * "The last automation may have been interrupted — inspect what it actually
 * finished, safely continue the rest, and tell me what changed."
 *
 * All three clauses, in that order, and the middle one refuses rather than
 * guesses. The rule that makes it safe rather than merely helpful:
 *
 *   ONCE A STEP ASKS, EVERYTHING AFTER IT IS BLOCKED.
 *
 * Not skipped, not attempted — blocked. Continuing to step 7 while step 4's
 * outcome is unknown is a guess wearing a plan's clothes: step 7 was written
 * assuming step 4 landed. `runnable` therefore stops at the first question, and
 * the caller gets the question instead of the rest of the plan.
 *
 * Pure: it reads the filesystem through `verify` and returns a description. It
 * runs nothing.
 */
export function planResume(manifest, { verify = verifyStepApplied, now = Date.now() } = {}) {
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : []

  /* A pending step is only trustworthy if nothing after it ran. Computed over
   * the whole list first so the per-step decision can see it. */
  const lastTouched = steps.reduce(
    (latest, step, index) => (step?.phase && step.phase !== 'pending' ? index : latest),
    -1,
  )

  let stopped = null
  const decided = steps.map((step, index) => {
    const base = {
      seq: step?.seq ?? index,
      stepKey: step?.stepKey ?? null,
      type: step?.type ?? null,
      label: step?.label ?? null,
      phase: step?.phase ?? 'pending',
      effect: step?.effect ?? null,
      riskTier: step?.riskTier ?? null,
      replaySafety: step?.replaySafety ?? null,
      needsApproval: step?.needsApproval ?? null,
      touches: Array.isArray(step?.touches) ? step.touches : [],
    }

    if (stopped) {
      return {
        ...base,
        decision: 'blocked',
        why: `Blocked behind step ${stopped.seq}: this step was planned assuming that one landed, and nobody knows whether it did.`,
        verification: null,
      }
    }

    const outcome = decideStep(step, {
      verify,
      gapped: step?.phase === 'pending' && index < lastTouched,
    })

    if (outcome.decision === 'ask') {
      stopped = {
        seq: base.seq,
        stepKey: base.stepKey,
        type: base.type,
        label: base.label,
        riskTier: base.riskTier,
        replaySafety: base.replaySafety,
        why: outcome.why,
        verification: outcome.verification,
        question: questionFor(base, outcome),
      }
    }

    return { ...base, ...outcome }
  })

  const counts = decided.reduce(
    (totals, step) => ({ ...totals, [step.decision]: (totals[step.decision] ?? 0) + 1 }),
    { completed: 0, skip: 0, rerun: 0, ask: 0, blocked: 0 },
  )

  /* Everything the run is known to have actually done — the third clause of the
   * ask. A step verified `applied` after the fact belongs here too: it happened,
   * the ledger just did not get to write it down. */
  const changed = decided
    .filter(
      (step) =>
        step.effect !== 'read' &&
        (step.decision === 'completed' ||
          (step.decision === 'skip' && step.verification?.verdict === 'applied')),
    )
    .map((step) => ({
      seq: step.seq,
      type: step.type,
      label: step.label,
      touches: step.touches,
      confirmedBy: step.decision === 'completed' ? 'receipt' : 'post-hoc inspection',
    }))

  const runnable = []
  for (const [index, step] of decided.entries()) {
    if (step.decision === 'ask' || step.decision === 'blocked') break
    if (step.decision !== 'rerun') continue
    const source = steps[index]
    if (!source?.params && source?.paramsElided) continue
    runnable.push({
      type: source.type,
      ...(source.label ? { label: source.label } : {}),
      params: source.params ?? {},
    })
  }

  return {
    ok: true,
    ledgerId: manifest?.ledgerId ?? null,
    jobId: manifest?.jobId ?? null,
    command: manifest?.command ?? '',
    planKey: manifest?.planKey ?? null,
    decidedAt: new Date(now).toISOString(),
    /* An interrupted run is one the ledger never got to close, or one with a
     * step it marked started and never settled. */
    interrupted:
      manifest?.status === 'open' || steps.some((step) => step?.phase === 'inflight'),
    safeToContinue: !stopped,
    stopped,
    question: stopped ? stopped.question : null,
    counts,
    changed,
    /* Steps to hand back to the existing /execute path. Empty when the very
     * first unresolved step is a question. Note that these are ACTIONS, not a
     * command to run them: this module cannot execute. */
    runnable,
    steps: decided,
    note: stopped
      ? 'Stopped at the first step whose outcome could not be established. Nothing after it is safe to run until that is answered.'
      : 'Every unfinished step was either proven not to have run, or is safe to run again.',
  }
}

function questionFor(step, outcome) {
  const name = step.label || step.type || 'that step'
  const target = step.touches?.[0]?.ref ? ` (${step.touches[0].ref})` : ''
  const consequence =
    step.replaySafety === 'additive'
      ? 'Running it again would do it a second time rather than repair it.'
      : step.replaySafety === 'unrepeatable'
        ? 'Running it again is not a retry — it would act on state that has already moved.'
        : 'Running it again may not be a no-op.'

  return `I cannot tell whether "${name}"${target} finished. ${outcome.why} ${consequence} Should I run it again, or treat it as done and carry on?`
}
