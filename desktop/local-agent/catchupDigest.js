import {
  ASSUMED_SKEW_MS,
  causalAnchor,
  describeSkew,
  measureSkew,
  orderByCausality,
  toMillis,
  windowMembership,
} from './catchupClock.js'
import {
  CATCHUP_LABELS,
  eventsFromAnnouncements,
  eventsFromBriefingRuns,
  eventsFromBrowserSpool,
  eventsFromJobs,
  eventsFromLedgers,
  eventsFromPendantInbox,
  eventsFromPendantItems,
  eventsFromReviewQueue,
  eventsFromRoutineRuns,
  fingerprintEvent,
} from './catchupSources.js'
import { getLedger, listLedgers, ledgerLocation } from './actionLedger.js'
import { readBrowserSpool } from './browserSpool.js'
import {
  listBriefingRuns,
  reviewQueue,
  toldFingerprints,
  unheardRunIds,
} from './briefingQueue.js'
import { listBriefings } from './audioBrief.js'
import { readJobs } from './jobTracker.js'
import { RELAY_API_KEY, RELAY_URL } from './bridgeConfig.js'

/*
 * "I was offline — tell me what happened while I was away, in order, and what
 * still needs me."
 *
 * WHAT WAS MISSING, precisely. Every piece of this already existed and none of
 * it could be read as one account. /jobs says what the Mac was asked to do.
 * /journal says what its steps did. actionLedger.js says which steps were
 * merely INTENDED. browserSpool.js says which browser commands died unqueued.
 * cloud-relay/routines.js says which scheduled occurrences were missed,
 * retried or superseded. briefingQueue.js says what the owner was already
 * told. The pendant holds alerts and bookmarks on its own card.
 *
 * Six surfaces, six vocabularies, and — this is the part that matters — every
 * one of them blurs the same three things together. A row exists. Did it
 * HAPPEN, is it WAITING, or did its window CLOSE? "The email went out",
 * "the email is queued to go out", and "the email never went out and now
 * won't" are three different states of the owner's world, and reading any
 * single surface you cannot tell which one you are looking at.
 *
 * So this module makes exactly one claim per row and refuses to make the
 * others. The label vocabulary is closed (catchupSources.CATCHUP_LABELS) and
 * every row carries the evidence for its own label in `why`.
 *
 * IT ACTS ON NOTHING. Every route is GET. Nothing here retries a routine,
 * replays a browser command, resumes a ledger, plays a briefing or
 * acknowledges an alert — and browserSpool.js states the reason for its own
 * contents in a sentence this module adopts wholesale: "A replay is a thing
 * the owner asks for, in the moment they ask for it, from a list they can
 * see."
 *
 * ON ORDER, which is the hard part: see catchupClock.js. Short version —
 * causality comes from identifiers and never from timestamps; clock skew is
 * measured from the round trip of this module's own relay fetch, which is an
 * NTP round trip by another name; and any two rows whose uncertainty windows
 * overlap are reported as "around the same time" rather than given a false
 * order.
 */

export const CATCHUP_VERSION = 1

/*
 * How far back a digest looks when the owner does not say.
 *
 * Twelve hours, taken from routines.DEFER_MAX_MS, whose comment calls it "one
 * working day of lid-closed time" and uses it to decide when a deferred
 * occurrence has gone stale. Using the same number here means the digest's
 * horizon and the scheduler's patience end at the same moment: a routine the
 * relay gave up on is the last thing that falls inside the window that would
 * have reported it.
 */
export const DEFAULT_GAP_MS = 12 * 60 * 60 * 1000

/* Enough to cover a long gap without turning a digest into a data dump. Each
 * is a bound on records READ, not on rows shown; the digest is bounded again
 * by what falls inside the window. */
export const READ_LIMITS = Object.freeze({
  ledgers: 40,
  jobs: 80,
  briefingRuns: 20,
  routineRuns: 60,
  announcements: 60,
})

