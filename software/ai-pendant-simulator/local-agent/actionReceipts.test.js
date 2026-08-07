import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  actionIdFor,
  buildActionReceipt,
  describeReversibility,
  observeBeforeAction,
  receiptsForJob,
  staticReversibility,
} from './actionReceipts.js'

const NOW = '2026-08-07T00:00:00.000Z'

function tempFile(t, contents = 'original') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'note.txt')
  fs.writeFileSync(filePath, contents)
  return filePath
}

test('an action id is stable across identical re-runs', () => {
  const action = { type: 'open_app', params: { appName: 'Finder' } }
  assert.equal(actionIdFor(action), actionIdFor({ ...action }))
  assert.notEqual(
    actionIdFor(action),
    actionIdFor({ type: 'open_app', params: { appName: 'Safari' } }),
  )
  assert.match(actionIdFor(action), /^act_[0-9a-f]{12}$/)
})

test('a receipt records what an action touched', () => {
  const action = {
    type: 'open_url',
    label: 'Open the docs',
    params: { url: 'https://example.com/docs' },
  }
  const receipt = buildActionReceipt({
    action,
    result: { action, ok: true, status: 'success' },
    startedAt: NOW,
    finishedAt: '2026-08-07T00:00:00.250Z',
  })

  assert.equal(receipt.type, 'open_url')
  assert.equal(receipt.effect, 'write')
  assert.equal(receipt.durationMs, 250)
  assert.deepEqual(receipt.touched, [
    { kind: 'url', ref: 'https://example.com/docs' },
  ])
  assert.equal(receipt.reversible, true)
  assert.equal(receipt.reversedBy, 'close the front window')
})

test('a read-only action is marked read, not write', () => {
  const action = { type: 'read_file', params: { path: '/tmp/x.txt' } }
  const receipt = buildActionReceipt({
    action,
    result: { action, ok: true, status: 'success', path: '/tmp/x.txt' },
    startedAt: NOW,
  })

  assert.equal(receipt.effect, 'read')
  assert.equal(receipt.reversible, false)
  assert.equal(receipt.irreversibleReason, 'Read-only: nothing to undo')
})

test('an email receipt names the recipient, not a bare path param', () => {
  const action = {
    type: 'send_email',
    params: { to: 'someone@example.com', subject: 'Hi', body: 'text' },
  }
  const receipt = buildActionReceipt({
    action,
    result: { action, ok: true, status: 'success' },
    startedAt: NOW,
  })

  assert.deepEqual(receipt.touched, [
    { kind: 'email-recipient', ref: 'someone@example.com' },
    { kind: 'email-subject', ref: 'Hi' },
  ])
  assert.equal(receipt.reversible, false)
})

test('a failed action is recorded and reported as having changed nothing', () => {
  const action = { type: 'write_file', params: { path: '/nope/x.txt' } }
  const receipt = buildActionReceipt({
    action,
    result: { action, ok: false, status: 'failed', message: 'Failed: EACCES' },
    before: observeBeforeAction(action),
    startedAt: NOW,
  })

  assert.equal(receipt.ok, false)
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.reversible, false)
  assert.match(receipt.irreversibleReason, /did not complete/)
})

test('observing a write snapshots the file it is about to overwrite', (t) => {
  const filePath = tempFile(t, 'the owners work')
  const action = { type: 'write_file', params: { path: filePath } }

  const before = observeBeforeAction(action)
  assert.equal(before.target.existed, true)
  assert.ok(before.target.snapshotPath)
  assert.equal(fs.readFileSync(before.target.snapshotPath, 'utf8'), 'the owners work')
  t.after(() => fs.rmSync(before.target.snapshotPath, { force: true }))

  const receipt = buildActionReceipt({
    action,
    result: { action, ok: true, status: 'success', path: filePath },
    before,
    startedAt: NOW,
  })
  assert.equal(receipt.reversible, true)
  assert.equal(receipt.reversedBy, 'restore snapshot')
  assert.equal(receipt.snapshot.of, filePath)
})

test('overwriting a file that could not be snapshotted is NOT called reversible', () => {
  const action = { type: 'write_file', params: { path: '/tmp/huge.bin' } }
  const receipt = buildActionReceipt({
    action,
    result: { action, ok: true, status: 'success', path: '/tmp/huge.bin' },
    before: {
      observedAt: NOW,
      target: {
        path: '/tmp/huge.bin',
        existed: true,
        snapshotPath: null,
        snapshotSkipped: 'larger than 8388608 bytes',
      },
    },
    startedAt: NOW,
  })

  // The old undo said yes here and then DELETED the file, destroying content
  // the agent had only overwritten.
  assert.equal(receipt.reversible, false)
  assert.match(receipt.irreversibleReason, /Overwrote an existing file/)
})

