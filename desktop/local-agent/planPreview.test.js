import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { actionIdFor, buildActionReceipt } from './actionReceipts.js'
import {
  BULK_FILE_THRESHOLD,
  foreseeAction,
  foreseePlan,
  formatPlanPreview,
  isBulkFileOperation,
} from './planPreview.js'

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('a preview names the same things the receipt will name afterwards', () => {
  const action = {
    type: 'move_path',
    label: 'move the invoice',
    params: { from: '/tmp/a.pdf', to: '/tmp/Archive/a.pdf' },
  }

  const preview = foreseeAction(action)
  const receipt = buildActionReceipt({
    action,
    result: { ok: true },
    startedAt: '2026-08-07T00:00:00.000Z',
  })

  assert.equal(preview.actionId, actionIdFor(action))
  assert.equal(
    preview.actionId,
    receipt.actionId,
    'the id in the preview is the id in the history, or the owner cannot connect them',
  )
  assert.deepEqual(
    preview.touches.map((touch) => `${touch.kind}:${touch.ref}`),
    receipt.touched.map((touch) => `${touch.kind}:${touch.ref}`),
  )
})

test('previewing a delete does not delete anything', (t) => {
  const directory = sandbox(t)
  const filePath = path.join(directory, 'keepme.txt')
  fs.writeFileSync(filePath, 'still here')

  const preview = foreseeAction({ type: 'delete_path', params: { path: filePath } })

  assert.equal(preview.effect, 'write')
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'still here')
})

test('a delete that could be snapshotted is reported as reversible; one that could not is not', (t) => {
  const directory = sandbox(t)
  const small = path.join(directory, 'small.txt')
  fs.writeFileSync(small, 'x')
  const huge = path.join(directory, 'huge.bin')
  fs.writeFileSync(huge, Buffer.alloc(9 * 1024 * 1024))
  const folder = path.join(directory, 'nested')
  fs.mkdirSync(folder)

  assert.equal(foreseeAction({ type: 'delete_path', params: { path: small } }).reversible, true)

  const big = foreseeAction({ type: 'delete_path', params: { path: huge } })
  assert.equal(big.reversible, false)
  assert.match(big.irreversibleReason, /too large to snapshot/)

  const directoryDelete = foreseeAction({ type: 'delete_path', params: { path: folder } })
  assert.equal(directoryDelete.reversible, false)
  assert.match(directoryDelete.irreversibleReason, /only single files are snapshotted/)
})

test('a move onto a name that is already taken says so before it happens', (t) => {
  const directory = sandbox(t)
  const from = path.join(directory, 'a.txt')
  const occupied = path.join(directory, 'b.txt')
  fs.writeFileSync(from, 'new')
  fs.writeFileSync(occupied, 'the thing that would be replaced')

  const clean = foreseeAction({
    type: 'move_path',
    params: { from, to: path.join(directory, 'free.txt') },
  })
  assert.equal(clean.reversible, true)
  assert.equal(clean.reversedBy, 'move it back')

  const clobber = foreseeAction({ type: 'move_path', params: { from, to: occupied } })
  assert.match(clobber.reversedBy, /restore what it replaced/)
})

test('a plan preview lists the apps, files and URLs it would affect', () => {
  const preview = foreseePlan(
    [
      { type: 'open_app', params: { appName: 'Finder' } },
      { type: 'read_file', params: { path: '/tmp/notes.md' } },
      { type: 'open_url', params: { url: 'https://example.com/invoice' } },
    ],
    { title: 'find my invoice' },
  )

  assert.equal(preview.title, 'find my invoice')
  assert.equal(preview.stepCount, 3)
  assert.deepEqual(preview.affected.apps, ['Finder'])
  assert.deepEqual(preview.affected.paths, ['/tmp/notes.md'])
  assert.deepEqual(preview.affected.urls, ['https://example.com/invoice'])
  assert.match(formatPlanPreview(preview), /Nothing has run/)
})

test('bulk is advice about which plans are worth showing, and a delete always qualifies', () => {
  const oneMove = [{ type: 'move_path', params: { from: '/a', to: '/b' } }]
  assert.equal(isBulkFileOperation(oneMove), false)

  const manyMoves = Array.from({ length: BULK_FILE_THRESHOLD }, (_, index) => ({
    type: 'move_path',
    params: { from: `/a${index}`, to: `/b${index}` },
  }))
  assert.equal(isBulkFileOperation(manyMoves), true)

  assert.equal(
    isBulkFileOperation([{ type: 'delete_path', params: { path: '/a' } }]),
    true,
    'one delete is enough: it is the thing you cannot walk back by hand',
  )

  assert.equal(isBulkFileOperation([{ type: 'open_app', params: { appName: 'Mail' } }]), false)
})

test('a preview has no verdict to enforce', () => {
  const preview = foreseePlan([
    { type: 'run_shell', params: { command: 'rm -rf /tmp/whatever' } },
    { type: 'send_email', params: { to: 'someone@example.com', subject: 'hi' } },
  ])

  /* The rejected proposals all worked by adding one of these to the preview and
   * then having /execute consult it. If one ever appears here, the preview has
   * become the gate the owner turned down three times. */
  for (const forbidden of [
    'blocked',
    'allowed',
    'approved',
    'requiresApproval',
    'confirmationToken',
    'expiresAt',
  ]) {
    assert.equal(forbidden in preview, false, `preview must not carry a ${forbidden} field`)
    for (const step of preview.steps) {
      assert.equal(forbidden in step, false, `step must not carry a ${forbidden} field`)
    }
  }

  assert.equal(preview.stepCount, 2, 'every action is described, none is withheld')
})
