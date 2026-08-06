import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOpusReplyEncoder,
  createOpusUploadDecoder,
  createPcm24kTo16k,
  isOpusFramesFormat,
  OPUS_FRAME_SAMPLES,
  OPUS_MAX_PACKET_BYTES,
} from './opusTranscode.js'

test('opus format detection', () => {
  assert.equal(isOpusFramesFormat('opus-frames'), true)
  assert.equal(isOpusFramesFormat('OPUS'), true)
  assert.equal(isOpusFramesFormat('pcmu'), false)
  assert.equal(isOpusFramesFormat('ogg'), false)
})

test('24k→16k resampler keeps 2/3 ratio across chunk boundaries', () => {
  const resampler = createPcm24kTo16k()
  const pcm = Buffer.alloc(2400 * 2) // 100 ms at 24 kHz
  let out = 0

  for (let off = 0; off < pcm.length; off += 146) {
    out += resampler.push(pcm.subarray(off, off + 146)).length
  }
  // 2400 input → 1600 output, less the anti-aliasing filter's one-time
  // priming delay (half its taps). Real filtering costs latency; the ratio
  // itself is verified in steady state below.
  const first = out / 2

  assert.ok(first > 1570 && first <= 1600, `got ${first} samples`)

  let second = 0

  for (let off = 0; off < pcm.length; off += 146) {
    second += resampler.push(pcm.subarray(off, off + 146)).length
  }
  // Steady state: no further priming, so exactly 2/3 (± one group).
  assert.ok(Math.abs(second / 2 - 1600) <= 2, `got ${second / 2} samples`)
})

test('24k→16k resampler rejects content above the 8 kHz Nyquist', () => {
  const resampler = createPcm24kTo16k()
  const rate = 24000
  const pcm = Buffer.alloc(rate * 2)

  for (let i = 0; i < rate; i++) {
    pcm.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 9000 * i) / rate)), i * 2)
  }
  const out = resampler.push(pcm)
  // A 9 kHz tone would fold onto 7 kHz without a real filter (it did: only
  // 3.2 dB of rejection, audible as metallic speech). Filtered, almost
  // nothing survives — assert on residual energy.
  let peak = 0

  for (let i = 0; i < out.length / 2; i++) {
    peak = Math.max(peak, Math.abs(out.readInt16LE(i * 2)))
  }
  assert.ok(peak < 12000 * 0.05, `alias residue peak ${peak} of 12000`)
})

test('reply encoder → upload decoder round trip preserves duration', async () => {
  const encoder = await createOpusReplyEncoder()
  const decoder = await createOpusUploadDecoder()
  // 1.2 s of 24 kHz tone → expect ~0.8 s of 16 kHz PCM back out.
  const seconds = 1.2
  const pcm24 = Buffer.alloc(Math.round(24000 * seconds) * 2)

  for (let i = 0; i < pcm24.length / 2; i++) {
    pcm24.writeInt16LE(
      Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 24000)),
      i * 2,
    )
  }

  let wire = Buffer.alloc(0)

  for (let off = 0; off < pcm24.length; off += 4800) {
    wire = Buffer.concat([wire, encoder.push(pcm24.subarray(off, off + 4800))])
  }
  wire = Buffer.concat([wire, encoder.end()])

  // Wire stream must parse as length-prefixed packets within RFC bounds.
  let cursor = 0
  let packets = 0

  while (cursor < wire.length) {
    const length = wire.readUInt16BE(cursor)

    assert.ok(length > 0 && length <= OPUS_MAX_PACKET_BYTES)
    cursor += 2 + length
    packets += 1
  }
  assert.equal(cursor, wire.length)
  assert.ok(packets >= Math.floor((seconds * 16000) / OPUS_FRAME_SAMPLES))

  // Bitrate sanity: 60 ms voice packets at ~14 kbps stay near ~105 B each.
  assert.ok(
    wire.length / packets < 400,
    `avg packet ${Math.round(wire.length / packets)} B`,
  )

  // Decode side accepts arbitrary chunk boundaries.
  let pcmOut = 0

  for (let off = 0; off < wire.length; off += 37) {
    pcmOut += decoder.push(wire.subarray(off, off + 37)).length
  }
  const outSeconds = pcmOut / 2 / 16000

  assert.ok(
    Math.abs(outSeconds - seconds) < 0.13,
    `decoded ${outSeconds.toFixed(2)} s`,
  )
  encoder.destroy()
  decoder.destroy()
})

test('upload decoder rejects corrupt packet lengths', async () => {
  const decoder = await createOpusUploadDecoder()
  const bogus = Buffer.alloc(4)

  bogus.writeUInt16BE(3000) // beyond RFC 6716 maximum
  assert.throws(() => decoder.push(bogus), /invalid opus packet length/)
  decoder.destroy()
})
