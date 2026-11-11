import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/*
 * The stores this module reads all compute their paths from config.workspacePath
 * at module load, so the workspace has to be redirected BEFORE the first import
 * of anything that reaches config.js. Static imports are hoisted; a dynamic one
 * is not, which is the only reason this file loads the module under test with
 * `await import`.
 */
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-catchup-'))
process.env.PENDANT_WORKSPACE_PATH = WORKSPACE
process.env.PENDANT_ACTION_LEDGER_PATH = path.join(WORKSPACE, 'ledger.json')

const {
  DEFAULT_GAP_MS,
  buildCatchupDigest,
  collectCatchupDigest,
  registerCatchupRoutes,
  speakDigest,
} = await import('./catchupDigest.js')
const { causalAnchor, instantOf } = await import('./catchupClock.js')
const { eventsFromAnnouncements, eventsFromBrowserSpool, eventsFromRoutineRuns } =
  await import('./catchupSources.js')

const NOW = Date.parse('2026-08-07T18:00:00.000Z')
const GAP_FROM = NOW - 12 * 3_600_000
const ago = (ms) => new Date(NOW - ms).toISOString()

function row(overrides = {}) {
  return {
    id: 'e1',
    surface: 'mac-job',
    label: 'occurred',
    title: 'Something',
    why: 'It finished.',
    at: instantOf({ domain: 'mac', at: ago(3_600_000) }),
    causedBy: [],
    joins: {},
    needsOwner: false,
    needsOwnerReason: null,
    suggestion: null,
    where: null,
    fingerprint: null,
    fingerprintInputs: null,
    alreadyTold: null,
    ...overrides,
  }
}

const digestOf = (events, extra = {}) =>
  buildCatchupDigest({ events, now: NOW, from: GAP_FROM, to: NOW, ...extra })

const find = (digest, id) => digest.timeline.find((entry) => entry.id === id)

/* ------------------------------------------------- the three-way distinction */

/*
 * THE WHOLE CAPABILITY, in one assertion.
 *
 * Before this, a browser command that died unqueued, a routine occurrence the
 * relay dropped, and a plan step that ran all appeared on three different
 * surfaces in three different vocabularies, and none of the three would tell
 * you which of "it happened / it is coming / it is gone" you were looking at.
 * They now carry one word each, from a closed vocabulary, plus the evidence.
 */
test('one gap, five distinct outcomes, each carrying the evidence for its label', () => {
  const digest = digestOf([
    row({ id: 'a', label: 'occurred', at: instantOf({ domain: 'mac', at: ago(6_000_000) }) }),
    row({ id: 'b', label: 'queued', at: instantOf({ domain: 'mac', at: ago(5_000_000) }) }),
    row({ id: 'c', label: 'expired', at: instantOf({ domain: 'mac', at: ago(4_000_000) }) }),
    row({ id: 'd', label: 'failed', needsOwner: true, at: instantOf({ domain: 'mac', at: ago(3_000_000) }) }),
    row({
      id: 'e',
      label: 'indeterminate',
      needsOwner: true,
      at: instantOf({ domain: 'mac', at: ago(2_000_000) }),
    }),
  ])

  assert.deepEqual(digest.counts, {
    occurred: 1,
    queued: 1,
    expired: 1,
    failed: 1,
    indeterminate: 1,
  })
  assert.deepEqual(
    digest.timeline.map((entry) => entry.id),
    ['a', 'b', 'c', 'd', 'e'],
    'ordered by when things happened, not by importance',
  )
  /* Every label has a sentence a person can read, in the payload itself. */
  for (const label of digest.labels) assert.ok(digest.legend[label])
  assert.match(digest.legend.expired, /Nobody failed/)
  assert.match(digest.legend.indeterminate, /only you can settle/)
})

/*
 * Queued is the system working. Putting a scheduled retry or a deferred
 * routine in front of the owner trains them to ignore the list — but a queued
 * item that is waiting ON THEM rather than on the system belongs there.
 */
