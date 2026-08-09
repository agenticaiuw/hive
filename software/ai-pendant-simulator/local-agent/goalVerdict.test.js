/*
 * The regression this file pins: 2026-08-09, "open ibkr and cancel my
 * recurring investments" planned as [open_url, ui_snapshot], both steps ran,
 * the run was stamped done, and nothing was cancelled. Everything here is a
 * SYNTHETIC fixture — no browser, no network, no real brokerage, ever.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import './testWorkspace.js'

const {
  applyGoalVerdict,
  assessGoalOutcome,
  assessPlanCoverage,
  describeGoal,
  stepTier,
} = await import('./goalVerdict.js')

/* The incident, as data. Fake goal, fake plan, fake per-step results. */
const IBKR_COMMAND = 'open ibkr and cancel my recurring investments'
const IBKR_ACTIONS = [
  {
    type: 'open_url',
    label: 'Open Interactive Brokers',
    params: { url: 'https://www.interactivebrokers.com' },
  },
  { type: 'ui_snapshot', label: 'Snapshot the page', params: {} },
]
const IBKR_RESULTS = [
  {
    action: IBKR_ACTIONS[0],
    ok: true,
    status: 'success',
    message: 'Opened https://www.interactivebrokers.com',
  },
  {
    action: IBKR_ACTIONS[1],
    ok: true,
    status: 'success',
    message: 'Captured 40 interactive elements',
  },
]

test('the IBKR run is never done: clean steps, unmet goal → incomplete', () => {
  const { status, verdict, response } = applyGoalVerdict({
    command: IBKR_COMMAND,
    actions: IBKR_ACTIONS,
    results: IBKR_RESULTS,
    status: 'success',
  })

  assert.equal(status, 'incomplete', 'a goal nothing acted on must not be success')
  assert.notEqual(status, 'success')
  assert.equal(verdict.met, false)
  assert.equal(verdict.attempted, false)

  // The text names what WAS done…
  assert.match(response, /Opened https:\/\/www\.interactivebrokers\.com/)
  assert.match(response, /looked at the page/)
  // …and what was NOT.
  assert.match(response, /nothing was cancelled/i)
  assert.match(response, /cancelling your recurring investments/i)
  assert.ok(!/\bdone\b/i.test(response), `verdict text claims done: ${response}`)
})

test('the unmet IBKR remainder is needs_approval-compatible', () => {
  const verdict = assessGoalOutcome({
    command: IBKR_COMMAND,
    actions: IBKR_ACTIONS,
    results: IBKR_RESULTS,
  })

  assert.ok(verdict.remainder, 'an unmet change goal must carry a remainder')
  assert.equal(verdict.remainder.needsApproval, true)
  /* The exact word pipelineTrace exports, so the approval-at-origin flow can
   * key on it without translating. */
  assert.equal(verdict.remainder.status, 'needs_approval')
  assert.match(verdict.remainder.text, /needs your approval/)
  assert.match(verdict.remainder.reason, /approval/)
})

test('a look goal stays exactly what the steps said', () => {
  const { status, verdict, response } = applyGoalVerdict({
    command: 'open interactivebrokers.com',
    actions: [IBKR_ACTIONS[0]],
    results: [IBKR_RESULTS[0]],
    status: 'success',
  })
  assert.equal(status, 'success')
  assert.equal(verdict.met, true)
  assert.equal(response, null, 'a met goal keeps the caller’s own response text')
})

test('an acting step aimed at the goal makes the run done', () => {
  const click = {
    type: 'browser_click',
    label: 'Click Cancel next to the recurring deposit',
    params: { selector: '#cancel-recurring' },
  }
  const { status, verdict } = applyGoalVerdict({
    command: IBKR_COMMAND,
    actions: [...IBKR_ACTIONS, click],
    results: [...IBKR_RESULTS, { action: click, ok: true, message: 'Clicked Cancel' }],
    status: 'success',
  })
  assert.equal(status, 'success')
  assert.equal(verdict.met, true)
  assert.equal(verdict.carriers, 1)
})

test('a planned-but-never-run carrier is not an attempt', () => {
  const click = {
    type: 'browser_click',
    label: 'Click Cancel next to the recurring deposit',
    params: { selector: '#cancel-recurring' },
  }
  const verdict = assessGoalOutcome({
    command: IBKR_COMMAND,
    actions: [...IBKR_ACTIONS, click],
    /* The click never ran — a drift stop after the first two steps. */
    results: IBKR_RESULTS,
  })
  assert.equal(verdict.met, false)
  assert.equal(verdict.attempted, false)
})

