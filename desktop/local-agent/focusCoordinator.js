import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { staticReversibility } from './actionReceipts.js'
import { parseForegroundApp, readForegroundApp } from './executionJournal.js'

/*
 * Focus-safe execution: watch the foreground while a plan runs, address apps by
 * name instead of activating them, and stop a plan that has lost the state it
 * was aimed at.
 *
 * THIS IS NOT AN APPROVAL GATE and must never become one. Nothing here blocks,
 * prompts, waits, or asks. The only plan it stops is one whose remaining steps
 * are now pointed at something else — a queued type_text for Notes while Safari
 * came to the front is not "a step awaiting permission", it is a step that would
 * put the owner's text in the wrong window. Stopping it is recovery. The same
 * promise actionReceipts.js and executionJournal.js make about themselves.
 *
 * The bug this exists for is already shipping. focusPolicy.js defaults to `auto`,
 * so while the owner is at the machine `open_app Notes` runs as `open -g` and
 * Notes never comes forward — and the very next `ui_click` in the same plan
 * defaults to `app: 'frontmost'`, which is the owner's window, not Notes. The
 * receipt says success either way. Routing that click to "Notes" by name fixes
 * it through the accessibility API, which reads and presses controls in an app
 * that is not in front. Not stealing focus is the owner's stated preference;
 * this is how a plan keeps working under it.
 */

const execFileAsync = promisify(execFile)

/* Re-check the host this often, in steps. Small enough that a plan notices the
 * ground moving before it has typed a paragraph into the wrong app, large
 * enough that the two lsappinfo reads (~15 ms measured) stay noise. */
export const FOCUS_BATCH_SIZE = Math.max(
  1,
  Number(process.env.PENDANT_FOCUS_BATCH_SIZE || 4) || 4,
)

/* Accessibility steps carry their own target: the Swift helper resolves
 * `--app <name>` through the AX API and never activates it. These are the ones
 * that can be routed. */
const ADDRESSABLE_TYPES = new Set([
  'ui_snapshot',
  'ui_find',
  'ui_click',
  'ui_menu',
  'ui_wait_for',
])

/* These reach whatever is in front by construction — a CGEvent posts to the
 * focused app and a screen coordinate means nothing without knowing whose
 * window is under it. No amount of routing changes that. */
const FOREGROUND_BOUND_TYPES = new Set([
  'type_text',
  'press_keys',
  'ui_hit_test',
  'mouse_move',
  'mouse_click',
  'mouse_double_click',
  'mouse_right_click',
  'mouse_down',
  'mouse_up',
  'mouse_drag',
  'scroll',
  'mouse_scroll',
  'screenshot',
  'zoom',
])

/* `open` activates or not depending on PENDANT_FOCUS_POLICY and on whether the
 * owner is at the keyboard, so a foreground change straight after one of these
 * is expected, not drift. */
const MAY_ACTIVATE_TYPES = new Set([
  'open_app',
  'open_url',
  'open_path',
  'open_folder',
  'create_note',
  'play_youtube',
  'show_screen_overlay',
])

/* Params through which a plan names the app it is about. */
const APP_PARAMS = ['app', 'appName', 'application', 'name']

