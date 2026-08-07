import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  lastBriefingRun,
  listBriefingRuns,
  readBriefingQueueStore,
  recordBriefingRun,
  resolveQueueItem,
  reviewQueue,
  statePolicy,
  statedPolicy,
  toldFingerprints,
  unheardRunIds,
} from './briefingQueue.js'

function tempStore() {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-briefing-queue-')),
    'queue.json',
  )
}

const AT = '2026-08-07T07:30:00.000Z'

function run(id = 'btg_1', generatedAt = AT) {
  return { id, generatedAt, digest: 'abc', spoken: 'Two things need you.' }
}

function found(fingerprint, overrides = {}) {
  return {
    fingerprint,
    source: 'reminders',
    title: 'File the form',
    detail: 'Work',
    why: ['its deadline has already passed'],
    score: 5,
    at: AT,
    actionableUntil: AT,
    provenance: { reader: 'local-agent/appleData.js listOpenReminders', capsuleIds: [] },
    ...overrides,
  }
}

test('an empty store is a valid store, not an error', () => {
  const filePath = tempStore()
  assert.deepEqual(reviewQueue({ filePath }), [])
  assert.equal(lastBriefingRun({ filePath }), null)
  assert.equal(statedPolicy({ filePath }), null)
})

test('the owner has stated no policy until they state one', () => {
  const filePath = tempStore()
  assert.equal(statedPolicy({ filePath }), null)

  const stated = statePolicy({ threshold: 6, maxSpoken: 2 }, { filePath })
  assert.equal(stated.threshold, 6)
  assert.ok(stated.statedAt, 'when they said it is part of the record')
  assert.equal(statedPolicy({ filePath }).maxSpoken, 2)
})

test('a second statement merges rather than replacing the first', () => {
  const filePath = tempStore()
  statePolicy({ threshold: 6 }, { filePath })
  statePolicy({ maxSpoken: 1 }, { filePath })
  const stored = statedPolicy({ filePath })
  assert.equal(stored.threshold, 6)
  assert.equal(stored.maxSpoken, 1)
})

test('statePolicy refuses anything that is not an object', () => {
  assert.throws(() => statePolicy('loud', { filePath: tempStore() }), /must be an object/)
})

test('what was told is remembered by fingerprint, and the body is not kept', () => {
  const filePath = tempStore()
  recordBriefingRun({ run: run(), told: [found('fp_1')], queued: [] }, { filePath })

  const told = toldFingerprints({ filePath })
  assert.equal(told.size, 1)
  assert.equal(told.get('fp_1').headline, 'File the form')
  /* This ledger is read on every run and shown to nobody. Keeping the finding
   * here would make the novelty check a growing read and would duplicate what
   * the queue already holds. */
  assert.equal(told.get('fp_1').provenance, undefined)
  assert.equal(told.get('fp_1').why, undefined)
})

test('toldFingerprints can be asked the narrower recent question', () => {
  const filePath = tempStore()
  recordBriefingRun(
    { run: run('btg_old', '2026-08-01T07:30:00.000Z'), told: [found('fp_old')], queued: [] },
    { filePath },
  )
  recordBriefingRun({ run: run('btg_new'), told: [found('fp_new')], queued: [] }, { filePath })

  const now = Date.parse(AT)
  assert.equal(toldFingerprints({ filePath, now }).size, 2)
  assert.equal(toldFingerprints({ filePath, now, withinMs: 3_600_000 }).size, 1)
})

test('a brief the owner never played has told them nothing', () => {
  /*
   * Composed is not heard. Verified end to end before this existed: run one
   * said "2 things need you" and went unplayed; run two, three minutes later,
   * found both fingerprints here, said "nothing needs you right now", and
   * replaced the audio the owner had not listened to.
   */
  const filePath = tempStore()
  recordBriefingRun(
    { run: { ...run('btg_1'), briefingId: 'brf_unplayed' }, told: [found('fp_1')], queued: [] },
    { filePath },
  )
  recordBriefingRun(
    { run: { ...run('btg_2'), briefingId: 'brf_played' }, told: [found('fp_2')], queued: [] },
    { filePath },
  )

  const unheard = unheardRunIds({ filePath, unplayedBriefingIds: ['brf_unplayed'] })
  assert.deepEqual(unheard, ['btg_1'])

  const told = toldFingerprints({ filePath, excludeRunIds: unheard })
  assert.equal(told.has('fp_1'), false, 'unheard is not told')
  assert.equal(told.has('fp_2'), true)
})