test('what still needs the owner excludes work that is merely still coming', () => {
  const digest = digestOf([
    row({ id: 'retry', label: 'queued', needsOwner: false }),
    row({ id: 'unplayed', surface: 'briefing', label: 'queued', needsOwner: true }),
    row({ id: 'unknown', label: 'indeterminate', needsOwner: true }),
    row({ id: 'dead', label: 'failed', needsOwner: true }),
  ])

  assert.deepEqual(
    digest.stillNeedsYou.map((item) => item.id),
    ['unknown', 'dead', 'unplayed'],
    'unknown outcomes outrank known failures, which outrank things waiting on them',
  )
  assert.equal(digest.stillNeedsYou.every((item) => item.acted === false), true)
})

/* ----------------------------------------------------------------- dedupe */

/*
 * "Do not re-tell it." The told-ledger is briefingQueue.js's, the fingerprints
 * are briefingTriage.js's, and a match means the owner has already heard this
 * sentence. It stays in the ORDERED ACCOUNT — the causal story is incomplete
 * without it — and it is kept out of what still needs them.
 */
test('something already spoken stays in the account and out of what needs you', () => {
  const told = new Map([['bf_known', { at: ago(4_000_000), headline: 'File the form', runId: 'btg_1' }]])

  const digest = digestOf(
    [
      row({ id: 'heard', label: 'failed', needsOwner: true, fingerprint: 'bf_known' }),
      row({ id: 'fresh', label: 'failed', needsOwner: true, fingerprint: 'bf_other' }),
    ],
    { told },
  )

  assert.equal(digest.alreadyToldCount, 1)
  assert.equal(find(digest, 'heard').alreadyTold.match, 'exact')
  assert.ok(find(digest, 'heard'), 'still part of the ordered account')
  assert.deepEqual(
    digest.stillNeedsYou.map((item) => item.id),
    ['fresh'],
  )
})

/*
 * ...but only the SAME sentence. briefingTriage.js gives a finding a different
 * fingerprint once its urgency band moves, deliberately, because "your form is
 * due Thursday" and "your form is overdue" are different news. Suppressing the
 * second because the owner heard the first would be the dedupe eating the
 * signal.
 */
test('the same thing in a new urgency band is still news, and says they heard the old one', async () => {
  const { fingerprintFinding } = await import('./briefingTriage.js')
  const inputs = { source: 'reminders', key: 'r1', title: 'File the form', actionableUntil: ago(-3600_000) }
  const told = new Map([[fingerprintFinding(inputs, 'later'), { at: ago(80_000_000), headline: 'File the form' }]])

  const digest = digestOf(
    [row({ id: 'form', label: 'expired', needsOwner: true, fingerprintInputs: inputs })],
    { told },
  )

  assert.equal(find(digest, 'form').alreadyTold.match, 'other-band')
  assert.deepEqual(
    digest.stillNeedsYou.map((item) => item.id),
    ['form'],
  )
  assert.equal(digest.stillNeedsYou[0].previouslyTold.band, 'later')
  assert.equal(digest.alreadyToldCount, 0, 'a band change is not "already told"')
})

/* ------------------------------------------------------ order and causality */

/*
 * The refusal, end to end. Two events seconds apart on two machines whose
 * clocks were never compared cannot be ordered, and the digest says so in the
 * row, in the refusal list, and in the words it speaks.
 */
test('cross-machine events the clocks cannot separate are never given a false order', () => {
  const digest = digestOf([
    row({ id: 'mac', at: instantOf({ domain: 'mac', at: ago(3_600_000) }) }),
    row({ id: 'relay', at: instantOf({ domain: 'relay', at: ago(3_598_000) }) }),
  ])

  const second = digest.timeline[1]
  assert.equal(second.afterPrevious, 'unknown')
  assert.match(second.afterPreviousWhy, /uncertainty windows overlap/)
  assert.ok(digest.refusals.some((entry) => entry.kind === 'order'))
  assert.match(digest.spoken, /Around the same time/)
  assert.equal(/Then:/.test(digest.spoken), false, 'never the word that implies sequence')
})

