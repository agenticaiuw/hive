/*
 * The ledger's LIFECYCLE, as opposed to its contents.
 *
 * actionLedger.test.js proves a manifest is written before dispatch and that its
 * steps carry the right labels. This file proves the other half, which nothing
 * covered: that a run which finished says so, that a run which was abandoned is
 * still findable, and that the record can be joined back to the job that caused
 * it. Those are the three things `GET /ledger/interrupted` is read for.
 *
 * Everything here runs against a ledger file of its own and a throwaway
 * workspace. The agent app on :8000 is a live writer to the real stores, and a
 * test that shares them is flaky by construction.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import './testWorkspace.js'

import {
  MAX_STORE_BYTES,
  closeLedger,
  getLedger,
  interruptedLedgers,
  ledgerLocation,
  listLedgers,
  markStepStarted,
  openLedger,
  settleStep,
} from './actionLedger.js'
import { clearActiveJob, registerActiveJob } from './jobControl.js'
import { recordJobStart } from './jobTracker.js'
import { orchestrateExecute } from './orchestrator.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-lifecycle-'))
  return { root, filePath: path.join(root, 'ledger.json'), at: (name) => path.join(root, name) }
}

/*
 * The exact sequence server.js POST /execute performs, with the two modules it
 * uses to do it. Nothing here is a stand-in: recordJobStart is jobTracker's,
 * registerActiveJob is jobControl's, and the ledger is whatever orchestrateExecute
 * decides to write.
 */
async function runThroughOrchestrator({ command, actions, sessionId = null, ledgerFile }) {
  const previous = process.env.PENDANT_ACTION_LEDGER_PATH
  process.env.PENDANT_ACTION_LEDGER_PATH = ledgerFile

  const tracked = recordJobStart({ type: 'execute', command, sessionId, source: 'local' })
  const abortController = new AbortController()
  registerActiveJob(tracked.jobId, { abortController, kind: 'execute' })

  try {
    const payload = await orchestrateExecute({
      command,
      actions,
      sessionId,
      /* What bridge.js actually sends: a planner label and a source, and no
       * job id, because the id is minted by the server after the pendant has
       * already built this object. */
      planMeta: { planner: 'llm', source: 'pendant' },
      source: 'local',
      signal: abortController.signal,
    })
    return { jobId: tracked.jobId, payload }
  } finally {
    clearActiveJob(tracked.jobId)
    if (previous === undefined) delete process.env.PENDANT_ACTION_LEDGER_PATH
    else process.env.PENDANT_ACTION_LEDGER_PATH = previous
  }
}

const soleLedger = (filePath) => {
  const listed = listLedgers({ filePath })
  assert.equal(listed.ledgers.length, 1, 'expected exactly one ledger to have been written')
  return getLedger(listed.ledgers[0].ledgerId, { filePath })
}

/* --------------------------------------------------------------- claim 1 */

test('a plan that ran to completion is not reported as interrupted', async () => {
  const box = sandbox()
  const { payload } = await runThroughOrchestrator({
    command: 'list the workspace',
    /* Read-only, no window, no prompt: the plan has to really run through the
     * executor for this to be a claim about the execution path. */
    actions: [{ type: 'list_directory', label: 'List the workspace', params: { path: box.root } }],
    ledgerFile: box.filePath,
  })

  assert.equal(payload.status, 'success', payload.response)

  const stored = soleLedger(box.filePath)
  assert.deepEqual(
    stored.steps.map((step) => step.phase),
    ['done'],
    'every step answered',
  )

  // The claim: nobody closed it, so the run that finished still reads as one
  // that did not.
  assert.notEqual(stored.status, 'open', 'a finished run must not be left open')
  assert.ok(stored.closedAt, 'a finished run records when it closed')
  assert.equal(
    interruptedLedgers({ filePath: box.filePath }).count,
    0,
    'a run that finished is not an interrupted run',
  )
})

test('a plan whose step failed is closed too, and closed as a failure', async () => {
  const box = sandbox()
  await runThroughOrchestrator({
    command: 'read a file that is not there',
    actions: [{ type: 'read_file', params: { path: box.at('absent.txt') } }],
    ledgerFile: box.filePath,
  })

  const stored = soleLedger(box.filePath)
  assert.equal(stored.steps[0].ok, false)
  assert.notEqual(stored.status, 'open', 'a failed run terminated, so its ledger terminated')
  assert.equal(interruptedLedgers({ filePath: box.filePath }).count, 0)
})

/* --------------------------------------------------------------- claim 2 */

