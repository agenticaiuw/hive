import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  backupPathFor,
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'

const ARRAY_STORE = { validate: Array.isArray }

function createStorePath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'store.json')
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777
}

test('writes the primary and backup atomically with owner-only permissions', (t) => {
  const filePath = createStorePath(t)
  const value = [{ id: 'first' }]

  writeJsonAtomic(filePath, value, ARRAY_STORE)

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), value)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(backupPathFor(filePath), 'utf8')),
    value,
  )
  assert.equal(mode(filePath), 0o600)
  assert.equal(mode(backupPathFor(filePath)), 0o600)
  assert.deepEqual(
    fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes('.tmp.')),
    [],
  )
})

test('repairs a malformed primary from a valid backup', (t) => {
  const filePath = createStorePath(t)
  const backup = [{ id: 'recover-from-backup' }]
  fs.writeFileSync(filePath, '{malformed', { mode: 0o644 })
  fs.writeFileSync(backupPathFor(filePath), JSON.stringify(backup), {
    mode: 0o644,
  })

  assert.deepEqual(
    readJsonWithRecovery(filePath, { fallback: [], ...ARRAY_STORE }),
    backup,
  )
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), backup)
  assert.equal(mode(filePath), 0o600)
  assert.equal(mode(backupPathFor(filePath)), 0o600)
})

test('prefers the newest valid interrupted-write temp over an older backup', (t) => {
  const filePath = createStorePath(t)
  const backup = [{ id: 'older-backup' }]
  const interrupted = [{ id: 'newer-temp' }]
  const tempPath = `${filePath}.tmp.crashed-writer`

  fs.writeFileSync(filePath, '{malformed')
  fs.writeFileSync(backupPathFor(filePath), JSON.stringify(backup))
  fs.writeFileSync(tempPath, JSON.stringify(interrupted))
  const now = Date.now() / 1000
  fs.utimesSync(backupPathFor(filePath), now - 20, now - 20)
  fs.utimesSync(tempPath, now, now)

  assert.deepEqual(
    readJsonWithRecovery(filePath, { fallback: [], ...ARRAY_STORE }),
    interrupted,
  )
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), interrupted)
  assert.deepEqual(
    JSON.parse(fs.readFileSync(backupPathFor(filePath), 'utf8')),
    interrupted,
  )
})

test('does not replace an unrecoverable malformed primary during ensure', (t) => {
  const filePath = createStorePath(t)
  fs.writeFileSync(filePath, '{malformed')

  assert.deepEqual(ensureJsonStore(filePath, [], ARRAY_STORE), [])
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{malformed')
})
