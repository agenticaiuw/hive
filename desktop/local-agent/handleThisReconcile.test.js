import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONFLICT,
  CORROBORATION,
  VERDICT,
  admitReading,
  corroborationOf,
  groupSightings,
  looseAnswer,
  normalizeAnswer,
  reconcile,
  reconcileAll,
  settledValues,
} from './handleThisReconcile.js'

/* A reading with everything the reconciler needs and nothing it does not. */
const reading = (overrides = {}) => ({
  inspector: 'main-text',
  questionKey: 'order.total',
  answer: '$41.98',
  capsuleId: 'cap_a',
  contentHash: 'sha256:aaa',
  capsuleState: 'live',
  sourceKey: 'shop.example.com/orders/1',
  regionKey: 'main_text|',
  observedAt: '2026-08-07T10:00:00.000Z',
  confidence: { score: 1, reasons: [] },
  error: null,
  ...overrides,
})

/* ------------------------------------------------------------------ answers */

test('answers differing only in formatting are one answer, not a conflict', () => {
  assert.equal(looseAnswer('$41.98'), looseAnswer('41.98'))
  assert.equal(normalizeAnswer('  $41.98 .'), '$41.98')
  assert.equal(normalizeAnswer(''), null)
})

test('a case-only difference is agreement, and both spellings are still shown', () => {
  /* One lens reads a heading, another reads the same words through a CSS
   * uppercase transform. That is one page agreeing with itself, and calling it
   * a conflict would spend the owner's attention where there is nothing wrong. */
  assert.equal(looseAnswer('AB12'), looseAnswer('ab12'))

  const verdict = reconcile({
    questionKey: 'order.id',
    readings: [
      reading({ questionKey: 'order.id', answer: 'AB12' }),
      reading({
        questionKey: 'order.id',
        inspector: 'landmarks',
        answer: 'ab12',
        contentHash: 'sha256:bbb',
        capsuleId: 'cap_b',
      }),
    ],
  })

  assert.equal(verdict.status, VERDICT.agreed)
  assert.deepEqual(verdict.spellings, ['AB12', 'ab12'], 'the difference is reported, just not as a conflict')
})

/* ------------------------------------------------------------ admissibility */

test('a revoked capsule takes its reading out of the answer', () => {
  const check = admitReading(reading({ capsuleState: 'revoked' }))
  assert.equal(check.admitted, false)
  assert.match(check.reason, /revoked/)
})

test('a reading with no capsule at all is still admitted, only unprovable', () => {
  /* An older extension mints nothing. Throwing the reading away would lose a
   * real observation; the honest cost is paid later, in corroboration. */
  const check = admitReading(reading({ capsuleId: null, contentHash: null, capsuleState: null }))
  assert.equal(check.admitted, true)
})

test('one redirect is a caveat, but two failures sink the reading', () => {
  assert.equal(admitReading(reading({ confidence: { score: 0.65, reasons: [] } })).admitted, true)
  assert.equal(admitReading(reading({ confidence: { score: 0.25, reasons: [] } })).admitted, false)
})

/* -------------------------------------------------------------- corroboration */

test('agreement across different bytes is independent corroboration', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading(),
      reading({ inspector: 'full-text', capsuleId: 'cap_b', contentHash: 'sha256:bbb', regionKey: 'text|' }),
    ],
  })

  assert.equal(verdict.status, VERDICT.agreed)
  assert.equal(verdict.answer, '$41.98')
  assert.equal(verdict.corroboration, CORROBORATION.independent)
  assert.equal(verdict.distinctEvidence, 2)
})

test('three inspectors on one set of bytes are one observation, and the narrative says so', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ inspector: 'main-text' }),
      reading({ inspector: 'full-text' }),
      reading({ inspector: 'landmarks' }),
    ],
  })

  assert.equal(verdict.status, VERDICT.agreed)
  assert.equal(verdict.corroboration, CORROBORATION.sameSource)
  /* The count that matters is 1, even though three inspectors reported. */
  assert.equal(verdict.distinctEvidence, 1)
  assert.equal(verdict.answering, 3)
  assert.match(verdict.narrative, /one observation with several names on it/)
})