test('writing a brand new file stays reversible by deleting it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-new-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, 'fresh.txt')
  const action = { type: 'write_file', params: { path: filePath } }

  const before = observeBeforeAction(action)
  assert.equal(before.target.existed, false)

  const receipt = buildActionReceipt({
    action,
    result: { action, ok: true, status: 'success', path: filePath },
    before,
    startedAt: NOW,
  })
  assert.equal(receipt.reversible, true)
  assert.equal(receipt.reversedBy, 'delete created file')
})

test('deleting a file becomes undoable because it is snapshotted first', (t) => {
  const filePath = tempFile(t, 'do not lose me')
  const action = { type: 'delete_path', params: { path: filePath } }

  const before = observeBeforeAction(action)
  t.after(() => fs.rmSync(before.target.snapshotPath, { force: true }))

  const receipt = buildActionReceipt({
    action,
    result: { action, ok: true, status: 'success' },
    before,
    startedAt: NOW,
  })
  assert.equal(receipt.reversible, true)
  assert.equal(receipt.reversedBy, 'restore snapshot')
})

test('deleting a directory is reported irreversible, with the reason', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-dir-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const action = { type: 'delete_path', params: { path: dir } }

  const receipt = buildActionReceipt({
    action,
    result: { action, ok: true, status: 'success' },
    before: observeBeforeAction(action),
    startedAt: NOW,
  })
  assert.equal(receipt.reversible, false)
  assert.match(receipt.irreversibleReason, /directory/)
})

test('observing never throws, whatever the action looks like', () => {
  for (const action of [
    null,
    {},
    { type: 'write_file' },
    { type: 'write_file', params: { path: 12345 } },
    { type: 'delete_path', params: { path: '\0bad' } },
    { type: 'run_shell', params: { command: 'echo hi' } },
  ]) {
    assert.doesNotThrow(() => observeBeforeAction(action))
  }
})

test('reversibility falls back to raw fields for jobs recorded before receipts', () => {
  const legacy = {
    action: { type: 'set_volume', params: { level: 60 } },
    ok: true,
    status: 'success',
    percent: 60,
    before: { percent: 25, muted: false },
  }
  const verdict = describeReversibility(legacy)
  assert.equal(verdict.reversible, true)
  assert.equal(verdict.mechanism, 'set_volume')
})

test('a receipt on the result wins over the legacy fallback', () => {
  const withReceipt = {
    action: { type: 'write_file', params: { path: '/tmp/x' } },
    ok: true,
    path: '/tmp/x',
    receipt: {
      reversible: false,
      reversedBy: null,
      irreversibleReason: 'Overwrote an existing file that could not be snapshotted',
    },
  }
  assert.equal(describeReversibility(withReceipt).reversible, false)
})

test('type-level reversibility is what the manifest can honestly claim', () => {
  assert.equal(staticReversibility('open_app').reversible, 'always')
  assert.equal(staticReversibility('set_volume').reversible, 'conditional')
  assert.equal(staticReversibility('run_shell').reversible, 'never')
  assert.equal(staticReversibility('read_file').reversible, 'not-needed')
})

test('old jobs still produce receipts, flagged as synthesized', () => {
  const job = {
    result: {
      results: [
        {
          action: { type: 'open_app', params: { appName: 'Finder' } },
          ok: true,
          status: 'success',
        },
      ],
    },
  }

  const [receipt] = receiptsForJob(job)
  assert.equal(receipt.synthesized, true)
  assert.equal(receipt.type, 'open_app')
  assert.equal(receipt.reversible, true)
  assert.deepEqual(receipt.touched, [{ kind: 'app', ref: 'Finder' }])
})

test('instant-info jobs keep their receipts under sideResults', () => {
  const job = {
    result: {
      sideResults: [
        {
          action: { type: 'get_time', params: {} },
          ok: true,
          receipt: { type: 'get_time', effect: 'read', reversible: false },
        },
      ],
    },
  }
  assert.deepEqual(receiptsForJob(job), [
    { type: 'get_time', effect: 'read', reversible: false },
  ])
})
