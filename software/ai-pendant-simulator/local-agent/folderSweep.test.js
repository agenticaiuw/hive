import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  applySweep,
  formatSweep,
  getSweep,
  looksLikeCopyOf,
  planSweep,
  surveyFolder,
  undoSweep,
} from './folderSweep.js'

const DAY = 24 * 60 * 60 * 1000

/* A folder of the owner's own making, plus a disposable plan store, so no test
 * here can reach the real Downloads folder or the real plan history. */
function sandbox(t, files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const previous = process.env.PENDANT_SWEEP_STORE_PATH
  process.env.PENDANT_SWEEP_STORE_PATH = path.join(home, 'plans.json')
  t.after(() => {
    if (previous === undefined) delete process.env.PENDANT_SWEEP_STORE_PATH
    else process.env.PENDANT_SWEEP_STORE_PATH = previous
  })

  const directory = path.join(home, 'Downloads')
  fs.mkdirSync(directory)
  for (const [name, spec] of Object.entries(files)) {
    const { content = 'x', ageDays = 0 } = typeof spec === 'string' ? { content: spec } : spec
    const filePath = path.join(directory, name)
    fs.writeFileSync(filePath, content)
    if (ageDays) {
      const at = new Date(Date.now() - ageDays * DAY)
      fs.utimesSync(filePath, at, at)
    }
  }
  return directory
}

const byName = (plan, name) => plan.items.find((item) => item.name === name)

test('a half-finished download is debris; a fresh file is not', (t) => {
  const directory = sandbox(t, {
    'movie.mp4.crdownload': 'half a file',
    'notes.md': 'written this morning',
  })

  const plan = planSweep({ directory })

  assert.equal(byName(plan, 'movie.mp4.crdownload').disposition, 'delete')
  assert.match(byName(plan, 'movie.mp4.crdownload').reason, /interrupted download/)
  assert.equal(byName(plan, 'notes.md').disposition, 'keep')
  assert.equal(byName(plan, 'notes.md').action, null)
})

test('an empty file is only debris once it is old enough not to be mid-write', (t) => {
  const directory = sandbox(t, {
    'being-written.csv': { content: '', ageDays: 0 },
    'abandoned.csv': { content: '', ageDays: 5 },
  })

  const plan = planSweep({ directory })
  assert.equal(byName(plan, 'being-written.csv').disposition, 'keep')
  assert.equal(byName(plan, 'abandoned.csv').disposition, 'delete')
})

test('a duplicate is only removed when the bytes AND the name say it is a copy', (t) => {
  const directory = sandbox(t, {
    'report.pdf': 'identical content here',
    'report (1).pdf': 'identical content here',
    'quarterly-summary.pdf': 'identical content here',
  })

  const plan = planSweep({ directory })

  assert.equal(byName(plan, 'report (1).pdf').disposition, 'delete')
  assert.equal(
    byName(plan, 'quarterly-summary.pdf').disposition,
    'flag',
    'same bytes under a different name is a report, not a licence to delete',
  )
  assert.equal(byName(plan, 'quarterly-summary.pdf').action, null)
  assert.equal(byName(plan, 'report.pdf').disposition, 'keep')
  assert.equal(plan.duplicates.length, 1)
  assert.equal(plan.duplicates[0].keeper, 'report.pdf')
})

test('files that only share their first 64 KB are not duplicates', (t) => {
  const head = Buffer.alloc(70 * 1024, 7)
  const directory = sandbox(t, {
    'a.bin': Buffer.concat([head, Buffer.from('tail one')]).toString('binary'),
    'a (1).bin': Buffer.concat([head, Buffer.from('tail two')]).toString('binary'),
  })

  const plan = planSweep({ directory })
  assert.equal(plan.duplicates.length, 0)
  assert.equal(byName(plan, 'a (1).bin').disposition, 'keep')
})

