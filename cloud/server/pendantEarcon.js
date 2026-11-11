/*
 * The blips. A scrollbar for the ear.
 *
 * docs/Screenless_App_Grammar.md: "A position-pitched earcon — a short blip
 * whose pitch rises as you scroll forward through the ring and falls as you
 * scroll back. Pitch alone tells your ear 'third of four' the way a scrollbar
 * tells your eye." That is the whole design constraint, and it is why the
 * frequency here is a function of INDEX/SIZE rather than of motion: an owner
 * spinning fast hears a rising sweep and knows they are climbing, and the same
 * position always sounds the same, so the ring becomes a place with a shape.
 *
 * WHY SYNTHESIZED RATHER THAN TTS. A name costs a TTS round-trip and about a
 * second of speech; a detent must cost neither, because the owner spins four
 * of them in the time one sentence takes. So a detent is a tone rendered
 * locally in a few hundred microseconds, and only the SETTLED position is
 * spoken (pendantConverse.js debounces it). Four blips and one name, not four
 * sentences.
 *
 * The output format is the pendant's reply format already — 24 kHz mono s16le,
 * REALTIME_PCM_RATE — so these buffers ride the exact streamAnnouncementPcm
 * path every other relay-composed sound rides. Nothing is resampled and no new
 * audio path exists.
 */

/* Two base pitches, one per ring depth. "Which ring am I in" must be audible
 * BEFORE any word is spoken, so the app ring and the rings inside apps do not
 * share a register. */
const RING_BASE_HZ = Object.freeze({
  apps: 523.25, // C5
  timer: 784.0, // G5
  /* Same register as the timer ring: both are "a ring inside an app", and the
   * distinction the ear needs is depth, not which app. */
  audio: 784.0,
  /* A numeric field is a ring inside an app too, so it shares that register —
   * but its "size" is the whole range (1..180 minutes), which makes the pitch
   * step per detent tiny and turns a long spin into a slow audible sweep. That
   * is the intended effect, not a degradation: the ear learns "high in the
   * range" before the number is spoken, which is the only positional cue a
   * spinner can offer between settles. */
  number: 784.0,
  closed: 523.25,
})

/* Just under a musical fifth across a whole ring: enough that adjacent
 * positions are distinguishable, little enough that the top of a six-entry
 * ring is not a shriek in the owner's ear at 2 cm. */
const RING_SPAN_RATIO = 1.45

const DEFAULT_SAMPLE_RATE = 24_000
const BLIP_MS = 90
const CHIME_NOTE_MS = 140
/* Well under a speaker at arm's length; this thing sits at the collarbone. */
const PEAK = 0.22

function toneSamples({ frequency, ms, sampleRate, peak = PEAK, phase = 0 }) {
  const count = Math.max(1, Math.round((ms / 1000) * sampleRate))
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    /*
     * Raised-cosine envelope over the WHOLE blip. A square-edged tone at 24 kHz
     * clicks, and a click on every detent is the sound of a broken device even
     * when the pitch underneath it is perfect.
     */
    const envelope = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / count)
    samples[i] = peak * envelope * Math.sin(2 * Math.PI * frequency * (i / sampleRate) + phase)
  }
  return samples
}

function toPcm(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const pcm = Buffer.alloc(total * 2)
  let offset = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, chunk[i]))
      pcm.writeInt16LE(Math.round(clamped * 32767), offset)
      offset += 2
    }
  }
  return pcm
}

/** The pitch one ring position sounds at. Exported because the test that
 * proves "forward rises" should assert on the number, not on a spectrogram. */
export function earconFrequency({ ring = 'apps', index = 0, size = 1 } = {}) {
  const base = RING_BASE_HZ[String(ring)] ?? RING_BASE_HZ.apps
  const count = Math.max(1, Number(size) || 1)
  const position = Math.min(Math.max(Number(index) || 0, 0), count - 1)
  /* count - 1 in the denominator so the last entry always lands on the top of
   * the span: the ring's edges are the two pitches the owner learns first. */
  const fraction = count <= 1 ? 0 : position / (count - 1)
  return base * (1 + (RING_SPAN_RATIO - 1) * fraction)
}

/**
 * One detent, one push, or one escape, as PCM.
 *
 * `motion` shapes the gesture on top of the position pitch:
 *   forward/back — a single blip at the position's pitch
 *   enter        — the position's pitch plus a fifth above it: "you went in"
 *   escape       — a falling pair: "you came out". The doc's close earcon.
 *   edge         — the knob turned and the value did NOT move: a numeric field
 *                  hit a stop. Two clipped blips at the same pitch, a muted
 *                  stutter rather than a new note, because the message is
 *                  precisely "nothing changed". A silent refusal here is
 *                  indistinguishable from a dead knob, and the owner's next
 *                  move would be to keep turning into a wall they cannot see.
 */
export function renderEarconPcm({
  ring = 'apps',
  index = 0,
  size = 1,
  motion = 'forward',
  sampleRate = DEFAULT_SAMPLE_RATE,
} = {}) {
  const frequency = earconFrequency({ ring, index, size })

  if (motion === 'edge') {
    const clipped = BLIP_MS * 0.4
    return toPcm([
      toneSamples({ frequency, ms: clipped, sampleRate, peak: PEAK * 0.7 }),
      toneSamples({ frequency: 0, ms: clipped * 0.5, sampleRate, peak: 0 }),
      toneSamples({ frequency, ms: clipped, sampleRate, peak: PEAK * 0.7 }),
    ])
  }
  if (motion === 'escape') {
    return toPcm([
      toneSamples({ frequency, ms: BLIP_MS, sampleRate }),
      toneSamples({ frequency: frequency * 0.63, ms: BLIP_MS * 1.3, sampleRate }),
    ])
  }
  if (motion === 'enter') {
    return toPcm([
      toneSamples({ frequency, ms: BLIP_MS * 0.8, sampleRate }),
      toneSamples({ frequency: frequency * 1.5, ms: BLIP_MS, sampleRate }),
    ])
  }
  return toPcm([toneSamples({ frequency, ms: BLIP_MS, sampleRate })])
}

/**
 * The timer chime: a rising three-note figure, then the words.
 *
 * Rising because it is an arrival, and three notes because two is a
 * notification and four is a ringtone. It plays before "Your 10 minute timer
 * is done." so an owner mid-sentence has a beat to stop talking before the
 * sentence they actually need arrives.
 */
export function renderTimerChimePcm({ sampleRate = DEFAULT_SAMPLE_RATE } = {}) {
  const root = 587.33 // D5
  return toPcm([
    toneSamples({ frequency: root, ms: CHIME_NOTE_MS, sampleRate }),
    toneSamples({ frequency: root * 1.25, ms: CHIME_NOTE_MS, sampleRate }),
    toneSamples({ frequency: root * 1.5, ms: CHIME_NOTE_MS * 1.6, sampleRate }),
  ])
}