function appNamed(action) {
  for (const key of APP_PARAMS) {
    const value = action?.params?.[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim().replace(/\.app$/i, '')
    if (trimmed && trimmed.toLowerCase() !== 'frontmost') return trimmed
  }
  return null
}

/* actionReceipts owns the read-only table; asking it keeps one answer to
 * "does this step change anything" instead of two that can drift apart. */
function isReadOnly(type) {
  return staticReversibility(type).reversible === 'not-needed'
}

/**
 * What a single step needs from the foreground, and whether it can be aimed
 * somewhere explicit instead.
 */
export function classifyFocus(action) {
  const type = String(action?.type ?? '')
  const named = appNamed(action)
  const readOnly = isReadOnly(type)

  if (ADDRESSABLE_TYPES.has(type)) {
    return {
      type,
      focus: named ? 'addressed' : 'foreground',
      targetApp: named,
      routable: true,
      mayActivate: false,
      readOnly,
    }
  }

  if (FOREGROUND_BOUND_TYPES.has(type)) {
    return { type, focus: 'foreground', targetApp: null, routable: false, mayActivate: false, readOnly }
  }

  return {
    type,
    focus: 'none',
    targetApp: null,
    routable: false,
    mayActivate: MAY_ACTIVATE_TYPES.has(type),
    readOnly,
  }
}

/* Only an app the plan itself named. Guessing one and then pressing a control
 * inside it would be a worse failure than the frontmost default it replaces. */
export function inferTargetApp(actions) {
  for (const action of Array.isArray(actions) ? actions : []) {
    const named = appNamed(action)
    if (named) return named
  }
  return null
}

/**
 * The plan with its focus requirements marked: which steps address an app by
 * name, which can only land in whatever is in front, and which of those change
 * something once they get there.
 */
export function planFocus(actions, { targetApp = null } = {}) {
  const list = Array.isArray(actions) ? actions : []
  const target = targetApp ?? inferTargetApp(list)

  const steps = list.map((action, seq) => {
    const need = classifyFocus(action)
    const routeTo = need.routable && !need.targetApp && target ? target : null
    const focus = routeTo ? 'addressed' : need.focus

    return {
      seq,
      type: need.type,
      label: action?.label ?? null,
      focus,
      targetApp: need.targetApp ?? routeTo,
      routedByCoordinator: Boolean(routeTo),
      readOnly: need.readOnly,
      mayActivate: need.mayActivate,
      /* The requirement the proposal asked to be marked: a step that can only
       * land in the frontmost app AND changes something is the one that needs
       * the owner's focus, and the reason to hand it back afterwards. */
      needsForeground: focus === 'foreground' && !need.readOnly,
    }
  })

  return {
    targetApp: target,
    steps,
    addressed: steps.filter((step) => step.focus === 'addressed').length,
    foregroundBound: steps.filter((step) => step.needsForeground).length,
    mayActivate: steps.filter((step) => step.mayActivate).length,
    routed: steps.filter((step) => step.routedByCoordinator).length,
  }
}

/**
 * Aim routable steps at the app the plan named.
 *
 * The rewritten action is what actually runs, so it is what the receipt records
 * and what actionIdFor hashes — an addressed click is a genuinely different step
 * from a frontmost one and deserves a different idempotency key.
 */
export function routeByTargetApp(actions, plan) {
  const list = Array.isArray(actions) ? actions : []
  return list.map((action, seq) => {
    const step = plan?.steps?.[seq]
    if (!step?.routedByCoordinator) return action
    return { ...action, params: { ...(action.params ?? {}), app: step.targetApp } }
  })
}

/* Empty output means the app is not running; lsappinfo still exits 0. */
async function readTargetApp(app, execFileImpl) {
  if (!app) {
    return { app: null, probed: false, detail: 'The plan named no target app.' }
  }

  try {
    const { stdout } = await execFileImpl(
      'lsappinfo',
      ['info', '-only', 'name,bundleID,pid', app],
      { timeout: 4000 },
    )
    const info = parseForegroundApp(stdout)
    return { app, probed: true, running: Boolean(info.pid), ...info }
  } catch (error) {
    return { app, probed: false, error: String(error?.message ?? error) }
  }
}

/*
 * The accessibility half of the fingerprint. It spawns the UI helper, so it is
 * injected rather than default-on and reports NOT PROBED when it was not — the
 * same honesty projectAccessibility() owes for inputPosting, and for the same
 * reason: an unprobed field read as a finding is how observability starts lying.
 */
async function fingerprintWindows(app, uiSnapshot) {
  if (!app || typeof uiSnapshot !== 'function') {
    return {
      probed: false,
      detail:
        'Not probed. The accessibility snapshot spawns the UI helper; pass uiSnapshot to fingerprint the target window state.',
    }
  }

  try {
    const snapshot = await uiSnapshot({ app, max: 40 })
    const labels = (Array.isArray(snapshot?.elements) ? snapshot.elements : [])
      .map((element) => `${element?.role ?? ''}:${element?.title ?? ''}`)
      .filter((label) => label !== ':')
    return {
      probed: true,
      elements: labels.length,
      digest: crypto.createHash('sha1').update(labels.join('\n')).digest('hex').slice(0, 12),
    }
  } catch (error) {
    return { probed: false, error: String(error?.message ?? error) }
  }
}

/**
 * The host as this plan depends on it: who is in front, and whether the app the
 * plan is aimed at is still the same process.
 */
export async function fingerprintHost({
  targetApp = null,
  execFileImpl = execFileAsync,
  uiSnapshot = null,
} = {}) {
  const [foreground, target] = await Promise.all([
    readForegroundApp(execFileImpl),
    readTargetApp(targetApp, execFileImpl),
  ])

  return {
    at: new Date().toISOString(),
    foreground,
    target,
    windows: await fingerprintWindows(targetApp, uiSnapshot),
  }
}

function identityOf(app) {
  return app?.bundleId || app?.name || null
}

function sameApp(before, after) {
  const from = identityOf(before)
  const to = identityOf(after)
  /* An unreadable foreground on either side is not evidence of a change. The
   * cautious direction here is to keep running, because the alternative is a
   * plan that aborts every time lsappinfo hiccups. */
  if (!from || !to) return true
  return from === to
}

/**
 * Has the ground moved under the steps that have not run yet?
 *
 * Deliberately narrow. The owner switching apps while the plan presses controls
 * in Notes BY NAME is not drift, it is the owner using their computer — which is
 * the entire point of routing by target app. Drift is only drift when a step
 * still to come depended on the thing that changed.
 */
export function detectDrift(before, after, { remaining = [], expectActivation = false } = {}) {
  const pending = Array.isArray(remaining) ? remaining : []
  const dependsOnForeground = pending.some((step) => step.needsForeground)
  const dependsOnTarget = pending.some((step) => step.focus === 'addressed')

  if (dependsOnForeground && !expectActivation && !sameApp(before?.foreground, after?.foreground)) {
    return {
      kind: 'foreground',
      from: identityOf(before?.foreground),
      to: identityOf(after?.foreground),
      detail: `Stopped: ${identityOf(after?.foreground)} came to the front, and ${
        pending.filter((step) => step.needsForeground).length
      } remaining step(s) act on whatever is in front. Nothing was typed or clicked into it.`,
    }
  }

  if (dependsOnTarget && before?.target?.probed && after?.target?.probed) {
    if (before.target.running && !after.target.running) {
      return {
        kind: 'target-gone',
        from: before.target.app,
        to: null,
        detail: `Stopped: ${before.target.app} is no longer running, and the remaining steps address it by name.`,
      }
    }

    if (before.target.pid && after.target.pid && before.target.pid !== after.target.pid) {
      return {
        kind: 'target-restarted',
        from: before.target.pid,
        to: after.target.pid,
        detail: `Stopped: ${before.target.app} restarted (pid ${before.target.pid} -> ${after.target.pid}), so element references from before it restarted no longer resolve.`,
      }
    }
  }

  return null
}

/*
 * Handing the foreground back is the opposite of taking it: it only ever runs
 * toward an app the owner already had, and only when this plan is what moved
 * away from it. If the foreground is some third app the plan never named, the
 * owner went there themselves and pulling them back would be the focus theft
 * the whole module exists to avoid.
 */
async function restoreForeground({
  before,
  latest,
  plan,
  planMovedFocus,
  execFileImpl,
  restoreFocus,
}) {
  const original = before?.foreground ?? null

  if (!restoreFocus) {
    return { attempted: false, restoredTo: null, reason: 'Restore is switched off.' }
  }
  /* A plan of pure file and shell steps never went near the foreground.
   * Activating anything on its way out would be a change, not a restore. */
  if (plan.foregroundBound + plan.mayActivate === 0) {
    return {
      attempted: false,
      restoredTo: null,
      reason: 'No step in this plan could have moved the foreground.',
    }
  }
  if (!identityOf(original)) {
    return { attempted: false, restoredTo: null, reason: 'The foreground app before the plan could not be read.' }
  }
  if (sameApp(original, latest?.foreground)) {
    return { attempted: false, restoredTo: null, reason: 'Focus never left the app that had it.' }
  }
  if (!planMovedFocus) {
    return {
      attempted: false,
      restoredTo: null,
      reason: `The foreground moved to ${identityOf(latest?.foreground)} after steps that could not have moved it — the owner switched apps, and that is not this agent's to undo.`,
    }
  }

  const named = new Set(
    [plan?.targetApp, ...plan.steps.map((step) => step.targetApp)]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase()),
  )
  const current = String(latest?.foreground?.name ?? '').toLowerCase()
  if (named.size && current && !named.has(current)) {
    return {
      attempted: false,
      restoredTo: null,
      reason: `${latest?.foreground?.name} is in front and this plan never named it, so the owner went there and the move is not ours to reverse.`,
    }
  }

  /* Relaunching an app the plan just quit would be a new side effect, not a
   * restoration, so only an app still running is handed the foreground back. */
  const stillRunning = await readTargetApp(identityOf(original), execFileImpl)
  if (!stillRunning.probed || !stillRunning.running) {
    return {
      attempted: false,
      restoredTo: null,
      reason: `${identityOf(original)} is no longer running; reopening it would be a new action, not a restore.`,
    }
  }

  /* By bundle id only. `open -a <name>` resolves through Launch Services and can
   * land on a different copy of the app than the one that had the foreground. */
  const bundleId = stillRunning.bundleId || original.bundleId
  if (!bundleId) {
    return {
      attempted: false,
      restoredTo: null,
      reason: `${original.name} reported no bundle id, so there is no unambiguous way to hand it back.`,
    }
  }

  try {
    await execFileImpl('open', ['-b', bundleId], { timeout: 8000 })
    return { attempted: true, ok: true, restoredTo: original.name ?? original.bundleId, how: 'open -b' }
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      restoredTo: null,
      reason: String(error?.message ?? error),
    }
  }
}

