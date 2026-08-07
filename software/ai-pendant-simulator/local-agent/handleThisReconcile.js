/*
 * Reconciliation: what several readings of the same question actually add up to.
 *
 * The premise of the panel (handleThisPanel.js) is that one reader of a page
 * behind the owner's login is a single point of failure nobody can check —
 * there is no second copy of their order history to compare against. So several
 * inspectors read it through different lenses and this module says what they
 * amount to.
 *
 * The temptation is to blend. Take the modal answer, or the highest-confidence
 * one, and hand back a single string. That is the wrong shape: it converts "two
 * of your tabs say different things about your bill" into "your bill is $41.98",
 * which is a worse answer than saying nothing, because the owner now believes a
 * number that was in dispute and has no way to learn that it was.
 *
 * So this module is allowed to report agreement, and it is allowed to report
 * disagreement, and it is NOT allowed to convert the second into the first.
 *
 * ── The trap this is mostly built around ───────────────────────────────────
 *
 * Counting inspectors is not counting evidence. Three inspectors reading one
 * cached page are one observation with three names on it, and if their tally
 * outvotes a fourth inspector who read a different page, the majority is pure
 * theatre — every vote in it traces to the same bytes, so every vote in it is
 * wrong together whenever those bytes are wrong.
 *
 * Everything below therefore counts SIGHTINGS — distinct content hashes, taken
 * from the evidence capsules in evidenceCapsules.js — and never inspectors. An
 * inspector count appears in the output only as description. It never decides
 * anything. `voiceCount` vs `distinctEvidence` in a verdict is exactly this
 * distinction and the tests pin it.
 *
 * Three separate ways several readings are secretly one, all of which have to
 * be caught before any comparison happens:
 *
 *   1. The bridge deduplicated the command. browserBridge.enqueueBrowserCommand
 *      returns `deduplicated: true` when two enqueues share an idempotency key —
 *      one browser command, two callers. Their agreement is a tautology.
 *   2. The capsule collapsed. evidenceCapsules mints content-addressed, so two
 *      inspectors that hash to the same capsule id are the same observer on the
 *      same bytes. Also one voice.
 *   3. Distinct capsules, identical contentHash. Genuinely two readers, but not
 *      two pieces of evidence: a page that lies lies to both.
 *
 * Only the third is even partial corroboration, and it is labelled as such
 * rather than being allowed to read as independent confirmation.
 *
 * THIS DECIDES NOTHING ABOUT THE BROWSER. Nothing here can queue, delay or
 * alter a browser command; it is handed readings that already happened. It also
 * never submits, clicks or writes — reconciliation is arithmetic over evidence.
 */

/* ------------------------------------------------------------- admissibility */

/*
 * The only judgements this module is allowed to make unilaterally.
 *
 * These drop a reading BEFORE the vote, and none of them is "this answer looks
 * wrong". They are all "this reading cannot be shown to the owner at all", which
 * is a different act: excluding evidence that has no standing is not picking a
 * winner among evidence that does.
 */
export const INADMISSIBLE = Object.freeze({
  errored: 'the read itself failed, so there is no reading to weigh',
  revoked: 'the owner revoked this source, so its reading may not be shown',
  expired: 'the capsule is past its TTL and is no longer current evidence',
  retired: 'the body aged out of the store, leaving only a tombstone',
  unknown: 'no capsule backs this reading, so there is nothing to trace it to',
  lowConfidence: 'the capture scored too low to stand on',
})

/*
 * Below this a capture is not evidence.
 *
 * evidenceCapsules.scoreCapture starts at 1 and subtracts: 0.4 for an empty
 * read, 0.35 for landing on a different host. 0.35 is deliberately under the
 * cheapest single deduction, so a reading is only dropped when TWO things went
 * wrong with it — one redirect alone is a caveat to report, not grounds to
 * silence a reading the owner might want to see.
 */
export const CONFIDENCE_FLOOR = 0.35

