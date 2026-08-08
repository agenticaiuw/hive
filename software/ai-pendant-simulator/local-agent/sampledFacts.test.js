import assert from 'node:assert/strict'
import test from 'node:test'

import './testWorkspace.js'
import {
  checkSample,
  needsRecheck,
  provenanceSuffix,
  reviewSampledFacts,
} from './sampledFacts.js'

const NOW = Date.parse('2026-08-08T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

const sampled = (overrides = {}) => ({
  key: 'preference.timezone',
  kind: 'preference',
  value: 'America/Chicago',
  confidence: 0.99,
  expiresAt: null,
  source: { origin: 'machine', at: new Date(NOW - 30 * DAY).toISOString() },
  ...overrides,
})

const chosen = (overrides = {}) => ({
  key: 'preference.editor',
  kind: 'preference',
  value: 'VS Code',
  confidence: 0.9,
  expiresAt: null,
  source: { origin: 'owner', at: new Date(NOW - 30 * DAY).toISOString() },
  ...overrides,
})

test('a stated choice is never annotated, re-read, or disputed', () => {
  /*
   * The whole mechanism must be invisible to facts the owner actually stated.
   * An editor preference does not go stale because nobody read it, and telling
   * a model where it came from would spend tokens saying "the owner said so"
   * about something already shaped like the owner saying so.
   */
  assert.equal(provenanceSuffix(chosen()), '')
  assert.equal(needsRecheck(chosen(), { now: NOW }), false)
  assert.equal(checkSample(chosen(), { observe: () => 'Vim', now: NOW }).status, 'not-sampled')
})

test('a sampled value says so in the prompt', () => {
  assert.equal(provenanceSuffix(sampled()), ' (sampled from this Mac, not stated by you)')
})

test('a disputed fact renders BOTH readings and settles nothing', () => {
  /*
   * Rendering one value is a decision. The owner may still want the stored one
   * — a laptop in a hotel reports the hotel's zone — so both ride, labelled.
   */
  const fact = sampled({
    dispute: { observed: 'America/New_York', sampledAt: '2026-07-09T00:00:00.000Z' },
  })
  const suffix = provenanceSuffix(fact)

  assert.match(suffix, /America\/New_York/, 'the fresh reading must appear')
  assert.match(suffix, /unresolved/)
  assert.match(suffix, /not stated by you/)
  assert.equal(fact.value, 'America/Chicago', 'the stored value is never replaced')
})

test('staleness marks a sample for re-reading and never deletes it', () => {
  assert.equal(needsRecheck(sampled(), { now: NOW }), true, '30 days old is due')
  assert.equal(
    needsRecheck(sampled({ source: { origin: 'machine', at: new Date(NOW - DAY).toISOString() } }), {
      now: NOW,
    }),
    false,
    'a day old is not',
  )
  /* An unrecorded sampling date is not evidence of freshness. */
  assert.equal(needsRecheck(sampled({ source: { origin: 'machine' } }), { now: NOW }), true)
})

test('an unreadable host produces no dispute', () => {
  /*
   * The failure mode to avoid: manufacturing disagreements during an outage and
   * telling the owner their settings are wrong because a probe threw.
   */
  assert.equal(checkSample(sampled(), { observe: () => '', now: NOW }).status, 'unknown')
  assert.equal(
    checkSample(sampled(), {
      observe: () => {
        throw new Error('no host')
      },
      now: NOW,
    }).status,
    'unknown',
  )
})

test('a fact that does not record how it was sampled reports unverifiable, not trusted', () => {
  /*
   * Every machine-origin fact in the live store is this shape — origin and a
   * timestamp, nothing about the probe. "Unverifiable" is the honest verdict
   * and more useful than silently trusting it, because it names what is
   * missing. There is deliberately no table here mapping preference.timezone to
   * a timezone probe: that is a per-fact special case wearing a mechanism's
   * clothes, and the next sampled key would need another one.
   */
  const review = reviewSampledFacts({ facts: [sampled()], probes: {}, now: NOW })

  assert.equal(review.counts.unverifiable, 1)
  assert.equal(review.counts.disputed, 0)
  assert.match(review.reviewed[0].why, /does not record how it was sampled/)
})

test('a named probe is resolved, and disagreement is reported without being settled', () => {
  const fact = sampled({
    source: {
      origin: 'machine',
      at: new Date(NOW - 30 * DAY).toISOString(),
      probe: 'host.timezone',
    },
  })
  const review = reviewSampledFacts({
    facts: [fact, chosen()],
    probes: { 'host.timezone': () => 'America/New_York' },
    now: NOW,
  })

  assert.equal(review.counts.total, 1, 'owner-origin facts are not reviewed at all')
  assert.equal(review.counts.disputed, 1)
  assert.equal(review.reviewed[0].observed, 'America/New_York')
  assert.equal(review.reviewed[0].value, 'America/Chicago', 'the stored value is untouched')
  assert.match(review.note, /owner/, 'the report says who decides')
})

test('agreement is reported as agreement rather than silence', () => {
  const fact = sampled({
    value: 'America/New_York',
    source: { origin: 'machine', at: new Date(NOW - DAY).toISOString(), probe: 'host.timezone' },
  })
  const review = reviewSampledFacts({
    facts: [fact],
    probes: { 'host.timezone': () => 'America/New_York' },
    now: NOW,
  })

  assert.equal(review.reviewed[0].status, 'agrees')
  assert.equal(review.counts.disputed, 0)
})
