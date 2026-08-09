/*
 * Affinity: work that originated in this browser and is doable BY this browser
 * runs HERE, and only the rest goes to the hive.
 *
 * THE FAILURE THIS EXISTS FOR, observed live on 2026-08-09: the owner typed
 * "open ibkr and cancel my recurring investments" into the extension popup.
 * The extension forwarded it to the hive, the Mac agent claimed it, and
 * interactivebrokers.com opened in the MAC's browser session — a different
 * profile, not signed in, nowhere near the owner. The command was born in a
 * browser and was executable by that browser; shipping it across the room was
 * pure loss. The owner's verdict: "it should just do it itself as a brain in
 * the browser extension node."
 *
 * THE RULE, so it can be asserted rather than felt:
 *
 *   1. Every plan step gets a CAPABILITY tag from a closed table
 *      (`LOCAL_CLAIMABLE_ACTIONS` ∪ the extension's own COMMAND_TYPES →
 *      'browser'; everything else → 'hive'). No text matching, no guessing:
 *      a step is browser-capable if and only if this module can translate it
 *      into one of the extension's own validated page commands.
 *   2. routePlan: a non-empty plan whose EVERY step tags 'browser' executes
 *      locally. One 'hive' step anywhere and the whole plan forwards to the
 *      hive exactly as before — the extension does not split plans, because a
 *      half-executed plan with the other half on another machine is a state
 *      nobody can reason about.
 *   3. Every step also gets an EFFECT tag: 'read' | 'act' | 'outward'.
 *      'outward' — submitting an order, cancelling an arrangement, sending
 *      anything — NEVER auto-runs. It parks in the approval queue
 *      (execution-status.js) and waits for the owner. This tagging errs
 *      toward 'outward': the cost of over-tagging is one approval tap, the
 *      cost of under-tagging is a cancelled investment nobody asked for.
 *   4. Completion is reported from the ledger of what ran, not from what a
 *      model claims. A run that only read says so ("changed nothing"); a run
 *      whose command asked for an outward effect that never ran says the
 *      effect did NOT happen.
 *
 * Everything here is pure — no browser APIs, no fetch, no storage — so the
 * whole policy is unit-testable in plain node, the same split relay-peer.js
 * uses. background.js supplies the impure edges.
 */
import { COMMAND_TYPES } from './bridge-core.js'

export const CAPABILITY_BROWSER = 'browser'
export const CAPABILITY_HIVE = 'hive'

export const EFFECT_READ = 'read'
export const EFFECT_ACT = 'act'
export const EFFECT_OUTWARD = 'outward'

/*
 * Hive planner action types this browser can claim, and the local command each
 * one becomes. Closed and explicit on purpose: adding an entry here is the
 * only way a hive-vocabulary step can execute locally, so the diff that widens
 * local execution is always one visible line in this table.
 *
 * The browser_* family is the Mac planner asking for THIS extension by name —
 * the Mac executes those by queueing them back over the bridge, so running
 * them here just removes a round trip through a machine that may be asleep.
 *
 * `open_url` is the failure case itself: the Mac runs it with `open <url>` in
 * the MAC's own browser session. When the command came from this browser,
 * "open a URL" means "in front of the owner", which is `activate_tab` here —
 * focus the signed-in tab if one exists, open it if not.
 */
export const LOCAL_CLAIMABLE_ACTIONS = Object.freeze({
  browser_navigate: 'navigate',
  browser_click: 'click',
  browser_type: 'type',
  browser_read_page: 'read_page',
  browser_snapshot: 'snapshot',
  browser_wait_for: 'wait_for',
  browser_scroll: 'scroll',
  browser_select: 'select',
  browser_list_tabs: 'list_tabs',
  browser_capture: 'capture',
  browser_press_key: 'press_key',
  browser_activate_tab: 'activate_tab',
  open_url: 'activate_tab',
})

/** The local command a hive plan step becomes, or null when it cannot. */
export function localCallFor(action) {
  const hiveType = String(action?.type ?? '').trim()
  const params =
    action?.params && typeof action.params === 'object' && !Array.isArray(action.params)
      ? { ...action.params }
      : {}

  /* A step already in the extension's own vocabulary needs no translation —
   * mesh mail and future callers may hand plans over pre-translated. */
  if (COMMAND_TYPES.has(hiveType)) return { type: hiveType, params }

  const localType = LOCAL_CLAIMABLE_ACTIONS[hiveType]
  if (!localType) return null

  if (hiveType === 'open_url') {
    const url = String(params.url ?? '').trim()
    if (!url) return null
    /* Focus an existing tab on that origin before opening a duplicate — the
     * owner's signed-in session is the whole point of running this here. */
    let urlContains = ''
    try {
      urlContains = new URL(url).hostname
    } catch {
      return null
    }
    return { type: 'activate_tab', params: { url, urlContains } }
  }

  return { type: localType, params }
}

