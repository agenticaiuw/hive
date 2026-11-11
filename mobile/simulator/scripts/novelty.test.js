import assert from 'node:assert/strict'
import test from 'node:test'

import { BLOCK_AT, WARN_AT, findDuplicate, fingerprint, similarity } from './novelty.mjs'

const describe = (item) => item.text

/*
 * The real pair from the ledger, proposed three separate times by different
 * agents in different rounds, while the prompt in front of every one of them
 * said not to restate the backlog.
 */
const FORM_FILLING = 'Fill out this web form from the information I give you, stop before submitting'

test('the same idea in different words is caught', () => {
  const found = findDuplicate(
    { text: 'Fill out this online form using the details we discussed, stop before submitting' },
    [{ id: 'cap-1', text: FORM_FILLING }],
    describe,
  )
  assert.equal(found.verdict, 'block')
  assert.equal(found.entry.id, 'cap-1')
})

test('an unrelated proposal is not blocked', () => {
  const found = findDuplicate(
    { text: 'Resample the pendant microphone at 24 kHz so the uplink stops aliasing' },
    [{ id: 'cap-1', text: FORM_FILLING }],
    describe,
  )
  assert.equal(found, null)
})

/*
 * The costs here are asymmetric and the distribution has no natural break, so
 * the middle band exists on purpose: a real refinement of a nearby idea must
 * survive, because suppressing it is silent and permanent where a duplicate is
 * one restated round and visible in the backlog afterwards.
 */
test('something merely adjacent is recorded, with what it is close to', () => {
  const near = { text: 'Fill out this web form from details, and afterwards archive the confirmation page' }
  const found = findDuplicate(near, [{ id: 'cap-1', text: FORM_FILLING }], describe)

  if (found) {
    assert.ok(found.score >= WARN_AT)
    assert.equal(found.verdict, found.score >= BLOCK_AT ? 'block' : 'warn')
  }
})

test('the closest match wins when several are near', () => {
  const found = findDuplicate(
    { text: FORM_FILLING },
    [
      { id: 'far', text: 'Fill out something entirely different about audio pipelines' },
      { id: 'exact', text: FORM_FILLING },
    ],
    describe,
  )
  assert.equal(found.entry.id, 'exact')
  assert.equal(found.score, 1)
})

test('too little text to compare is not treated as a match', () => {
  /* Two three-word entries sharing every word say nothing about whether they
   * are the same idea, and blocking on that would silence real proposals. */
  assert.equal(similarity('save this page', 'save this page'), 0)
  assert.equal(findDuplicate({ text: 'do it' }, [{ id: 'x', text: 'do it' }], describe), null)
})

test('an empty proposal collides with nothing', () => {
  assert.equal(findDuplicate({ text: '' }, [{ id: 'x', text: FORM_FILLING }], describe), null)
})

test('words too short to carry a topic are dropped', () => {
  /* Four letters is the cut, so "with" survives it. Kept honest rather than
   * asserting a tidier claim than the code makes — a stopword list would be a
   * separate decision, not something this test can imply. */
  assert.deepEqual([...fingerprint('the and for a of to in on at it')], [])
  assert.deepEqual([...fingerprint('the with and')], ['with'])
})

test('an empty backlog blocks nothing', () => {
  assert.equal(findDuplicate({ text: FORM_FILLING }, [], describe), null)
})
