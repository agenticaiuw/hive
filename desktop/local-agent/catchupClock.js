/*
 * Putting events from four machines in one order, when no two of them share a
 * clock.
 *
 * THE PROBLEM, stated exactly.
 *
 * A catch-up digest is a claim about SEQUENCE — "this happened, then that, and
 * because of that this other thing never did". Every timestamp it has to work
 * from was written by a different computer:
 *
 *   mac      local-agent's stores (actionLedger, jobTracker, browserSpool,
 *            briefingQueue). One machine, one Date.now(), mutually exact.
 *   relay    a Cloudflare Worker. Different machine, NTP-disciplined, and the
 *            isolate serving one request is not the isolate serving the next.
 *   pendant  an nRF9160. Its clock is the modem's NITZ time WHEN THE TOWER EVER
 *            GAVE IT ONE, and device uptime otherwise — see
 *            firmware/nrf9160/src/pendant_store.h, which says so in as many
 *            words. Uptime is not a wall clock at all: it says "4 minutes after
 *            this device booted", which is a true statement about an instant
 *            nobody can locate.
 *
 * There is no NTP handshake between them, no Lamport counter on the wire, no
 * vector clock in any store. Adding one would mean changing the firmware, the
 * relay and the executor — three files this module is not allowed to touch, and
 * two of them are shipped hardware. So this file does not invent a shared
 * clock. It does three things instead, in strict order of preference:
 *
 *   1. CAUSAL JOINS FIRST. Where two records share an identifier — a routine
 *      run carrying the macJobId it created, a ledger carrying its jobId, an
 *      announcement carrying its runId — the order is a FACT and no timestamp
 *      is consulted. See orderByCausality below: causality is a topological
 *      constraint, and time only breaks ties among events causality leaves
 *      unordered.
 *
 *   2. MEASURED SKEW SECOND. Those same joins bracket the clock offset, for
 *      free, by exactly the argument NTP uses for a round trip: a relay that
 *      creates a Mac job at relay-time r, and a Mac that stamps that job at
 *      mac-time m, proves the relay's clock is not ahead by more than m - r.
 *      The reply leg bounds it from the other side. Two legs give a bracket.
 *
 *   3. A DECLARED ASSUMPTION LAST, and only where it is already load-bearing
 *      elsewhere in this system. When no anchor exists, relay↔mac comparisons
 *      fall back to ASSUMED_SKEW_MS — and every output that used the fallback
 *      says `source: 'assumed'` rather than passing it off as knowledge.
 *
 * WHAT IT REFUSES. A pendant timestamp taken from uptime gets no interval at
 * all: `positionKnown: false`, and the only true statement about it — "it was
 * before the moment it was forwarded" — is expressed as a causal edge to the
 * forwarding event, not as a number. Any two events whose uncertainty intervals
 * overlap are reported `relation: 'unknown'` and shown adjacent; the digest
 * says "around the same time", never "then".
 */

/* The clock each surface's timestamps were written by. `unknown` is a real
 * value and is treated as maximally uncertain rather than quietly as `mac`. */
export const CLOCK_DOMAINS = Object.freeze(['mac', 'relay', 'pendant', 'unknown'])

/*
 * How a timestamp was produced, which is a different question from which
 * machine produced it.
 *
 *   wall     a real wall-clock reading (Date.now(), or a modem NITZ time).
 *   uptime   milliseconds since that device booted. NOT a wall clock. The
 *            pendant writes these when the tower never handed it a time.
 *   unknown  no timestamp at all.
 */
export const CLOCK_QUALITIES = Object.freeze(['wall', 'uptime', 'unknown'])

/*
 * The fallback bound on relay↔mac skew, in milliseconds.
 *
 * NOT a number invented here. cloud-relay/scheduler.js decides whether the Mac
 * is awake with `Date.now() - Date.parse(device.lastSeenAt) < 90_000`, where
 * Date.now() is the relay's clock and lastSeenAt was stamped by the Mac. That
 * comparison is only meaningful if the two clocks agree to well inside 90
 * seconds, and the whole routine dispatcher has been running on that bet. This
 * constant writes the existing bet down and doubles it for headroom; it does
 * not place a new one.
 *
 * It is used ONLY when no causal anchor is available to measure with, and its
 * use is always reported.
 */
export const ASSUMED_SKEW_MS = 180_000

/*
 * The pendant's modem clock, when it has one, comes from the cell network and
 * is coarse: NITZ carries whole quarter-hours of offset, some networks never
 * send it, and the modem is re-read after a power cycle that may have taken
 * any amount of time. Five minutes is generous on purpose — a bound that is
 * too tight would let the digest claim an order it cannot support, which is
 * the one failure this file exists to prevent.
 */
