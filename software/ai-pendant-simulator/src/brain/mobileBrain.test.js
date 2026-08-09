/*
 * The loop, driven by a scripted model.
 *
 * `infer` is a function, so the whole brain runs with no network, no API key
 * and no relay — which is the point of the seam in relayInference.js. Every
 * test here is about the loop's own behaviour: does it observe before it
 * concludes, does it widen when asked, and — the one that matters most — does
 * the confirmation gate open ONLY when the model opens it.
 *
 * No filesystem, no network, no workspace: everything here is pure.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DEVICE_SCOPES } from '../../cloud-relay/deviceAuth.js'
import {
  buildBrainSystemPrompt,
  describeSituation,
  fitMessagesToBudget,
  PROMPT_SCHEMA_BUDGET,
  runMobileBrain,
} from './mobileBrain.js'
import { buildMobileCatalogue, renderFullSchema, toolsForDomains } from './mobileDiscovery.js'
import { extractJsonObject, INFERENCE_LIMITS, parseModelJson } from './relayInference.js'
import { MOBILE_TOOL_TYPES } from './mobileTools.js'

/** A model that says exactly what the script says, in order. */
function scriptedModel(...answers) {
  const seen = []
  const infer = async ({ messages }) => {
    seen.push(messages.map((message) => ({ role: message.role, content: message.content })))
    const next = answers.shift()
    if (next === undefined) throw new Error('the script ran out of answers')
    return { content: typeof next === 'string' ? next : JSON.stringify(next), model: 'test-model' }
  }
  infer.seen = seen
  infer.remaining = () => answers.length
  return infer
}

/** A cloud client stub: only the methods the tools under test actually call. */
function stubClient(overrides = {}) {
  return {
    async readSharedState() {
      return { nodes: [{ id: 'mac', status: 'down', reason: 'lid shut' }] }
    },
    async bridgePresence() {
      return { ok: true, connected: false }
    },
    async deviceStatus() {
      return { ok: true, devices: [{ deviceId: 'home-macbook-bridge', deviceType: 'mac_bridge', online: false }] }
    },
    ...overrides,
  }
}

const baseCtx = () => ({
  client: stubClient(),
  deviceId: 'mobile-test',
  platform: 'test',
  navigator: { onLine: true, language: 'en-US' },
})

test('the loop observes, then answers from what it saw', async () => {
  const infer = scriptedModel(
    { status: 'act', say: 'Checking the hive.', actions: [{ tool: 'hive_read', label: 'read hive', params: { key: 'hive' } }] },
    { status: 'done', say: 'Your Mac is down — the lid is shut.' },
  )

  const phases = []
  const outcome = await runMobileBrain({
    command: 'is my mac awake?',
    infer,
    ctx: baseCtx(),
    onProgress: (event) => phases.push(event.phase),
    confirm: async () => {
      throw new Error('confirm must not be called when the model did not ask')
    },
  })

  assert.equal(outcome.status, 'done')
  assert.match(outcome.say, /lid is shut/)
  assert.equal(outcome.steps.length, 1)
  assert.equal(outcome.steps[0].tool, 'hive_read')
  assert.equal(outcome.steps[0].ok, true)
  assert.equal(outcome.turns, 2)
  assert.equal(outcome.usage.calls, 2)
  assert.ok(phases.includes('tool'))
  assert.ok(phases.includes('done'))

  /* The second call must have seen the tool result — otherwise it "concluded"
   * from nothing, which is the failure this whole loop exists to prevent. */
  const secondCall = infer.seen[1]
  assert.match(secondCall.at(-1).content, /Tool results/)
  assert.match(secondCall.at(-1).content, /hive_read/)
})

