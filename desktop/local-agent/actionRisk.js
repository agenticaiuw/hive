/*
 * A pendant command is hands-free: there is no screen to confirm on and no
 * keyboard to cancel with. It is also remote — the command text arrives from
 * the cloud relay work queue, so whatever can enqueue a job is what this
 * allowlist is actually protecting the Mac against.
 *
 * THE RULE: IRREVERSIBLE OR OUTWARD-FACING NEEDS A HUMAN; READING DOES NOT.
 *
 * The owner said the sentence out loud. That IS the authorization for a read.
 * Approval exists for the things a read can never be — destroying data,
 * changing state, reaching another person, spending money — and asking for it
 * on a look is not caution, it is a broken product: the request dies on a
 * device with no screen and no speaker, and the owner hears nothing.
 *
 * WHICH MEANS THE QUESTION IS "WHAT DOES THIS DO", NOT "WHAT IS THIS MADE OF".
 *
 * This file used to answer by action TYPE alone, which put "read my Safari
 * Reading List" and "empty my trash" in the same tier because both are
 * AppleScript, and `ls` in the same tier as `rm -rf` because both are
 * run_shell. On 2026-08-09 that parked a spoken request for four reading-list
 * items behind an approval nobody had asked for. So the two types whose risk
 * lives in their ARGUMENT — run_shell and run_applescript — are now classified
 * by what the script body actually does (scriptEffects.js), and an unreadable
 * or mixed body is not a read.
 *
 * The types whose risk lives in the type itself do not move: write_file,
 * copy_path and move_path change things; delete_path, send_email, send_message
 * and computer_use_task are the irreversible/outward tier and are also the
 * routine deny-list at the bottom of this file. run_project stays too — it runs
 * whatever a project's own script says today, which nothing here can see.
 */

import { capabilityGapHandsFree } from './capabilityGapsActions.js'
import { analyzeAppleScript, analyzeShellCommand } from './scriptEffects.js'

const AUTO_SAFE_ACTIONS = new Set([
  'open_app',
  'open_url',
  'open_path',
  'open_folder',
  'read_file',
  'list_directory',
  'screenshot',
  'zoom',
  'ui_snapshot',
  'ui_find',
  'ui_click',
  'ui_menu',
  'ui_wait_for',
  'ui_hit_test',
  'mouse_move',
  'mouse_click',
  'scroll',
  'type_text',
  'press_keys',
  'set_brightness',
  'get_brightness',
  'set_volume',
  'get_volume',
  'set_mute',
  'create_reminder',
  'show_screen_overlay',
  'get_clipboard',
  'copy_to_clipboard',
  'set_clipboard',
  'play_youtube',
  // Structured status tools (prefer over freeform shell).
  'get_mac_status',
  'get_battery',
  /*
   * Answers, not effects. Every one of these reports something and writes
   * nothing: the cursor's coordinates, the attached displays, whether input
   * permissions are granted, the current keyboard layout, the clock, the
   * forecast, a translation, a filename search under one folder, the list of
   * briefings already made. They were denied only because nobody had put them
   * on the list, which is the same failure as the AppleScript one above with a
   * quieter symptom: "get_time is not on the hands-free allowlist."
   */
  'get_time',
  'get_weather',
  'get_input_source',
  'check_input_permissions',
  'cursor_position',
  'list_displays',
  'list_briefings',
  'search_file',
  'translate_text',
  /* Reading the owner's own Reminders and Calendar, spoken back to the owner.
   * There is nothing an approval prompt could protect here, and the pendant has
   * no screen to prompt on — which is the same reasoning get_time already got. */
  'list_reminders',
  'list_calendar_events',
  // Browser extension (hands-free when extension is online).
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_read_page',
  'browser_snapshot',
  'browser_wait_for',
  'browser_scroll',
  'browser_select',
  'browser_list_tabs',
  'browser_capture',
  'browser_press_key',
  'browser_open_session',
  'browser_list_sessions',
  'browser_close_session',
  // Quick capture, reminders and focus: said in one breath, to a device with no
  // screen to confirm on. Each writes only to the owner's own stores or to the
  // apps they were already asking for.
  'quick_capture',
  'recall_capture',
  'remind_me',
  'start_focus_session',
  'end_focus_session',
  'plan_my_day',
  'prepare_for_meeting',
  'triage_notifications',
  'tidy_downloads_preview',
  // Apply is here rather than in CONFIRM_REASONS because it cannot act on its
  // own: it replays a stored plan by id, and the only way to get an id is a
  // preview the owner has already been shown. The gate is the shape of the API,
  // not a prompt.
  'tidy_downloads_apply',
  // Looking costs nothing and changes nothing: a folder survey, a plan preview,
  // and a page read with citations are all pure description.
  'sweep_folder_preview',
  'preview_plan',
  'browser_inspect',
  // Same shape as tidy_downloads_apply: these replay a stored, already-shown
  // plan by id and cannot invent one. Nothing is being withheld from the owner
  // here — they can still call move_path, delete_path or browser_click directly
  // and have them run immediately, exactly as before.
  'sweep_folder_apply',
  'sweep_folder_undo',
  'browser_inspect_act',
  /*
   * The owner's real iPhone, through iPhone Mirroring.
   *
   * Reading is free: ios_status asks whether mirroring is connected, and
   * ios_ocr / ios_screenshot read the screen that is already there.
   *
   * Touching is ORDINARY, on the same footing as ui_click, type_text and
   * scroll on the Mac side — and that is deliberate, not an oversight. A phone
   * task is a dozen taps ("open Instacart, reorder my usual"); a dozen
   * approval prompts is not an agent, it is a very slow remote control. What
   * gets approved here is the PLAN, exactly as it is for the Mac's own UI
   * actions, and the steps then run.
   *
   * The narrow exception is IOS_CONFIRM_TARGET below: a tap or a keystroke
   * aimed at something irreversible or outward-facing still stops and asks.
   * classifyAction consults it for every ios_tap_text / ios_type_text, so
   * these entries mean "ordinary unless the target says otherwise".
   */
  'ios_status',
  'ios_ocr',
  'ios_screenshot',
  'ios_open_app',
  'ios_home',
  'ios_back',
  'ios_swipe',
  'ios_scroll',
  'ios_tap_text',
  'ios_type_text',
])

