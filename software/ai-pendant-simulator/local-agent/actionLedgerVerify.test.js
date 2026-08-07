import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  getLedger,
  markStepStarted,
  openLedger,
  resumeLedger,
  settleStep,
} from './actionLedger.js'
import {
  capturePreState,
  describePath,
  planResume,
  replaySafetyFor,
  riskTierFor,
  verifyStepApplied,
} from './actionLedgerVerify.js'

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-verify-'))
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

/* Open a manifest and stop it dead in the middle, the way a crash would: the
 * step at `interruptAt` is marked started and never settled, everything before
 * it is settled, everything after stays pending. */
function interruptedRun(box, actions, interruptAt, { command = 'plan' } = {}) {
  const manifest = openLedger({ command, actions, filePath: box.filePath })
  for (const step of manifest.steps.slice(0, interruptAt)) {
    markStepStarted(manifest.ledgerId, step.stepKey, { filePath: box.filePath })
    settleStep(manifest.ledgerId, step.stepKey, {
      result: { ok: true, status: 'success', message: 'done' },
      filePath: box.filePath,
    })
  }
  markStepStarted(manifest.ledgerId, manifest.steps[interruptAt].stepKey, {
    filePath: box.filePath,
  })
  return manifest
}

test('describePath records content, and never judges on mtime', () => {
  const box = sandbox()
  const target = box.file('a.txt', 'hello')
  const before = describePath(target)
  assert.equal(before.existed, true)
  assert.equal(before.sha256.length, 64)

  // A touch moves mtime without changing a byte. Verification must not notice.
  const later = new Date(Date.now() + 60_000)
  fs.utimesSync(target, later, later)
  const after = describePath(target)
  assert.notEqual(after.mtimeMs, before.mtimeMs)
  assert.equal(after.sha256, before.sha256)

  assert.equal(describePath(box.at('missing.txt')).existed, false)
  assert.equal(describePath(''), null)
})

test('captures a pre-state only where there is something to compare', () => {
  const box = sandbox()
  const target = box.file('a.txt', 'hello')
  assert.equal(capturePreState({ type: 'write_file', params: { path: target } }).kind, 'path')
  assert.equal(
    capturePreState({ type: 'move_path', params: { from: target, to: box.at('b.txt') } }).kind,
    'path-pair',
  )
  const email = capturePreState({ type: 'send_email', params: { to: 'a@b.com' } })
  assert.equal(email.kind, 'unobservable')
  assert.match(email.why, /nothing on this Mac/)
})

test('separates replay safety from risk tier — they are different questions', () => {
  assert.equal(replaySafetyFor('set_volume'), 'idempotent')
  assert.equal(replaySafetyFor('send_email'), 'additive')
  assert.equal(replaySafetyFor('move_path'), 'unrepeatable')
  assert.equal(replaySafetyFor('some_new_tool'), 'unknown')

  // Reversibility that "depends" must not round up to reversible: the
  // optimistic read is what deleted a file the agent never wrote.
  assert.equal(riskTierFor({ type: 'write_file' }, { effect: 'write', reversible: null }), 'irreversible-write')
  assert.equal(riskTierFor({ type: 'write_file' }, { effect: 'write', reversible: true }), 'reversible-write')
  // A shell command that happens to write a file is a shell command.
  assert.equal(riskTierFor({ type: 'run_shell' }, { effect: 'write', reversible: true }), 'uncontained')
})

test('proves a delete landed, and skips it', () => {
  const box = sandbox()
  const target = box.file('gone.txt', 'bytes')
  const manifest = interruptedRun(box, [{ type: 'delete_path', params: { path: target } }], 0)
  fs.rmSync(target)

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.interrupted, true)
  assert.equal(plan.steps[0].decision, 'skip')
  assert.equal(plan.steps[0].verification.verdict, 'applied')
  assert.equal(plan.safeToContinue, true)
  assert.deepEqual(plan.runnable, [])
  // "Tell me what changed" — including work the ledger never got to write down.
  assert.equal(plan.changed.length, 1)
  assert.equal(plan.changed[0].confirmedBy, 'post-hoc inspection')
})

test('proves a delete did not land, and re-runs it', () => {
  const box = sandbox()
  const target = box.file('gone.txt', 'bytes')
  const manifest = interruptedRun(box, [{ type: 'delete_path', params: { path: target } }], 0)

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'rerun')
  assert.equal(plan.steps[0].verification.verdict, 'not-applied')
  assert.equal(plan.safeToContinue, true)
  assert.deepEqual(plan.runnable, [{ type: 'delete_path', params: { path: target } }])
})

