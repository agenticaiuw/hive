/*
 * The relay's brain route. No network: `fetchImpl` is the seam.
 *
 * The tests that matter here are not the happy path — they are the two
 * properties that make this route safe to expose on a device credential: a
 * client cannot name a model it may not use, and a leaked token cannot spend
 * without a ceiling. Everything else is plumbing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setCloudflareBindings } from './cloudflareBindings.js'
import {
  allowedInferModels,
  chargeInferBudget,
  DEFAULT_INFER_OUTPUT_TOKENS,
  MAX_INFER_CHARS,
  MAX_INFER_MESSAGES,
  MAX_INFER_OUTPUT_TOKENS,
  normalizeInferMessages,
  resetInProcessInferBudget,
  resolveInferModel,
  runInference,
} from './nodeInference.js'

const NOW = Date.parse('2026-08-08T12:00:00.000Z')

test.beforeEach(() => {
  resetInProcessInferBudget()
  delete process.env.INFER_ALLOWED_MODELS
  setCloudflareBindings(null)
})

test('the model is resolved server-side, and a client cannot widen it', () => {
  const allowed = allowedInferModels()
  assert.equal(allowed.length, 1, 'default is exactly the configured model')
  assert.equal(resolveInferModel(''), allowed[0])
  assert.equal(resolveInferModel(null), allowed[0])
  assert.equal(resolveInferModel(allowed[0]), allowed[0])

  /*
   * Refused, not silently substituted. A caller told "ok" while being served
   * a different model has been lied to, and a planner that thinks it is
   * running on a reasoning model when it is not will fail in ways nobody can
   * reproduce.
   */
  assert.throws(
    () => resolveInferModel('some-expensive-frontier-model'),
    (error) => error.code === 'model_not_allowed',
  )
})

test('the allow-list is config, not client input', () => {
  process.env.INFER_ALLOWED_MODELS = 'model-a, model-b'
  assert.deepEqual(allowedInferModels(), ['model-a', 'model-b'])
  assert.equal(resolveInferModel('model-b'), 'model-b')
  assert.throws(() => resolveInferModel('model-c'))
})

test('a prompt is rejected rather than truncated', () => {
  assert.throws(
    () => normalizeInferMessages([]),
    (error) => error.code === 'invalid_messages',
  )
  assert.throws(
    () => normalizeInferMessages([{ role: 'root', content: 'hi' }]),
    (error) => error.code === 'invalid_messages',
  )
  assert.throws(
    () =>
      normalizeInferMessages(
        Array.from({ length: MAX_INFER_MESSAGES + 1 }, () => ({
          role: 'user',
          content: 'x',
        })),
      ),
    (error) => error.code === 'invalid_messages',
  )
  /* Silently cutting a prompt in half produces a confident answer to a
   * question nobody asked. */
  assert.throws(
    () =>
      normalizeInferMessages([
        { role: 'user', content: 'x'.repeat(MAX_INFER_CHARS + 1) },
      ]),
    (error) => error.code === 'prompt_too_large',
  )

  assert.deepEqual(
    normalizeInferMessages([{ role: 'user', content: 'hello' }]),
    [{ role: 'user', content: 'hello' }],
  )
})

test('the budget is per device and refuses past its ceiling', async () => {
  for (let call = 1; call <= 3; call += 1) {
    const charge = await chargeInferBudget({
      deviceId: 'phone-1',
      limit: 3,
      now: NOW,
    })
    assert.equal(charge.allowed, true, `call ${call} should be allowed`)
    assert.equal(charge.used, call)
  }
  const overBudget = await chargeInferBudget({
    deviceId: 'phone-1',
    limit: 3,
    now: NOW,
  })
  assert.equal(overBudget.allowed, false)

  /* Per device: one node burning its budget must not silence another. */
  const other = await chargeInferBudget({
    deviceId: 'browser-1',
    limit: 3,
    now: NOW,
  })
  assert.equal(other.allowed, true)
})

test('the window rolls forward', async () => {
  await chargeInferBudget({ deviceId: 'phone-1', limit: 1, now: NOW })
  assert.equal(
    (await chargeInferBudget({ deviceId: 'phone-1', limit: 1, now: NOW + 1_000 }))
      .allowed,
    false,
  )
  assert.equal(
    (
      await chargeInferBudget({
        deviceId: 'phone-1',
        limit: 1,
        windowMs: 3_600_000,
        now: NOW + 3_600_001,
      })
    ).allowed,
    true,
  )
})

test('the in-process limiter admits it is not a durable ceiling', async () => {
  /*
   * This is the honest half. Without a Durable Object binding the counter
   * lives in one isolate and resets with it, so a determined caller can walk
   * through it by causing isolate churn. `enforced: false` is what a caller
   * and an operator see instead of a number that looks like a guarantee.
   */
  const local = await chargeInferBudget({ deviceId: 'phone-1', now: NOW })
  assert.equal(local.enforced, false)
})

