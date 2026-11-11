// node --test gives each file its own process, so the planner's module-level
// consts are pinned here before it is ever imported. Discovery is ON in this
// file; llmPlannerDiscoveryOff.test.js is the same planner with it disabled.
process.env.FULL_CONTROL_MODE = 'true'
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_ENABLED = 'true'
process.env.LLM_API_BASE_URL = 'https://api.openai.com/v1'
process.env.LLM_MODEL = 'gpt-5.6-luna'
process.env.LLM_BACKGROUND_MODEL = 'gpt-4.1-mini'
process.env.PENDANT_TOOL_DISCOVERY = 'on'

import assert from 'node:assert/strict'
import os from 'node:os'
import test from 'node:test'

const { formatMachineContextForPrompt, getMachineContext } = await import(
  './machineContext.js'
)
const {
  actionSchemaForTier,
  buildPlannerSystemPrompt,
  planCommand,
} = await import('./llmPlanner.js')
const discovery = await import('./toolDiscovery.js')
const { classifyTier, matchDeterministic, TIER_DETERMINISTIC } = await import(
  './policyRouter.js'
)

const MACHINE = 'MACHINE-CONTEXT-BLOCK'
const HOME = '/Users/test'

/*
 * Stand in for the model. Records every request the planner makes so the test
 * can assert on the prompt that was actually sent — the prompt is the result
 * here, so measuring a reconstruction of it would measure nothing.
 */
