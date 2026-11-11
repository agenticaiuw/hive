import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MEETING_PREP_PRODUCER,
  QUEUE_BUDGET,
  assertOwned,
  commitQueue,
  estimateSeconds,
  listMeetingPrepQueue,
  planQueue,
  queueItemDigest,
  queueSpoken,
} from './meetingPrepQueue.js'

const NOW = new Date('2026-08-07T05:00:00')

function item(overrides = {}) {
  return {
    meetingKey: 'e1',
    meetingStart: '2026-08-07T09:00:00',
    title: 'Pendant firmware review',
    text: 'Pendant firmware review at 9 AM. Jorge wrote last and you have not replied.',
    ...overrides,
  }
}

function row(overrides = {}) {
  const base = {
    id: 'brf_1',
    producer: MEETING_PREP_PRODUCER,
    meetingKey: 'e1',
    meetingStart: '2026-08-07T09:00:00',
    topic: 'Pendant firmware review',
    seconds: 30,
    played: false,
    createdAt: '2026-08-07T05:00:00.000Z',
  }
  const merged = { ...base, ...overrides }
  return { ...merged, digest: merged.digest ?? queueItemDigest({ meetingKey: merged.meetingKey, text: item().text }) }
}

test('identical content is reused, never rendered a second time', () => {
  const existing = [row()]
  const plan = planQueue({ items: [item()], existing, now: NOW })

  assert.equal(plan.render.length, 0, '44 byte-identical copies is how the shelf ate itself')
  assert.equal(plan.reuse.length, 1)
  assert.deepEqual(plan.retire, [])
})

test('a re-prep of the same meeting replaces its own row rather than adding one', () => {
  const existing = [row()]
  const plan = planQueue({
    items: [item({ text: 'Pendant firmware review at 9 AM. The agenda changed overnight.' })],
    existing,
    now: NOW,
  })

  assert.equal(plan.render.length, 1)
  assert.equal(plan.retire.length, 1)
  assert.equal(plan.retire[0].id, 'brf_1')
  assert.match(plan.retire[0].reason, /same meeting/)
})

test('an unheard brief is never evicted to make room for a new one', () => {
  /* Four unheard briefs for meetings that have not happened: the queue is full
   * of things the owner still needs. */
  const existing = Array.from({ length: QUEUE_BUDGET.maxItems }, (_unused, index) =>
    row({
      id: `brf_${index}`,
      meetingKey: `m${index}`,
      digest: `d${index}`,
      seconds: 30,
      played: false,
    }),
  )

  const plan = planQueue({
    items: [item({ meetingKey: 'new', title: 'A fifth meeting' })],
    existing,
    now: NOW,
  })

  assert.deepEqual(plan.retire, [], 'nothing unheard and still useful may be dropped')
  assert.equal(plan.render.length, 0)
  assert.equal(plan.refused.length, 1)
  assert.match(plan.refused[0].reason, /have not listened to/)
})

test('a brief for a meeting that has already started is the one thing that may go', () => {
  const existing = [
    row({ id: 'brf_past', meetingKey: 'past', digest: 'dp', meetingStart: '2026-08-07T04:00:00' }),
    row({ id: 'brf_future', meetingKey: 'future', digest: 'df' }),
  ]
  const plan = planQueue({ items: [], existing, now: NOW })

  assert.equal(plan.retire.length, 1)
  assert.equal(plan.retire[0].id, 'brf_past')
  assert.match(plan.retire[0].reason, /already started/)
})

test('played briefs are the capacity this feature makes for itself', () => {
  const existing = [
    ...Array.from({ length: QUEUE_BUDGET.maxItems - 1 }, (_unused, index) =>
      row({ id: `brf_${index}`, meetingKey: `m${index}`, digest: `d${index}`, played: false }),
    ),
    row({ id: 'brf_old', meetingKey: 'old', digest: 'dold', played: true, createdAt: '2026-08-01T05:00:00.000Z' }),
  ]

  const plan = planQueue({ items: [item({ meetingKey: 'new' })], existing, now: NOW })

  assert.equal(plan.render.length, 1)
  assert.equal(plan.retire.length, 1)
  assert.equal(plan.retire[0].id, 'brf_old')
  assert.match(plan.retire[0].reason, /already listened/)
})