test('the ledger a run wrote names the job that produced it', async () => {
  const box = sandbox()
  const { jobId } = await runThroughOrchestrator({
    command: 'list the workspace',
    actions: [{ type: 'list_directory', params: { path: box.root } }],
    ledgerFile: box.filePath,
  })

  // "Which job wrote this file" has to be answerable, and the only id that can
  // answer it is the one jobTracker minted for this request.
  assert.equal(soleLedger(box.filePath).jobId, jobId)
  assert.match(jobId, /^local_/)
})

/* ------------------------------------------------- abandonment, for real */

/*
 * A process that is killed cannot close its own ledger, which is the whole
 * reason `interrupted` has to mean something other than "the file says open".
 * So this spawns a real Node process, has it write a real manifest and mark a
 * real step in flight, and SIGKILLs it — no clock tricks, no hand-edited JSON.
 */
function killARunMidPlan(ledgerFile, { command = 'a run that will be killed' } = {}) {
  const script = path.join(path.dirname(ledgerFile), 'doomed.mjs')
  fs.writeFileSync(
    script,
    `import { openLedger, markStepStarted } from ${JSON.stringify(path.join(here, 'actionLedger.js'))}
const file = ${JSON.stringify(ledgerFile)}
const manifest = openLedger({
  command: ${JSON.stringify(command)},
  actions: [{ type: 'list_directory', params: { path: ${JSON.stringify(path.dirname(ledgerFile))} } }],
  filePath: file,
})
markStepStarted(manifest.ledgerId, manifest.steps[0].stepKey, { filePath: file })
process.kill(process.pid, 'SIGKILL')
`,
  )

  try {
    execFileSync(process.execPath, [script], { stdio: 'pipe' })
    assert.fail('the child was supposed to die before it could exit cleanly')
  } catch (error) {
    assert.equal(error.signal, 'SIGKILL', `child exited unexpectedly: ${error.stderr ?? error}`)
  }
}

test('a run killed mid-plan is still reported as interrupted', () => {
  const box = sandbox()
  killARunMidPlan(box.filePath)

  const interrupted = interruptedLedgers({ filePath: box.filePath })
  assert.equal(interrupted.count, 1, 'the killed run is the one thing this query exists to find')
  assert.equal(interrupted.ledgers[0].progress.inflight, 1)
  assert.equal(interrupted.ledgers[0].status, 'open')
})

test('a killed run is found among the runs that finished, not buried by them', async () => {
  const box = sandbox()

  for (const index of [0, 1, 2]) {
    await runThroughOrchestrator({
      command: `finished run ${index}`,
      actions: [{ type: 'list_directory', params: { path: box.root } }],
      ledgerFile: box.filePath,
    })
  }
  killARunMidPlan(box.filePath, { command: 'the one that died' })

  const interrupted = interruptedLedgers({ filePath: box.filePath })
  assert.equal(interrupted.count, 1)
  assert.equal(interrupted.ledgers[0].command, 'the one that died')
  assert.equal(listLedgers({ filePath: box.filePath }).total, 4, 'the finished runs are still on disk')
})

test('a plan nobody has dispatched yet is prepared, not interrupted', () => {
  const box = sandbox()
  /* What POST /ledger, /prepare and the form-preview submit manifest all write:
   * a plan on disk that has deliberately not run. Reporting one of those as an
   * interrupted run is the same false positive in a different costume. */
  openLedger({
    command: 'send the form',
    actions: [{ type: 'ui_click', params: { app: 'Safari', label: 'Submit' } }],
    filePath: box.filePath,
  })

  const interrupted = interruptedLedgers({ filePath: box.filePath })
  assert.equal(interrupted.count, 0, 'nothing was ever dispatched, so nothing was interrupted')
  assert.equal(getLedger(listLedgers({ filePath: box.filePath }).ledgers[0].ledgerId, {
    filePath: box.filePath,
  }).status, 'open', 'it stays open — it is still waiting to be approved')
})

test('a run still in flight in a live process is not called interrupted', () => {
  const box = sandbox()
  const manifest = openLedger({
    command: 'a plan running right now',
    actions: [
      { type: 'list_directory', params: { path: box.root } },
      { type: 'list_directory', params: { path: box.root } },
    ],
    filePath: box.filePath,
  })
  markStepStarted(manifest.ledgerId, manifest.steps[0].stepKey, { filePath: box.filePath })

  // This process wrote it and this process is alive. A slow step is not a dead
  // run, and calling it one would put a resume prompt in front of the owner
  // while the thing is still working.
  assert.equal(interruptedLedgers({ filePath: box.filePath }).count, 0)
})