function stubModel(replies) {
  const sent = []
  const queue = [...replies]
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    sent.push(body)
    const content = queue.shift() ?? '{"status":"unsupported","error":"no reply queued"}'
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content } }] }),
    }
  }
  return {
    sent,
    systemPrompts: () => sent.map((body) => body.messages[0].content),
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const READY_VOLUME =
  '{"status":"ready","actions":[{"type":"set_volume","label":"Set volume to 30%","params":{"level":30}}]}'

test('the first-level prompt is a catalogue: domains, and not one capability', async (t) => {
  const model = stubModel(['{"domains":["system"]}', READY_VOLUME])
  t.after(model.restore)

  const plan = await planCommand('set the volume to 30 and tell me the battery')
  assert.equal(plan.status, 'ready')
  assert.equal(model.sent.length, 2, 'one discovery pre-pass, one planning call')

  const [discoveryPrompt, planningPrompt] = model.systemPrompts()

  // Level 1 carries shelf labels only.
  assert.match(discoveryPrompt, /tool-discovery layer/)
  assert.match(discoveryPrompt, /^system \(\d+\) — /m)
  assert.ok(!discoveryPrompt.includes('set_volume'), 'level 1 named an action type')
  assert.ok(!discoveryPrompt.includes('browser_navigate'), 'level 1 named an action type')

  // Level 3 arrives only for the domain that was asked for.
  assert.ok(planningPrompt.includes('set_volume'), 'the tool it needs did not arrive')
  assert.ok(planningPrompt.includes('get_battery'))
  assert.ok(!planningPrompt.includes('browser_navigate'), 'a whole unrelated shelf was delivered')
  assert.ok(!planningPrompt.includes('ios_tap_text'))

  // The cheap discovery model plans nothing; the real planner plans.
  assert.equal(model.sent[0].model, 'gpt-4.1-mini')
  assert.equal(model.sent[1].model, 'gpt-5.6-luna')
})

test('the measured prompt for a real command is a fraction of the flat one', async (t) => {
  const model = stubModel(['{"domains":["system"]}', READY_VOLUME])
  t.after(model.restore)

  const plan = await planCommand('set the volume to 30 and tell me the battery')
  const [discoveryPrompt, planningPrompt] = model.systemPrompts()

  /* What this file would have sent for the same command: the same builder,
   * unscoped, over the same live machine block — extracted from the prompt
   * that was actually sent so the two differ only in how tools were delivered. */
  const machinePrompt = formatMachineContextForPrompt(await getMachineContext())
  const flat = buildPlannerSystemPrompt({
    tier: 'planner',
    machinePrompt,
    home: os.homedir(),
  })
  assert.ok(planningPrompt.includes(machinePrompt), 'measuring against a different machine block')

  const flatSchema = JSON.stringify(actionSchemaForTier('planner'), null, 2).length
  const scopedSchema = discovery.renderToolSchemas(discovery.toolsForDomains(['system'])).length

  // The headline: the schema block, which is the part discovery replaces.
  assert.ok(
    scopedSchema < flatSchema * 0.15,
    `schema block went ${flatSchema} → ${scopedSchema}; expected under 15%`,
  )
  // The whole turn, pre-pass included, against the whole flat prompt.
  assert.ok(
    planningPrompt.length + discoveryPrompt.length < flat.length * 0.6,
    `pre-pass + planning ${planningPrompt.length + discoveryPrompt.length} vs flat ${flat.length}`,
  )

  // The plan reports what it cost, across both calls.
  assert.equal(plan.usage.calls, 2)
  assert.equal(plan.usage.discovery, true)
  assert.equal(plan.usage.widened, false)
  assert.deepEqual(plan.usage.domains, ['system'])
  assert.equal(plan.usage.toolCount, discovery.toolsForDomains(['system']).length)
})

/*
 * The capability guarantee. A drilled-down prompt can be less capable than the
 * flat one in exactly two ways, and both are caught here.
 */
test('a planner short of tools asks for more instead of refusing', async (t) => {
  const model = stubModel([
    '{"domains":["files"]}',
    '{"status":"need_tools","domains":["browser"]}',
    '{"status":"ready","actions":[{"type":"browser_list_tabs","label":"List tabs","params":{}}]}',
  ])
  t.after(model.restore)

  const plan = await planCommand('read me the price on the flight tab I left open')

  assert.equal(plan.status, 'ready')
  assert.equal(plan.actions[0].type, 'browser_list_tabs')
  assert.equal(model.sent.length, 3, 'discovery, a short-handed plan, and one widening')
  assert.equal(plan.usage.widened, true)

  const widened = model.systemPrompts()[2]
  // Widening goes to the whole library — the prompt this file always sent.
  assert.ok(widened.includes('browser_list_tabs'))
  assert.ok(widened.includes('ios_tap_text'))
  assert.ok(!widened.includes('Tool domains NOT loaded'), 'nothing was withheld the second time')
})

test('a refusal made against a partial library is never believed on the spot', async (t) => {
  const model = stubModel([
    '{"domains":["info"]}',
    '{"status":"unsupported","error":"no tool for that"}',
    '{"status":"ready","actions":[{"type":"run_shell","label":"Run tests","params":{"command":"npm test"}}]}',
  ])
  t.after(model.restore)

  const plan = await planCommand('run npm test in the pendant repo')

  assert.equal(plan.status, 'ready', 'the flat schema could do it, so discovery must not lose it')
  assert.equal(plan.actions[0].type, 'run_shell')
  assert.equal(model.sent.length, 3)
  assert.equal(plan.usage.widened, true)
})

test('a request nothing can do still refuses, and only pays for one widening', async (t) => {
  const model = stubModel([
    '{"domains":["info"]}',
    '{"status":"unsupported","error":"cannot do that"}',
    '{"status":"unsupported","error":"cannot do that"}',
  ])
  t.after(model.restore)

  const plan = await planCommand('flibber the wozzle backwards')
  assert.equal(plan.status, 'unsupported')
  assert.equal(plan.error, 'cannot do that')
  assert.equal(model.sent.length, 3, 'bounded: never a fourth call')
})

test('a model that keeps asking for tools after being given all of them is a refusal', async (t) => {
  const model = stubModel([
    '{"domains":["info"]}',
    '{"status":"need_tools","domains":["browser"]}',
    '{"status":"need_tools","domains":["browser"]}',
  ])
  t.after(model.restore)

  const plan = await planCommand('do the impossible thing')
  // The failure mode this guards: "ready" with an empty action list, which the
  // orchestrator would take to confirmation as a plan with no steps in it.
  assert.equal(plan.status, 'unsupported')
  assert.equal(model.sent.length, 3)
})

test('discovery that fails falls back to the prompt this file always sent', async (t) => {
  const model = stubModel(['not json at all', READY_VOLUME])
  t.after(model.restore)

  const plan = await planCommand('set the volume to 30')
  assert.equal(plan.status, 'ready')
  assert.equal(model.sent.length, 2)

  const planningPrompt = model.systemPrompts()[1]
  assert.ok(planningPrompt.includes('browser_navigate'), 'a failed pre-pass must cost tokens, not capability')
  assert.ok(!planningPrompt.includes('Tool domains NOT loaded'))
})

test('a domain the model invents is dropped rather than trusted', async (t) => {
  const model = stubModel(['{"domains":["teleportation"]}', READY_VOLUME])
  t.after(model.restore)

  await planCommand('set the volume to 30')
  const planningPrompt = model.systemPrompts()[1]
  // Nothing real was selected, so the planner gets everything — degrading to
  // today's cost, never to a prompt with no tools in it.
  assert.ok(planningPrompt.includes('browser_navigate'))
})

/*
 * Discovery only changes HOW the schema is delivered. With nothing withheld,
 * the prompt is byte-for-byte the one HEAD sent — which is what makes the
 * widening path a real safety net rather than a differently-worded retry.
 */
test('an unscoped prompt is exactly the flat prompt, rules included', () => {
  const flat = buildPlannerSystemPrompt({ tier: 'planner', machinePrompt: MACHINE, home: HOME })

  assert.ok(flat.includes(JSON.stringify(actionSchemaForTier('planner'), null, 2)))
  assert.ok(flat.includes('- Choose dedicated action types yourself. Never invent keyword parsers.'))
  assert.ok(flat.includes('  6) Only use browser_capture or desktop computer_use_task'))
  assert.ok(flat.includes(`- Keep plans short (usually 1-3 steps). Use absolute paths under ${HOME} when possible.`))
  assert.ok(flat.includes('- If truly impossible, return status "unsupported" with a short reason.'))
  assert.ok(!flat.includes('Tool domains NOT loaded'))
})

test('a rule travels with the tools it talks about', () => {
  const names = discovery.toolsForDomains(['files'])
  const scoped = buildPlannerSystemPrompt({
    tier: 'planner',
    machinePrompt: MACHINE,
    home: HOME,
    schemaText: discovery.renderToolSchemas(names),
    toolNames: names,
    otherDomains: discovery.domainsExcept(['files']),
  })

  // Six lines of browser-session doctrine in a files-only prompt would not just
  // waste tokens, it would advertise browser_* to a model holding no browser
  // schema at all.
  assert.ok(!scoped.includes('browser_open_session'))
  assert.ok(!scoped.includes('ui_menu / ui_find / ui_click'))
  assert.ok(scoped.includes('- Destructive actions only when the user explicitly asks.'))
  assert.ok(scoped.includes('Tool domains NOT loaded for this request: agent, apps, briefings'))
  assert.ok(scoped.includes('"status":"need_tools"'))
})

test('the cheap tier gets the same types it always had, packed smaller', () => {
  const before = buildPlannerSystemPrompt({ tier: 'background', machinePrompt: MACHINE, home: HOME })
  const names = Object.keys(actionSchemaForTier('background'))
  const after = buildPlannerSystemPrompt({
    tier: 'background',
    machinePrompt: MACHINE,
    home: HOME,
    schemaText: discovery.renderToolSchemas(names),
    toolNames: names,
  })

  assert.ok(after.length < before.length, `${after.length} should be under ${before.length}`)
  for (const type of names) assert.ok(after.includes(`"${type}"`), `${type} left the cheap tier`)
  // Still walled off from the types that need judgement.
  for (const type of ['run_shell', 'browser_navigate', 'ui_click', 'delete_path']) {
    assert.ok(!after.includes(`"type":"${type}"`), `${type} must not be in the cheap tier`)
  }
})

/*
 * The path that must never pay for any of this. "Set volume to 30" resolved to
 * one action with no model call before discovery, and a discovery layer that
 * put a model call in front of it would have made the cheapest turn the agent
 * has more expensive than it was.
 */
test('the deterministic fast path still costs zero model calls', async (t) => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('the fast path must never reach a model')
  }
  t.after(() => {
    globalThis.fetch = original
  })

  const deterministic = await matchDeterministic('set volume to 30')
  assert.ok(deterministic, 'the utterance still resolves to one action')
  assert.equal(deterministic.actions[0].type, 'set_volume')
  assert.equal(
    classifyTier('set volume to 30', { deterministic }).tier,
    TIER_DETERMINISTIC,
  )
  assert.equal(calls, 0)
})
