import assert from 'node:assert/strict'
import test from 'node:test'

/*
 * Regression cover for the 2026-08-07T05:19 pendant run.
 *
 * The pendant uploaded 33 s of perfectly intelligible speech ("what is my
 * battery level right now?" — whisper-1 transcribes the stored capture
 * verbatim) and got nothing back: decoded_packets=0 on the device, and the
 * Realtime session emitted exactly two events, session.created and
 * session.updated. No speech_started, no commit, no response.
 *
 * The clip's speech peaks at 928/32767 (-31 dBFS). Realtime's turn detection
 * gates on ABSOLUTE level, not SNR: replaying the same samples scaled 8x
 * produces a normal transcript and a spoken reply. So the relay levels the
 * uplink before handing it to the model.
 */
const {
  createUplinkLeveler,
  UPLINK_TARGET_PEAK,
  UPLINK_MAX_GAIN,
  buildPlanResult,
} = await import('./openaiRealtimeVoice.js')

/** Sine-ish tone at a given peak amplitude, as s16le mono PCM. */
function tone(peak, { sampleRate = 24000, seconds = 1, hz = 220 } = {}) {
  const count = Math.round(sampleRate * seconds)
  const buf = Buffer.alloc(count * 2)
  for (let i = 0; i < count; i++) {
    buf.writeInt16LE(
      Math.round(peak * Math.sin((2 * Math.PI * hz * i) / sampleRate)),
      i * 2,
    )
  }
  return buf
}

function peakOf(pcm) {
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i))
    if (v > peak) peak = v
  }
  return peak
}

test('a mic too quiet for the Realtime VAD is lifted toward the target peak', () => {
  const leveler = createUplinkLeveler()
  // The failing capture's actual speech peak, over the length of that capture.
  const out = leveler.push(tone(928, { seconds: 20 }))

  assert.equal(out.length % 2, 0)
  assert.ok(
    leveler.gain > 6,
    `expected a real boost on -31 dBFS speech, got ${leveler.gain}x`,
  )
  // 8x is the gain that was measured to make this clip transcribe and answer.
  assert.ok(peakOf(out) > 8 * 928, `levelled peak was only ${peakOf(out)}`)
})

test('a normal-level talker is left alone', () => {
  const leveler = createUplinkLeveler()
  // The capture from the run that DID work peaks at full scale.
  const loud = tone(30000, { seconds: 4 })
  const out = leveler.push(loud)

  assert.equal(leveler.gain, 1)
  // Within the slew of unity — no boost, and nothing driven into the rails.
  assert.ok(Math.abs(peakOf(out) - peakOf(loud)) / peakOf(loud) < 0.01)
  assert.ok(peakOf(out) < 32767)
})

/*
 * The regression that a naive fast AGC caused, locked shut.
 *
 * With a 1 s rise, the 2.7 s of room tone before the working capture's talker
 * said anything got lifted from ~100 RMS to ~1000 — the same level as their
 * actual voice — and the gain then collapsed to unity the moment they spoke.
 * Replayed live, that session went from a clean transcript and reply to zero
 * Realtime events: turn detection reads the CONTRAST between silence and
 * speech, so an AGC that erases it is worse than no AGC at all.
 */
test('room tone before a normal talker speaks is not lifted to speech level', () => {
  const leveler = createUplinkLeveler()
  // Room tone at the level both real captures actually show.
  const roomTone = tone(450, { seconds: 2.7, hz: 90 })
  const levelled = leveler.push(roomTone)

  assert.ok(
    leveler.gain < 2,
    `room tone was already boosted ${leveler.gain}x before anyone spoke`,
  )
  assert.ok(peakOf(levelled) < 2 * 450)

  // ...and the talker who follows still rides at unity.
  leveler.push(tone(32000, { seconds: 1 }))
  assert.equal(leveler.gain, 1)
})

test('a quiet mic is levelled well inside one conversation', () => {
  const leveler = createUplinkLeveler()
  // The failing run held the socket open for 33 s. Whatever the wind-up costs,
  // it has to be paid back long before that.
  leveler.push(tone(928, { seconds: 15 }))

  assert.ok(leveler.gain > 6, `only reached ${leveler.gain}x after 15 s`)
})

test('levelling never clips and never inverts the waveform', () => {
  const leveler = createUplinkLeveler()
  // Quiet lead-in (winds the gain up) then a sudden full-scale burst.
  leveler.push(tone(500, { seconds: 5 }))
  const burst = tone(32000, { seconds: 1 })
  const out = leveler.push(burst)

  for (let i = 0; i + 1 < out.length; i += 2) {
    const sample = out.readInt16LE(i)
    assert.ok(sample >= -32768 && sample <= 32767)
    const source = burst.readInt16LE(i)
    if (source > 0) assert.ok(sample >= 0)
    if (source < 0) assert.ok(sample <= 0)
  }
})

test('gain is bounded by UPLINK_MAX_GAIN even on near-silence', () => {
  const leveler = createUplinkLeveler()
  leveler.push(tone(1, { seconds: 10 }))

  assert.ok(leveler.gain <= UPLINK_MAX_GAIN)
  assert.ok(UPLINK_TARGET_PEAK > 0 && UPLINK_TARGET_PEAK < 32768)
})

test('levelling is streaming: chunk boundaries do not change the output', () => {
  const source = tone(900, { seconds: 3 })
  const whole = createUplinkLeveler().push(source)

  const chunked = createUplinkLeveler()
  const parts = []
  // 60 ms opus frames arrive one at a time on the converse socket.
  for (let i = 0; i < source.length; i += 2880) {
    parts.push(chunked.push(source.subarray(i, i + 2880)))
  }
  assert.ok(Buffer.concat(parts).equals(whole))
})

test('an odd trailing byte is dropped rather than corrupting the frame', () => {
  const leveler = createUplinkLeveler()
  const out = leveler.push(Buffer.concat([tone(4000, { seconds: 0.1 }), Buffer.from([0x7f])]))

  assert.equal(out.length % 2, 0)
})

/*
 * The other half of the same incident: because no words were ever recognised,
 * the capture was filed with plan.text — whose last-resort value is the
 * literal string 'voice command' — sitting in the ASR transcript field. The
 * run then read like the owner had said "voice command" and been answered.
 */
test('a session that recognised nothing yields no transcript, only a label', () => {
  const plan = buildPlanResult(
    {
      transcript: '',
      response: undefined,
      actions: [],
      toolsUsed: [],
      delegate: false,
      status: 'instant',
      textParts: [],
    },
    Date.now(),
    null,
  )

  assert.equal(plan.text, 'voice command') // history label, unchanged
  assert.equal(plan.transcript, undefined) // ASR field: honest about nothing
})

test('a session that did recognise speech exposes it as a real transcript', () => {
  const plan = buildPlanResult(
    {
      transcript: 'what is my battery level right now',
      response: 'Eighty-two percent.',
      actions: [],
      toolsUsed: [],
      delegate: false,
      status: 'instant',
      textParts: [],
    },
    Date.now(),
    null,
  )

  assert.equal(plan.transcript, 'what is my battery level right now')
  assert.equal(plan.text, 'what is my battery level right now')
})
