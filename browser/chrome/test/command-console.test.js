import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONSOLE_SOURCE,
  HISTORY_LIMIT,
  PLAN_APPROVAL_TTL_MS,
  appendHistory,
  buildCommandText,
  commandContext,
  consoleWindowRungs,
  currentEntry,
  dashboardUrlFor,
  describeBrainState,
  describeEntry,
  describeResults,
  interpretExecuteResponse,
  interpretPlanResponse,
  localStepPending,
  newHistoryEntry,
  outcomeToPatch,
  patchHistory,
  planDecisionPreflight,
  scrubPageContext,
} from '../src/command-console.js'

/* ------------------------------------------------------------------ *
 * Fixtures. The instant-plan and execute shapes below are trimmed from
 * REAL responses of the live agent (POST /plan, POST /execute on
 * 127.0.0.1:8000, 2026-08-08), not invented. The ready/unsupported/error
 * shapes are the exact objects local-agent/server.js builds around
 * llmPlanner.js returns.
 * ------------------------------------------------------------------ */

const LIVE_INSTANT_PLAN = {
  status: 'instant',
  mode: 'deterministic',
  command: 'what time is it',
  requiresConfirmation: false,
  summary: 'Saturday, August 8, 2026 at 5:57:27 PM EDT',
  response: 'Saturday, August 8, 2026 at 5:57:27 PM EDT',
  actions: [],
  planner: 'deterministic',
  fullControl: true,
  preview: null,
  jobId: 'local_849bcaba-f805-4912-8bfe-db8c9a0c652a',
  sessionId: 'cfddbdc8-5248-497d-8463-b2fe375a4598',
}

const READY_PLAN = {
  status: 'ready',
  command: 'send the weekly email',
  response: undefined,
  actions: [
    { type: 'send_email', label: 'Send the weekly email', params: { to: 'x@y.z' } },
  ],
  requiresConfirmation: true,
  safety: 'Actions are prepared first. Nothing is executed on the Mac until you confirm.',
  planner: 'llm',
  preview: {
    stepCount: 1,
    affected: { apps: ['Mail'], paths: [], urls: [], other: [] },
    spoken: 'One step touching Mail.',
  },
  jobId: 'local_plan_ready',
  sessionId: 'session-1',
}

const LIVE_EXECUTE_OK = {
  ok: true,
  status: 'success',
  results: [
    {
      action: { type: 'get_time', label: 'Read the current time', params: {} },
      ok: true,
      status: 'success',
      message: 'Saturday, August 8, 2026 at 5:57:43 PM EDT',
    },
  ],
  response: 'Saturday, August 8, 2026 at 5:57:43 PM EDT',
  jobId: 'local_4ea01b99-2028-4270-a1f0-e285abcbb106',
  sessionId: 'cfddbdc8-5248-497d-8463-b2fe375a4598',
}

test('an instant plan renders as an answered result', () => {
  const outcome = interpretPlanResponse({ status: 200, payload: LIVE_INSTANT_PLAN })
  assert.equal(outcome.kind, 'answered')
  assert.equal(outcome.message, 'Saturday, August 8, 2026 at 5:57:27 PM EDT')
  assert.equal(outcome.jobId, LIVE_INSTANT_PLAN.jobId)
  assert.equal(outcome.sessionId, LIVE_INSTANT_PLAN.sessionId)
})

test('a ready plan that requires confirmation parks with its steps kept', () => {
  const outcome = interpretPlanResponse({ status: 200, payload: READY_PLAN })
  assert.equal(outcome.kind, 'parked')
  assert.match(outcome.detail, /Send the weekly email/)
  assert.match(outcome.detail, /Touches: Mail/)
  assert.match(outcome.safety, /until you confirm/)
  /* The steps ride along, or the popup could only ever describe the plan and
   * send the owner elsewhere to approve it. */
  assert.equal(outcome.actions.length, 1)
  assert.equal(outcome.actions[0].type, 'send_email')
})