test('readings that cannot prove which bytes they saw never count as confirmation', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ capsuleId: null, contentHash: null, capsuleState: null }),
      reading({ inspector: 'full-text', capsuleId: null, contentHash: null, capsuleState: null }),
    ],
  })

  assert.equal(verdict.status, VERDICT.agreed)
  assert.equal(verdict.corroboration, CORROBORATION.unverified)
  assert.equal(verdict.distinctEvidence, 0)
})

test('a bridge-deduplicated reading is pinned to the reading it duplicated', () => {
  /*
   * Two enqueues sharing an idempotency key are ONE browser command. Without
   * the pin these two would look like two observations agreeing, which is the
   * cheapest possible way to fake corroboration.
   */
  const sightings = groupSightings([
    reading({ inspector: 'main-text', contentHash: null, capsuleId: null }),
    reading({
      inspector: 'full-text',
      contentHash: null,
      capsuleId: null,
      deduplicated: true,
      sharedWith: ['main-text'],
    }),
  ])

  assert.equal(sightings.length, 1, 'one fetch is one sighting no matter how many callers asked')
  assert.deepEqual(sightings[0].inspectors, ['main-text', 'full-text'])
  assert.equal(corroborationOf(sightings), CORROBORATION.none)
})

/* ------------------------------------------------------------------ conflicts */

test('identical bytes with different answers is an interpretation conflict and is refused', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ inspector: 'main-text', answer: '$41.98' }),
      reading({ inspector: 'full-text', answer: '$52.10' }),
    ],
  })

  assert.equal(verdict.status, VERDICT.disputed)
  assert.equal(verdict.answer, null, 'a disputed question has no answer, not a hedged one')
  assert.equal(verdict.conflict.kind, CONFLICT.interpretation)
  assert.equal(verdict.conflict.resolvable, false)
  assert.match(verdict.conflict.why, /Re-reading it will not settle this/)
  assert.equal(verdict.conflict.sides.length, 2)
})

test('two different pages disagreeing is not a disagreement to settle', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ sourceKey: 'shop.example.com/orders/1' }),
      reading({
        inspector: 'full-text',
        answer: '$52.10',
        contentHash: 'sha256:bbb',
        capsuleId: 'cap_b',
        sourceKey: 'bank.example.com/activity',
      }),
    ],
  })

  assert.equal(verdict.status, VERDICT.disputed)
  assert.equal(verdict.conflict.kind, CONFLICT.page)
  assert.match(verdict.conflict.why, /right about its own page/)
})

test('two lenses reading different parts of one page is a region conflict', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ inspector: 'main-text', regionKey: 'main_text|', answer: '$41.98' }),
      reading({
        inspector: 'full-text',
        regionKey: 'text|',
        answer: '$52.10',
        contentHash: 'sha256:bbb',
        capsuleId: 'cap_b',
      }),
    ],
  })

  assert.equal(verdict.conflict.kind, CONFLICT.region)
  assert.match(verdict.conflict.why, /both can be accurate reports of what they looked at/)
})

test('the same lens on the same page at two times is reported in order, not resolved', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ answer: '$41.98', observedAt: '2026-08-07T10:00:00.000Z' }),
      reading({
        inspector: 'main-text-again',
        answer: '$52.10',
        contentHash: 'sha256:bbb',
        capsuleId: 'cap_b',
        observedAt: '2026-08-07T10:05:00.000Z',
      }),
    ],
  })

  assert.equal(verdict.conflict.kind, CONFLICT.revision)
  assert.equal(verdict.status, VERDICT.disputed)
  assert.equal(verdict.answer, null, 'the later reading is later, which is not the same as right')
  assert.equal(verdict.conflict.latest, '$52.10')
  assert.deepEqual(
    verdict.conflict.chronological.map((side) => side.answer),
    ['$41.98', '$52.10'],
  )
  assert.match(verdict.narrative, /Reporting both rather than picking the later one/)
})

/* ------------------------------------------------------- the vote-stuffing guard */