/* ===================================================================== *
 * Effect classification: what a step DOES, not what it is made of.
 * ===================================================================== */

/* Commands that only look. Auto-run without ceremony. */
const READ_COMMANDS = new Set([
  'read_page',
  'snapshot',
  'list_tabs',
  'wait_for',
  'capture',
  'scroll',
])

/*
 * Words that mark a control as the COMMIT point of something irreversible or
 * outward-facing: money moving, an arrangement changing, a message leaving,
 * an agreement being entered. Matched against everything known about the
 * step's target — its accessible name, the plan label, the selector, typed
 * text — lowercased. Kept as sources (not RegExp objects) so tests can assert
 * the list itself, and so the list reads as policy rather than as code.
 *
 * "cancel" is deliberately here unqualified. Cancelling an order, a
 * subscription, a transfer or a recurring investment is exactly the standing-
 * arrangement change this gate exists for, and "cancel" as in "close this
 * dialog" costs one approval tap when over-matched. Asymmetric costs, so the
 * match is asymmetric too.
 */
export const OUTWARD_EFFECT_PATTERNS = Object.freeze([
  '\\b(submit|confirm|place\\s+(?:the\\s+)?order|checkout|check\\s+out)\\b',
  '\\b(buy|sell|trade|invest|transfer|withdraw|deposit|pay(?:ment)?|purchase|donate)\\b',
  '\\b(send|reply|post|publish|share|tweet|forward)\\b',
  '\\b(cancel|unsubscribe|terminate|close\\s+(?:my\\s+)?account|deactivat\\w*|delete)\\b',
  '\\b(sign|agree|accept|consent|authoriz\\w*|approve)\\b',
  '\\b(book|reserve|order|enroll|register|subscribe|renew)\\b',
])

const outwardMatchers = OUTWARD_EFFECT_PATTERNS.map(
  (source) => new RegExp(source, 'i'),
)

/** Does this text describe an outward commit point? '' matches nothing. */
export function textLooksOutward(text) {
  const haystack = String(text ?? '')
  if (!haystack.trim()) return false
  return outwardMatchers.some((pattern) => pattern.test(haystack))
}

/**
 * The effect tag for one local call.
 *
 * `targetName` is what the page itself calls the element (the accessible name
 * a snapshot recorded). It is the strongest signal there is — the label the
 * OWNER would read before pressing the same control — so it participates in
 * the match alongside the planner's label and the raw selector.
 *
 * Fail-closed rule for clicks: a click whose target this side cannot describe
 * AT ALL (a bare ref with no snapshot behind it, an empty selector) is tagged
 * 'outward'. Not because it is known to be dangerous, but because it is not
 * known to be safe, and "click the unlabeled thing on a live page" is not a
 * bet to make unattended.
 */