test('a ready plan the planner cleared executes', () => {
  const outcome = interpretPlanResponse({
    status: 200,
    payload: { ...READY_PLAN, requiresConfirmation: false },
  })
  assert.equal(outcome.kind, 'execute')
  assert.equal(outcome.actions.length, 1)
  assert.equal(outcome.actions[0].type, 'send_email')
})

test('unsupported plans surface the agent refusal verbatim', () => {
  const outcome = interpretPlanResponse({
    status: 422,
    payload: {
      status: 'unsupported',
      actions: [],
      requiresConfirmation: true,
      error: 'Blocked for safety: LLM could not produce an action plan.',
      jobId: 'local_x',
    },
  })
  assert.equal(outcome.kind, 'refused')
  assert.equal(
    outcome.message,
    'Blocked for safety: LLM could not produce an action plan.',
  )
})

test('token rejection and server errors are kept verbatim', () => {
  const unauthorized = interpretPlanResponse({
    status: 401,
    payload: {
      ok: false,
      status: 'blocked',
      error: 'Blocked for safety: invalid or missing agent token.',
    },
  })
  assert.equal(unauthorized.kind, 'error')
  assert.equal(unauthorized.unauthorized, true)
  assert.match(unauthorized.message, /invalid or missing agent token/)

  const failed = interpretPlanResponse({
    status: 500,
    payload: { ok: false, error: 'planner exploded', cancelled: false, jobId: 'j' },
  })
  assert.equal(failed.kind, 'error')
  assert.equal(failed.message, 'planner exploded')

  const empty = interpretPlanResponse({ status: 502, payload: null })
  assert.equal(empty.kind, 'error')
  assert.match(empty.message, /HTTP 502/)
})

test('execute results carry the response and per-step lines', () => {
  const outcome = interpretExecuteResponse({ status: 200, payload: LIVE_EXECUTE_OK })
  assert.equal(outcome.kind, 'executed')
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.message, 'Saturday, August 8, 2026 at 5:57:43 PM EDT')
  assert.equal(outcome.steps.length, 1)
  assert.match(outcome.steps[0], /✓ Read the current time/)
})

test('execute failures keep the error verbatim', () => {
  const httpError = interpretExecuteResponse({
    status: 400,
    payload: { ok: false, error: 'No actions provided.', jobId: 'j' },
  })
  assert.equal(httpError.kind, 'error')
  assert.equal(httpError.message, 'No actions provided.')

  const stepFailure = interpretExecuteResponse({
    status: 200,
    payload: {
      ok: false,
      status: 'failed',
      results: [
        { action: { type: 'open_app', label: 'Open Mail' }, ok: false, error: 'Mail is not installed.' },
      ],
      response: 'Mail is not installed.',
    },
  })
  assert.equal(stepFailure.kind, 'exec-failed')
  assert.match(stepFailure.steps[0], /✗ Open Mail — Mail is not installed\./)
})

test('describeResults tolerates malformed result lists', () => {
  assert.deepEqual(describeResults(null), [])
  assert.deepEqual(describeResults([{}]), ['✗ step'])
})

