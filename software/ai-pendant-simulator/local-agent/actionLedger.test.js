import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_LEDGER_BYTES,
  MAX_STORE_BYTES,
  closeLedger,
  compactLedgerForStore,
  getLedger,
  interruptedLedgers,
  ledgerStepObserver,
  listLedgers,
  markStepStarted,
  openLedger,
  persistableParams,
  planKeyFor,
  presentLedger,
  pruneLedgers,
  resumeLedger,
  settleStep,
  stepKeysFor,
} from './actionLedger.js'
import { registerActionLedgerRoutes } from './actionLedgerRoutes.js'

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-ledger-'))
  return {
    root,
    filePath: path.join(root, 'ledger.json'),
    file: (name, contents = '') => {
      const target = path.join(root, name)
      fs.writeFileSync(target, contents)
      return target
    },
    at: (name) => path.join(root, name),
  }
}

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value))

/* Mirrors focusCoordinator.runFocusSafePlan's onStep contract exactly: `start`
 * is awaited before the executor sees the action, `done` after it answers. If
 * that contract ever changes, these tests are where the ledger finds out. */
async function runPlan(actions, observer, execute) {
  for (const [seq, action] of actions.entries()) {
    await observer({ phase: 'start', seq, action })
    const [result] = await execute([action])
    await observer({ phase: 'done', seq, action, result })
  }
}

const okResult = (action) => [{ action, ok: true, status: 'success', message: 'done' }]

test('persists the manifest before anything runs, with every step pending', () => {
  const box = sandbox()
  const actions = [
    { type: 'open_app', label: 'Open Notes', params: { appName: 'Notes' } },
    { type: 'write_file', params: { path: box.at('out.txt'), content: 'hello' } },
  ]

  const manifest = openLedger({ command: 'take notes', actions, filePath: box.filePath })

  // The point of the whole file: it is on disk before dispatch, not after.
  assert.ok(fs.existsSync(box.filePath))
  const stored = getLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(stored.status, 'open')
  assert.deepEqual(
    stored.steps.map((step) => step.phase),
    ['pending', 'pending'],
  )
  assert.equal(stored.steps.every((step) => step.startedAt === null), true)
})

test('gives repeated identical steps distinct keys that survive a re-plan', () => {
  const press = { type: 'press_keys', params: { keys: 'cmd+s' } }
  const first = stepKeysFor([press, { type: 'screenshot', params: {} }, press])

  // The failure this guards: actionIdFor is content-addressed, so both
  // press_keys steps carry the same action id. A resume that cannot tell step 0
  // from step 2 cannot say which of them was interrupted.
  assert.equal(first[0].actionId, first[2].actionId)
  assert.notEqual(first[0].stepKey, first[2].stepKey)
  assert.equal(first[0].stepKey.endsWith('#0'), true)
  assert.equal(first[2].stepKey.endsWith('#1'), true)

  // Stable across a re-plan of the same command, which is what makes it an
  // idempotency key rather than a row number.
  const second = stepKeysFor([press, { type: 'screenshot', params: {} }, press])
  assert.deepEqual(
    second.map((entry) => entry.stepKey),
    first.map((entry) => entry.stepKey),
  )
  assert.equal(planKeyFor([press]), planKeyFor([press]))
  assert.notEqual(planKeyFor([press]), planKeyFor([{ type: 'press_keys', params: { keys: 'cmd+q' } }]))
})

test('labels every step with where the damage lands and what a second run would do', () => {
  const box = sandbox()
  const target = box.file('doomed.txt', 'bytes')

  const manifest = openLedger({
    command: 'mixed plan',
    actions: [
      { type: 'read_file', params: { path: target } },
      { type: 'set_volume', params: { percent: 40 } },
      { type: 'delete_path', params: { path: target } },
      { type: 'send_email', params: { to: 'a@b.com', subject: 'hi', body: 'x' } },
      { type: 'run_shell', params: { command: 'rm -rf /tmp/x' } },
    ],
    filePath: box.filePath,
  })

  assert.deepEqual(
    manifest.steps.map((step) => step.riskTier),
    // A small file can be copied into the undo vault, so deleting it is a
    // reversible write. The tier is resolved against the real filesystem at
    // manifest time, not read off a table of type names.
    ['observe', 'setting', 'reversible-write', 'off-machine', 'uncontained'],
  )
  assert.deepEqual(
    manifest.steps.map((step) => step.replaySafety),
    ['idempotent', 'idempotent', 'unrepeatable', 'additive', 'unrepeatable'],
  )
  // The approval axis is a separate question and comes from actionRisk, not
  // from a second table in this file.
  assert.deepEqual(
    manifest.steps.map((step) => step.needsApproval),
    [false, false, true, true, true],
  )
  // delete_path has a pre-state and is checkable; the email and the shell are
  // not, and the manifest says so before the plan starts.
  assert.equal(manifest.risk.unverifiableOnResume, 2)

  // Only single files are snapshotted, so deleting a folder is the tier that
  // cannot be walked back — the same verdict planPreview reaches, reached once.
  fs.mkdirSync(box.at('folder'))
  const folderPlan = openLedger({
    command: 'delete a folder',
    actions: [{ type: 'delete_path', params: { path: box.at('folder') } }],
    filePath: box.filePath,
  })
  assert.equal(folderPlan.steps[0].riskTier, 'irreversible-write')
  assert.equal(folderPlan.risk.irreversible, 1)
})

