/*
 * DID THE RUN DO WHAT WAS ASKED, OR ONLY WHAT THE PLAN CONTAINED?
 *
 * THE INCIDENT THIS FILE EXISTS TO FIX (2026-08-09)
 *
 * The owner sent "open ibkr and cancel my recurring investments" from the
 * browser extension. The planner produced two steps — open the site, snapshot
 * the page — both ran cleanly, and the run was stamped done: the executor's
 * completion criterion was "every planned step ran", and every planned step
 * had. Nothing was cancelled. The dashboard said Done anyway, because nothing
 * anywhere compared the STATED GOAL against the EFFECTS actually achieved.
 *
 * THE RULE
 *
 * A terminal verdict is a claim about the goal, not about the plan. A goal
 * that asks for a change ("cancel", "send", "delete", "pay") is only done when
 * a step that ACTS — not one that merely looks — ran at that goal and
 * succeeded. Steps that opened, read, snapshotted or scrolled are real work
 * and are reported as such, but they never complete a change on their own.
 * When the change never ran, the verdict is `incomplete`, and its user-facing
 * text names both halves: what WAS done, and what was NOT.
 *
 * When the unmet remainder is irreversible or outward-facing — actionRisk.js's
 * tier: destroying data, reaching another person, spending money, changing
 * standing arrangements — the remainder is stamped needs_approval-compatible
 * (pipelineTrace.NEEDS_APPROVAL_STATUS), so the approval-at-origin flow can
 * pick it up as a question addressed to the owner. This file only SHAPES that
 * question; it delivers nothing and gates nothing.
 *
 * THE HONEST LIMIT
 *
 * This is a recogniser, not a witness. It can tell "nothing even tried" from
 * "an acting step aimed at the goal ran and reported success"; it cannot
 * verify from here that a remote site really carried the change out. So the
 * bias is the same as scriptEffects.js's: pure observation never rounds up to
 * done, and an acting step at the goal is believed exactly as far as its own
 * per-step result — which is the same evidence every other verdict in this
 * process stands on.
 */

import { stripContextTrailer } from './callerContext.js'
import { NEEDS_APPROVAL_STATUS } from './pipelineTrace.js'
import { analyzeAppleScript, analyzeShellCommand } from './scriptEffects.js'

/* ------------------------------------------------------------ the goal */

/*
 * Change verbs, grouped by EFFECT — the same vocabulary actionRisk.js's
 * CONFIRM_REASONS speaks. `approval: true` mirrors that file's tier line
 * (irreversible or outward-facing needs a human): those groups' unmet
 * remainders are stamped needs_approval. Reversible local changes (create a
 * note, set the volume) still make a goal a change goal — a run that only
 * looked at them is still not done — but their remainder waits without an
 * approval claim.
 *
 * Verbs are BASE FORM only, on purpose: commands are imperative ("cancel my
 * …"), while past participles show up in read requests ("show my cancelled
 * orders"), and \b after the base form naturally rejects "cancelled".
 */
