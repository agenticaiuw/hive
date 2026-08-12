import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  forgetFact,
  listDomainFacts,
  listFacts,
  pruneFacts,
  readFactStore,
  rememberBrowserFindings,
  rememberDomainFact,
  rememberFact,
  touchFacts,
} from './memoryService.js'
import { normalizeDomainFact } from '../shared/domainMemory.js'

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

test('scope rides on a fact, and anything unknown fails closed to node', (t) => {
  const at = store(t)
  const shared = rememberFact({ key: 'obs.shared', value: 'x', scope: 'hive' }, at)
  const local = rememberFact({ key: 'obs.local', value: 'y' }, at)
  const bogus = rememberFact({ key: 'obs.bogus', value: 'z', scope: 'everywhere' }, at)

  assert.equal(shared.scope, 'hive')
  assert.equal(local.scope, 'node', 'the default keeps a fact on this Mac')
  assert.equal(bogus.scope, 'node', 'a scope the store does not know must not travel')
})

test('a key prefix reads one family without scanning it back out by hand', (t) => {
  const at = store(t)
  rememberFact({ key: 'dom.email.account.school', value: 'liu@uni.edu' }, at)
  rememberFact({ key: 'web.united.com.fare', value: '$148' }, at)

  assert.deepEqual(
    listFacts({ keyPrefix: 'dom.' }, at).map((fact) => fact.key),
    ['dom.email.account.school'],
  )
})

test('a domain fact round-trips through the store in the shared shape', (t) => {
  const at = store(t)
  const now = Date.parse('2026-08-12T00:00:00.000Z')

  const identity = normalizeDomainFact(
    {
      domain: 'email',
      name: 'account.school',
      value: 'liu@uni.edu',
      scope: 'hive',
      node: 'voice',
      confidence: 0.95,
    },
    { now },
  )
  const connection = normalizeDomainFact(
    { domain: 'browser', name: 'site.github.com', value: 'github.com', scope: 'node', node: 'mac' },
    { now },
  )

  const storedIdentity = rememberDomainFact(identity, { origin: 'domain-tool', ...at })
  rememberDomainFact(connection, at)

  /* Identities pin like preferences; connections are entities with a lease. */
  assert.equal(storedIdentity.kind, 'preference')
  assert.equal(storedIdentity.source.origin, 'domain-tool')

  const facts = listDomainFacts({}, at)
  assert.equal(facts.length, 2)

  const backIdentity = facts.find((fact) => fact.name === 'account.school')
  assert.equal(backIdentity.domain, 'email')
  assert.equal(backIdentity.value, 'liu@uni.edu')
  assert.equal(backIdentity.scope, 'hive')
  assert.equal(backIdentity.node, 'voice', 'the capturing body survives the round trip')
  assert.equal(backIdentity.expiresAt, null)

  const backConnection = facts.find((fact) => fact.name === 'site.github.com')
  assert.equal(backConnection.scope, 'node')
  assert.equal(backConnection.expiresAt, connection.expiresAt, 'the shared TTL is honoured, not re-derived')

  /* The filters the planner and the bridge actually use. */
  assert.deepEqual(listDomainFacts({ domain: 'email' }, at).map((fact) => fact.name), ['account.school'])
  assert.deepEqual(listDomainFacts({ scope: 'hive' }, at).map((fact) => fact.name), ['account.school'])
  assert.deepEqual(listDomainFacts({ scope: 'node' }, at).map((fact) => fact.name), ['site.github.com'])
})

test('a domain fact deduplicates on its key: saving again overwrites, not piles', (t) => {
  const at = store(t)
  rememberDomainFact(
    normalizeDomainFact({ domain: 'email', name: 'account.school', value: 'old@uni.edu', node: 'mac' }),
    at,
  )
  rememberDomainFact(
    normalizeDomainFact({ domain: 'email', name: 'account.school', value: 'new@uni.edu', node: 'mac' }),
    at,
  )

  const facts = listDomainFacts({ domain: 'email' }, at)
  assert.equal(facts.length, 1)
  assert.equal(facts[0].value, 'new@uni.edu')
})