test('withholds secret parameters and marks the step unreplayable', () => {
  const box = sandbox()
  const manifest = openLedger({
    command: 'write config',
    actions: [
      {
        type: 'write_file',
        params: { path: box.at('cfg.env'), content: 'api_key: sk-abcdefghijklmnop1234' },
      },
      { type: 'send_email', params: { to: 'friend@example.com', subject: 'hi', body: 'x' } },
    ],
    filePath: box.filePath,
  })

  const [secretStep, sensitiveStep] = manifest.steps
  assert.equal(secretStep.sensitivity, 'secret')
  assert.deepEqual(secretStep.withheldParams, ['content'])
  assert.equal(secretStep.params.content.includes('sk-abcdefghijklmnop1234'), false)
  assert.equal(secretStep.resumable, false)
  // The hash survives even though the body did not, so "did it land?" is still
  // answerable for a step we deliberately refuse to keep a copy of.
  assert.equal(typeof secretStep.intent.contentSha256, 'string')

  // A recipient is sensitive, not secret: withholding it would make the step
  // unresumable for nothing, and the same address is already in the job store.
  assert.equal(sensitiveStep.sensitivity, 'sensitive')
  assert.deepEqual(sensitiveStep.sensitiveParams, ['to'])
  assert.equal(sensitiveStep.params.to, 'friend@example.com')
  assert.equal(sensitiveStep.resumable, true)
})

test('strips image bytes before they reach the store', () => {
  const scrubbed = persistableParams({
    imageBase64: 'x'.repeat(5000),
    nested: { dataUrl: 'data:image/png;base64,zzzz', keep: 'yes' },
  })
  assert.equal('imageBase64' in scrubbed.params, false)
  assert.equal('dataUrl' in scrubbed.params.nested, false)
  assert.equal(scrubbed.params.nested.keep, 'yes')
})

test('marks a step started durably before the executor is handed the action', async () => {
  const box = sandbox()
  const actions = [{ type: 'open_app', params: { appName: 'Notes' } }]
  const manifest = openLedger({ command: 'open', actions, filePath: box.filePath })
  const observer = ledgerStepObserver(manifest, { filePath: box.filePath })

  let seenDuringDispatch = null
  await runPlan(actions, observer, async (batch) => {
    // Read the file, not memory: the invariant the resume rests on is that the
    // "started" record is FSYNCED before dispatch, so a crash right here still
    // leaves evidence behind.
    seenDuringDispatch = getLedger(manifest.ledgerId, { filePath: box.filePath }).steps[0].phase
    return okResult(batch[0])
  })

  assert.equal(seenDuringDispatch, 'inflight')
  const after = getLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(after.steps[0].phase, 'done')
  assert.equal(after.steps[0].ok, true)
})

test('a crash mid-plan leaves the interrupted step inflight and the rest pending', async () => {
  const box = sandbox()
  const actions = [
    { type: 'open_app', params: { appName: 'Notes' } },
    { type: 'delete_path', params: { path: box.file('gone.txt', 'bytes') } },
    { type: 'send_email', params: { to: 'a@b.com', subject: 's', body: 'b' } },
  ]
  const manifest = openLedger({ command: 'clean up', actions, filePath: box.filePath })
  const observer = ledgerStepObserver(manifest, { filePath: box.filePath })

  await assert.rejects(
    runPlan(actions, observer, async (batch) => {
      if (batch[0].type === 'delete_path') throw new Error('process died')
      return okResult(batch[0])
    }),
    /process died/,
  )

  const stored = getLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.deepEqual(
    stored.steps.map((step) => step.phase),
    ['done', 'inflight', 'pending'],
  )

  const interrupted = interruptedLedgers({ filePath: box.filePath })
  assert.equal(interrupted.count, 1)
  assert.equal(interrupted.ledgers[0].progress.inflight, 1)
})