test('screenshots go to dated folders and stale installers go to the archive', (t) => {
  const directory = sandbox(t, {
    'Screenshot 2026-05-04 at 09.14.22.png': { content: 'png', ageDays: 95 },
    'SomeApp-1.2.3.dmg': { content: 'dmg', ageDays: 60 },
    'yesterday.dmg': { content: 'dmg2', ageDays: 1 },
  })

  const plan = planSweep({ directory })

  const shot = byName(plan, 'Screenshot 2026-05-04 at 09.14.22.png')
  assert.equal(shot.disposition, 'file')
  assert.match(path.relative(directory, shot.to), /^Screenshots\/\d{4}-\d{2}\//)

  const installer = byName(plan, 'SomeApp-1.2.3.dmg')
  assert.equal(installer.disposition, 'archive')
  assert.match(path.relative(directory, installer.to), /^Archive\/\d{4}-\d{2}\/Installers\//)
  assert.match(installer.reason, /installer last touched 60 days ago/)

  assert.equal(byName(plan, 'yesterday.dmg').disposition, 'keep')
})

test('previewing moves nothing at all', (t) => {
  const directory = sandbox(t, {
    'old.pdf': { content: 'old', ageDays: 200 },
    'temp.crdownload': 'temp',
  })
  const before = fs.readdirSync(directory).sort()

  const plan = planSweep({ directory })

  assert.deepEqual(fs.readdirSync(directory).sort(), before)
  assert.equal(plan.appliedAt, null)
  assert.match(formatSweep(plan), /Nothing has moved/)
})

test('two files headed for the same name get different ones in the preview', (t) => {
  const directory = sandbox(t, {
    'Screenshot A.png': { content: 'one', ageDays: 10 },
  })
  fs.mkdirSync(path.join(directory, 'Screenshots'), { recursive: true })

  const plan = planSweep({ directory })
  const destination = byName(plan, 'Screenshot A.png').to
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, 'something already there')

  const second = planSweep({ directory })
  assert.notEqual(byName(second, 'Screenshot A.png').to, destination)
  assert.match(byName(second, 'Screenshot A.png').to, /-2\.png$/)
})

test('applying does exactly the items that were named and nothing else', async (t) => {
  const directory = sandbox(t, {
    'junk.crdownload': 'junk',
    'old-report.pdf': { content: 'old report', ageDays: 200 },
    'old-notes.md': { content: 'old notes', ageDays: 200 },
  })

  const plan = planSweep({ directory })
  const onlyThis = byName(plan, 'old-report.pdf').itemId

  const outcome = await applySweep(plan.id, { only: [onlyThis] })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.movedCount, 1)
  assert.equal(outcome.deletedCount, 0)
  assert.equal(fs.existsSync(byName(plan, 'old-report.pdf').to), true)
  assert.equal(
    fs.existsSync(path.join(directory, 'junk.crdownload')),
    true,
    'an item the owner did not name must not be swept along with the ones they did',
  )
  assert.equal(fs.existsSync(path.join(directory, 'old-notes.md')), true)
})

test('a file that changed since the preview is reported, not guessed at', async (t) => {
  const directory = sandbox(t, {
    'draft.pdf': { content: 'first draft', ageDays: 200 },
  })

  const plan = planSweep({ directory })
  fs.writeFileSync(path.join(directory, 'draft.pdf'), 'a much longer second draft')

  const outcome = await applySweep(plan.id)

  assert.equal(outcome.movedCount, 0)
  assert.equal(outcome.driftedCount, 1)
  assert.match(outcome.drifted[0].reason, /changed size/)
  assert.equal(fs.readFileSync(path.join(directory, 'draft.pdf'), 'utf8'), 'a much longer second draft')
})

test('a destination that filled up after the preview is drift too', async (t) => {
  const directory = sandbox(t, {
    'old.pdf': { content: 'old', ageDays: 200 },
  })

  const plan = planSweep({ directory })
  const destination = byName(plan, 'old.pdf').to
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, 'someone else got here first')

  const outcome = await applySweep(plan.id)

  assert.equal(outcome.driftedCount, 1)
  assert.match(outcome.drifted[0].reason, /took the destination name/)
  assert.equal(
    fs.readFileSync(destination, 'utf8'),
    'someone else got here first',
    'nothing the preview did not describe gets overwritten',
  )
})

