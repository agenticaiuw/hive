import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_OUTPUT_DIRECTORY,
  decodeOggOpusToWave,
  inspectWave,
  savedCaptureIds,
} from './capture-pendant-audio.mjs'
import { spawnSync } from 'node:child_process'

function waveFor(samples, sampleRate = 16000) {
  const wave = Buffer.alloc(44 + samples.length * 2)
  wave.write('RIFF', 0)
  wave.writeUInt32LE(wave.length - 8, 4)
  wave.write('WAVE', 8)
  wave.write('fmt ', 12)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(sampleRate, 24)
  wave.writeUInt32LE(sampleRate * 2, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((sample, index) => wave.writeInt16LE(sample, 44 + index * 2))
  return wave
}

test('inspectWave reports format and signal measurements', () => {
  const metrics = inspectWave(waveFor([-1200, -600, 0, 600, 1200]))

  assert.equal(metrics.sampleRate, 16000)
  assert.equal(metrics.channels, 1)
  assert.equal(metrics.bitsPerSample, 16)
  assert.equal(metrics.samples, 5)
  assert.equal(metrics.dcOffset, 0)
  assert.equal(metrics.peak, 1200)
  assert.equal(metrics.zeroCrossings, 1)
  assert.equal(metrics.clippedSamples, 0)
})

test('decodes Ogg Opus captures for signal inspection', () => {
  const source = waveFor(
    Array.from({ length: 16000 }, (_, index) =>
      Math.round(Math.sin((index * Math.PI * 2 * 330) / 16000) * 5000),
    ),
  )
  const encoded = spawnSync(
    process.env.PENDANT_FFMPEG_PATH || 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-c:a',
      'libopus',
      '-b:a',
      '16k',
      '-f',
      'ogg',
      'pipe:1',
    ],
    { input: source },
  )
  assert.equal(encoded.status, 0, encoded.stderr?.toString())

  const metrics = inspectWave(decodeOggOpusToWave(encoded.stdout))
  assert.equal(metrics.sampleRate, 48000)
  assert.equal(metrics.channels, 1)
  assert.ok(metrics.durationMs >= 990 && metrics.durationMs <= 1010)
})

test('default capture directory lives inside the repository', () => {
  assert.equal(
    DEFAULT_OUTPUT_DIRECTORY,
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../../diagnostics/audio-captures',
    ),
  )
})

test('savedCaptureIds recovers completed captures and ignores invalid reports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-audio-'))
  try {
    fs.writeFileSync(
      path.join(directory, 'capture.json'),
      JSON.stringify({ capture: { captureId: 'job_saved' } }),
    )
    fs.writeFileSync(path.join(directory, 'partial.json'), '{')
    fs.writeFileSync(
      path.join(directory, 'latest.json'),
      JSON.stringify({ capture: { captureId: 'job_latest_alias' } }),
    )

    assert.deepEqual([...savedCaptureIds(directory)], ['job_saved'])
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})
