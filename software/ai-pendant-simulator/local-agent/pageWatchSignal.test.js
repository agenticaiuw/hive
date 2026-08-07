import assert from 'node:assert/strict'
import test from 'node:test'

import {
  churnVerdict,
  diffSegmentSets,
  differingTokens,
  digestSegments,
  fieldChurn,
  filterSegmentNoise,
  isClockLike,
  isTokenLike,
  numericOf,
  onlyNoiseMoved,
  scoreChange,
  scoreSegmentChange,
  shapeOf,
} from './pageWatchSignal.js'

/* ------------------------------------------------------------------ shapes */

test('a value that carries a time of day is clock-shaped', () => {
  for (const value of [
    'Updated 14:32:07',
    '2 minutes ago',
    'just now',
    '5m ago',
    'in 3 hours',
    '2026-08-07T14:32:11Z',
    '1754582400',
  ]) {
    assert.equal(isClockLike(value), true, `${value} should read as a clock`)
  }
})

test('a calendar date with no clock in it is not treated as a clock', () => {
  /* The distinction the whole noise filter rests on: nothing about a page
   * re-rendering moves a delivery date, so when one moves it is news. An
   * earlier cut called every date a timestamp and would have swallowed a
   * delivery slipping by a day. */
  for (const value of ['Friday', 'Arrives Aug 12', 'Delivery Wednesday', 'Shipped', '$129.99']) {
    assert.equal(isClockLike(value), false, `${value} should not read as a clock`)
  }
})

test('a nonce is recognised by the absence of language, and an order number is not', () => {
  assert.equal(isTokenLike('a3f9c21e77bd4410'), true)
  assert.equal(isTokenLike('c2h8Kx9Lm4Qp7Rt3Vw'), true)
  /* Short codes are exactly what the owner wants to hear about — a tracking
   * number appearing is one of the changes this feature exists to catch. */
  assert.equal(isTokenLike('1Z999AA10123456784'.slice(0, 10)), false)
  assert.equal(isTokenLike('Processing'), false)
  assert.equal(isTokenLike('Order 42 shipped'), false)
})

test('a value that is essentially one number reads as a number', () => {
  assert.equal(numericOf('$1,299.00'), 1299)
  assert.equal(numericOf('42%'), 42)
  assert.equal(numericOf('Arrives in 3 days'), null)
  assert.equal(shapeOf('$1,299.00'), 'number')
  assert.equal(shapeOf(''), 'empty')
  assert.equal(shapeOf('Shipped'), 'text')
})

/* -------------------------------------------------------- what differs */

test('the comparison is over the tokens that moved, not the whole value', () => {
  assert.deepEqual(
    differingTokens('Status: Processing', 'Status: Shipped').sort(),
    ['Processing', 'Shipped'],
  )
})

test('a four-thousand character page whose only difference is a clock is silent', () => {
  const filler = 'Your order is being prepared for dispatch. '.repeat(90)
  assert.equal(
    onlyNoiseMoved(`${filler} Last updated 14:32:07`, `${filler} Last updated 14:41:52`),
    true,
  )
})

test('a nine character value moving is not silent', () => {
  assert.equal(onlyNoiseMoved('Delayed', 'Shipped'), false)
})

test('whitespace reflow alone is not a change', () => {
  assert.equal(onlyNoiseMoved('Status:   Shipped', 'Status: Shipped'), true)
})

/* ---------------------------------------------------------------- churn */

test('churn is measured over prior comparisons only', () => {
  assert.deepEqual(fieldChurn(['a', 'a', 'a', 'a']), {
    samples: 3,
    changes: 0,
    rate: 0,
    distinct: 1,
  })
  assert.equal(fieldChurn(['a', 'b', 'c', 'd', 'e']).rate, 1)
  assert.equal(fieldChurn([]).rate, null)
})

