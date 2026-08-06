/*
 * Measures what the downlink audio chain does to a known signal, so voice
 * quality is a number instead of an opinion.
 *
 * Test 1 (aliasing): a pure 9 kHz tone — real speech sibilance lives here.
 * At a 16 kHz wire rate anything above 8 kHz MUST be filtered out before
 * decimation; if it is not, 9 kHz folds down to 7 kHz and lands right in
 * the voice band as metallic noise. We measure the 7 kHz fold directly.
 *
 * Test 2 (codec): speech-like multitone through encode+decode, reporting
 * SNR so bitrate changes can be compared.
 *
 *   node scripts/audio-quality-probe.mjs
 */
import {
  createPcm24kTo16k,
  createOpusReplyEncoder,
  createOpusUploadDecoder,
  OPUS_REPLY_SAMPLE_RATE,
  OPUS_WIRE_SAMPLE_RATE,
} from '../cloud-relay/opusTranscode.js'

const MODEL_RATE = 24000

/* Goertzel: energy at one frequency, no FFT dependency. */
function toneEnergy(pcm, rate, freq) {
  const n = pcm.length / 2
  const k = (2 * Math.PI * freq) / rate
  const coeff = 2 * Math.cos(k)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768 + coeff * s1 - s2
    s2 = s1
    s1 = s
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n
}

function tone(rate, seconds, freqs, amp = 0.35) {
  const n = Math.round(rate * seconds)
  const buf = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    let v = 0
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / rate)
    buf.writeInt16LE(Math.round((v / freqs.length) * amp * 32767), i * 2)
  }
  return buf
}

const db = (x) => (x <= 0 ? -999 : 20 * Math.log10(x))

console.log('=== Test 1: does 9 kHz alias into the voice band? ===')
{
  const input = tone(MODEL_RATE, 1.0, [9000])
  const encoder = await createOpusReplyEncoder()
  const decoder = await createOpusUploadDecoder(OPUS_REPLY_SAMPLE_RATE)
  let wire = Buffer.alloc(0)
  for (let off = 0; off < input.length; off += 4800) {
    wire = Buffer.concat([wire, encoder.push(input.subarray(off, off + 4800))])
  }
  wire = Buffer.concat([wire, encoder.end()])
  let out = Buffer.alloc(0)
  for (let off = 0; off < wire.length; off += 64) {
    out = Buffer.concat([out, decoder.push(wire.subarray(off, off + 64))])
  }

  const at9k = toneEnergy(input, MODEL_RATE, 9000)
  const fold = toneEnergy(out, OPUS_REPLY_SAMPLE_RATE, 7000)
  const kept = toneEnergy(out, OPUS_REPLY_SAMPLE_RATE, 9000) // survives now
  console.log(`  input 9 kHz tone level      : ${db(at9k).toFixed(1)} dB`)
  console.log(`  ALIAS folded to 7 kHz       : ${db(fold).toFixed(1)} dB`)
  console.log(`  rejection (higher is better): ${(db(at9k) - db(fold)).toFixed(1)} dB`)
  console.log(
    `  verdict: ${db(at9k) - db(fold) < 30 ? 'ALIASING — this is audible as harsh/metallic speech' : 'acceptable'}`,
  )
  console.log(`  9 kHz content actually delivered: ${db(kept).toFixed(1)} dB`)
  encoder.destroy()
  decoder.destroy()
}

console.log('\n=== Test 2: codec SNR on speech-like content ===')
{
  const speechLike = tone(MODEL_RATE, 2.0, [220, 440, 900, 1800, 3200, 6000])
  const encoder = await createOpusReplyEncoder()
  const decoder = await createOpusUploadDecoder(OPUS_REPLY_SAMPLE_RATE)

  let wire = Buffer.alloc(0)
  for (let off = 0; off < speechLike.length; off += 4800) {
    wire = Buffer.concat([wire, encoder.push(speechLike.subarray(off, off + 4800))])
  }
  wire = Buffer.concat([wire, encoder.end()])

  let decoded = Buffer.alloc(0)
  for (let off = 0; off < wire.length; off += 64) {
    decoded = Buffer.concat([decoded, decoder.push(wire.subarray(off, off + 64))])
  }

  const seconds = speechLike.length / 2 / MODEL_RATE
  const kbps = (wire.length * 8) / seconds / 1000
  console.log(`  wire bitrate: ${kbps.toFixed(1)} kbps`)
  console.log(`  decoded: ${(decoded.length / 2 / OPUS_REPLY_SAMPLE_RATE).toFixed(2)} s`)

  // Per-partial retention: how much of each speech harmonic survives.
  for (const f of [220, 440, 900, 1800, 3200, 6000]) {
    if (f >= OPUS_REPLY_SAMPLE_RATE / 2) continue
    const inLevel = toneEnergy(speechLike, MODEL_RATE, f)
    const outLevel = toneEnergy(decoded, OPUS_REPLY_SAMPLE_RATE, f)
    console.log(
      `  ${String(f).padStart(5)} Hz: in ${db(inLevel).toFixed(1)} dB -> out ${db(outLevel).toFixed(1)} dB  (${(db(outLevel) - db(inLevel)).toFixed(1)} dB)`,
    )
  }
  encoder.destroy()
  decoder.destroy()
}
