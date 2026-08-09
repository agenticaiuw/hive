import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BRIEF_SPEECH_RATE_WPM,
  clampSpokenToBudget,
  describeSpokenBudget,
  estimateSpokenSeconds,
  parseSpokenBudget,
  spokenBudgetPromptRule,
  spokenWordCount,
} from './spokenBudget.js'
import { composeBrief, spokenScript } from './research.js'

/*
 * The spoken-length budget, end to end: the parser, and the two places in
 * research.js it changes.
 *
 * No workspace import here on purpose — nothing under test touches disk.
 * research.js deliberately does not import audioBrief.js so it stays testable
 * without a workspace, and spokenBudget.js keeps that true.
 */

/* The command the owner's routine actually fired, and the topic the planner
 * actually recorded for it (briefing shelf, 2026-08-09T00:16:58Z). */
const LIVE_COMMAND =
  'Give me the top world and US news headlines from the last 12 hours, as three short spoken sentences.'
const LIVE_TOPIC =
  'Top world and US news headlines from the last 12 hours, as three short spoken sentences'

/* The script that run produced: 794 characters, 125 words, 42.7 s of audio. */
const LIVE_SPOKEN =
  "Here's your briefing on Top world and US news headlines from the last 12 hours, as three short spoken sentences. I read 1 source. There are no verified US or world headlines from the last 12 hours in the available search results, and the newest source is a Week roundup last updated August 7, 2026. That roundup says US front pages were focused on a possible expansion of broadcaster ownership, changes affecting SNAP benefits, concern over a federal Head Start overhaul, alleged Justice Department missteps, and a dispute involving President Trump and Defense Secretary Hegseth. Internationally, it cited warnings about Russia potentially testing NATO, Ukraine’s appeals for air defenses, and broader concerns over munition policy, but these are not confirmed as the latest developments today."

function capturingLlm(reply) {
  const calls = []
  return {
    calls,
    llm: async (options) => {
      calls.push(options)
      return JSON.stringify(reply)
    },
  }
}

const MODEL_REPLY = {
  headline: 'Headline under a hundred characters',
  keyPoints: [
    { point: 'First written point.', sources: [] },
    { point: 'Second written point.', sources: [] },
    { point: 'Third written point.', sources: [] },
    { point: 'Fourth written point.', sources: [] },
  ],
  recommendation: 'A recommendation that runs to a sentence or two of its own.',
  openQuestions: ['What the sources did not settle.'],
  spoken: 'The model wrote this.',
}

test('the live command is recognised as a three-sentence spoken budget', () => {
  for (const text of [LIVE_COMMAND, LIVE_TOPIC]) {
    const budget = parseSpokenBudget(text)
    assert.ok(budget, `expected a budget from: ${text}`)
    assert.equal(budget.sentences, 3)
    assert.equal(budget.seconds, null)
    assert.equal(budget.words, 48)
    assert.deepEqual(budget.matched, ['sentence-count'])
    assert.equal(budget.phrase, 'three short spoken sentences')
  }
})

test('the phrasings the planner recorded across the live runs all parse', () => {
  /* Every topic the planner wrote for this one command on 2026-08-08/09. The
   * wording moved run to run; the budget must not. */
  const observed = [
    'Top world and US news headlines from the last 12 hours, as three short spoken sentences',
    'Top world and US news headlines from the last 12 hours, summarized as three short spoken sentences',
    'Top world and U.S. news headlines from the last 12 hours, summarized as exactly three short spoken sentences',
    'Top world and US news headlines from the last 12 hours, in three short spoken sentences',
  ]
  for (const topic of observed) {
    assert.equal(parseSpokenBudget(topic)?.sentences, 3, topic)
  }
})