test('a run that produced no audio counts as delivered', () => {
  /* There is no played flag that could ever say otherwise, and it wrote a note
   * the owner can open. */
  const filePath = tempStore()
  recordBriefingRun({ run: run('btg_1'), told: [found('fp_1')], queued: [] }, { filePath })

  assert.deepEqual(unheardRunIds({ filePath, unplayedBriefingIds: ['brf_x'] }), [])
  assert.equal(toldFingerprints({ filePath }).has('fp_1'), true)
})

test('nothing unplayed means nothing is excluded, without reading the store twice', () => {
  const filePath = tempStore()
  recordBriefingRun(
    { run: { ...run('btg_1'), briefingId: 'brf_1' }, told: [found('fp_1')], queued: [] },
    { filePath },
  )
  assert.deepEqual(unheardRunIds({ filePath, unplayedBriefingIds: [] }), [])
})

test('an open finding seen three mornings running is one queue row, not three', () => {
  const filePath = tempStore()
  for (const day of ['2026-08-05', '2026-08-06', '2026-08-07']) {
    recordBriefingRun(
      { run: run(`btg_${day}`, `${day}T07:30:00.000Z`), told: [], queued: [found('fp_1')] },
      { filePath },
    )
  }

  const queue = reviewQueue({ filePath })
  assert.equal(queue.length, 1)
  assert.equal(queue[0].seenCount, 3)
  assert.equal(queue[0].openedAt, '2026-08-05T07:30:00.000Z')
  assert.equal(queue[0].lastSeenAt, '2026-08-07T07:30:00.000Z')
})

test('a queue row refreshes its detail in place when the finding moves', () => {
  const filePath = tempStore()
  recordBriefingRun({ run: run(), told: [], queued: [found('fp_1')] }, { filePath })
  recordBriefingRun(
    {
      run: run('btg_2'),
      told: [],
      queued: [found('fp_1', { detail: 'Personal', why: ['you wrote this one down yourself'] })],
    },
    { filePath },
  )

  const [item] = reviewQueue({ filePath })
  assert.equal(item.detail, 'Personal')
  assert.deepEqual(item.why, ['you wrote this one down yourself'])
})

test('nothing in the queue claims to have been acted on', () => {
  const filePath = tempStore()
  recordBriefingRun(
    {
      run: run(),
      told: [],
      queued: [found('fp_1', { draft: { subject: 'Re: hi', body: 'Hi', to: 'a@b.example', sent: false } })],
    },
    { filePath },
  )

  const [item] = reviewQueue({ filePath })
  assert.equal(item.acted, false)
  assert.equal(item.status, 'waiting')
  assert.equal(item.draft.sent, false)
})

test('resolving takes an item off the queue without deleting the record', () => {
  const filePath = tempStore()
  recordBriefingRun({ run: run(), told: [], queued: [found('fp_1')] }, { filePath })
  const [item] = reviewQueue({ filePath })

  assert.equal(resolveQueueItem(item.id, { status: 'dismissed', filePath }).status, 'dismissed')
  assert.equal(reviewQueue({ filePath }).length, 0)
  assert.equal(reviewQueue({ filePath, includeResolved: true }).length, 1)
})

test('there is no status that means the agent did something', () => {
  const filePath = tempStore()
  recordBriefingRun({ run: run(), told: [], queued: [found('fp_1')] }, { filePath })
  const [item] = reviewQueue({ filePath })

  assert.throws(() => resolveQueueItem(item.id, { status: 'sent', filePath }), /reviewed.*dismissed/s)
  assert.throws(() => resolveQueueItem(item.id, { status: 'acted', filePath }), /reviewed.*dismissed/s)
})

test('resolving something that is not there is a miss, not a crash', () => {
  assert.equal(resolveQueueItem('bqi_nope', { filePath: tempStore() }), null)
})

