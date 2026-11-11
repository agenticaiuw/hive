import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DOMAIN_MEMORY_FIELD,
  domainFactClass,
  domainFactKey,
  foldDomainFacts,
  lookupDomainFacts,
  mergeDomainMemory,
  normalizeDomainFact,
  normalizeDomainMemoryBlock,
  parseDomainFactKey,
  renderDomainFactLines,
} from './domainMemory.js'

const NOW = Date.parse('2026-08-12T10:00:00Z')

test('a fact normalizes with key, class-driven expiry, and scope', () => {
  const fact = normalizeDomainFact(
    { domain: 'email', name: 'account.school', value: 'liu@uni.edu', node: 'mac' },
    { now: NOW },
  )
  assert.equal(fact.key, 'dom.email.account.school')
  assert.equal(fact.scope, 'hive')
  assert.equal(fact.expiresAt, null, 'identities do not expire')

  const site = normalizeDomainFact(
    { domain: 'browser', name: 'site.github.com', value: 'github.com', scope: 'hive' },
    { now: NOW },
  )
  assert.ok(site.expiresAt, 'connections carry an expiry')
  assert.equal(domainFactClass('site.github.com'), 'connection')
  assert.equal(domainFactClass('task.reminders'), 'task')
  assert.equal(domainFactClass('account.personal'), 'identity')
})

test('bad writers are refused loudly, not silently dropped', () => {
  assert.throws(() => normalizeDomainFact({ domain: 'nope', name: 'a', value: 'b' }))
  assert.throws(() => normalizeDomainFact({ domain: 'email', name: '', value: 'b' }))
  assert.throws(() => normalizeDomainFact({ domain: 'email', name: 'a', value: '' }))
  assert.throws(() =>
    normalizeDomainFact({ domain: 'email', name: 'a', value: 'b', scope: 'global' }),
  )
})

test('keys round-trip', () => {
  assert.equal(domainFactKey('email', 'account.club'), 'dom.email.account.club')
  assert.deepEqual(parseDomainFactKey('dom.email.account.club'), {
    domain: 'email',
    name: 'account.club',
  })
  assert.equal(parseDomainFactKey('preference.timezone'), null)
})

test('fold keeps the newest write per key and drops the expired', () => {
  const older = normalizeDomainFact(
    { domain: 'email', name: 'account.default', value: 'school', at: '2026-08-01T00:00:00Z' },
    { now: NOW },
  )
  const newer = normalizeDomainFact(
    { domain: 'email', name: 'account.default', value: 'personal', at: '2026-08-10T00:00:00Z' },
    { now: NOW },
  )
  const expired = normalizeDomainFact(
    {
      domain: 'browser',
      name: 'site.dead.example',
      value: 'dead.example',
      expiresAt: '2026-08-01T00:00:00Z',
    },
    { now: NOW },
  )
  const folded = foldDomainFacts([older, newer, expired], { now: NOW })
  assert.equal(folded.length, 1)
  assert.equal(folded[0].value, 'personal')
})

test('the hive block refuses node-scoped facts on both read and merge', () => {
  const block = normalizeDomainMemoryBlock(
    {
      facts: [
        { domain: 'email', name: 'account.personal', value: 'e@x.com', scope: 'hive' },
        { domain: 'files', name: 'place.notes', value: '/Users/evan/Notes', scope: 'node' },
      ],
    },
    { now: NOW },
  )
  assert.equal(block.facts.length, 1)
  assert.equal(block.facts[0].domain, 'email')

  const { block: merged, stats } = mergeDomainMemory(
    block,
    [{ domain: 'files', name: 'place.notes', value: '/tmp', scope: 'node' }],
    { now: NOW },
  )
  assert.equal(merged.facts.length, 1)
  assert.equal(stats.rejected.length, 1)
  assert.match(stats.rejected[0].reason, /node-scoped/)
})

test('merge is a union where the newest write per key wins', () => {
  const current = {
    facts: [
      { domain: 'email', name: 'account.personal', value: 'old@x.com', scope: 'hive', at: '2026-08-01T00:00:00Z' },
      { domain: 'calendar', name: 'list.groceries', value: 'Groceries', scope: 'hive', at: '2026-08-05T00:00:00Z' },
    ],
  }
  const { block } = mergeDomainMemory(
    current,
    [
      { domain: 'email', name: 'account.personal', value: 'new@x.com', scope: 'hive', at: '2026-08-11T00:00:00Z' },
      { domain: 'music', name: 'service.default', value: 'youtube', scope: 'hive', at: '2026-08-11T00:00:00Z' },
    ],
    { now: NOW },
  )
  const byKey = new Map(block.facts.map((fact) => [fact.key, fact]))
  assert.equal(byKey.size, 3)
  assert.equal(byKey.get('dom.email.account.personal').value, 'new@x.com')
  assert.ok(byKey.get('dom.calendar.list.groceries'), 'unrelated facts survive the merge')
  assert.equal(DOMAIN_MEMORY_FIELD, 'domainMemory')
})

test('lookup filters by domain, ranks query matches first, and bounds itself', () => {
  const facts = [
    normalizeDomainFact({ domain: 'email', name: 'account.personal', value: 'evan@gmail.com' }, { now: NOW }),
    normalizeDomainFact({ domain: 'email', name: 'account.school', value: 'liu@uni.edu' }, { now: NOW }),
    normalizeDomainFact({ domain: 'calendar', name: 'list.default', value: 'Reminders' }, { now: NOW }),
  ]
  const school = lookupDomainFacts(facts, { domain: 'email', query: 'school', now: NOW })
  assert.equal(school[0].name, 'account.school')
  assert.ok(school.every((fact) => fact.domain === 'email'))

  const all = lookupDomainFacts(facts, { domain: null, query: '', limit: 2, now: NOW })
  assert.equal(all.length, 2)
})

test('rendering masks secrets', () => {
  const lines = renderDomainFactLines([
    normalizeDomainFact(
      {
        domain: 'system',
        name: 'level.volume',
        value: '30',
        sensitivity: 'normal',
      },
      { now: NOW },
    ),
    normalizeDomainFact(
      {
        domain: 'browser',
        name: 'site.bank',
        value: 'password hunter2',
        sensitivity: 'secret',
      },
      { now: NOW },
    ),
  ])
  assert.match(lines[0], /system\/level\.volume: 30/)
  assert.ok(!lines[1].includes('hunter2'), 'secret values never render in full')
})