test('the supported phrasings, and what each one means', () => {
  const table = [
    ['Summarize the Fed decision in two sentences', { sentences: 2, seconds: null }],
    ['Three short sentences on the election, please', { sentences: 3, seconds: null }],
    ['What happened in tech today, keep it under 30 seconds', { sentences: null, seconds: 30 }],
    ['Catch me up on the war, under a minute', { sentences: null, seconds: 60 }],
    ['Tell me about the new iPhone briefly', { sentences: 3, seconds: null }],
    ['Give me the weather in one line', { sentences: 1, seconds: null }],
    ['Explain quantum computing, one-liner', { sentences: 1, seconds: null }],
    ['The tariff news in a sentence', { sentences: 1, seconds: null }],
  ]
  for (const [text, expected] of table) {
    const budget = parseSpokenBudget(text)
    assert.ok(budget, `expected a budget from: ${text}`)
    assert.equal(budget.sentences, expected.sentences, text)
    assert.equal(budget.seconds, expected.seconds, text)
  }
})

test('an explicit number beats a bare "briefly"', () => {
  const budget = parseSpokenBudget('Briefly, and in two sentences, what happened?')
  assert.equal(budget.sentences, 2)
  assert.deepEqual(budget.matched, ['sentence-count'])
})

test('a sentence count and a second limit together take the tighter one', () => {
  const budget = parseSpokenBudget('Three short sentences, under 10 seconds')
  assert.equal(budget.sentences, 3)
  assert.equal(budget.seconds, 10)
  /* 10 s at the briefing rate is ~31 words, tighter than 3 x 16. */
  assert.equal(budget.words, Math.round((10 * BRIEF_SPEECH_RATE_WPM) / 60))
})

test('unrecognised phrasings fall through to the behaviour of today', () => {
  const untouched = [
    /* No length instruction at all — the ordinary case. */
    'Give me my morning brief',
    'Summarize this page',
    'Research the best standing desks under $400 and compare them',
    /* Numbers that are not about how long to speak. */
    'What are the top 3 headlines from the last 12 hours',
    'Compare the top five mirrorless cameras with 10 sources',
    'Remind me in 30 seconds',
    /* "sentence" as subject matter, not as a length. */
    'Explain the difference between a sentence and a clause',
    /* Real length phrasings that are not shorter than what we already do, so
     * honouring them would make briefings LONGER. */
    'Give me a rundown in under three minutes',
    'The news in 20 sentences',
    /* Phrasings a person might use that this table deliberately does not
     * guess at. They get today's briefing, not a wrong one. */
    'Give me the gist',
    'Just the important bits',
    'Make it snappy',
  ]
  for (const text of untouched) {
    assert.equal(parseSpokenBudget(text), null, text)
  }
})

test('empty and non-string input is not a budget', () => {
  for (const value of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(parseSpokenBudget(value), null)
  }
})

test('the composer prompt is byte-identical when no length was stated', async () => {
  /*
   * Captured from the code as it stood before this feature existed. If a
   * future edit reflows the rules block, this fails and the reviewer gets to
   * decide whether the unbudgeted path really was meant to change.
   */
  const PRE_CHANGE_SYSTEM = `You write briefings that are READ ALOUD to their owner later. Write a short factual briefing. Lead with what changed or what is true now.

Return ONLY JSON:
{
  "headline": "one sentence, under 100 characters",
  "keyPoints": [{"point": "one sentence", "sources": [1, 2]}],
  "recommendation": "one or two sentences, or empty string",
  "openQuestions": ["what the sources did not settle"],
  "spoken": "the script to read aloud"
}

Rules:
- Every keyPoint cites at least one source number from the numbered sources below. Never cite a number that is not there.
- If the sources do not support a claim, leave it out and add it to openQuestions instead.
- 3 to 6 keyPoints. "spoken" is 150-320 words of plain spoken English: no markdown, no URLs, no bullet characters, no "click here". Name outlets by name ("according to TechRadar") instead of reading links.
- You cannot buy, book, order or pay for anything and you never claim to have done so. Recommending is the whole job.`

  const captured = capturingLlm(MODEL_REPLY)
  await composeBrief({
    topic: 'Kubernetes 1.31 release',
    mode: 'brief',
    overview: 'ov',
    sources: [],
    llm: captured.llm,
  })
  assert.equal(captured.calls[0].messages[0].content, PRE_CHANGE_SYSTEM)

  /* And passing an explicit null budget is the same thing. */
  const withNull = capturingLlm(MODEL_REPLY)
  await composeBrief({
    topic: 'Kubernetes 1.31 release',
    mode: 'brief',
    overview: 'ov',
    sources: [],
    llm: withNull.llm,
    spokenBudget: null,
  })
  assert.equal(withNull.calls[0].messages[0].content, PRE_CHANGE_SYSTEM)
})

