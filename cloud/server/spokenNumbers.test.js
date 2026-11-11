import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_SPOKEN_NUMBER,
  PHONEMES,
  SPOKEN_WORDS,
  numberWords,
  phonemeTimeline,
  phonemesFor,
  renderNumberPcm,
} from './spokenNumbers.js'

const RATE = 24_000

function samples(pcm) {
  const out = new Float64Array(pcm.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = pcm.readInt16LE(i * 2) / 32768
  return out
}

const durationMs = (pcm) => (pcm.length / 2 / RATE) * 1000

/* ------------------------------------------------------------ the words */

test('the number decomposes the way an English speaker says it', () => {
  assert.deepEqual(numberWords(0), ['zero'])
  assert.deepEqual(numberWords(7), ['seven'])
  assert.deepEqual(numberWords(10), ['ten'])
  /* The teens are single words, not "ten three" — the most common mistake a
   * naive decomposer makes, and the one that would make every clock field
   * between 13 and 19 sound wrong. */
  assert.deepEqual(numberWords(13), ['thirteen'])
  assert.deepEqual(numberWords(20), ['twenty'])
  assert.deepEqual(numberWords(21), ['twenty', 'one'])
  assert.deepEqual(numberWords(23), ['twenty', 'three'])
  /* A round ten is ONE word. "thirty zero" is the other classic failure. */
  assert.deepEqual(numberWords(30), ['thirty'])
  assert.deepEqual(numberWords(59), ['fifty', 'nine'])
  assert.deepEqual(numberWords(60), ['sixty'])
  assert.deepEqual(numberWords(99), ['ninety', 'nine'])
  assert.deepEqual(numberWords(100), ['one', 'hundred'])
  /* No "and": American convention, and it has to match what the TTS voice
   * says for the same value or the knob readback and the spoken confirmation
   * disagree about the same number. */
  assert.deepEqual(numberWords(118), ['one', 'hundred', 'eighteen'])
  assert.deepEqual(numberWords(180), ['one', 'hundred', 'eighty'])
})

test('every word the decomposer can emit is a word the synthesizer knows', () => {
  const emitted = new Set()
  for (let n = 0; n <= MAX_SPOKEN_NUMBER; n += 1) for (const word of numberWords(n)) emitted.add(word)
  for (const word of emitted) {
    assert.ok(SPOKEN_WORDS.includes(word), `${word} has no transcription`)
    assert.ok(phonemesFor(word).length > 0, `${word} has no phonemes`)
  }
  /* The set is closed on purpose. A word in the table that nothing can ever
   * say is dead weight in a hand-tuned inventory. */
  assert.equal(emitted.size, SPOKEN_WORDS.length)
})

test('a number outside the range refuses rather than mispronouncing', () => {
  assert.throws(() => numberWords(-1), RangeError)
  assert.throws(() => numberWords(1000), RangeError)
  assert.throws(() => numberWords(2.5), RangeError)
  assert.throws(() => phonemesFor('eleventeen'), RangeError)
})

/* ------------------------------------------------------------ phonetics */

test('the transcriptions are the ones a speaker uses, not the ones spelling implies', () => {
  /* "one" starts with a /w/. No letter-to-sound rule gets this from "o-n-e",
   * which is the whole argument for a hand-tuned closed set. */
  assert.deepEqual(phonemesFor('one'), ['w', 'ah', 'n'])
  /* Reduced second syllable. "SEV-EN" with a full vowel is the sound of a
   * machine reading letters. */
  assert.deepEqual(phonemesFor('seven'), ['s', 'eh', 'v', 'ax', 'n'])
  assert.ok(phonemesFor('eleven').includes('ax'), 'eleven lost its schwa')
  /* Diphthongs, not vowels: /ay/ is a trip from /aa/ to /ih/ and rendering
   * either endpoint alone gives "non" or "neen". */
  assert.ok(phonemesFor('nine').includes('ay'))
  assert.ok(phonemesFor('zero').includes('ow'))
  /* Stops that carry a word: "eight" is a diphthong and a closure. */
  assert.equal(PHONEMES[phonemesFor('eight')[1]].type, 'stop')
  assert.equal(PHONEMES[phonemesFor('three')[0]].type, 'fricative')
})

test('phonemesFor hands back a copy — the table is not editable through it', () => {
  const first = phonemesFor('nine')
  first.push('junk')
  assert.deepEqual(phonemesFor('nine'), ['n', 'ay', 'n'])
})

/* ------------------------------------------------------------ the buffer */

test('every number the pendant can show renders as playable PCM', () => {
  for (let n = 0; n <= 199; n += 1) {
    const pcm = renderNumberPcm(n)
    assert.ok(Buffer.isBuffer(pcm), `${n} did not render a Buffer`)
    assert.ok(pcm.length > 0, `${n} rendered nothing`)
    /* An odd byte length would shift the phase of every later frame; the
     * pendant's reply path is 24 kHz s16le and nothing here is resampled. */
    assert.equal(pcm.length % 2, 0, `${n} rendered a half sample`)
  }
})

test('the same number is byte-identical every time', () => {
  /* Determinism is not a nicety here: the noise sources are seeded rather than
   * random precisely so a future caller can memoize 0..59 into a table and
   * know the cached buffer is the one the synthesizer would have produced. */
  for (const n of [0, 7, 23, 59, 118, 199]) {
    assert.ok(renderNumberPcm(n).equals(renderNumberPcm(n)), `${n} is not deterministic`)
  }
  /* And different numbers are actually different — a synthesizer that returns
   * the same buffer for everything would pass every test above. */
  assert.ok(!renderNumberPcm(7).equals(renderNumberPcm(8)))
})

test('a spoken number lasts as long as a spoken number does', () => {
  const seven = durationMs(renderNumberPcm(7))
  /* THE GUARD AGAINST DEGENERATION. A synthesizer that quietly collapses to a
   * click still returns a valid even-length Buffer, so length is the cheapest
   * assertion that catches it. */
  assert.ok(seven > 250 && seven < 700, `"seven" is ${seven.toFixed(0)}ms`)

  const twentyThree = durationMs(renderNumberPcm(23))
  assert.ok(
    twentyThree > seven * 1.4,
    `"twenty-three" (${twentyThree.toFixed(0)}ms) is not meaningfully longer than "seven" (${seven.toFixed(0)}ms)`,
  )

  /* Nothing in the pendant's range turns into a speech. 199 is the longest
   * thing this file can be asked for in numeric entry. */
  for (let n = 0; n <= 199; n += 1) {
    const ms = durationMs(renderNumberPcm(n))
    assert.ok(ms > 200 && ms < 2200, `${n} lasts ${ms.toFixed(0)}ms`)
  }
})

test('nothing reaches the rail, and nothing clicks at the edges', () => {
  let worst = 0
  for (let n = 0; n <= 199; n += 1) {
    const pcm = renderNumberPcm(n)
    for (let i = 0; i < pcm.length; i += 2) worst = Math.max(worst, Math.abs(pcm.readInt16LE(i)))
  }
  /* Same conservative rail pendantEarcon.js sits at, for the same reason: this
   * thing is 2 cm from a collarbone. A number must never arrive louder than
   * the detent blip that preceded it. */
  assert.ok(worst < 0.35 * 32767, `peak ${worst}`)
  assert.ok(worst > 0.1 * 32767, `peak ${worst} — too quiet to hear`)

  /* A square-edged start at 24 kHz is a click, and a click in front of every
   * number is the sound of a broken device. */
  for (const n of [0, 7, 23, 118]) {
    const values = samples(renderNumberPcm(n))
    assert.ok(Math.abs(values[0]) < 0.005, `${n} starts with a step`)
    assert.ok(Math.abs(values[values.length - 1]) < 0.005, `${n} ends with a step`)
  }
})

test('the timeline accounts for every sample of the buffer', () => {
  for (const n of [7, 23, 118]) {
    const timeline = phonemeTimeline(n)
    const total = timeline[timeline.length - 1].endMs
    assert.ok(
      Math.abs(total - durationMs(renderNumberPcm(n))) < 0.05,
      `${n}: timeline ends at ${total}ms but the buffer is ${durationMs(renderNumberPcm(n))}ms`,
    )
    /* No gaps and no overlaps: the renderer walks one continuous parameter
     * track, and a hole in it would be a formant jump. */
    for (let i = 1; i < timeline.length; i += 1) {
      assert.equal(timeline[i].startMs, timeline[i - 1].endMs)
    }
  }
})

test('a different sample rate changes the buffer, not the utterance', () => {
  const at16k = renderNumberPcm(7, { sampleRate: 16_000 })
  const at24k = renderNumberPcm(7)
  const ms16 = (at16k.length / 2 / 16_000) * 1000
  assert.ok(Math.abs(ms16 - durationMs(at24k)) < 2, `${ms16}ms vs ${durationMs(at24k)}ms`)
})

/* --------------------------------------------------- the phonetic guard */

/*
 * THE MEASUREMENT THAT MATTERS.
 *
 * Everything above would still pass if the resonators were wired to constants
 * and the formant table were decoration. So: render the number, cut out the
 * steady state of one vowel, transform it, and look at where the energy
 * actually is. If F1 and F2 are not where PHONEMES says they should be, the
 * table is a comment and the device is saying the wrong vowel.
 *
 * Three deliberate choices in the analysis, none of them cosmetic:
 *
 *   PRE-EMPHASIS. The glottal source falls at about 6 dB/octave, so a raw
 *   spectrum slopes down hard and a peak-picker just returns the lowest
 *   frequency it is allowed to look at. The standard first-order pre-emphasis
 *   flattens that tilt. Without it this test measured F2 of /iy/ at 580 Hz.
 *
 *   SHORT WINDOWS. 8 ms, not 40. A long window resolves the PITCH harmonics
 *   (110 Hz apart) and the peak-picker finds those instead of the formants —
 *   which is exactly what happened on the first attempt: 240, 350, 460, 570.
 *   A window shorter than two pitch periods smears the harmonics together and
 *   leaves the formant envelope, which is the wideband-spectrogram trick.
 *
 *   AVERAGING. One 8 ms window catches one glottal pulse and its spectrum
 *   depends on where in the pulse it landed, so several overlapping windows
 *   are averaged.
 */
const ANALYSIS_WINDOW = 192 // 8 ms at 24 kHz
const PRE_EMPHASIS = 0.97
const BIN_HZ = 20

/* A plain DFT of one windowed frame, evaluated only on the band we care
 * about. No FFT, no dependency: 163 bins over a 192-sample frame is a few
 * hundred thousand multiplies and the whole test file still runs in under a
 * second. */
function dftMagnitudes(frame, loHz, hiHz) {
  const n = frame.length
  const windowed = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    windowed[i] = frame[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
  }
  const bins = []
  for (let f = loHz; f <= hiHz; f += BIN_HZ) {
    let re = 0
    let im = 0
    const omega = (2 * Math.PI * f) / RATE
    for (let i = 0; i < n; i += 1) {
      re += windowed[i] * Math.cos(omega * i)
      im -= windowed[i] * Math.sin(omega * i)
    }
    bins.push({ f, mag: Math.hypot(re, im) })
  }
  return bins
}

/** The averaged spectral envelope of a stretch of audio. */
function spectralEnvelope(signal, loHz, hiHz) {
  const pre = new Float64Array(signal.length)
  for (let i = 0; i < signal.length; i += 1) {
    pre[i] = signal[i] - PRE_EMPHASIS * (i > 0 ? signal[i - 1] : 0)
  }
  const hop = ANALYSIS_WINDOW / 2
  let total = null
  let frames = 0
  for (let start = 0; start + ANALYSIS_WINDOW <= pre.length; start += hop) {
    const bins = dftMagnitudes(pre.subarray(start, start + ANALYSIS_WINDOW), loHz, hiHz)
    if (!total) total = bins.map((bin) => ({ f: bin.f, mag: 0 }))
    for (let i = 0; i < bins.length; i += 1) total[i].mag += bins[i].mag
    frames += 1
  }
  assert.ok(frames >= 4, `only ${frames} analysis frames — the vowel is too short to measure`)
  return total.map((bin) => ({ f: bin.f, mag: bin.mag / frames }))
}

function loudestBetween(bins, loHz, hiHz) {
  let best = null
  for (const bin of bins) {
    if (bin.f < loHz || bin.f > hiHz) continue
    if (!best || bin.mag > best.mag) best = bin
  }
  return best.f
}

/**
 * F1 and F2 of one phoneme inside one rendered number, measured from the
 * audio. `at` is where in the phoneme to look, as a fraction of its span —
 * mid-phoneme for a vowel's steady state, early for a diphthong's first
 * target, which is the part that carries its identity.
 */
function measureFormants(n, phoneme, at) {
  const segment = phonemeTimeline(n).find((s) => s.phoneme === phoneme)
  assert.ok(segment, `${n} does not contain /${phoneme}/`)
  const signal = samples(renderNumberPcm(n))
  const span = segment.endMs - segment.startMs
  const from = Math.round((((segment.startMs + span * (at - 0.16)) / 1000) * RATE))
  const to = Math.round((((segment.startMs + span * (at + 0.16)) / 1000) * RATE))
  const bins = spectralEnvelope(signal.subarray(from, to), 150, 3400)
  const f1 = loudestBetween(bins, 180, 1000)
  /* F2 is searched above F1 with a guard band, because an 8 ms window is
   * 500 Hz wide and the skirt of F1 would otherwise win. */
  const f2 = loudestBetween(bins, f1 + 400, 3200)
  return { f1, f2 }
}

/* The measurement is worth about ±10% against the table: an 8 ms window is a
 * blunt instrument and the vowel is still moving slightly at its edges. Stated
 * here rather than buried, because a tolerance nobody wrote down is a
 * tolerance that quietly grows. */
const FORMANT_TOLERANCE = 0.15

function assertFormant(label, measured, target) {
  const error = Math.abs(measured / target - 1)
  assert.ok(
    error <= FORMANT_TOLERANCE,
    `${label}: measured ${measured} Hz, table says ${target} Hz (${(error * 100).toFixed(1)}% off)`,
  )
}

test('the resonators actually put the formants where the table says', () => {
  /* /iy/ in "three": the front-vowel extreme — lowest F1, highest F2 of the
   * whole inventory. */
  const iy = measureFormants(3, 'iy', 0.55)
  assertFormant('/iy/ F1', iy.f1, PHONEMES.iy.points[0].f1)
  assertFormant('/iy/ F2', iy.f2, PHONEMES.iy.points[0].f2)

  /* /uw/ in "two": the back-vowel extreme, and the one that shares /iy/'s low
   * F1 — so F2 is the ONLY thing distinguishing "two" from "three"'s vowel. */
  const uw = measureFormants(2, 'uw', 0.55)
  assertFormant('/uw/ F1', uw.f1, PHONEMES.uw.points[0].f1)
  assertFormant('/uw/ F2', uw.f2, PHONEMES.uw.points[0].f2)

  /* The open nucleus of the /ay/ in "nine", measured at its first target: high
   * F1, low F2, the opposite corner of the vowel space from /iy/. */
  const ay = measureFormants(9, 'ay', 0.28)
  assertFormant('/ay/ F1', ay.f1, PHONEMES.ay.points[0].f1)
  assertFormant('/ay/ F2', ay.f2, PHONEMES.ay.points[0].f2)

  /* /er/ in "thirty" — the r-colour is a LOW F3, and "thirty" against "thirty"
   * misheard as "forty" is a real risk on a timer dial. */
  const er = measureFormants(30, 'er', 0.55)
  assertFormant('/er/ F1', er.f1, PHONEMES.er.points[0].f1)
  assertFormant('/er/ F2', er.f2, PHONEMES.er.points[0].f2)
})

test('the vowels are ordered in the spectrum the way they are in the mouth', () => {
  /*
   * The ordering assertion, independent of how well the peak-picker did. Even
   * if every absolute number above drifted, THIS is what makes the vowels
   * distinguishable to an ear: front vowels have a high F2 and back vowels a
   * low one, and open vowels have a high F1 and close vowels a low one. If
   * these orderings ever invert, the device is saying different words than the
   * ones it thinks it is.
   */
  const iy = measureFormants(3, 'iy', 0.55)
  const uw = measureFormants(2, 'uw', 0.55)
  const ay = measureFormants(9, 'ay', 0.28)

  assert.ok(iy.f2 > uw.f2 * 2, `F2 of /iy/ (${iy.f2}) is not far above F2 of /uw/ (${uw.f2})`)
  assert.ok(ay.f1 > iy.f1 * 1.6, `F1 of /ay/ (${ay.f1}) is not far above F1 of /iy/ (${iy.f1})`)
  assert.ok(ay.f1 > uw.f1 * 1.6, `F1 of /ay/ (${ay.f1}) is not far above F1 of /uw/ (${uw.f1})`)
})

test('a fricative is noise in its own band, not a buzz', () => {
  /*
   * /s/ carries "six", "seven" and every "-ty" that starts with one, and it is
   * the sound this kind of synthesizer most often gets wrong by leaving the
   * voicing on. Two things must be true: the /s/ has to be audible at all, and
   * its energy has to sit ABOVE the vowel's, not on top of it.
   */
  const timeline = phonemeTimeline(6) // six: s ih k s
  const signal = samples(renderNumberPcm(6))
  const cut = (segment, at, width) => {
    const span = segment.endMs - segment.startMs
    return signal.subarray(
      Math.round((((segment.startMs + span * (at - width)) / 1000) * RATE)),
      Math.round((((segment.startMs + span * (at + width)) / 1000) * RATE)),
    )
  }
  const energyAbove = (frame, hz) => {
    const bins = spectralEnvelope(frame, 300, 8000)
    let low = 0
    let high = 0
    for (const bin of bins) {
      if (bin.f < hz) low += bin.mag
      else high += bin.mag
    }
    return high / (low + high)
  }

  const s = timeline.find((seg) => seg.phoneme === 's')
  const ih = timeline.find((seg) => seg.phoneme === 'ih')
  const sHigh = energyAbove(cut(s, 0.5, 0.22), 4000)
  const vowelHigh = energyAbove(cut(ih, 0.5, 0.22), 4000)
  assert.ok(sHigh > 0.5, `/s/ has only ${(sHigh * 100).toFixed(0)}% of its energy above 4 kHz`)
  assert.ok(
    sHigh > vowelHigh * 3,
    `/s/ (${sHigh.toFixed(2)}) is not clearly higher-banded than the vowel (${vowelHigh.toFixed(2)})`,
  )
})

test('a stop is a silence and then a burst', () => {
  /*
   * "Two", "eight", "ten" and every -teen and -ty hang on the /t/, and the
   * closure is the larger half of that cue. Measured as amplitude: the middle
   * of the closure must be far quieter than the release that follows it.
   */
  const timeline = phonemeTimeline(10) // ten: t eh n
  const signal = samples(renderNumberPcm(10))
  const t = timeline.find((seg) => seg.phoneme === 't')
  const span = t.endMs - t.startMs
  const rms = (fromFraction, toFraction) => {
    const from = Math.round((((t.startMs + span * fromFraction) / 1000) * RATE))
    const to = Math.round((((t.startMs + span * toFraction) / 1000) * RATE))
    let sum = 0
    for (let i = from; i < to; i += 1) sum += signal[i] * signal[i]
    return Math.sqrt(sum / Math.max(1, to - from))
  }
  const closure = rms(0.15, 0.45)
  const burst = rms(0.53, 0.7)
  assert.ok(burst > closure * 8, `burst ${burst.toFixed(5)} vs closure ${closure.toFixed(5)}`)
})