/*
 * Past this gap, two readings of the same page are two states of it.
 *
 * Under it, "the total changed" is more likely to be two lenses catching a page
 * mid-update than the page genuinely moving. Over it, calling them a
 * disagreement would be wrong in the other direction: nobody thinks a price
 * quoted this morning and a different price now are in conflict.
 */
export const REVISION_WINDOW_MS = 90_000

/* ------------------------------------------------------------------ answers */

/** The comparable form of an answer: whitespace collapsed, trailing punctuation
 * and space dropped. The displayed answer keeps its own spelling — this is only
 * what gets compared. */
export function normalizeAnswer(value) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').replace(/[\s.,;]+$/, '').trim()
  return text || null
}

/**
 * The same answer written two ways.
 *
 * "$41.98" from the receipt and "41.98" from the form field are not two
 * opinions about the total, and reporting them as a conflict would train the
 * owner to ignore conflicts. Alphanumerics only, so currency symbols, thin
 * spaces and separators stop mattering while the digits do not.
 *
 * Case is folded too, which is the one judgement call here. It costs the
 * ability to see a genuine case-only difference; it buys not reporting a
 * conflict every time one lens picks up a heading and the other picks up the
 * same words through a `text-transform: uppercase`, which is a real and common
 * way for two correct readings of one page to differ in case alone. Both
 * spellings are kept and surfaced on the verdict (`spellings`), so the
 * difference is shown to the owner rather than discarded — it is just not
 * called a disagreement.
 */
export function looseAnswer(value) {
  const text = normalizeAnswer(value)
  if (text === null) return null
  const stripped = text.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return stripped || null
}

/* ------------------------------------------------------------- one reading */

/**
 * Whether a reading may be weighed at all, and why not when it may not.
 *
 * `capsuleState` is evidenceCapsules' word, not ours — passing it through means
 * a revocation the owner performed after the read still takes this reading out
 * of the answer, because state is derived on read over there rather than
 * frozen at capture.
 */
export function admitReading(reading = {}, { confidenceFloor = CONFIDENCE_FLOOR } = {}) {
  if (reading.error) {
    return { admitted: false, reason: INADMISSIBLE.errored, detail: String(reading.error) }
  }

  const state = reading.capsuleState ?? null

  /*
   * No capsule at all is admissible; a capsule in a non-live state is not.
   *
   * A reading can legitimately arrive uncapsuled — an older extension, or a
   * lens whose result nothing minted for. That is a provenance gap to declare
   * (see corroborationOf, which refuses to call such readings independent), not
   * grounds to throw the reading away. But a capsule that EXISTS and is revoked
   * or expired is a positive instruction about what may be shown, and it wins.
   */
  if (state && state !== 'live') {
    return {
      admitted: false,
      reason: INADMISSIBLE[state] ?? INADMISSIBLE.unknown,
      detail: reading.capsuleId ?? null,
    }
  }

  const score = reading.confidence?.score
  if (Number.isFinite(score) && score < confidenceFloor) {
    return {
      admitted: false,
      reason: INADMISSIBLE.lowConfidence,
      detail: (reading.confidence?.reasons ?? []).join('; ') || `score ${score}`,
    }
  }

  return { admitted: true, reason: null, detail: null }
}

/*
 * Which sighting a reading belongs to — the identity of the bytes it read.
 *
 * The content hash does most of the work, and it does it for free: capsule
 * collapse in evidenceCapsules already means byte-identical content, so two
 * readings whose capsules collapsed arrive with the same hash and group here
 * without having to declare anything about each other.
 *
 * `sharedWith` is for the case the hash cannot cover: a reading the BRIDGE
 * deduplicated (browserBridge returned an existing command for a repeated
 * idempotency key) may carry no capsule of its own at all, because there was
 * only ever one fetch. Such a reading names the inspector it duplicated and is
 * pinned to that inspector's sighting. Left unpinned it would key on its own
 * name, become a second sighting, and manufacture exactly the independent
 * corroboration this module exists to refuse.
 *
 * A reading with no hash and no duplication claim gets a sighting of its own —
 * but see corroborationOf, which will not call such a group independent, since
 * there is no way to prove it read different bytes from anyone else.
 */