/* briefingTriage.timeBand's whole vocabulary. A finding the owner heard about
 * while it was still "later" carries a different fingerprint once it is
 * "overdue", by design — so checking one band would miss it. */
const BANDS = Object.freeze(['none', 'later', 'closing', 'overdue'])

const RELAY_TIMEOUT_MS = Number(process.env.CATCHUP_RELAY_TIMEOUT_MS || 4000)

/* ------------------------------------------------------------- the digest */

/**
 * Reconcile the surfaces into one ordered, labelled account. Pure: every input
 * is passed in, nothing is read and nothing is written.
 */
export function buildCatchupDigest({
  events = [],
  anchors = [],
  told = new Map(),
  from = null,
  to = null,
  now = Date.now(),
  reference = 'mac',
  unreadable = [],
} = {}) {
  const gapFrom = toMillis(from) ?? now - DEFAULT_GAP_MS
  const gapTo = toMillis(to) ?? now
  const skew = measureSkew(anchors, { reference })
  const refusals = []

  /*
   * Dedupe first, so a row the owner has already heard cannot be counted as
   * something that still needs them further down.
   */
  const marked = events.map((row) => markAsTold(row, told))

  /*
   * Window membership is computed against the SKEW-ADJUSTED position, not the
   * raw stamp, which is why it can return `edge`. A relay row three seconds
   * before the gap opened is genuinely ambiguous, and both possible mistakes
   * are bad: drop it and the owner never learns something happened while they
   * were away; keep it silently and they are shown something they have seen.
   * It is kept and marked.
   */
  const scoped = []
  for (const row of marked) {
    const membership = windowMembership(row.at, { from: gapFrom, to: gapTo }, skew)
    if (membership.inside === 'before' || membership.inside === 'after') continue
    scoped.push({ ...row, boundary: membership.inside, boundaryWhy: membership.reason })
    if (membership.inside === 'unknown') {
      refusals.push({
        kind: 'window',
        about: row.id,
        refusal:
          'This is included without a claim that it happened inside the gap: ' +
          `${membership.reason}.`,
      })
    }
  }

  const {
    ordered,
    clockConflicts,
    danglingEdges,
    cyclicIds,
    unresolvedAdjacencies,
    resolvedParents,
  } = orderByCausality(scoped, skew)

  const unresolvedBefore = new Map(
    unresolvedAdjacencies.map((pair) => [pair.after, pair]),
  )

  const timeline = ordered.map((row, index) => {
    const unresolved = unresolvedBefore.get(row.id)
    /* Parents as the ordering resolved them — an announcement naming a runId
     * comes back pointing at the occurrence row that is actually in this list,
     * not at the id the relay happened to write down. */
    const causes = resolvedParents.get(row.id) ?? []

    return {
      ...row,
      seq: index,
      /*
       * How this row relates to the one printed above it, and the only field
       * a renderer may turn into the word "then". `unknown` must render as
       * "around the same time".
       */
      afterPrevious: index === 0 ? null : unresolved ? 'unknown' : 'after',
      afterPreviousWhy: unresolved?.why ?? null,
      /*
       * Causality is reported ONLY where an identifier links the two records.
       * Adjacency in this list is never a cause, and a renderer that says
       * "because" without this field is inventing one.
       */
      becauseOf: causes.length ? causes : null,
      causeEvidence: causes.length
        ? `The two records name each other (${describeJoin(row.joins)}).`
        : null,
    }
  })

  for (const pair of unresolvedAdjacencies) {
    refusals.push({
      kind: 'order',
      about: pair.after,
      against: pair.before,
      refusal: `These two are shown next to each other without a claim about which came first: ${pair.why}.`,
    })
  }
  for (const conflict of clockConflicts) {
    refusals.push({
      kind: 'clock-conflict',
      about: conflict.event,
      against: conflict.cause,
      refusal: conflict.note,
    })
  }
  if (danglingEdges) {
    refusals.push({
      kind: 'missing-record',
      refusal:
        `${danglingEdges} row(s) point at a record that is not in this digest — a bounded store dropped it, ` +
        'or it fell outside the window. Their place in the order rests on clocks alone.',
    })
  }
  for (const id of cyclicIds) {
    refusals.push({
      kind: 'cycle',
      about: id,
      refusal:
        'Two records each claim to have caused the other. This row is shown, but its position is not a claim.',
    })
  }
  for (const surface of unreadable) {
    refusals.push({
      kind: 'unreadable-surface',
      about: surface.surface,
      refusal: surface.why,
    })
  }
  /* An assumed clock is a refusal to measure, named by the clock it is about,
   * so a reader can tell "the relay was guessed at" from "the pendant was". */
  const skewNotes = describeSkew(skew)
  for (const entry of skewNotes) {
    if (!entry.measured) refusals.push({ kind: 'skew', about: entry.domain, refusal: entry.note })
  }

  /*
   * WHAT STILL NEEDS THE OWNER — the last section, and the only one that is
   * allowed to be short.
   *
   * The rule is not "everything that is not occurred". A `queued` row is the
   * system working: a retry is scheduled, a deferred routine is waiting for
   * the lid to open, an alert is sitting on the pendant. Putting those in
   * front of the owner trains them to ignore the list. What lands here is:
   *
   *   indeterminate  always, by definition — nobody but the owner can settle
   *                  whether a dispatched-and-unanswered action took effect.
   *   failed         it was attempted, it did not work, nothing will retry.
   *   expired        its window closed, so it will not happen on its own.
   *   queued         only when it is waiting ON THE OWNER rather than on the
   *                  system — an unplayed briefing, an open review item.
   *
   * minus anything they have already been told, in the same words.
   */
  const stillNeedsYou = timeline
    .filter((row) => row.needsOwner && row.alreadyTold?.match !== 'exact')
    .sort((left, right) => needsRank(left) - needsRank(right) || left.seq - right.seq)
    .map((row) => ({
      id: row.id,
      surface: row.surface,
      label: row.label,
      title: row.title,
      why: row.needsOwnerReason ?? row.why,
      suggestion: row.suggestion,
      where: row.where,
      /* Said rather than implied: the digest changes nothing by being read. */
      acted: false,
      previouslyTold: row.alreadyTold?.match === 'other-band' ? row.alreadyTold : null,
    }))

  const counts = {}
  for (const label of CATCHUP_LABELS) {
    counts[label] = timeline.filter((row) => row.label === label).length
  }

  return {
    ok: true,
    readOnly: true,
    version: CATCHUP_VERSION,
    gap: {
      from: new Date(gapFrom).toISOString(),
      to: new Date(gapTo).toISOString(),
      spanMs: Math.max(0, gapTo - gapFrom),
    },
    clock: {
      reference: skew.reference,
      domains: skew.domains,
      notes: skewNotes,
      anchorsUsed: skew.usableAnchors,
      anchorsRefused: skew.unusableAnchors,
    },
    counts,
    labels: CATCHUP_LABELS,
    /*
     * The vocabulary, written into the payload rather than left to a reader's
     * intuition. The whole feature is these five sentences being kept apart.
     */
    legend: {
      occurred: 'It happened. Something that did it recorded that it finished.',
      queued: 'It has not happened and nothing has been lost — it is still coming.',
      expired: 'Its window closed before it could happen. Nobody failed; time ran out.',
      failed: 'It was attempted, it returned an error, and nothing will attempt it again.',
      indeterminate:
        'It was handed over and never answered for. Whether it happened is genuinely unknown, and only you can settle it.',
    },
    alreadyToldCount: timeline.filter((row) => row.alreadyTold?.match === 'exact').length,
    timeline,
    stillNeedsYou,
    refusals,
    spoken: speakDigest({ timeline, stillNeedsYou, counts, gapFrom, gapTo }),
  }
}

