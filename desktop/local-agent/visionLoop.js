import { closeLedger, ledgerLocation, ledgerStepObserver, openLedger } from './actionLedger.js'
import { planFocus, routeByTargetApp, runFocusSafePlan } from './focusCoordinator.js'
import { preflight } from './visionLoopPreflight.js'
import {
  PRESS_FALLBACK,
  VISION_LOOP_READ_ONLY,
  admitStep,
  describePolicy,
  describeStep,
  requirementsFor,
} from './visionLoopPolicy.js'

/*
 * The accessibility-mode UI interaction loop.
 *
 * HTTP lives in visionLoopRoutes.js — `registerVisionLoopRoutes(app)` — for the
 * same reason actionLedgerRoutes.js is its own file: server.js is 70 000
 * characters that several people are editing at once, and a module that mounts
 * in one line is a module that does not collide. It is a separate file rather
 * than a re-export from here so the import graph stays acyclic.
 *
 * It is CORRECT AND INERT, in that order, and both words are load-bearing.
 *
 * Correct: the plan is built, validated against the structural vocabulary in
 * visionLoopPolicy.js, aimed at a named app through the existing focus
 * coordinator, and checked step by step for what it would touch and what it
 * would need — all of which happens today, on a machine where none of it can
 * run. None of that work is deferred to the day the grant lands. What is
 * deferred is exactly one thing: handing an action to the executor.
 *
 * Inert: when the preflight is not satisfied, `execute` is never called. Not
 * called with a dry-run flag, not called against a stub, not called at all. The
 * test for this asserts the call count is zero, because "we checked and then
 * carefully did nothing" is a claim that decays the moment someone adds a
 * convenience path, and the only durable version of it is a counter.
 *
 * WHAT IT WILL NOT DO WHEN BLOCKED, and these are the interesting ones:
 *
 *   - It will not take a screenshot instead. The general loop's `observe()`
 *     attaches an image whenever the accessibility tree comes back empty, which
 *     is exactly what a denied grant looks like from the inside — so on this
 *     machine that loop would degrade straight into pixel capture. This one has
 *     no image tier to degrade into; `screenshot` is not in the vocabulary.
 *   - It will not fall back to typing or clicking at coordinates. Those reach
 *     the owner's keyboard focus and the owner's topmost window by construction,
 *     which is the takeover the capability is defined against.
 *   - It will not activate the target app to make a step work. Not stealing
 *     focus is the feature, not the obstacle.
 *   - It will not open System Settings to ask. See visionLoopPreflight.js.
 *   - It will NOT open a ledger manifest for a run that is not going to happen.
 *     actionLedger treats a still-open ledger as "a run that did not get to
 *     finish saying so", and interruptedLedgers() reads it that way. Writing a
 *     manifest per blocked attempt would fill that report with runs that never
 *     started, and the one real interrupted run would be buried in them.
 */

/* A goal longer than this is not a goal. */
const MAX_GOAL = 400

/* The tag written into the ledger's `source`, so the history can tell this
 * loop's runs apart from every other thing that opens a manifest without
 * keeping a second store to remember which was which. */
export const VISION_LOOP_SOURCE = 'vision-loop'

/**
 * Build the plan. Pure, and it never runs or checks anything about the machine
 * — a plan is valid or not on its own terms, and the permission state is a
 * separate question asked later so that a plan can be reviewed while the answer
 * is still "no".
 */