test('stops and asks when a destructive step changed into something unexpected', () => {
  const box = sandbox()
  const target = box.file('gone.txt', 'bytes')
  const manifest = interruptedRun(
    box,
    [
      { type: 'delete_path', params: { path: target } },
      { type: 'open_app', params: { appName: 'Notes' } },
    ],
    0,
  )
  fs.writeFileSync(target, 'something else edited this')

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'ask')
  assert.equal(plan.steps[0].verification.verdict, 'indeterminate')
  assert.equal(plan.safeToContinue, false)
  assert.equal(plan.stopped.seq, 0)
  assert.match(plan.question, /cannot tell whether/)

  // The rule that makes "continue the rest" safe: nothing past an unanswered
  // question runs, even a step that would be harmless on its own, because it
  // was planned assuming the unanswered one landed.
  assert.equal(plan.steps[1].decision, 'blocked')
  assert.deepEqual(plan.runnable, [])
})

test('refuses to guess about a folder delete that may have stopped partway', () => {
  const box = sandbox()
  fs.mkdirSync(box.at('folder'))
  fs.writeFileSync(box.at('folder/one.txt'), 'a')
  fs.writeFileSync(box.at('folder/two.txt'), 'b')
  const manifest = interruptedRun(
    box,
    [{ type: 'delete_path', params: { path: box.at('folder') } }],
    0,
  )
  fs.rmSync(box.at('folder/one.txt'))

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'ask')
  assert.match(plan.steps[0].verification.why, /stop partway/)
})

test('will not tell a completed move from a move that never could have run', () => {
  const box = sandbox()
  const manifest = interruptedRun(
    box,
    [{ type: 'move_path', params: { from: box.at('absent.txt'), to: box.at('dest.txt') } }],
    0,
  )

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'ask')
  assert.equal(plan.steps[0].verification.verdict, 'unverifiable')
  assert.match(plan.steps[0].verification.why, /also what a completed move looks like/)
})

test('recognises a move that landed and one that did not', () => {
  const box = sandbox()
  const from = box.file('src.txt', 'payload')
  const actions = [{ type: 'move_path', params: { from, to: box.at('dst.txt') } }]

  const untouched = interruptedRun(box, actions, 0)
  assert.equal(
    resumeLedger(untouched.ledgerId, { filePath: box.filePath }).steps[0].verification.verdict,
    'not-applied',
  )

  const moved = interruptedRun(box, actions, 0)
  fs.renameSync(from, box.at('dst.txt'))
  const plan = resumeLedger(moved.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].verification.verdict, 'applied')
  assert.equal(plan.steps[0].decision, 'skip')
})

test('asks about a sent email rather than sending it twice', () => {
  const box = sandbox()
  const manifest = interruptedRun(
    box,
    [{ type: 'send_email', params: { to: 'a@b.com', subject: 's', body: 'b' } }],
    0,
  )

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'ask')
  assert.equal(plan.steps[0].verification.verdict, 'unverifiable')
  assert.match(plan.question, /a second time rather than repair it/)
})

test('re-runs an idempotent step without needing to know whether it landed', () => {
  const box = sandbox()
  const manifest = interruptedRun(box, [{ type: 'set_volume', params: { percent: 40 } }], 0)

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'rerun')
  assert.match(plan.steps[0].why, /converges on the same end state/)
  assert.deepEqual(plan.runnable, [{ type: 'set_volume', params: { percent: 40 } }])
})

test('treats a step that failed as possibly half-applied, not as nothing', () => {
  const box = sandbox()
  const target = box.file('gone.txt', 'bytes')
  const manifest = openLedger({
    command: 'delete it',
    actions: [{ type: 'delete_path', params: { path: target } }],
    filePath: box.filePath,
  })
  markStepStarted(manifest.ledgerId, manifest.steps[0].stepKey, { filePath: box.filePath })
  settleStep(manifest.ledgerId, manifest.steps[0].stepKey, {
    result: { ok: false, status: 'failed', message: 'permission denied' },
    filePath: box.filePath,
  })
  // The executor said it failed — and the file is gone anyway. A failed step
  // that reports nothing happened is a claim, not a measurement.
  fs.rmSync(target)

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'skip')
  assert.equal(plan.steps[0].verification.verdict, 'applied')
})