/* Highest attention first: an unknown outcome outranks a known failure,
 * because the failure at least tells the owner where they stand. */
const NEEDS_ORDER = { indeterminate: 0, failed: 1, expired: 2, queued: 3, occurred: 4 }
const needsRank = (row) => NEEDS_ORDER[row.label] ?? 5

function describeJoin(joins = {}) {
  const named = Object.entries(joins)
    .filter(([, value]) => value)
    .map(([key]) => key)
  return named.length ? named.join(', ') : 'a shared identifier'
}

/**
 * Has the owner already heard this, and in what framing?
 *
 * Two answers, not one. An EXACT fingerprint match means they were told this
 * thing in this urgency band, and re-telling it is the noise this check
 * exists to prevent. A match in a DIFFERENT band means they were told about
 * the same thing when it read differently — "your form is due Thursday" when
 * it is now overdue. briefingTriage.js deliberately makes that a different
 * fingerprint because it is genuinely news again, so it is kept and annotated
 * rather than suppressed: the digest says "you have heard about this, and it
 * has changed".
 */
function markAsTold(row, told) {
  const fingerprints = BANDS.map((band) => ({ band, fingerprint: fingerprintEvent(row, band) }))
  const exact = fingerprints.find((entry) => entry.band === 'none' && entry.fingerprint)
  const hit = fingerprints.find((entry) => entry.fingerprint && told.has(entry.fingerprint))

  if (!hit) {
    return { ...row, fingerprint: row.fingerprint ?? exact?.fingerprint ?? null, alreadyTold: null }
  }

  const entry = told.get(hit.fingerprint)
  return {
    ...row,
    fingerprint: row.fingerprint ?? exact?.fingerprint ?? null,
    alreadyTold: {
      match: hit.band === 'none' ? 'exact' : 'other-band',
      band: hit.band,
      at: entry?.at ?? null,
      headline: entry?.headline ?? null,
      runId: entry?.runId ?? null,
    },
  }
}