test('type affinity: send_email carries a send goal without saying the word', () => {
  const send = {
    type: 'send_email',
    label: 'Mail the figures',
    params: { to: 'priya@example.com' },
  }
  const { status, verdict } = applyGoalVerdict({
    command: 'send the survey results to Priya',
    actions: [send],
    results: [{ action: send, ok: true, message: 'Sent.' }],
    status: 'success',
  })
  assert.equal(status, 'success')
  assert.equal(verdict.met, true)
})

test('failed and blocked runs pass through untouched', () => {
  for (const stepStatus of ['failed', 'blocked']) {
    const { status, response } = applyGoalVerdict({
      command: IBKR_COMMAND,
      actions: IBKR_ACTIONS,
      results: [{ action: IBKR_ACTIONS[0], ok: false, message: 'Failed: offline' }],
      status: stepStatus,
    })
    assert.equal(status, stepStatus)
    assert.equal(response, null)
  }
})

test('questions about changes are reads, not change goals', () => {
  assert.equal(describeGoal('did I cancel my Netflix subscription').wantsChange, false)
  assert.equal(describeGoal('what did I order last week').wantsChange, false)
  assert.equal(describeGoal('show me my cancelled orders').wantsChange, false)
})

test('nouns and negations do not make a change goal', () => {
  assert.equal(describeGoal('read the text on the screen').wantsChange, false)
  assert.equal(describeGoal('open the book review in Safari').wantsChange, false)
  assert.equal(
    describeGoal('do not cancel anything, just list the subscriptions').wantsChange,
    false,
  )
  assert.equal(describeGoal('make sure the deck is ready').wantsChange, false)
})

test('the goal object is addressed to the owner: my → your', () => {
  const goal = describeGoal(IBKR_COMMAND)
  assert.equal(goal.wantsChange, true)
  assert.equal(goal.object, 'your recurring investments')
  assert.equal(goal.gerundPhrase, 'cancelling your recurring investments')
})

test('script steps are tiered by body, reusing scriptEffects', () => {
  assert.equal(
    stepTier({ type: 'run_shell', params: { command: 'ls /tmp/logs' } }),
    'observe',
  )
  assert.equal(
    stepTier({ type: 'run_shell', params: { command: 'rm -f /tmp/build.log' } }),
    'mutate',
  )
  assert.equal(stepTier({ type: 'open_url', params: {} }), 'observe')
  assert.equal(stepTier({ type: 'browser_click', params: {} }), 'interact')
  assert.equal(stepTier({ type: 'delete_path', params: {} }), 'mutate')
})

test('a mutating shell step at the goal object counts as the attempt', () => {
  const rm = {
    type: 'run_shell',
    label: 'Remove the log',
    params: { command: 'rm -f /tmp/build.log' },
  }
  const { status, verdict } = applyGoalVerdict({
    command: 'delete the old build logs',
    actions: [rm],
    results: [{ action: rm, ok: true, message: 'Removed.' }],
    status: 'success',
  })
  assert.equal(status, 'success')
  assert.equal(verdict.met, true)
})

test('a reversible unmet remainder waits without an approval claim', () => {
  const look = { type: 'search_file', label: 'Find the notes', params: { query: 'antenna' } }
  const verdict = assessGoalOutcome({
    command: 'create a note about the pendant antenna',
    actions: [look],
    results: [{ action: look, ok: true, message: 'Found 3 matches' }],
  })
  assert.equal(verdict.met, false)
  assert.equal(verdict.remainder.needsApproval, false)
  assert.equal(verdict.remainder.status, 'pending')
  assert.ok(!/approval/i.test(verdict.remainder.text))
})

test('plan coverage marks look-only plans for change goals as reconnaissance', () => {
  const recon = assessPlanCoverage(IBKR_COMMAND, IBKR_ACTIONS)
  assert.equal(recon.reconnaissance, true)
  assert.match(recon.note, /cancelling your recurring investments/i)
  assert.match(recon.note, /Reconnaissance only/)

  const acting = assessPlanCoverage(IBKR_COMMAND, [
    ...IBKR_ACTIONS,
    { type: 'browser_click', label: 'Click Cancel', params: {} },
  ])
  assert.equal(acting.reconnaissance, false)

  const readGoal = assessPlanCoverage('open interactivebrokers.com', IBKR_ACTIONS)
  assert.equal(readGoal.reconnaissance, false)
})
