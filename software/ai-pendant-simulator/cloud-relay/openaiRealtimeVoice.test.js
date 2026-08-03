import assert from 'node:assert/strict'
import test from 'node:test'

const {
  extractPcmFromWavOrPcm,
  resamplePcmS16le,
  StreamingPcmResampler,
  REALTIME_TOOLS,
} = await import('./openaiRealtimeVoice.js')

test('REALTIME_TOOLS expose search + Mac tools', () => {
  const names = REALTIME_TOOLS.map((t) => t.name).sort()
  assert.deepEqual(names, ['mac_delegate', 'mac_run_actions', 'web_search'])
})

test('extractPcmFromWavOrPcm strips RIFF header', () => {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + 4, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(4, 40)
  const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03])
  const wav = Buffer.concat([header, pcm])
  const extracted = extractPcmFromWavOrPcm(wav, 'wav')
  assert.equal(extracted.sampleRate, 16000)
  assert.deepEqual(extracted.pcm, pcm)
})

test('resamplePcmS16le identity when rates match', () => {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0])
  const out = resamplePcmS16le(pcm, 24000, 24000)
  assert.deepEqual(out, pcm)
})

test('resamplePcmS16le changes length when rates differ', () => {
  const samples = new Int16Array(1000)
  for (let i = 0; i < samples.length; i++) samples[i] = i
  const pcm = Buffer.from(samples.buffer)
  const out = resamplePcmS16le(pcm, 16000, 24000)
  assert.ok(out.length > pcm.length)
  assert.equal(out.length % 2, 0)
})

test('StreamingPcmResampler accepts mid-press byte chunks', () => {
  const stream = new StreamingPcmResampler(16000, 24000)
  const samples = new Int16Array(800)
  for (let i = 0; i < samples.length; i++) samples[i] = (i % 200) - 100
  const pcm = Buffer.from(samples.buffer)
  const a = stream.push(pcm.subarray(0, 100))
  const b = stream.push(pcm.subarray(100))
  const c = stream.flush()
  const total = a.length + b.length + c.length
  assert.ok(total > 0)
  assert.equal(total % 2, 0)
})