function sightingKeyOf(reading) {
  if (reading.contentHash) return `hash:${reading.contentHash}`

  const shared =
    reading.deduplicated || reading.collapsed ? reading.sharedWith?.[0] : null
  return `unhashed:${shared ?? reading.inspector ?? 'anonymous'}`
}

/**
 * Collapse readings into sightings: one entry per distinct set of bytes.
 *
 * The returned `inspectors` array is description. The array length is the thing
 * that must never be used as a weight, and nothing downstream of here does.
 */
export function groupSightings(readings = []) {
  const byKey = new Map()

  for (const reading of readings) {
    const key = sightingKeyOf(reading)
    const existing = byKey.get(key)

    if (!existing) {
      byKey.set(key, {
        sightingKey: key,
        hashed: Boolean(reading.contentHash),
        contentHash: reading.contentHash ?? null,
        sourceKey: reading.sourceKey ?? null,
        regionKey: reading.regionKey ?? null,
        capsuleIds: reading.capsuleId ? [reading.capsuleId] : [],
        inspectors: [reading.inspector ?? 'anonymous'],
        readings: [reading],
        /* MY fetch clock. capturedAt is the capsule's first-seen time and is
         * deliberately not used for age — evidenceCapsules' own header warns
         * that an unchanged page answers a fresh read with an old capsule. */
        observedAt: reading.observedAt ?? null,
      })
      continue
    }

    existing.inspectors.push(reading.inspector ?? 'anonymous')
    existing.readings.push(reading)
    if (reading.capsuleId && !existing.capsuleIds.includes(reading.capsuleId)) {
      existing.capsuleIds.push(reading.capsuleId)
    }
    /* Keep the earliest fetch: the sighting is as old as its oldest reading, and
     * dating it by the newest would make a stale reading look fresh. */
    if (
      reading.observedAt &&
      (!existing.observedAt || reading.observedAt < existing.observedAt)
    ) {
      existing.observedAt = reading.observedAt
    }
  }

  return [...byKey.values()]
}

/*
 * What a sighting says. Normally one thing — but two inspectors CAN read the
 * same bytes and extract different answers, and that is the sharpest conflict
 * there is, so it is detected here rather than being averaged away.
 */
function answersWithin(sighting) {
  const seen = new Map()
  for (const reading of sighting.readings) {
    const answer = normalizeAnswer(reading.answer)
    if (answer === null) continue
    const key = looseAnswer(answer)
    if (!seen.has(key)) seen.set(key, { answer, inspectors: [] })
    seen.get(key).inspectors.push(reading.inspector ?? 'anonymous')
  }
  return [...seen.values()]
}

/* -------------------------------------------------------------- conflicts */

export const CONFLICT = Object.freeze({
  interpretation: 'interpretation',
  region: 'region',
  revision: 'revision',
  page: 'page',
})

/*
 * Why two sightings differ. The cause determines what the owner should do, and
 * it is far more useful than a winner would have been.
 *
 * Ordered most to least severe: identical bytes disagreeing is a reader problem
 * and no amount of re-reading fixes it, whereas two different pages disagreeing
 * is usually not a problem at all.
 */
