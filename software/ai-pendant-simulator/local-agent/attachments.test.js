/*
 * Attachments as first-class planner input (attachments.js), and the wiring
 * that carries them: orchestratePlan strips the HUD's redundant suffix, sends
 * the paths to the model exactly once via context.promptBlock, refuses bad
 * paths by name before any model call, and stamps the vetted paths onto
 * whatever plan comes back.
 *
 * Env is pinned before any import so the planner believes a model exists; the
 * model itself is a recorded stub (same shape llmPlannerDiscovery.test.js
 * uses — content-type application/json takes the non-SSE branch even though
 * the orchestrator streams).
 */
process.env.FULL_CONTROL_MODE = 'true'
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_ENABLED = 'true'
process.env.PENDANT_TOOL_DISCOVERY = 'off'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { testWorkspacePath } from './testWorkspace.js'

const {
  attachmentsPromptBlock,
  describeAttachmentProblems,
  isSecretFileName,
  prepareAttachments,
  stripAttachedSuffix,
} = await import('./attachments.js')
const { orchestratePlan } = await import('./orchestrator.js')

/* ------------------------------------------------------------- fixtures */

const fixtureRoot = fs.mkdtempSync(path.join(testWorkspacePath, 'attachments-'))
const at = (...parts) => path.join(fixtureRoot, ...parts)

fs.writeFileSync(at('notes.txt'), 'release notes: the bridge no longer hums')
fs.writeFileSync(at('pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
fs.mkdirSync(at('a-folder'))
fs.writeFileSync(at('.env'), 'FAKE=fixture')
fs.writeFileSync(at('.env.local'), 'FAKE=fixture')
fs.writeFileSync(at('.env.example'), 'FAKE=template')
fs.writeFileSync(at('secrets.conf'), 'fake fixture')

/* A pretend home with a real key file, and a symlink that points into it
 * from neutral ground. */
const fakeHome = at('fake-home')
fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true })
fs.mkdirSync(path.join(fakeHome, '.aws'), { recursive: true })
fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_fixture'), 'not a real key')
fs.writeFileSync(path.join(fakeHome, '.aws', 'credentials'), 'not real either')
fs.symlinkSync(path.join(fakeHome, '.ssh', 'id_fixture'), at('innocent-link.txt'))

/* ----------------------------------------------------- suffix stripping */

test('the [attached: …] suffix is stripped only when the array is present', () => {
  const command = 'summarize this [attached: /tmp/a.png, /tmp/b.txt]'

  const without = prepareAttachments({ command })
  assert.equal(without.command, command)

  const withArray = prepareAttachments({
    command,
    attachments: [at('notes.txt')],
  })
  assert.equal(withArray.command, 'summarize this')
})

test('a mid-sentence mention of the phrase survives; only the trailing block goes', () => {
  assert.equal(
    stripAttachedSuffix('the [attached: x] label means files [attached: /a]'),
    'the [attached: x] label means files',
  )
  assert.equal(stripAttachedSuffix('no suffix here'), 'no suffix here')
})

test('a suffix-only send still hands the planner a request', () => {
  const prepared = prepareAttachments({
    command: '[attached: /whatever]',
    attachments: [at('notes.txt')],
  })
  assert.equal(prepared.command, 'Use the attached file.')
})

/* ----------------------------------------------------------- validation */

test('an existing regular file comes back with size and kind', () => {
  const prepared = prepareAttachments({
    command: 'read these',
    attachments: [at('notes.txt'), at('pic.png')],
  })

  assert.equal(prepared.problems.length, 0)
  assert.deepEqual(
    prepared.attachments.map((file) => file.path),
    [at('notes.txt'), at('pic.png')],
  )
  assert.equal(prepared.attachments[0].kind, 'file')
  assert.equal(prepared.attachments[1].kind, 'image')
  assert.equal(
    prepared.attachments[0].bytes,
    fs.statSync(at('notes.txt')).size,
  )
})

test('a nonexistent path is named, never silently dropped', () => {
  const missing = at('gone.pdf')
  const prepared = prepareAttachments({
    command: 'summarize',
    attachments: [at('notes.txt'), missing],
  })

  assert.equal(prepared.problems.length, 1)
  assert.equal(prepared.problems[0].path, missing)
  assert.match(prepared.problems[0].reason, /no such file/)
  assert.equal(prepared.problems[0].refused, false)
})

test('a directory is not an attachable file', () => {
  const prepared = prepareAttachments({
    command: 'x',
    attachments: [at('a-folder')],
  })
  assert.match(prepared.problems[0].reason, /not a regular file/)
})

test('duplicate paths collapse to one attachment', () => {
  const prepared = prepareAttachments({
    command: 'x',
    attachments: [at('notes.txt'), at('notes.txt')],
  })
  assert.equal(prepared.attachments.length, 1)
})

/* ------------------------------------------------------------- refusals */

test('paths under ~/.ssh and ~/.aws are refused without ever being probed', () => {
  const paranoid = {
    statSync: (probed) => {
      throw new Error(`refused paths must never be stat'd: ${probed}`)
    },
    realpathSync: (target) => {
      if (target === fakeHome) return fakeHome
      throw new Error(`refused paths must never be resolved: ${target}`)
    },
  }

  const prepared = prepareAttachments({
    command: 'read my key',
    attachments: [
      path.join(fakeHome, '.ssh', 'nope-never-checked'),
      path.join(fakeHome, '.aws', 'credentials'),
    ],
    home: fakeHome,
    fsImpl: paranoid,
  })

  assert.equal(prepared.attachments.length, 0)
  assert.equal(prepared.problems.length, 2)
  assert.match(prepared.problems[0].reason, /~\/\.ssh/)
  assert.match(prepared.problems[1].reason, /~\/\.aws/)
  assert.ok(prepared.problems.every((problem) => problem.refused))
})