const RECEIPT_NOTE =
  'Observation and recovery only. Nothing on this path can block, prompt, or wait for a person. A stopped plan is one whose remaining steps lost the state they were aimed at; re-send `remaining` to finish it.'

/**
 * Run a plan through the executor with the foreground watched around it.
 *
 * `execute` is injected (the executor is the caller's, not this module's) and is
 * handed one action at a time, exactly as orchestrateExecute already did, so the
 * per-step trace and the per-action receipts are unchanged.
 *
 * Returns `{ results, receipt }` — the receipt deliberately does not carry the
 * results, because the caller persists those after stripping image bytes and a
 * second copy inside the receipt would sail straight past that.
 */
export async function runFocusSafePlan(
  actions,
  {
    execute,
    targetApp = null,
    batchSize = FOCUS_BATCH_SIZE,
    execFileImpl = execFileAsync,
    uiSnapshot = null,
    restoreFocus = true,
    onStep = null,
  } = {},
) {
  if (typeof execute !== 'function') {
    throw new Error('runFocusSafePlan requires an execute function.')
  }

  const list = Array.isArray(actions) ? actions : []
  const plan = planFocus(list, { targetApp })
  const routed = routeByTargetApp(list, plan)
  const size = Math.max(1, Number(batchSize) || 1)

  const before = await fingerprintHost({ targetApp: plan.targetApp, execFileImpl, uiSnapshot })
  let latest = before

  const results = []
  const batches = []
  const focusChanges = []
  let drift = null
  let ran = 0
  /* Assigned in the `finally` below, on every path including a thrown one. */
  let restored

  try {
    for (let start = 0; start < routed.length && !drift; start += size) {
      const slice = routed.slice(start, start + size)
      const seqs = []

      for (const [offset, action] of slice.entries()) {
        const seq = start + offset
        const step = plan.steps[seq]
        await onStep?.({ phase: 'start', seq, action, step })
        const [result] = await execute([action])
        results.push(result)
        ran = seq + 1
        seqs.push(seq)
        await onStep?.({ phase: 'done', seq, action, step, result })
      }

      const batchSteps = seqs.map((seq) => plan.steps[seq])
      const couldMoveFocus = batchSteps.some((step) => step.mayActivate || step.needsForeground)
      const after = await fingerprintHost({
        targetApp: plan.targetApp,
        execFileImpl,
        uiSnapshot,
      })

      if (!sameApp(latest.foreground, after.foreground)) {
        focusChanges.push({
          afterBatch: batches.length,
          from: identityOf(latest.foreground),
          to: identityOf(after.foreground),
          expected: couldMoveFocus,
        })
      }

      drift = detectDrift(latest, after, {
        remaining: plan.steps.slice(ran),
        expectActivation: couldMoveFocus,
      })

      batches.push({
        index: batches.length,
        steps: seqs,
        observedAt: after.at,
        /* What was actually checked after this batch, so "verified" is a list of
         * readings rather than a word. A digest that did not move is an
         * observation, not a verdict: plenty of real clicks open a menu without
         * retitling anything. */
        verified: {
          foregroundApp: after.foreground?.name ?? null,
          targetApp: after.target?.app ?? null,
          targetRunning: after.target?.probed ? Boolean(after.target.running) : null,
          targetPid: after.target?.pid ?? null,
          targetWindows: after.windows?.probed
            ? after.windows.digest === latest.windows?.digest
              ? 'unchanged'
              : 'changed'
            : 'not-probed',
        },
        drift,
      })

      latest = after
    }
  } finally {
    /* In `finally` so a cancelled job still gets the owner's window back — the
     * receipt is discarded on a throw, but the foreground is not a bookkeeping
     * detail. Its own try/catch because an error raised here would replace the
     * error the caller is actually being told about. */
    try {
      latest = await fingerprintHost({ targetApp: plan.targetApp, execFileImpl, uiSnapshot })
      restored = await restoreForeground({
        before,
        latest,
        plan,
        /* Attributed over the steps that RAN, not over completed batches: a plan
         * cancelled mid-batch has still already opened whatever it opened, and
         * the owner should get their window back either way. */
        planMovedFocus: plan.steps
          .slice(0, ran)
          .some((step) => step.mayActivate || step.needsForeground),
        execFileImpl,
        restoreFocus,
      })
    } catch (error) {
      restored = { attempted: false, restoredTo: null, reason: String(error?.message ?? error) }
    }
  }

  const remaining = plan.steps.slice(ran).map((step) => ({
    seq: step.seq,
    type: step.type,
    label: step.label,
    focus: step.focus,
    targetApp: step.targetApp,
  }))

  return {
    results,
    receipt: {
      ok: !drift && results.every((result) => result?.ok !== false),
      status: drift ? 'stopped-on-drift' : 'completed',
      note: RECEIPT_NOTE,
      observedAt: before.at,
      finishedAt: latest.at,
      batchSize: size,
      targetApp: plan.targetApp,
      plan: plan.steps,
      focus: {
        before: before.foreground,
        after: latest.foreground,
        changed: !sameApp(before.foreground, latest.foreground),
        changes: focusChanges,
        restored,
      },
      batches,
      drift,
      ranSteps: ran,
      remaining,
    },
  }
}
