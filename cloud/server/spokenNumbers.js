/*
 * The numbers, spoken by the relay itself.
 *
 * WHY THIS FILE EXISTS. Numeric entry on this device is a knob and an ear:
 * one detent is +1, and ~200 ms after the knob stops the owner must hear the
 * bare number — "seven.", "twenty-three." — and nothing else. No units, no
 * sentence, no preamble. A number read back late is not a slow readback, it is
 * a WRONG one: the owner has already turned two more detents by the time it
 * arrives, so the voice is describing a value that no longer exists.
 *
 * That rules out the TTS path. cloud-relay/speak.js is a POST to
 * /audio/speech and it costs 500-1500 ms of round trip on a good LTE link,
 * which is one to three detents of lag, plus a network dependency on a device
 * whose whole promise is that the knob works. So the number is synthesized
 * HERE, on the relay, from nothing but arithmetic — no network, no audio
 * assets on disk, no model.
 *
 * THE PRECEDENT IS pendantEarcon.js and this file follows it exactly: 24 kHz
 * mono s16le, the pendant's own reply format (REALTIME_PCM_RATE), so these
 * buffers ride the same streamAnnouncementPcm path every other relay-composed
 * sound rides. Nothing is resampled, no new audio path exists, and a number
 * and a detent blip can be concatenated without a conversion in between.
 *
 * HOW IT SOUNDS THE WAY IT DOES. This is a Klatt-lite source-filter
 * synthesizer: a glottal pulse train (or shaped noise) driven through four
 * cascaded resonators whose centre frequencies are the formant targets of the
 * phoneme currently being spoken, INTERPOLATED between neighbours so a word is
 * a continuous gesture rather than a row of steady tones. The word set is
 * closed — twenty-eight words cover every number this device will ever say —
 * so the phonetics are hand-tuned per word instead of derived by a
 * letter-to-sound engine that would be bigger than this whole file and worse
 * at the only thirty words it needed to get right.
 *
 * WHAT IT IS NOT. It is not the pendant's voice. Sentences still go through
 * TTS, and they should: this thing is a talking dial, tuned for one job where
 * latency beats timbre. Anywhere latency does not beat timbre, use speak.js.
 *
 * DETERMINISTIC BY CONSTRUCTION. Same integer in, byte-identical buffer out —
 * the two noise sources are seeded PRNGs reset on every call, never
 * Math.random(). That is what lets the tests assert on the waveform at all,
 * and it is what will let a future caller memoize 0..59 into a table without
 * having to prove anything new.
 */

const DEFAULT_SAMPLE_RATE = 24_000

/* Same rail pendantEarcon.js sits at, for the same reason it gives: this
 * thing is 2 cm from a collarbone, not across a room. Every utterance is
 * normalized to exactly this peak, so a number never arrives louder than the
 * detent blip that preceded it. */
const PEAK = 0.22

/*
 * Pitch falls across the utterance — 128 Hz down to 98 Hz. A flat F0 is the
 * single thing that makes a formant synthesizer sound like a fire alarm
 * reading digits; a declining one is heard as a STATEMENT, which is what a
 * settled number is. The fall is per-utterance, not per-word, so
 * "twenty-three" is one gesture and not two numbers in a row.
 */
const F0_START_HZ = 128
const F0_END_HZ = 98

/* Fixed upper pole. F4 does not move for any phoneme in this set, and giving
 * it a wide bandwidth is what keeps the spectrum above 3 kHz from sounding
 * like a whistle. */
const F4_HZ = 3650
const F4_BW = 260

/* Resonator coefficients are recomputed every millisecond rather than every
 * sample. At 24 kHz that is 24 samples per update: far finer than the ~10 ms
 * over which formants actually move, and it takes four transcendentals per
 * millisecond instead of four per sample. */
const COEFF_UPDATE_SAMPLES = 24

/* Raised-cosine edges, the lesson pendantEarcon.js already paid for: a
 * square-edged start at 24 kHz is a click, and a click in front of every
 * number is the sound of a broken device. */
const FADE_MS = 8

