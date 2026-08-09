/*
 * The length the owner asked for, out loud, in their own words.
 *
 * THE BUG THIS EXISTS TO FIX. The routine command was:
 *
 *   "Give me the top world and US news headlines from the last 12 hours,
 *    as three short spoken sentences."
 *
 * It produced 42.7 seconds of audio (measured, 2026-08-09T00:16Z, briefing
 * shelf row 1: 794 characters, 125 words). Three short sentences is about
 * fifteen. Two layers each had a reason not to care:
 *
 *   - research.js treats the whole command as a TOPIC. The composer prompt
 *     asks for "150-320 words" regardless of what the topic says, so the
 *     length instruction was fed to the model as part of the subject matter
 *     and then contradicted three lines later by the rules block.
 *   - pendantSpeech.js caps spoken REPLIES at 180 characters, and
 *     prerenderedPendantSpeech() deliberately exempts briefings from it (a
 *     briefing re-rendered from its own 180-character summary is not a
 *     briefing). That bypass is correct and is not touched here.
 *
 * So the constraint has to arrive at the thing that WRITES the script. This
 * module is that constraint, parsed once, in one place.
 *
 * WHY PARSE, RATHER THAN HAVE THE PLANNER PASS A PARAMETER. The planner is an
 * LLM, and asking it to extract a number reliably adds a failure mode that
 * cannot be tested without calling it. It also already does the only part that
 * needs a model: it puts the owner's words into `topic`. Every one of the five
 * live runs on 2026-08-08/09 carried the phrase through verbatim —
 * "…as three short spoken sentences", "…in three short spoken sentences",
 * "…summarized as exactly three short spoken sentences". Parsing that string
 * is deterministic, testable offline, and keeps ONE place responsible.
 *
 * WHAT IS DELIBERATELY NOT HERE. No truncation of rendered audio. Cutting a
 * 43-second WAV at 15 seconds ends a sentence mid-word, which is worse than a
 * long briefing. Everything here happens before a single sample is synthesised.
 */

/*
 * The rate `say` is actually driven at when a briefing is rendered
 * (audioBrief.js renderBriefAudio passes it as -r). It lives here, and
 * audioBrief.js imports it, because a duration estimate measured against a
 * different rate than the voice the owner hears is not an estimate of
 * anything. 210 wpm is the reply voice — brisk enough that a one-line
 * confirmation does not drag. A minute of unbroken briefing at that rate is
 * exhausting, so briefings are slower.
 */
export const BRIEF_SPEECH_RATE_WPM = Number(
  process.env.PENDANT_BRIEF_SPEECH_RATE || 185,
)

/*
 * The top of composeBrief()'s standing "150-320 words" rule.
 *
 * It is the test for whether a stated length is a BUDGET at all. "Keep it
 * under three minutes" is 555 words at the briefing rate — that is not the
 * owner shortening anything, it is a ceiling above the one already in force,
 * and honouring it would make briefings longer. Anything that does not come
 * in under this falls through to today's behaviour untouched.
 */
const DEFAULT_SPOKEN_MAX_WORDS = 320

/*
 * A "short spoken sentence" is about sixteen words. Three of them is 48 words,
 * which at 185 wpm is 15.6 seconds — the length the owner described as "three
 * short spoken sentences" and the length the briefing should have been. The
 * number is a word ALLOWANCE handed to the composer, not a hard trim.
 */
const WORDS_PER_SPOKEN_SENTENCE = 16

/*
 * What "briefly" means when the owner gives no number. Three is the smallest
 * count that still holds a lead, a detail and a close; one or two turns a
 * briefing into a fragment.
 */
const BRIEFLY_SENTENCES = 3

const COUNT_WORDS = new Map([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
])

const COUNTS = `\\d{1,3}|${[...COUNT_WORDS.keys()].join('|')}`

/*
 * Words the owner puts between the number and "sentences". A fixed list, not
 * `\w+`: "three sources in the sentences" must not read as a sentence count.
 */
const SHORTNESS_WORDS = 'short|brief|quick|spoken|simple|plain|crisp|punchy|tight'

function countFrom(token) {
  const word = String(token ?? '').toLowerCase()
  if (COUNT_WORDS.has(word)) return COUNT_WORDS.get(word)
  if (word === 'a' || word === 'an') return 1
  const digits = Number.parseInt(word, 10)
  return Number.isFinite(digits) ? digits : null
}