test('the budget is seconds as well as rows — "short" is about listening, not counting', () => {
  const long = 'word '.repeat(600)
  const plan = planQueue({
    items: [item({ meetingKey: 'a', text: long }), item({ meetingKey: 'b', text: long })],
    existing: [],
    now: NOW,
  })

  assert.ok(estimateSeconds(long) > 120)
  assert.equal(plan.render.length, 1)
  assert.equal(plan.refused.length, 1)
  assert.match(plan.refused[0].reason, /seconds of unheard audio/)
})

test('when the queue cannot hold every meeting it holds the earliest ones', () => {
  const plan = planQueue({
    items: [
      item({ meetingKey: 'late', meetingStart: '2026-08-07T16:00:00', title: 'Late' }),
      item({ meetingKey: 'early', meetingStart: '2026-08-07T08:00:00', title: 'Early' }),
    ],
    existing: Array.from({ length: QUEUE_BUDGET.maxItems - 1 }, (_unused, index) =>
      row({ id: `brf_${index}`, meetingKey: `m${index}`, digest: `d${index}` }),
    ),
    now: NOW,
  })

  assert.equal(plan.render.length, 1)
  assert.equal(plan.render[0].title, 'Early')
  assert.equal(plan.refused[0].item.title, 'Late')
})

test('this module refuses to remove audio it did not produce', () => {
  const foreign = { id: 'brf_research', producer: 'research', played: false }
  assert.throws(() => assertOwned(['brf_research'], [foreign]), /only retires audio it produced/)
  assert.throws(
    () =>
      commitQueue(
        { render: [], reuse: [], retire: [{ id: 'brf_research', reason: 'nope' }], refused: [] },
        { existing: [foreign] },
      ),
    /only retires audio it produced/,
  )
})

test('rendering happens before retiring, so a failed render never leaves an empty queue', () => {
  const existing = [row()]
  const removed = []
  const result = commitQueue(
    planQueue({ items: [item({ text: 'something new entirely' })], existing, now: NOW }),
    {
      existing,
      now: NOW,
      render: () => {
        throw new Error('say: no audio device')
      },
      save: () => assert.fail('nothing should be saved when the render failed'),
      remove: (id) => {
        removed.push(id)
        return true
      },
    },
  )

  assert.equal(result.rendered.length, 0)
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0], /no audio device/)
  assert.deepEqual(
    removed,
    [],
    'the old brief survives a failed render — the owner keeps yesterday rather than getting nothing',
  )
})

test('a committed row carries the two fields the eviction rules are made of', () => {
  const saved = []
  const result = commitQueue(planQueue({ items: [item()], existing: [], now: NOW }), {
    existing: [],
    now: NOW,
    render: () => ({ wavPath: '/tmp/a.wav', opusPath: '/tmp/a.opus', seconds: 31, pcmBytes: 1, opusBytes: 1, truncated: false }),
    save: (entry) => {
      saved.push(entry)
      return { id: 'brf_new', ...entry }
    },
    remove: () => true,
  })

  assert.equal(saved[0].producer, MEETING_PREP_PRODUCER)
  assert.equal(saved[0].meetingKey, 'e1')
  assert.equal(saved[0].meetingStart, '2026-08-07T09:00:00')
  assert.equal(result.rendered[0].seconds, 31)
})

test('the shelf is only ever read through this producer’s own filter', () => {
  const rows = listMeetingPrepQueue({
    list: () => [
      { id: 'a', producer: MEETING_PREP_PRODUCER },
      { id: 'b', producer: 'briefingTriage' },
      { id: 'c' },
    ],
  })
  assert.deepEqual(rows.map((entry) => entry.id), ['a'])
})

test('the queue says how long it is, not just how many', () => {
  assert.match(queueSpoken([{ seconds: 40 }, { seconds: 35 }]), /2 meeting briefs.*about 1 minute/)
  assert.match(queueSpoken([]), /nothing in your pendant queue/)
})

test('failing to render one meeting does not cost the owner the others', () => {
  let calls = 0
  const result = commitQueue(
    planQueue({
      items: [item({ meetingKey: 'a', title: 'A' }), item({ meetingKey: 'b', title: 'B' })],
      existing: [],
      now: NOW,
    }),
    {
      existing: [],
      now: NOW,
      render: () => {
        calls += 1
        if (calls === 1) throw new Error('say failed')
        return { wavPath: '/tmp/b.wav', opusPath: '/tmp/b.opus', seconds: 30, pcmBytes: 1, opusBytes: 1, truncated: false }
      },
      save: (entry) => ({ id: 'brf_b', ...entry }),
      remove: () => true,
    },
  )

  assert.equal(result.rendered.length, 1)
  assert.equal(result.problems.length, 1)
})
