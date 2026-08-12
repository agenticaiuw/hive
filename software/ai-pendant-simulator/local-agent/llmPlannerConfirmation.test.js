/*
 * Who decides whether the owner is asked.
 *
 * The planner used to decide, with a constant: every plan confirmed except one
 * made entirely of get_weather / get_time / translate_text. The owner replaced
 * that with a rule about SCOPE — "the request is the authorization; ask only
 * for what I did not ask for" — and moved the decision to the model, which is
 * the only party that can compare a plan against a sentence.
 *
 * These tests hold both halves: an in-scope plan runs, and a model that
 * chooses to ask is heard, with its reason intact all the way to the caller.
 */
process.env.FULL_CONTROL_MODE = 'true'
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_ENABLED = 'true'
process.env.LLM_API_BASE_URL = 'https://api.openai.com/v1'
process.env.LLM_MODEL = 'gpt-5.6-luna'
process.env.PENDANT_TOOL_DISCOVERY = 'off'
/* Everything here is about what the PLANNER returns, and the deterministic
 * table would execute some of these commands for real before a model ever saw
 * them. Off, so every case in this file reaches the planner. */
process.env.PENDANT_FAST_PATH = 'off'

import assert from 'node:assert/strict'
import test from 'node:test'
import './testWorkspace.js'

const { buildPlannerSystemPrompt, planCommand } = await import('./llmPlanner.js')

/** The exact script the planner produced on 2026-08-09, tabs and all. */
const READING_LIST_SCRIPT = `tell application "Safari"
\tset itemsList to every reading list item
\tset rows to {}
\trepeat with i in itemsList
\t\tset end of rows to {(date added of i), (name of i), (URL of i)}
\tend repeat
end tell
return output`

function stubModel(content) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { content } }] }),
  })
  return () => {
    globalThis.fetch = original
  }
}

const planOf = (reply) => JSON.stringify(reply)

/*
 * The incident. One read-only AppleScript, planned from a direct question,
 * parked for an approval nobody had asked for — on a device with no way to
 * give one.
 */
test('the reading-list question runs instead of parking', async (t) => {
  t.after(
    stubModel(
      planOf({
        status: 'ready',
        actions: [
          {
            type: 'run_applescript',
            label: 'Read the Safari reading list',
            params: { script: READING_LIST_SCRIPT },
          },
        ],
      }),
    ),
  )

  const plan = await planCommand(
    'What are the four latest items on my Safari reading list?',
  )

  assert.equal(plan.status, 'ready')
  assert.equal(plan.requiresConfirmation, false)
  assert.equal(plan.confirmReason, undefined)
  assert.equal(plan.actions[0].type, 'run_applescript')
  assert.ok(!/before confirming/i.test(plan.safety), `safety line still nags: ${plan.safety}`)
})

test("the owner's own friction example runs: a reminder they asked for", async (t) => {
  t.after(
    stubModel(
      planOf({
        status: 'ready',
        actions: [
          {
            type: 'create_reminder',
            label: 'Remind you to call mom at 6',
            params: { title: 'Call mom', time: 'today 6pm' },
          },
        ],
      }),
    ),
  )

  const plan = await planCommand('remind me to call mom at 6')
  assert.equal(plan.requiresConfirmation, false)
  assert.equal(plan.actions[0].type, 'create_reminder')
})

/*
 * The mutation check. Putting the constant back — in either direction — has to
 * break a named test, or the next refactor quietly restores the thing the
 * owner removed.
 */
test('confirmation is never asserted: a plan that does not ask, runs', async (t) => {
  const CASES = [
    { type: 'delete_path', params: { path: '/Users/test/scratch/old.txt' } },
    { type: 'send_email', params: { to: 'a@b.c', subject: 'hi', body: 'hi' } },
    { type: 'run_shell', params: { command: 'rm -rf /Users/test/scratch' } },
    { type: 'get_weather', params: { location: 'Madison' } },
  ]

  for (const action of CASES) {
    const restore = stubModel(
      planOf({ status: 'ready', actions: [{ ...action, label: action.type }] }),
    )
    const plan = await planCommand(`do the thing: ${action.type}`)
    restore()
    assert.equal(
      plan.requiresConfirmation,
      false,
      `${action.type} was gated by code, not by the model's judgement`,
    )
  }
  t.diagnostic('a hardcoded requiresConfirmation: true fails this test')
})

test('the three formerly-whitelisted types are no longer special — they just run', async (t) => {
  for (const type of ['get_weather', 'get_time', 'translate_text']) {
    const restore = stubModel(
      planOf({ status: 'ready', actions: [{ type, label: type, params: {} }] }),
    )
    const plan = await planCommand(`the ${type} one`)
    restore()
    assert.equal(plan.requiresConfirmation, false)
    // …and they take the same path everything else does, with no trio named
    // anywhere in the planner to keep them company.
    assert.equal(plan.status, 'ready')
  }
  t.diagnostic('no action-type whitelist remains in llmPlanner.js')
})

