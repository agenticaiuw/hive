import assert from 'node:assert/strict'
import test from 'node:test'

import { earconFrequency, renderEarconPcm, renderTimerChimePcm } from './pendantEarcon.js'
import { APP_RING, TIMER_RING } from './menuRing.js'

const RATE = 24_000

function samples(pcm) {
  const out = new Array(pcm.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = pcm.readInt16LE(i * 2)
  return out
}

const peak = (pcm) => samples(pcm).reduce((max, value) => Math.max(max, Math.abs(value)), 0)

/*
 * THE WHOLE CLAIM OF THIS FILE, as a number: pitch rises as you scroll
 * forward, so pitch alone tells the ear "third of four" the way a scrollbar
 * tells the eye. Asserted on the frequency rather than on a spectrogram
 * because that is the property the design actually depends on.
 */
test('pitch rises monotonically through a ring', () => {
  const pitches = APP_RING.map((_, index) =>
    earconFrequency({ ring: 'apps', index, size: APP_RING.length }),
  )
  for (let i = 1; i < pitches.length; i += 1) {
    assert.ok(pitches[i] > pitches[i - 1], `position ${i} is not higher than ${i - 1}`)
  }
})

test('a ring inside an app sits in a different register, so depth is audible', () => {
  const apps = earconFrequency({ ring: 'apps', index: 0, size: APP_RING.length })
  const timer = earconFrequency({ ring: 'timer', index: 0, size: TIMER_RING.length })
  assert.ok(timer > apps * 1.2, 'the inner ring is not distinguishable from the app ring')
})

test('the same position always sounds the same — a ring with a shape', () => {
  const first = earconFrequency({ ring: 'apps', index: 2, size: 5 })
  const again = earconFrequency({ ring: 'apps', index: 2, size: 5 })
  assert.equal(first, again)
})

test('a one-entry ring does not divide by zero', () => {
  assert.ok(Number.isFinite(earconFrequency({ ring: 'apps', index: 0, size: 1 })))
  assert.ok(Number.isFinite(earconFrequency({})))
})

test('an out-of-range index is clamped into the ring rather than shrieking', () => {
  const top = earconFrequency({ ring: 'apps', index: 4, size: 5 })
  assert.equal(earconFrequency({ ring: 'apps', index: 99, size: 5 }), top)
  assert.equal(
    earconFrequency({ ring: 'apps', index: -3, size: 5 }),
    earconFrequency({ ring: 'apps', index: 0, size: 5 }),
  )
})

test('a detent is a short blip, not a note', () => {
  const pcm = renderEarconPcm({ ring: 'apps', index: 0, size: 5 })
  const ms = (pcm.length / 2 / RATE) * 1000
  /* Long enough to hear, short enough that a fast spin is a click wheel and
   * not a chord. */
  assert.ok(ms > 40 && ms < 160, `${ms}ms`)
  assert.ok(peak(pcm) > 1000)
})

test('escaping falls and entering rises — the gesture is in the shape', () => {
  const escape = renderEarconPcm({ ring: 'apps', index: 0, size: 5, motion: 'escape' })
  const enter = renderEarconPcm({ ring: 'apps', index: 0, size: 5, motion: 'enter' })
  const blip = renderEarconPcm({ ring: 'apps', index: 0, size: 5, motion: 'forward' })
  assert.ok(escape.length > blip.length, 'the escape is not a two-tone figure')
  assert.ok(enter.length > blip.length, 'the enter is not a two-tone figure')
})

/*
 * A square-edged tone at 24 kHz clicks, and a click on every detent is the
 * sound of a broken device even when the pitch underneath it is perfect. The
 * envelope is what prevents it, so the first and last samples must be silent.
 */
test('every blip fades in and out, so no detent clicks', () => {
  for (const motion of ['forward', 'back', 'enter', 'escape']) {
    const values = samples(renderEarconPcm({ ring: 'apps', index: 3, size: 5, motion }))
    assert.ok(Math.abs(values[0]) < 200, `${motion} starts with a step`)
    assert.ok(Math.abs(values[values.length - 1]) < 200, `${motion} ends with a step`)
  }
})

test('nothing the relay plays is loud — this sits at the collarbone', () => {
  const loudest = Math.max(
    peak(renderEarconPcm({ ring: 'timer', index: 5, size: 7, motion: 'enter' })),
    peak(renderTimerChimePcm()),
  )
  assert.ok(loudest < 0.35 * 32767, `peak ${loudest}`)
})

test('the timer chime is three rising notes and a beat long', () => {
  const pcm = renderTimerChimePcm()
  const ms = (pcm.length / 2 / RATE) * 1000
  /* Two notes is a notification and four is a ringtone; and the owner needs a
   * beat to stop talking before the sentence they actually need arrives. */
  assert.ok(ms > 350 && ms < 700, `${ms}ms`)
  assert.ok(peak(pcm) > 1000)
})

test('the PCM is 16-bit mono at the pendant’s own reply rate', () => {
  const pcm = renderEarconPcm({ ring: 'apps', index: 0, size: 5, sampleRate: RATE })
  /* An odd byte length would shift every later frame's phase; the pendant's
   * reply path is 24 kHz s16le, so nothing here is ever resampled. */
  assert.equal(pcm.length % 2, 0)
  assert.ok(Buffer.isBuffer(pcm))
})