test('a budget reaches the model that writes the script', async () => {
  const captured = capturingLlm(MODEL_REPLY)
  await composeBrief({
    topic: LIVE_TOPIC,
    mode: 'brief',
    sources: [],
    llm: captured.llm,
    spokenBudget: parseSpokenBudget(LIVE_TOPIC),
  })
  const system = captured.calls[0].messages[0].content

  assert.match(system, /LENGTH, STATED BY THE OWNER \("three short spoken sentences"\)/)
  assert.match(system, /"spoken" MUST be at most 3 sentences/)
  /* The standing 150-320 word rule must be gone, or the prompt contradicts
   * itself and the model picks the longer one — which is the original bug. */
  assert.doesNotMatch(system, /150-320 words/)
  /* Everything that is about quality rather than length survives. */
  assert.match(system, /3 to 6 keyPoints/)
  assert.match(system, /no markdown, no URLs/)
  assert.match(system, /according to TechRadar/)
  assert.match(system, /Recommending is the whole job/)
})

test('the budget is stated as applying to the spoken script only', () => {
  const rule = spokenBudgetPromptRule(parseSpokenBudget(LIVE_TOPIC))
  assert.match(rule, /applies to "spoken" ONLY/)
  assert.match(rule, /keyPoints/)
  assert.match(rule, /WRITTEN brief/)
  assert.equal(spokenBudgetPromptRule(null), '')
})

test('the written brief is not gutted when the spoken script is capped', async () => {
  /*
   * The owner asked to HEAR three sentences. The note filed on their Mac keeps
   * its headline, all four key points, the recommendation and the open
   * questions — composeBrief must not clip any of them.
   */
  const captured = capturingLlm({
    ...MODEL_REPLY,
    spoken: 'One. Two. Three. Four. Five. Six. Seven. Eight.',
  })
  const brief = await composeBrief({
    topic: LIVE_TOPIC,
    mode: 'brief',
    sources: [],
    llm: captured.llm,
    spokenBudget: parseSpokenBudget(LIVE_TOPIC),
  })

  assert.equal(brief.headline, MODEL_REPLY.headline)
  assert.equal(brief.keyPoints.length, 4)
  assert.deepEqual(
    brief.keyPoints.map((entry) => entry.point),
    MODEL_REPLY.keyPoints.map((entry) => entry.point),
  )
  assert.equal(brief.recommendation, MODEL_REPLY.recommendation)
  assert.deepEqual(brief.openQuestions, MODEL_REPLY.openQuestions)
  /* composeBrief returns the model's own script untouched; the cap that
   * belongs to the spoken artifact is applied by spokenScript. */
  assert.equal(brief.spoken, 'One. Two. Three. Four. Five. Six. Seven. Eight.')
})

test('spokenScript is unchanged, byte for byte, without a budget', () => {
  const brief = { spoken: 'Line one.\nLine two.' }
  const sources = [{ ok: true }, { ok: true }]

  assert.equal(
    spokenScript({ topic: 'Kubernetes 1.31', brief, sources }),
    "Here's your briefing on Kubernetes 1.31. I read 2 sources. Line one.\nLine two.",
  )
  assert.equal(
    spokenScript({ topic: 'Kubernetes 1.31', brief, sources, spokenBudget: null }),
    "Here's your briefing on Kubernetes 1.31. I read 2 sources. Line one.\nLine two.",
  )
  assert.equal(
    spokenScript({ topic: 'A topic', brief: { keyPoints: [] }, sources: [] }),
    "Here's your briefing on A topic. I read 0 sources. I couldn't read enough to say anything useful. The note on your Mac lists what I tried.",
  )
})