/* Two independent noise streams so that frication and aspiration never
 * correlate (a single stream shared between them makes /s/ and the release of
 * /t/ sound like the same event). Constants, not entropy — see the
 * determinism note in the header. */
const FRICATION_SEED = 0x5eed_5eed
const ASPIRATION_SEED = 0x1eaf_1eaf

/* Gain of the frication branch relative to the voiced branch. Measured, not
 * guessed: with both branches peak-normalized, raw noise through one bandpass
 * lands within a couple of dB of a vowel, which is nothing like speech — a
 * real /s/ sits well below the vowel in level and still reads clearly because
 * it owns a band the vowel has nothing in. This is the scalar that puts it
 * there. */
const FRICATION_GAIN = 0.85
const ASPIRATION_GAIN = 0.55

/* ------------------------------------------------------------ phonemes */

/*
 * Every control point carries a COMPLETE parameter set, because the renderer
 * interpolates linearly between adjacent points and a missing field would
 * silently mean "glide to the default" — which is how a stop burst ends up
 * dragging the formants to 500/1500 mid-word.
 */
const POINT_DEFAULTS = Object.freeze({
  f1: 500,
  f2: 1500,
  f3: 2500,
  b1: 80,
  b2: 120,
  b3: 180,
  av: 0, // voicing amplitude
  af: 0, // frication amplitude
  fz: 5200, // frication centre frequency
  fbw: 2000, // frication bandwidth
  asp: 0, // aspiration, driven THROUGH the cascade so it takes vowel colour
})

function point(at, fields) {
  return Object.freeze({ ...POINT_DEFAULTS, ...fields, at })
}

/*
 * A vowel gets TWO identical targets, at 30% and 75% of its span. That gap is
 * the steady state, and it is the whole reason a vowel is identifiable: with a
 * single target the vowel is a continuous glide from the previous consonant to
 * the next one and never actually arrives anywhere. It is also the window the
 * tests take their DFT over.
 */
function vowel(ms, [f1, f2, f3], { av = 1, b = [70, 110, 170] } = {}) {
  const target = { f1, f2, f3, b1: b[0], b2: b[1], b3: b[2], av }
  return Object.freeze({
    type: 'vowel',
    ms,
    sustained: true,
    points: Object.freeze([point(0.3, target), point(0.75, target)]),
  })
}

/*
 * A diphthong is two targets and the glide between them, and the glide is the
 * identity: the /ay/ of "nine" is not a vowel, it is a trip from /aa/ to /ih/.
 * Rendering it as either endpoint alone gives "non" or "neen".
 */
function diphthong(ms, from, to) {
  const shape = (f) => ({ f1: f[0], f2: f[1], f3: f[2], b1: 70, b2: 110, b3: 170, av: 1 })
  return Object.freeze({
    type: 'diphthong',
    ms,
    sustained: true,
    points: Object.freeze([point(0.25, shape(from)), point(0.85, shape(to))]),
  })
}

/*
 * Glides and liquids. One target for /w/ and /r/, which really are pure
 * transition — they exist only as the bend they put in the vowel next to them.
 * /l/ takes two, because a lateral has a genuine steady state and a
 * single-target /l/ is swallowed whole by its neighbours: "twelve" came out
 * closer to "six" than to "twelve" under the confusion probe until it got one.
 */
function glide(ms, [f1, f2, f3], { av = 0.9, b = [80, 120, 180], hold = false } = {}) {
  const target = { f1, f2, f3, b1: b[0], b2: b[1], b3: b[2], av }
  return Object.freeze({
    type: 'glide',
    ms,
    sustained: true,
    points: Object.freeze(
      hold ? [point(0.3, target), point(0.75, target)] : [point(0.45, target)],
    ),
  })
}

/*
 * Nasal murmur: a very low, narrow F1 with everything above it damped almost
 * flat. Six of the twenty-eight words end in /n/ ("seven", "nine", "ten",
 * "eleven", the whole teens), so a nasal that reads as a vowel would blur the
 * most contrastive position in the set.
 */
