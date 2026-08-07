import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applyTidy,
  formatBytes,
  formatPreview,
  getPlan,
  groupFor,
  planTidy,
  undoTidy,
} from './downloadsTidy.js'

function sandbox(t, files = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-tidy-test-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content)
  }
  return directory
}

test('files are grouped by what they are, with screenshots split out from images', () => {
  assert.equal(groupFor({ name: 'photo.HEIC', mtimeMs: 0 }, 'type'), 'Images')
  assert.equal(
    groupFor({ name: 'Screenshot 2026-07-23 at 23.06.12.png', mtimeMs: 0 }, 'type'),
    'Screenshots',
    'screenshots are the biggest pile in most Downloads folders',
  )
  assert.equal(groupFor({ name: 'resume.pdf', mtimeMs: 0 }, 'type'), 'Documents')
  assert.equal(groupFor({ name: 'Cursor-darwin-universal.dmg', mtimeMs: 0 }, 'type'), 'Installers')
  assert.equal(groupFor({ name: 'mystery.qqq', mtimeMs: 0 }, 'type'), 'Other')
})

test('dated grouping uses the file’s own month', () => {
  const at = Date.parse('2026-03-09T12:00:00Z')
  assert.equal(groupFor({ name: 'a.pdf', mtimeMs: at }, 'date'), '2026-03')
})

test('planning moves nothing', (t) => {
  const directory = sandbox(t, { 'a.pdf': 'x', 'b.png': 'y' })
  const plan = planTidy({ directory })

  assert.equal(plan.fileCount, 2)
  assert.equal(plan.appliedAt, null)
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    ['a.pdf', 'b.png'],
    'the preview must not have created a single folder',
  )
})

test('folders are left alone — someone already decided where those go', (t) => {
  const directory = sandbox(t, { 'a.pdf': 'x' })
  fs.mkdirSync(path.join(directory, 'Taxes 2025'))
  fs.writeFileSync(path.join(directory, 'Taxes 2025', 'w2.pdf'), 'z')

  const plan = planTidy({ directory })
  assert.equal(plan.fileCount, 1)
  assert.equal(plan.moves[0].name, 'a.pdf')
})

test('same bytes under different names are reported, never deleted', (t) => {
  const directory = sandbox(t, {
    'invoice.pdf': 'identical contents',
    'invoice (1).pdf': 'identical contents',
    'other.pdf': 'different',
  })

  const plan = planTidy({ directory })
  assert.equal(plan.duplicates.length, 1)
  assert.deepEqual(plan.duplicates[0].names.sort(), ['invoice (1).pdf', 'invoice.pdf'])
  assert.equal(plan.moves.length, 3, 'every duplicate is still filed; none is dropped')
})

test('apply replays the stored plan and reports drift instead of guessing', (t) => {
  const directory = sandbox(t, { 'a.pdf': 'one', 'b.pdf': 'two' })
  const plan = planTidy({ directory })

  // The owner keeps working: one file grows, one disappears.
  fs.writeFileSync(path.join(directory, 'a.pdf'), 'one plus more')
  fs.rmSync(path.join(directory, 'b.pdf'))

  const applied = applyTidy(plan.id)
  assert.equal(applied.movedCount, 0)
  assert.equal(applied.driftedCount, 2)
  assert.deepEqual(
    applied.drifted.map((entry) => entry.reason).sort(),
    ['changed since the preview', 'gone since the preview'],
  )
})

test('apply files what it previewed', (t) => {
  const directory = sandbox(t, { 'a.pdf': 'one', 'b.png': 'two' })
  const plan = planTidy({ directory })
  const applied = applyTidy(plan.id)

  assert.equal(applied.ok, true)
  assert.equal(applied.movedCount, 2)
  assert.ok(fs.existsSync(path.join(directory, 'Documents', 'a.pdf')))
  assert.ok(fs.existsSync(path.join(directory, 'Images', 'b.png')))
})

test('a taken destination name is suffixed, never overwritten', (t) => {
  const directory = sandbox(t, { 'a.pdf': 'new one' })
  fs.mkdirSync(path.join(directory, 'Documents'))
  fs.writeFileSync(path.join(directory, 'Documents', 'a.pdf'), 'the older one')

  const plan = planTidy({ directory })
  assert.deepEqual(plan.collisions, ['a.pdf'], 'the preview warns before the fact')

  applyTidy(plan.id)
  assert.equal(fs.readFileSync(path.join(directory, 'Documents', 'a.pdf'), 'utf8'), 'the older one')
  assert.equal(fs.readFileSync(path.join(directory, 'Documents', 'a-2.pdf'), 'utf8'), 'new one')
})

test('a plan cannot be applied twice', (t) => {
  const directory = sandbox(t, { 'a.pdf': 'one' })
  const plan = planTidy({ directory })
  applyTidy(plan.id)
  assert.throws(() => applyTidy(plan.id), /already applied/)
})

test('applying an unknown plan asks for a preview rather than inventing one', () => {
  assert.throws(() => applyTidy('tidy_nope'), /Preview one first/)
})

test('undo puts every moved file back', (t) => {
  const directory = sandbox(t, { 'a.pdf': 'one', 'b.png': 'two' })
  const plan = planTidy({ directory })
  applyTidy(plan.id)

  const undone = undoTidy(plan.id)
  assert.equal(undone.ok, true)
  assert.equal(undone.restored, 2)
  assert.ok(fs.existsSync(path.join(directory, 'a.pdf')))
  assert.ok(fs.existsSync(path.join(directory, 'b.png')))
})

test('the stored plan is what apply reads, so the preview is binding', (t) => {
  const directory = sandbox(t, { 'a.pdf': 'one' })
  const plan = planTidy({ directory })

  // A file that appeared after the preview is not in the plan and is not moved.
  fs.writeFileSync(path.join(directory, 'late.pdf'), 'arrived after')
  assert.equal(getPlan(plan.id).moves.length, 1)

  applyTidy(plan.id)
  assert.ok(fs.existsSync(path.join(directory, 'late.pdf')), 'untouched: it was never previewed')
})

test('the preview reads as something a person can disagree with', (t) => {
  const directory = sandbox(t, { 'a.pdf': 'one', 'b.png': 'two', 'c.png': 'three' })
  const preview = formatPreview(planTidy({ directory }))

  assert.match(preview, /3 loose files/)
  assert.match(preview, /Nothing has moved yet/)
  assert.match(preview, /Images\/\s+\(2/)
})

test('planning a folder that is not there says so', () => {
  assert.throws(() => planTidy({ directory: '/nope/not/here' }), /No such folder/)
})

test('byte sizes read like sizes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})
