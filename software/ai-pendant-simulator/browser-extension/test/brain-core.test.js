import assert from 'node:assert/strict'
import test from 'node:test'

import { COMMAND_TYPES } from '../src/bridge-core.js'
import {
  BRAIN_DEFAULTS,
  BRAIN_STORAGE_KEYS,
  BROWSER_TOOLS,
  buildBrainMessages,
  chooseBrainRoute,
  createBrainState,
  normalizeBrainConfig,
  parseToolCalls,
  reduceBrain,
  runBrainLoop,
  summarizeBrainRun,
} from '../src/brain.js'

/* ------------------------------------------------------------------ *
 * Inertness: the property this scaffold ships with.
 * ------------------------------------------------------------------ */

test('the brain is off by default and stays off without a credential', () => {
  assert.deepEqual(BRAIN_DEFAULTS, {
    brainEnabled: false,
    modelProxyUrl: null,
    deviceToken: null,
  })

  assert.equal(normalizeBrainConfig().ready, false)
  assert.equal(normalizeBrainConfig({}).ready, false)
  assert.equal(normalizeBrainConfig({ brainEnabled: 'true' }).ready, false)
  assert.equal(normalizeBrainConfig({ brainEnabled: 1 }).ready, false)
  assert.equal(
    normalizeBrainConfig({ brainEnabled: true }).ready,
    false,
    'enabled without a proxy URL must not be ready',
  )
  assert.equal(
    normalizeBrainConfig({
      brainEnabled: true,
      modelProxyUrl: 'https://relay.example/v1/brain',
    }).ready,
    false,
    'enabled without a device token must not be ready',
  )

  const ready = normalizeBrainConfig({
    brainEnabled: true,
    modelProxyUrl: 'https://relay.example/v1/brain',
    deviceToken: 'scoped-token',
  })
  assert.equal(ready.ready, true)
})

test('the model proxy must be https or loopback http', () => {
  const base = { brainEnabled: true, deviceToken: 't' }
  assert.equal(
    normalizeBrainConfig({ ...base, modelProxyUrl: 'http://192.168.1.4/brain' }).ready,
    false,
  )
  assert.equal(
    normalizeBrainConfig({ ...base, modelProxyUrl: 'file:///tmp/x' }).ready,
    false,
  )
  assert.equal(
    normalizeBrainConfig({ ...base, modelProxyUrl: 'http://127.0.0.1:9999/dev' }).ready,
    true,
  )
})

test('routing sends everything to the Mac planner until the brain is ready', () => {
  const parked = chooseBrainRoute(normalizeBrainConfig({}))
  assert.equal(parked.route, 'mac-planner')
  assert.match(parked.reason, /switched off/)

  const live = chooseBrainRoute(
    normalizeBrainConfig({
      brainEnabled: true,
      modelProxyUrl: 'https://relay.example/v1/brain',
      deviceToken: 't',
    }),
  )
  assert.equal(live.route, 'local-brain')
})

test('a not-ready brain never touches the model or the tools', async () => {
  let modelCalls = 0
  let toolCalls = 0
  const state = await runBrainLoop({
    command: 'do something',
    config: normalizeBrainConfig({ brainEnabled: true }),
    callModel: async () => {
      modelCalls += 1
      return '{}'
    },
    runTool: async () => {
      toolCalls += 1
      return {}
    },
  })
  assert.equal(state.status, 'handoff')
  assert.equal(modelCalls, 0)
  assert.equal(toolCalls, 0)
})

/* ------------------------------------------------------------------ *
 * Tool catalog: exactly the 11 page commands, never a 12th.
 * ------------------------------------------------------------------ */

test('the tool catalog covers exactly the executable command set', () => {
  assert.equal(BROWSER_TOOLS.length, COMMAND_TYPES.size)
  for (const tool of BROWSER_TOOLS) {
    assert.ok(COMMAND_TYPES.has(tool.name), `${tool.name} must be executable`)
  }
  assert.deepEqual(BRAIN_STORAGE_KEYS, ['brainEnabled', 'modelProxyUrl', 'deviceToken'])
})

/* ------------------------------------------------------------------ *
 * Tool-call parsing.
 * ------------------------------------------------------------------ */

test('parseToolCalls reads bare and fenced tool calls', () => {
  const bare = parseToolCalls('{"tool":"read_page","params":{"mode":"main_text"}}')
  assert.equal(bare.done, false)
  assert.deepEqual(bare.calls, [{ type: 'read_page', params: { mode: 'main_text' } }])

  const fenced = parseToolCalls(
    'Sure, let me look.\n```json\n{"tool":"snapshot","params":{}}\n```',
  )
  assert.deepEqual(fenced.calls, [{ type: 'snapshot', params: {} }])

  const list = parseToolCalls('{"tool_calls":[{"tool":"click","params":{"selector":"#go"}}]}')
  assert.deepEqual(list.calls, [{ type: 'click', params: { selector: '#go' } }])
})

