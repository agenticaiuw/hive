// node --test runs each test file in its own process, so setting the
// environment here (before the dynamic import below) deterministically
// configures the planner module regardless of the developer's .env.
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_API_BASE_URL = 'https://api.openai.com/v1'
process.env.LLM_MODEL = 'deepseek/deepseek-v4-flash-0731'
process.env.LLM_VISION_MODEL = 'google/gemini-3.6-flash'

import assert from 'node:assert/strict'
import test from 'node:test'

const {
  isVisionConfigured,
  isKnownActionType,
  llmRequestHeaders,
  requestLlmMessages,
  visionModelName,
} = await import('./llmPlanner.js')

const IMAGE_TURN = {
  role: 'user',
  content: [
    { type: 'text', text: 'Step 1. Finder has no usable accessibility tree.' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ', detail: 'high' },
    },
  ],
}

function recordingFetch(response = { choices: [{ message: { content: '{"status":"done"}' } }] }) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers })
    return { ok: true, json: async () => response }
  }
  return { calls, fetchImpl }
}

test('an image request is routed to the configured vision model, not the text model', async () => {
  const { calls, fetchImpl } = recordingFetch()

  await requestLlmMessages({ messages: [IMAGE_TURN], hasImages: true, fetchImpl })

  assert.equal(calls[0].body.model, 'google/gemini-3.6-flash')
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions')
})

test('a text-only request still uses the cheaper text model', async () => {
  const { calls, fetchImpl } = recordingFetch()

  await requestLlmMessages({
    messages: [{ role: 'user', content: 'plain text' }],
    hasImages: false,
    fetchImpl,
  })

  assert.equal(calls[0].body.model, 'deepseek/deepseek-v4-flash-0731')
})

test('the image survives the request body in OpenAI content-part form', async () => {
  const { calls, fetchImpl } = recordingFetch()

  await requestLlmMessages({ messages: [IMAGE_TURN], hasImages: true, fetchImpl })

  const [message] = calls[0].body.messages
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[1].type, 'image_url')
  assert.match(message.content[1].image_url.url, /^data:image\/jpeg;base64,/)
})

test('json_object is omitted when images are present and applied when they are not', async () => {
  const { calls, fetchImpl } = recordingFetch()

  // Several vision-capable models on OpenRouter reject json_object alongside
  // image parts, and the failure is an opaque provider 400.
  await requestLlmMessages({ messages: [IMAGE_TURN], hasImages: true, fetchImpl })
  assert.equal(calls[0].body.response_format, undefined)

  await requestLlmMessages({ messages: [IMAGE_TURN], hasImages: false, fetchImpl })
  assert.deepEqual(calls[1].body.response_format, { type: 'json_object' })
})


test('a provider rejecting the image is reported as such so the caller can degrade', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: 'this model does not support image input' } }),
  })

  await assert.rejects(
    () => requestLlmMessages({ messages: [IMAGE_TURN], hasImages: true, fetchImpl }),
    (error) => {
      assert.equal(error.rejectedImages, true)
      assert.match(error.message, /google\/gemini-3\.6-flash/)
      return true
    },
  )
})

test('vision is reported as configured and the model name is exposed', () => {
  assert.equal(isVisionConfigured(), true)
  assert.equal(visionModelName(), 'google/gemini-3.6-flash')
  assert.ok(llmRequestHeaders().Authorization)
})

test('a hallucinated action type is not a known type', () => {
  assert.equal(isKnownActionType('mouse_click'), true)
  assert.equal(isKnownActionType('computer_use_task'), true)
  assert.equal(isKnownActionType('ui_menu'), true)
  assert.equal(isKnownActionType('teleport_cursor'), false)
  assert.equal(isKnownActionType(undefined), false)
})
