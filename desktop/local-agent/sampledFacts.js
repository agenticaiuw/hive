/*
 * A value the host reported once is not a choice the owner made.
 *
 * memoryService gives `preference` a null TTL and pins it against idle
 * eviction. That is right for something the owner chose — an editor preference
 * does not go stale because nobody read it for a month. It is applied unchanged
 * to facts whose source.origin is "machine": values sampled from the host once
 * and then pinned forever, never re-read, and rendered in the prompt in exactly
 * the same shape as a stated choice.
 *
 * The live store shows what that produces. preference.timezone holds
 * "America/Chicago" at confidence 0.99 with expiresAt null and a useCount over
 * five thousand, while this machine reports America/New_York. The projection
 * layer of the day sorted ## Owner by confidence, so it sat at the head of
 * every projection, reaching voice instructions and the local planner. On
 * the background tier machineContext puts the true reading in the system
 * prompt, so one call carries both values, contradicting each other, with
 * nothing marking either as sampled.
 *
 * THREE DELIBERATE NON-DECISIONS, because the failure here was a machine
 * quietly deciding something and this must not repeat it one layer up:
 *
 *   1. A stale sample is never deleted. Expiry would resolve the disagreement
 *      by discarding one side, and the owner would never learn there was one.
 *      Staleness marks a fact for RE-READING, which is a different act.
 *   2. A disagreement is never resolved. Both values are carried, both are
 *      labelled with where they came from, and the owner picks. A sampled
 *      reading is not automatically right — a laptop in a hotel reports the
 *      hotel's zone, and the owner's answer may still be home.
 *   3. Confidence is not adjusted downward on a disputed fact. Silently
 *      demoting it would reorder the prompt and hide the row, which is the
 *      quiet resolution this is built to prevent.
 *
 * Owner-origin facts are untouched by all of this. Nothing here re-reads,
 * re-checks or annotates something the owner said.
 */

/*
 * How long a sampled reading is taken on trust.
 *
 * Seven days is a compromise with a reason on both sides: shorter and a laptop
 * that travels for a weekend is re-read into a dispute it will resolve itself
 * by Monday; longer and a genuine move stays wrong for most of a month. It is
 * not a TTL — nothing expires at seven days — it is when the value stops being
 * assumed and starts being checked.
 */
export const SAMPLE_RECHECK_MS = 7 * 24 * 60 * 60 * 1000

export const MACHINE_ORIGIN = 'machine'

/** Was this value sampled from the host rather than stated by the owner? */
export function isSampled(fact) {
  return String(fact?.source?.origin || '') === MACHINE_ORIGIN
}

/**
 * Is a sampled fact old enough to be worth re-reading?
 *
 * Reads `source.at` — when the sample was TAKEN — not updatedAt, which the
 * store bumps for reasons that have nothing to do with the host being re-read.
 * A fact whose sample time is unrecorded is due immediately: an unknown
 * sampling date is not evidence of freshness.
 */
export function needsRecheck(fact, { now = Date.now(), window = SAMPLE_RECHECK_MS } = {}) {
  if (!isSampled(fact)) return false
  const takenAt = Date.parse(fact?.source?.at ?? '')
  if (!Number.isFinite(takenAt)) return true
  return now - takenAt >= window
}

/**
 * Compare a stored sample against what the host says now.
 *
 * `observe` is injected rather than imported so this stays testable without a
 * host, and so a caller can check one fact without dragging in every probe the
 * machine knows how to run. A probe that throws or returns nothing yields
 * 'unknown' — an unreadable host is not evidence that the stored value is
 * wrong, and treating it as such would manufacture disputes during an outage.
 */
export function checkSample(fact, { observe, now = Date.now() } = {}) {
  if (!isSampled(fact)) return { status: 'not-sampled' }

  let observed
  try {
    observed = observe ? observe(fact) : null
  } catch {
    observed = null
  }

  const seen = typeof observed === 'string' ? observed.trim() : ''
  if (!seen) return { status: 'unknown', checkedAt: new Date(now).toISOString() }

  const stored = String(fact.value ?? '').trim()
  if (stored === seen) {
    return { status: 'agrees', observed: seen, checkedAt: new Date(now).toISOString() }
  }
  return { status: 'disputed', observed: seen, checkedAt: new Date(now).toISOString() }
}

/**
 * The dispute record to attach to a fact. Never replaces `value`.
 *
 * Keeping the stored value in place is the whole point: overwriting it with the
 * fresh reading would be the machine settling the question, and the owner would
 * see a corrected fact rather than a choice they were owed.
 */