function nasal(ms, [f1, f2, f3]) {
  const target = { f1, f2, f3, b1: 90, b2: 260, b3: 320, av: 0.7 }
  return Object.freeze({
    type: 'nasal',
    ms,
    sustained: true,
    points: Object.freeze([point(0.35, target), point(0.8, target)]),
  })
}

/*
 * Fricatives are noise through a bandpass, and the CENTRE of that band is the
 * only cue distinguishing them: /s/ high and strong at 6.2 kHz, /th/ and /f/
 * high but weak and diffuse. The formant fields still matter even though the
 * voicing is off — they are the locus the following vowel departs from.
 */
function fricative(ms, [f1, f2, f3], { af, fz, fbw, av = 0 }) {
  const target = { f1, f2, f3, b1: 90, b2: 140, b3: 200, av, af, fz, fbw }
  return Object.freeze({
    type: 'fricative',
    ms,
    points: Object.freeze([point(0.25, target), point(0.8, target)]),
  })
}

/*
 * A stop is SILENCE and then a bang, and the silence is the larger half of the
 * cue. "Two", "eight", "ten" and every -teen and -ty in the set hang on it, so
 * the closure is modelled explicitly rather than being approximated by a fast
 * amplitude dip.
 *
 * The final control point sits at 0.85 rather than 1.0 so the last sliver of
 * the stop is already gliding toward the following vowel: a release whose
 * formants are still parked at the locus sounds like a click stuck to the
 * front of the syllable instead of part of it.
 */
function stop(
  ms,
  [f1, f2, f3],
  { closure = 0.5, burstAf, burstFz, burstFbw, aspiration = 0.3, voiceBar = 0 },
) {
  const locus = { f1, f2, f3, b1: 90, b2: 130, b3: 190 }
  return Object.freeze({
    type: 'stop',
    ms,
    points: Object.freeze([
      point(0, { ...locus, av: voiceBar }),
      point(closure, { ...locus, av: voiceBar }),
      /* 3% of the span later: at 88 ms that is a ~2.6 ms attack, which is a
       * burst. Ramp it over any longer and the stop becomes a fricative. */
      point(closure + 0.03, {
        ...locus,
        av: voiceBar,
        af: burstAf,
        fz: burstFz,
        fbw: burstFbw,
      }),
      point(closure + 0.18, {
        ...locus,
        av: voiceBar,
        af: burstAf * 0.3,
        fz: burstFz,
        fbw: burstFbw,
        asp: aspiration,
      }),
      point(0.85, { ...locus, af: 0, asp: aspiration * 0.4 }),
    ]),
  })
}

/**
 * The phoneme inventory, and the whole phonetic claim of this file. Exported
 * so the tests can assert against the INTENDED targets — and so a bench listen
 * that finds a bad word has one obvious place to correct it.
 *
 * Formant values are conventional adult-male targets (Peterson-Barney
 * neighbourhood). They are not this device's owner's voice and are not trying
 * to be: the goal is a number that is unmistakable at 2 cm, not a person.
 */