test('churn says nothing until there is enough of it', () => {
  /* Two samples make a field that changed once look like a coin flip, and the
   * first real status change on a new watch would be suppressed by a statistic
   * computed from nothing. */
  assert.equal(churnVerdict(fieldChurn(['a', 'b'])).delta, 0)
  assert.match(churnVerdict(fieldChurn(['a', 'b'])).reason, /not enough history/)
})

/* -------------------------------------------------------------- scoring */

test('a clock moving is suppressed on shape alone, before any history exists', () => {
  const verdict = scoreChange({
    before: 'Updated 14:32:07',
    after: 'Updated 14:41:52',
  })
  assert.equal(verdict.meaningful, false)
  assert.match(verdict.reasons.join(' '), /only a timestamp or an opaque token moved/)
})

test('a status word moving is reported on shape alone, before any history exists', () => {
  const verdict = scoreChange({ before: 'Processing', after: 'Shipped' })
  assert.equal(verdict.meaningful, true)
  assert.equal(verdict.score, 1)
})

test("a field's own stability overrules the shape prior", () => {
  /* A delivery window is time-shaped and moving it is real news. The only
   * thing that separates it from a "last updated" line is behaviour: a clock
   * moves every time you look, a delivery window sits still for days. */
  const stable = ['9:00 AM - 5:00 PM', '9:00 AM - 5:00 PM', '9:00 AM - 5:00 PM', '9:00 AM - 5:00 PM', '9:00 AM - 5:00 PM']
  const verdict = scoreChange({
    before: '9:00 AM - 5:00 PM',
    after: '10:00 AM - 6:00 PM',
    history: stable,
  })
  assert.equal(verdict.meaningful, true)
  assert.match(verdict.reasons.join(' '), /has been stable/)
})

test('a field that moves on nearly every check is suppressed whatever it contains', () => {
  const verdict = scoreChange({
    before: 'Seventeen people are viewing this',
    after: 'Twenty two people are viewing this',
    history: ['one', 'two', 'three', 'four', 'five'],
  })
  assert.equal(verdict.meaningful, false)
  assert.match(verdict.reasons.join(' '), /changed on 4 of the last 4 checks/)
})

test('a value the field already held recently is cycling, not changing', () => {
  const verdict = scoreChange({
    before: 'A',
    after: 'B',
    history: ['A', 'B', 'A', 'B', 'A'],
  })
  assert.equal(verdict.meaningful, false)
  assert.match(verdict.reasons.join(' '), /cycling rather than changing/)
})

test('a value disappearing is reported however noisy the field has been', () => {
  /* An appointment vanishing off an appointments page is the most important
   * thing this can notice, and it is one where the page says nothing at all. */
  const verdict = scoreChange({
    before: '$129.99',
    after: null,
    history: ['a', 'b', 'c', 'd', 'e'],
  })
  assert.equal(verdict.meaningful, true)
  assert.equal(verdict.structural, true)
  assert.match(verdict.reasons.join(' '), /no longer on the page/)
})

test('a selector that stops matching is reported as the page changing shape', () => {
  const verdict = scoreChange({ before: null, after: 'Shipped' })
  assert.equal(verdict.meaningful, true)
  assert.equal(verdict.structural, true)
})

test('a numeric threshold suppresses a move under the bar', () => {
  const verdict = scoreChange({
    before: '$100.00',
    after: '$100.40',
    minPercent: 1,
  })
  assert.equal(verdict.meaningful, false)
  assert.match(verdict.reasons.join(' '), /under the threshold you set/)
})

test('a threshold is measured from the last value the owner was told, so drift cannot creep past it', () => {
  /*
   * The failure this exists for: a price moving 0.4% per poll never trips a 1%
   * bar on any single step, so measuring each step against the previous
   * reading means the owner is never told, having asked to be told.
   */
  const stepwise = scoreChange({ before: '100.80', after: '101.20', minPercent: 1 })
  assert.equal(stepwise.meaningful, false, 'each single step really is under the bar')

  const fromAnchor = scoreChange({
    before: '100.80',
    after: '101.20',
    anchor: '100.00',
    minPercent: 1,
  })
  assert.equal(fromAnchor.meaningful, true, 'the move since the owner was last told is over it')
  assert.match(fromAnchor.reasons.join(' '), /over the threshold you set/)
})