/*
 * Measuring the offset — which costs nothing, because the relay already stamps
 * observedAt on every response — buys back the order the assumption had to
 * refuse.
 */
test('the round trip that fetched the data is what makes the order knowable', () => {
  const anchors = [
    causalAnchor({
      before: { domain: 'mac', at: NOW - 100 },
      after: { domain: 'relay', at: NOW - 50 },
      why: 'sent before stamped',
    }),
    causalAnchor({
      before: { domain: 'relay', at: NOW - 50 },
      after: { domain: 'mac', at: NOW },
      why: 'stamped before received',
    }),
  ]

  const events = [
    row({ id: 'mac', at: instantOf({ domain: 'mac', at: ago(3_600_000) }) }),
    row({ id: 'relay', at: instantOf({ domain: 'relay', at: ago(3_598_000) }) }),
  ]

  assert.equal(digestOf(events).timeline[1].afterPrevious, 'unknown')

  const measured = digestOf(events, { anchors })
  assert.equal(measured.timeline[1].afterPrevious, 'after')
  assert.equal(measured.clock.domains.relay.source, 'measured')
  assert.equal(measured.clock.anchorsUsed, 2)
  assert.equal(
    measured.refusals.some((entry) => entry.kind === 'skew' && entry.about === 'relay'),
    false,
    'a measured clock is not a refusal',
  )
  /* ...while the pendant, which nothing in this gap links to the Mac, still is.
   * The two must be distinguishable, or "a clock was assumed" is a worry the
   * reader cannot act on. */
  assert.ok(measured.refusals.some((entry) => entry.kind === 'skew' && entry.about === 'pendant'))
})

/*
 * "Because" is only ever said off an identifier. Two rows next to each other
 * in a timeline are next to each other; that is not a cause, and a renderer
 * that treats adjacency as one is inventing the causality this digest was
 * asked to establish.
 */
test('causality is claimed only where two records name each other', () => {
  const digest = digestOf([
    row({ id: 'run:r1', at: instantOf({ domain: 'relay', at: ago(7_200_000) }) }),
    row({
      id: 'announcement:a1',
      at: instantOf({ domain: 'relay', at: ago(7_100_000) }),
      causedBy: ['run:r1'],
      joins: { runId: 'r1' },
    }),
    row({ id: 'unrelated', at: instantOf({ domain: 'relay', at: ago(7_000_000) }) }),
  ])

  assert.deepEqual(find(digest, 'announcement:a1').becauseOf, ['run:r1'])
  assert.match(find(digest, 'announcement:a1').causeEvidence, /name each other/)
  assert.equal(find(digest, 'unrelated').becauseOf, null)
  assert.equal(find(digest, 'unrelated').causeEvidence, null)
})

/*
 * The relay's two rows about the same scheduled task, joined.
 *
 * The occurrence is keyed by what the owner declared; the announcement records
 * the runId of the attempt that produced it. Both are correct and they are
 * different strings, so an unaliased digest would report the announcement as
 * an orphan and lose the one real causal link the relay ever writes down.
 */
test('a run and the announcement it produced are joined across two vocabularies', () => {
  const events = [
    ...eventsFromRoutineRuns(
      [
        {
          runId: 'run_1',
          routineId: 'rtn_1',
          routineName: 'Morning news',
          status: 'completed',
          attempt: 1,
          final: true,
          dueAt: ago(9_000_000),
          startedAt: ago(9_000_000),
          occurrenceKey: 'rtn_1#am',
        },
      ],
      { now: NOW },
    ),
    ...eventsFromAnnouncements(
      [
        {
          announcementId: 'a1',
          title: 'Rent is due',
          speech: 'Rent is due today.',
          state: 'pending',
          createdAt: ago(8_000_000),
          expiresAt: ago(2_000_000),
          runId: 'run_1',
        },
      ],
      { now: NOW },
    ),
  ]

  const digest = digestOf(events)

  assert.deepEqual(find(digest, 'announcement:a1').becauseOf, ['occurrence:rtn_1#am'])
  assert.equal(
    digest.refusals.some((entry) => entry.kind === 'missing-record'),
    false,
    'the edge resolved, so nothing is reported as missing',
  )
  /* And the two are labelled differently: the task ran, and the words it
   * produced expired before anyone heard them. */
  assert.equal(find(digest, 'occurrence:rtn_1#am').label, 'occurred')
  assert.equal(find(digest, 'announcement:a1').label, 'expired')
})