test('the repo secret-file patterns are refused; .env.example is the carve-out', () => {
  const prepared = prepareAttachments({
    command: 'x',
    attachments: [at('.env'), at('.env.local'), at('secrets.conf'), at('.env.example')],
  })

  assert.deepEqual(
    prepared.problems.map((problem) => problem.path),
    [at('.env'), at('.env.local'), at('secrets.conf')],
  )
  assert.ok(prepared.problems.every((problem) => problem.refused))
  assert.deepEqual(
    prepared.attachments.map((file) => file.path),
    [at('.env.example')],
  )
})

test('a symlink cannot launder a credential path', () => {
  const prepared = prepareAttachments({
    command: 'x',
    attachments: [at('innocent-link.txt')],
    home: fakeHome,
  })

  assert.equal(prepared.attachments.length, 0)
  assert.match(prepared.problems[0].reason, /~\/\.ssh/)
  assert.equal(prepared.problems[0].refused, true)
})

test('isSecretFileName mirrors the gitignore patterns', () => {
  assert.equal(isSecretFileName('.env'), true)
  assert.equal(isSecretFileName('.env.production'), true)
  assert.equal(isSecretFileName('secrets.conf'), true)
  assert.equal(isSecretFileName('.env.example'), false)
  assert.equal(isSecretFileName('environment.md'), false)
})

/* ------------------------------------------------------------ rendering */

test('the prompt block lists each path once, with size and kind', () => {
  const prepared = prepareAttachments({
    command: 'x',
    attachments: [at('notes.txt'), at('pic.png')],
  })
  const block = attachmentsPromptBlock(prepared.attachments)

  assert.match(block, /^Attached files/)
  assert.ok(block.includes(at('notes.txt')))
  assert.ok(block.includes('(image, '))
  assert.match(block, /read_file/)
  assert.equal(attachmentsPromptBlock([]), '')
})

test('problem descriptions name every path and its reason', () => {
  const text = describeAttachmentProblems([
    { path: '/a/.ssh/key', reason: 'inside ~/.ssh — credential stores are never read or attached', refused: true },
    { path: '/tmp/gone.png', reason: 'no such file on this Mac', refused: false },
  ])
  assert.ok(text.includes('/a/.ssh/key'))
  assert.ok(text.includes('/tmp/gone.png'))
  assert.match(text, /Nothing was planned\./)
})

/* -------------------------------------------- through the orchestrator */

/* Stand in for the model; records every request so the prompt that was
 * actually sent is the thing asserted on. */
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
      const message = sent[index]?.messages?.at(-1)
      return typeof message?.content === 'string' ? message.content : ''
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test('a plan with attachments sends each path to the model exactly once', async (t) => {
  const notes = at('notes.txt')
  const model = stubModel([
    `{"status":"ready","actions":[{"type":"read_file","label":"Read the notes","params":{"path":"${notes}"}}]}`,
  ])
  t.after(model.restore)

  const plan = await orchestratePlan({
    command: `summarize the attached release notes [attached: ${notes}]`,
    sessionId: null,
    source: 'floating-hud',
    attachments: [notes],
  })

  assert.equal(plan.status, 'ready')
  assert.deepEqual(plan.attachments, [notes])
  assert.equal(model.sent.length, 1, 'one planning call, no fast path')

  const prompt = model.userContent(0)
  assert.ok(
    prompt.includes('summarize the attached release notes'),
    'the typed request reaches the model',
  )
  assert.ok(!prompt.includes('[attached:'), 'the redundant suffix is stripped')
  const occurrences = prompt.split(notes).length - 1
  assert.equal(occurrences, 1, 'the path appears once, in the attachments block')
  assert.match(prompt, /Attached files/)
})

test('a refused attachment fails the plan by name before any model call', async (t) => {
  const model = stubModel([])
  t.after(model.restore)

  const plan = await orchestratePlan({
    command: 'read my ssh key [attached: ~/.ssh/id_rsa]',
    sessionId: null,
    source: 'floating-hud',
    attachments: ['~/.ssh/id_rsa'],
  })

  assert.equal(plan.status, 'unsupported')
  assert.equal(plan.planner, 'attachments')
  assert.match(plan.error, /\.ssh/)
  assert.match(plan.error, /id_rsa/)
  assert.equal(plan.attachmentProblems[0].refused, true)
  assert.equal(model.sent.length, 0, 'refusal happens before the model')
})

test('a missing attachment fails the plan and names the path', async (t) => {
  const missing = at('not-there.png')
  const model = stubModel([])
  t.after(model.restore)

  const plan = await orchestratePlan({
    command: `look at this [attached: ${missing}]`,
    sessionId: null,
    source: 'floating-hud',
    attachments: [missing],
  })

  assert.equal(plan.status, 'unsupported')
  assert.ok(plan.error.includes(missing))
  assert.match(plan.error, /no such file/)
  assert.equal(plan.attachmentProblems[0].refused, false)
  assert.equal(model.sent.length, 0)
})
