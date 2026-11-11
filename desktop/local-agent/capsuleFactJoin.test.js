/*
 * The capsule -> fact join, end to end, entirely in a temp directory.
 *
 * PENDANT_MEMORY_FACTS_PATH and PENDANT_EVIDENCE_STORE_PATH are set before the
 * modules are imported, because memoryService reads FACTS_PATH at module scope.
 * Nothing here goes near the owner's real stores.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, beforeEach } from 'node:test'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'capsule-fact-join-'))
const factsPath = path.join(workspace, 'facts.json')
const capsulePath = path.join(workspace, 'capsules.json')
process.env.PENDANT_MEMORY_FACTS_PATH = factsPath
process.env.PENDANT_EVIDENCE_STORE_PATH = capsulePath

const {
  factsForCapsules,
  listFacts,
  pruneFacts,
  readFactStore,
  rememberBrowserFindings,
  rememberFact,
  revokeFactsForCapsules,
} = await import('./memoryService.js')
const { mintCapsule, revokeCapsules } = await import('./evidenceCapsules.js')

const PAGE = 'https://www.united.com/en/us/fsr/choose-flights?session=abc123'

/*
 * atomicJsonStore keeps a `.bak` beside every store and recovers from it when
 * the primary is missing, so deleting only the primary restores the PREVIOUS
 * test's data rather than starting empty. Clear the whole directory.
 */
function reset() {
  for (const name of fs.readdirSync(workspace)) {
    fs.rmSync(path.join(workspace, name), { recursive: true, force: true })
  }
}

beforeEach(reset)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

test('a browser finding records the capsule it was read from', () => {
  const minted = mintCapsule({
    url: PAGE,
    title: 'Choose flights',
    region: { kind: 'main_text' },
    content: 'ORD to MSN nonstop $148 on Aug 14, United 6041. 3 seats left.',
    context: 'browser-extension',
  })

  const [fact] = rememberBrowserFindings({
    jobId: 'job_1',
    url: PAGE,
    capsuleId: minted.capsuleId,
    findings: [{ key: 'ord_msn_fare', value: 'ORD→MSN nonstop $148 on Aug 14' }],
  })

  assert.deepEqual(fact.source.capsuleIds, [minted.capsuleId])
  assert.equal(fact.source.host, 'united.com')

  const matches = factsForCapsules({ capsuleIds: [minted.capsuleId] })
  assert.equal(matches.length, 1)
  assert.equal(matches[0].matchedBy, 'capsuleId')
  assert.equal(matches[0].inferred, false)
})

test('revoking the capsule removes the derived value from disk, not just from a read', () => {
  const minted = mintCapsule({
    url: PAGE,
    title: 'Choose flights',
    region: { kind: 'main_text' },
    content: 'ORD to MSN nonstop $148 on Aug 14.',
    context: 'browser-extension',
  })
  rememberBrowserFindings({
    jobId: 'job_1',
    url: PAGE,
    capsuleId: minted.capsuleId,
    findings: [
      { key: 'ord_msn_fare', value: 'ORD→MSN nonstop $148 on Aug 14, United 6041' },
      { key: 'ord_msn_seats', value: '3 seats left at that fare' },
    ],
  })

  const raw = fs.readFileSync(factsPath, 'utf8')
  assert.match(raw, /\$148/, 'precondition: the claim is on disk')

  const result = revokeCapsules({ capsuleId: minted.capsuleId, reason: 'owner asked' })

  assert.equal(result.revoked.length, 1)
  assert.equal(result.derivedFacts.removedCount, 2)
  assert.ok(result.derivedFacts.removedBytes > 0)

  const after = fs.readFileSync(factsPath, 'utf8')
  assert.doesNotMatch(after, /\$148/, 'the claim is gone from the file, not filtered')
  assert.doesNotMatch(after, /3 seats left/)

  /* The rows survive as proof, and are unreadable through the normal path. */
  const store = readFactStore()
  assert.equal(store.facts.length, 2)
  for (const fact of store.facts) {
    assert.equal(fact.value, null)
    assert.equal(fact.revocation.matchedBy, 'capsuleId')
    assert.equal(fact.revocation.reason, 'owner asked')
  }
  assert.equal(listFacts().length, 0)
  assert.equal(listFacts({ includeRevoked: true }).length, 2)
})

test('a fact written before capsule ids existed is still reachable, and says so', () => {
  /* Exactly the shape of the two live United observations on this machine:
   * provenance by url and jobId, no capsule anywhere. */
  rememberFact({
    key: 'web.united.com.ord_msn_fare',
    kind: 'observation',
    value: 'ORD→MSN nonstop $148 on Aug 14, United 6041',
    source: {
      origin: 'browser-job',
      url: 'https://www.united.com/en/us/fsr/choose-flights',
      host: 'united.com',
      jobId: 'job_demo_1',
    },
  })

  const minted = mintCapsule({
    url: PAGE,
    title: 'Choose flights',
    region: { kind: 'main_text' },
    content: 'ORD to MSN nonstop $148.',
    context: 'browser-extension',
  })

  const result = revokeCapsules({ capsuleId: minted.capsuleId })
  assert.equal(result.derivedFacts.removedCount, 1)
  assert.equal(result.derivedFacts.revoked[0].matchedBy, 'source-url')
  assert.equal(result.derivedFacts.revoked[0].inferred, true, 'reported as an inference')
})