test('a majority built from one page does not outvote a single reading of another', () => {
  /*
   * THE case this module exists for. Three inspectors read one cached page and
   * say "$41.98"; one inspector reads a different page and says "$52.10". By
   * head count that is 3–1 and a blending system answers "$41.98". By evidence
   * it is 1–1, because the three share every byte and are wrong together
   * whenever those bytes are wrong.
   */
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ inspector: 'main-text', answer: '$41.98' }),
      reading({ inspector: 'full-text', answer: '$41.98' }),
      reading({ inspector: 'landmarks', answer: '$41.98' }),
      reading({
        inspector: 'sibling-tab',
        answer: '$52.10',
        contentHash: 'sha256:bbb',
        capsuleId: 'cap_b',
        sourceKey: 'shop.example.com/orders/1',
        regionKey: 'main_text|',
        observedAt: '2026-08-07T10:00:10.000Z',
      }),
    ],
  })

  assert.equal(verdict.status, VERDICT.disputed)
  assert.equal(verdict.answer, null)

  const sides = verdict.conflict.sides
  const majority = sides.find((side) => side.answer === '$41.98')
  const dissent = sides.find((side) => side.answer === '$52.10')

  assert.equal(majority.inspectors.length, 3, 'three inspectors did say it')
  assert.equal(majority.evidenceCount, 1, 'but they stand on one piece of evidence')
  assert.equal(dissent.evidenceCount, 1, 'so the tally is one to one')
})

/* ----------------------------------------------------------------- silence */

test('a reading that found nothing is silence, never a vote against', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ answer: '$41.98' }),
      reading({ inspector: 'landmarks', answer: null, miss: 'headings only' }),
    ],
  })

  assert.equal(verdict.status, VERDICT.single)
  assert.equal(verdict.answer, '$41.98')
  assert.equal(verdict.silent.length, 1)
  assert.equal(verdict.conflict, null)
  assert.match(verdict.narrative, /nothing checked it/)
})

test('when every reading is inadmissible the question is unanswered, not answered anyway', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ capsuleState: 'revoked' }),
      reading({ inspector: 'full-text', error: 'the tab went away' }),
    ],
  })

  assert.equal(verdict.status, VERDICT.unanswered)
  assert.equal(verdict.answer, null)
  assert.equal(verdict.inadmissible.length, 2)
})

test('the same value written two ways agrees, and the spellings are kept', () => {
  const verdict = reconcile({
    questionKey: 'order.total',
    readings: [
      reading({ answer: '$41.98' }),
      reading({
        inspector: 'form-fields',
        answer: '41.98',
        contentHash: 'sha256:bbb',
        capsuleId: 'cap_b',
      }),
    ],
  })

  assert.equal(verdict.status, VERDICT.agreed)
  assert.deepEqual(verdict.spellings, ['$41.98', '41.98'])
})

/* ------------------------------------------------------------------ batching */

test('settled values exclude every disputed key and say why it was held back', () => {
  const { verdicts } = reconcileAll({
    questions: [
      { key: 'order.total', prompt: 'the order total' },
      { key: 'order.id', prompt: 'the order number' },
    ],
    readings: [
      reading({ questionKey: 'order.total', answer: '$41.98' }),
      reading({
        questionKey: 'order.total',
        inspector: 'full-text',
        answer: '$52.10',
        contentHash: 'sha256:bbb',
        capsuleId: 'cap_b',
        regionKey: 'text|',
      }),
      reading({ questionKey: 'order.id', answer: 'A-771' }),
    ],
  })

  const { values, withheld } = settledValues(verdicts)

  assert.equal(values['order.id'], 'A-771')
  assert.ok(!Object.hasOwn(values, 'order.total'), 'a disputed value is absent, not present-with-a-warning')
  assert.equal(withheld[0].key, 'order.total')
  assert.match(withheld[0].why, /different parts of it/)
})

test('an investigation reports settled=false while anything is in dispute', () => {
  const outcome = reconcileAll({
    questions: [{ key: 'order.total' }],
    readings: [
      reading({ answer: '$41.98' }),
      reading({ inspector: 'full-text', answer: '$52.10' }),
    ],
  })

  assert.equal(outcome.settled, false)
  assert.deepEqual(outcome.disputed, ['order.total'])
  assert.deepEqual(outcome.agreed, [])
})
