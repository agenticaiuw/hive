// Same trick as llmPlannerVision.test.js: node --test gives each file its own
// process, so the model names are pinned here before the module is imported.
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_API_BASE_URL = 'https://api.openai.com/v1'
process.env.LLM_MODEL = 'gpt-5.6-luna'
process.env.LLM_BACKGROUND_MODEL = 'gpt-4.1-mini'

import assert from 'node:assert/strict'
import test from 'node:test'

const {
  actionSchemaForTier,
  backgroundModelName,
  plannerModelName,
  requestLlmPlanContent,
} = await import('./llmPlanner.js')
const { formatMachineContextForPrompt } = await import('./machineContext.js')

const MACHINE = {
  home: '/Users/test',
  hostname: 'test-mac',
  platform: 'darwin',
  timezone: 'America/New_York',
  applications: ['Safari', 'Notes'],
  automation: {
    macosVersion: '26.1',
    arch: 'arm64',
    shortcuts: ['Morning'],
    // The CLI inventory is the single biggest block in the planner prompt.
    cliTools: Array.from({ length: 400 }, (_, index) => `tool-${index}`),
  },
}

test('the background schema is a strict subset of the planner schema', () => {
  const planner = actionSchemaForTier('planner')
  const background = actionSchemaForTier('background')

  for (const [type, spec] of Object.entries(background)) {
    // Derived, never duplicated: descriptions must be identical objects.
    assert.equal(spec, planner[type], `${type} drifted from the full schema`)
  }
  assert.ok(Object.keys(background).length < Object.keys(planner).length)
})

test('the cheap tier cannot reach the action types that need judgement', () => {
  const background = actionSchemaForTier('background')
  for (const type of [
    'run_shell',
    'run_applescript',
    'computer_use_task',
    'send_email',
    'browser_navigate',
    'ui_click',
    'delete_path',
  ]) {
    assert.equal(background[type], undefined, `${type} must not be in the cheap tier`)
  }
  // …but the everyday ones are all still there.
  for (const type of ['open_app', 'set_volume', 'get_mac_status', 'create_reminder']) {
    assert.ok(background[type], `${type} should be planable on the cheap tier`)
  }
})

test('the cheap tier prompt is dramatically smaller — that is the whole point', () => {
  const plannerChars = JSON.stringify(actionSchemaForTier('planner'), null, 2).length
  const backgroundChars = JSON.stringify(actionSchemaForTier('background'), null, 2).length
  const plannerMachine = formatMachineContextForPrompt(MACHINE).length
  const compactMachine = formatMachineContextForPrompt(MACHINE, { compact: true }).length

  assert.ok(
    backgroundChars < plannerChars * 0.5,
    `background schema ${backgroundChars} should be under half of ${plannerChars}`,
  )
  assert.ok(
    compactMachine < plannerMachine * 0.5,
    `compact machine block ${compactMachine} should be under half of ${plannerMachine}`,
  )
  // The compact block still names the apps: "open X" is only right if X exists.
  assert.match(formatMachineContextForPrompt(MACHINE, { compact: true }), /Safari/)
})

test('a tier override picks the model and token ceiling; omitting it does not', async () => {
  const sent = []
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body))
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: '{"status":"ready"}' } }] }),
    }
  }

  await requestLlmPlanContent({
    headers: {},
    systemPrompt: 'sys',
    userContent: 'do it',
    fetchImpl,
    model: backgroundModelName(),
    maxTokens: 768,
  })
  assert.equal(sent[0].model, 'gpt-4.1-mini')
  assert.equal(sent[0].max_completion_tokens, 768)

  await requestLlmPlanContent({
    headers: {},
    systemPrompt: 'sys',
    userContent: 'do it',
    fetchImpl,
  })
  assert.equal(sent[1].model, plannerModelName())
  assert.ok(sent[1].max_completion_tokens >= 128)
})