/*
 * The line between "go" and "ask" on a phone.
 *
 * The principle is not "touching is dangerous" — it is that some touches
 * cannot be taken back and some reach other people. Navigating, searching,
 * scrolling and opening things are reversible and private: they run. Paying,
 * ordering, sending, deleting and unsubscribing are not, and neither is
 * handing over a password or a card number: they ask.
 *
 * This is matched against the text the tap is AIMED at — the label the agent
 * itself chose from OCR — so it fires on "Place Order" and "Send" without
 * knowing anything about the app. It is deliberately narrow. Widening it until
 * ordinary navigation trips it would recreate the per-tap prompting this
 * design exists to avoid; leaving it out entirely would let a hallucinated
 * planner step buy something.
 */
const IOS_CONFIRM_TARGET =
  /\b(pay|paying|payment|buy|purchase|checkout|check ?out|place (?:the )?order|confirm (?:and )?(?:order|purchase|payment|pay)|order now|send|sending|share|post|publish|delete|remove|erase|unsubscribe|cancel subscription|transfer|withdraw|deposit|wire|sign out|log ?out|reset|factory)\b/i

/* A field the SCREEN calls a secret. The planner reads the screen before it
 * types, so it can say which field it is typing into; when it does, and the
 * label looks like this, typing stops and asks. */
const IOS_SECRET_FIELD =
  /\b(password|passcode|pass ?phrase|pin|cvv|cvc|security code|card number|credit card|social security|ssn|one[- ]time code|2fa|verification code)\b/i

/* A payment card, by shape, whatever the field claims to be. */
const IOS_CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/

/**
 * Why this phone touch needs approval, or null if it may just run.
 *
 * Exported because the routine venue asks the same question: a schedule that
 * fires at 3am must not be able to tap "Place Order" while nobody is looking.
 */