/* The pendant press that has no wall clock is carried, not placed, and its
 * inclusion is recorded as something the digest declined to claim. */
test('an offline press with no usable clock is included without a claim about when', () => {
  const digest = digestOf([
    row({
      id: 'pendant:M1',
      surface: 'pendant-offline',
      title: 'You marked a moment on the pendant',
      at: instantOf({ domain: 'pendant', at: 240_000, quality: 'uptime' }),
    }),
  ])

  assert.equal(find(digest, 'pendant:M1').boundary, 'unknown')
  assert.ok(
    digest.refusals.some((entry) => entry.kind === 'window' && /uptime/.test(entry.refusal)),
  )
})

/* ------------------------------------------------------------- refusals */

/*
 * A gap account with a blind spot in it looks exactly like a quiet gap, and
 * the difference is everything. Every surface that could not be read is named.
 */
test('a surface that could not be read is named rather than silently missing', () => {
  const digest = digestOf([], {
    unreadable: [{ surface: 'relay', why: 'The relay could not be reached (timeout).' }],
  })

  assert.ok(
    digest.refusals.some(
      (entry) => entry.kind === 'unreadable-surface' && entry.about === 'relay',
    ),
  )
})

test('an unmeasured clock is itself reported as a refusal', () => {
  const digest = digestOf([row({ at: instantOf({ domain: 'relay', at: ago(3_600_000) }) })])

  const skewRefusal = digest.refusals.find((entry) => entry.kind === 'skew')
  assert.ok(skewRefusal)
  assert.match(skewRefusal.refusal, /assumes the two agree/)
})

/* --------------------------------------------------------------- speaking */

test('with nothing new, it says so rather than reciting what they have heard', () => {
  const told = new Map([['bf_known', { at: ago(1000), headline: 'x' }]])
  const digest = digestOf([row({ id: 'heard', fingerprint: 'bf_known' })], { told })

  assert.match(digest.spoken, /Nothing new happened/)
})

/*
 * Rows the owner has already heard are skipped when speaking, which breaks the
 * chain: the row after a skipped one is no longer the neighbour whose relation
 * the timeline recorded. Saying "then" across that break would assert a
 * sequence nothing established.
 */
test('skipping something already heard does not let the next line claim sequence', () => {
  const told = new Map([['bf_known', { at: ago(1000), headline: 'x' }]])
  const digest = digestOf(
    [
      row({ id: 'a', at: instantOf({ domain: 'mac', at: ago(6_000_000) }) }),
      row({ id: 'heard', fingerprint: 'bf_known', at: instantOf({ domain: 'mac', at: ago(5_000_000) }) }),
      row({ id: 'c', at: instantOf({ domain: 'mac', at: ago(4_000_000) }) }),
    ],
    { told },
  )

  assert.match(digest.spoken, /Also:/)
  assert.equal(/Then:/.test(digest.spoken), false)
})

test('the spoken account leads with order and closes with what needs them', () => {
  const spoken = speakDigest({
    timeline: [
      { seq: 0, title: 'A', label: 'occurred', why: 'It ran.', afterPrevious: null },
      { seq: 1, title: 'B', label: 'expired', why: 'Its window closed.', afterPrevious: 'after' },
    ],
    stillNeedsYou: [{ title: 'B', why: 'It will not happen on its own.' }],
    counts: { indeterminate: 0 },
    gapFrom: GAP_FROM,
    gapTo: NOW,
  })

  assert.match(spoken, /^Here is the last 12 hour\(s\), in order\./)
  assert.ok(spoken.indexOf('First: A') < spoken.indexOf('Then: B'))
  assert.match(spoken, /1 thing\(s\) still need you/)
})

