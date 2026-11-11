/*
 * The relay-side domain-memory seam, exercised against the real in-memory
 * store so the read-merge-write cycle is the production one, not a stub's.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDomainMemoryRelay,
  readDomainMemory,
  saveDomainMemory,
} from './domainMemoryRelay.js'
import { FLEET_STATE_KEY } from './fleetContext.js'
import { createMemoryStore } from './store/memoryStore.js'

test('readDomainMemory answers an empty hand from a store with no fleet state', async () => {
  const { facts, lines } = await readDomainMemory(createMemoryStore(), {
    domain: 'email',
  })
  assert.deepEqual(facts, [])
  assert.deepEqual(lines, [])
})

test('readDomainMemory is best-effort: a throwing store costs the facts, not an exception', async () => {
  const { facts, lines } = await readDomainMemory({
    async getState() {
      throw new Error('D1 is down')
    },
  })
  assert.deepEqual(facts, [])
  assert.deepEqual(lines, [])
})

test('saveDomainMemory creates the fleet state when missing and the fact round-trips', async () => {
  const store = createMemoryStore()
  const stats = await saveDomainMemory(
    store,
    [{ domain: 'email', name: 'account.school', value: 'liu@uni.edu' }],
    { node: 'voice' },
  )
  assert.equal(stats.accepted, 1)
  assert.equal(stats.kept, 1)

  const { facts, lines } = await readDomainMemory(store, {
    domain: 'email',
    query: 'school',
  })
  assert.equal(facts.length, 1)
  assert.equal(facts[0].key, 'dom.email.account.school')
  /* Fill-in stamp: the fact carried no node of its own. */
  assert.equal(facts[0].node, 'voice')
  assert.deepEqual(lines, ['- email/account.school: liu@uni.edu'])
})

test('saveDomainMemory touches domainMemory and nothing else in the fleet document', async () => {
  const store = createMemoryStore()
  await store.saveState(
    FLEET_STATE_KEY,
    {
      mac: { online: true, hostname: 'home' },
      domainMemory: {
        facts: [
          { domain: 'music', name: 'service.default', value: 'Spotify', node: 'mac' },
        ],
      },
    },
    { updatedBy: 'mac' },
  )

  await saveDomainMemory(
    store,
    [{ domain: 'email', name: 'account.personal', value: 'evan@gmail.com' }],
    { node: 'voice' },
  )

  const state = await store.getState(FLEET_STATE_KEY)
  /* The Mac's telemetry survives a voice save untouched… */
  assert.deepEqual(state.data.mac, { online: true, hostname: 'home' })
  /* …and the block is a UNION, not a replacement. */
  const keys = state.data.domainMemory.facts.map((fact) => fact.key).sort()
  assert.deepEqual(keys, [
    'dom.email.account.personal',
    'dom.music.service.default',
  ])
})

test('node-scoped facts are refused by the hive block, with the reason on the stats', async () => {
  const store = createMemoryStore()
  const stats = await saveDomainMemory(
    store,
    [
      { domain: 'system', name: 'level.volume', value: '30', scope: 'node' },
      { domain: 'email', name: 'account.club', value: 'club@uni.edu' },
    ],
    { node: 'voice' },
  )
  assert.equal(stats.accepted, 1)
  assert.equal(stats.rejected.length, 1)
  assert.match(stats.rejected[0].reason, /node-scoped/)

  const { facts } = await readDomainMemory(store)
  assert.deepEqual(
    facts.map((fact) => fact.key),
    ['dom.email.account.club'],
  )
})

test('an existing node stamp on a fact is kept, not overwritten', async () => {
  const store = createMemoryStore()
  await saveDomainMemory(
    store,
    [{ domain: 'browser', name: 'site.bank', value: 'chase.com', node: 'browser-ext' }],
    { node: 'voice' },
  )
  const { facts } = await readDomainMemory(store, { domain: 'browser' })
  assert.equal(facts[0].node, 'browser-ext')
})

test('createDomainMemoryRelay yields the session-option shape the voice brain consumes', async () => {
  const store = createMemoryStore()
  const relay = createDomainMemoryRelay({ store, node: 'voice' })

  const stats = await relay.save([
    { domain: 'email', name: 'account.school', value: 'liu@uni.edu' },
    { domain: 'email', name: 'account.personal', value: 'evan@gmail.com' },
  ])
  assert.equal(stats.accepted, 2)

  const { facts, lines } = await relay.lookup({ domain: 'email', query: 'school' })
  assert.equal(facts.length, 2)
  /* Best match first: the query names the school account. */
  assert.equal(facts[0].name, 'account.school')
  assert.equal(lines.length, 2)

  /* A lookup with no domain still answers — the degrade path memory_lookup
   * relies on when the model picks a wrong domain. */
  const all = await relay.lookup({})
  assert.equal(all.facts.length, 2)
})

test('saveDomainMemory refuses a store that cannot persist', async () => {
  await assert.rejects(
    () => saveDomainMemory({}, [{ domain: 'email', name: 'a.b', value: 'c' }]),
    /cannot persist/,
  )
})