test('confirmation happens only when the model asks for it', async () => {
  const asked = []
  const infer = scriptedModel(
    {
      status: 'act',
      say: 'One moment.',
      requiresConfirmation: true,
      confirmReason: 'I also want to save this as a note for later — you did not ask for that.',
      actions: [{ tool: 'memory_save', label: 'save note', params: { name: 'x', observations: 'y' } }],
    },
    { status: 'done', say: 'Saved.' },
  )

  const outcome = await runMobileBrain({
    command: 'remember my wifi password is on the fridge',
    infer,
    ctx: {
      ...baseCtx(),
      client: stubClient({
        async getProductState() {
          return { sessions: [], memory: { entities: [], relations: [] }, revision: 1 }
        },
        async saveProductState(state) {
          return state
        },
      }),
    },
    confirm: async (request) => {
      asked.push(request)
      return true
    },
  })

  assert.equal(asked.length, 1)
  assert.match(asked[0].reason, /you did not ask for that/)
  assert.equal(asked[0].actions[0].tool, 'memory_save')
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.steps.length, 1)
})

test('declining does not run the step, and the model is told so it can adapt', async () => {
  const infer = scriptedModel(
    {
      status: 'act',
      requiresConfirmation: true,
      confirmReason: 'I want to also open the link.',
      actions: [{ tool: 'phone_open_url', label: 'open', params: { url: 'https://example.com' } }],
    },
    { status: 'done', say: 'Left it closed.' },
  )

  let opened = 0
  const outcome = await runMobileBrain({
    command: 'what is on my clipboard',
    infer,
    ctx: { ...baseCtx(), openUrl: () => { opened += 1 } },
    confirm: async () => false,
  })

  assert.equal(opened, 0, 'a declined action still ran')
  assert.equal(outcome.steps.length, 0)
  assert.match(infer.seen[1].at(-1).content, /declined/i)
})

test('with no confirm callback an ask is a decline, never a silent yes', async () => {
  const infer = scriptedModel(
    {
      status: 'act',
      requiresConfirmation: true,
      confirmReason: 'extra step',
      actions: [{ tool: 'phone_open_url', label: 'open', params: { url: 'https://example.com' } }],
    },
    { status: 'done', say: 'ok' },
  )
  let opened = 0
  const outcome = await runMobileBrain({
    command: 'anything',
    infer,
    ctx: { ...baseCtx(), openUrl: () => { opened += 1 } },
    confirm: null,
  })
  assert.equal(opened, 0)
  assert.equal(outcome.steps.length, 0)
})

test('nothing deterministic gates a tool the model did not flag', async () => {
  /* The standing policy: no per-tool guardrails. A tool that opens a URL on the
   * owner's screen runs without a confirm callback ever being consulted, if the
   * model judged it to be what the owner asked for. */
  let opened = null
  const infer = scriptedModel(
    { status: 'act', actions: [{ tool: 'phone_open_url', label: 'open', params: { url: 'https://example.com/x' } }] },
    { status: 'done', say: 'Opened it.' },
  )
  const outcome = await runMobileBrain({
    command: 'open example.com',
    infer,
    ctx: { ...baseCtx(), openUrl: (url) => { opened = url } },
    confirm: async () => {
      throw new Error('confirm must not be consulted for an unflagged action')
    },
  })
  assert.equal(opened, 'https://example.com/x')
  assert.equal(outcome.steps[0].ok, true)
})

test('need_tools widens the prompt instead of ending the turn', async () => {
  /* Force the drill-down path with a budget of zero, so the pre-pass runs and
   * the first planning prompt really is a subset. */
  const infer = scriptedModel(
    { domains: ['phone'] }, // level-1 pre-pass
    { status: 'need_tools', domains: ['mac'] },
    { status: 'done', say: 'Got them.' },
  )

  const opened = []
  const outcome = await runMobileBrain({
    command: 'ask the mac something',
    infer,
    ctx: baseCtx(),
    schemaBudget: 0,
    onProgress: (event) => {
      if (event.phase === 'discover_tools') opened.push(event.message)
    },
  })

  assert.equal(outcome.status, 'done')
  const firstPlanPrompt = infer.seen[1][0].content
  const widenedPrompt = infer.seen[2][0].content

  assert.ok(!firstPlanPrompt.includes('mac_run'), 'mac was never actually withheld')
  assert.ok(widenedPrompt.includes('mac_run'), 'the ask did not widen the prompt')
  /* And widening ADDS: the shelf it already had is still there. */
  assert.ok(widenedPrompt.includes('phone_status'), 'widening took a shelf away')
  assert.match(infer.seen[2].at(-1).content, /now in your system prompt/i)
  assert.deepEqual(opened, ['Opened: phone', 'Opened: phone, mac'])
})