/* ------------------------------------------------------------ end to end */

/*
 * Real normalizers, real reconciliation. The point of this one is that a dead
 * browser command and a dropped routine occurrence — two surfaces that have
 * never been able to talk about each other — come out of one call in one order
 * with two different, correct words on them.
 */
test('two surfaces that never shared a vocabulary produce one ordered account', () => {
  const events = [
    ...eventsFromBrowserSpool({
      entries: [
        { commandId: 'c1', reason: 'expired', action: { type: 'navigate' }, queuedAt: ago(5_000_000) },
        { commandId: 'c2', reason: 'lease-expired', action: { type: 'click' }, queuedAt: ago(4_000_000) },
      ],
      dropped: { entries: 0 },
    }),
    ...eventsFromRoutineRuns(
      [
        {
          runId: 'run_1',
          routineId: 'rtn_1',
          routineName: 'Morning news',
          status: 'missed',
          attempt: 1,
          final: true,
          dueAt: ago(9_000_000),
          startedAt: ago(9_000_000),
          occurrenceKey: 'rtn_1#morning',
        },
      ],
      { now: NOW },
    ),
  ]

  const digest = digestOf(events)

  assert.deepEqual(
    digest.timeline.map((entry) => [entry.id, entry.label]),
    [
      ['occurrence:rtn_1#morning', 'expired'],
      ['spool:c1', 'expired'],
      ['spool:c2', 'indeterminate'],
    ],
  )
  /* The two expired rows are expired for different reasons, and each says its
   * own. A single "it didn't happen" bucket would have lost both. */
  assert.match(find(digest, 'occurrence:rtn_1#morning').why, /window closed/)
  assert.match(find(digest, 'spool:c1').why, /no browser extension online/)
})

/*
 * Reading a digest changes nothing — not a retry, not a replay, not a resume,
 * not an acknowledgement. browserSpool.js states the rule for its own
 * contents; this asserts it for the layer above.
 */
test('building the digest twice gives the same answer and touches no store', async () => {
  const before = fs.readdirSync(WORKSPACE).sort()
  const first = await collectCatchupDigest({ now: NOW, includeRelay: false })
  const second = await collectCatchupDigest({ now: NOW, includeRelay: false })

  assert.deepEqual(first.timeline, second.timeline)
  assert.equal(first.readOnly, true)
  /* Stores are created on first read by ensureJsonStore, which is not a write
   * by this module; what must not change is their CONTENT between two reads. */
  const after = fs.readdirSync(WORKSPACE).sort()
  for (const name of before) assert.ok(after.includes(name))
})

/*
 * The Mac cannot read the pendant's card. That is a real hole in the account
 * and it is stated rather than left to look like a quiet device.
 */
test('the pendant outbox it cannot read is declared, not assumed empty', async () => {
  const digest = await collectCatchupDigest({ now: NOW, includeRelay: false })

  const refusal = digest.refusals.find((entry) => entry.about === 'pendant-outbox')
  assert.ok(refusal)
  assert.match(refusal.refusal, /not readable from this Mac/)
})

/*
 * The relay is the half that stayed awake while the owner was away, so a
 * digest missing it is missing exactly the part they asked about. It must not
 * fail quietly.
 */
test('an unreachable relay leaves a named hole rather than a short list', async () => {
  const digest = await collectCatchupDigest({
    now: NOW,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
    relayUrl: 'http://localhost:9',
  })

  const refusal = digest.refusals.find((entry) => entry.about === 'relay')
  assert.ok(refusal)
  assert.match(refusal.refusal, /not in it/)
})

/*
 * The measurement rides the fetch that was happening anyway. This drives the
 * whole collector against a stubbed relay and asserts the offset came back
 * measured rather than assumed.
 */