/*
 * ============================================================================
 * THE TABLE. Four entries. Each one earns its place by being something a
 * person actually says out loud to a thing on their chest.
 * ============================================================================
 *
 * `sentence-count`  "as three short spoken sentences", "in two sentences"
 *                   The live bug, verbatim. The only phrasing that carries an
 *                   explicit number, so it is the one that needs no defaults.
 *
 * `second-limit`    "keep it under 30 seconds", "under a minute"
 *                   Someone wearing this thinks in play time, not word count,
 *                   because play time is what they experience. Note the
 *                   lead-in is REQUIRED: bare "in 30 seconds" is excluded on
 *                   purpose, because on a device that also takes scheduling
 *                   commands it far more often means "start in 30 seconds".
 *
 * `single-line`     "one line", "in a sentence", "one-liner"
 *                   The shortest possible ask, and it is almost never said as
 *                   "one sentence" (which sentence-count already handles). An
 *                   article instead of a number needs a lead-in preposition so
 *                   that a topic like "the difference between a sentence and a
 *                   clause" is not read as a length instruction.
 *
 * `briefly`         "briefly", "keep it short", "in short"
 *                   The most common way to ask for less, and it carries no
 *                   number at all — which is exactly why it needs a documented
 *                   default rather than a guess at the call site.
 *
 * Anything not on this table is NOT a length instruction. It falls through to
 * today's behaviour rather than being guessed at, because a wrong guess here
 * silently deletes the news the owner asked for.
 */
const SPOKEN_LENGTH_RULES = Object.freeze([
  {
    name: 'sentence-count',
    kind: 'sentences',
    pattern: new RegExp(
      `\\b(${COUNTS})\\s+(?:(?:${SHORTNESS_WORDS})\\s+){0,3}sentences?\\b`,
      'i',
    ),
    read: (match) => countFrom(match[1]),
  },
  {
    name: 'second-limit',
    kind: 'seconds',
    pattern: new RegExp(
      `\\b(?:under|below|less than|no (?:more|longer) than|at most|within|` +
        `max(?:imum)?(?: of)?|keep it (?:to|under|below))\\s+` +
        `(?:about\\s+|around\\s+|roughly\\s+)?(${COUNTS}|an?)\\s*` +
        `(seconds?|secs?|minutes?|mins?)\\b`,
      'i',
    ),
    read: (match) => {
      const value = countFrom(match[1])
      if (value === null) return null
      return /^min/i.test(match[2]) ? value * 60 : value
    },
  },
  {
    name: 'single-line',
    kind: 'sentences',
    pattern: new RegExp(
      `\\bone[-\\s]liner\\b|\\bone\\s+line\\b|` +
        `\\b(?:in|as|to|into|just|only|keep it to)\\s+(?:an?|one)\\s+` +
        `(?:(?:${SHORTNESS_WORDS}|single)\\s+){0,2}(?:line|sentence)\\b`,
      'i',
    ),
    read: () => 1,
  },
  {
    name: 'briefly',
    kind: 'sentences',
    pattern:
      /\bbriefly\b|\bkeep it (?:brief|short|snappy|tight)\b|\bin short\b|\bbe brief\b|\bshort version\b/i,
    read: () => BRIEFLY_SENTENCES,
    /* Only when nothing with a number matched. "In two sentences, briefly"
     * means two, not three. */
    onlyIfNothingElseMatched: true,
  },
])