test('a run whose record went cold is interrupted even if its pid is unreadable', () => {
  const box = sandbox()
  const start = Date.parse('2026-08-06T09:00:00.000Z')
  const manifest = openLedger({
    command: 'a run that stopped writing',
    actions: [{ type: 'list_directory', params: { path: box.root } }],
    filePath: box.filePath,
    now: start,
  })
  markStepStarted(manifest.ledgerId, manifest.steps[0].stepKey, {
    filePath: box.filePath,
    now: start,
  })

  const fresh = interruptedLedgers({ filePath: box.filePath, now: start + 1000 })
  assert.equal(fresh.count, 0)

  // Every step transition rewrites and fsyncs this file, so a file nothing has
  // touched for longer than a step could plausibly take is a run nobody is
  // driving any more.
  const cold = interruptedLedgers({ filePath: box.filePath, now: start + 6 * 60 * 60 * 1000 })
  assert.equal(cold.count, 1)
})

test('closing settles the run without pretending the step answered', () => {
  const box = sandbox()
  const manifest = openLedger({
    command: 'cancelled halfway',
    actions: [
      { type: 'list_directory', params: { path: box.root } },
      { type: 'list_directory', params: { path: box.root } },
    ],
    filePath: box.filePath,
  })
  settleStep(manifest.ledgerId, manifest.steps[0].stepKey, {
    result: { ok: true, status: 'success' },
    filePath: box.filePath,
  })
  markStepStarted(manifest.ledgerId, manifest.steps[1].stepKey, { filePath: box.filePath })
  closeLedger(manifest.ledgerId, {
    status: 'cancelled',
    outcome: 'Cancelled from dashboard',
    filePath: box.filePath,
  })

  const stored = getLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(stored.status, 'cancelled')
  assert.equal(stored.steps[1].phase, 'inflight', 'closing the run does not answer for the step')

  const report = interruptedLedgers({ filePath: box.filePath })
  assert.equal(report.count, 0, 'the process came back and said what happened')
  // But the step that was dispatched and never answered is still the thing a
  // resume has to ask about, so it must not vanish from this surface.
  assert.equal(report.unresolved.length, 1)
  assert.equal(report.unresolved[0].ledgerId, manifest.ledgerId)
})

/* ------------------------------------------------------------ byte budget */

test('the store budget is measured against the file, not against a proxy for it', () => {
  const box = sandbox()
  const budget = 128 * 1024

  /* Small records, many of them: this is the shape that hides the undercount.
   * Indentation costs per LINE, so a store of many small manifests overshoots
   * by far more than a store of one fat one. */
  for (let index = 0; index < 120; index += 1) {
    const manifest = openLedger({
      command: `run number ${index}`,
      actions: [{ type: 'list_directory', params: { path: box.at(`dir-${index}`) } }],
      filePath: box.filePath,
      maxStoreBytes: budget,
    })
    closeLedger(manifest.ledgerId, { status: 'settled', filePath: box.filePath, maxStoreBytes: budget })
  }

  const listed = listLedgers({ filePath: box.filePath })
  assert.ok(listed.dropped.ledgers > 0, 'the budget has to have actually bitten for this to prove anything')

  const onDisk = fs.statSync(box.filePath).size
  assert.ok(
    onDisk <= budget,
    `the ledger store is ${onDisk} bytes on disk against a stated ${budget} byte budget`,
  )
  assert.ok(
    listed.budget.usedBytes >= onDisk,
    `the store reports ${listed.budget.usedBytes} bytes but the file is ${onDisk}`,
  )
})

test('the default store budget is the size of the file it produces', () => {
  const box = sandbox()
  assert.equal(MAX_STORE_BYTES, 1024 * 1024)
  openLedger({
    command: 'one small plan',
    actions: [{ type: 'list_directory', params: { path: box.root } }],
    filePath: box.filePath,
  })
  const listed = listLedgers({ filePath: box.filePath })
  assert.equal(
    listed.budget.usedBytes,
    fs.statSync(box.filePath).size,
    'the number the store reports about itself is the number on disk',
  )
})

test('ledgerLocation still answers without an override', () => {
  const previous = process.env.PENDANT_ACTION_LEDGER_PATH
  delete process.env.PENDANT_ACTION_LEDGER_PATH
  try {
    assert.match(ledgerLocation(), /\.pendant-action-ledger\.json$/)
  } finally {
    if (previous !== undefined) process.env.PENDANT_ACTION_LEDGER_PATH = previous
  }
})