test('a bookkeeping failure never reaches the execution path', async () => {
  const box = sandbox()
  const actions = [{ type: 'open_app', params: { appName: 'Notes' } }]
  const manifest = openLedger({ command: 'open', actions, filePath: box.filePath })
  // A directory where the store should be: every write from here on throws.
  fs.rmSync(box.filePath)
  fs.mkdirSync(box.filePath)
  const observer = ledgerStepObserver(manifest, { filePath: box.filePath })

  let ran = 0
  await runPlan(actions, observer, async (batch) => {
    ran += 1
    return okResult(batch[0])
  })
  assert.equal(ran, 1)
})

test('closes a finished run so it stops counting as interrupted', () => {
  const box = sandbox()
  const manifest = openLedger({
    command: 'open',
    actions: [{ type: 'open_app', params: { appName: 'Notes' } }],
    filePath: box.filePath,
  })
  assert.equal(interruptedLedgers({ filePath: box.filePath }).count, 1)

  settleStep(manifest.ledgerId, manifest.steps[0].stepKey, {
    result: { ok: true, status: 'success', message: 'Opened Notes' },
    receipt: { receiptId: 'rcpt_1' },
    filePath: box.filePath,
  })
  closeLedger(manifest.ledgerId, { status: 'settled', filePath: box.filePath })

  assert.equal(interruptedLedgers({ filePath: box.filePath }).count, 0)
  const stored = getLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(stored.status, 'settled')
  assert.equal(stored.steps[0].receiptId, 'rcpt_1')
})

test('bounds a single manifest by bytes and says which field it lost', () => {
  const box = sandbox()
  const manifest = openLedger({
    command: 'write a lot',
    actions: [
      { type: 'write_file', params: { path: box.at('big.txt'), content: 'a'.repeat(200_000) } },
    ],
    filePath: box.filePath,
  })

  assert.ok(bytesOf(manifest) <= MAX_LEDGER_BYTES)
  const [step] = manifest.steps
  assert.equal(step.params, null)
  assert.equal(step.paramsElided.bytes > 100_000, true)
  assert.equal(step.resumable, false)
  assert.match(step.notResumableReason, /byte budget/)
  // Shedding the body does not shed the ability to check whether it landed.
  assert.equal(typeof step.intent.contentSha256, 'string')
  assert.deepEqual(manifest.compacted, ['params'])
})

test('bounds the store by bytes rather than by a count of ledgers', () => {
  const fat = (index, status) => ({
    ledgerId: `ldg_${index}`,
    status,
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    steps: [{ seq: 0, stepKey: 'k', filler: 'z'.repeat(40_000) }],
  })

  // Ten ledgers of ~40 KB. A count-based cap of, say, 120 would keep all of
  // them — that is exactly the shape of cap that let pendant-jobs.json reach
  // 129 MB and wedge the agent.
  const pruned = pruneLedgers(
    Array.from({ length: 10 }, (_, index) => fat(index, 'settled')),
    { maxStoreBytes: 100_000, maxLedgerBytes: 64 * 1024 },
  )
  assert.ok(pruned.bytes <= 100_000)
  assert.equal(pruned.ledgers.length < 10, true)
  assert.equal(pruned.dropped > 0, true)
  assert.ok(pruned.droppedThrough)
  // The newest survive.
  assert.equal(pruned.ledgers[0].ledgerId, 'ldg_9')
})

test('prefers open ledgers when space runs out but does not exempt them', () => {
  const make = (index, status) => ({
    ledgerId: `ldg_${index}`,
    status,
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    steps: [{ seq: 0, filler: 'z'.repeat(20_000) }],
  })

  const mixed = [make(1, 'settled'), make(2, 'open'), make(3, 'settled')]
  const kept = pruneLedgers(mixed, { maxStoreBytes: 25_000, maxLedgerBytes: 64 * 1024 })
  assert.deepEqual(
    kept.ledgers.map((ledger) => ledger.ledgerId),
    ['ldg_2'],
  )

  // An exemption is how a bounded store becomes unbounded: many open ledgers
  // must still compete on the same budget.
  const allOpen = [make(1, 'open'), make(2, 'open'), make(3, 'open')]
  const bounded = pruneLedgers(allOpen, { maxStoreBytes: 25_000, maxLedgerBytes: 64 * 1024 })
  assert.equal(bounded.ledgers.length, 1)
  assert.equal(bounded.dropped, 2)
})

test('compaction leaves a small manifest untouched', () => {
  const small = { ledgerId: 'ldg_small', steps: [{ seq: 0, params: { a: 1 } }] }
  assert.equal(compactLedgerForStore(small), small)
})