export function classifyEffect({ type, params = {}, label = '', targetName = '' } = {}) {
  const command = String(type ?? '').trim()

  if (READ_COMMANDS.has(command)) {
    return { effect: EFFECT_READ, reason: 'Reads the page; changes nothing.' }
  }

  if (command === 'navigate' || command === 'activate_tab') {
    /* Opening or focusing a page is recon, whatever the URL says: a page named
     * /cancel-subscription has cancelled nothing by being looked at. */
    return { effect: EFFECT_ACT, reason: 'Opens or focuses a page.' }
  }

  const described = [
    targetName,
    label,
    String(params.selector ?? ''),
    String(params.ref ?? ''),
    String(params.text ?? ''),
    String(params.value ?? params.label ?? ''),
  ]
    .filter(Boolean)
    .join(' ')

  if (command === 'click') {
    const hasName = String(targetName ?? '').trim()
    const hasSelector = String(params.selector ?? '').trim()
    if (!hasName && !hasSelector) {
      return {
        effect: EFFECT_OUTWARD,
        reason:
          'Clicks a target this side cannot describe (no snapshot name, no selector) — not provably safe.',
      }
    }
    if (textLooksOutward(described)) {
      return {
        effect: EFFECT_OUTWARD,
        reason: `The click target reads as a commit point: "${(hasName || hasSelector).slice(0, 120)}".`,
      }
    }
    return { effect: EFFECT_ACT, reason: 'Clicks an element.' }
  }

  if (command === 'type' || command === 'select') {
    if (params.submit === true) {
      return {
        effect: EFFECT_OUTWARD,
        reason: 'Typing with submit:true files the form in the same breath.',
      }
    }
    if (textLooksOutward(described)) {
      return {
        effect: EFFECT_OUTWARD,
        reason: 'The field or its content reads as part of an outward action.',
      }
    }
    return { effect: EFFECT_ACT, reason: 'Edits a field without submitting.' }
  }

  if (command === 'press_key') {
    const key = String(params.key ?? '').trim().toLowerCase()
    if (key === 'enter' || key === 'return') {
      return {
        effect: EFFECT_OUTWARD,
        reason: 'Enter submits whatever form holds the focus.',
      }
    }
    return { effect: EFFECT_ACT, reason: `Presses ${key || 'a key'}.` }
  }

  /* A command this classifier has never heard of is not a command to run
   * unattended. New verbs must be classified before they may auto-run. */
  return {
    effect: EFFECT_OUTWARD,
    reason: `No effect classification exists for "${command}".`,
  }
}

/* ===================================================================== *
 * Plan routing: the per-step tags, and the one rule over them.
 * ===================================================================== */

/** Tag one hive plan step. Pure; never throws. */
export function tagPlanStep(action, index = 0) {
  const localCall = localCallFor(action)
  const label = String(action?.label ?? action?.type ?? 'step')

  if (!localCall) {
    return {
      index,
      label,
      hiveType: String(action?.type ?? ''),
      capability: CAPABILITY_HIVE,
      localCall: null,
      effect: null,
      effectReason: '',
    }
  }

  const { effect, reason } = classifyEffect({
    type: localCall.type,
    params: localCall.params,
    label,
  })

  return {
    index,
    label,
    hiveType: String(action?.type ?? ''),
    capability: CAPABILITY_BROWSER,
    localCall,
    effect,
    effectReason: reason,
  }
}

/**
 * THE AFFINITY RULE. A non-empty plan whose every step is browser-capable
 * executes on this node; anything else forwards to the hive unchanged.
 */
export function routePlan(actions) {
  const list = Array.isArray(actions) ? actions : []
  const steps = list.map((action, index) => tagPlanStep(action, index))

  if (!steps.length) {
    return { route: CAPABILITY_HIVE, steps, reason: 'The plan has no steps.' }
  }

  const foreign = steps.filter((step) => step.capability !== CAPABILITY_BROWSER)
  if (foreign.length) {
    const named = foreign
      .slice(0, 3)
      .map((step) => step.hiveType || step.label)
      .join(', ')
    return {
      route: CAPABILITY_HIVE,
      steps,
      reason:
        `${foreign.length} of ${steps.length} step(s) need more than a browser ` +
        `(${named}) — the hive keeps the whole plan.`,
    }
  }

  return {
    route: CAPABILITY_BROWSER,
    steps,
    reason: `All ${steps.length} step(s) are browser work; this node runs them itself.`,
  }
}

/* ===================================================================== *
 * The outward guard for the brain loop: same classifier, plus memory of
 * what the page called each ref.
 * ===================================================================== */

/**
 * A stateful wrapper around classifyEffect for tool-by-tool execution.
 *
 * The brain clicks by ref, and a ref means nothing outside the snapshot that
 * minted it. The guard watches snapshot results go past and remembers each
 * ref's accessible name, so when the model later says {click, ref:"e4"} the
 * classifier sees "Confirm cancellation" — the words the OWNER would have
 * read — and not an opaque token. A ref the guard never saw snapshotted is
 * unclassifiable and therefore parks (classifyEffect's fail-closed rule).
 */