test('collecting from the relay measures its clock off the same request', async () => {
  /*
   * The stamp is taken when the request is HANDLED, which is where a real relay
   * takes it — between this Mac sending and this Mac receiving. That placement
   * is the whole basis of the bracket, so the stub has to honour it; a stamp
   * taken after the response was already in hand would describe a relay that
   * answered before it was asked, and the code is right to call that
   * contradicted rather than measured.
   */
  const digest = await collectCatchupDigest({
    now: NOW,
    fetchImpl: async (url) => {
      const observedAt = new Date(Date.now() + 25_000).toISOString()
      return {
        ok: true,
        json: async () =>
          String(url).includes('/v1/routines')
            ? { recentRuns: [], observedAt }
            : { announcements: [], observedAt },
      }
    },
    relayUrl: 'http://relay.test',
  })

  assert.match(digest.clock.domains.relay.source, /^measured/)
  assert.ok(digest.clock.anchorsUsed >= 2)
})

/* ---------------------------------------------------------------- routes */

function fakeApp() {
  const routes = new Map()
  const app = { get: (route, handler) => routes.set(`GET ${route}`, handler) }
  const call = async (route, query = {}) => {
    const handler = routes.get(`GET ${route}`)
    assert.ok(handler, `no handler for GET ${route}`)
    let statusCode = 200
    let payload = null
    await handler(
      { query, params: {} },
      {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        },
      },
    )
    return { statusCode, payload }
  }
  return { app, call, routes }
}

/*
 * Every route is a GET. A digest that both reports and acts is a digest nobody
 * can trust to be complete, because it would have a reason to leave things
 * out — so this asserts the absence of a write path, not just the presence of
 * the reads.
 */
test('it mounts three read-only routes and no way to act on any of them', async () => {
  const { app, call, routes } = fakeApp()
  registerCatchupRoutes(app, { includeRelay: false })

  assert.deepEqual([...routes.keys()], [
    'GET /catchup',
    'GET /catchup/needs-me',
    'GET /catchup/refusals',
  ])
  assert.equal(typeof app.post, 'undefined', 'nothing here needed a POST')

  const digest = await call('/catchup', { hours: '6' })
  assert.equal(digest.payload.ok, true)
  assert.equal(digest.payload.readOnly, true)
  assert.match(digest.payload.note, /Nothing was retried, replayed, resumed/)
})

/*
 * The pendant has no screen and cannot render a timeline, so the closing
 * section is its own route — and it carries what it is NOT showing, because a
 * short list otherwise reads as a quiet gap.
 */
test('the needs-me route says what it left out', async () => {
  const { app, call } = fakeApp()
  registerCatchupRoutes(app, { includeRelay: false })

  const { payload } = await call('/catchup/needs-me')
  assert.equal(payload.readOnly, true)
  assert.equal(typeof payload.notShown.alreadyTold, 'number')
  assert.equal(typeof payload.notShown.stillComing, 'number')
  assert.match(payload.notShown.note, /has not been lost/)
})

test('the refusals route exposes the clock it had to assume', async () => {
  const { app, call } = fakeApp()
  registerCatchupRoutes(app, { includeRelay: false })

  const { payload } = await call('/catchup/refusals')
  assert.equal(payload.clock.reference, 'mac')
  assert.ok(Array.isArray(payload.refusals))
})

test('registration refuses anything that is not an Express-style app', () => {
  assert.throws(() => registerCatchupRoutes(null), /Express-style app/)
  assert.throws(() => registerCatchupRoutes({}), /Express-style app/)
})

/* The default horizon is borrowed from routines.DEFER_MAX_MS so the digest's
 * reach and the scheduler's patience end at the same moment. */
test('the default window is the same twelve hours the scheduler gives up after', () => {
  assert.equal(DEFAULT_GAP_MS, 12 * 60 * 60 * 1000)

  const digest = buildCatchupDigest({ events: [], now: NOW })
  assert.equal(digest.gap.from, new Date(NOW - DEFAULT_GAP_MS).toISOString())
})

test.after(() => fs.rmSync(WORKSPACE, { force: true, recursive: true }))