export function disputeFor(fact, check) {
  if (check?.status !== 'disputed') return null
  return {
    stored: String(fact.value ?? ''),
    observed: check.observed,
    checkedAt: check.checkedAt,
    sampledAt: fact?.source?.at ?? null,
    note: 'Sampled from this machine, never stated by the owner. Both readings are kept; the owner decides.',
  }
}

/**
 * How a sampled fact should read in a prompt.
 *
 * A model cannot tell a sampled reading from a stated choice, and on the
 * evidence it does not need to be able to guess — it needs to be told. A
 * disputed fact renders BOTH values, because rendering one is a decision.
 *
 * Owner-origin facts return null: they are already exactly what they claim to
 * be, and annotating them would spend tokens saying so.
 */
export function provenanceSuffix(fact) {
  if (!isSampled(fact)) return ''
  if (fact?.dispute?.observed) {
    return ` (this Mac now reports "${fact.dispute.observed}"; the stored value was sampled${
      fact.dispute.sampledAt ? ` ${fact.dispute.sampledAt.slice(0, 10)}` : ''
    }, not stated by you — unresolved)`
  }
  return ' (sampled from this Mac, not stated by you)'
}

/*
 * WHAT A RE-READ NEEDS, AND WHY IT CANNOT RUN ON TODAY'S FACTS.
 *
 * A sampled fact records only origin and the time it was taken. It does not
 * record HOW it was sampled, so there is no general way to re-read it — and
 * there must not be a table here mapping `preference.timezone` to a timezone
 * probe, because that is a per-fact special case masquerading as a mechanism,
 * and the next sampled key would need another one.
 *
 * So the probe is named by the writer, in the fact's own source, and this
 * resolves it against a registry the caller supplies. Facts written before this
 * existed report `unverifiable` — which is the honest verdict and a more useful
 * one than silently trusting them, because it says exactly what is missing.
 */
export function reviewSampledFacts(
  { facts = [], probes = {}, now = Date.now(), window = SAMPLE_RECHECK_MS } = {},
) {
  const reviewed = []
  for (const fact of facts) {
    if (!isSampled(fact)) continue

    const probeName = fact?.source?.probe || null
    const base = {
      key: fact.key,
      value: fact.value,
      sampledAt: fact?.source?.at || null,
      due: needsRecheck(fact, { now, window }),
      probe: probeName,
    }

    if (!probeName || typeof probes[probeName] !== 'function') {
      reviewed.push({
        ...base,
        status: 'unverifiable',
        why: probeName
          ? `No probe named "${probeName}" was supplied, so this cannot be re-read.`
          : 'This fact does not record how it was sampled, so nothing can re-read it. Writers should set source.probe.',
      })
      continue
    }

    const check = checkSample(fact, { observe: () => probes[probeName](fact), now })
    reviewed.push({
      ...base,
      status: check.status,
      observed: check.observed ?? null,
      checkedAt: check.checkedAt ?? null,
      ...(check.status === 'disputed' ? { dispute: disputeFor(fact, check) } : {}),
    })
  }

  const disputed = reviewed.filter((entry) => entry.status === 'disputed')
  return {
    reviewed,
    counts: {
      total: reviewed.length,
      disputed: disputed.length,
      unverifiable: reviewed.filter((entry) => entry.status === 'unverifiable').length,
      due: reviewed.filter((entry) => entry.due).length,
    },
    /* Stated rather than implied: a caller that reads only the counts should
     * still learn that nothing here was decided for the owner. */
    note: disputed.length
      ? 'Both readings are kept. Nothing was changed, and the disagreement is the owner’s to settle.'
      : 'Nothing disputed.',
  }
}

/*
 * NO ROUTE HERE, DELIBERATELY.
 *
 * A registerSampledFactRoutes was written and then removed, because
 * routeRegistration.test.js failed it: server.js is out of scope for this
 * change, so the route would have been the seventh register function in this
 * repo exported and mounted by nothing — shipped, tested, and unreachable. The
 * guard was written earlier today after six of those, four of them mine, and it
 * caught the seventh inside an hour.
 *
 * The surface that matters is already live and needs no route: provenanceSuffix
 * puts the annotation in ## Owner, which reaches both the Realtime voice
 * instructions and the local planner. reviewSampledFacts is exported for a
 * caller that wants the structured report; mounting it is one line in
 * server.js whenever that file is in scope:
 *
 *   app.get('/memory/sampled', (_req, res) =>
 *     res.json({ ok: true, readOnly: true, ...reviewSampledFacts({ facts: listFacts(), probes }) }))
 *
 * If it is mounted, it stays READ-ONLY with no PUT or DELETE twin. An
 * "accept the host reading" button would put a one-click resolution next to a
 * disagreement the owner may not have read yet, and the point is that the
 * machine does not settle this.
 */
