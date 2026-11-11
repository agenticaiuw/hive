import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSUMED_SKEW_MS,
  causalAnchor,
  compareInstants,
  describeSkew,
  instantOf,
  measureSkew,
  orderByCausality,
  projectInstant,
  windowMembership,
} from './catchupClock.js'

const T = Date.parse('2026-08-07T12:00:00.000Z')
const at = (offsetMs) => new Date(T + offsetMs).toISOString()

const mac = (offsetMs) => instantOf({ domain: 'mac', at: at(offsetMs) })
const relay = (offsetMs) => instantOf({ domain: 'relay', at: at(offsetMs) })

const node = (id, moment, causedBy = [], aliases = []) => ({ id, at: moment, causedBy, aliases })

/*
 * The round trip, which is the only measurement this system can actually make.
 *
 * Nothing on the wire carries a clock protocol, and adding one would mean
 * changing shipped firmware and a Worker. What IS available is that the relay
 * stamps `observedAt` on every response, so a request bracketed by two local
 * readings is an NTP round trip by another name — and the bracket it produces
 * has to be tight enough to be worth having, or the whole exercise is theatre.
 */
test('a request round trip brackets the relay clock to within the round-trip time', () => {
  /* The relay is genuinely 40s ahead; the request took 200ms each way. */
  const requestedAt = T
  const observedAt = T + 40_200
  const receivedAt = T + 400

  const skew = measureSkew([
    causalAnchor({
      before: { domain: 'mac', at: requestedAt },
      after: { domain: 'relay', at: observedAt },
      why: 'sent before it was stamped',
    }),
    causalAnchor({
      before: { domain: 'relay', at: observedAt },
      after: { domain: 'mac', at: receivedAt },
      why: 'stamped before it arrived',
    }),
  ])

  assert.equal(skew.domains.relay.source, 'measured')
  assert.ok(skew.domains.relay.lo <= 40_000 && skew.domains.relay.hi >= 40_000)
  /* The bracket is the round trip, not the assumption — three orders of
   * magnitude tighter, and the whole reason to bother measuring. */
  assert.equal(skew.domains.relay.hi - skew.domains.relay.lo, receivedAt - requestedAt)
  assert.ok(skew.domains.relay.hi - skew.domains.relay.lo < ASSUMED_SKEW_MS)
})

/*
 * An unmeasured clock is not a synchronized clock. The fallback is used, and
 * the output says which one it is — a reader must be able to tell a measured
 * bound from a borrowed one.
 */
test('with nothing to measure against, the fallback is used and named as one', () => {
  const skew = measureSkew([])

  assert.equal(skew.domains.relay.source, 'assumed')
  assert.equal(skew.domains.relay.hi, ASSUMED_SKEW_MS)
  assert.equal(skew.domains.mac.source, 'reference')
  const described = describeSkew(skew).find((entry) => entry.domain === 'relay')
  assert.equal(described.measured, false)
  assert.match(described.note, /was not measured/)
})

test('the reference clock compares exactly against itself', () => {
  const skew = measureSkew([])
  assert.equal(compareInstants(mac(0), mac(1000), skew).relation, 'before')
  assert.equal(compareInstants(mac(1000), mac(0), skew).relation, 'after')
})

/*
 * THE REFUSAL THAT MATTERS MOST. Two events a few seconds apart on two
 * different machines cannot be ordered by clocks that were never synchronized,
 * and saying "then" about them is a lie the owner would build a mental model
 * on. The right answer is to say so.
 */
test('two clocks that were never synchronized cannot order events seconds apart', () => {
  const skew = measureSkew([])
  const verdict = compareInstants(mac(0), relay(5_000), skew)

  assert.equal(verdict.relation, 'unknown')
  assert.match(verdict.why, /uncertainty windows overlap/)
})

/* ...but the refusal is not blanket. Far enough apart and the intervals are
 * disjoint whatever the offset is, and then the order IS knowable. */
test('the same two clocks do order events that are far enough apart', () => {
  const skew = measureSkew([])
  const verdict = compareInstants(mac(0), relay(ASSUMED_SKEW_MS * 2), skew)

  assert.equal(verdict.relation, 'before')
})

/* A measurement earns back the order the assumption had to refuse. */
test('measuring the offset makes a comparison possible that was not before', () => {
  const anchors = [
    causalAnchor({
      before: { domain: 'mac', at: T },
      after: { domain: 'relay', at: T + 100 },
      why: 'sent before stamped',
    }),
    causalAnchor({
      before: { domain: 'relay', at: T + 100 },
      after: { domain: 'mac', at: T + 150 },
      why: 'stamped before received',
    }),
  ]

  assert.equal(compareInstants(mac(0), relay(5_000), measureSkew([])).relation, 'unknown')
  assert.equal(compareInstants(mac(0), relay(5_000), measureSkew(anchors)).relation, 'before')
})

/*
 * The pendant's clock, which no measurement can repair.
 *
 * pendant_store.h stamps a bookmark from "modem NITZ clock when the tower ever
 * gave us one, uptime otherwise". An uptime reading is a duration since an
 * unknown boot, and 240000 as an epoch time is January 1970. Placing it on a
 * timeline at all would put every offline press before every other event in
 * the digest.
 */