export const PHONEMES = Object.freeze({
  /* --- vowels ------------------------------------------------------- */
  iy: vowel(125, [300, 2300, 3010]), // th-r-EE, s-i-x-t-EE-n
  ih: vowel(95, [400, 1950, 2570]), // s-I-x, f-I-fty
  eh: vowel(115, [560, 1780, 2480]), // s-E-ven, t-E-n
  ah: vowel(120, [660, 1250, 2440]), // w-U-n, h-U-ndred
  ax: vowel(60, [520, 1450, 2400], { av: 0.75 }), // sev-E-n; reduced, and short
  ao: vowel(130, [580, 880, 2400]), // f-OU-r
  uw: vowel(150, [310, 920, 2280]), // t-WO
  er: vowel(145, [480, 1350, 1690]), // th-IR-ty; the low F3 IS the r-colour

  /* --- diphthongs: the glide is the identity ------------------------- */
  ey: diphthong(165, [530, 1800, 2500], [370, 2200, 2900]), // -EIGH-t
  ay: diphthong(175, [730, 1150, 2450], [420, 1900, 2600]), // n-I-ne, f-I-ve
  ow: diphthong(165, [520, 880, 2400], [360, 760, 2300]), // zer-O

  /* --- glides, liquids, nasal --------------------------------------- */
  /* 70 ms, not 60: a syllable-initial glide in English runs 60-90 ms, and
   * "one" is nothing but this glide and a nasal. */
  w: glide(70, [300, 620, 2200], { av: 0.85 }),
  r: glide(70, [470, 1180, 1600]), // low F3, same colour as /er/
  l: glide(80, [380, 1100, 2800], { av: 0.85, hold: true }),
  n: nasal(75, [260, 1300, 2500]),

  /* --- fricatives ---------------------------------------------------- */
  /* /s/ is the loudest and highest of them and it carries "six" and "seven"
   * and every "-ty" that starts with one; 6.2 kHz is comfortably inside the
   * 12 kHz Nyquist this rate gives us. */
  s: fricative(110, [400, 1700, 2600], { af: 0.5, fz: 6200, fbw: 1400 }),
  z: fricative(95, [300, 1700, 2600], { af: 0.3, fz: 5200, fbw: 1600, av: 0.35 }),
  /* /th/ and /f/ are the two weakest sounds in English and the two this
   * synthesizer is least able to distinguish — both are diffuse noise with no
   * strong pole. They are kept quiet and wide rather than being faked into
   * something crisper, because a loud /th/ turns "three" into "see". */
  th: fricative(85, [350, 1650, 2600], { af: 0.22, fz: 6800, fbw: 3400 }),
  f: fricative(85, [350, 1000, 2200], { af: 0.22, fz: 5500, fbw: 3600 }),
  /* /v/ is the quietest sound in the inventory and it ends three words
   * ("five", "twelve", and the middle of "seven"/"eleven"). 70 ms rather than
   * 60 so there is something there to hear at all. */
  v: fricative(70, [300, 1100, 2200], { af: 0.16, fz: 5000, fbw: 3000, av: 0.5 }),

  /* --- stops: closure, burst, release ------------------------------- */
  t: stop(88, [400, 1750, 2600], { burstAf: 0.55, burstFz: 4000, burstFbw: 1200, aspiration: 0.35 }),
  d: stop(55, [350, 1700, 2550], {
    closure: 0.55,
    burstAf: 0.3,
    burstFz: 2600,
    burstFbw: 1500,
    aspiration: 0.1,
    voiceBar: 0.12,
  }),
  k: stop(65, [380, 1900, 2400], {
    closure: 0.52,
    burstAf: 0.45,
    burstFz: 1900,
    burstFbw: 900,
    aspiration: 0.25,
  }),

  /* --- /h/: noise through the cascade, so it wears the next vowel's
   * formants. That is what makes it an /h/ and not a hiss. -------------- */
  hh: Object.freeze({
    type: 'aspirate',
    ms: 60,
    points: Object.freeze([
      point(0.3, { f1: 620, f2: 1300, f3: 2400, b1: 200, b2: 220, b3: 260, asp: 0.55 }),
    ]),
  }),

  /* --- the seam between two words of one number ---------------------- */
  /* 45 ms. "Twenty-three" is ONE number, so this is a seam and not a pause;
   * long enough that the /iy/ of "twenty" does not run into the /th/ of
   * "three", short enough that nobody hears two separate utterances. */
  _: Object.freeze({
    type: 'silence',
    ms: 45,
    points: Object.freeze([point(0.5, {})]),
  }),
})

/* ------------------------------------------------------------ words */

/*
 * The closed set. Twenty-eight words is every number this device can ever say,
 * which is exactly why hand-tuned transcriptions beat a letter-to-sound
 * engine here — "one" is /w ah n/ and no rule-based speller will tell you so.
 *
 * Reduced vowels are written as /ax/ deliberately: "seven" is SEV-'n, not
 * SEV-EN, and spelling the second syllable full is the single clearest way to
 * make a synthesizer sound like it is reading letters.
 */