export function iosConfirmReason(action) {
  const type = String(action?.type || '')
  const params = action?.params ?? {}

  if (type === 'ios_tap_text') {
    const target = String(params.query ?? params.text ?? params.label ?? '')
    if (IOS_CONFIRM_TARGET.test(target)) {
      return `Tapping "${target.trim()}" on your iPhone could be irreversible or send something, so it needs your approval.`
    }
    return null
  }

  if (type === 'ios_type_text') {
    const field = String(params.field ?? params.fieldLabel ?? params.label ?? '')
    if (IOS_SECRET_FIELD.test(field)) {
      return 'Typing into a password or payment field on your iPhone needs your approval.'
    }
    const text = String(params.text ?? params.value ?? '')
    if (IOS_SECRET_FIELD.test(text) || IOS_CARD_NUMBER.test(text)) {
      return 'That looks like a card number or a secret, so typing it on your iPhone needs your approval.'
    }
    return null
  }

  return null
}

/*
 * Why each of these is held, said in terms of EFFECT rather than mechanism.
 *
 * "Running AppleScript needs your approval" told a future reader of a parked
 * plan nothing except which API was involved. These sentences have to survive
 * being read cold, months later, by someone deciding whether to approve.
 *
 * run_shell and run_applescript keep an entry here as the fallback for a body
 * this file could not read at all; when the body IS readable, classifyAction
 * replaces it with what the script would actually have done.
 */
const CONFIRM_REASONS = new Map([
  [
    'run_shell',
    'That shell command does more than report something, so it needs your approval.',
  ],
  [
    'run_project',
    'A project command runs whatever that project’s script says today, which nothing here can see in advance, so it needs your approval.',
  ],
  [
    'run_applescript',
    'That script changes an app rather than only reading from it, so it needs your approval.',
  ],
  ['write_file', 'Writing a file changes what is on disk, so it needs your approval.'],
  [
    'copy_path',
    'Copying puts a second file somewhere it was not, so it needs your approval.',
  ],
  [
    'move_path',
    'Moving takes a file out of where you left it, so it needs your approval.',
  ],
  [
    'delete_path',
    'Deleting cannot be taken back from here, so it needs your approval.',
  ],
  ['send_email', 'Sending email acts on your behalf and needs approval.'],
  ['send_message', 'Sending a message acts on your behalf and needs approval.'],
  [
    'computer_use_task',
    'Driving the screen on its own can do anything you can do, so it needs your approval.',
  ],
])