function classifyConflict(sightings, { revisionWindowMs = REVISION_WINDOW_MS } = {}) {
  const hashes = new Set(sightings.map((item) => item.contentHash ?? item.sightingKey))
  const sources = new Set(sightings.map((item) => item.sourceKey ?? 'unknown'))
  const regions = new Set(sightings.map((item) => item.regionKey ?? 'unknown'))

  if (hashes.size === 1) {
    return {
      kind: CONFLICT.interpretation,
      why: 'Both readings came off byte-identical text and still disagree, so this is a disagreement about what the page means, not about what it says. Re-reading it will not settle this.',
      resolvable: false,
    }
  }

  if (sources.size > 1) {
    return {
      kind: CONFLICT.page,
      why: 'These readings are of different pages. Each is probably right about its own page, and there is no version of this where one of them is the answer.',
      resolvable: false,
    }
  }

  if (regions.size > 1) {
    return {
      kind: CONFLICT.region,
      why: 'Same page, different parts of it. One lens read a region the other never saw, so both can be accurate reports of what they looked at.',
      resolvable: false,
    }
  }

  const times = sightings.map((item) => Date.parse(item.observedAt ?? '')).filter(Number.isFinite)
  const gapMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0

  return {
    kind: CONFLICT.revision,
    why:
      gapMs >= revisionWindowMs
        ? `Same page and same region, read ${Math.round(gapMs / 1000)}s apart with different content. These are two states of the page over time rather than two opinions about one state.`
        : 'Same page and same region, but the content differed between reads taken moments apart — the page was changing underneath the panel.',
    resolvable: false,
    gapMs,
  }
}

/* ---------------------------------------------------------- corroboration */

export const CORROBORATION = Object.freeze({
  independent: 'independent',
  sameSource: 'same-source',
  unverified: 'unverified',
  none: 'none',
})

/**
 * How much weight an agreement deserves.
 *
 * `independent` requires two or more sightings that are both content-hashed and
 * demonstrably different. Anything less is named for what it is instead of being
 * quietly rounded up, because "four inspectors agree" is the sentence a reader
 * will remember and it must not be available unless it is earned.
 */
export function corroborationOf(sightings = []) {
  const readers = sightings.reduce((sum, item) => sum + item.inspectors.length, 0)

  /* Nobody checked it. Distinct from "several readers, one source", which is
   * weak corroboration but is not nothing — an extraction bug in one lens would
   * still have shown up as a split within the sighting. */
  if (readers <= 1) return CORROBORATION.none

  if (sightings.length === 1) {
    /* Several readers on one set of bytes. Unhashed here means the readings were
     * pinned together as a single reused fetch (see sightingKeyOf), so the
     * second reader never went to the page and there is nothing to corroborate. */
    return sightings[0].hashed ? CORROBORATION.sameSource : CORROBORATION.none
  }

  const hashed = sightings.filter((item) => item.hashed)
  if (hashed.length < sightings.length) {
    /* At least one reading cannot prove which bytes it saw, so it cannot prove
     * it is a second observation rather than the first one again. */
    return CORROBORATION.unverified
  }

  const distinct = new Set(hashed.map((item) => item.contentHash))
  return distinct.size > 1 ? CORROBORATION.independent : CORROBORATION.sameSource
}

/* ------------------------------------------------------------- the verdict */

export const VERDICT = Object.freeze({
  agreed: 'agreed',
  single: 'single',
  disputed: 'disputed',
  unanswered: 'unanswered',
})

/**
 * Reconcile every reading of one question into one honest statement.
 *
 * Returns a verdict whose `answer` is populated ONLY when there is genuinely a
 * single answer to give. A disputed question has `answer: null` and a populated
 * `conflict` — callers that want a string are meant to hit the null and have to
 * deal with it, rather than receiving a plausible value with a warning flag
 * beside it that everything downstream will drop.
 */