test('re-runs pending steps, because the started record is fsynced before dispatch', () => {
  const box = sandbox()
  const manifest = interruptedRun(
    box,
    [
      { type: 'open_app', params: { appName: 'Notes' } },
      { type: 'set_volume', params: { percent: 20 } },
      { type: 'send_email', params: { to: 'a@b.com', subject: 's', body: 'b' } },
    ],
    1,
  )

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.deepEqual(
    plan.steps.map((step) => step.decision),
    ['completed', 'rerun', 'rerun'],
  )
  assert.match(plan.steps[2].why, /never handed to the executor/)
  assert.equal(plan.runnable.length, 2)
})

test('notices a hole in its own record instead of trusting it', () => {
  const box = sandbox()
  const manifest = openLedger({
    command: 'two steps',
    actions: [
      { type: 'send_email', params: { to: 'a@b.com', subject: 's', body: 'b' } },
      { type: 'open_app', params: { appName: 'Notes' } },
    ],
    filePath: box.filePath,
  })
  // Step 0's "started" write is lost — the observer swallows its own failures,
  // which is correct for the execution path and leaves this behind. Step 1 then
  // records normally, so the record now says step 0 never ran while a later
  // step did.
  markStepStarted(manifest.ledgerId, manifest.steps[1].stepKey, { filePath: box.filePath })
  settleStep(manifest.ledgerId, manifest.steps[1].stepKey, {
    result: { ok: true, status: 'success' },
    filePath: box.filePath,
  })

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'ask')
  assert.match(plan.steps[0].why, /gap/)
})

test('a secret-bearing write is still provable, even though it cannot be replayed', () => {
  const box = sandbox()
  const content = 'api_key: sk-abcdefghijklmnop1234'
  const target = box.at('cfg.env')
  const manifest = interruptedRun(
    box,
    [{ type: 'write_file', params: { path: target, content } }],
    0,
  )
  assert.equal(getLedger(manifest.ledgerId, { filePath: box.filePath }).steps[0].resumable, false)

  // Not yet written: the parameters are gone, so this one has to be asked about.
  const blocked = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(blocked.steps[0].decision, 'ask')

  // Written: the intent hash proves it landed, and a step that landed does not
  // need the parameters it no longer has.
  fs.writeFileSync(target, content)
  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'skip')
  assert.equal(plan.steps[0].verification.verdict, 'applied')
  assert.match(plan.steps[0].why, /does not need them/)
})

test('says "already satisfied" rather than pretending to know', () => {
  const box = sandbox()
  const content = 'settled'
  const target = box.file('same.txt', content)
  const manifest = interruptedRun(
    box,
    [{ type: 'write_file', params: { path: target, content } }],
    0,
  )

  const plan = planResume(getLedger(manifest.ledgerId, { filePath: box.filePath }))
  const verification = verifyStepApplied(
    getLedger(manifest.ledgerId, { filePath: box.filePath }).steps[0],
  )
  assert.equal(verification.verdict, 'already-satisfied')
  // write_file is idempotent, so the decision does not hang on the verdict —
  // but the verdict is still reported honestly rather than rounded to "done".
  assert.equal(plan.steps[0].decision, 'rerun')
})

test('a read-only step never blocks a resume', () => {
  const box = sandbox()
  const manifest = interruptedRun(
    box,
    [{ type: 'read_file', params: { path: box.file('a.txt', 'x') } }],
    0,
  )
  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'rerun')
  assert.equal(plan.steps[0].verification.verdict, 'no-effect')
  assert.deepEqual(plan.changed, [])
})

test('an unknown action type is asked about, not assumed safe', () => {
  const box = sandbox()
  const manifest = interruptedRun(box, [{ type: 'brand_new_tool', params: { x: 1 } }], 0)
  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.equal(plan.steps[0].decision, 'ask')
  assert.equal(plan.steps[0].replaySafety, 'unknown')
})

test('a fully settled run has nothing to resume and reports what it did', () => {
  const box = sandbox()
  const target = box.file('gone.txt', 'bytes')
  const manifest = openLedger({
    command: 'clean',
    actions: [{ type: 'delete_path', params: { path: target } }],
    filePath: box.filePath,
  })
  markStepStarted(manifest.ledgerId, manifest.steps[0].stepKey, { filePath: box.filePath })
  settleStep(manifest.ledgerId, manifest.steps[0].stepKey, {
    result: { ok: true, status: 'success', message: 'Deleted' },
    filePath: box.filePath,
  })

  const plan = resumeLedger(manifest.ledgerId, { filePath: box.filePath })
  assert.deepEqual(plan.steps.map((step) => step.decision), ['completed'])
  assert.equal(plan.safeToContinue, true)
  assert.deepEqual(plan.runnable, [])
  assert.equal(plan.changed[0].confirmedBy, 'receipt')
})
