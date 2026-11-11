// Same trick as llmPlannerVision.test.js: node --test gives each file its own
// process, so this one configures a deployment with NO vision model.
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_API_BASE_URL = 'https://api.openai.com/v1'
process.env.LLM_VISION_MODEL = 'off'

import assert from 'node:assert/strict'
import test from 'node:test'
import { runComputerUseTask } from './computerUseLoop.js'

const { isVisionConfigured, requestLlmMessages } = await import('./llmPlanner.js')

test('vision is reported as unconfigured when LLM_VISION_MODEL is off', () => {
  assert.equal(isVisionConfigured(), false)
})

test('an image request fails with an actionable message instead of silently guessing', async () => {
  // The text model is text-only: sending it an image either 404s or, worse,
  // drops the image and the agent confidently describes a screen it never saw.
  await assert.rejects(
    () =>
      requestLlmMessages({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }],
        hasImages: true,
        fetchImpl: async () => {
          throw new Error('should not have been called')
        },
      }),
    /No vision model is configured/,
  )
})

test('text-only planning still works with no vision model', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"status":"ready"}' } }] }),
  })

  const content = await requestLlmMessages({
    messages: [{ role: 'user', content: 'what time is it' }],
    hasImages: false,
    fetchImpl,
  })

  assert.equal(content, '{"status":"ready"}')
})

test('the loop degrades to text-only when the provider rejects the image', async () => {
  let imageAttempts = 0
  const replies = ['{"status":"done","response":"finished without pixels"}']

  const result = await runComputerUseTask(
    { goal: 'do the thing', maxSteps: 3 },
    {
      requestMessages: async ({ hasImages }) => {
        if (hasImages) {
          imageAttempts += 1
          const error = new Error('this model does not support image input')
          error.rejectedImages = true
          throw error
        }

        return replies.shift() ?? '{"status":"done","response":"done"}'
      },
      execute: async (actions) =>
        actions.map((action) => ({ action, ok: true, status: 'success', message: 'ok' })),
      // An empty accessibility tree is what forces the screenshot in the first
      // place, so this is the exact case that used to abort the whole task.
      snapshot: async () => ({ app: 'Canvas', semanticAvailable: false, elements: [] }),
      capture: async () => ({
        id: 'obs',
        display: { index: 1, x: 0, y: 0, w: 1440, h: 900, backingScale: 2 },
        region: { x: 0, y: 0, w: 1440, h: 900 },
        image: { width: 1456, height: 910, bytes: 1 },
        scale: { x: 1, y: 1 },
        sha256: 'a',
        imageBase64: 'AAAA',
        mediaType: 'image/jpeg',
      }),
      cursor: async () => ({ x: 0, y: 0 }),
      displays: async () => [{ index: 1, x: 0, y: 0, w: 1440, h: 900, scale: 2, main: true }],
      sleep: async () => {},
    },
  )

  assert.equal(imageAttempts, 1)
  assert.equal(result.ok, true)
  assert.equal(result.message, 'finished without pixels')
})