/**
 * The account, out loud.
 *
 * Ordered by the timeline and NOT by importance, because the owner asked for
 * what happened in order. The one place ranking is allowed is the closing
 * section, which is the answer to the other half of their question.
 */
export function speakDigest({ timeline = [], stillNeedsYou = [], counts = {}, gapFrom, gapTo }) {
  const hours = Math.max(1, Math.round((gapTo - gapFrom) / 3_600_000))
  const fresh = timeline.filter((row) => row.alreadyTold?.match !== 'exact')

  if (!fresh.length) {
    return `Nothing new happened in the last ${hours} hour(s) that you have not already heard about.`
  }

  const lines = [`Here is the last ${hours} hour(s), in order.`]

  fresh.slice(0, 12).forEach((row, index) => {
    /*
     * Each of these four words is a different claim, and only one of them is a
     * claim about sequence.
     *
     *   Then                   the clocks separated this row from the one read
     *                          out before it, and that row is its immediate
     *                          neighbour in the timeline.
     *   Around the same time   the two overlap inside the clock uncertainty.
     *   Also                   something between them was skipped as already
     *                          heard, so this row's relation to what was just
     *                          said is not the relation the timeline recorded.
     *                          No claim is made.
     *   First                  it opens the account.
     */
    const previous = index === 0 ? null : fresh[index - 1]
    const adjacentInTimeline = previous ? previous.seq === row.seq - 1 : false
    const joiner =
      index === 0
        ? 'First'
        : !adjacentInTimeline
          ? 'Also'
          : row.afterPrevious === 'unknown'
            ? 'Around the same time'
            : 'Then'
    /* "because" is only ever spoken off an identifier join. */
    const because = row.becauseOf ? ', because of the item above it' : ''
    lines.push(`${joiner}: ${row.title} — ${verbFor(row.label)}${because}. ${row.why}`)
  })

  if (fresh.length > 12) {
    lines.push(`${fresh.length - 12} more item(s) are in the full list.`)
  }

  const unknown = counts.indeterminate ?? 0
  if (unknown) {
    lines.push(
      `${unknown} of those were handed over and never answered for, so whether they happened is genuinely unknown.`,
    )
  }

  if (!stillNeedsYou.length) {
    lines.push('Nothing from the gap needs you.')
  } else {
    lines.push(`${stillNeedsYou.length} thing(s) still need you.`)
    for (const item of stillNeedsYou.slice(0, 5)) {
      lines.push(`${item.title}: ${item.why}`)
    }
  }

  return lines.join(' ')
}

