import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  forgetFact,
  listFacts,
  pruneFacts,
  readFactStore,
  rememberBrowserFindings,
  rememberFact,
  touchFacts,
} from './memoryService.js'

const DAY = 24 * 60 * 60 * 1000

function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-memory-test-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return { filePath: path.join(directory, 'facts.json') }
}

test('a fact carries provenance, confidence, sensitivity, expiry and use tracking', (t) => {
  const at = store(t)
  const now = Date.parse('2026-08-07T00:00:00.000Z')

  const fact = rememberFact(
    {
      key: 'preference.editor',
      kind: 'preference',
      value: 'VS Code',
      surfaces: ['mac'],
      source: { origin: 'owner' },
      confidence: 0.95,
      now,
    },
    at,
  )

  assert.equal(fact.kind, 'preference')
  assert.equal(fact.source.origin, 'owner')
  assert.equal(fact.confidence, 0.95)
  assert.equal(fact.sensitivity, 'normal')
  assert.equal(fact.expiresAt, null, 'preferences do not expire on their own')
  assert.equal(fact.lastUsedAt, null)

  assert.equal(touchFacts([fact.id], { now }, at), 1)
  const [stored] = listFacts({ now }, at)
  assert.equal(stored.lastUsedAt, new Date(now).toISOString())
  assert.equal(stored.useCount, 1)
})

test('same key replaces the old value and keeps one step of contradiction history', (t) => {
  const at = store(t)
  rememberFact({ key: 'preference.editor', kind: 'preference', value: 'Vim' }, at)
  const updated = rememberFact(
    { key: 'preference.editor', kind: 'preference', value: 'VS Code' },
    at,
  )

  assert.equal(readFactStore(at).facts.length, 1)
  assert.equal(updated.value, 'VS Code')
  assert.equal(updated.previousValue, 'Vim')
})

test('sensitivity is inferred when the writer does not say', (t) => {
  const at = store(t)
  const secret = rememberFact(
    { key: 'cred.relay', value: 'RELAY_API_KEY=sk-live-2f8a9b3c4d5e6f7a8b9c' },
    at,
  )
  const personal = rememberFact({ key: 'person.david', value: 'david@stanford.edu' }, at)
  const plain = rememberFact({ key: 'note.gpu', value: 'The GPU cluster is called SAIL' }, at)

  assert.equal(secret.sensitivity, 'secret')
  assert.equal(personal.sensitivity, 'sensitive')
  assert.equal(plain.sensitivity, 'normal')
})

test('expiry and idleness stop the owner paying for stale facts', (t) => {
  const at = store(t)
  const now = Date.parse('2026-08-07T00:00:00.000Z')

  rememberFact({ key: 'obs.fresh', value: 'still true', now }, at)
  rememberFact({ key: 'obs.stale', value: 'was true last week', ttlMs: DAY, now: now - 3 * DAY }, at)
  rememberFact({ key: 'obs.forgotten', value: 'nobody ever read this', ttlMs: null, now: now - 90 * DAY }, at)
  rememberFact(
    { key: 'preference.timezone', kind: 'preference', value: 'America/Chicago', now: now - 400 * DAY },
    at,
  )

  assert.equal(listFacts({ now }, at).length, 3, 'expired facts are hidden before pruning')

  const result = pruneFacts({ now }, at)
  assert.equal(result.reasons.expired, 1)
  assert.equal(result.reasons.idle, 1)

  const remaining = listFacts({ now }, at).map((fact) => fact.key).sort()
  assert.deepEqual(remaining, ['obs.fresh', 'preference.timezone'])
})

test('per-kind caps evict the least recently used, not the oldest written', (t) => {
  const at = store(t)
  const now = Date.parse('2026-08-07T00:00:00.000Z')

  for (let index = 0; index < 5; index += 1) {
    rememberFact({ key: `obs.${index}`, value: `fact ${index}`, now: now - index * 1000 }, at)
  }
  const revived = listFacts({ now }, at).find((fact) => fact.key === 'obs.4')
  touchFacts([revived.id], { now }, at)

  pruneFacts({ now, maxPerKind: 2 }, at)
  const kept = listFacts({ now }, at).map((fact) => fact.key).sort()
  assert.deepEqual(kept, ['obs.0', 'obs.4'], 'the touched fact outranks fresher untouched ones')
})

test('browser findings land in their own tier: normalized value, source url, retrieval time', (t) => {
  const at = store(t)
  const now = Date.parse('2026-08-07T00:00:00.000Z')

  const [fact] = rememberBrowserFindings(
    {
      jobId: 'job_42',
      url: 'https://www.united.com/booking/ORD-MSN',
      retrievedAt: '2026-08-07T00:00:00.000Z',
      findings: [{ key: 'cheapest_fare', value: `ORD→MSN nonstop $148 ${'x'.repeat(500)}` }],
    },
    at,
  )

  assert.equal(fact.key, 'web.united.com.cheapest_fare')
  assert.equal(fact.source.origin, 'browser-job')
  assert.equal(fact.source.url, 'https://www.united.com/booking/ORD-MSN')
  assert.equal(fact.source.jobId, 'job_42')
  assert.equal(fact.source.at, '2026-08-07T00:00:00.000Z')
  assert.ok(fact.value.length <= 200, 'raw page text can never become memory')
  assert.equal(fact.expiresAt, new Date(now + DAY).toISOString())
})

test('forget removes by id or by key', (t) => {
  const at = store(t)
  const fact = rememberFact({ key: 'obs.one', value: 'one' }, at)
  rememberFact({ key: 'obs.two', value: 'two' }, at)

  assert.equal(forgetFact(fact.id, at), true)
  assert.equal(forgetFact('obs.two', at), true)
  assert.equal(forgetFact('obs.missing', at), false)
  assert.equal(readFactStore(at).facts.length, 0)
})

test('the store survives a truncated write', (t) => {
  const at = store(t)
  rememberFact({ key: 'preference.editor', kind: 'preference', value: 'VS Code' }, at)
  fs.writeFileSync(at.filePath, '{"facts":[')

  assert.equal(listFacts({}, at)[0].value, 'VS Code')
})