test('a finding whose evidence is gone keeps its row and loses its contents', () => {
  /*
   * Same contract as pageWatch.js's pendingReports, and for the same reason:
   * dropping the row would make a revocation look like the finding never
   * happened, and showing the detail would make "forget what you read there"
   * mean nothing. A capsule id the store has never seen is treated exactly like
   * a revoked one — there is no reading behind it either way.
   */
  const filePath = tempStore()
  recordBriefingRun(
    {
      run: run(),
      told: [],
      queued: [
        found('fp_1', {
          source: 'account',
          title: 'Flight NH117',
          detail: 'Flight NH117: status On time → Delayed',
          provenance: {
            reader: 'local-agent/pageWatch.js pendingReports',
            capsuleIds: ['cap_this_was_revoked'],
          },
        }),
      ],
    },
    { filePath },
  )

  const [item] = reviewQueue({ filePath })
  assert.equal(item.title, 'Flight NH117', 'the row survives')
  assert.equal(item.detail, '')
  assert.deepEqual(item.why, [])
  assert.match(item.summary, /evidence for it is no longer available/)
  assert.equal(item.evidenceWithheld.length, 1)
})

test('a finding with no capsules behind it is untouched by the evidence check', () => {
  const filePath = tempStore()
  recordBriefingRun({ run: run(), told: [], queued: [found('fp_1')] }, { filePath })
  const [item] = reviewQueue({ filePath })
  assert.equal(item.detail, 'Work')
  assert.equal(item.evidenceWithheld, undefined)
})

test('runs are kept newest first with what they said and where it landed', () => {
  const filePath = tempStore()
  recordBriefingRun(
    { run: { ...run('btg_1', '2026-08-06T07:30:00.000Z'), notePath: '/tmp/a.md' }, told: [found('fp_a')], queued: [] },
    { filePath },
  )
  recordBriefingRun(
    { run: { ...run('btg_2'), policySource: 'owner' }, told: [], queued: [found('fp_b')] },
    { filePath },
  )

  const runs = listBriefingRuns({ filePath })
  assert.equal(runs[0].id, 'btg_2')
  assert.equal(runs[0].told, 0)
  assert.equal(runs[0].queued, 1)
  assert.equal(runs[0].policySource, 'owner')
  assert.equal(runs[1].notePath, '/tmp/a.md')
  assert.equal(lastBriefingRun({ filePath }).id, 'btg_2')
})

test('the told ledger is bounded so the novelty check stays a cheap read', () => {
  const filePath = tempStore()
  for (let batch = 0; batch < 6; batch += 1) {
    recordBriefingRun(
      {
        run: run(`btg_${batch}`),
        told: Array.from({ length: 100 }, (_, index) => found(`fp_${batch}_${index}`)),
        queued: [],
      },
      { filePath },
    )
  }
  assert.equal(readBriefingQueueStore({ filePath }).told.length, 500)
})

test('the queue evicts what the owner already resolved before what they have not seen', () => {
  const filePath = tempStore()
  recordBriefingRun(
    {
      run: run(),
      told: [],
      queued: Array.from({ length: 40 }, (_, index) => found(`fp_old_${index}`)),
    },
    { filePath },
  )
  for (const item of reviewQueue({ filePath })) {
    resolveQueueItem(item.id, { status: 'dismissed', filePath })
  }
  recordBriefingRun(
    {
      run: run('btg_2'),
      told: [],
      queued: Array.from({ length: 190 }, (_, index) => found(`fp_new_${index}`)),
    },
    { filePath },
  )

  const store = readBriefingQueueStore({ filePath })
  assert.equal(store.queue.length, 200)
  assert.equal(
    store.queue.filter((item) => item.status === 'waiting').length,
    190,
    'nothing the owner has not looked at may be evicted while dismissed rows remain',
  )
})

test('a corrupt store is recovered rather than silently emptied', () => {
  const filePath = tempStore()
  recordBriefingRun({ run: run(), told: [found('fp_1')], queued: [] }, { filePath })
  fs.writeFileSync(filePath, '{ not json', 'utf8')

  assert.equal(toldFingerprints({ filePath }).size, 1)
})