const VERBS = {
  occurred: 'it happened',
  queued: 'it is queued and still coming',
  expired: 'its window closed and it never ran',
  failed: 'it failed',
  indeterminate: 'nobody recorded whether it happened',
}
const verbFor = (label) => VERBS[label] ?? label

/* ------------------------------------------------------------- collecting */

/**
 * Read every surface this Mac can reach and build the digest from them.
 *
 * Each source is wrapped: a store that cannot be read produces a named entry in
 * `unreadable` and the digest continues. A catch-up digest that refuses to
 * answer because one of six stores is corrupt is worse than one that answers
 * and says which eye it is missing — and silently returning a short list would
 * be worst of all, because a short list reads as "not much happened".
 */
export async function collectCatchupDigest({
  from = null,
  to = null,
  now = Date.now(),
  filePath = ledgerLocation(),
  fetchImpl = fetch,
  relayUrl = RELAY_URL,
  apiKey = RELAY_API_KEY,
  includeRelay = true,
  /*
   * The pendant's OUTBOX — bookmarks and voice memos it held on its card — is
   * injected, because this Mac genuinely cannot read it. See the refusal
   * recorded below; the shape is documented on eventsFromPendantItems.
   */
  pendantItems = [],
  heldAlerts = 0,
} = {}) {
  const events = []
  const unreadable = []
  const anchors = []

  const read = (surface, why, run) => {
    try {
      return run()
    } catch (error) {
      unreadable.push({ surface, why: `${why} (${String(error?.message ?? error)})` })
      return null
    }
  }

  /* ---- this Mac ---- */

  const ledgers = read('action-ledger', 'Plan manifests could not be read', () => {
    const summaries = listLedgers({ filePath, limit: READ_LIMITS.ledgers }).ledgers ?? []
    return summaries
      .map((summary) => getLedger(summary.ledgerId, { filePath }))
      .filter(Boolean)
  })
  if (ledgers) events.push(...eventsFromLedgers(ledgers, { now }))

  const spool = read('browser-spool', 'The browser spool could not be read', () =>
    readBrowserSpool({}),
  )
  if (spool) events.push(...eventsFromBrowserSpool(spool))

  const jobs = read('mac-job', 'The job store could not be read', () =>
    readJobs().slice(0, READ_LIMITS.jobs),
  )
  if (jobs) events.push(...eventsFromJobs(jobs, { now }))

  /*
   * COMPOSED IS NOT HEARD. briefingQueue.js was written after a briefing that
   * was composed, marked its findings told, and then went unplayed — after
   * which the next run said "nothing needs you right now" and overwrote the
   * audio nobody had heard. The exclusion below is the fix for that, and it
   * has to happen HERE rather than in the digest, because the played flag
   * lives on audioBrief.js's shelf and briefingQueue.js deliberately does not
   * import it.
   */
  const unplayed = read('briefing-shelf', 'The briefing shelf could not be read', () =>
    listBriefings({ limit: 40 })
      .filter((briefing) => !briefing.played)
      .map((briefing) => briefing.id),
  )
  const unheard = read('briefing-queue', 'The briefing ledger could not be read', () =>
    unheardRunIds({ unplayedBriefingIds: unplayed ?? [] }),
  )

  const briefingRuns = read('briefing', 'Past briefings could not be read', () =>
    listBriefingRuns({ limit: READ_LIMITS.briefingRuns }),
  )
  if (briefingRuns) {
    events.push(...eventsFromBriefingRuns(briefingRuns, { unheardRunIds: unheard ?? [] }))
  }

  const queue = read('review-queue', 'The review queue could not be read', () => reviewQueue({ now }))
  if (queue) events.push(...eventsFromReviewQueue(queue))

  const told =
    read('told-ledger', 'What you have already been told could not be read', () =>
      toldFingerprints({ now, excludeRunIds: unheard ?? [] }),
    ) ?? new Map()

  /* ---- the relay ---- */

  if (includeRelay) {
    const relay = await readRelay({ fetchImpl, relayUrl, apiKey, now })
    if (relay.ok) {
      events.push(...eventsFromRoutineRuns(relay.runs, { now }))
      events.push(...eventsFromAnnouncements(relay.announcements, { now }))
      anchors.push(...relay.anchors)
    } else {
      unreadable.push({
        surface: 'relay',
        why:
          `The relay could not be reached (${relay.reason}), so scheduled occurrences and ` +
          'announcements are missing from this account. Anything the relay did while you were away is not in it.',
      })
    }
  }

  /* ---- the pendant ---- */

  events.push(...eventsFromPendantItems(pendantItems))
  events.push(...eventsFromPendantInbox({ heldAlerts, observedAt: now }))

  if (!pendantItems.length) {
    unreadable.push({
      surface: 'pendant-outbox',
      why:
        'Bookmarks and voice memos the pendant held on its own card are not readable from this Mac — ' +
        'they only become visible once the device forwards them to the relay. If you pressed the ' +
        'button while it was offline and it has not reconnected, that press is not in this account.',
    })
  }

  return buildCatchupDigest({ events, anchors, told, from, to, now, unreadable })
}