test('a threshold the owner did not set does not suppress anything', () => {
  assert.equal(scoreChange({ before: '$100.00', after: '$100.40' }).meaningful, true)
})

/* ------------------------------------------------------------- segments */

const ORDER_PAGE = [
  'Order #42',
  'Status: Processing',
  'Last updated 14:32:07',
  'Estimated delivery Friday',
].join('\n')

test('an edited line is reported as one change, with its before and after', () => {
  const after = ORDER_PAGE.replace('Processing', 'Shipped').replace('14:32:07', '14:41:52')
  const diff = diffSegmentSets(digestSegments(ORDER_PAGE), after)

  assert.equal(diff.edits.length, 2, 'both edited lines pair up rather than showing as four events')
  const filtered = filterSegmentNoise(diff)
  assert.equal(filtered.edits.length, 1)
  assert.deepEqual(
    [filtered.edits[0].before, filtered.edits[0].after],
    ['Status: Processing', 'Status: Shipped'],
  )
  assert.equal(filtered.noisy.length, 1, 'the timestamp line was ignored')
})

test('a page where only the clock moved produces no report at all', () => {
  /* This is what makes a whole-page watch possible. Nearly every page renders
   * a timestamp somewhere, so without it every poll of every page is a change
   * and the feature is a notification the owner turns off. */
  const after = ORDER_PAGE.replace('14:32:07', '14:41:52')
  const filtered = filterSegmentNoise(diffSegmentSets(digestSegments(ORDER_PAGE), after))
  const verdict = scoreSegmentChange(filtered)

  assert.equal(verdict.moved, 0)
  assert.equal(verdict.meaningful, false)
  assert.equal(verdict.suppressed, 1)
  assert.match(verdict.reasons.join(' '), /all of them timestamps or opaque tokens/)
})

test('a line appearing is news; a line of clock appearing is not', () => {
  const withNews = `${ORDER_PAGE}\nYour appointment was cancelled`
  const news = filterSegmentNoise(diffSegmentSets(digestSegments(ORDER_PAGE), withNews))
  assert.deepEqual(news.added, ['Your appointment was cancelled'])
  assert.equal(scoreSegmentChange(news).meaningful, true)

  const withClock = `${ORDER_PAGE}\n14:41:52`
  const clock = filterSegmentNoise(diffSegmentSets(digestSegments(ORDER_PAGE), withClock))
  assert.deepEqual(clock.added, [])
  assert.equal(scoreSegmentChange(clock).meaningful, false)
})

test('a page whose real text differs every poll is a feed, not a watch', () => {
  const after = `${ORDER_PAGE}\nA genuinely different sentence`
  const filtered = filterSegmentNoise(diffSegmentSets(digestSegments(ORDER_PAGE), after))
  const verdict = scoreSegmentChange(filtered, {
    history: ['h1', 'h2', 'h3', 'h4', 'h5'],
  })
  assert.equal(verdict.meaningful, false)
  assert.match(verdict.reasons.join(' '), /changed on 4 of the last 4 checks/)
})

test('the stored baseline is hashes and excerpts, not the page', () => {
  /* These are pages behind the owner's login and the watch store is a plain
   * file. Keeping only enough to detect and describe a change is the smaller
   * thing to keep. */
  const digested = digestSegments(ORDER_PAGE)
  assert.equal(digested.length, 4)
  for (const entry of digested) {
    assert.match(entry.h, /^[0-9a-f]{16}$/)
    assert.ok(entry.t.length <= 160)
  }
})
