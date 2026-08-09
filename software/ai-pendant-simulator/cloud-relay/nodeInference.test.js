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
import express from 'express'
import { setCloudflareBindings } from './cloudflareBindings.js'
import {
  allowedInferModels,
  chargeInferBudget,
  INFER_RATE_LIMIT_PER_HOUR,
  DEFAULT_INFER_OUTPUT_TOKENS,
  MAX_INFER_CHARS,
  MAX_INFER_MESSAGES,
  MAX_INFER_OUTPUT_TOKENS,
  NOT_CONFIGURED_RETRY_AFTER_S,
  normalizeInferMessages,
  registerInferenceRoutes,
  resetInProcessInferBudget,
  resolveInferModel,
  retryAfterSeconds,
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
    (error) =>
      error.code === 'not_configured' &&
      error.status === 503 &&
      /* Carries a retry floor so a client can encode "fatal until an operator
       * acts" as a cooldown instead of inventing a number it cannot know. */
      error.retryAfter === NOT_CONFIGURED_RETRY_AFTER_S,
  )
})

test('the 503 floor is a floor, and the 429 deadline is a deadline', () => {
  /*
   * The two Retry-After values mean genuinely different things and it matters
   * that they are computed differently.
   *
   * The 503's is a FLOOR: a missing model key cannot self-heal, and the relay
   * has no idea when an operator will act. It claims only "a human must act,
   * and humans do not act in seconds". Operator-configurable precisely
   * because five minutes is not a fact about anything.
   */
  assert.ok(NOT_CONFIGURED_RETRY_AFTER_S >= 1)

  /* The 429's is a real deadline the relay computed — the end of the budget
   * window — so it is derived, never guessed. */
  const now = Date.parse('2026-08-09T12:00:00.000Z')
  assert.equal(
    retryAfterSeconds('2026-08-09T12:00:30.000Z', now),
    30,
  )
  /* Rounds up, and never returns 0: "retry after 0 seconds" is a busy-loop
   * invitation. */
  assert.equal(retryAfterSeconds('2026-08-09T12:00:00.500Z', now), 1)
  assert.equal(retryAfterSeconds('2026-08-09T11:59:00.000Z', now), 1)
  /* Unknown stays unknown rather than becoming a made-up number. */
  assert.equal(retryAfterSeconds(null, now), null)
  assert.equal(retryAfterSeconds('not a date', now), null)
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

test('any abnormal stop is flagged, not just truncation', async () => {
  /*
   * The follow-up question to the truncation bug, and it was the right one:
   * `length` is not the only terminal reason. A content filter ends a
   * generation with short-or-empty content and truncated:false, so a caller
   * checking only for truncation acts on a filtered non-answer as a genuine
   * one — the identical bug one field over.
   */
  const answer = async (finish_reason, message = { content: 'x' }) =>
    runInference({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message, finish_reason }] }),
      }),
    })

  const filtered = await answer('content_filter', { content: '' })
  assert.equal(filtered.complete, false, 'a filtered reply is not a complete one')
  assert.equal(filtered.truncated, false, 'and it is not a truncated one either')

  const cutOff = await answer('length')
  assert.equal(cutOff.complete, false)
  assert.equal(cutOff.truncated, true)

  const clean = await answer('stop')
  assert.equal(clean.complete, true)

  /* A reason nobody has seen yet must fail SAFE — false, not true. This is
   * why `complete` is not a list of known-bad reasons. */
  const novel = await answer('some_future_reason')
  assert.equal(novel.complete, false)
})

test('an unknown finish reason is unknown, not incomplete', async () => {
  /* Same distinction nodePresence draws between "offline" and "we could not
   * ask". Collapsing null into false would flag every good answer from a
   * provider that omits the field. */
  const noReason = await runInference({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'fine' } }] }),
    }),
  })
  assert.equal(noReason.complete, null)
  assert.equal(noReason.truncated, false)
})

test('a structured refusal is surfaced, not flattened into an empty answer', async () => {
  const refused = await runInference({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { content: null, refusal: 'I cannot help with that.' },
            finish_reason: 'stop',
          },
        ],
      }),
    }),
  })
  assert.equal(refused.refusal, 'I cannot help with that.')
  assert.equal(refused.content, '', 'content is genuinely empty')
  /* A refusal stops cleanly, so `complete` is true — `refusal` is the field
   * that distinguishes it from a model that simply said nothing. */
  assert.equal(refused.complete, true)
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

/* ---- the refusal paths over real HTTP ------------------------------------
 * The Retry-After wiring is three lines of glue, and glue that sets a header
 * is exactly what fails silently: every unit test above still passes if
 * response.set() is never called. Mounted on 127.0.0.1:0 so it cannot collide
 * with the relay on 8787 or the agent on 8000.
 * ------------------------------------------------------------------------- */

async function inferRelay(principal, { apiKey } = {}) {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.relayPrincipal = principal
    next()
  })
  registerInferenceRoutes(app, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }),
    ...(apiKey === undefined ? {} : { apiKey }),
  })
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const { port } = server.address()
  return {
    async post(body) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/infer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return {
        status: response.status,
        retryAfterHeader: response.headers.get('retry-after'),
        body: await response.json(),
      }
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('a rate-limited caller gets a real deadline, in the header and the body', async () => {
  const relay = await inferRelay({
    kind: 'device',
    deviceId: 'phone-1',
    role: 'mobile',
    scopes: ['llm:infer'],
  })
  /* Burn the budget. */
  for (let call = 0; call < INFER_RATE_LIMIT_PER_HOUR; call += 1) {
    await chargeInferBudget({ deviceId: 'phone-1' })
  }

  const limited = await relay.post({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(limited.status, 429)
  assert.equal(limited.body.code, 'rate_limited')
  assert.ok(limited.body.resetAt, 'says when the window ends')
  assert.ok(Number(limited.body.retryAfter) > 0, 'and how long that is')
  assert.equal(
    limited.retryAfterHeader,
    String(limited.body.retryAfter),
    'the standard header must agree with the body — proxies read the header',
  )
  await relay.close()
})

test('an unconfigured relay sends the retry floor as a header too', async () => {
  /*
   * The first version of this test deleted OPENAI_API_KEY/LLM_API_KEY from the
   * environment and branched on whichever status came back. It passed, and it
   * tested NOTHING: LLM_API_KEY is a module-level const captured at import, so
   * the deletes could not reach it, and on any machine with a key configured —
   * which is every machine that runs this suite — it took the 200 path and
   * asserted the 200. A test whose name describes a branch it never enters is
   * worse than no test, because it reports the branch as covered.
   *
   * Hence the injected apiKey. Empty string is now unambiguous and the 503 is
   * asserted unconditionally.
   */
  const relay = await inferRelay(
    { kind: 'device', deviceId: 'phone-2', role: 'mobile', scopes: ['llm:infer'] },
    { apiKey: '' },
  )
  const response = await relay.post({
    messages: [{ role: 'user', content: 'hi' }],
  })

  assert.equal(response.status, 503)
  assert.equal(response.body.code, 'not_configured')
  assert.equal(response.body.retryAfter, NOT_CONFIGURED_RETRY_AFTER_S)
  assert.equal(
    response.retryAfterHeader,
    String(NOT_CONFIGURED_RETRY_AFTER_S),
    'the header is the part a client gets for free — it must be set',
  )
  await relay.close()
})