test('an uptime stamp is refused a position rather than mistaken for an epoch time', () => {
  const skew = measureSkew([])
  const moment = instantOf({ domain: 'pendant', at: 240_000, quality: 'uptime' })
  const placed = projectInstant(moment, skew)

  assert.equal(placed.positionKnown, false)
  assert.match(placed.reason, /uptime/)
  assert.equal(moment.iso, null, 'and it is never rendered as a wall-clock time')
  assert.equal(compareInstants(moment, mac(0), skew).relation, 'unknown')
})

/* An uptime stamp also may not be used to measure anything: subtracting it
 * from a wall reading yields a number with no meaning, and a bound built from
 * one would be worse than no bound because it would look authoritative. */
test('an uptime stamp is refused as a measurement anchor and the refusal is counted', () => {
  const skew = measureSkew([
    causalAnchor({
      before: { domain: 'pendant', at: 240_000, quality: 'uptime' },
      after: { domain: 'mac', at: T },
      why: 'the press was before the forward',
    }),
  ])

  assert.equal(skew.usableAnchors, 0)
  assert.equal(skew.unusableAnchors, 1)
  assert.equal(skew.domains.pendant.source, 'assumed')
})

/* Chaining relay↔pendant through no common reference would widen the bound at
 * every hop while still looking like a measurement. It is refused and counted
 * rather than attempted. */
test('an anchor between two non-reference clocks is refused rather than chained', () => {
  const skew = measureSkew([
    causalAnchor({
      before: { domain: 'pendant', at: T },
      after: { domain: 'relay', at: T + 5 },
      why: 'forwarded after it was pressed',
    }),
  ])

  assert.equal(skew.unusableAnchors, 1)
  assert.equal(skew.domains.relay.source, 'assumed')
})

/*
 * When the legs disagree, at least one "cause" is not one — or a clock stepped
 * mid-gap. An empty interval would make every comparison vacuously definite,
 * which is the worst possible failure: maximum confidence from broken data.
 */
test('contradictory legs void the bracket instead of producing an empty one', () => {
  const skew = measureSkew([
    causalAnchor({
      before: { domain: 'mac', at: T },
      after: { domain: 'relay', at: T - 10_000 },
      why: 'claims the relay stamped it before we sent it',
    }),
    causalAnchor({
      before: { domain: 'relay', at: T + 10_000 },
      after: { domain: 'mac', at: T },
      why: 'claims we received it before the relay stamped it',
    }),
  ])

  assert.equal(skew.domains.relay.source, 'contradicted')
  assert.equal(skew.domains.relay.hi, ASSUMED_SKEW_MS)
})

/* -------------------------------------------------------------- ordering */

/*
 * THE CENTRAL RULE: a shared identifier is evidence about the world; a
 * timestamp is evidence about a clock. When they disagree, the clock is wrong.
 */
test('causality wins over the clock, and the disagreement is reported not hidden', () => {
  const skew = measureSkew([])
  const cause = node('cause', mac(10_000))
  const effect = node('effect', mac(0), ['cause'])

  const { ordered, clockConflicts } = orderByCausality([effect, cause], skew)

  assert.deepEqual(
    ordered.map((row) => row.id),
    ['cause', 'effect'],
  )
  assert.equal(clockConflicts.length, 1)
  assert.equal(clockConflicts[0].event, 'effect')
  assert.match(clockConflicts[0].note, /one of the two clocks is wrong/)
})

/*
 * The pendant press, placed by the only evidence there is.
 *
 * An uptime stamp locates nothing, but the press definitely happened before
 * the relay confirmed the forward — and the forward has a real position. So
 * the press is printed just ahead of it rather than dumped at the end of the
 * account, and nothing about its `at` is fabricated to achieve that.
 */
test('an unplaceable event is printed beside the effect it is known to have caused', () => {
  const skew = measureSkew([])
  const press = node('press', instantOf({ domain: 'pendant', at: 240_000, quality: 'uptime' }))
  const forward = node('forward', mac(60_000), ['press'])

  const { ordered } = orderByCausality(
    [node('early', mac(0)), node('late', mac(120_000)), forward, press],
    skew,
  )

  assert.deepEqual(
    ordered.map((row) => row.id),
    ['early', 'press', 'forward', 'late'],
  )
  /* ...and it is still reported as having no position of its own. */
  assert.equal(projectInstant(press.at, skew).positionKnown, false)
})

test('an unplaceable event that caused nothing takes the slot nothing else wants', () => {
  const skew = measureSkew([])
  const orphan = node('orphan', instantOf({ domain: 'pendant', at: 240_000, quality: 'uptime' }))

  const { ordered } = orderByCausality([orphan, node('a', mac(0)), node('b', mac(1000))], skew)

  assert.deepEqual(
    ordered.map((row) => row.id),
    ['a', 'b', 'orphan'],
  )
})

