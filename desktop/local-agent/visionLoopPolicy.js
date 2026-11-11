import { LOOP_ALLOWED_ACTIONS } from './computerUseLoop.js'
import { classifyFocus } from './focusCoordinator.js'
import { postsSyntheticInput } from './inputReachability.js'

/*
 * Accessibility-mode UI automation: the vocabulary, and why everything else is
 * unreachable from it.
 *
 * The capability being asked for is "automate GUI tasks WITHOUT taking over the
 * screen or keyboard focus". That is not a preference to be expressed in a
 * system prompt — computerUseLoop.js already says "prefer ui_menu, then ui_find,
 * then pixels", and a preference is exactly what a model abandons on step nine
 * of a hard task. The screen and the keyboard are the owner's; a loop that can
 * reach them under pressure will.
 *
 * So the vocabulary here is STRUCTURAL, the same way LOOP_ALLOWED_ACTIONS is
 * structural. Five step types exist. Every one of them addresses an app BY NAME
 * through the accessibility API, which reads and presses controls in a window
 * that is not in front and never activates it. Screenshots, mouse coordinates,
 * synthesized keystrokes and app activation are not "discouraged" here, they are
 * absent, and a plan that needs one is reported as blocked rather than quietly
 * downgraded into it. Nothing in this file can be widened by anything a model
 * emits or by any text it reads on screen.
 *
 * THE ONE HONEST HOLE, declared rather than hidden: `ui_click` is
 * `AXUIElementPerformAction(kAXPressAction)`, and macos/UIControl.swift falls
 * back to a real left click at the element's frame centre when that returns
 * anything but success. A background window's frame centre is very often
 * covered by the owner's window, so the fallback is precisely the focus theft
 * this module exists to prevent. The helper is not this module's to change, so
 * the fallback is (a) declared per step before anything runs and (b) detected
 * after the fact — the helper reports `method: "mouse"`, and visionLoop.js
 * treats that as a terminal stop for the whole run rather than a step note. A
 * degradation you can see on its first occurrence is a different thing from a
 * silent one.
 */

/**
 * The complete step vocabulary. Read-only members first.
 *
 * `ui_hit_test` is deliberately absent despite being an accessibility call: it
 * takes a SCREEN COORDINATE and reports whatever is under it, which is a
 * question about the owner's stacking order rather than about the target app.
 * focusCoordinator classifies it as foreground-bound for the same reason.
 */
export const VISION_LOOP_STEPS = Object.freeze([
  'ui_snapshot',
  'ui_find',
  'ui_wait_for',
  'ui_click',
  'ui_menu',
])

export const VISION_LOOP_VOCABULARY = new Set(VISION_LOOP_STEPS)

/* Steps that only read the accessibility tree. Nothing about them can change
 * the target app, so they are the half of the loop that would be safe to run
 * unattended the moment the grant lands. */
export const VISION_LOOP_READ_ONLY = new Set(['ui_snapshot', 'ui_find', 'ui_wait_for'])

/*
 * Why each excluded action is excluded, in the owner's words rather than in a
 * capability name.
 *
 * Keyed by every action the general computer-use loop allows. The test suite
 * asserts this map plus the vocabulary covers LOOP_ALLOWED_ACTIONS exactly, so
 * a new action type added to that loop cannot silently arrive here unclassified
 * — it fails a test instead, and someone has to decide which side it is on.
 */
export const VISION_LOOP_EXCLUSIONS = Object.freeze({
  screenshot:
    'Takes a picture of a whole display, which is pixel capture of every window on it — including ones that have nothing to do with the task. Needs Screen Recording, which this loop is built not to need.',
  zoom: 'A cropped screenshot is still a screenshot of the owner’s screen.',
  mouse_move:
    'Moves the owner’s pointer. There is one pointer and it is theirs.',
  mouse_click:
    'Clicks at a screen coordinate, which lands in whatever window is topmost at that point — the owner’s window whenever the target app is in the background.',
  mouse_double_click: 'Same as mouse_click: a screen coordinate, not a control.',
  mouse_right_click: 'Same as mouse_click, and it opens a context menu over whatever is in front.',
  mouse_drag: 'Drags the owner’s pointer across their screen.',
  mouse_down: 'Holds the owner’s mouse button down; anything that happens next is theirs.',
  mouse_up: 'The other half of a pointer takeover.',
  scroll: 'Scrolls whatever is under the pointer, which is not necessarily the target app.',
  mouse_scroll: 'Same as scroll.',
  type_text:
    'Synthesized keystrokes go to the KEYBOARD FOCUS, which is the owner’s insertion point. There is no way to type into a background window with a CGEvent.',
  press_keys:
    'Key chords go to the keyboard focus too, and some of them (⌘Q, ⌘W) act on whatever app happens to have it.',
  ui_hit_test:
    'Reads whatever element is under a screen coordinate. That is a question about the owner’s window stacking, not about the app this plan named.',
  cursor_position:
    'Reads where the owner’s pointer is. The general loop uses it to notice a human taking over; a loop that never touches the pointer has nothing to notice.',
  list_displays:
    'Display geometry is only needed to turn pixels into coordinates, and this loop has no pixel tier to feed.',
  open_app:
    'Launching or raising an app is exactly the foreground move this loop promises not to make. Address a running app by name instead; if it is not running, say so and stop.',
  get_clipboard:
    'The clipboard is shared state the owner is also using, and reading it can pick up whatever they last copied.',
  copy_to_clipboard:
    'Writing the clipboard destroys whatever the owner had in it, with no snapshot and no undo.',
})

