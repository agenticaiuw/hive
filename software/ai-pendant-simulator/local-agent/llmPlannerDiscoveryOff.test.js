/*
 * Same planner as llmPlannerDiscovery.test.js with the escape hatch pulled.
 * TOOL_DISCOVERY_ENABLED is a module-level const, so the only way to test both
 * settings is two processes — which is what node --test gives each file.
 *
 * This is the revert path. If drilling down ever costs the owner a capability,
 * PENDANT_TOOL_DISCOVERY=off has to put the agent back exactly where it was,
 * with no redeploy and no code change.
 */
process.env.FULL_CONTROL_MODE = 'true'
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_ENABLED = 'true'
process.env.LLM_API_BASE_URL = 'https://api.openai.com/v1'
process.env.LLM_MODEL = 'gpt-5.6-luna'
process.env.PENDANT_TOOL_DISCOVERY = 'off'

import assert from 'node:assert/strict'
import test from 'node:test'

const { actionSchemaForTier, planCommand } = await import('./llmPlanner.js')

test('PENDANT_TOOL_DISCOVERY=off is one model call against the whole library', async (t) => {
  const sent = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body))
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"status":"ready","actions":[{"type":"set_volume","label":"Set volume","params":{"level":30}}]}',
            },
          },
        ],
      }),
    }
  }
  t.after(() => {
    globalThis.fetch = original
  })

  const plan = await planCommand('set the volume to 30 and tell me the battery')

  assert.equal(plan.status, 'ready')
  assert.equal(sent.length, 1, 'no pre-pass, exactly the one call this file always made')
  assert.equal(plan.usage.calls, 1)
  assert.equal(plan.usage.discovery, false)

  const systemPrompt = sent[0].messages[0].content
  assert.ok(
    systemPrompt.includes(JSON.stringify(actionSchemaForTier('planner'), null, 2)),
    'the flat schema must come back verbatim',
  )
  assert.ok(!systemPrompt.includes('Tool domains NOT loaded'))
  assert.ok(!systemPrompt.includes('need_tools'))
})