export function planVisionLoop({ goal = '', app = '', steps = [] } = {}, { now = Date.now() } = {}) {
  const targetApp = String(app ?? '').trim().replace(/\.app$/i, '')
  const list = Array.isArray(steps) ? steps : []
  const problems = []

  /*
   * A plan with no named app is a plan aimed at whatever is in front, which is
   * the owner's window. Every other guarantee in this module is downstream of
   * this one refusal, so it comes first and it is not overridable.
   */
  if (!targetApp || targetApp.toLowerCase() === 'frontmost') {
    problems.push({
      seq: null,
      type: null,
      category: 'no-target-app',
      reason:
        'Accessibility-mode automation must name the app it is about. Without a name every step aims at whatever is in front — which is the owner’s window — and “without taking over the screen” stops meaning anything.',
    })
  }

  if (!list.length) {
    problems.push({ seq: null, type: null, category: 'empty', reason: 'The plan has no steps.' })
  }

  const admitted = []
  for (const [seq, step] of list.entries()) {
    const verdict = admitStep(step)
    if (!verdict.ok) {
      problems.push({ seq, type: verdict.type, category: verdict.category, reason: verdict.reason })
      continue
    }
    admitted.push({ seq, step })
  }

  /*
   * Every step carries the app name explicitly rather than inheriting a default
   * inside the helper. `app: 'frontmost'` is uiControl's default for all five of
   * these calls, so an omitted name is not a neutral omission — it is the
   * takeover, spelled as an absence.
   */
  const named = admitted.map(({ step }) => ({
    ...step,
    type: String(step.type),
    params: { ...(step.params ?? {}), app: targetApp },
  }))

  /* Ask the focus coordinator what it makes of the result. It owns "can this be
   * aimed at a named app"; this module only checks that the answer came back
   * the way the capability requires. */
  const focus = planFocus(named, { targetApp })
  const actions = routeByTargetApp(named, focus)

  for (const step of focus.steps) {
    if (step.focus !== 'addressed') {
      problems.push({
        seq: step.seq,
        type: step.type,
        category: 'not-addressed',
        reason: `${step.type} did not come out of the focus coordinator addressed to ${targetApp}; it would act on whatever is in front. Refusing the whole plan rather than the step.`,
      })
    }
  }
  if (focus.foregroundBound > 0 || focus.mayActivate > 0) {
    problems.push({
      seq: null,
      type: null,
      category: 'foreground-bound',
      reason: `${focus.foregroundBound} step(s) can only act on the frontmost app and ${focus.mayActivate} could activate one. Neither is reachable in accessibility mode.`,
    })
  }

  /*
   * All or nothing. A plan with one rejected step is not a shorter plan — the
   * remaining steps were written assuming the rejected one happened, and
   * running them without it is the same class of guess planResume refuses to
   * make. Returning a partial plan is how a refusal turns into a silent
   * degradation two callers downstream.
   */
  const ok = problems.length === 0

  const described = (ok ? actions : []).map((action, seq) => ({
    seq,
    type: action.type,
    readOnly: VISION_LOOP_READ_ONLY.has(action.type),
    does: describeStep(action, { app: targetApp }),
    requires: requirementsFor(action.type),
  }))

  return {
    ok,
    mode: 'accessibility',
    goal: String(goal ?? '').slice(0, MAX_GOAL),
    app: targetApp || null,
    createdAt: new Date(now).toISOString(),
    steps: described,
    actions: ok ? actions : [],
    rejected: problems,
    focus: { addressed: focus.addressed, foregroundBound: focus.foregroundBound, routed: focus.routed },
    writes: described.filter((step) => !step.readOnly).length,
    /* Declared before anything runs, so an owner reading the plan meets the one
     * hole in the promise at the same time as the promise. */
    pressFallbackRisk: described.some((step) => step.type === 'ui_click') ? PRESS_FALLBACK : null,
    summary: summarizePlan(described, targetApp, problems),
  }
}

function summarizePlan(steps, app, problems) {
  if (problems.length) {
    return `This plan cannot run in accessibility mode: ${problems[0].reason}`
  }
  const writes = steps.filter((step) => !step.readOnly).length
  return `${steps.length} step${steps.length === 1 ? '' : 's'} against ${app}, ${writes} of which press something. Every step goes through the accessibility API, so ${app} never has to come to the front and the owner’s keyboard focus is never touched.`
}

/**
 * Run it — which today means: check, report, and dispatch nothing.
 *
 * Every effect is injected, including the preflight, so the whole thing is
 * testable on a machine with no grants (which is every machine this has ever
 * run on).
 */