test('with a hub binding the ceiling is the Durable Object’s', async () => {
  const calls = []
  setCloudflareBindings({
    BRIDGE_HUB: {
      idFromName: (name) => name,
      get: (name) => ({
        async fetch(url, init) {
          calls.push({ name, body: JSON.parse(init.body) })
          return {
            json: async () => ({
              ok: true,
              allowed: true,
              limit: 120,
              used: 7,
              resetAt: '2026-08-08T13:00:00.000Z',
            }),
          }
        },
      }),
    },
  })

  const charge = await chargeInferBudget({ deviceId: 'phone-1', now: NOW })
  assert.equal(charge.enforced, true)
  assert.equal(charge.used, 7)
  assert.equal(calls[0].name, 'phone-1', 'counted against that device only')
})

test('a wedged hub falls back to a weaker ceiling, never to none', async () => {
  setCloudflareBindings({
    BRIDGE_HUB: {
      idFromName: (name) => name,
      get: () => ({
        async fetch() {
          throw new Error('durable object unavailable')
        },
      }),
    },
  })
  const charge = await chargeInferBudget({
    deviceId: 'phone-1',
    limit: 1,
    now: NOW,
  })
  assert.equal(charge.allowed, true)
  assert.equal(charge.enforced, false)
  /* The point: an outage must not become a free-inference bypass. */
  const second = await chargeInferBudget({
    deviceId: 'phone-1',
    limit: 1,
    now: NOW,
  })
  assert.equal(second.allowed, false)
})

test('no upstream key means 503, not a crash and not a fake answer', async () => {
  await assert.rejects(
    runInference({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: '',
    }),
    (error) => error.code === 'not_configured' && error.status === 503,
  )
})

test('the upstream body is never echoed back to the caller', async () => {
  /*
   * An upstream error body can quote the request, and the request can quote
   * the owner. The status travels; the body does not.
   */
  const secretInPrompt = 'the owner said something private'
  await assert.rejects(
    runInference({
      model: 'm',
      messages: [{ role: 'user', content: secretInPrompt }],
      apiKey: 'test-key',
      baseUrl: 'https://upstream.invalid/v1',
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: secretInPrompt } }),
      }),
    }),
    (error) => {
      assert.equal(error.code, 'upstream_error')
      assert.equal(error.status, 502)
      assert.ok(
        !error.message.includes(secretInPrompt),
        'the error must not carry the prompt back out',
      )
      return true
    },
  )
})

test('a 429 upstream stays a 429, so a client can back off correctly', async () => {
  await assert.rejects(
    runInference({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    }),
    (error) => error.status === 429,
  )
})

test('a successful call returns content, model and usage', async () => {
  let sentBody = null
  const result = await runInference({
    model: 'model-a',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 64,
    responseFormat: 'json_object',
    apiKey: 'test-key',
    baseUrl: 'https://upstream.invalid/v1',
    fetchImpl: async (url, init) => {
      sentBody = JSON.parse(init.body)
      assert.equal(url, 'https://upstream.invalid/v1/chat/completions')
      assert.equal(init.headers.authorization, 'Bearer test-key')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'model-a',
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { total_tokens: 12 },
        }),
      }
    },
  })

  assert.equal(result.content, '{"ok":true}')
  assert.equal(result.model, 'model-a')
  assert.deepEqual(result.usage, { total_tokens: 12 })
  assert.equal(sentBody.max_completion_tokens, 64)
  assert.deepEqual(sentBody.response_format, { type: 'json_object' })
})

test('a cut-off answer says so instead of arriving as bad JSON', async () => {
  /*
   * The failure this prevents is genuinely nasty and was silent until an
   * extension client pointed at the cause. maxTokens DEFAULTS to 512, not to
   * the 2048 ceiling, so a caller that omits it has a quarter of the budget it
   * thinks it has. Ask for json_object, run out mid-object, and every layer
   * downstream reports a malformed model response — while the one fact that
   * explains it, finish_reason:'length', was in the upstream payload and being
   * thrown away here.
   */
  const cutOff = await runInference({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"partial":' }, finish_reason: 'length' }],
      }),
    }),
  })
  assert.equal(cutOff.truncated, true)
  assert.equal(cutOff.finishReason, 'length')

  const complete = await runInference({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      }),
    }),
  })
  assert.equal(complete.truncated, false)
  assert.equal(complete.finishReason, 'stop')
})

test('omitting maxTokens spends the default, not the ceiling', async () => {
  /* "Clamped to 2048" reads as "2048 unless you ask for less". It is not:
   * absent means 512, and the gap has already misled one reader. */
  let sentBody = null
  await runInference({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body)
      return { ok: true, json: async () => ({ choices: [] }) }
    },
  })
  assert.equal(sentBody.max_completion_tokens, DEFAULT_INFER_OUTPUT_TOKENS)
  assert.equal(DEFAULT_INFER_OUTPUT_TOKENS, 512)
  assert.notEqual(DEFAULT_INFER_OUTPUT_TOKENS, MAX_INFER_OUTPUT_TOKENS)
})

test('maxTokens is clamped, so one call cannot be an unbounded bill', async () => {
  let sentBody = null
  await runInference({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 1_000_000,
    apiKey: 'test-key',
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body)
      return { ok: true, json: async () => ({ choices: [] }) }
    },
  })
  assert.equal(sentBody.max_completion_tokens, 2_048)
})