export const ASSUMED_PENDANT_SKEW_MS = 300_000

/* Nothing is comparable to a domain we do not recognise. */
const UNBOUNDED = Object.freeze({ lo: -Infinity, hi: Infinity })

const finite = (value) => (Number.isFinite(value) ? value : null)

/** Parse whatever a store wrote — ISO string, epoch millis, Date — or null. */
export function toMillis(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return finite(value.getTime())
  if (typeof value === 'number') return finite(value)
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * One instant, as this system can actually know it.
 *
 * `quality` is carried separately from `domain` because they answer different
 * questions and only one of them can be repaired. A relay `wall` reading is a
 * real instant seen through an offset that measurement can bound. A pendant
 * `uptime` reading is not an instant at all, and no amount of measurement makes
 * it one.
 */
export function instantOf({ domain = 'mac', at = null, quality = 'wall' } = {}) {
  const millis = toMillis(at)
  const knownDomain = CLOCK_DOMAINS.includes(domain) ? domain : 'unknown'
  const knownQuality = CLOCK_QUALITIES.includes(quality) ? quality : 'unknown'
  return {
    domain: knownDomain,
    at: millis,
    quality: millis === null ? 'unknown' : knownQuality,
    iso: millis === null || knownQuality !== 'wall' ? null : new Date(millis).toISOString(),
  }
}

/* ------------------------------------------------------------ measuring skew */

/**
 * One thing that is known to have happened before another thing, stamped by
 * two different clocks.
 *
 * `why` is required rather than decorative: an anchor is an assertion about
 * causality, and an assertion nobody can check is how a measurement becomes a
 * guess wearing a number. Every anchor this project can build comes from an
 * identifier one side wrote down about the other.
 */
export function causalAnchor({ before, after, why }) {
  return {
    before: instantOf(before),
    after: instantOf(after),
    why: String(why ?? ''),
  }
}

/*
 * Bound the offset of every domain against a reference domain.
 *
 * Define, for domain D, the offset δ(D) = (what D's clock reads at some true
 * instant) − (what the reference clock reads at the same instant). Converting a
 * D-stamp t into the reference frame is therefore `t − δ(D)`, and δ(reference)
 * is 0 by construction.
 *
 * An anchor says true(before) ≤ true(after). Writing both in the reference
 * frame, with `a` the before-stamp in domain A and `b` the after-stamp in
 * domain B:
 *
 *     a − δ(A) ≤ b − δ(B)      ⟺      δ(B) − δ(A) ≤ b − a
 *
 * When A is the reference (δ(A) = 0) that is an UPPER bound on δ(B).
 * When B is the reference (δ(B) = 0) it rearranges to δ(A) ≥ a − b, a LOWER
 * bound on δ(A). One dispatch leg and one reply leg therefore bracket the
 * offset from both sides — the same argument NTP makes about a round trip,
 * made here out of identifiers the stores already write down.
 *
 * Anchors between two NON-reference domains are counted and reported and then
 * deliberately not used. Chaining them would need a shortest-path closure over
 * the constraint graph, and each hop widens the interval; with the two or three
 * anchors a real gap produces, the chained bound is always looser than the
 * declared assumption while LOOKING like a measurement. Refusing is the honest
 * option, and `unusableAnchors` says how often it was taken.
 */
export function measureSkew(anchors = [], { reference = 'mac' } = {}) {
  const bounds = new Map()
  let usable = 0
  let unusable = 0

  const widen = (domain, patch) => {
    const current = bounds.get(domain) ?? { lo: -Infinity, hi: Infinity, anchors: 0 }
    bounds.set(domain, {
      lo: Math.max(current.lo, patch.lo ?? -Infinity),
      hi: Math.min(current.hi, patch.hi ?? Infinity),
      anchors: current.anchors + 1,
    })
  }

  for (const anchor of anchors) {
    const { before, after } = anchor ?? {}
    /* Only wall readings constrain anything. An uptime stamp is a duration
     * since an unknown boot instant; subtracting it from a wall reading yields
     * a number with no meaning, and a bound built from one would be worse than
     * no bound because it would look authoritative. */
    if (!before || !after) continue
    if (before.at === null || after.at === null) continue
    if (before.quality !== 'wall' || after.quality !== 'wall') {
      unusable += 1
      continue
    }
    if (before.domain === after.domain) continue

    if (before.domain === reference) {
      widen(after.domain, { hi: after.at - before.at })
      usable += 1
    } else if (after.domain === reference) {
      widen(before.domain, { lo: before.at - after.at })
      usable += 1
    } else {
      unusable += 1
    }
  }

  const domains = {}
  for (const domain of CLOCK_DOMAINS) {
    if (domain === reference) {
      domains[domain] = { lo: 0, hi: 0, source: 'reference', anchors: 0 }
      continue
    }

    const measured = bounds.get(domain)
    const assumed = domain === 'pendant' ? ASSUMED_PENDANT_SKEW_MS : ASSUMED_SKEW_MS

    if (domain === 'unknown') {
      domains[domain] = { ...UNBOUNDED, source: 'unbounded', anchors: 0 }
      continue
    }

    if (!measured || (!Number.isFinite(measured.lo) && !Number.isFinite(measured.hi))) {
      domains[domain] = { lo: -assumed, hi: assumed, source: 'assumed', anchors: 0 }
      continue
    }

    /*
     * A one-sided measurement is kept on the side it constrains and backed by
     * the assumption on the other. Discarding a real bound because its partner
     * is missing throws away the only hard information in the record; widening
     * the measured side to the assumption would be worse still, since the
     * measurement may well be tighter.
     */
    const lo = Number.isFinite(measured.lo) ? measured.lo : -assumed
    const hi = Number.isFinite(measured.hi) ? measured.hi : assumed

    /*
     * Contradictory legs mean at least one anchor is not the causal edge it
     * claims to be — or a clock stepped mid-gap. Either way the bracket is
     * void: fall back and say so, rather than emit an empty interval that
     * would make every comparison vacuously definite.
     */
    if (lo > hi) {
      domains[domain] = {
        lo: -assumed,
        hi: assumed,
        source: 'contradicted',
        anchors: measured.anchors,
      }
      continue
    }

    domains[domain] = {
      lo,
      hi,
      source:
        Number.isFinite(measured.lo) && Number.isFinite(measured.hi)
          ? 'measured'
          : 'measured-one-sided',
      anchors: measured.anchors,
    }
  }

  return { reference, domains, usableAnchors: usable, unusableAnchors: unusable }
}

/**
 * Where an instant sits in the reference frame, as an interval rather than a
 * point.
 *
 * A same-domain reading is a point. A cross-domain reading is a point minus an
 * offset known only to lie in [lo, hi], so it becomes [at − hi, at − lo]. An
 * uptime reading has no position at all and says so; callers must place it by
 * causality or not at all.
 */
export function projectInstant(moment, skew) {
  const domain = moment?.domain ?? 'unknown'
  const bound = skew?.domains?.[domain] ?? UNBOUNDED

  if (moment?.at === null || moment?.at === undefined) {
    return { lo: -Infinity, hi: Infinity, mid: null, positionKnown: false, reason: 'no timestamp' }
  }
  if (moment.quality === 'uptime') {
    return {
      lo: -Infinity,
      hi: Infinity,
      mid: null,
      positionKnown: false,
      /* Named exactly, because this is the one uncertainty in the system that
       * cannot be narrowed by any measurement available to it. */
      reason: 'the device stamped this from uptime, not from a wall clock',
    }
  }

  const lo = moment.at - bound.hi
  const hi = moment.at - bound.lo
  return {
    lo,
    hi,
    mid: Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : moment.at,
    positionKnown: Number.isFinite(lo) && Number.isFinite(hi),
    reason: null,
    skewSource: bound.source ?? 'unbounded',
  }
}

/**
 * Which of two instants came first — or an admission that it cannot be told.
 *
 * Disjoint intervals are a proof. Overlapping intervals are not evidence of
 * simultaneity; they are evidence that the available clocks cannot separate
 * the two, which is a different and much more common thing.
 */
export function compareInstants(left, right, skew) {
  const a = projectInstant(left, skew)
  const b = projectInstant(right, skew)

  if (!a.positionKnown || !b.positionKnown) {
    return { relation: 'unknown', order: 0, why: a.reason ?? b.reason ?? 'one side has no position' }
  }
  if (a.hi < b.lo) return { relation: 'before', order: -1, why: null }
  if (b.hi < a.lo) return { relation: 'after', order: 1, why: null }
  return {
    relation: 'unknown',
    order: 0,
    why: 'their uncertainty windows overlap, so the clocks available cannot separate them',
  }
}

/* -------------------------------------------------------- causal ordering */

/*
 * Sort so that causality is never violated and time only breaks ties.
 *
 * Kahn's algorithm over the causal edges, with the ready set drained in
 * projected-time order. The consequence worth stating: an event whose recorded
 * time is EARLIER than its cause still lands after its cause, and the
 * disagreement is reported in `clockConflicts` rather than silently resolved.
 * That is the correct treatment — a join is evidence about the world, a
 * timestamp is evidence about a clock, and when they disagree it is the clock
 * that is wrong.
 *
 * Events are keyed by `id`; edges are `causedBy: [id]`. Edges pointing at ids
 * that are not present (a job whose ledger fell off a bounded store) are
 * dropped and counted — a dangling edge must not deadlock the sort.
 */
export function orderByCausality(events = [], skew) {
  const byId = new Map()
  for (const event of events) {
    if (event?.id) byId.set(event.id, event)
  }

  /*
   * ONE THING, SEVERAL NAMES.
   *
   * Surfaces name the same fact differently and neither name is wrong. A
   * scheduled occurrence is `occurrence:<routineId>#<dueAt>` here, because that
   * is the unit the owner declared — but the announcement it produced records
   * the `runId` of the individual attempt, because that is what the relay had
   * in hand when it wrote the row. Matching only on the primary id would drop
   * the edge and file the announcement as an orphan whose position rests on
   * clocks alone, which is exactly the causal link this digest exists to
   * recover. So an event may declare the other names it answers to, and edges
   * resolve through them.
   */
  const alias = new Map()
  for (const event of byId.values()) {
    for (const name of event.aliases ?? []) {
      if (name && !byId.has(name) && !alias.has(name)) alias.set(name, event.id)
    }
  }
  const resolve = (id) => (byId.has(id) ? id : (alias.get(id) ?? null))

  const parents = new Map()
  const children = new Map()
  let danglingEdges = 0

  for (const event of byId.values()) {
    const list = []
    for (const rawParentId of event.causedBy ?? []) {
      const parentId = resolve(rawParentId)
      if (!parentId || parentId === event.id) {
        if (!parentId) danglingEdges += 1
        continue
      }
      list.push(parentId)
      children.set(parentId, [...(children.get(parentId) ?? []), event.id])
    }
    parents.set(event.id, list)
  }

  const remaining = new Map([...parents].map(([id, list]) => [id, list.length]))
  const projected = new Map(
    [...byId].map(([id, event]) => [id, projectInstant(event.at, skew)]),
  )

  /*
   * Where to put an event whose own clock cannot place it.
   *
   * The pendant press is the case: an uptime stamp locates nothing, but the
   * press definitely happened BEFORE the relay confirmed the forward, and the
   * forward has a real position. So an unplaceable event inherits an upper
   * bound from the earliest effect it is known to have caused, and sits just
   * ahead of it.
   *
   * This is a derivation from the one causal fact available, not a guess at a
   * timestamp: nothing here fabricates an `at`, and projectInstant still
   * reports the event as unpositioned. It only decides where an unplaceable row
   * is PRINTED, and printing it next to the thing it caused is both the most
   * useful place and the only one supported by evidence. An event with no
   * positioned effects keeps the last slot — it has no claim to a place, so it
   * takes the one nothing else wants.
   */
  const placement = new Map()
  for (const [id, position] of projected) {
    if (position.positionKnown) {
      placement.set(id, position.mid)
      continue
    }
    const effects = (children.get(id) ?? [])
      .map((childId) => projected.get(childId))
      .filter((child) => child?.positionKnown)
      .map((child) => child.mid)
    placement.set(id, effects.length ? Math.min(...effects) - 1 : Number.POSITIVE_INFINITY)
  }

  /* Deterministic, and deterministic for a reason a reader can check: earliest
   * placement, then the raw stamp, then the id. */
  const rank = (id) => {
    const event = byId.get(id)
    return [
      placement.get(id) ?? Number.POSITIVE_INFINITY,
      event?.at?.at ?? Number.POSITIVE_INFINITY,
      id,
    ]
  }

  const readyBefore = (left, right) => {
    const a = rank(left)
    const b = rank(right)
    if (a[0] !== b[0]) return a[0] < b[0]
    if (a[1] !== b[1]) return a[1] < b[1]
    return String(a[2]) < String(b[2])
  }

  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id)
  const ordered = []
  const clockConflicts = []

  while (ready.length) {
    let pick = 0
    for (let index = 1; index < ready.length; index += 1) {
      if (readyBefore(ready[index], ready[pick])) pick = index
    }
    const id = ready.splice(pick, 1)[0]
    ordered.push(byId.get(id))

    for (const childId of children.get(id) ?? []) {
      const left = (remaining.get(childId) ?? 1) - 1
      remaining.set(childId, left)
      if (left === 0) ready.push(childId)
    }
  }

  /*
   * A cycle means two records each claim to have caused the other. That is a
   * data bug, not a timing question, and swallowing it would drop events from
   * the digest — the one thing a catch-up digest may never do. Everything still
   * blocked is appended in time order and named.
   */
  const cyclic = [...remaining].filter(([, count]) => count > 0).map(([id]) => id)
  if (cyclic.length) {
    cyclic.sort((left, right) => (readyBefore(left, right) ? -1 : 1))
    for (const id of cyclic) ordered.push(byId.get(id))
  }

  /* Report, after the fact, every place a join and a clock disagreed. */
  for (const event of ordered) {
    for (const parentId of parents.get(event.id) ?? []) {
      const parent = byId.get(parentId)
      if (!parent) continue
      const verdict = compareInstants(event.at, parent.at, skew)
      if (verdict.relation === 'before') {
        clockConflicts.push({
          event: event.id,
          cause: parentId,
          note:
            'This is recorded as happening before the thing that caused it. ' +
            'The link between them is an identifier, so the order is right and one of the two clocks is wrong.',
        })
      }
    }
  }

  return {
    ordered,
    clockConflicts,
    danglingEdges,
    cyclicIds: cyclic,
    /* Adjacent pairs the clocks could not separate. The digest renders these
     * as "around the same time" rather than "then". */
    /* The resolved parent list, so a caller can report causality using the same
     * ids it will find in the ordered output rather than the ones the source
     * surface happened to write down. */
    resolvedParents: new Map([...parents]),
    unresolvedAdjacencies: ordered
      .map((event, index) => {
        if (index === 0) return null
        const previous = ordered[index - 1]
        if ((parents.get(event.id) ?? []).includes(previous.id)) return null
        const verdict = compareInstants(previous.at, event.at, skew)
        return verdict.relation === 'unknown'
          ? { after: event.id, before: previous.id, why: verdict.why }
          : null
      })
      .filter(Boolean),
  }
}