/*
 * Fetch the relay's half AND measure the clock offset in the same round trip.
 *
 * THE MEASUREMENT IS THE POINT, and it is free. Stamp the request on this Mac,
 * read the relay's own `observedAt` out of the response, stamp the arrival on
 * this Mac. Those three readings say:
 *
 *     requestedAt (mac)  happened-before  observedAt (relay)
 *     observedAt (relay) happened-before  receivedAt  (mac)
 *
 * which is exactly NTP's round-trip argument, and it brackets the relay's
 * offset to within the round-trip time — typically tens of milliseconds, far
 * tighter than the 3-minute assumption catchupClock falls back to. It requires
 * no new endpoint, no clock protocol and no change to the relay: `observedAt`
 * is already on both of these responses because somebody wanted a freshness
 * stamp.
 *
 * The two anchors are ordinary causal anchors and go through the same
 * measureSkew as any other, so nothing here is a special case.
 */
async function readRelay({ fetchImpl, relayUrl, apiKey, now }) {
  if (!relayUrl) return { ok: false, reason: 'no relay is configured' }

  const call = async (path) => {
    const requestedAt = Date.now()
    const response = await fetchImpl(`${String(relayUrl).replace(/\/$/, '')}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    })
    const receivedAt = Date.now()
    if (!response.ok) throw new Error(`status ${response.status}`)
    return { payload: await response.json(), requestedAt, receivedAt }
  }

  try {
    const routines = await call('/v1/routines')
    let announcements = { payload: {}, requestedAt: now, receivedAt: now }
    try {
      announcements = await call('/v1/announcements?limit=60')
    } catch {
      /* One endpoint answering and the other not is a partial read, not a
       * failed one: the routine half is still worth having. */
    }

    const anchors = []
    for (const leg of [routines, announcements]) {
      const observedAt = toMillis(leg.payload?.observedAt)
      if (observedAt === null) continue
      anchors.push(
        causalAnchor({
          before: { domain: 'mac', at: leg.requestedAt },
          after: { domain: 'relay', at: observedAt },
          why: 'this Mac sent the request before the relay stamped its reply',
        }),
        causalAnchor({
          before: { domain: 'relay', at: observedAt },
          after: { domain: 'mac', at: leg.receivedAt },
          why: 'the relay stamped its reply before this Mac received it',
        }),
      )
    }

    return {
      ok: true,
      runs: Array.isArray(routines.payload?.recentRuns) ? routines.payload.recentRuns : [],
      announcements: Array.isArray(announcements.payload?.announcements)
        ? announcements.payload.announcements
        : [],
      anchors,
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/* ------------------------------------------------------------------ HTTP */

/**
 * Mount the digest. A registration function rather than routes written into
 * server.js, for the same reason actionLedgerRoutes.js is one: that file is a
 * hundred kilobytes of shared surface with several people in it at once, and a
 * module that mounts in one line is a module that does not collide.
 *
 *     registerCatchupRoutes(app)
 *
 * EVERY ROUTE IS GET AND CHANGES NOTHING. If you are here to add a route that
 * clears the spool, plays the waiting briefing, acknowledges an alert or
 * resumes a ledger, put it next to the surface that owns that state. A digest
 * that both reports and acts is a digest nobody can trust to be complete,
 * because it would have a reason to leave things out.
 */
export function registerCatchupRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new Error('registerCatchupRoutes requires an Express-style app.')
  }

  const build = async (request) => {
    const sinceMs = toMillis(request.query?.since)
    const hours = Number(request.query?.hours)
    const from =
      sinceMs ??
      (Number.isFinite(hours) && hours > 0 ? Date.now() - hours * 3_600_000 : null)

    return collectCatchupDigest({
      from,
      to: toMillis(request.query?.until),
      includeRelay: String(request.query?.relay ?? '') !== 'false',
      heldAlerts: Number(request.query?.heldAlerts) || 0,
      ...options,
    })
  }

  /* The whole account: ordered, labelled, deduped, ending in what needs them. */
  app.get('/catchup', async (request, response) => {
    try {
      const digest = await build(request)
      response.json({
        ...digest,
        note:
          'Read-only. Nothing was retried, replayed, resumed, played or acknowledged to produce this. ' +
          'Every item is labelled with one of five outcomes and carries the evidence for that label.',
      })
    } catch (error) {
      response.status(500).json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  /*
   * Just the closing section. Separate because it is what a device with no
   * screen asks for — the pendant cannot render a timeline, and asking it to
   * download one to speak five lines is the wrong shape.
   */
  app.get('/catchup/needs-me', async (request, response) => {
    try {
      const digest = await build(request)
      response.json({
        ok: true,
        readOnly: true,
        gap: digest.gap,
        count: digest.stillNeedsYou.length,
        items: digest.stillNeedsYou,
        /* Named so a caller cannot mistake a short list for a quiet gap. */
        notShown: {
          alreadyTold: digest.alreadyToldCount,
          stillComing: digest.counts.queued,
          note: 'Queued work is not listed here: it has not been lost and nothing is waiting on you for it.',
        },
        refusals: digest.refusals,
      })
    } catch (error) {
      response.status(500).json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  /*
   * What this digest could not see, and what it declined to claim.
   *
   * Its own route because it is the part a reader is least likely to scroll to
   * and most needs: a gap account with a blind spot in it looks exactly like a
   * quiet gap, and the difference is everything.
   */
  app.get('/catchup/refusals', async (request, response) => {
    try {
      const digest = await build(request)
      response.json({
        ok: true,
        readOnly: true,
        clock: digest.clock,
        refusals: digest.refusals,
        note:
          'Each entry is something this digest could have guessed and did not. ' +
          `Where no clock could be measured, comparisons fall back to an assumed ±${ASSUMED_SKEW_MS}ms.`,
      })
    } catch (error) {
      response.status(500).json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  return app
}