test('naming an item that is not in the plan is an error, not a fresh decision', async (t) => {
  const directory = sandbox(t, { 'old.pdf': { content: 'old', ageDays: 200 } })
  const plan = planSweep({ directory })

  await assert.rejects(
    () => applySweep(plan.id, { only: ['act_notinthisplan'] }),
    /has no item act_notinthisplan/,
  )
  assert.equal(fs.existsSync(path.join(directory, 'old.pdf')), true)
})

test('an applied sweep can be put back, deletes included', async (t) => {
  const directory = sandbox(t, {
    'junk.crdownload': 'junk that was deleted',
    'old.pdf': { content: 'old', ageDays: 200 },
  })

  const plan = planSweep({ directory })
  await applySweep(plan.id)

  assert.equal(fs.existsSync(path.join(directory, 'junk.crdownload')), false)
  assert.equal(fs.existsSync(path.join(directory, 'old.pdf')), false)

  const undone = await undoSweep(plan.id)

  assert.equal(undone.ok, true)
  assert.equal(
    fs.readFileSync(path.join(directory, 'junk.crdownload'), 'utf8'),
    'junk that was deleted',
    'the deleted bytes come back out of the snapshot the executor took on the way past',
  )
  assert.equal(fs.readFileSync(path.join(directory, 'old.pdf'), 'utf8'), 'old')
})

test('the preview item id is the id the receipt carries afterwards', async (t) => {
  const directory = sandbox(t, { 'old.pdf': { content: 'old', ageDays: 200 } })
  const plan = planSweep({ directory })
  const item = byName(plan, 'old.pdf')

  await applySweep(plan.id)

  const stored = getSweep(plan.id)
  const receipt = stored.runs[0].results[0].receipt
  assert.equal(receipt.actionId, item.itemId)
  assert.equal(receipt.reversible, item.foresight.reversible)
})

test('applying is not a confirmation step: it does not ask, and nothing waits on it', async (t) => {
  const directory = sandbox(t, { 'junk.crdownload': 'junk' })
  const plan = planSweep({ directory })

  /* No token, no expiry, no approval state anywhere on the plan. The plan id is
   * a reference to a description, not a permission. */
  for (const forbidden of ['confirmationToken', 'expiresAt', 'approvedAt', 'approvedBy']) {
    assert.equal(forbidden in plan, false, `a sweep plan must not carry ${forbidden}`)
  }

  const outcome = await applySweep(plan.id)
  assert.equal(outcome.ok, true)
  assert.equal(fs.existsSync(path.join(directory, 'junk.crdownload')), false)
})

test('a survey describes the folder without proposing anything', (t) => {
  const directory = sandbox(t, {
    'a.crdownload': 'a',
    'b.pdf': { content: 'b', ageDays: 300 },
  })

  const survey = surveyFolder({ directory })

  assert.equal(survey.files.length, 2)
  assert.equal(survey.files.every((file) => !('disposition' in file)), true)
  assert.deepEqual(
    survey.files.find((file) => file.name === 'a.crdownload').classes,
    ['temporary'],
  )
  assert.equal(survey.files.find((file) => file.name === 'b.pdf').classes.includes('stale'), true)
})

test('copy names are recognised the way a browser and the Finder write them', () => {
  assert.equal(looksLikeCopyOf('report (1).pdf', 'report.pdf'), true)
  assert.equal(looksLikeCopyOf('report copy.pdf', 'report.pdf'), true)
  assert.equal(looksLikeCopyOf('report copy 2.pdf', 'report.pdf'), true)
  assert.equal(looksLikeCopyOf('report-2.pdf', 'report.pdf'), true)
  assert.equal(looksLikeCopyOf('report.pdf', 'report.pdf'), false)
  assert.equal(looksLikeCopyOf('summary.pdf', 'report.pdf'), false)
  assert.equal(looksLikeCopyOf('report-final.pdf', 'report.pdf'), false)
})