/**
 * Whether an instant falls inside a window expressed in the reference frame.
 *
 * Three answers, not two. `edge` is the one that matters: an event whose
 * uncertainty straddles the start of the gap may or may not belong to it, and
 * dropping it would hide something that happened while the owner was away
 * while keeping it would put something they already saw back in front of them.
 * It is included and marked, which is the only choice that loses nothing.
 */
export function windowMembership(moment, { from = null, to = null } = {}, skew) {
  const position = projectInstant(moment, skew)
  if (!position.positionKnown) return { inside: 'unknown', reason: position.reason }

  const start = toMillis(from)
  const end = toMillis(to)

  if (start !== null && position.hi < start) return { inside: 'before', reason: null }
  if (end !== null && position.lo > end) return { inside: 'after', reason: null }
  if (
    (start === null || position.lo >= start) &&
    (end === null || position.hi <= end)
  ) {
    return { inside: 'inside', reason: null }
  }
  return {
    inside: 'edge',
    reason: 'its uncertainty window straddles the edge of the gap',
  }
}

/**
 * How the skew estimate should be described out loud, per domain.
 *
 * Returns objects rather than sentences so a caller can tell WHICH clock it is
 * reading about — a digest that reports "a clock was assumed" without naming it
 * has handed the reader a worry they cannot act on, and a caller checking
 * whether the relay was measured cannot be made to parse prose for it.
 */
export function describeSkew(skew) {
  return Object.entries(skew?.domains ?? {})
    .filter(([domain]) => domain !== skew?.reference && domain !== 'unknown')
    .map(([domain, bound]) => {
      const measured = bound.source === 'measured' || bound.source === 'measured-one-sided'

      const note = measured
        ? `The ${domain} clock was measured against this Mac from ${bound.anchors} ` +
          `record(s) that name each other: between ${Math.round(bound.lo)}ms and ` +
          `${Math.round(bound.hi)}ms of offset` +
          (bound.source === 'measured-one-sided'
            ? ', bounded on one side only, so the other side falls back to the assumption.'
            : '.')
        : bound.source === 'contradicted'
          ? `The ${domain} clock could not be measured: the records that name each other ` +
            'disagree about which came first, so the assumed bound is used instead.'
          : `The ${domain} clock was not measured — nothing in this gap links it to this Mac — ` +
            `so ordering against it assumes the two agree to within ${Math.round(bound.hi)}ms.`

      return { domain, source: bound.source, measured, note }
    })
}
