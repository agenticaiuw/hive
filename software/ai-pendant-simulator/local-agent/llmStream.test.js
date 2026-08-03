process.env.LLM_API_KEY = 'test-key'
process.env.LLM_API_BASE_URL = 'https://openrouter.ai/api/v1'

import assert from 'node:assert/strict'
import test from 'node:test'

const {
  readLlmSseContent,
  requestLlmMessages,
  requestLlmPlanContent,
} = await import('./llmPlanner.js')

function chunkedBody(chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

test('stream parser flushes a final JSON line without a newline', async () => {
  const body = chunkedBody([
    'data: {"choices":[{"delta":{"content":"{\\"status\\":"}}]}\r\n',
    'data: {"choices":[{"delta":{"content":"\\"ready\\"}"}}]}',
  ])

  assert.equal(await readLlmSseContent(body), '{"status":"ready"}')
})

test('provider transport terminator is consumed without synthetic progress', async () => {
  const progress = []
  const body = chunkedBody([
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n',
    'data: [DO',
    'NE]',
  ])

  assert.equal(
    await readLlmSseContent(body, {
      onProgress: (event) => progress.push(event),
    }),
    'hello',
  )
  assert.ok(progress.every((event) => !event.message.includes('finished')))
  assert.ok(progress.every((event) => !event.partial.includes('[DONE]')))
})

test('provider error frames reject an HTTP-200 stream', async () => {
  const body = chunkedBody([
    'data: {"error":{"message":"upstream quota exhausted"}}\n\n',
  ])
  await assert.rejects(
    () => readLlmSseContent(body),
    /upstream quota exhausted/,
  )
})

test('HTTP-200 JSON error body rejects a requested stream', async () => {
  await assert.rejects(
    () =>
      requestLlmPlanContent({
        headers: {},
        systemPrompt: 'system',
        userContent: 'user',
        onProgress: () => {},
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ error: { message: 'provider returned an error' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      }),
    /provider returned an error/,
  )
})

test('HTTP-200 error payload rejects the non-stream message API', async () => {
  await assert.rejects(
    () =>
      requestLlmMessages({
        messages: [{ role: 'user', content: 'hello' }],
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ error: { message: 'model unavailable' } }),
        }),
      }),
    /model unavailable/,
  )
})