/*
 * The other half. Judgement is only real if the model can act on it, so a plan
 * that asks must park AND carry the reason it asked — the owner reads "I also
 * wanted to X because Y", never a generic block.
 */
test('a model that asks is heard, and its reason survives to the caller', async (t) => {
  t.after(
    stubModel(
      planOf({
        status: 'ready',
        requiresConfirmation: true,
        confirmReason:
          'You asked me to file the invoices, but 12 look like duplicates and deleting them cannot be undone.',
        actions: [
          { type: 'tidy_downloads_apply', label: 'File the invoices', params: { planId: 'p1' } },
          { type: 'delete_path', label: 'Delete the duplicates', params: { path: '/Users/test/dupes' } },
        ],
      }),
    ),
  )

  const plan = await planCommand('file the invoices in my Downloads folder')

  assert.equal(plan.requiresConfirmation, true)
  assert.match(plan.confirmReason, /cannot be undone/)
  // The reason leads, rather than a notice the owner has read a hundred times.
  assert.match(plan.safety, /^Waiting on you: /)
  assert.match(plan.safety, /duplicates/)
  // The step it wants permission for is still in the plan, not dropped and not
  // smuggled through.
  assert.equal(plan.actions.length, 2)
  assert.ok(plan.actions.some((action) => action.type === 'delete_path'))
})

test('an ask with no reason is still an ask, and says so plainly', async (t) => {
  t.after(
    stubModel(
      planOf({
        status: 'ready',
        requiresConfirmation: true,
        actions: [{ type: 'open_app', label: 'Open Notes', params: { appName: 'Notes' } }],
      }),
    ),
  )

  const plan = await planCommand('open notes')
  assert.equal(plan.requiresConfirmation, true)
  assert.match(plan.confirmReason, /without saying why/)
})

test('only a literal true asks — a chatty model cannot park a plan by accident', async () => {
  for (const value of ['true', 1, 'yes', {}, null]) {
    const restore = stubModel(
      planOf({
        status: 'ready',
        requiresConfirmation: value,
        actions: [{ type: 'open_app', label: 'Open Notes', params: { appName: 'Notes' } }],
      }),
    )
    const plan = await planCommand('open notes')
    restore()
    assert.equal(plan.requiresConfirmation, false, `${JSON.stringify(value)} parked a plan`)
  }
})

/*
 * A reason the owner never sees is a reason that was not given. The plan
 * travels planner → orchestrator → HTTP by being spread, so this holds the
 * field on that path: it is one `...plan` away from being dropped silently.
 */
test('the ask and its reason reach the surface that renders a parked plan', async (t) => {
  t.after(
    stubModel(
      planOf({
        status: 'ready',
        requiresConfirmation: true,
        confirmReason: 'I also wanted to archive last year, which you did not ask for.',
        actions: [
          { type: 'create_note', label: 'Write the summary', params: { filename: 'q3.md', content: 'x' } },
        ],
      }),
    ),
  )

  const { orchestratePlan } = await import('./orchestrator.js')
  const result = await orchestratePlan({
    command: 'summarise the quarterly widget reconciliation',
    source: 'local',
  })

  assert.equal(result.status, 'ready')
  assert.equal(result.requiresConfirmation, true)
  assert.match(result.confirmReason, /archive last year/)
  assert.match(result.safety, /archive last year/)
})

/*
 * The rule has to be IN the prompt, because the prompt is now where the policy
 * lives. A model that is never told the owner's request is authorization will
 * fall back on its own caution and re-create the friction by hand.
 */
test('the scope rule and the way to ask are both in the system prompt', () => {
  const prompt = buildPlannerSystemPrompt({
    tier: 'planner',
    machinePrompt: 'MACHINE',
    home: '/Users/test',
  })

  assert.match(prompt, /The owner's request IS your authorization/)
  assert.match(prompt, /Ask ONLY when a step goes beyond what they asked for/)
  assert.match(prompt, /"requiresConfirmation": true only if you are asking permission/)
  assert.match(prompt, /"confirmReason"/)
  // The accountability half of the trade is stated too: it is what makes
  // running-by-default defensible rather than merely cheaper.
  assert.match(prompt, /recorded and can be undone/)

  const small = buildPlannerSystemPrompt({
    tier: 'background',
    machinePrompt: 'MACHINE',
    home: '/Users/test',
  })
  assert.match(small, /The owner's request is your authorization/)
  assert.match(small, /"confirmReason"/)
})