test('asking for a domain that does not exist opens everything rather than looping', async () => {
  const infer = scriptedModel(
    { domains: ['phone'] },
    { status: 'need_tools', domains: ['telepathy'] },
    { status: 'done', say: 'fine' },
  )
  const outcome = await runMobileBrain({
    command: 'x',
    infer,
    ctx: baseCtx(),
    schemaBudget: 0,
  })
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.usage.calls, 3)
  /* Every tool is on the table now, not just the one shelf it started with. */
  assert.ok(infer.seen[2][0].content.includes('mac_run'))
})

test('asking for tools when every shelf is already open does not narrow the prompt', async () => {
  const infer = scriptedModel(
    { status: 'need_tools', domains: ['mac'] },
    { status: 'done', say: 'fine' },
  )
  const outcome = await runMobileBrain({ command: 'x', infer, ctx: baseCtx() })
  assert.equal(outcome.status, 'done')
  /* The system prompt is untouched — narrowing to the named shelf would take
   * tools away as a reward for asking for more. */
  assert.equal(infer.seen[0][0].content, infer.seen[1][0].content)
  assert.match(infer.seen[1].at(-1).content, /already in your system prompt/i)
})

test('a failing tool is a result to reason about, not an exception', async () => {
  const infer = scriptedModel(
    { status: 'act', actions: [{ tool: 'hive_read', label: 'read', params: { key: 'hive' } }] },
    { status: 'done', say: 'The relay would not answer, so I could not check.' },
  )

  const outcome = await runMobileBrain({
    command: 'check the hive',
    infer,
    ctx: {
      ...baseCtx(),
      client: stubClient({
        async readSharedState() {
          throw new Error('relay unreachable')
        },
      }),
    },
  })

  assert.equal(outcome.status, 'done')
  assert.equal(outcome.steps[0].ok, false)
  assert.match(outcome.steps[0].error, /relay unreachable/)
  assert.match(infer.seen[1].at(-1).content, /relay unreachable/)
})

test('an unknown tool name comes back with the real ones', async () => {
  const infer = scriptedModel(
    { status: 'act', actions: [{ tool: 'summon_helicopter', label: 'nope', params: {} }] },
    { status: 'done', say: 'That is not something I can do.' },
  )
  const outcome = await runMobileBrain({ command: 'x', infer, ctx: baseCtx() })
  assert.equal(outcome.steps[0].ok, false)
  assert.match(outcome.steps[0].error, /No such tool/)
  assert.match(infer.seen[1].at(-1).content, /No such tool/)
})

test('invalid JSON costs one turn, not the request', async () => {
  const infer = scriptedModel(
    'I think I should check the hive first!',
    { status: 'done', say: 'Recovered.' },
  )
  const outcome = await runMobileBrain({ command: 'x', infer, ctx: baseCtx() })
  assert.equal(outcome.status, 'done')
  assert.match(infer.seen[1].at(-1).content, /not valid JSON/)
})

test('the loop stops at maxSteps and says so instead of inventing an ending', async () => {
  const spin = { status: 'act', actions: [{ tool: 'phone_status', label: 'look', params: {} }] }
  const infer = scriptedModel(spin, spin, spin)
  const outcome = await runMobileBrain({
    command: 'loop forever',
    infer,
    ctx: baseCtx(),
    maxSteps: 3,
  })
  assert.equal(outcome.status, 'exhausted')
  assert.equal(outcome.turns, 3)
  assert.equal(outcome.steps.length, 3)
  assert.match(outcome.say, /did not finish/)
})