const WORD_PHONEMES = Object.freeze({
  zero: Object.freeze(['z', 'iy', 'r', 'ow']),
  one: Object.freeze(['w', 'ah', 'n']),
  two: Object.freeze(['t', 'uw']),
  three: Object.freeze(['th', 'r', 'iy']),
  four: Object.freeze(['f', 'ao', 'r']),
  five: Object.freeze(['f', 'ay', 'v']),
  six: Object.freeze(['s', 'ih', 'k', 's']),
  seven: Object.freeze(['s', 'eh', 'v', 'ax', 'n']),
  eight: Object.freeze(['ey', 't']),
  nine: Object.freeze(['n', 'ay', 'n']),
  ten: Object.freeze(['t', 'eh', 'n']),
  eleven: Object.freeze(['ih', 'l', 'eh', 'v', 'ax', 'n']),
  twelve: Object.freeze(['t', 'w', 'eh', 'l', 'v']),
  thirteen: Object.freeze(['th', 'er', 't', 'iy', 'n']),
  fourteen: Object.freeze(['f', 'ao', 'r', 't', 'iy', 'n']),
  fifteen: Object.freeze(['f', 'ih', 'f', 't', 'iy', 'n']),
  sixteen: Object.freeze(['s', 'ih', 'k', 's', 't', 'iy', 'n']),
  seventeen: Object.freeze(['s', 'eh', 'v', 'ax', 'n', 't', 'iy', 'n']),
  eighteen: Object.freeze(['ey', 't', 'iy', 'n']),
  nineteen: Object.freeze(['n', 'ay', 'n', 't', 'iy', 'n']),
  twenty: Object.freeze(['t', 'w', 'eh', 'n', 't', 'iy']),
  thirty: Object.freeze(['th', 'er', 't', 'iy']),
  forty: Object.freeze(['f', 'ao', 'r', 't', 'iy']),
  fifty: Object.freeze(['f', 'ih', 'f', 't', 'iy']),
  sixty: Object.freeze(['s', 'ih', 'k', 's', 't', 'iy']),
  seventy: Object.freeze(['s', 'eh', 'v', 'ax', 'n', 't', 'iy']),
  eighty: Object.freeze(['ey', 't', 'iy']),
  ninety: Object.freeze(['n', 'ay', 'n', 't', 'iy']),
  hundred: Object.freeze(['hh', 'ah', 'n', 'd', 'r', 'ih', 'd']),
})

/** Every word this synthesizer knows. If a caller ever needs a word that is
 * not in here, the answer is TTS, not a new rule. */
export const SPOKEN_WORDS = Object.freeze(Object.keys(WORD_PHONEMES))

const ONES = Object.freeze([
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
])

const TENS = Object.freeze([
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
])

/** The largest integer this file will speak. Three digits is already more than
 * the device needs (0-59 for clock fields, 1-180 for timer minutes); beyond it
 * the composition rules stop being trivial and the caller should be using
 * words, not a dial. */
export const MAX_SPOKEN_NUMBER = 999

/**
 * The number as words: 23 -> ['twenty','three'], 118 -> ['one','hundred','eighteen'].
 *
 * Tokens, not a string, and no hyphen anywhere — "twenty-three" is two words
 * to a synthesizer and one word to a printer, and this is the synthesizer's
 * side. A caller that wants text joins them; a caller that wants a TTS
 * sentence should not be using this file at all.
 *
 * No "and": American convention, and it matches what the TTS voice says for
 * the same value, so the knob readback and the spoken confirmation agree.
 */
export function numberWords(n) {
  const value = Number(n)
  if (!Number.isInteger(value) || value < 0 || value > MAX_SPOKEN_NUMBER) {
    throw new RangeError(`numberWords: ${n} is not an integer 0..${MAX_SPOKEN_NUMBER}`)
  }
  if (value < 20) return [ONES[value]]
  if (value < 100) {
    const tens = TENS[Math.floor(value / 10)]
    const ones = value % 10
    return ones ? [tens, ONES[ones]] : [tens]
  }
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  const head = [ONES[hundreds], 'hundred']
  return rest ? head.concat(numberWords(rest)) : head
}