/** Words in a spoken script, counted the way the duration estimate counts. */
export function spokenWordCount(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

/** How long this script will take to read at the rate briefings are rendered. */
export function estimateSpokenSeconds(text) {
  return (spokenWordCount(text) / BRIEF_SPEECH_RATE_WPM) * 60
}

/**
 * Read a spoken-length budget out of the owner's own command.
 *
 * Returns null — meaning "no instruction, behave exactly as before" — for
 * anything unrecognised, and for any stated length that is not actually
 * shorter than the composer's standing default.
 *
 * @returns {null | {sentences: number|null, seconds: number|null,
 *                   words: number, matched: string[], phrase: string}}
 */
export function parseSpokenBudget(text) {
  const source = String(text ?? '')
  if (!source.trim()) return null

  let sentences = null
  let seconds = null
  let phrase = ''
  const matched = []

  for (const rule of SPOKEN_LENGTH_RULES) {
    if (rule.onlyIfNothingElseMatched && matched.length) continue
    if (rule.kind === 'sentences' && sentences !== null) continue
    if (rule.kind === 'seconds' && seconds !== null) continue

    const found = source.match(rule.pattern)
    if (!found) continue
    const value = rule.read(found)
    if (value === null || !Number.isFinite(value) || value < 1) continue

    if (rule.kind === 'sentences') sentences = value
    /* Under three seconds is not a briefing, it is a mis-parse. */
    else if (value >= 3) seconds = value
    else continue

    matched.push(rule.name)
    if (!phrase) phrase = found[0].trim()
  }

  if (sentences === null && seconds === null) return null

  const fromSentences =
    sentences === null ? Infinity : sentences * WORDS_PER_SPOKEN_SENTENCE
  const fromSeconds =
    seconds === null ? Infinity : Math.round((seconds * BRIEF_SPEECH_RATE_WPM) / 60)
  const words = Math.min(fromSentences, fromSeconds)

  /* Not shorter than what the composer already does — so not a budget. */
  if (!Number.isFinite(words) || words >= DEFAULT_SPOKEN_MAX_WORDS) return null

  return { sentences, seconds, words, matched, phrase }
}

/** Human-readable, for logs, notes and the research result. */
export function describeSpokenBudget(budget) {
  if (!budget) return ''
  const parts = []
  if (budget.sentences !== null) {
    parts.push(`${budget.sentences} sentence${budget.sentences === 1 ? '' : 's'}`)
  }
  if (budget.seconds !== null) parts.push(`${budget.seconds} seconds`)
  return `${parts.join(', ')} (about ${budget.words} words)`
}

/**
 * The rule handed to the model that writes the script.
 *
 * The last sentence of it is the whole point of the feature: the budget is a
 * SPOKEN budget. keyPoints, recommendation and openQuestions are the written
 * brief that gets filed on the Mac with its citations, and the owner asking to
 * hear three sentences is not asking for that file to be gutted.
 */
export function spokenBudgetPromptRule(budget) {
  if (!budget) return ''
  const limit =
    budget.sentences !== null
      ? `at most ${budget.sentences} sentence${budget.sentences === 1 ? '' : 's'}`
      : `at most ${budget.words} words`
  const seconds =
    budget.seconds ?? Math.round((budget.words / BRIEF_SPEECH_RATE_WPM) * 60)

  const length = [
    `- LENGTH, STATED BY THE OWNER ("${budget.phrase}"): "spoken" MUST be ${limit},`,
    `no more than ${budget.words} words, and must read aloud in under`,
    `${seconds} seconds. This overrides any other length guidance. Start with`,
    'the substance — no preamble, no "here is your briefing", no sign-off. Say',
    'the most important things first, because there is no room for the rest.',
  ].join(' ')

  const scope = [
    '- That length limit applies to "spoken" ONLY. headline, keyPoints,',
    'recommendation and openQuestions are the WRITTEN brief that is filed with',
    'its citations, and they keep their normal length and count.',
  ].join(' ')

  return `${length}\n${scope}`
}

/**
 * Backstop, not the mechanism.
 *
 * The composer is asked for a script of the right length and usually writes
 * one. When a model overshoots anyway, this drops whole trailing sentences —
 * it never cuts inside one, and it never returns nothing. A briefing that
 * stops one sentence early still ends on a full stop; the failure mode we were
 * told to avoid is the one that ends mid-word.
 *
 * The split requires whitespace and a following capital, so "the U.S. economy"
 * stays one sentence. "Sen. Smith" would split; the cost of that is a script
 * one clause shorter than it could have been, never a broken one.
 */
export function clampSpokenToBudget(text, budget) {
  const raw = String(text ?? '')
  /* No budget is not "a budget of infinity": the string is returned exactly as
   * it arrived, down to its whitespace, so a command that says nothing about
   * length produces a byte-identical script to the one it produced before. */
  if (!budget) return raw

  const script = raw.replace(/\s+/g, ' ').trim()
  if (!script) return script

  const pieces = script.split(/(?<=[.!?])\s+(?=[A-Z"'“‘])/).filter(Boolean)
  const maxSentences = budget.sentences ?? Number.POSITIVE_INFINITY
  const kept = []
  let words = 0

  for (const piece of pieces) {
    if (kept.length >= maxSentences) break
    const count = spokenWordCount(piece)
    /* The first sentence is always kept whole, however long it is. */
    if (kept.length && words + count > budget.words) break
    kept.push(piece)
    words += count
  }

  return kept.length ? kept.join(' ') : pieces[0]
}