export function createOutwardGuard() {
  const names = new Map()

  return {
    /** Feed every successful tool result through here. */
    observe(call, result) {
      if (String(call?.type) !== 'snapshot') return
      for (const element of result?.elements ?? []) {
        const ref = String(element?.ref ?? '').trim()
        if (!ref) continue
        names.set(ref, {
          name: String(element?.name ?? ''),
          role: String(element?.role ?? ''),
        })
      }
    },

    /** What the last snapshot called this ref, if anything. */
    describeRef(ref) {
      return names.get(String(ref ?? '').trim()) ?? null
    },

    /**
     * May this call run unattended? {allow, effect, reason, targetName}.
     * Read and act steps pass; outward steps do not — deciding what happens
     * to a parked call is the caller's business, not the guard's.
     */
    assess(call) {
      const known = names.get(String(call?.params?.ref ?? '').trim())
      const targetName = known
        ? [known.name, known.role && `(${known.role})`].filter(Boolean).join(' ')
        : ''
      const { effect, reason } = classifyEffect({
        type: call?.type,
        params: call?.params ?? {},
        targetName,
      })
      return { allow: effect !== EFFECT_OUTWARD, effect, reason, targetName }
    },
  }
}

/* ===================================================================== *
 * Honesty at completion: the verdict comes from the ledger, not the model.
 * ===================================================================== */

/*
 * Navigation-class commands are 'act' for GATING (they do change which page
 * is in front) but RECON for honesty: a run that only opened and read pages
 * has changed nothing on any of them, and must say so. This set is what
 * keeps "opened the page" out of the "did the thing" claim.
 */
const NAVIGATION_COMMANDS = new Set(['navigate', 'activate_tab'])

/** What a finished run actually did, counted from its steps. */
export function summarizeEffects(steps = []) {
  const counts = { read: 0, opened: 0, act: 0, outward: 0, failed: 0 }
  for (const step of steps) {
    if (step?.ok === false) {
      counts.failed += 1
      continue
    }
    if (step?.effect === EFFECT_OUTWARD) counts.outward += 1
    else if (step?.effect === EFFECT_ACT) {
      if (NAVIGATION_COMMANDS.has(String(step?.tool ?? ''))) counts.opened += 1
      else counts.act += 1
    } else counts.read += 1
  }
  return counts
}

/**
 * The honest completion line for a locally executed run.
 *
 * verdict:
 *   'achieved'   — outward/act effects ran and nothing is pending.
 *   'recon-only' — nothing on any page was changed; says exactly that.
 *   'parked'     — stopped at an outward step; the effect has NOT happened.
 *   'incomplete' — the command wanted an outward effect and none ran.
 *
 * The model's own response (if any) survives as color, never as the claim:
 * headline truth is derived from `steps` and `parked`, which only the
 * executor writes.
 */
export function honestVerdict({ command, steps = [], parked = [], response = '' } = {}) {
  const effects = summarizeEffects(steps)
  /* Does the command ASK for an outward effect? Same vocabulary as the step
   * classifier, applied to the owner's own words — "cancel my recurring
   * investments" wants a cancellation, and a run that never performed one
   * must not be allowed to sound as if it did. */
  const wanted = textLooksOutward(command)
  const said = String(response ?? '').trim()

  if (parked.length) {
    const waiting = parked
      .map((entry) => String(entry?.reason ?? 'an irreversible step'))
      .slice(0, 2)
      .join('; ')
    return {
      verdict: 'parked',
      headline:
        'Stopped before the irreversible step — nothing was submitted, cancelled or sent. ' +
        'It is waiting for your approval.',
      detail: `Parked: ${waiting}. Steps so far: ${describeCounts(effects)}.`,
    }
  }

  if (effects.act === 0 && effects.outward === 0) {
    return {
      verdict: 'recon-only',
      headline: said
        ? `${said} (Read-only: opened and read pages; changed nothing.)`
        : 'Read-only run: opened and read pages; changed nothing.',
      detail: `Steps: ${describeCounts(effects)}.`,
    }
  }

  if (wanted && effects.outward === 0) {
    return {
      verdict: 'incomplete',
      headline:
        'NOT done: the final submit/cancel/send step never ran, so nothing was changed. ' +
        (said || 'The pages were only navigated and read.'),
      detail: `Steps: ${describeCounts(effects)}.`,
    }
  }

  return {
    verdict: 'achieved',
    headline: said || 'Done.',
    detail: `Steps: ${describeCounts(effects)}.`,
  }
}

function describeCounts(effects) {
  return (
    `${effects.read} read, ${effects.opened} page(s) opened, ` +
    `${effects.act} page interaction(s), ` +
    `${effects.outward} approved outward step(s), ${effects.failed} failed`
  )
}
