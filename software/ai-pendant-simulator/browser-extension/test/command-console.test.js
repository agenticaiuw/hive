import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HISTORY_LIMIT,
  appendHistory,
  buildCommandText,
  dashboardUrlFor,
  describeEntry,
  describeResults,
  interpretExecuteResponse,
  interpretPlanResponse,
  newHistoryEntry,
  outcomeToPatch,
  patchHistory,
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

test('a ready plan that requires confirmation parks for the dashboard', () => {
  const outcome = interpretPlanResponse({ status: 200, payload: READY_PLAN })
  assert.equal(outcome.kind, 'parked')
  assert.match(outcome.detail, /Send the weekly email/)
  assert.match(outcome.detail, /Touches: Mail/)
  assert.match(outcome.safety, /until you confirm/)
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

test('the dashboard link prefers the name the agent prints for itself', () => {
  assert.equal(dashboardUrlFor('http://127.0.0.1:8000'), 'http://localhost:8000/dashboard')
  assert.equal(dashboardUrlFor('http://localhost:9000'), 'http://localhost:9000/dashboard')
  assert.equal(dashboardUrlFor('not a url'), 'http://localhost:8000/dashboard')
})