test('"act" with no actions but an answer is treated as the answer', async () => {
  const infer = scriptedModel({ status: 'act', say: 'It is 4pm.', actions: [] })
  const outcome = await runMobileBrain({ command: 'time?', infer, ctx: baseCtx() })
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.say, 'It is 4pm.')
})

test('unsupported carries the reason to the owner', async () => {
  const infer = scriptedModel({ status: 'unsupported', error: 'this phone has no camera tool' })
  const outcome = await runMobileBrain({ command: 'take a photo', infer, ctx: baseCtx() })
  assert.equal(outcome.status, 'unsupported')
  assert.match(outcome.say, /no camera tool/)
})

/* ------------------------------------------------------------- the prompt */

test('the prompt carries only tools it was actually given', () => {
  const catalogue = buildMobileCatalogue()
  const phoneOnly = toolsForDomains(['phone'], { catalogue })
  const prompt = buildBrainSystemPrompt({
    schemaText: '(schema)',
    toolNames: phoneOnly,
    otherDomains: ['mac', 'hive'],
    blocked: [],
    situation: 'now',
  })

  /* The mac rules name mac tools. With no mac tool loaded they must not ship —
   * a prompt that tells the model to "check mac_status first" while giving it
   * no mac_status is advertising a capability it does not have. */
  assert.ok(!prompt.includes('mac_status'), 'a rule named a tool that was not loaded')
  assert.ok(!prompt.includes('mac_run'), 'a rule named a tool that was not loaded')
  /* But the escape hatch must be there, naming the shelves held back. */
  assert.match(prompt, /need_tools/)
  assert.match(prompt, /mac, hive/)
})

test('the prompt names no tool that is not in the catalogue', () => {
  /* The standing rule: never hardcode a capability list into a prompt. The only
   * tool names allowed in the prompt body are ones the executor really has. */
  const catalogue = buildMobileCatalogue()
  const everyTool = [...catalogue.tools.keys()]
  const prompt = buildBrainSystemPrompt({
    schemaText: renderFullSchema({ catalogue }),
    toolNames: everyTool,
    situation: 'now',
  })
  const known = new Set(MOBILE_TOOL_TYPES)
  for (const candidate of prompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []) {
    if (known.has(candidate)) continue
    /* Everything else that looks like a tool name must be a JSON field or a
     * status word from the contract, not an invented capability. */
    assert.ok(
      ['need_tools', 'requiresConfirmation', 'confirmReason', 'json_object'].includes(candidate),
      `prompt names "${candidate}", which is not a tool the executor has`,
    )
  }
})

test('a blocked tool is explained by scope, not silently missing', () => {
  const catalogue = buildMobileCatalogue({ scopes: [] })
  const prompt = buildBrainSystemPrompt({
    schemaText: renderFullSchema({ catalogue }),
    toolNames: [...catalogue.tools.keys()],
    blocked: catalogue.blocked,
    situation: 'now',
  })
  assert.match(prompt, /missing relay scope/)
  assert.match(prompt, /re-pair the phone/)
})

test('the situation block states facts and never guesses', () => {
  const offline = describeSituation({
    now: new Date('2026-08-08T12:00:00Z'),
    navigator: { onLine: false },
    credential: { role: 'mobile' },
    platform: 'ios',
  })
  assert.match(offline, /NO network/)
  assert.match(offline, /role "mobile"/)
  assert.match(offline, /ios/)

  /* A platform that reports nothing must not produce a claim either way. */
  const unknown = describeSituation({ navigator: {}, credential: null })
  assert.ok(!/network/i.test(unknown), 'invented a network claim from nothing')
  assert.ok(!/role/i.test(unknown), 'invented a pairing claim from nothing')
})