test('events causality leaves unordered fall back to time, deterministically', () => {
  const skew = measureSkew([])
  const rows = [node('c', mac(3000)), node('a', mac(1000)), node('b', mac(2000))]

  const first = orderByCausality(rows, skew).ordered.map((row) => row.id)
  const second = orderByCausality([...rows].reverse(), skew).ordered.map((row) => row.id)

  assert.deepEqual(first, ['a', 'b', 'c'])
  assert.deepEqual(second, first, 'input order cannot change the answer')
})

/*
 * Adjacent-but-unorderable is reported, so the renderer can say "around the
 * same time" instead of "then". Without this the timeline reads as a causal
 * chain it has no right to claim.
 */
test('adjacent pairs the clocks cannot separate are flagged rather than sequenced', () => {
  const skew = measureSkew([])
  const { unresolvedAdjacencies } = orderByCausality(
    [node('m', mac(0)), node('r', relay(2_000))],
    skew,
  )

  assert.equal(unresolvedAdjacencies.length, 1)
  assert.equal(unresolvedAdjacencies[0].after, 'r')
})

/* A causal edge is an order, so an adjacency backed by one is never flagged. */
test('a causal pair is never reported as unorderable', () => {
  const skew = measureSkew([])
  const { unresolvedAdjacencies } = orderByCausality(
    [node('m', mac(0)), node('r', relay(2_000), ['m'])],
    skew,
  )

  assert.deepEqual(unresolvedAdjacencies, [])
})

/*
 * Bounded stores drop things. An edge pointing at a record that was evicted
 * must not stall the sort — a digest that silently loses every event behind a
 * dangling edge is the exact failure it exists to prevent.
 */
test('an edge pointing at a missing record is counted, and nothing is lost', () => {
  const skew = measureSkew([])
  const { ordered, danglingEdges } = orderByCausality(
    [node('a', mac(0), ['gone']), node('b', mac(1000))],
    skew,
  )

  assert.equal(danglingEdges, 1)
  assert.deepEqual(
    ordered.map((row) => row.id).sort(),
    ['a', 'b'],
  )
})

/*
 * Two surfaces, two names, one fact.
 *
 * A scheduled occurrence is keyed by the unit the owner declared; the
 * announcement it produced records the runId of the individual attempt,
 * because that is what the relay had in hand. Matching only on the primary id
 * drops the edge and files the announcement as an orphan whose position rests
 * on clocks alone — losing precisely the causal link this is here to recover.
 */
test('an edge written in another surface vocabulary still resolves', () => {
  const skew = measureSkew([])
  const occurrence = node('occurrence:rtn_1#am', mac(0), [], ['run:run_1'])
  const announcement = node('announcement:a1', mac(1000), ['run:run_1'])

  const { resolvedParents, danglingEdges, unresolvedAdjacencies } = orderByCausality(
    [announcement, occurrence],
    skew,
  )

  assert.deepEqual(resolvedParents.get('announcement:a1'), ['occurrence:rtn_1#am'])
  assert.equal(danglingEdges, 0)
  assert.deepEqual(unresolvedAdjacencies, [], 'a resolved edge is an order')
})

/* An alias may never shadow a real event: if something already owns that id,
 * the id keeps meaning what it meant. */
test('an alias never displaces an event that already owns the id', () => {
  const skew = measureSkew([])
  const { resolvedParents } = orderByCausality(
    [
      node('run:run_1', mac(0)),
      node('occurrence:x', mac(500), [], ['run:run_1']),
      node('announcement:a1', mac(1000), ['run:run_1']),
    ],
    skew,
  )

  assert.deepEqual(resolvedParents.get('announcement:a1'), ['run:run_1'])
})

test('a cycle is named rather than allowed to swallow its events', () => {
  const skew = measureSkew([])
  const { ordered, cyclicIds } = orderByCausality(
    [node('a', mac(0), ['b']), node('b', mac(1000), ['a'])],
    skew,
  )

  assert.deepEqual(cyclicIds.sort(), ['a', 'b'])
  assert.equal(ordered.length, 2, 'both are still in the account')
})

/* --------------------------------------------------------------- windows */

/*
 * Three answers, not two. An event whose uncertainty straddles the start of
 * the gap may or may not belong to it, and both mistakes cost the owner
 * something. It is included and marked.
 */
test('an event straddling the edge of the gap is kept and marked, not dropped', () => {
  const skew = measureSkew([])
  const from = T
  const to = T + 3_600_000

  assert.equal(windowMembership(mac(-1), { from, to }, skew).inside, 'before')
  assert.equal(windowMembership(mac(1000), { from, to }, skew).inside, 'inside')
  /* A relay stamp one second into the gap could be either side of it once the
   * assumed offset is applied. */
  assert.equal(windowMembership(relay(1000), { from, to }, skew).inside, 'edge')
})

test('an unplaceable instant is neither included silently nor excluded silently', () => {
  const skew = measureSkew([])
  const membership = windowMembership(
    instantOf({ domain: 'pendant', at: 240_000, quality: 'uptime' }),
    { from: T, to: T + 1000 },
    skew,
  )

  assert.equal(membership.inside, 'unknown')
  assert.match(membership.reason, /uptime/)
})
