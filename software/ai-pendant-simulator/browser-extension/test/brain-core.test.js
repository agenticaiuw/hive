import assert from 'node:assert/strict'
import test from 'node:test'

import { COMMAND_TYPES } from '../src/bridge-core.js'
import {
  BRAIN_DEFAULTS,
  BRAIN_OUTPUT_TOKENS,
  BRAIN_STORAGE_KEYS,
  BROWSER_TOOLS,
  INFER_LIMITS,
  buildBrainMessages,
  callModelWithHeadroom,
  chooseBrainRoute,
  createBrainState,
  escalateOutputTokens,
  interpretInferError,
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

/* ------------------------------------------------------------------ *
 * POST /v1/infer failures. Codes and limits mirrored from
 * cloud-relay/nodeInference.js + cloud-relay/server.js, read 2026-08-09.
 * ------------------------------------------------------------------ */

test('a credential minted before llm:infer says re-pair, not "broken"', () => {
  const verdict = interpretInferError({
    status: 403,
    payload: {
      ok: false,
      code: 'credential_predates_capability',
      error:
        'Blocked for safety: this credential was issued before its role gained llm:infer. Re-pair the device to pick it up — scopes are frozen into a credential when it is created.',
    },
  })
  assert.equal(verdict.code, 'credential_predates_capability')
  assert.equal(verdict.fatal, true)
  assert.match(verdict.message, /Re-pair/i)
  assert.match(verdict.message, /browser_node/)
})

test('settled refusals are fatal; flaky transport is not', () => {
  const fatal = [
    'scope_denied',
    'not_configured',
    'model_not_allowed',
    'rate_limited',
    'prompt_too_large',
    'invalid_messages',
  ]
  for (const code of fatal) {
    assert.equal(
      interpretInferError({ status: 403, payload: { code } }).fatal,
      true,
      `${code} must not be retried`,
    )
  }
  assert.equal(
    interpretInferError({ status: 502, payload: { code: 'upstream_error' } }).fatal,
    false,
    'a provider hiccup is worth one retry',
  )
  assert.equal(interpretInferError({ status: 500, payload: null }).fatal, false)
})

test('rate limiting reports when the budget comes back', () => {
  const verdict = interpretInferError({
    status: 429,
    payload: { code: 'rate_limited', resetAt: '2026-08-09T12:00:00.000Z' },
  })
  assert.match(verdict.message, /2026-08-09T12:00:00\.000Z/)
})

test('an upstream failure never quotes the provider body', () => {
  /* The relay strips it on purpose — a provider error can quote the request,
   * and the request can quote the owner. Nothing here may put it back. */
  const verdict = interpretInferError({
    status: 502,
    payload: {
      code: 'upstream_error',
      error: 'The model provider refused the request (HTTP 400).',
    },
  })
  assert.equal(verdict.message, 'The model provider refused the request (HTTP 502).')
})

test('this loop never relies on the relay output default', () => {
  /* The relay gives 512 to a caller that stays silent — a quarter of the
   * ceiling. Asking for more is the whole reason the field is sent. */
  assert.equal(INFER_LIMITS.defaultOutputTokens, 512)
  assert.ok(BRAIN_OUTPUT_TOKENS > INFER_LIMITS.defaultOutputTokens)
  assert.ok(BRAIN_OUTPUT_TOKENS < INFER_LIMITS.maxOutputTokens)
})

test('a cut-off reply buys headroom once, then stops', () => {
  assert.equal(escalateOutputTokens(BRAIN_OUTPUT_TOKENS), INFER_LIMITS.maxOutputTokens)
  assert.equal(escalateOutputTokens(512), 1_024)
  /* Never past the ceiling: the relay would clamp it and bill for the clamp. */
  assert.equal(escalateOutputTokens(1_500), INFER_LIMITS.maxOutputTokens)
  /* At the ceiling there is no headroom left to buy — retrying would pay for
   * the same cut-off twice. */
  assert.equal(escalateOutputTokens(INFER_LIMITS.maxOutputTokens), null)
  assert.equal(escalateOutputTokens(9_999), null)
  /* A missing budget is treated as the relay's default, not as zero. */
  assert.equal(escalateOutputTokens(undefined), 1_024)
})

test('a truncated reply is retried once with real headroom, then answered', async () => {
  const asked = []
  const content = await callModelWithHeadroom(async (maxTokens) => {
    asked.push(maxTokens)
    return maxTokens < INFER_LIMITS.maxOutputTokens
      ? { content: '{"tool":"read_pa', truncated: true }
      : { content: '{"tool":"read_page","params":{}}', truncated: false }
  })
  assert.deepEqual(asked, [BRAIN_OUTPUT_TOKENS, INFER_LIMITS.maxOutputTokens])
  assert.equal(content, '{"tool":"read_page","params":{}}')
  /* And the recovered reply is a usable tool call, not just a longer string. */
  assert.deepEqual(parseToolCalls(content).calls, [
    { type: 'read_page', params: {} },
  ])
})

test('a reply that never fits stops paying, and says why', async () => {
  const asked = []
  await assert.rejects(
    () =>
      callModelWithHeadroom(async (maxTokens) => {
        asked.push(maxTokens)
        return { content: 'half an ob', truncated: true }
      }),
    (error) => {
      assert.equal(error.code, 'truncated')
      assert.equal(error.fatal, true, 'must hand off, not retry into the same wall')
      assert.match(error.message, /cut off/)
      return true
    },
  )
  /* Exactly two billed calls: the first, and the one that bought the ceiling.
   * A third would be paying twice for an identical refusal. */
  assert.deepEqual(asked, [BRAIN_OUTPUT_TOKENS, INFER_LIMITS.maxOutputTokens])
})

test('an untruncated first reply costs exactly one call', async () => {
  let calls = 0
  const content = await callModelWithHeadroom(async () => {
    calls += 1
    return { content: '{"done":true,"response":"hi"}', truncated: false }
  })
  assert.equal(calls, 1)
  assert.equal(parseToolCalls(content).response, 'hi')
})

test('truncation at the ceiling hands off instead of looking like garbage', () => {
  /* The failure this prevents: in JSON mode a cut-off reply is unparseable,
   * so without the `truncated` signal the loop would burn both strikes
   * reporting "the model reply was unusable" and never name the real cause. */
  let state = createBrainState({ command: 'x' })
  state = reduceBrain(state, {
    type: 'model_error',
    error: "The model's reply was cut off at the relay's 2048-token ceiling.",
    fatal: true,
  })
  assert.equal(state.status, 'handoff')
  assert.match(state.handoffReason, /cut off/)
  assert.match(summarizeBrainRun(state), /handed off to the Mac planner/i)
})

test('a fatal model error hands off on the first strike', () => {
  let state = createBrainState({ command: 'x' })
  state = reduceBrain(state, {
    type: 'model_error',
    error: 'Re-pair the extension.',
    fatal: true,
  })
  assert.equal(state.status, 'handoff')
  assert.equal(state.handoffReason, 'Re-pair the extension.')
})

test('the prompt is trimmed to the relay ceiling, and says that it was', () => {
  let state = createBrainState({ command: 'read everything', maxSteps: 12 })
  /* Each read_page result is capped at 2 kB in the transcript, so ~20 steps
   * is comfortably past the 24 kB prompt ceiling. */
  for (let index = 0; index < 20; index += 1) {
    state = reduceBrain(state, {
      type: 'model_reply',
      text: '{"tool":"read_page","params":{"mode":"text"}}',
    })
    state = reduceBrain(state, {
      type: 'tool_result',
      ok: true,
      result: { content: `${index}-${'x'.repeat(4_000)}` },
    })
    if (state.status !== 'thinking') break
  }

  const messages = buildBrainMessages(state)
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0)
  assert.ok(
    chars < INFER_LIMITS.maxPromptChars,
    `prompt was ${chars} chars, ceiling is ${INFER_LIMITS.maxPromptChars}`,
  )
  assert.ok(messages.length <= INFER_LIMITS.maxMessages)

  const transcript = messages.at(-1).content
  assert.match(transcript, /earlier step\(s\) omitted/)

  /* What survived, by step number. The newest must be present and the oldest
   * gone — dropping from the wrong end would keep the prompt legal while
   * starving the next decision of what just happened. */
  const kept = [...transcript.matchAll(/(?:^|\n)(\d+)\. read_page/g)].map((match) =>
    Number(match[1]),
  )
  assert.ok(kept.length > 1, 'more than one step should still fit')
  assert.equal(kept.at(-1), state.steps.length, 'the newest step must survive')
  assert.equal(kept[0] > 1, true, 'the oldest steps are the ones dropped')
  assert.deepEqual(
    kept,
    Array.from({ length: kept.length }, (_, offset) => kept[0] + offset),
    'the kept steps must be a contiguous, most-recent run',
  )
})

test('the command and system block are never dropped to fit', () => {
  const state = createBrainState({ command: 'q'.repeat(2_000) })
  const messages = buildBrainMessages(state)
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[1].content, 'q'.repeat(2_000))
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