/*
 * What each step needs from macOS, and what it does NOT need.
 *
 * The second half matters as much as the first: this loop needs exactly ONE of
 * the two grants that are missing on this machine. Screen Recording is not on
 * its critical path at all, and saying so is the difference between "the agent
 * needs everything" and an owner who can make one decision.
 */
export const ACCESSIBILITY_GRANT = Object.freeze({
  grant: 'accessibility',
  pane: 'System Settings › Privacy & Security › Accessibility',
  why: 'Reading another app’s controls and pressing them by name is the accessibility API. macos/UIControl.swift refuses snapshot, find, press and menu outright when AXIsProcessTrusted() is false.',
  symptomWithout:
    'The helper exits with NO_AX and the step fails loudly. It does not half-work.',
})

export const SCREEN_RECORDING_GRANT = Object.freeze({
  grant: 'screenRecording',
  pane: 'System Settings › Privacy & Security › Screen Recording',
  why: 'Only needed to capture pixels.',
  symptomWithout: 'Captures come back empty.',
})

/**
 * The `ui_click` mouse fallback, written down where a reader will meet it.
 *
 * `detectableBy` is the load-bearing field: it is what turns this from a
 * caveat into a check. visionLoop.js stops the run on it.
 */
export const PRESS_FALLBACK = Object.freeze({
  possible: true,
  mechanism:
    'macos/UIControl.swift posts a real left click at the element’s frame centre when the accessibility press action fails.',
  condition:
    'AXUIElementPerformAction(kAXPressAction) returns anything but success AND the element has an on-screen frame.',
  consequence:
    'That click goes to whatever window is topmost at that point. When the target app is in the background — which is the normal case for this loop — that is the owner’s window.',
  detectableBy:
    'The helper reports method:"mouse" instead of method:"press" in its own result.',
  handling:
    'Treated as a terminal stop for the whole run, not a step note: the loop’s promise was already broken once and the remaining steps were planned assuming it had not been.',
})

/*
 * Pressing a menu bar item is an accessibility action, and whether it also
 * brings the app forward is NOT something this project has measured — the grant
 * to measure it has never been held. inputReachability.js is the house style
 * for this: `unverified` means "not probed", never "assumed fine". Claiming
 * ui_menu is focus-safe would be an inference reported as a measurement, and
 * claiming it steals focus would be the same mistake pointing the other way.
 */
export const MENU_ACTIVATION = Object.freeze({
  status: 'unverified',
  detail:
    'Walking a menu bar performs a press on each menu item. Whether macOS also activates the owning app when its menu opens has not been measured from this binary, because the accessibility grant needed to try it has never been held.',
  measureBy:
    'Once Accessibility is granted: run one ui_menu against a background app and compare the foreground app before and after, which focusCoordinator.fingerprintHost already reports per batch.',
})

/** Per-step requirements, derived rather than tabulated twice. */
export function requirementsFor(type) {
  const name = String(type ?? '')
  if (!VISION_LOOP_VOCABULARY.has(name)) return null

  return {
    type: name,
    grants: [ACCESSIBILITY_GRANT.grant],
    /* Said explicitly, because "does this need Screen Recording" is the
     * question an owner deciding on one checkbox is actually asking. */
    doesNotNeed: [SCREEN_RECORDING_GRANT.grant],
    readOnly: VISION_LOOP_READ_ONLY.has(name),
    /* inputReachability owns the list of steps that only arrive by way of a
     * posted event; asking it keeps one answer instead of two. ui_click and
     * ui_menu are on it precisely because of the fallback above. */
    postsSyntheticInput: postsSyntheticInput(name),
    pressFallback: name === 'ui_click' ? PRESS_FALLBACK : null,
    focusNote: name === 'ui_menu' ? MENU_ACTIVATION : null,
  }
}

