import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testWorkspace = fs.mkdtempSync(
  path.join(os.tmpdir(), 'pendant-audio-test-'),
)
process.env.PENDANT_WORKSPACE_PATH = testWorkspace

const { readPipelineAudio, savePipelineAudio } = await import(
  `./pipelineAudio.js?test=${Date.now()}`
)

test.after(() => {
  fs.rmSync(testWorkspace, { recursive: true, force: true })
})

test('stores diagnostic PCM as a playable WAVE without embedding it in traces', () => {
  const pcm = Buffer.alloc(2400 * 2)
  for (let index = 0; index < 2400; index += 1) {
    pcm.writeInt16LE(index % 2 === 0 ? 12000 : -12000, index * 2)
  }

  const metadata = savePipelineAudio({
    pipelineId: 'job_audio_test',
    direction: 'output',
    format: 's16le',
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    audioBase64: pcm.toString('base64'),
  })
  const saved = readPipelineAudio('job_audio_test', 'output')

  assert.equal(metadata.durationMs, 100)
  assert.equal(metadata.pcmBytes, pcm.length)
  assert.equal(metadata.clippedSamples, 0)
  assert.ok(metadata.peakPercent > 30)
  assert.ok(saved)
  assert.equal(saved.buffer.toString('ascii', 0, 4), 'RIFF')
  assert.equal(saved.buffer.toString('ascii', 8, 12), 'WAVE')
  assert.deepEqual(saved.buffer.subarray(44), pcm)
})
