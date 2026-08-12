/*
 * Attach-on-tool-selection, measured on the wire.
 *
 * The owner's design, 2026-08-12: "tools should be combined with memories —
 * the tools for reading emails are in the same folder as the memories for
 * email preferences", and never again "generic memories that all get added to
 * the system prompt". So the assertion here is about the actual request body:
 * an email-scoped plan carries the email facts, a files-scoped plan carries
 * nothing, and the block never appears in the system prompt at all.
 */
process.env.FULL_CONTROL_MODE = 'true'
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_ENABLED = 'true'
process.env.LLM_API_BASE_URL = 'https://api.openai.com/v1'
process.env.LLM_MODEL = 'gpt-5.6-luna'
process.env.LLM_BACKGROUND_MODEL = 'gpt-4.1-mini'
process.env.PENDANT_TOOL_DISCOVERY = 'on'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/* The store must be private BEFORE memoryService resolves its path. */
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-planner-mem-'))
process.env.PENDANT_MEMORY_FACTS_PATH = path.join(storeDir, 'facts.json')
process.on('exit', () => {
  try {
    fs.rmSync(storeDir, { force: true, recursive: true })
  } catch {
    /* a leftover temp dir is not worth failing a run */
  }
})

const { rememberDomainFact } = await import('./memoryService.js')
const { normalizeDomainFact } = await import('../shared/domainMemory.js')
const { planCommand } = await import('./llmPlanner.js')

rememberDomainFact(
  normalizeDomainFact({
    domain: 'email',
    name: 'account.school',
    value: 'liu@uni.edu',
    scope: 'hive',
    node: 'mac',
  }),
  { origin: 'domain-tool' },
)

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
    userContent: (index) => {
      const messages = sent[index]?.messages ?? []
      return String(messages[messages.length - 1]?.content ?? '')
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test("selecting a domain's tools fetches that domain's facts into the request", async (t) => {
  const model = stubModel([
    '{"domains":["communication"]}',
    '{"status":"ready","actions":[{"type":"send_email","label":"Send it","params":{"to":"liu@uni.edu","subject":"hi","body":"hi"}}]}',
  ])
  t.after(model.restore)

  const plan = await planCommand('email my school account about the seminar')
  assert.equal(plan.status, 'ready')

  const planningTurn = model.userContent(1)
  assert.match(planningTurn, /Domain memory \(fetched for: email\):/)
  assert.match(planningTurn, /- email\/account\.school: liu@uni\.edu/)
  /* The block sits with the request, never in the system prompt — that would
   * be the global splice coming back under a new name. */
  assert.ok(!model.sent[1].messages[0].content.includes('Domain memory'))
  /* The discovery pre-pass runs before tools are selected, so it gets none. */
  assert.ok(!model.userContent(0).includes('Domain memory'))
  /* And the cost is priced, beside schemaChars. */
  assert.ok(plan.usage.domainMemoryChars > 0)
})

test('a plan scoped away from the facts carries no memory at all', async (t) => {
  const model = stubModel([
    '{"domains":["files"]}',
    '{"status":"ready","actions":[{"type":"list_directory","label":"List home","params":{"path":"/Users/test"}}]}',
  ])
  t.after(model.restore)

  const plan = await planCommand('list what is in my home folder')
  assert.equal(plan.status, 'ready')
  assert.ok(
    !model.userContent(1).includes('Domain memory'),
    'a files request paid for the email accounts — that is prompt stuffing again',
  )
  assert.equal(plan.usage.domainMemoryChars, 0)
})