/**
 * One word's phonemes. Exported so the tests can assert the PHONETICS rather
 * than a waveform: if "eleven" ever loses its schwa, that should fail here in
 * a line anyone can read, not in a spectral assertion nobody can debug.
 */
export function phonemesFor(word) {
  const key = String(word ?? '').trim().toLowerCase()
  const phonemes = WORD_PHONEMES[key]
  if (!phonemes) throw new RangeError(`phonemesFor: "${word}" is not a number word`)
  return phonemes.slice()
}

/* ------------------------------------------------------------ timing */

/*
 * The last sustained sound of the utterance is stretched by a third. Final
 * lengthening is what an English speaker does at the end of a statement, and
 * without it a bare number sounds clipped — like the device was interrupted
 * mid-word, which on a screenless device reads as a fault rather than a style.
 */
const FINAL_LENGTHENING = 1.3

/**
 * Where every phoneme lands, in milliseconds. Pure, and exported because it is
 * the only honest way for a test to window the steady state of a particular
 * vowel: the alternative is for the test to re-derive this arithmetic, which
 * would then agree with a broken renderer just as happily as with a good one.
 */
export function phonemeTimeline(n, { sampleRate = DEFAULT_SAMPLE_RATE } = {}) {
  const { segments } = buildPlan(n, sampleRate)
  return segments.map((segment) => ({
    word: segment.word,
    phoneme: segment.phoneme,
    type: PHONEMES[segment.phoneme].type,
    startMs: (segment.start / sampleRate) * 1000,
    endMs: (segment.end / sampleRate) * 1000,
  }))
}

function buildPlan(n, sampleRate) {
  const words = numberWords(n)

  /* The phoneme run, with a seam between words. Built as one flat list because
   * the renderer interpolates ACROSS word boundaries too — the /iy/ of
   * "twenty" and the /th/ of "three" are neighbours in one gesture. */
  const run = []
  words.forEach((word, index) => {
    if (index > 0) run.push({ word: null, phoneme: '_' })
    for (const phoneme of phonemesFor(word)) run.push({ word, phoneme })
  })

  const last = run[run.length - 1]
  const segments = []
  let cursor = 0
  for (const item of run) {
    const spec = PHONEMES[item.phoneme]
    const stretch = item === last && spec.sustained ? FINAL_LENGTHENING : 1
    const length = Math.max(1, Math.round((spec.ms * stretch * sampleRate) / 1000))
    segments.push({ ...item, start: cursor, end: cursor + length })
    cursor += length
  }

  /* Absolute control points. Two points can land on the same sample (the end
   * of one phoneme and the start of the next); the renderer steps rather than
   * dividing by zero. */
  const points = []
  for (const segment of segments) {
    const span = segment.end - segment.start
    for (const p of PHONEMES[segment.phoneme].points) {
      points.push({ t: segment.start + p.at * span, p })
    }
  }

  return { segments, points, totalSamples: cursor }
}

/* ------------------------------------------------------------ synthesis */

/* mulberry32. A named, seeded generator rather than Math.random() — see the
 * determinism note in the header; the tests compare buffers byte for byte. */
function makeNoise(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) - 0.5) * 2
  }
}

/*
 * Two-pole resonators, in TWO different normalizations — and which one goes
 * where is the difference between speech and mud.
 *
 * The cascade is DC-normalized (a = 1 - b - c, Klatt's own choice). Each stage
 * then passes everything BELOW its resonance at unity and only lifts its own
 * peak, so four stages in series produce one spectral envelope with four
 * bumps. Peak-normalizing a cascade instead — which reads as the more
 * principled choice, and was the first thing tried here — attenuates every
 * frequency below each stage's resonance by 20-30 dB, so F1 arrives at the
 * output roughly 60 dB down and the vowel is inaudible under its own /s/.
 * Measured on "three": the /iy/ came out at an RMS of zero to four decimals.
 *
 * The frication branch is a single isolated bandpass with nothing after it, so
 * there the peak normalization IS right: it makes af in the phoneme table mean
 * a level rather than a level times whatever gain the bandwidth happened to
 * imply.
 */