const CHANGE_VERB_GROUPS = [
  {
    id: 'cancel',
    verbs: ['cancel'],
    gerund: 'cancelling',
    negative: 'nothing was cancelled',
    approval: true,
    why: 'changes a standing arrangement that cannot be undone from here',
  },
  {
    id: 'delete',
    verbs: ['delete', 'remove', 'erase', 'discard', 'empty', 'uninstall'],
    gerund: 'removing',
    negative: 'nothing was deleted or removed',
    approval: true,
    why: 'destroys something that cannot be brought back from here',
  },
  {
    id: 'unsubscribe',
    verbs: ['unsubscribe', 'opt out'],
    gerund: 'unsubscribing',
    negative: 'nothing was unsubscribed',
    approval: true,
    why: 'changes a standing arrangement outside this Mac',
  },
  {
    id: 'send',
    verbs: ['send', 'email', 'text', 'message', 'reply', 'forward'],
    gerund: 'sending',
    negative: 'nothing was sent',
    approval: true,
    why: 'reaches another person on your behalf',
  },
  {
    id: 'pay',
    verbs: [
      'pay',
      'buy',
      'purchase',
      'order',
      'checkout',
      'book',
      'reserve',
      'subscribe',
      'donate',
      'renew',
    ],
    gerund: 'buying',
    negative: 'nothing was bought, booked, or paid for',
    approval: true,
    why: 'spends your money',
  },
  {
    id: 'transfer',
    verbs: ['transfer', 'withdraw', 'deposit', 'wire'],
    gerund: 'moving',
    negative: 'no money was moved',
    approval: true,
    why: 'moves your money',
  },
  {
    id: 'post',
    verbs: ['post', 'publish', 'share', 'tweet', 'upload', 'submit'],
    gerund: 'posting',
    negative: 'nothing was posted or submitted',
    approval: true,
    why: 'puts something where other people will see it',
  },
  {
    id: 'signout',
    verbs: ['sign out', 'log out', 'deactivate', 'unpair'],
    gerund: 'signing out of',
    negative: 'nothing was signed out or deactivated',
    approval: true,
    why: 'changes account state that is painful to restore',
  },
  /* Reversible, local, or self-directed changes: still change goals, no
   * approval claim on the remainder. */
  {
    id: 'create',
    verbs: [
      'create',
      'make',
      'add',
      'write',
      'compose',
      'draft',
      'schedule',
      'set up',
      'save',
    ],
    gerund: 'creating',
    negative: 'nothing was created',
    approval: false,
    why: null,
  },
  {
    id: 'file',
    verbs: ['move', 'copy', 'rename', 'archive', 'organize', 'organise', 'sort', 'tidy'],
    gerund: 'moving',
    negative: 'nothing was moved or renamed',
    approval: false,
    why: null,
  },
  {
    id: 'update',
    verbs: [
      'update',
      'change',
      'edit',
      'modify',
      'set',
      'turn off',
      'turn on',
      'turn',
      'enable',
      'disable',
      'toggle',
      'switch',
      'mute',
      'unmute',
      'install',
      'stop',
      'pause',
      'resume',
      'close',
    ],
    gerund: 'changing',
    negative: 'nothing was changed',
    approval: false,
    why: null,
  },
].map((group) => ({
  ...group,
  pattern: new RegExp(
    `\\b(?:${group.verbs.map((verb) => verb.split(' ').join('\\s+')).join('|')})\\b`,
    'i',
  ),
}))

/* A question about the past or about state is a read, whatever verbs it
 * quotes: "did I cancel my subscription" wants an answer, not a cancellation. */