test('the HTTP projection drops parameters and keeps what a reader needs', () => {
  const box = sandbox()
  const manifest = openLedger({
    command: 'email someone',
    actions: [{ type: 'send_email', params: { to: 'a@b.com', subject: 'hi', body: 'secret-ish' } }],
    filePath: box.filePath,
  })

  const shown = presentLedger(manifest)
  const [step] = shown.steps
  assert.equal('params' in step, false)
  assert.deepEqual(step.paramKeys, ['to', 'subject', 'body'])
  assert.equal(step.riskTier, 'off-machine')
  assert.equal(step.replaySafety, 'additive')
  assert.ok(step.touches.length)
  assert.equal(JSON.stringify(shown).includes('secret-ish'), false)
})

test('the store reports its own budget and what it has dropped', () => {
  const box = sandbox()
  openLedger({
    command: 'open',
    actions: [{ type: 'open_app', params: { appName: 'Notes' } }],
    filePath: box.filePath,
  })
  const listed = listLedgers({ filePath: box.filePath })
  assert.equal(listed.budget.maxStoreBytes, MAX_STORE_BYTES)
  assert.equal(listed.budget.usedBytes > 0, true)
  assert.equal(listed.dropped.ledgers, 0)
  assert.equal(listed.ledgers.length, 1)
})

test('refuses to open a manifest for an empty plan', () => {
  const box = sandbox()
  assert.throws(
    () => openLedger({ command: 'nothing', actions: [], filePath: box.filePath }),
    /at least one action/,
  )
})

/* --------------------------------------------------------------- routes */

function fakeApp() {
  const routes = new Map()
  const app = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  }
  const call = async (method, route, { params = {}, query = {}, body = {} } = {}) => {
    const handler = routes.get(`${method} ${route}`)
    assert.ok(handler, `no handler for ${method} ${route}`)
    let statusCode = 200
    let payload = null
    await handler(
      { params, query, body },
      {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        },
      },
    )
    return { statusCode, payload }
  }
  return { app, call, routes }
}

test('registers the ledger routes and prepares a plan without running it', async () => {
  const box = sandbox()
  const { app, call, routes } = fakeApp()
  registerActionLedgerRoutes(app, { filePath: box.filePath })

  assert.deepEqual(
    [...routes.keys()],
    [
      'POST /ledger',
      'GET /ledger',
      'GET /ledger/interrupted',
      'GET /ledger/:ledgerId',
      'GET /ledger/:ledgerId/resume',
    ],
  )

  const prepared = await call('POST', '/ledger', {
    body: {
      command: 'tidy up',
      actions: [{ type: 'delete_path', params: { path: box.file('junk.txt', 'x') } }],
    },
  })
  assert.equal(prepared.statusCode, 201)
  assert.equal(prepared.payload.executed, false)
  // Preparing must not touch the thing it describes.
  assert.equal(fs.existsSync(box.at('junk.txt')), true)

  const ledgerId = prepared.payload.ledger.ledgerId
  const fetched = await call('GET', '/ledger/:ledgerId', { params: { ledgerId } })
  assert.equal(fetched.payload.ledger.ledgerId, ledgerId)

  const interrupted = await call('GET', '/ledger/interrupted')
  assert.equal(interrupted.payload.count, 1)

  const listed = await call('GET', '/ledger', { query: { limit: '5' } })
  assert.equal(listed.payload.total, 1)
})

test('the resume route reports decisions and runs nothing', async () => {
  const box = sandbox()
  const { app, call } = fakeApp()
  registerActionLedgerRoutes(app, { filePath: box.filePath })

  const target = box.file('gone.txt', 'bytes')
  const manifest = openLedger({
    command: 'clean',
    actions: [{ type: 'delete_path', params: { path: target } }],
    filePath: box.filePath,
  })
  markStepStarted(manifest.ledgerId, manifest.steps[0].stepKey, { filePath: box.filePath })
  fs.rmSync(target) // the interrupted step actually landed

  const resumed = await call('GET', '/ledger/:ledgerId/resume', {
    params: { ledgerId: manifest.ledgerId },
  })
  assert.equal(resumed.payload.executed, false)
  assert.equal(resumed.payload.safeToContinue, true)
  assert.equal(resumed.payload.steps[0].decision, 'skip')
  assert.deepEqual(resumed.payload.runnable, [])

  const missing = await call('GET', '/ledger/:ledgerId/resume', { params: { ledgerId: 'nope' } })
  assert.equal(missing.statusCode, 404)
})

test('rejects an app that is not Express-shaped', () => {
  assert.throws(() => registerActionLedgerRoutes({}), /Express-style app/)
})

test('resumeLedger returns null for a ledger that is not there', () => {
  const box = sandbox()
  assert.equal(resumeLedger(`ldg_${crypto.randomUUID()}`, { filePath: box.filePath }), null)
})
