import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  captureNote,
  forgetCapture,
  parseCapture,
  recallCaptures,
  stripLeadIn,
} from './quickCapture.js'

function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-capture-test-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  const archived = []
  return {
    at: {
      filePath: path.join(directory, 'facts.json'),
      archive: (entity) => {
        archived.push(entity)
        return { entity: { ...entity, id: `ent_${archived.length}` } }
      },
    },
    archived,
  }
}

test('lead-ins are stripped without eating the payload', () => {
  assert.equal(stripLeadIn('Remember this: my bike lock code is 4829'), 'my bike lock code is 4829')
  assert.equal(
    stripLeadIn('Save this idea for later: a pendant that files its own tickets'),
    'a pendant that files its own tickets',
  )
  assert.equal(stripLeadIn('Save this for later — call the dentist'), 'call the dentist')
  // "save this idea for later" must not be clipped by the shorter "save this".
  assert.equal(stripLeadIn('save this idea for later, buy oat milk'), 'buy oat milk')
  // Nothing to strip is not an error.
  assert.equal(stripLeadIn('the roof leaks'), 'the roof leaks')
})

test('"my X is Y" becomes a keyed fact the owner can ask for by name', () => {
  const parsed = parseCapture('Remember this: my bike lock code is 4829.')
  assert.equal(parsed.mode, 'fact')
  assert.equal(parsed.title, 'bike lock code')
  assert.equal(parsed.key, 'owner.bike-lock-code')
  assert.equal(parsed.value, 'bike lock code: 4829')
})

test('a spoken lock code is classified secret so it never reaches a prompt in the clear', () => {
  const parsed = parseCapture('Remember this: my bike lock code is 4829.')
  assert.equal(
    parsed.sensitivity,
    'secret',
    'four digits and a noun carry none of the machine-generated secret shapes',
  )
})

test('an idea is stored whole and never overwrites the previous one', (t) => {
  const { at } = store(t)
  const now = Date.parse('2026-08-07T09:00:00.000Z')

  const first = captureNote({ text: 'Save this idea for later: pendant files its own tickets', now }, at)
  const second = captureNote({ text: 'Save this idea for later: pendant reads my Downloads', now }, at)

  assert.equal(first.mode, 'idea')
  assert.notEqual(first.key, second.key, 'two ideas on one day must not collide')
  assert.equal(recallCaptures({ now }, at).length, 2)
})

test('the same fact said twice replaces itself rather than accumulating', (t) => {
  const { at } = store(t)
  const now = Date.parse('2026-08-07T09:00:00.000Z')

  captureNote({ text: 'Remember this: my bike lock code is 4829', now }, at)
  captureNote({ text: 'Remember this: my bike lock code is 1111', now: now + 60_000 }, at)

  const recalled = recallCaptures({ query: 'bike lock', now: now + 60_000 }, at)
  assert.equal(recalled.length, 1, 'a lock code cannot be two things')
  assert.equal(recalled[0].value, 'bike lock code: 1111')
})

test('the archive copy of a secret carries the label and not the value', (t) => {
  const { at, archived } = store(t)
  captureNote({ text: 'Remember this: my bike lock code is 4829' }, at)

  const [entity] = archived
  assert.equal(entity.type, 'Note')
  assert.equal(entity.name, 'bike lock code')
  assert.equal(entity.attributes.note, '[stored privately]')
  assert.equal(entity.attributes.factKey, 'owner.bike-lock-code')
  assert.ok(
    !JSON.stringify(entity).includes('4829'),
    'the context graph is pasted into planner prompts verbatim',
  )
})

test('a non-sensitive idea is archived in full', (t) => {
  const { at, archived } = store(t)
  captureNote({ text: 'Save this idea for later: pendant files its own tickets' }, at)
  assert.match(archived[0].attributes.note, /files its own tickets/)
})

test('the owner reads their own secret back at full fidelity', (t) => {
  const { at } = store(t)
  captureNote({ text: 'Remember this: my bike lock code is 4829' }, at)

  const [recalled] = recallCaptures({ query: 'bike lock code' }, at)
  assert.equal(recalled.value, 'bike lock code: 4829', 'withholding is about prompts, not the owner')
  assert.equal(recalled.sensitivity, 'secret')
})

test('the spoken confirmation of a secret does not contain the secret', (t) => {
  const { at } = store(t)
  const result = captureNote({ text: 'Remember this: my bike lock code is 4829' }, at)
  assert.ok(!result.spoken.includes('4829'), 'said out loud, possibly in public')
  assert.match(result.spoken, /bike lock code/)
})

test('captures never expire on their own', (t) => {
  const { at } = store(t)
  const now = Date.parse('2026-08-07T09:00:00.000Z')
  captureNote({ text: 'Save this idea for later: buy a soldering station', now }, at)

  const [recalled] = recallCaptures({ now: now + 400 * 24 * 60 * 60 * 1000 }, at)
  assert.ok(recalled, '"for later" cannot mean "for a week"')
})

test('forgetting is by key', (t) => {
  const { at } = store(t)
  captureNote({ text: 'Remember this: my bike lock code is 4829' }, at)
  assert.equal(forgetCapture('owner.bike-lock-code', at), true)
  assert.equal(recallCaptures({}, at).length, 0)
})

test('an empty capture is refused rather than stored as a blank note', () => {
  assert.throws(() => parseCapture('   remember this:   '), /Nothing to capture/)
})
