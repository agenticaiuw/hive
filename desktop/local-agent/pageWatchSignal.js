import crypto from 'node:crypto'

/*
 * Which diffs are worth waking the owner for.
 *
 * pageWatch.js can already tell that two readings differ. That was never the
 * hard part, and on its own it is useless: every proposal that asked for this
 * feature asked for it with a qualifier attached — "tell me only what changed",
 * "only when a meaningful change happens", "a change threshold". A watcher that
 * reports every diff is a notification the owner turns off in a day, at which
 * point the feature has negative value, because now they also are not told the
 * one thing that mattered.
 *
 * Measured on the pages this was pointed at, the overwhelming majority of
 * poll-to-poll churn is three things: a clock ("Updated 2 minutes ago"), a
 * cache-buster or session nonce embedded in the rendered text, and a slot whose
 * contents rotate on every load. None of those are the status, the price, or
 * the appointment.
 *
 * THE RULE THIS FILE IS BUILT ON: no per-site knowledge. Not a domain table,
 * not a selector blocklist, not "on this site ignore .promo". A rule table is
 * wrong the day a site redesigns and it is empty for every site the owner has
 * that nobody anticipated — which is all of them, since the whole premise is
 * pages behind *their* login that nobody else can see. So meaningfulness is
 * decided from two things this module can always get: the shape of the text
 * that actually differs, and how this particular field has behaved on this
 * particular page across previous polls.
 *
 * Two ideas do almost all the work.
 *
 *   LOOK AT WHAT DIFFERS, NOT AT HOW MUCH. Comparing whole values makes long
 *   values look noisy and short values look important, which is backwards: a
 *   4,000-character page whose only difference is "14:32:07" → "14:33:09" is
 *   silent, and a nine-character value going "Delayed" → "Shipped" is the whole
 *   point of the feature. So the comparison is over the set of tokens present
 *   in one reading and absent in the other, and the question asked of them is
 *   what KIND of token they are.
 *
 *   SHAPE IS ONLY A PRIOR; THE FIELD'S OWN HISTORY OVERRULES IT. "Contains a
 *   time of day" is a good guess at a clock and a bad rule: a delivery window
 *   of "9:00 AM - 5:00 PM" is time-shaped and moving it is real news. The
 *   difference between a clock and a delivery window is not in the text, it is
 *   in the behaviour — a clock moves every single time you look, a delivery
 *   window sits still for days and then moves once. That is observable without
 *   knowing anything about the site, so a field that has been stable across
 *   several polls gets its shape penalty waived, and a field that changes on
 *   nearly every poll is suppressed whatever it looks like.
 *
 * Everything here is pure. No store, no clock, no I/O — scoring a change must
 * be reproducible from the record of the change, because the first question
 * about a watcher that stayed quiet is "why", and the answer has to be
 * recomputable rather than remembered.
 */

/*
 * Below this many prior comparisons, churn is not evidence of anything.
 *
 * With two samples a field that changed once looks like it changes half the
 * time. The first real status change on a newly created watch would then be
 * scored as a coin-flip field and suppressed — the exact change the owner set
 * the watch up for, lost to a statistic computed from nothing. So churn is
 * ignored entirely until there is enough of it to mean something, and shape
 * alone decides until then.
 */
const MIN_CHURN_SAMPLES = 4

/* How many recent values a field remembers, for detecting a slot that rotates
 * through a small set rather than actually changing. Eight covers the rotations
 * seen here (2-4 states) with room to spare, and bounds the store. */
export const HISTORY_DEPTH = 8

/* Long values are diffed as segments rather than as one blob. 400 is where a
 * before/after pair stops being something a person can read in a spoken
 * report, which is the only consumer that matters. */
export const SEGMENT_THRESHOLD_CHARS = 400

/* Bounds on the segment baseline a watch stores. A page with more distinct
 * lines than this has changed shape more than a watcher can usefully narrate. */
export const MAX_SEGMENTS = 200
const MAX_SEGMENT_EXCERPT = 160