export function reconcile(
  { questionKey, prompt = null, readings = [] } = {},
  { confidenceFloor = CONFIDENCE_FLOOR, revisionWindowMs = REVISION_WINDOW_MS } = {},
) {
  const inadmissible = []
  const admitted = []

  for (const reading of readings) {
    const check = admitReading(reading, { confidenceFloor })
    if (check.admitted) admitted.push(reading)
    else {
      inadmissible.push({
        inspector: reading.inspector ?? 'anonymous',
        reason: check.reason,
        detail: check.detail,
      })
    }
  }

  /*
   * A reading that found nothing is not a vote against the readings that found
   * something. "I could not see it" and "it says something else" are different
   * claims, and merging them would let silence outvote sight.
   */
  const silent = admitted
    .filter((reading) => normalizeAnswer(reading.answer) === null)
    .map((reading) => ({
      inspector: reading.inspector ?? 'anonymous',
      reason: reading.miss ?? 'the reading came back with nothing for this question',
      capsuleId: reading.capsuleId ?? null,
    }))

  const answering = admitted.filter((reading) => normalizeAnswer(reading.answer) !== null)
  const sightings = groupSightings(answering)

  const base = {
    questionKey,
    prompt,
    readings: readings.length,
    admitted: admitted.length,
    answering: answering.length,
    distinctEvidence: new Set(
      sightings.filter((item) => item.hashed).map((item) => item.contentHash),
    ).size,
    voices: sightings.map((sighting) => ({
      sightingKey: sighting.sightingKey,
      inspectors: sighting.inspectors,
      answers: answersWithin(sighting).map((entry) => entry.answer),
      contentHash: sighting.contentHash,
      sourceKey: sighting.sourceKey,
      regionKey: sighting.regionKey,
      capsuleIds: sighting.capsuleIds,
      observedAt: sighting.observedAt,
    })),
    silent,
    inadmissible,
  }

  if (!sightings.length) {
    return {
      ...base,
      status: VERDICT.unanswered,
      answer: null,
      corroboration: CORROBORATION.none,
      conflict: null,
      narrative: narrate({ ...base, status: VERDICT.unanswered, answer: null }),
    }
  }

  /*
   * Same bytes, two answers. Checked before the cross-sighting comparison
   * because it can be true inside a single sighting, where a naive "how many
   * distinct answers are there across sightings" test would see one sighting,
   * conclude unanimity, and report a disputed reading as settled.
   */
  const split = sightings.find((sighting) => answersWithin(sighting).length > 1)
  if (split) {
    const conflict = classifyConflict([split, split], { revisionWindowMs })
    return {
      ...base,
      status: VERDICT.disputed,
      answer: null,
      corroboration: CORROBORATION.none,
      conflict: {
        ...conflict,
        sides: answersWithin(split).map((entry) => ({
          answer: entry.answer,
          inspectors: entry.inspectors,
          contentHash: split.contentHash,
          sourceKey: split.sourceKey,
          regionKey: split.regionKey,
          capsuleIds: split.capsuleIds,
          observedAt: split.observedAt,
        })),
      },
      narrative: narrate({
        ...base,
        status: VERDICT.disputed,
        conflict: { ...conflict, sides: answersWithin(split) },
      }),
    }
  }

  /* One answer per sighting from here on, so a sighting can stand for its answer. */
  const byAnswer = new Map()
  for (const sighting of sightings) {
    const [entry] = answersWithin(sighting)
    const key = looseAnswer(entry.answer)
    if (!byAnswer.has(key)) byAnswer.set(key, { answer: entry.answer, sightings: [] })
    byAnswer.get(key).sightings.push(sighting)
  }

  if (byAnswer.size === 1) {
    const [only] = [...byAnswer.values()]
    const corroboration = corroborationOf(only.sightings)

    /*
     * Spelled differently but the same value. Reported as agreement with a
     * note, because calling "$41.98" and "41.98" a conflict would spend the
     * owner's attention on formatting and teach them to skip the real ones.
     */
    const spellings = [
      ...new Set(only.sightings.map((sighting) => answersWithin(sighting)[0].answer)),
    ]

    /*
     * Status counts READINGS; corroboration counts EVIDENCE. Three inspectors
     * on one page did all report, so calling that `single` would be a lie about
     * how many looked — the fact that their agreement is worth one observation
     * is carried by `corroboration` and said out loud in the narrative, which
     * is where it belongs.
     */
    const status = answering.length > 1 ? VERDICT.agreed : VERDICT.single
    const verdict = {
      ...base,
      status,
      answer: only.answer,
      corroboration,
      conflict: null,
      ...(spellings.length > 1 ? { spellings } : {}),
    }
    return { ...verdict, narrative: narrate(verdict) }
  }

  /*
   * Genuine disagreement across sightings.
   *
   * No tally is computed and no winner is chosen. This is the point the whole
   * module exists to reach without flinching: several readings, several answers,
   * and the output is all of them with their evidence rather than one of them
   * with the others discarded.
   */
  const sides = [...byAnswer.values()].map((group) => ({
    answer: group.answer,
    inspectors: group.sightings.flatMap((sighting) => sighting.inspectors),
    /* The weight that would have decided this if weights were allowed. It is
     * reported so a reader can see the majority is not being honoured, and so a
     * three-inspectors-one-page "majority" is visibly worth one. */
    evidenceCount: new Set(
      group.sightings.filter((item) => item.hashed).map((item) => item.contentHash),
    ).size,
    contentHashes: group.sightings.map((sighting) => sighting.contentHash),
    sourceKeys: [...new Set(group.sightings.map((sighting) => sighting.sourceKey))],
    regionKeys: [...new Set(group.sightings.map((sighting) => sighting.regionKey))],
    capsuleIds: group.sightings.flatMap((sighting) => sighting.capsuleIds),
    observedAt: group.sightings
      .map((sighting) => sighting.observedAt)
      .filter(Boolean)
      .sort()[0] ?? null,
  }))

  const conflict = { ...classifyConflict(sightings, { revisionWindowMs }), sides }

  /*
   * For a revision conflict the readings can at least be ordered, which is
   * reporting rather than resolving: "at 10:04 it said X, at 10:07 it said Y" is
   * two facts, where "it says Y" would be a choice.
   */
  if (conflict.kind === CONFLICT.revision) {
    conflict.chronological = [...sides].sort((left, right) =>
      String(left.observedAt ?? '').localeCompare(String(right.observedAt ?? '')),
    )
    conflict.latest = conflict.chronological[conflict.chronological.length - 1]?.answer ?? null
  }

  const verdict = {
    ...base,
    status: VERDICT.disputed,
    answer: null,
    corroboration: CORROBORATION.none,
    conflict,
  }
  return { ...verdict, narrative: narrate(verdict) }
}