test('page context rides in the command text only when provided', () => {
  assert.equal(buildCommandText('  hi  '), 'hi')
  const withPage = buildCommandText('summarize this', {
    url: 'https://example.com/docs',
    title: 'Example Docs',
  })
  assert.match(withPage, /^summarize this\n\n\[Sent from the browser extension/)
  assert.match(withPage, /"Example Docs" — https:\/\/example\.com\/docs/)
})

test('the page also travels as a first-class context field', () => {
  /*
   * Both channels on purpose. `context` is where a current agent reads the
   * page — as a labelled block, not as part of the owner's sentence, which is
   * what let "…browser extension." end up inside a verdict. The trailer above
   * stays because it is the only channel an OLDER agent has, and an agent that
   * gets both strips it (local-agent/callerContext.js).
   */
  const context = commandContext({
    url: 'https://example.com/docs',
    title: 'Example Docs',
  })
  assert.deepEqual(context, {
    surface: CONSOLE_SOURCE,
    page: { url: 'https://example.com/docs', title: 'Example Docs' },
  })

  /* A titleless page is still worth sending; nothing at all is not. */
  assert.deepEqual(commandContext({ url: 'https://example.com/' }), {
    surface: CONSOLE_SOURCE,
    page: { url: 'https://example.com/' },
  })
  assert.equal(commandContext(null), null)
  assert.equal(commandContext({ title: 'no url' }), null)
})

test('page scrubbing keeps the address but withholds URL-borne secrets', () => {
  assert.equal(scrubPageContext({ url: 'chrome://settings', title: 'x' }), null)
  assert.equal(scrubPageContext(null), null)

  const clean = scrubPageContext({
    url: 'https://example.com/reset?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
    title: '  Reset   your password  ',
  })
  assert.match(clean.url, /^https:\/\/example\.com\/reset\?token=/)
  assert.ok(clean.url.includes('[withheld]'), 'JWT must be withheld from the URL')
  assert.equal(clean.title, 'Reset your password')
})

test('the history is bounded and patches keep text within limits', () => {
  let history = []
  for (let i = 0; i < HISTORY_LIMIT + 3; i += 1) {
    history = appendHistory(history, newHistoryEntry({ id: `id-${i}`, command: `c${i}` }))
  }
  assert.equal(history.length, HISTORY_LIMIT)
  assert.equal(history[0].id, `id-${HISTORY_LIMIT + 2}`)

  history = patchHistory(history, history[0].id, {
    state: 'answered',
    headline: 'x'.repeat(2_000),
  })
  assert.ok(history[0].headline.length <= 500)
  assert.equal(history[1].state, 'working')
})

test('outcomes become honest history patches', () => {
  const parked = outcomeToPatch(
    interpretPlanResponse({ status: 200, payload: READY_PLAN }),
  )
  assert.equal(parked.state, 'parked')
  assert.match(parked.detail, /Nothing is executed on the Mac until you confirm/)

  const executed = outcomeToPatch(
    interpretExecuteResponse({ status: 200, payload: LIVE_EXECUTE_OK }),
  )
  assert.equal(executed.state, 'executed')
  assert.equal(executed.jobId, LIVE_EXECUTE_OK.jobId)
})

test('working entries go honest-lost once nothing can still finish them', () => {
  const now = Date.now()
  const entry = newHistoryEntry({ id: 'a', command: 'x', now })

  assert.equal(describeEntry(entry, now + 5_000).state, 'working')

  const lost = describeEntry(entry, now + 10 * 60_000)
  assert.equal(lost.state, 'lost')
  assert.equal(lost.showDashboardLink, true)

  const parked = describeEntry({ ...entry, state: 'parked', headline: 'waiting' }, now)
  assert.equal(parked.label, 'Parked for approval')
  assert.equal(parked.showDashboardLink, true)
})

test('a parked plan keeps what Approve would run', () => {
  const now = Date.parse('2026-08-09T20:00:00.000Z')
  const patch = outcomeToPatch(
    interpretPlanResponse({ status: 200, payload: READY_PLAN }),
    now,
  )

  assert.equal(patch.pending.kind, 'mac-plan')
  assert.equal(patch.pending.actions[0].type, 'send_email')
  /* The Mac's own parked job is the arbiter between this button and the
   * dashboard's, so its id has to survive onto the entry. */
  assert.equal(patch.pending.jobId, 'local_plan_ready')
  assert.equal(patch.pending.sessionId, 'session-1')
  assert.equal(patch.pending.parkedAt, new Date(now).toISOString())
})

test('a parked plan is decidable in the popup until it goes stale', () => {
  const now = Date.parse('2026-08-09T20:00:00.000Z')
  const entry = {
    ...newHistoryEntry({ id: 'a', command: 'send the weekly email', now }),
    ...outcomeToPatch(
      interpretPlanResponse({ status: 200, payload: READY_PLAN }),
      now,
    ),
  }

  const fresh = describeEntry(entry, now + 1_000)
  assert.equal(fresh.canDecide, true)
  /* The link is the fallback now, not the offer. */
  assert.equal(fresh.showDashboardLink, false)

  const stale = describeEntry(entry, now + PLAN_APPROVAL_TTL_MS + 1)
  assert.equal(stale.canDecide, false)
  assert.equal(stale.showDashboardLink, true)
  assert.match(stale.decisionNote, /waiting too long/)
})

test('preflight refuses a decision the entry cannot honour', () => {
  const now = Date.parse('2026-08-09T20:00:00.000Z')
  const parked = {
    ...newHistoryEntry({ id: 'a', command: 'send it', now }),
    ...outcomeToPatch(
      interpretPlanResponse({ status: 200, payload: READY_PLAN }),
      now,
    ),
  }

  assert.equal(planDecisionPreflight(parked, now).ok, true)
  assert.equal(planDecisionPreflight(null, now).ok, false)

  /* Already decided: a second click, or a second popup, finds nothing parked. */
  const running = planDecisionPreflight({ ...parked, state: 'working' }, now)
  assert.equal(running.ok, false)
  assert.match(running.error, /no longer waiting/)

  /* Parked by a build that did not keep the steps — the dashboard still can. */
  const stepless = planDecisionPreflight({ ...parked, pending: null }, now)
  assert.equal(stepless.ok, false)
  assert.match(stepless.error, /dashboard/)

  const expired = planDecisionPreflight(parked, now + PLAN_APPROVAL_TTL_MS + 1)
  assert.equal(expired.ok, false)
  assert.equal(expired.expired, true)
})

test('a locally parked outward step is decidable the same way a plan is', () => {
  const now = Date.parse('2026-08-09T20:00:00.000Z')
  const entry = {
    ...newHistoryEntry({ id: 'run-1', command: 'cancel my recurring investments', now }),
    state: 'parked',
    headline: 'Stopped before the irreversible step.',
    pending: localStepPending(
      {
        call: { type: 'click', params: { ref: 'e4' } },
        effect: 'outward',
        reason: 'The click target reads as a commit point: "Cancel plan".',
        runId: 'run-1',
        approvalId: 'apr-run-1-1',
      },
      now,
    ),
  }

  const view = describeEntry(entry, now + 1_000)
  assert.equal(view.canDecide, true)
  assert.equal(view.showDashboardLink, false)
  assert.equal(entry.pending.call.type, 'click')
  assert.equal(entry.pending.runId, 'run-1')
})

test('the popup shows the current task and nothing behind it', () => {
  const now = Date.now()
  const older = newHistoryEntry({ id: 'older', command: 'first', now: now - 5_000 })
  const newest = newHistoryEntry({ id: 'newest', command: 'second', now })

  /* appendHistory puts newest first; the popup paints exactly that one. */
  const history = appendHistory(appendHistory([], older), newest)
  assert.equal(currentEntry(history).id, 'newest')
  assert.equal(currentEntry([]), null)
  assert.equal(currentEntry(undefined), null)
  /* Storage still keeps the rest — this is a rendering rule, not a purge. */
  assert.equal(history.length, 2)
})

test('the dashboard link prefers the name the agent prints for itself', () => {
  assert.equal(dashboardUrlFor('http://127.0.0.1:8000'), 'http://localhost:8000/dashboard')
  assert.equal(dashboardUrlFor('http://localhost:9000'), 'http://localhost:9000/dashboard')
  assert.equal(dashboardUrlFor('not a url'), 'http://localhost:8000/dashboard')
})

test('the popup says which brain it will use, and never overclaims', () => {
  /*
   * THE DEFECT THIS GUARDS, found by the owner on 2026-08-09 asking why
   * everything went to the Mac. Routing is brain-first, but the brain needs a
   * relay credential; with none paired, brainAvailability() fails at its first
   * line and every command falls through to the Mac. That is the designed
   * fallback — and it was invisible, because the footer went on saying "this
   * browser thinks for itself" regardless.
   */
  const paired = describeBrainState({ relayStatus: { state: 'connected' }, agentConfigured: true })
  assert.equal(paired.brain, 'local')
  /* Wording shortened 2026-08-12 (owner: no long paragraphs in the popup);
   * the claim it guards is the same — local thinking is only stated when
   * the relay leg is genuinely connected. */
  assert.match(paired.help, /Thinks and acts in your signed-in tabs/)

  /* Unpaired: the claim must be gone, and the fix named. */
  const unpaired = describeBrainState({ relayStatus: { state: 'off' }, agentConfigured: true })
  assert.equal(unpaired.brain, 'mac')
  assert.equal(unpaired.help.includes('thinks for itself'), false)
  assert.match(unpaired.help, /no brain of its own/)
  /* The fix is named where it now lives: the popup's own pairing box, not the
   * settings page the owner deleted (2026-08-12). */
  assert.match(unpaired.help, /pairing code/)
  assert.equal(unpaired.help.includes('Settings'), false)

  /* No relayStatus at all is the same case, not a crash: a browser that has
   * never reached the relay has never written the key. */
  const cold = describeBrainState({})
  assert.equal(cold.brain, 'mac')
  assert.match(cold.help, /pairing code/)
  assert.equal(cold.help.includes('Settings'), false)

  /* A rejected credential needs a different fix from never having had one. */
  const stale = describeBrainState({ relayStatus: { state: 'unauthorized' }, agentConfigured: true })
  assert.equal(stale.tone, 'error')
  assert.match(stale.help, /pairing code/)

  /* Neither peer: say so rather than promising a Mac that is not there. */
  const nothing = describeBrainState({ relayStatus: { state: 'off' }, agentConfigured: false })
  assert.match(nothing.help, /not set up.*pairing code/)
})

test('a working entry reports the route the background actually took', () => {
  /*
   * THE BUG, seen by the owner on the first command after the brain shipped:
   * the popup said "Asking the Mac agent…" the instant Send was pressed, no
   * matter where the command went. It was a FIXED string — true when the Mac
   * was the only destination, a lie the moment this node grew a brain, and it
   * appeared "immediately" because it was never looking at anything.
   *
   * background.js narrates the route as it happens; all of it was discarded
   * here.
   */
  const now = Date.now()
  const base = newHistoryEntry({ id: 'a', command: 'find the movies', now })

  const thinking = describeEntry({ ...base, headline: 'Thinking in this browser…' }, now)
  assert.equal(thinking.state, 'working')
  assert.equal(thinking.headline, 'Thinking in this browser…')

  const handedOff = describeEntry(
    { ...base, headline: 'Handing this to the Mac — no relay credential is configured.' },
    now,
  )
  assert.match(handedOff.headline, /Handing this to the Mac/)

  /* No headline yet: say something that claims nothing about which machine is
   * busy, rather than naming one. */
  const fresh = describeEntry(base, now)
  assert.equal(fresh.headline, 'Working on it…')
  assert.equal(fresh.headline.includes('Mac'), false)
})

test('the pop-out ladder skips what a browser lacks and never double-opens', () => {
  /*
   * THE BUG (owner, 2026-08-10: "after I first expand the pop-up and then
   * collapse it, I'm not able to open the pop-up again"). Two defects met in
   * the pop-out handler, and this pins the half that is decidable purely.
   *
   * The ladder tested `if (await rung())` — a falsy return meant "declined,
   * try the next". A browser that opens the window and returns nothing is
   * indistinguishable from one that refused, so one click could open a popup
   * window AND a pinned tab AND a plain tab AND another window. Availability
   * is now decided up front, from what the API actually has.
   */
  assert.deepEqual(
    consoleWindowRungs({ hasWindowsCreate: true, hasTabsCreate: true }),
    ['popup-window', 'pinned-tab', 'tab', 'window'],
  )

  /* Tabs-only: no window rungs offered at all, rather than called and caught. */
  assert.deepEqual(consoleWindowRungs({ hasTabsCreate: true }), ['pinned-tab', 'tab'])

  /* Windows-only still ends with the plain window — the rung that exists for
   * Safari running with no window open, where a tab has nowhere to go. */
  assert.deepEqual(consoleWindowRungs({ hasWindowsCreate: true }), ['popup-window', 'window'])

  /* A browser with neither gets an empty ladder and an honest message, not a
   * silent no-op. */
  assert.deepEqual(consoleWindowRungs({}), [])
  assert.deepEqual(consoleWindowRungs(), [])
})