/* Pairing changed lines is O(added × removed). Past this the page did not
 * change, it was replaced, and no pairing would be meaningful anyway. */
const MAX_PAIRING = 40

/** The default bar. Tuned so a clock is suppressed and a one-word status is not. */
export const DEFAULT_THRESHOLD = 0.5

/* Non-breaking and typographic spaces are folded first: a page that renders
 * "&nbsp;" between a label and its value would otherwise diff against the same
 * page rendering a plain space, which is a change nobody made. */
export const normalize = (value) =>
  String(value ?? '')
    .replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const shortHash = (value) =>
  crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16)

/* ------------------------------------------------------------------- shapes */

/*
 * A value that carries a TIME OF DAY advances on its own; a value that carries
 * only a calendar date does not.
 *
 * That is the whole distinction, and it is the one that makes this safe to
 * apply without knowing the site. "Estimated delivery Friday" and "Arrives
 * Aug 12" are dates with no clock in them: nothing about the page re-rendering
 * moves them, so when they move, something happened. "Updated 14:32:07",
 * "2 minutes ago" and an ISO timestamp all move because time passed.
 *
 * Bare dates are deliberately NOT matched here. An earlier cut treated any date
 * as a clock and would have swallowed a delivery slipping by a day, which is
 * one of the four things the owner named when asking for this.
 */
const CLOCK_PATTERNS = [
  /* "3 minutes ago", "just now", "in 2 hours", "5m ago" */
  /\b(just\s+now|moments?\s+ago)\b/i,
  /\b\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\s+ago\b/i,
  /\b\d+\s*[smhdw]\s+ago\b/i,
  /\bin\s+\d+\s*(seconds?|minutes?|hours?)\b/i,
  /* a clock reading, with or without seconds or a meridiem */
  /\b\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m\.?)?\b/i,
  /* ISO-8601 with a time component — the date alone is not enough */
  /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}/i,
  /* a unix timestamp in seconds or milliseconds, which is how cache-busters
   * and "?t=" parameters show up once a page renders them into its text */
  /\b1[0-9]{9}([0-9]{3})?\b/,
]

export function isClockLike(value) {
  const text = normalize(value)
  if (!text) return false
  return CLOCK_PATTERNS.some((pattern) => pattern.test(text))
}

/*
 * A nonce, a session id, a cache key, a build hash.
 *
 * Recognised by the absence of language rather than the presence of a format:
 * one long unbroken run of characters, mixing letters and digits, with almost
 * no vowels — or pure hex, which is the same thing said more clearly. Real
 * values a person would want to be told about are words, numbers, or short
 * codes; none of them look like this.
 *
 * The length floor is 12 because order numbers and tracking codes are shorter
 * than that and are absolutely not noise. A tracking number appearing is one of
 * the changes this feature exists to catch.
 */
export function isTokenLike(value) {
  const text = normalize(value)
  if (text.length < 12 || /\s/.test(text)) return false
  if (!/^[A-Za-z0-9_\-=+/.:%]+$/.test(text)) return false

  const letters = text.replace(/[^A-Za-z]/g, '')
  const digits = text.replace(/[^0-9]/g, '')

  /* Pure hex of this length is a hash or an id; nothing a person names is. */
  if (/^[0-9a-f]{16,}$/i.test(text)) return true

  if (!letters.length || !digits.length) return false
  const vowels = (letters.match(/[aeiou]/gi) ?? []).length
  return vowels / letters.length < 0.2
}

/** The single number a value is, if it is essentially one number. */
export function numericOf(value) {
  const text = normalize(value)
  if (!text) return null
  const match = text.match(/-?\d[\d,]*(\.\d+)?/)
  if (!match) return null
  const number = Number(match[0].replace(/,/g, ''))
  if (!Number.isFinite(number)) return null
  /* Refuse values that are mostly words with a number in them: "Arrives in 3
   * days" is not a quantity a percentage threshold means anything about. */
  const remainder = text.replace(match[0], '').replace(/[^A-Za-z]/g, '')
  return remainder.length > 8 ? null : number
}