test('parseToolCalls reads final answers, with or without the envelope', () => {
  const enveloped = parseToolCalls('{"done": true, "response": "It is 5pm."}')
  assert.equal(enveloped.done, true)
  assert.equal(enveloped.response, 'It is 5pm.')

  const prose = parseToolCalls('The page says the meeting is at noon.')
  assert.equal(prose.done, true)
  assert.equal(prose.response, 'The page says the meeting is at noon.')
})

test('parseToolCalls flags garbage instead of guessing', () => {
  assert.equal(parseToolCalls('').malformed, true)
  assert.equal(parseToolCalls('{"tool":').malformed, true)
  assert.equal(parseToolCalls('{"neither":"nor"}').malformed, true)
})

/* ------------------------------------------------------------------ *
 * The reducer: the whole lifecycle without a browser or a network.
 * ------------------------------------------------------------------ */

test('a reply with a tool call moves the state to acting, then back', () => {
  let state = createBrainState({ command: 'read the page' })
  state = reduceBrain(state, {
    type: 'model_reply',
    text: '{"tool":"read_page","params":{"mode":"text"}}',
  })
  assert.equal(state.status, 'acting')
  assert.equal(state.pendingCall.type, 'read_page')

  state = reduceBrain(state, { type: 'tool_result', ok: true, result: { content: 'hi' } })
  assert.equal(state.status, 'thinking')
  assert.equal(state.stepCount, 1)
  assert.equal(state.steps[0].tool, 'read_page')

  state = reduceBrain(state, {
    type: 'model_reply',
    text: '{"done":true,"response":"The page says hi."}',
  })
  assert.equal(state.status, 'done')
  assert.equal(state.response, 'The page says hi.')
})

test('unknown tools and malformed replies hand off after two strikes', () => {
  let state = createBrainState({ command: 'x' })
  state = reduceBrain(state, { type: 'model_reply', text: '{"tool":"rm_rf","params":{}}' })
  assert.equal(state.status, 'thinking')
  assert.equal(state.failures, 1)

  state = reduceBrain(state, { type: 'model_reply', text: '{"tool":"rm_rf","params":{}}' })
  assert.equal(state.status, 'handoff')
  assert.match(state.handoffReason, /unknown tool/)
})

test('the step budget forces a handoff instead of an endless loop', () => {
  let state = createBrainState({ command: 'x', maxSteps: 1 })
  state = reduceBrain(state, { type: 'model_reply', text: '{"tool":"snapshot","params":{}}' })
  state = reduceBrain(state, { type: 'tool_result', ok: true, result: {} })
  state = reduceBrain(state, { type: 'model_reply', text: '{"tool":"snapshot","params":{}}' })
  assert.equal(state.status, 'handoff')
  assert.match(state.handoffReason, /budget/)
})

test('terminal states ignore further events', () => {
  let state = createBrainState({ command: 'x' })
  state = reduceBrain(state, { type: 'hand_off', reason: 'because' })
  assert.equal(state.status, 'handoff')
  const after = reduceBrain(state, { type: 'model_reply', text: '{"done":true}' })
  assert.equal(after, state)
})

/* ------------------------------------------------------------------ *
 * The loop with injected edges.
 * ------------------------------------------------------------------ */

const READY_CONFIG = normalizeBrainConfig({
  brainEnabled: true,
  modelProxyUrl: 'https://relay.example/v1/brain',
  deviceToken: 'scoped',
})

test('the loop runs model → tool → model → done', async () => {
  const replies = [
    '{"tool":"read_page","params":{"mode":"main_text"}}',
    '{"done":true,"response":"Summed up."}',
  ]
  const toolsRun = []
  const state = await runBrainLoop({
    command: 'summarize',
    page: { url: 'https://example.com', title: 'Example' },
    config: READY_CONFIG,
    callModel: async (messages) => {
      assert.equal(messages[0].role, 'system')
      assert.match(messages[0].content, /read_page/)
      assert.match(messages[0].content, /Example/)
      return replies.shift()
    },
    runTool: async (call) => {
      toolsRun.push(call.type)
      return { content: 'page text' }
    },
  })
  assert.equal(state.status, 'done')
  assert.equal(state.response, 'Summed up.')
  assert.deepEqual(toolsRun, ['read_page'])
  assert.match(summarizeBrainRun(state), /answered after 1 tool call/)
})

test('a dead model endpoint ends in a handoff, not a hang', async () => {
  const state = await runBrainLoop({
    command: 'x',
    config: READY_CONFIG,
    callModel: async () => {
      throw new Error('proxy unreachable')
    },
    runTool: async () => ({}),
  })
  assert.equal(state.status, 'handoff')
  assert.match(state.handoffReason, /failed twice/)
  assert.match(summarizeBrainRun(state), /handed off to the Mac planner/i)
})

test('tool transcripts feed the next model turn', () => {
  let state = createBrainState({ command: 'go' })
  state = reduceBrain(state, { type: 'model_reply', text: '{"tool":"list_tabs","params":{}}' })
  state = reduceBrain(state, {
    type: 'tool_result',
    ok: false,
    error: 'No matching browser tab is available.',
  })
  const messages = buildBrainMessages(state)
  const transcript = messages.at(-1)
  assert.match(transcript.content, /list_tabs/)
  assert.match(transcript.content, /No matching browser tab is available\./)
})
