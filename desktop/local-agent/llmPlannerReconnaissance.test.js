/*
 * The upstream half of the 2026-08-09 false-done incident: the planner
 * answered "open ibkr and cancel my recurring investments" with a plan that
 * only opens and snapshots, and nothing marked that plan as less than the
 * whole task. Here the model is a stub (node --test gives this file its own
 * process, so the module-level consts are pinned before import). No real
 * site, no network: the fetch stub answers everything.
 */
process.env.FULL_CONTROL_MODE = 'true'
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_ENABLED = 'true'
process.env.LLM_API_BASE_URL = 'https://api.openai.com/v1'
process.env.LLM_MODEL = 'gpt-5.6-luna'
process.env.PENDANT_TOOL_DISCOVERY = 'off'

import assert from 'node:assert/strict'
import test from 'node:test'
import './testWorkspace.js'

const { buildPlannerSystemPrompt, planCommand } = await import('./llmPlanner.js')

function stubModel(replies) {
  const queue = [...replies]
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({
      choices: [
        {
          message: {
            content:
              queue.shift() ?? '{"status":"unsupported","error":"no reply queued"}',
          },
        },
      ],
    }),
  })
  return {
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const RECON_PLAN = JSON.stringify({
  status: 'ready',
  actions: [
    {
      type: 'open_url',
      label: 'Open Interactive Brokers',
      params: { url: 'https://www.interactivebrokers.com' },
    },
    { type: 'ui_snapshot', label: 'Snapshot the page', params: {} },
  ],
})

const ACTING_PLAN = JSON.stringify({
  status: 'ready',
  actions: [
    {
      type: 'open_url',
      label: 'Open Interactive Brokers',
      params: { url: 'https://www.interactivebrokers.com' },
    },
    {
      type: 'browser_click',
      label: 'Click Cancel next to the recurring deposit',
      params: { selector: '#cancel-recurring' },
    },
  ],
})

test('a look-only plan for an irreversible goal is stamped as reconnaissance', async (t) => {
  const model = stubModel([RECON_PLAN])
  t.after(model.restore)

  const plan = await planCommand('open ibkr and cancel my recurring investments')
  assert.equal(plan.status, 'ready')
  assert.ok(plan.partial, 'the plan must carry a partial marker')
  assert.equal(plan.partial.reconnaissance, true)
  assert.match(plan.partial.note, /Reconnaissance only/)
  assert.match(plan.partial.remainder, /cancelling your recurring investments/i)
  /* The safety line the surfaces show must say "looking first", not
   * "running what you asked for". */
  assert.match(plan.safety, /Reconnaissance only/)
})

test('a plan that carries the acting step is not marked partial', async (t) => {
  const model = stubModel([ACTING_PLAN])
  t.after(model.restore)

  const plan = await planCommand('open ibkr and cancel my recurring investments')
  assert.equal(plan.status, 'ready')
  assert.equal(plan.partial, undefined)
  assert.match(plan.safety, /Running what you asked for/)
})

test('a read goal is never marked partial, whatever the plan shape', async (t) => {
  const model = stubModel([RECON_PLAN])
  t.after(model.restore)

  const plan = await planCommand('open interactivebrokers.com and read the page')
  assert.equal(plan.status, 'ready')
  assert.equal(plan.partial, undefined)
})

test('the planner prompt says a look-only plan does not complete a change', () => {
  const prompt = buildPlannerSystemPrompt({ machinePrompt: '' })
  assert.match(prompt, /not completed by a plan that only opens and reads/)
  assert.match(prompt, /reconnaissance/i)
})