export async function runVisionLoop(plan, deps = {}) {
  const {
    execute = null,
    preflightImpl = preflight,
    runPlanImpl = runFocusSafePlan,
    openLedgerImpl = openLedger,
    closeLedgerImpl = closeLedger,
    observerImpl = ledgerStepObserver,
    ledgerPath = ledgerLocation(),
    jobId = null,
    sessionId = null,
    uiSnapshot = null,
  } = deps

  if (!plan?.ok) {
    /* An invalid plan does not get a permission check. Asking whether we may
     * run something we have already refused to build would put a `blocked on
     * the grant` label on what is actually a bad plan, and the owner would go
     * flip a switch that changes nothing. */
    return {
      ok: false,
      status: 'invalid-plan',
      dispatched: 0,
      executed: false,
      reason: plan?.rejected?.[0]?.reason ?? 'No plan was given.',
      rejected: plan?.rejected ?? [],
      preflight: null,
    }
  }

  const gate = await preflightImpl()

  if (!gate.ok) {
    return {
      ok: false,
      status: 'blocked-on-grant',
      dispatched: 0,
      executed: false,
      /* The point of the whole exercise: a precise, ordered account of what it
       * would have done, produced by the same describeStep() the history will
       * use afterwards. */
      wouldRun: plan.steps.map((step) => ({ seq: step.seq, type: step.type, does: step.does })),
      wouldTouch: { app: plan.app, presses: plan.writes, reads: plan.steps.length - plan.writes },
      blockedOn: gate.blockedOn,
      preflight: gate,
      ledgerId: null,
      ledgerNote:
        'No manifest was written. actionLedger reads a still-open ledger as an interrupted run, and a blocked attempt is not one.',
      summary: `${plan.summary} Nothing was dispatched. ${gate.summary}`,
    }
  }

  if (typeof execute !== 'function') {
    return {
      ok: false,
      status: 'no-executor',
      dispatched: 0,
      executed: false,
      preflight: gate,
      reason: 'The preflight passed but no execute implementation was supplied, so nothing was run.',
    }
  }

  /* Past this line the grant is held and the switch is on. The manifest is
   * written BEFORE the first dispatch — actionLedger's ordering invariant — and
   * closed in a finally so an interrupted run is the only thing left open. */
  const manifest = openLedgerImpl({
    command: plan.goal || `accessibility-mode automation against ${plan.app}`,
    actions: plan.actions,
    jobId,
    sessionId,
    source: VISION_LOOP_SOURCE,
    title: `Accessibility-mode UI automation — ${plan.app}`,
    filePath: ledgerPath,
  })

  const ledgerObserver = observerImpl(manifest, { filePath: ledgerPath })
  const fallbacks = []

  /* The detector for the one declared hole. The helper reports how it pressed;
   * anything other than the accessibility press means a real click went to a
   * real screen coordinate, and the promise is already broken for that step. */
  const watchForFallback = async (event) => {
    await ledgerObserver(event)
    if (event?.phase !== 'done') return
    const method = event?.result?.method
    if (event?.action?.type === 'ui_click' && method && method !== 'press' && method !== 'dryrun') {
      fallbacks.push({ seq: event.seq, method, action: event.action?.type ?? null })
    }
  }

  let outcome
  try {
    outcome = await runPlanImpl(plan.actions, {
      execute,
      targetApp: plan.app,
      uiSnapshot,
      /* Nothing in this plan can move the foreground, so there is nothing to
       * hand back. Asking for a restore would be the module activating an app
       * on its way out — a change, not a restoration. */
      restoreFocus: false,
      onStep: watchForFallback,
    })
  } finally {
    closeLedgerImpl(manifest.ledgerId, {
      status: 'settled',
      outcome: fallbacks.length
        ? `Stopped: ${fallbacks.length} press fell back to a real mouse click.`
        : null,
      filePath: ledgerPath,
    })
  }

  const stopped = fallbacks.length > 0

  return {
    ok: !stopped && outcome?.receipt?.ok !== false,
    status: stopped ? 'stopped-on-press-fallback' : (outcome?.receipt?.status ?? 'completed'),
    dispatched: outcome?.receipt?.ranSteps ?? 0,
    executed: true,
    ledgerId: manifest.ledgerId,
    jobId,
    results: outcome?.results ?? [],
    receipt: outcome?.receipt ?? null,
    pressFallbacks: fallbacks,
    preflight: gate,
    summary: stopped
      ? `Stopped after ${outcome?.receipt?.ranSteps ?? 0} step(s): a press could not go through the accessibility API and the helper clicked at the control’s screen position instead. ${PRESS_FALLBACK.consequence}`
      : plan.summary,
  }
}

/** Plan + gate in one read, for a caller that only wants to know the position. */
export async function visionLoopStatus({ preflightImpl = preflight } = {}) {
  const gate = await preflightImpl()
  return {
    ok: true,
    readOnly: true,
    ready: gate.ok,
    preflight: gate,
    policy: describePolicy(),
    /* Answering the question an owner actually has, which is not "what are my
     * TCC flags" but "what can this thing do for me right now". */
    todayWithoutTheGrant: [
      'Build a full accessibility-mode plan against a named app and validate every step of it.',
      'Report exactly which controls it would read and which it would press, in order, in plain sentences.',
      'Say which single grant is missing, which binary needs it, and that Screen Recording is not needed at all.',
      'Narrate and explain the history of any runs that did happen, with the undo position for each.',
    ],
    blockedUntilGranted: [
      'Reading the accessibility tree of any app (the helper refuses with NO_AX).',
      'Pressing any control, including in the app’s own menu bar.',
      'Measuring whether opening a menu bar item activates the app — the one focus question this design cannot answer from here.',
    ],
  }
}