export function shapeOf(value) {
  if (value === null || value === undefined || normalize(value) === '') return 'empty'
  if (isClockLike(value)) return 'clock'
  if (isTokenLike(value)) return 'token'
  if (numericOf(value) !== null) return 'number'
  return 'text'
}

/* --------------------------------------------------------- what differs */

const tokensOf = (value) =>
  normalize(value)
    .split(/[\s]+/)
    .filter(Boolean)

/**
 * The tokens present in one reading and absent from the other, both ways.
 *
 * Multiset-aware: a word that appears twice before and once after is a
 * difference. Punctuation is kept attached, because "$129.99" and "129" have to
 * stay distinguishable and splitting on punctuation would shred timestamps.
 */
export function differingTokens(before, after) {
  const count = (list) => {
    const map = new Map()
    for (const token of list) map.set(token, (map.get(token) ?? 0) + 1)
    return map
  }
  const left = count(tokensOf(before))
  const right = count(tokensOf(after))
  const differing = []

  for (const [token, times] of left) {
    const surplus = times - (right.get(token) ?? 0)
    for (let index = 0; index < surplus; index += 1) differing.push(token)
  }
  for (const [token, times] of right) {
    const surplus = times - (left.get(token) ?? 0)
    for (let index = 0; index < surplus; index += 1) differing.push(token)
  }

  return differing
}