function resonator() {
  return { a: 0, b: 0, c: 0, y1: 0, y2: 0 }
}

function tuneCascade(res, frequency, bandwidth, sampleRate) {
  const r = Math.exp((-Math.PI * bandwidth) / sampleRate)
  const b = 2 * r * Math.cos((2 * Math.PI * frequency) / sampleRate)
  const c = -(r * r)
  res.b = b
  res.c = c
  res.a = 1 - b - c
}

function tuneBandpass(res, frequency, bandwidth, sampleRate) {
  const r = Math.exp((-Math.PI * bandwidth) / sampleRate)
  const theta = (2 * Math.PI * frequency) / sampleRate
  res.b = 2 * r * Math.cos(theta)
  res.c = -(r * r)
  res.a = (1 - r) * Math.sqrt(1 - 2 * r * Math.cos(2 * theta) + r * r)
}

/*
 * Rosenberg glottal pulse, differentiated.
 *
 * Differentiated because the source the vocal tract actually sees, once the
 * +6 dB/octave of radiation at the lips is folded in, is the DERIVATIVE of
 * glottal flow — and because differentiating removes the DC that would
 * otherwise walk the resonator states around and cost headroom for nothing.
 * The sharp negative excursion at closure is the part that carries the higher
 * formants; a pure sine source excites F1 and nothing else, which is why a
 * naive synthesizer sounds like a hum with a vowel painted on it.
 */
const GLOTTAL_OPEN = 0.6
const GLOTTAL_CLOSE = 0.16

function glottalFlow(phase) {
  if (phase < GLOTTAL_OPEN) return 0.5 * (1 - Math.cos((Math.PI * phase) / GLOTTAL_OPEN))
  if (phase < GLOTTAL_OPEN + GLOTTAL_CLOSE) {
    return Math.cos((Math.PI * (phase - GLOTTAL_OPEN)) / (2 * GLOTTAL_CLOSE))
  }
  return 0
}

/* Scales the differentiated pulse back to roughly unit peak so that the level
 * of a vowel does not swing with F0 as the declination falls. */
const GLOTTAL_NORM = 0.1