// Block composition / writes / network exfil.
const SHELL_METACHAR = /[|;&`$<>\n\r]|&&|\|\||>>|<</

// Narrow read-only status / inventory commands only (whole-command match).
const STATUS_SHELL_PATTERNS = [
  /^pmset(\s|$)/i,
  /^df(\s|$)/i,
  /^sw_vers(\s|$)/i,
  /^uname(\s|$)/i,
  /^uptime(\s|$)/i,
  /^date(\s|$)/i,
  /^whoami(\s|$)/i,
  /^hostname(\s|$)/i,
  /^pwd(\s|$)/i,
  /^system_profiler\s+SP(Power|Hardware|Network)DataType\b/i,
  /^scutil\s+--(nwi|dns|get)\b/i,
  /^networksetup\s+-get(airportnetwork|info)\b/i,
  /^sysctl\s+(hw\.|kern\.|machdep\.)/i,
  /^defaults\s+read\b/i,
  // Launch apps / URLs (same effect as open_app / open_url).
  /^open\s+-a\s+(".+?"|'.+?'|\S+)/i,
  /^open\s+https?:\/\/\S+/i,
]

/**
 * True for a narrow set of inventory / status / open commands that are safe
 * to run hands-free from the pendant (Realtime battery path depends on this).
 */
export function isStatusShellCommand(command) {
  const cmd = String(command || '').trim()
  if (!cmd || cmd.length > 240) return false
  if (SHELL_METACHAR.test(cmd)) return false
  if (/^\s*(sudo|doas)\b/i.test(cmd)) return false
  if (
    /\b(curl|wget|nc|ssh|python|node|ruby|perl|bash\s+-c|zsh\s+-c|osascript)\b/i.test(
      cmd,
    )
  ) {
    return false
  }
  return STATUS_SHELL_PATTERNS.some((re) => re.test(cmd))
}

export function classifyAction(action) {
  /* Returns null for everything else, so no existing verdict moves. Without it
   * a spoken request for the cross-account brief ends at "waiting for your
   * approval on the dashboard" — on a device that has no dashboard. */
  const gap = capabilityGapHandsFree(action)
  if (gap) return gap

  const type = String(action?.type || '')
  if (!type) return { safe: false, reason: 'Action has no type.' }

  /*
   * The two types whose risk is in the argument, not the name. Both consult
   * scriptEffects.js, which reads the body and answers one question — does this
   * only look? — and answers "no" whenever it cannot tell.
   */
  if (type === 'run_shell') {
    const command = action?.params?.command ?? action?.command
    /* The older, narrower status allowlist still stands on its own: it clears a
     * couple of things that are not reads at all (`open -a Notes`) on the
     * separate ground that they are identical to open_app, which is already
     * hands-free. */
    if (isStatusShellCommand(command)) return { safe: true }
    const shell = analyzeShellCommand(command)
    if (shell.read) return { safe: true }
    return {
      safe: false,
      reason: shell.why
        ? `That shell command ${shell.why}, so it needs your approval.`
        : CONFIRM_REASONS.get('run_shell'),
    }
  }

  if (type === 'run_applescript') {
    const script = action?.params?.script ?? action?.script
    const applescript = analyzeAppleScript(script)
    if (applescript.read) return { safe: true }
    return {
      safe: false,
      reason: applescript.why
        ? `That script ${applescript.why}, so it needs your approval.`
        : CONFIRM_REASONS.get('run_applescript'),
    }
  }

  const confirmReason = CONFIRM_REASONS.get(type)
  if (confirmReason) return { safe: false, reason: confirmReason }

  /* Phone touches are ordinary; the target is what can promote one. Checked
   * before the allowlist so the promotion cannot be short-circuited by the
   * type simply being on it. */
  const phoneReason = iosConfirmReason(action)
  if (phoneReason) return { safe: false, reason: phoneReason }

  if (AUTO_SAFE_ACTIONS.has(type)) return { safe: true }
  return { safe: false, reason: `${type} is not on the hands-free allowlist.` }
}

export function classifyPlan(actions) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) {
    return { autoRun: false, blocked: [], reason: 'No actions to run.' }
  }
  const blocked = []
  for (const action of list) {
    const verdict = classifyAction(action)
    if (!verdict.safe) {
      blocked.push({ type: action?.type ?? 'unknown', reason: verdict.reason })
    }
  }
  return {
    autoRun: blocked.length === 0,
    blocked,
    reason: blocked.length
      ? blocked.map((entry) => entry.reason).join(' ')
      : '',
  }
}

/*
 * The ROUTINE venue.
 *
 * A schedule the owner wrote and enabled is standing approval for its own
 * purpose. The local runner has always worked that way — routines.js goes
 * orchestratePlan → orchestrateExecute with no approval gate at all, "so a
 * routine can do anything a spoken command can" — and cloud-relay/routines.js
 * dispatches a Mac-venue routine promising it "behaves identically whichever
 * side declared it; only the clock moved". Applying the pendant's hands-free
 * allowlist to those jobs broke that promise in production: the 7am briefing
 * planned a run_shell, parked for a dashboard nobody was looking at, and the
 * owner heard silence.
 *
 * So a routine plan auto-runs everything a voice command may run, plus the
 * confirm-tier work the routine's own command implies (run_shell, file writes,
 * AppleScript) — EXCEPT the deny-list below. Those are the action types whose
 * CONFIRM_REASONS text already says why: they act outward on the owner's
 * behalf (send_email, send_message), destroy data (delete_path), or hand the
 * whole screen to the model (computer_use_task), which is outward-capable by
 * construction. A hallucinated planner step must never become an email
 * somebody received while the owner slept. There is no first-class "purchase"
 * action in this stack; buying anything rides computer_use_task or a send_*
 * flow, so the same four entries cover it.
 */
export const ROUTINE_DENY_ACTIONS = new Set([
  'send_email',
  'send_message',
  'delete_path',
  'computer_use_task',
])

/**
 * classifyPlan for a routine-originated job.
 *
 * Same vocabulary, wider venue: `blocked` still reports what the VOICE
 * threshold would have held (kept for telemetry and the dashboard), while
 * `denied` is the list that actually parks a routine. autoRun is therefore
 * "nothing denied", not "nothing blocked".
 */
export function classifyPlanForRoutine(actions) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) {
    return { autoRun: false, blocked: [], denied: [], reason: 'No actions to run.' }
  }
  const voice = classifyPlan(list)
  /*
   * The phone joins the deny-list conditionally, by target rather than by type.
   *
   * Ordinary phone navigation is exactly the sort of thing a routine should be
   * able to do — check a delivery, open an app, read a screen. But the
   * reasoning that keeps send_email off this list applies unchanged to a tap
   * on "Place Order": a hallucinated planner step must never become a purchase
   * somebody finds in the morning. iosConfirmReason draws that line once, and
   * both venues use the same line.
   */
  const denied = list
    .filter(
      (action) =>
        ROUTINE_DENY_ACTIONS.has(String(action?.type || '')) ||
        iosConfirmReason(action),
    )
    .map((action) => ({
      type: String(action?.type),
      reason:
        CONFIRM_REASONS.get(String(action?.type)) ||
        iosConfirmReason(action) ||
        `${action?.type} never runs unattended.`,
    }))
  if (denied.length) {
    return {
      autoRun: false,
      blocked: voice.blocked,
      denied,
      reason: `${denied
        .map((entry) => entry.reason)
        .join(' ')} A scheduled routine cannot approve this on its own.`,
    }
  }
  return { autoRun: true, blocked: voice.blocked, denied: [], reason: '' }
}

/*
 * THE EFFECT TIER — read / act / outward — and the owner's ruling of 2026-08-11.
 *
 * The incident: the owner asked, by voice, "what's the latest email in my
 * Outlook account?" The plan was two steps — open Outlook, run an AppleScript
 * that only `get`s the newest message's subject and sender — and BOTH parked as
 * approval cards. Not because this file held them: classifyPlan clears that
 * exact plan. They parked because the PLANNER asked ("requiresConfirmation":
 * true), and the bridge honoured the model's ask over the taxonomy for every
 * step in the plan, harmless opener included. The owner's verbatim ruling:
 * "asking to read emails should not be something that needs permissions also i
 * specifically asked the agent to do that."
 *
 * So the model's caution needed a floor AND a ceiling, and both are stated in
 * the browser extension's vocabulary (browser-extension/src/affinity.js tags
 * every call read/act/outward) so the two halves of this product draw the same
 * line:
 *
 *   read    — looks at something and changes nothing: reading state, listing,
 *             screenshots of the owner's own screen, and — per the owner —
 *             opening an app or a page, which shows what was already there.
 *             A spoken request IS the authorization for a read. NOTHING may
 *             park a pure-read plan, not even the model's own ask: the ask
 *             lands on a device with no screen, and the request dies.
 *   act     — changes something local and recoverable: writes, moves, UI
 *             clicks, settings, scripts that do more than look. The model's
 *             judgement decides here, exactly as before; the per-type
 *             allowlist is the fallback when the model gave no verdict.
 *   outward — reaches another person, spends, destroys, or hands over the
 *             screen: send_email, send_message, delete_path,
 *             computer_use_task, a phone tap aimed at "Place Order", an
 *             AppleScript that sends/deletes rather than gets. These park
 *             ALWAYS. The owner asking out loud does not clear them, and
 *             neither does the model deciding not to ask — explicit-ask bias
 *             is a read-tier privilege only.
 */

/* Members of the hands-free allowlist that are also pure LOOKS. open_* is here
 * on the owner's say-so and on affinity.js's own reasoning ("a page named
 * /cancel-subscription has cancelled nothing by being looked at"). */
const READ_TIER_ACTIONS = new Set([
  'open_app',
  'open_url',
  'open_path',
  'open_folder',
  'read_file',
  'list_directory',
  'search_file',
  'screenshot',
  'zoom',
  'ui_snapshot',
  'ui_find',
  'ui_wait_for',
  'ui_hit_test',
  'cursor_position',
  'list_displays',
  'check_input_permissions',
  'get_clipboard',
  'get_brightness',
  'get_volume',
  'get_mac_status',
  'get_battery',
  'get_time',
  'get_weather',
  'get_input_source',
  'list_briefings',
  'list_reminders',
  'list_calendar_events',
  'translate_text',
  'recall_capture',
  'preview_plan',
  'sweep_folder_preview',
  'tidy_downloads_preview',
  'browser_read_page',
  'browser_snapshot',
  'browser_wait_for',
  'browser_list_tabs',
  'browser_capture',
  'browser_list_sessions',
  'browser_inspect',
  'ios_status',
  'ios_ocr',
  'ios_screenshot',
  'ios_open_app',
])

/*
 * The heuristic for a script that is not a read: does its body reach for an
 * outward verb? `send`, `make new outgoing message`, `delete` are how Mail and
 * Outlook scripts commit; a non-read script WITHOUT one of these is an 'act'
 * (it changes something, locally) rather than an 'outward'. Matched against
 * the raw body, strings included — a false positive parks a plan, a false
 * negative sends an email, and only one of those can be taken back.
 */
const OUTWARD_SCRIPT_VERB =
  /\b(send|post|reply|forward|share|publish|submit|delete|remove|erase|empty|unsubscribe|purchase|pay|order)\b/i

/**
 * Which tier one action sits in. The outward checks come first so nothing on
 * an allowlist can shadow them (same ordering classifyAction uses for the
 * phone's confirm targets).
 */
export function effectTierFor(action) {
  const type = String(action?.type || '')
  if (ROUTINE_DENY_ACTIONS.has(type)) return 'outward'
  if (iosConfirmReason(action)) return 'outward'
  if (type === 'run_shell') {
    const command = action?.params?.command ?? action?.command
    if (isStatusShellCommand(command)) return 'read'
    return analyzeShellCommand(command).read ? 'read' : 'act'
  }
  if (type === 'run_applescript') {
    const script = action?.params?.script ?? action?.script
    if (analyzeAppleScript(script).read) return 'read'
    return OUTWARD_SCRIPT_VERB.test(String(script ?? '')) ? 'outward' : 'act'
  }
  return READ_TIER_ACTIONS.has(type) ? 'read' : 'act'
}

/** Why this outward action is held — reusing the sentences a card already
 * prints, with the script heuristic's own sentence for the scripted case. */
function outwardReasonFor(action) {
  const type = String(action?.type || '')
  return (
    CONFIRM_REASONS.get(type) ??
    iosConfirmReason(action) ??
    (type === 'run_applescript'
      ? 'That script sends, deletes or posts rather than only reading, so it needs your approval.'
      : `${type} acts outward on your behalf, so it needs your approval.`)
  )
}

/**
 * The VOICE venue's whole decision, model verdict included.
 *
 * The bridge used to hold this logic itself ("THE MODEL'S JUDGEMENT WINS") and
 * the model's ask parked the Outlook read above. The precedence is now:
 *
 *   1. outward present  → park, whatever the model said (floor);
 *   2. every step reads → run, whatever the model said (ceiling — the owner's
 *                         spoken command is the explicit ask, and a read has
 *                         nothing an approval could protect);
 *   3. otherwise        → the model's verdict when it made one, else the
 *                         per-type hands-free line (classifyPlan), unchanged.
 *
 * `model` is { asked: boolean, reason: string } or null when the plan carried
 * no verdict at all.
 */
export function classifyPlanForVoice(actions, { model = null } = {}) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) {
    return { autoRun: false, blocked: [], reason: 'No actions to run.' }
  }

  const outward = list
    .filter((action) => effectTierFor(action) === 'outward')
    .map((action) => ({
      type: action?.type ?? 'unknown',
      reason: outwardReasonFor(action),
    }))
  if (outward.length) {
    return {
      autoRun: false,
      blocked: outward,
      reason: outward.map((entry) => entry.reason).join(' '),
    }
  }

  if (list.every((action) => effectTierFor(action) === 'read')) {
    return { autoRun: true, blocked: [], reason: '' }
  }

  if (model && typeof model.asked === 'boolean') {
    if (!model.asked) return { autoRun: true, blocked: [], reason: '' }
    const reason =
      String(model.reason || '').trim() ||
      'The planner asked for your approval on this step.'
    return {
      autoRun: false,
      blocked: list.map((action) => ({
        type: action?.type ?? 'unknown',
        reason,
      })),
      reason,
    }
  }

  return classifyPlan(list)
}