test('the whole schema fits the prompt budget today, and the budget is measured', () => {
  const catalogue = buildMobileCatalogue({ scopes: [...DEVICE_SCOPES.mobile] })
  const chars = renderFullSchema({ catalogue }).length
  console.log(`[measured] full mobile schema ${chars} chars vs budget ${PROMPT_SCHEMA_BUDGET}`)
  assert.ok(
    chars <= PROMPT_SCHEMA_BUDGET,
    `the phone's schema is ${chars} chars, past the ${PROMPT_SCHEMA_BUDGET} budget — the drill-down path now runs on every turn, which costs a round trip. Either raise the budget deliberately or split a domain.`,
  )
})

/* ------------------------------------------------------- the prompt budget */

test('the thread is fitted to the relay ceilings, keeping the schema and the request', () => {
  const messages = [
    { role: 'system', content: 'SCHEMA' },
    { role: 'user', content: 'THE REQUEST' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `obs ${i} ${'x'.repeat(200)}` })),
  ]
  const fitted = fitMessagesToBudget(messages, { maxMessages: 8, maxChars: 100000 })

  assert.ok(fitted.length <= 8)
  assert.equal(fitted[0].content, 'SCHEMA', 'the tool schema was dropped')
  assert.equal(fitted[1].content, 'THE REQUEST', "the owner's request was dropped")
  assert.match(fitted[2].content, /dropped to stay inside/)
  /* What survives is the NEWEST working memory, not the oldest. */
  assert.match(fitted.at(-1).content, /obs 19/)
})

test('a character overflow drops messages rather than cutting one in half', () => {
  const messages = [
    { role: 'system', content: 'S'.repeat(100) },
    { role: 'user', content: 'R'.repeat(100) },
    { role: 'user', content: 'A'.repeat(5000) },
    { role: 'user', content: 'B'.repeat(5000) },
  ]
  const fitted = fitMessagesToBudget(messages, { maxMessages: 40, maxChars: 5500 })
  for (const message of fitted) {
    assert.ok(
      messages.some((original) => original.content === message.content) ||
        /dropped to stay inside/.test(message.content),
      'a message was truncated instead of dropped',
    )
  }
})

test('a thread already inside the budget is passed through untouched', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'R' },
  ]
  assert.equal(fitMessagesToBudget(messages), messages)
})

test('the loop never asks for more tokens than the relay allows', async () => {
  let seen = null
  const infer = async ({ maxTokens }) => {
    seen = maxTokens
    return { content: JSON.stringify({ status: 'done', say: 'ok' }) }
  }
  await runMobileBrain({ command: 'x', infer, ctx: baseCtx() })
  assert.ok(seen <= INFERENCE_LIMITS.maxTokens, `asked for ${seen} tokens`)
})

/* --------------------------------------------------------- JSON extraction */

test('JSON survives fences, preamble and braces inside strings', () => {
  assert.deepEqual(parseModelJson('{"status":"done"}'), { status: 'done' })
  assert.deepEqual(parseModelJson('```json\n{"status":"done"}\n```'), { status: 'done' })
  assert.deepEqual(parseModelJson('Sure! {"status":"done"} — hope that helps'), { status: 'done' })
  assert.deepEqual(
    parseModelJson('{"say":"use {curly} braces","status":"done"}'),
    { say: 'use {curly} braces', status: 'done' },
  )
  assert.deepEqual(
    parseModelJson('{"say":"he said \\"{\\" once","status":"done"}'),
    { say: 'he said "{" once', status: 'done' },
  )
  assert.deepEqual(parseModelJson('{"a":{"b":{"c":1}}}'), { a: { b: { c: 1 } } })
})

test('JSON extraction says what it saw when it fails', () => {
  assert.throws(() => extractJsonObject('no object here'), /did not return JSON/)
  assert.throws(() => extractJsonObject('{"unterminated": true'), /unterminated/)
})