function synthesize(plan, sampleRate) {
  const { points, totalSamples } = plan
  const out = new Float32Array(totalSamples)

  const r1 = resonator()
  const r2 = resonator()
  const r3 = resonator()
  const r4 = resonator()
  const fricBand = resonator()
  /* F4 never moves for any phoneme in this set, so it is tuned once and left
   * out of the millisecond update entirely. */
  tuneCascade(r4, F4_HZ, F4_BW, sampleRate)

  const fricNoise = makeNoise(FRICATION_SEED)
  const aspNoise = makeNoise(ASPIRATION_SEED)

  let phase = 0
  let previousFlow = 0

  /* Control-point cursor. The parameter track is walked once, forwards, rather
   * than being expanded into one array per parameter: eleven Float arrays per
   * utterance is a megabyte of garbage per number on a path that is meant to
   * run on every detent. */
  let index = 0
  let a = points[0].p
  let b = points[0].p
  let t0 = points[0].t
  let invSpan = 0
  const retarget = () => {
    const next = points[Math.min(index + 1, points.length - 1)]
    a = points[index].p
    b = next.p
    t0 = points[index].t
    const span = next.t - t0
    invSpan = span > 0 ? 1 / span : 0
  }
  retarget()

  for (let i = 0; i < totalSamples; i += 1) {
    if (index < points.length - 2 && points[index + 1].t <= i) {
      while (index < points.length - 2 && points[index + 1].t <= i) index += 1
      retarget()
    }

    /* Clamped, so the run before the first control point and after the last
     * one HOLDS rather than extrapolating off into a formant that no phoneme
     * asked for. */
    let k = (i - t0) * invSpan
    if (k < 0) k = 0
    else if (k > 1) k = 1

    const av = a.av + (b.av - a.av) * k
    const af = a.af + (b.af - a.af) * k
    const asp = a.asp + (b.asp - a.asp) * k

    if (i % COEFF_UPDATE_SAMPLES === 0) {
      tuneCascade(r1, a.f1 + (b.f1 - a.f1) * k, a.b1 + (b.b1 - a.b1) * k, sampleRate)
      tuneCascade(r2, a.f2 + (b.f2 - a.f2) * k, a.b2 + (b.b2 - a.b2) * k, sampleRate)
      tuneCascade(r3, a.f3 + (b.f3 - a.f3) * k, a.b3 + (b.b3 - a.b3) * k, sampleRate)
      tuneBandpass(fricBand, a.fz + (b.fz - a.fz) * k, a.fbw + (b.fbw - a.fbw) * k, sampleRate)
    }

    const f0 = F0_START_HZ + (F0_END_HZ - F0_START_HZ) * (i / totalSamples)
    phase += f0 / sampleRate
    if (phase >= 1) phase -= 1
    const flow = glottalFlow(phase)
    const pulse = (flow - previousFlow) / GLOTTAL_NORM
    previousFlow = flow

    /* Voicing and aspiration share the cascade; frication does not. That is
     * the whole source-filter split: /h/ is noise IN the vocal tract and so it
     * wears the vowel's formants, while /s/ is noise made AT the constriction,
     * downstream of everything, and wears only its own band. */
    let x = pulse * av + aspNoise() * asp * ASPIRATION_GAIN
    let y = r1.a * x + r1.b * r1.y1 + r1.c * r1.y2
    r1.y2 = r1.y1
    r1.y1 = y
    x = y
    y = r2.a * x + r2.b * r2.y1 + r2.c * r2.y2
    r2.y2 = r2.y1
    r2.y1 = y
    x = y
    y = r3.a * x + r3.b * r3.y1 + r3.c * r3.y2
    r3.y2 = r3.y1
    r3.y1 = y
    x = y
    y = r4.a * x + r4.b * r4.y1 + r4.c * r4.y2
    r4.y2 = r4.y1
    r4.y1 = y

    const n = fricNoise()
    const fy = fricBand.a * n + fricBand.b * fricBand.y1 + fricBand.c * fricBand.y2
    fricBand.y2 = fricBand.y1
    fricBand.y1 = fy

    out[i] = y + fy * af * FRICATION_GAIN
  }

  return out
}

function toPcm(samples, sampleRate) {
  /* Peak normalization, per utterance. Absolute level out of a formant
   * synthesizer is a function of how many resonators happened to line up, not
   * of anything meaningful, so it is set here instead — and setting it here is
   * also what guarantees nothing ever reaches the int16 rail. */
  let loudest = 0
  for (const value of samples) loudest = Math.max(loudest, Math.abs(value))
  const scale = loudest > 0 ? PEAK / loudest : 0

  const fade = Math.max(1, Math.round((FADE_MS / 1000) * sampleRate))
  const pcm = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    let value = samples[i] * scale
    if (i < fade) value *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fade)
    const tail = samples.length - 1 - i
    if (tail < fade) value *= 0.5 - 0.5 * Math.cos((Math.PI * tail) / fade)
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2)
  }
  return pcm
}

/**
 * The number, spoken, as 24 kHz mono s16le PCM.
 *
 * This is the whole public surface the numeric-entry mode needs: one call per
 * settle, no await, no socket, no cache to warm.
 *
 * MEASURED on this Mac (2026-08-13, node 22, per-number median of nine warmed
 * runs): 0.74 ms mean and 1.11 ms worst across the clock range 0..59, 1.27 ms
 * mean and 2.14 ms worst across 0..199 — about a thousandth of the audio it
 * produces. The same words through speak.js are a 500-1500 ms round trip. That
 * three-orders-of-magnitude gap is the entire reason numeric entry can promise
 * the owner that the number arrives when the knob stops, and it is why a
 * settle costs less than the detent blip it follows.
 */
export function renderNumberPcm(n, { sampleRate = DEFAULT_SAMPLE_RATE } = {}) {
  const rate = Math.max(8000, Math.round(Number(sampleRate) || DEFAULT_SAMPLE_RATE))
  const plan = buildPlan(n, rate)
  return toPcm(synthesize(plan, rate), rate)
}