/**
 * Is this action allowed in accessibility mode, and if not, why not?
 *
 * Never returns a bare false. A refusal without the sentence explaining it is
 * how "blocked" becomes a shrug.
 */
export function admitStep(action) {
  const type = String(action?.type ?? '')

  if (!type) {
    return { ok: false, type, reason: 'The step has no action type.', category: 'malformed' }
  }

  if (VISION_LOOP_VOCABULARY.has(type)) {
    /* Routability is asked of focusCoordinator rather than asserted here. It
     * already owns "can this step be aimed at a named app", the answer is
     * frozen policy, and a second copy would be the copy that drifts. */
    const focus = classifyFocus(action)
    if (!focus.routable) {
      return {
        ok: false,
        type,
        reason: `focusCoordinator no longer classifies ${type} as routable to a named app, so it can only act on whatever is in front. It has been dropped from accessibility mode until that is untrue again.`,
        category: 'not-routable',
      }
    }
    return { ok: true, type, requirements: requirementsFor(type) }
  }

  const excluded = VISION_LOOP_EXCLUSIONS[type]
  if (excluded) {
    return { ok: false, type, reason: excluded, category: 'takes-over-screen-or-focus' }
  }

  return {
    ok: false,
    type,
    reason: `"${type}" is not part of accessibility-mode UI automation. Shell, file, mail and browser steps are deliberately unreachable here; if the task genuinely needs one, it belongs in the normal plan-confirm-execute path where the owner sees it.`,
    category: 'outside-vocabulary',
  }
}

/**
 * One step, as a sentence.
 *
 * Shared by the "here is what I would have done" report and by the history
 * narration, so the line an owner reads before a run and the line they read
 * afterwards describe the same step in the same words. planPreview.js and
 * actionLedger.js keep the same promise to each other for the same reason.
 */
export function describeStep(action, { app = null } = {}) {
  const type = String(action?.type ?? '')
  const params = action?.params ?? {}
  const target = params.app ?? app ?? 'the app this plan named'
  const named =
    params.title ??
    params.titleContains ??
    (params.ref ? `the element ${params.ref}` : null)

  switch (type) {
    case 'ui_snapshot':
      return `Read the list of controls ${target} is showing, without touching any of them.`
    case 'ui_find':
      return `Look for ${named ? `“${named}”` : 'a control'} in ${target} and report whether it is there.`
    case 'ui_wait_for':
      return `Wait until ${named ? `“${named}”` : 'a control'} appears in ${target}, then carry on.`
    case 'ui_click':
      return `Press ${named ? `“${named}”` : 'a control'} in ${target} through the accessibility API — the same thing a screen reader does, in a window that does not have to be in front.`
    case 'ui_menu':
      return `Open ${target}’s ${formatMenuPath(params.path)} menu item from its menu bar.`
    default:
      return `${type || 'An unnamed step'} (no accessibility-mode description; this step is not in the vocabulary).`
  }
}

function formatMenuPath(value) {
  const parts = Array.isArray(value) ? value.filter(Boolean).map(String) : []
  return parts.length ? parts.join(' › ') : 'menu bar'
}

/** The vocabulary as a page of text, for /vision-loop/status and for humans. */
export function describePolicy() {
  return {
    mode: 'accessibility',
    steps: VISION_LOOP_STEPS.map((type) => ({
      type,
      readOnly: VISION_LOOP_READ_ONLY.has(type),
      does: describeStep({ type, params: {} }),
      requires: requirementsFor(type),
    })),
    excluded: Object.entries(VISION_LOOP_EXCLUSIONS).map(([type, reason]) => ({ type, reason })),
    needs: [ACCESSIBILITY_GRANT],
    doesNotNeed: [SCREEN_RECORDING_GRANT],
    pressFallback: PRESS_FALLBACK,
    menuActivation: MENU_ACTIVATION,
    note: 'Structural, not advisory. An action absent from the vocabulary cannot be reached from this loop whatever a model emits and whatever text it reads on screen.',
  }
}

/* Exported so the drift test can compare against the general loop's vocabulary
 * without reaching into computerUseLoop from the test file and pinning a second
 * import of it. */
export function unclassifiedGeneralLoopActions() {
  return [...LOOP_ALLOWED_ACTIONS].filter(
    (type) => !VISION_LOOP_VOCABULARY.has(type) && !VISION_LOOP_EXCLUSIONS[type],
  )
}