test('under a budget the preface goes, because it is two of the three sentences', () => {
  const budget = parseSpokenBudget(LIVE_TOPIC)
  const script = spokenScript({
    topic: LIVE_TOPIC,
    brief: { spoken: 'Russia tested NATO air defenses. The FCC lifted its ownership cap. Nothing else was confirmed.' },
    sources: [{ ok: true }],
    spokenBudget: budget,
  })

  assert.doesNotMatch(script, /Here's your briefing/)
  assert.doesNotMatch(script, /I read 1 source/)
  assert.ok(script.startsWith('Russia tested NATO'))
  assert.ok(
    estimateSpokenSeconds(script) < 15,
    `expected under 15 s, got ${estimateSpokenSeconds(script).toFixed(1)}`,
  )
})

test('the live 42.7 second script comes back inside the stated budget', () => {
  /*
   * The regression, measured. This is the exact text the owner heard, run
   * through the path as it now stands. The clamp is the backstop — the prompt
   * is what should keep it from ever getting here — but the backstop has to
   * work, and it has to end on a full stop rather than mid-word.
   */
  const budget = parseSpokenBudget(LIVE_TOPIC)
  const before = estimateSpokenSeconds(LIVE_SPOKEN)
  const after = estimateSpokenSeconds(clampSpokenToBudget(LIVE_SPOKEN, budget))

  assert.ok(before > 38, `expected the recorded script to be long, got ${before}`)
  assert.ok(after <= 18, `expected under 18 s, got ${after.toFixed(1)}`)
  assert.match(clampSpokenToBudget(LIVE_SPOKEN, budget), /[.!?]["'”’]?$/)
})

test('the clamp cuts between sentences, never inside one', () => {
  const budget = parseSpokenBudget('in two sentences')
  const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda.'
  assert.equal(
    clampSpokenToBudget(text, budget),
    'Alpha beta gamma. Delta epsilon zeta.',
  )

  /* An abbreviation mid-sentence is not a sentence boundary. */
  assert.equal(
    clampSpokenToBudget('The U.S. economy grew. Europe did not. Asia was flat.', budget),
    'The U.S. economy grew. Europe did not.',
  )

  /* One sentence longer than the whole word allowance is still returned
   * whole: a script that ends mid-word is worse than one that runs over. */
  const oneLine = parseSpokenBudget('in one line')
  const long = `${'word '.repeat(60).trim()}.`
  assert.equal(clampSpokenToBudget(long, oneLine), long)

  /* And nothing is ever returned empty. */
  assert.equal(clampSpokenToBudget('', budget), '')
  assert.equal(clampSpokenToBudget('   ', budget), '')
})

test('the estimate uses the rate briefings are actually rendered at', () => {
  assert.equal(BRIEF_SPEECH_RATE_WPM, 185)
  assert.equal(spokenWordCount(' one  two\nthree '), 3)
  assert.equal(estimateSpokenSeconds('one two three'), (3 / 185) * 60)
  /*
   * Sanity against the live measurement: 125 words rendered as 42.7 s of
   * audio. The estimate should land within a couple of seconds of that.
   */
  assert.ok(Math.abs(estimateSpokenSeconds(LIVE_SPOKEN) - 42.7) < 3)
})

test('describeSpokenBudget says what was understood', () => {
  assert.equal(describeSpokenBudget(parseSpokenBudget('in one line')), '1 sentence (about 16 words)')
  assert.equal(
    describeSpokenBudget(parseSpokenBudget(LIVE_TOPIC)),
    '3 sentences (about 48 words)',
  )
  assert.equal(
    describeSpokenBudget(parseSpokenBudget('keep it under 30 seconds')),
    '30 seconds (about 93 words)',
  )
  assert.equal(describeSpokenBudget(null), '')
})