/* The clock patterns as global replacers, for masking rather than testing. */
const CLOCK_MASKS = CLOCK_PATTERNS.map(
  (pattern) => new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`),
)

/**
 * The value with every clock and every opaque token replaced by a placeholder.
 *
 * Needed because comparing token by token loses the phrase. "2 minutes ago" and
 * "17 minutes ago" differ only in the tokens "2" and "17", and a bare number is
 * not timestamp-shaped on its own — so the token test called a relative
 * timestamp a real change, which is the single noisiest thing on a logged-in
 * page. Masking asks the question at the right granularity: with the clocks
 * blanked out, do these two readings still say different things?
 */
export function maskNoise(value) {
  let text = normalize(value)
  for (const pattern of CLOCK_MASKS) text = text.replace(pattern, '⟦t⟧')
  return text
    .split(' ')
    .map((token) => (isTokenLike(token) ? '⟦k⟧' : token))
    .join(' ')
}

/**
 * True when everything that moved was a clock or a token.
 *
 * This is the single most load-bearing predicate in the feature. It is what
 * lets a whole-page watch exist at all: nearly every page carries a rendered
 * timestamp somewhere, so without this every poll of every page is a change.
 *
 * Asked two ways, because each catches what the other misses. The mask catches
 * a timestamp that is a PHRASE — "17 minutes ago" — where no single differing
 * token looks like a clock. The token test catches a clock that moved inside
 * text that also changed elsewhere, where the masked strings differ but the
 * only actual movement was the clock.
 *
 * A pair of readings with no differing tokens at all (whitespace reflow only)
 * counts as noise too — that is a page laying itself out differently, not a
 * page saying something different.
 */
export function onlyNoiseMoved(before, after) {
  const differing = differingTokens(before, after)
  if (!differing.length) return true
  if (maskNoise(before) === maskNoise(after)) return true
  return differing.every((token) => isClockLike(token) || isTokenLike(token))
}

/* ------------------------------------------------------------ segmenting */

/** Non-empty lines, normalized and bounded. The unit a person reads. */
export function segmentsOf(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => normalize(line))
    .filter(Boolean)
    .slice(0, MAX_SEGMENTS)
}

/**
 * The baseline a watch stores for a long field: a hash to compare against and
 * a short excerpt so a line that DISAPPEARS can still be quoted.
 *
 * Deliberately not the full text. The watch store is durable and unencrypted
 * and these are pages behind the owner's login; keeping only enough to detect
 * and describe a change is the smaller thing to keep. The full reading lives in
 * the evidence capsule, which has a TTL and can be revoked — which is exactly
 * why the watch cannot use it as its baseline (see pageWatch.js).
 */
export function digestSegments(text) {
  return segmentsOf(text).map((segment) => ({
    h: shortHash(segment),
    t: segment.slice(0, MAX_SEGMENT_EXCERPT),
  }))
}

const wordSet = (value) => new Set(normalize(value).toLowerCase().split(/\W+/).filter(Boolean))

function overlap(left, right) {
  const a = wordSet(left)
  const b = wordSet(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / Math.max(a.size, b.size)
}

/**
 * Line-level diff of a long field, with edited lines paired up.
 *
 * Pairing matters: "Status: Processing" vanishing and "Status: Shipped"
 * appearing is one edit, and reporting it as an unrelated removal plus an
 * unrelated addition is both twice the noise and strictly less informative —
 * the pair is what carries the before and after the owner asked for.
 *
 * Pairs are matched on word overlap because that is what survives the edit:
 * the label stays, the value moves.
 */
export function diffSegmentSets(beforeDigests = [], afterText = '') {
  const after = segmentsOf(afterText)
  const beforeByHash = new Map((beforeDigests ?? []).map((entry) => [entry.h, entry]))
  const afterByHash = new Map(after.map((segment) => [shortHash(segment), segment]))

  const added = after.filter((segment) => !beforeByHash.has(shortHash(segment)))
  const removed = (beforeDigests ?? []).filter((entry) => !afterByHash.has(entry.h))

  const edits = []
  const unpairedAdded = [...added]
  const unpairedRemoved = [...removed]

  if (added.length <= MAX_PAIRING && removed.length <= MAX_PAIRING) {
    for (const gone of [...unpairedRemoved]) {
      let best = null
      let bestScore = 0
      for (const arrived of unpairedAdded) {
        const score = overlap(gone.t, arrived)
        if (score > bestScore) {
          bestScore = score
          best = arrived
        }
      }
      /* Half the words in common is a rewritten line; less than that is two
       * different lines that happen to share a stopword. */
      if (best && bestScore >= 0.5) {
        edits.push({ before: gone.t, after: best, overlap: Math.round(bestScore * 100) / 100 })
        unpairedRemoved.splice(unpairedRemoved.indexOf(gone), 1)
        unpairedAdded.splice(unpairedAdded.indexOf(best), 1)
      }
    }
  }

  return {
    edits,
    added: unpairedAdded,
    removed: unpairedRemoved.map((entry) => entry.t),
  }
}

/**
 * Drop the segment changes that are only a clock or a token moving.
 *
 * An edited line is judged on the pair. A line that purely appeared or
 * disappeared is judged on itself: a page that grew a line saying
 * "Last refreshed 14:02" is not news, and a page that grew a line saying
 * "Your appointment was cancelled" is.
 */
export function filterSegmentNoise(diff) {
  const noisy = []
  const keep = (list, isNoise) =>
    list.filter((item) => {
      if (!isNoise(item)) return true
      noisy.push(item)
      return false
    })

  return {
    edits: keep(diff.edits, (edit) => onlyNoiseMoved(edit.before, edit.after)),
    added: keep(diff.added, (line) => shapeOf(line) === 'clock' || shapeOf(line) === 'token'),
    removed: keep(diff.removed, (line) => shapeOf(line) === 'clock' || shapeOf(line) === 'token'),
    noisy,
  }
}

/* ---------------------------------------------------------------- churn */

/**
 * How often this field has moved, over its own past.
 *
 * `history` is the field's recent values, oldest first, as recorded by the
 * watch. The rate is over PRIOR comparisons only — the change being scored is
 * not allowed to vote on whether it is typical, or a first change would always
 * look like a 100%-churn field and suppress itself.
 */
export function fieldChurn(history = []) {
  const values = Array.isArray(history) ? history : []
  const samples = Math.max(0, values.length - 1)
  if (!samples) return { samples: 0, changes: 0, rate: null, distinct: 0 }

  let changes = 0
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== values[index - 1]) changes += 1
  }

  return {
    samples,
    changes,
    rate: changes / samples,
    distinct: new Set(values).size,
  }
}

/* ---------------------------------------------------------------- scoring */

/**
 * How much this change deserves to interrupt the owner, and why.
 *
 * Returns a score in 0..1 with every term that moved it named. The reasons are
 * not decoration: "why did you not tell me" and "why did you tell me that" are
 * the only two complaints a watcher ever gets, and both are unanswerable if the
 * verdict is a bare number. They are also what the owner tunes the threshold
 * against.
 *
 * `anchor` is the value the owner was LAST TOLD, which is not the same as the
 * previous reading and is the reason this parameter exists. Scoring a numeric
 * threshold against the previous reading lets a value creep: 100 → 100.4 →
 * 100.8 → 101.2 never trips a "tell me on a 1% move" threshold on any single
 * step, and the owner is never told, having asked to be told. Measuring the
 * move against the last REPORTED value instead makes the threshold mean what it
 * says.
 */
export function scoreChange({
  before = null,
  after = null,
  anchor = undefined,
  history = [],
  minDelta = null,
  minPercent = null,
  threshold = DEFAULT_THRESHOLD,
} = {}) {
  const reasons = []
  let score = 1

  const beforeShape = shapeOf(before)
  const afterShape = shapeOf(after)
  const appeared = beforeShape === 'empty' && afterShape !== 'empty'
  const vanished = beforeShape !== 'empty' && afterShape === 'empty'

  /*
   * A field appearing or disappearing is structural, and is reported whatever
   * its shape or history says.
   *
   * This is the case the noise filters would get most wrong: a selector that
   * stops matching means the page was redesigned, and a value that vanishes
   * means the thing it described is gone — "your appointment" disappearing off
   * an appointments page is the single most important thing this can notice,
   * and it is one where the page says nothing at all.
   */
  if (appeared || vanished) {
    reasons.push(vanished ? 'the value is no longer on the page' : 'the value appeared')
    return {
      score: 1,
      meaningful: true,
      reasons,
      structural: true,
      churn: fieldChurn(history),
    }
  }

  const churn = fieldChurn(history)
  const stable = churnVerdict(churn).stable

  /* Shape, applied to what actually moved rather than to the whole value. */
  if (onlyNoiseMoved(before, after)) {
    if (stable) {
      /* The prior said clock; the field's own record says it sits still for
       * days at a time. A delivery window and a "last updated" line are the
       * same shape and different things, and only the history tells them
       * apart. */
      reasons.push(
        'the text that moved is time- or token-shaped, but this field has been stable, so it is treated as real',
      )
    } else {
      score -= 0.7
      reasons.push('only a timestamp or an opaque token moved')
    }
  }

  /*
   * A value the field has recently held before is a rotation, not a change.
   *
   * Catches the slot that alternates between two states on alternate loads —
   * an A/B-tested string, a rotating promo, a status that flickers between
   * "Preparing" and "Processing" while a backend job retries. The immediately
   * previous value is excluded, since that is by definition what we changed
   * from.
   */
  const recent = (Array.isArray(history) ? history : []).slice(0, -1)
  if (after !== null && recent.includes(after)) {
    score -= 0.5
    reasons.push('this field has already held that value recently; it is cycling rather than changing')
  }

  /*
   * The owner's own threshold, measured from the last value they were told.
   */
  const beforeNumber = numericOf(anchor === undefined ? before : anchor)
  const afterNumber = numericOf(after)
  if (
    (minDelta !== null || minPercent !== null) &&
    beforeNumber !== null &&
    afterNumber !== null
  ) {
    const delta = Math.abs(afterNumber - beforeNumber)
    const percent = beforeNumber === 0 ? Infinity : (delta / Math.abs(beforeNumber)) * 100
    const belowAbsolute = minDelta !== null && delta < minDelta
    const belowRelative = minPercent !== null && percent < minPercent
    const configured = [minDelta !== null, minPercent !== null].filter(Boolean).length
    const below = configured === 2 ? belowAbsolute && belowRelative : belowAbsolute || belowRelative

    if (below) {
      score -= 0.8
      reasons.push(
        `moved ${round(delta)} (${round(percent)}%) from the last value you were told, under the threshold you set`,
      )
    } else {
      reasons.push(
        `moved ${round(delta)} (${round(percent)}%) from the last value you were told, over the threshold you set`,
      )
    }
  }

  /*
   * How this field behaves, learned from this page rather than assumed.
   *
   * This is what makes the feature work on a site nobody wrote a rule for. A
   * field that has moved on nearly every poll is a clock whatever it contains;
   * a field that has sat still is worth listening to whatever it contains.
   */
  const adjustment = churnVerdict(churn)
  score += adjustment.delta
  reasons.push(adjustment.reason)

  const bounded = Math.max(0, Math.min(1, score))
  return {
    score: Math.round(bounded * 100) / 100,
    meaningful: bounded >= threshold,
    reasons,
    structural: false,
    churn,
  }
}

const round = (value) =>
  Number.isFinite(value) ? Math.round(value * 100) / 100 : value

/**
 * What this field's own track record is worth as a signal.
 *
 * Shared by the short-value and the long-value paths deliberately. A page whose
 * body genuinely differs on every single poll — a feed, a live counter, a page
 * that renders a fresh nonce into its markup — is as unworthy of a
 * notification as a field that does, and it was reporting on every poll while
 * this logic existed only for short values.
 */
export function churnVerdict(churn) {
  if (churn.rate === null || churn.samples < MIN_CHURN_SAMPLES) {
    return {
      delta: 0,
      stable: false,
      reason: 'not enough history yet to know how often this moves',
    }
  }
  if (churn.rate >= 0.8) {
    return {
      delta: -0.7,
      stable: false,
      reason: `this has changed on ${churn.changes} of the last ${churn.samples} checks, so its changes are not news`,
    }
  }
  if (churn.rate >= 0.5) {
    return {
      delta: -0.35,
      stable: false,
      reason: `this changes often (${churn.changes} of the last ${churn.samples} checks)`,
    }
  }
  if (churn.rate <= 0.1) {
    return {
      delta: 0.3,
      stable: true,
      reason: `this has been stable across the last ${churn.samples} checks, so a change is worth saying`,
    }
  }
  return {
    delta: 0,
    stable: false,
    reason: `this changed on ${churn.changes} of the last ${churn.samples} checks`,
  }
}

/**
 * Score a long-field change from its segments.
 *
 * A long value cannot be scored as one string — token-differencing a 4,000
 * character page against another 4,000 character page answers "did anything at
 * all move", which is always yes. Scoring the SEGMENTS that survived the noise
 * filter answers the question the owner asked.
 */
export function scoreSegmentChange(
  filtered,
  { threshold = DEFAULT_THRESHOLD, history = [] } = {},
) {
  const moved =
    filtered.edits.length + filtered.added.length + filtered.removed.length
  const reasons = []

  if (!moved) {
    reasons.push(
      filtered.noisy.length
        ? `${filtered.noisy.length} line(s) moved, all of them timestamps or opaque tokens`
        : 'nothing on the page moved',
    )
    return {
      score: 0,
      meaningful: false,
      reasons,
      moved: 0,
      suppressed: filtered.noisy.length,
    }
  }

  reasons.push(`${moved} line(s) changed in a way that is not a timestamp or a token`)
  if (filtered.noisy.length) {
    reasons.push(
      `${filtered.noisy.length} further line(s) were timestamps or tokens and were ignored`,
    )
  }

  /* A page whose real text differs every time anyone looks is a feed, and a
   * feed is not a watch. Same test the short-value path applies, on the same
   * evidence: what this page has actually done on previous polls. */
  const adjustment = churnVerdict(fieldChurn(history))
  const score = Math.max(0, Math.min(1, 1 + Math.min(0, adjustment.delta)))
  if (adjustment.delta < 0) reasons.push(adjustment.reason)

  return {
    score: Math.round(score * 100) / 100,
    meaningful: score >= threshold,
    reasons,
    moved,
    suppressed: filtered.noisy.length,
  }
}