/* ------------------------------------------------------------- narration */

const listOf = (items) => {
  const unique = [...new Set(items.filter(Boolean))]
  if (unique.length <= 1) return unique[0] ?? ''
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`
}

/**
 * The verdict as a sentence, because this reaches the owner through a spoken
 * briefing where a status enum is unreadable.
 *
 * Every branch says how many independent pieces of evidence there were. A
 * sentence that says "they agree" without saying what "they" were is exactly
 * the blend this module refuses to produce, only in prose.
 */
export function narrate(verdict) {
  const { status, questionKey, conflict } = verdict
  const label = verdict.prompt || questionKey

  if (status === VERDICT.unanswered) {
    const silent = verdict.silent?.length ?? 0
    const dropped = verdict.inadmissible?.length ?? 0
    if (dropped && !silent) {
      return `Nothing usable for ${label}: ${dropped} reading(s) were set aside (${listOf(verdict.inadmissible.map((entry) => entry.reason))}).`
    }
    /* No readings at all is not the same as readings that came back empty, and
     * "0 inspector(s) looked and came back empty" was the sentence this
     * produced live. Nobody looked is its own answer. */
    if (!silent && !dropped) {
      return `Nothing was read for ${label} — no inspector produced a reading of it either way.`
    }
    return `No reading found ${label}. ${silent} inspector(s) looked and came back empty${dropped ? `, and ${dropped} more were set aside` : ''}.`
  }

  if (status === VERDICT.single) {
    return `${label}: ${verdict.answer}. Only one reading found it — nothing checked it, so treat it as unconfirmed.`
  }

  if (status === VERDICT.agreed) {
    const distinct = verdict.distinctEvidence
    if (verdict.corroboration === CORROBORATION.independent) {
      return `${label}: ${verdict.answer}. ${distinct} independent readings agree.`
    }
    if (verdict.corroboration === CORROBORATION.sameSource) {
      return `${label}: ${verdict.answer}. ${verdict.answering} inspectors agree, but all of them read the same text, so this is one observation with several names on it — not confirmation.`
    }
    if (verdict.corroboration === CORROBORATION.none) {
      /* One fetch, reused. The bridge deduplicated the command, so the second
       * "reading" never went to the page at all. */
      return `${label}: ${verdict.answer}. ${verdict.answering} inspectors report it, but they were served by a single fetch that was reused, so it is one reading counted twice.`
    }
    return `${label}: ${verdict.answer}. The readings agree, but at least one could not prove which page text it came from, so they may be the same observation twice.`
  }

  const sides = conflict?.sides ?? []
  const rendered = sides
    .map((side) => `${listOf(side.inspectors)} read "${side.answer}"`)
    .join('; ')

  if (conflict?.kind === CONFLICT.revision && conflict.chronological?.length) {
    const ordered = conflict.chronological
      .map((side) => `"${side.answer}" at ${String(side.observedAt ?? '').slice(11, 19) || 'an unknown time'}`)
      .join(', then ')
    return `${label} is unsettled: ${ordered}. ${conflict.why} Reporting both rather than picking the later one.`
  }

  return `${label} is unsettled — ${rendered}. ${conflict?.why ?? ''} Not picking between them.`
}

/* ---------------------------------------------------------------- batching */

/**
 * Reconcile a whole investigation. Readings arrive flat, tagged with the
 * question they answer, because an inspector reads a page once and answers
 * several questions off that one reading.
 */
export function reconcileAll({ questions = [], readings = [] } = {}, options = {}) {
  const byQuestion = new Map()
  for (const reading of readings) {
    const key = reading.questionKey
    if (!byQuestion.has(key)) byQuestion.set(key, [])
    byQuestion.get(key).push(reading)
  }

  const asked = questions.length
    ? questions
    : [...byQuestion.keys()].map((key) => ({ key, prompt: null }))

  const verdicts = asked.map((question) =>
    reconcile(
      {
        questionKey: question.key,
        prompt: question.prompt ?? null,
        readings: byQuestion.get(question.key) ?? [],
      },
      options,
    ),
  )

  return {
    verdicts,
    agreed: verdicts.filter((item) => item.status === VERDICT.agreed).map((item) => item.questionKey),
    disputed: verdicts.filter((item) => item.status === VERDICT.disputed).map((item) => item.questionKey),
    unconfirmed: verdicts
      .filter((item) => item.status === VERDICT.single)
      .map((item) => item.questionKey),
    unanswered: verdicts
      .filter((item) => item.status === VERDICT.unanswered)
      .map((item) => item.questionKey),
    /* The one number that matters for whether any of this can be acted on. */
    settled: verdicts.every((item) => item.status !== VERDICT.disputed),
  }
}

/**
 * Values safe to put into a form or a message: agreed or single, never disputed.
 *
 * This is the join between the two halves of the proposal, and it is one line
 * on purpose. A disputed value must not reach a draft at all — not as a filled
 * field with a warning attached, because the warning lives in a preview the
 * owner skims and the field is what gets submitted.
 */
export function settledValues(verdicts = []) {
  const values = {}
  const withheld = []

  for (const verdict of verdicts) {
    if (verdict.status === VERDICT.agreed || verdict.status === VERDICT.single) {
      values[verdict.questionKey] = verdict.answer
      continue
    }
    withheld.push({
      key: verdict.questionKey,
      status: verdict.status,
      why:
        verdict.status === VERDICT.disputed
          ? verdict.conflict?.why ?? 'the readings disagree'
          : 'no reading found a value',
      narrative: verdict.narrative,
    })
  }

  return { values, withheld }
}
