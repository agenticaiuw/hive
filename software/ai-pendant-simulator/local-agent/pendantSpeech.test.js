import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  PENDANT_SPEECH_SAMPLE_RATE,
  encodePendantSpeechOpus,
  extractWavePcm,
  spokenTextForResult,
  synthesizePendantSpeech,
} from './pendantSpeech.js'

test('selects the agent response before summaries and action labels', () => {
  assert.equal(
    spokenTextForResult({
      response: 'The direct response.',
      summary: 'The summary.',
      actions: [{ label: 'Open Finder' }],
    }),
    'The direct response.',
  )
})

test('falls back to a confirmation description for action plans', () => {
  assert.equal(
    spokenTextForResult({
      actions: [
        {
          label: 'Open Finder',
          requiresConfirmation: true,
        },
      ],
    }),
    'Ready for confirmation: Open Finder.',
  )
})

test('extracts 24 kHz mono signed PCM from a macOS WAVE file', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-pendant-speech-test-'),
  )
  const wavePath = path.join(temporaryDirectory, 'test.wav')

  try {
    const result = spawnSync(
      'say',
      [
        '-o',
        wavePath,
        '--file-format=WAVE',
        `--data-format=LEI16@${PENDANT_SPEECH_SAMPLE_RATE}`,
        '--channels=1',
        'Testing the agent response.',
      ],
      { encoding: 'utf8', timeout: 30000 },
    )
    assert.equal(result.status, 0, result.stderr)

    const pcm = extractWavePcm(fs.readFileSync(wavePath))
    assert.ok(pcm.length > 1000)
    assert.equal(pcm.length % 2, 0)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test('attaches bounded raw speech to the bridge result', () => {
  const result = synthesizePendantSpeech({
    status: 'instant',
    response: 'This response is sent back through the existing relay job.',
  })

  assert.equal(result.pendantSpeech.format, 's16le')
  assert.equal(result.pendantSpeech.sampleRate, PENDANT_SPEECH_SAMPLE_RATE)
  assert.equal(result.pendantSpeech.channels, 1)
  assert.equal(result.pendantSpeech.bitsPerSample, 16)
  assert.ok(result.pendantSpeech.pcmBytes > 1000)
  assert.equal(
    Buffer.from(result.pendantSpeech.audioBase64, 'base64').length,
    result.pendantSpeech.pcmBytes,
  )
  const compressed = Buffer.from(
    result.pendantSpeech.compressedAudioBase64,
    'base64',
  )
  assert.equal(result.pendantSpeech.compressedFormat, 'ogg-opus')
  assert.equal(compressed.length, result.pendantSpeech.compressedBytes)
  assert.equal(compressed.toString('ascii', 0, 4), 'OggS')
  assert.ok(compressed.length < result.pendantSpeech.pcmBytes / 4)
})

test('encodes 24 kHz PCM into an Ogg Opus stream', () => {
  const pcm = Buffer.alloc(PENDANT_SPEECH_SAMPLE_RATE * 2)
  for (let sample = 0; sample < PENDANT_SPEECH_SAMPLE_RATE; sample += 1) {
    pcm.writeInt16LE(
      Math.round(Math.sin((sample * Math.PI * 2 * 440) / 24000) * 8000),
      sample * 2,
    )
  }

  const opus = encodePendantSpeechOpus(pcm)
  assert.equal(opus.toString('ascii', 0, 4), 'OggS')
  assert.ok(opus.length < pcm.length / 4)
})