const INTERROGATIVE_START =
  /^\s*(?:what|what's|when|who|whose|where|why|how|did|does|have|has|had|am|is|are|was|were|show me|tell me|list|check whether|check if)\b/i

/* "make sure", "make certain": a verification framed with a change verb. */
const MAKE_SURE = /^\s*(?:sure|certain)\b/i

/* A change verb governed by a negation is not a request for the change. */
const NEGATED_BEFORE = /\b(?:don'?t|do not|never|without|not|no)\s*$/i

/* A determiner right before the word means it is being used as a NOUN —
 * "read the text", "check my order", "open the book" — not as the verb the
 * group is named for. Imperative verb uses are never preceded this way. */
const DETERMINER_BEFORE =
  /\b(?:the|a|an|my|your|our|his|her|their|its|this|that|these|those|of|in|on|per)\s*$/i

const OBJECT_STOPWORDS = new Set([
  'the', 'a', 'an', 'my', 'your', 'our', 'his', 'her', 'their', 'its',
  'all', 'any', 'some', 'every', 'each', 'this', 'that', 'these', 'those',
  'please', 'for', 'from', 'with', 'into', 'onto', 'about',
])

/**
 * What the command is asking for. Pure text analysis, no model call.
 *
 * @returns {{
 *   text: string,
 *   wantsChange: boolean,
 *   group: object|null,      // matched CHANGE_VERB_GROUPS entry
 *   verb: string|null,       // the exact matched verb text
 *   object: string|null,     // "your recurring investments" (my → your)
 *   objectWords: string[],   // lowercased content-word stems for matching
 *   gerundPhrase: string|null, // "cancelling your recurring investments"
 * }}
 */
export function describeGoal(command) {
  /*
   * STRIPPED FIRST, ALWAYS. Everything below reads the command as a SENTENCE —
   * objectAfter() takes the words after the verb, stops at the first clause
   * boundary and keeps seven — so a surface's provenance trailer is not extra
   * noise here, it is grammar. Observed live 2026-08-09: the extension's
   * "[Sent from the browser extension. Active page: …]" supplied the boundary
   * with "extension.", and the owner was told "Cancelling all your recurring
   * investments on ibkr [Sent is still to do."
   *
   * Unconditional even though /plan now takes a first-class `context` and
   * strips the trailer on the way in, because this function is also called on
   * jobs recorded BEFORE that existed, and by callers that never went through
   * /plan at all. A sentence-reader that trusts its input to be clean is the
   * bug; this is the fix.
   */
  const text = stripContextTrailer(command).trim()
  const none = {
    text,
    wantsChange: false,
    group: null,
    verb: null,
    object: null,
    objectWords: [],
    gerundPhrase: null,
  }
  if (!text || INTERROGATIVE_START.test(text)) return none

  /* Earliest surviving change-verb match wins, so "open ibkr and cancel my
   * recurring investments" is the cancel goal, not the open one. */
  let earliest = null
  for (const group of CHANGE_VERB_GROUPS) {
    const pattern = new RegExp(group.pattern.source, 'ig')
    let match
    while ((match = pattern.exec(text))) {
      const before = text.slice(Math.max(0, match.index - 24), match.index)
      if (NEGATED_BEFORE.test(before) || DETERMINER_BEFORE.test(before)) continue
      const after = text.slice(match.index + match[0].length)
      if (/^make$/i.test(match[0]) && MAKE_SURE.test(after)) continue
      if (!earliest || match.index < earliest.index) {
        earliest = { group, verb: match[0], index: match.index, after }
      }
      break
    }
  }

  if (!earliest) return none

  const object = objectAfter(earliest.after)
  const gerundPhrase = [earliest.group.gerund, object ?? 'it']
    .join(' ')
    .trim()

  return {
    text,
    wantsChange: true,
    group: earliest.group,
    verb: earliest.verb,
    object,
    objectWords: contentWords(object),
    gerundPhrase,
  }
}

/** The words after the verb, up to a clause boundary, addressed to the owner. */
function objectAfter(tail) {
  const clause = String(tail ?? '')
    .split(/[,.;!?]|\b(?:and|then|when|after|before|once|via|so that)\b/i)[0]
    .trim()
  if (!clause) return null
  const words = clause.split(/\s+/).slice(0, 7)
  const phrase = words.join(' ').trim()
  if (!phrase) return null
  /* Second person, because the verdict is a sentence addressed to the owner. */
  return phrase.replace(/^my\b/i, 'your').replace(/\bmy\b/gi, 'your')
}

/** Lowercased stems of the content words, for matching against step text. */
function contentWords(object) {
  if (!object) return []
  return String(object)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !OBJECT_STOPWORDS.has(word))
    .map((word) => word.replace(/s$/, ''))
}

/* ------------------------------------------------------------ the steps */

/*
 * Steps that only reveal: navigation and looking. Aligned with
 * actionReceipts.READ_ONLY_TYPES, plus the navigations (open_url, open_app,
 * browser_navigate…) that receipts call writes because they poke the screen —
 * for THIS question they are observation: opening a page never completes a
 * change goal, which is the exact lie the incident told.
 */
const OBSERVE_TYPES = new Set([
  'open_url',
  'open_app',
  'open_path',
  'open_folder',
  'browser_navigate',
  'browser_open_session',
  'browser_close_session',
  'browser_list_sessions',
  'browser_list_tabs',
  'browser_read_page',
  'browser_snapshot',
  'browser_capture',
  'browser_wait_for',
  'browser_scroll',
  'browser_inspect',
  'scroll',
  'mouse_move',
  'ui_snapshot',
  'ui_find',
  'ui_wait_for',
  'ui_hit_test',
  'screenshot',
  'zoom',
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
  'check_input_permissions',
  'cursor_position',
  'list_displays',
  'list_briefings',
  'translate_text',
  'preview_plan',
  'sweep_folder_preview',
  'tidy_downloads_preview',
  'ios_status',
  'ios_ocr',
  'ios_screenshot',
  'ios_open_app',
  'ios_home',
  'ios_back',
  'ios_swipe',
  'ios_scroll',
])

/* Steps that change state by their type alone. */
const MUTATE_TYPES = new Set([
  'write_file',
  'delete_path',
  'move_path',
  'copy_path',
  'create_note',
  'create_reminder',
  'remind_me',
  'quick_capture',
  'compose_briefing',
  'send_email',
  'send_message',
  'sweep_folder_apply',
  'sweep_folder_undo',
  'tidy_downloads_apply',
  'run_project',
  'set_clipboard',
  'copy_to_clipboard',
])

/* An action type that inherently PERFORMS a verb group, so a send_email step
 * carries a "send" goal even when its label never says the word. */
const TYPE_PERFORMS = new Map([
  ['send_email', 'send'],
  ['send_message', 'send'],
  ['delete_path', 'delete'],
  ['write_file', 'create'],
  ['create_note', 'create'],
  ['compose_briefing', 'create'],
  ['quick_capture', 'create'],
  ['create_reminder', 'create'],
  ['remind_me', 'create'],
  ['move_path', 'file'],
  ['copy_path', 'file'],
  ['sweep_folder_apply', 'file'],
  ['tidy_downloads_apply', 'file'],
  ['set_volume', 'update'],
  ['set_brightness', 'update'],
  ['set_mute', 'update'],
])

/**
 * observe | interact | mutate, for one step.
 *
 * run_shell / run_applescript are judged by BODY, not by name — the same
 * scriptEffects.js verdict actionRisk.js uses, reused rather than re-derived,
 * so `ls` observes and `rm` mutates. An unknown type falls back to the
 * receipt's own effect record when one rode in on the result, and to
 * 'interact' otherwise — never to 'observe', because unknown must not round up
 * to "only looked".
 */
export function stepTier(action, result = null) {
  const type = String(action?.type || '')
  if (type === 'run_shell') {
    const command = action?.params?.command ?? action?.command
    return analyzeShellCommand(command).read ? 'observe' : 'mutate'
  }
  if (type === 'run_applescript') {
    const script = action?.params?.script ?? action?.script
    return analyzeAppleScript(script).read ? 'observe' : 'mutate'
  }
  if (OBSERVE_TYPES.has(type)) return 'observe'
  if (MUTATE_TYPES.has(type)) return 'mutate'
  if (result?.receipt?.effect === 'read') return 'observe'
  return 'interact'
}

/** Does this acting step aim at the goal — by verb, by type, or by object? */
function carriesGoal(goal, action) {
  const type = String(action?.type || '')
  if (TYPE_PERFORMS.get(type) === goal.group.id) return true

  let paramsText
  try {
    paramsText = JSON.stringify(action?.params ?? {})
  } catch {
    paramsText = ''
  }
  const text = `${String(action?.label ?? '')} ${paramsText} ${
    String(action?.params?.command ?? '')} ${String(action?.params?.script ?? '')}`

  if (goal.group.pattern.test(text)) return true
  const lower = text.toLowerCase()
  return goal.objectWords.some((word) => lower.includes(word))
}

/* --------------------------------------------------- what actually ran */

const LOOK_PHRASE_TYPES = new Set([
  'ui_snapshot',
  'browser_snapshot',
  'browser_read_page',
  'browser_capture',
  'browser_inspect',
  'screenshot',
  'zoom',
  'ui_find',
  'ios_ocr',
  'ios_screenshot',
])

function phraseForStep(action, result) {
  const type = String(action?.type || '')
  if (LOOK_PHRASE_TYPES.has(type)) return 'looked at the page'
  if (type === 'read_file') return 'read the file'
  if (type === 'list_directory') return 'listed the folder'
  if (type === 'browser_list_tabs') return 'listed the open tabs'
  const message = String(result?.message ?? '').replace(/\s+/g, ' ').trim()
  if (message) return clip(message, 90)
  const label = String(action?.label ?? action?.type ?? 'a step').trim()
  return clip(label, 90)
}

/** "Opened https://… and looked at the page" — the truthful half of done. */
function describeWhatRan(steps) {
  const phrases = []
  for (const step of steps) {
    if (step.result?.ok === false) continue
    const phrase = phraseForStep(step.action, step.result)
    if (!phrases.includes(phrase)) phrases.push(phrase)
    if (phrases.length === 3) break
  }
  if (!phrases.length) return 'The planned steps ran'
  const [first, ...rest] = phrases
  const opened = first.charAt(0).toUpperCase() + first.slice(1)
  return [opened, ...rest.map(lowerLead)].join(' and ')
}

function lowerLead(phrase) {
  /* Lowercase a leading capital only when it starts an ordinary word, so a
   * URL or an app name survives the join untouched. */
  return /^[A-Z][a-z]/.test(phrase)
    ? phrase.charAt(0).toLowerCase() + phrase.slice(1)
    : phrase
}

/* ------------------------------------------------------------ verdicts */

/**
 * Compare the stated goal against the effects the run actually achieved.
 *
 * `results` are the executor's own per-step outcomes — the same records the
 * execution journal derives from — so the verdict stands on evidence that
 * already exists rather than on a second opinion.
 */
export function assessGoalOutcome({ command, actions = [], results = [] } = {}) {
  const goal = describeGoal(command)
  const steps = (results.length ? results : actions.map(() => null)).map(
    (result, index) => ({
      action: result?.action ?? actions[index] ?? {},
      result,
    }),
  )

  if (!goal.wantsChange) {
    /* A look/answer goal: the steps' own outcomes are the whole story, which
     * is exactly what the caller already computed. Nothing to add. */
    return {
      goal,
      met: true,
      attempted: null,
      carriers: 0,
      status: 'done',
      headline: null,
      summary: null,
      remainder: null,
    }
  }

  /* An acting step aimed at the goal, that actually ran and did not fail.
   * Planned-but-never-run carriers (a drift stop) are precisely NOT attempts. */
  const carriers = steps.filter(
    (step) =>
      step.result != null &&
      step.result.ok !== false &&
      stepTier(step.action, step.result) !== 'observe' &&
      carriesGoal(goal, step.action),
  )

  if (carriers.length) {
    return {
      goal,
      met: true,
      attempted: true,
      carriers: carriers.length,
      status: 'done',
      headline: null,
      summary: null,
      remainder: null,
    }
  }

  const did = describeWhatRan(steps)
  const headline = `${did} — ${goal.group.negative}.`
  const gerund =
    goal.gerundPhrase.charAt(0).toUpperCase() + goal.gerundPhrase.slice(1)
  const remainderText = goal.group.approval
    ? `${gerund} is still to do, and it ${goal.group.why} — the next step needs your approval.`
    : `${gerund} is still to do.`

  return {
    goal,
    met: false,
    attempted: false,
    carriers: 0,
    status: 'incomplete',
    headline,
    summary: `${headline} ${remainderText}`,
    remainder: {
      text: remainderText,
      goalText: goal.text,
      gerundPhrase: goal.gerundPhrase,
      needsApproval: Boolean(goal.group.approval),
      /* The approval-at-origin flow keys on this exact word (pipelineTrace
       * exports it); a remainder that waits without an approval claim says
       * 'pending' instead. */
      status: goal.group.approval ? NEEDS_APPROVAL_STATUS : 'pending',
      reason: goal.group.approval
        ? `The remaining step ${goal.group.why}, so it needs your approval.`
        : null,
    },
  }
}

/**
 * The one merge rule the orchestrator applies: a run whose steps all
 * succeeded is only 'success' if the goal check agrees; otherwise it is
 * 'incomplete' and `response` is the sentence that names both halves. Step
 * failures, blocks and drift keep their existing statuses — those are already
 * honest about not being done.
 */
export function applyGoalVerdict({ command, actions = [], results = [], status }) {
  const verdict = assessGoalOutcome({ command, actions, results })
  if (status !== 'success' || verdict.met) {
    return { status, verdict, response: null }
  }
  return { status: 'incomplete', verdict, response: verdict.summary }
}

/**
 * The same comparison, before anything runs: does this plan even contain an
 * acting step aimed at the goal? Used by the planner to mark a look-only plan
 * for a change goal as reconnaissance rather than as the whole task.
 */
export function assessPlanCoverage(command, actions = []) {
  const goal = describeGoal(command)
  if (!goal.wantsChange || !actions.length) {
    return { goal, reconnaissance: false, note: null }
  }
  const carried = actions.some(
    (action) => stepTier(action) !== 'observe' && carriesGoal(goal, action),
  )
  if (carried) return { goal, reconnaissance: false, note: null }
  return {
    goal,
    reconnaissance: true,
    note: `Reconnaissance only: these steps look but do not act, so ${goal.gerundPhrase} will still be left to do.`,
  }
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