test('exactOnly refuses the inference and leaves an unlinked fact alone', () => {
  rememberFact({
    key: 'web.united.com.ord_msn_fare',
    kind: 'observation',
    value: 'ORD→MSN nonstop $148',
    source: {
      origin: 'browser-job',
      url: 'https://www.united.com/en/us/fsr/choose-flights',
      host: 'united.com',
    },
  })
  const minted = mintCapsule({
    url: PAGE,
    region: { kind: 'main_text' },
    content: 'ORD to MSN nonstop $148.',
    context: 'browser-extension',
  })

  const result = revokeCapsules({ capsuleId: minted.capsuleId, exactOnly: true })
  assert.equal(result.derivedFacts.removedCount, 0)
  assert.equal(listFacts().length, 1)
})

test('revoking a whole host reaches every fact read from it, www or not', () => {
  rememberBrowserFindings({
    url: 'https://www.united.com/a',
    findings: [{ key: 'a', value: 'fare A' }],
  })
  rememberBrowserFindings({
    url: 'https://united.com/b',
    findings: [{ key: 'b', value: 'fare B' }],
  })
  rememberBrowserFindings({
    url: 'https://delta.com/c',
    findings: [{ key: 'c', value: 'fare C' }],
  })
  mintCapsule({
    url: 'https://www.united.com/a',
    region: { kind: 'main_text' },
    content: 'fare A',
    context: 'browser-extension',
  })

  const result = revokeCapsules({ host: 'www.united.com' })
  assert.equal(result.derivedFacts.removedCount, 2)

  const live = listFacts().map((fact) => fact.key)
  assert.deepEqual(live, ['web.delta.com.c'])
})

test('a fact with no page and no capsule is never swept up by a page revocation', () => {
  rememberFact({
    key: 'preference.editor',
    kind: 'preference',
    value: 'VS Code',
    source: { origin: 'owner' },
  })
  mintCapsule({
    url: PAGE,
    region: { kind: 'main_text' },
    content: 'something',
    context: 'browser-extension',
  })

  const result = revokeCapsules({ host: 'united.com' })
  assert.equal(result.derivedFacts.removedCount, 0)
  assert.equal(listFacts()[0].value, 'VS Code')
})

test('revoking twice is a no-op that reports the earlier revocation', () => {
  const minted = mintCapsule({
    url: PAGE,
    region: { kind: 'main_text' },
    content: 'ORD to MSN $148.',
    context: 'browser-extension',
  })
  rememberBrowserFindings({
    url: PAGE,
    capsuleId: minted.capsuleId,
    findings: [{ key: 'fare', value: '$148' }],
  })

  const first = revokeCapsules({ capsuleId: minted.capsuleId, reason: 'first' })
  assert.equal(first.derivedFacts.removedCount, 1)

  const second = revokeCapsules({ capsuleId: minted.capsuleId, reason: 'second' })
  assert.equal(second.derivedFacts.removedCount, 0)
  assert.equal(second.derivedFacts.alreadyRevoked.length, 1)
  assert.equal(
    readFactStore().facts[0].revocation.reason,
    'first',
    'the first revocation is the true one',
  )
})

test('the join never blocks a revocation, even if the fact store refuses', () => {
  const minted = mintCapsule({
    url: PAGE,
    region: { kind: 'main_text' },
    content: 'ORD to MSN $148.',
    context: 'browser-extension',
  })

  const result = revokeCapsules(
    { capsuleId: minted.capsuleId },
    {
      revokeDerivedFacts: () => {
        throw new Error('fact store is unwritable')
      },
    },
  )

  assert.equal(result.revoked.length, 1, 'the capsule is still revoked')
  assert.match(result.derivedFacts.error, /unwritable/)
})

test('pruning does not let revoked tombstones evict live facts', () => {
  const minted = mintCapsule({
    url: PAGE,
    region: { kind: 'main_text' },
    content: 'ORD to MSN $148.',
    context: 'browser-extension',
  })
  rememberBrowserFindings({
    url: PAGE,
    capsuleId: minted.capsuleId,
    findings: [{ key: 'fare', value: '$148' }],
  })
  revokeCapsules({ capsuleId: minted.capsuleId })

  rememberFact({
    key: 'observation.live',
    kind: 'observation',
    value: 'still true',
    source: { origin: 'owner' },
  })

  const report = pruneFacts({ maxPerKind: 1 })
  assert.equal(report.revokedKept, 1)
  assert.equal(typeof report.removedBytes, 'number')
  assert.equal(typeof report.keptBytes, 'number')

  const live = listFacts().map((fact) => fact.key)
  assert.deepEqual(live, ['observation.live'], 'the live fact survived the cap')
  assert.equal(
    listFacts({ includeRevoked: true }).length,
    2,
    'the tombstone survived the prune',
  )
})

test('revokeFactsForCapsules reports counts and bytes for removed and kept', () => {
  rememberBrowserFindings({
    url: PAGE,
    capsuleId: 'cap_known',
    findings: [{ key: 'fare', value: 'a value long enough to measure' }],
  })
  rememberFact({
    key: 'preference.editor',
    kind: 'preference',
    value: 'VS Code',
    source: { origin: 'owner' },
  })

  const report = revokeFactsForCapsules({ capsuleIds: ['cap_known'] })
  assert.equal(report.removedCount, 1)
  assert.ok(report.removedBytes >= 'a value long enough to measure'.length)
  assert.equal(report.keptCount, 1)
  assert.ok(report.keptBytes > 0)
})
