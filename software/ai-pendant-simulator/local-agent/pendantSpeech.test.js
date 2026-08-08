import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  PENDANT_SPEECH_SAMPLE_RATE,
  clearPendantSpeechCache,
  encodePendantSpeechOpus,
  extractWavePcm,
  hasServableOpus,
  pendantSpeechCacheSize,
  pendantSpeechForWire,
  resultForWire,
  spokenConfirmation,
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

test('never returns empty spoken text', () => {
  assert.equal(spokenTextForResult({}), 'Done.')
  assert.equal(spokenTextForResult(null), 'Done.')
  assert.equal(
    spokenTextForResult({ awaitingApproval: true }),
    'Waiting for your approval on the dashboard.',
  )
  assert.equal(
    spokenTextForResult({ executed: false, executionError: 'Outlook missing' }),
    'Outlook missing',
  )
})

test('spokenConfirmation always describes what happened', () => {
  assert.equal(
    spokenConfirmation(
      { response: 'Opening Outlook', actions: [{ label: 'Open Outlook' }] },
      {
        results: [{ ok: true, message: 'Opened Microsoft Outlook on Mac' }],
      },
    ),
    'Opened Microsoft Outlook on Mac',
  )
  assert.match(
    spokenConfirmation(
      { actions: [{ label: 'Open Outlook' }] },
      { results: [{ ok: false, message: 'not installed' }] },
    ),
    /That didn't work/,
  )
  assert.equal(
    spokenConfirmation({ actions: [{ label: 'Open Outlook' }] }, { results: [] }),
    'Done: Open Outlook',
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

test('caches canned short phrases and clears on demand', () => {
  clearPendantSpeechCache()
  assert.equal(pendantSpeechCacheSize(), 0)

  const first = synthesizePendantSpeech({ response: 'Done.' })
  assert.ok(first.pendantSpeech.pcmBytes > 100)
  assert.ok(pendantSpeechCacheSize() >= 1)

  const second = synthesizePendantSpeech({ response: 'Done.' })
  assert.ok(second.pendantSpeech.pcmBytes > 100)
  assert.equal(second.pendantSpeech.pcmBytes, first.pendantSpeech.pcmBytes)
  assert.equal(
    second.pendantSpeech.audioBase64,
    first.pendantSpeech.audioBase64,
  )
  // Second call should reuse cache rather than grow it.
  assert.equal(pendantSpeechCacheSize(), 1)

  clearPendantSpeechCache()
  assert.equal(pendantSpeechCacheSize(), 0)
})

/* ---------------------------------------------------------------------------
 * The wire form. Raw 24 kHz PCM is ~3.8 MB of base64 per spoken minute, and a
 * pre-rendered briefing pushed one result to ~29 MB -- refused by the relay
 * (413), then too large for D1. The relay serves the opus track anyway, so the
 * raw PCM is dropped when (and only when) that opus is one the relay accepts.
 * ------------------------------------------------------------------------- */

function speechFixture({ pcmBytes = 400_000, opus = true, validOpus = true } = {}) {
  const pcm = Buffer.alloc(pcmBytes, 1)
  const payload = {
    format: 's16le',
    sampleRate: PENDANT_SPEECH_SAMPLE_RATE,
    channels: 1,
    bitsPerSample: 16,
    pcmBytes: pcm.length,
    truncated: false,
    audioBase64: pcm.toString('base64'),
  }
  if (opus) {
    const bytes = Buffer.alloc(4096, 7)
    if (validOpus) bytes.write('OggS', 0, 'ascii')
    payload.compressedFormat = 'ogg-opus'
    payload.compressedBytes = bytes.length
    payload.compressedAudioBase64 = bytes.toString('base64')
  }
  return payload
}

test('the wire form drops raw PCM when the relay-servable opus track exists', () => {
  const speech = speechFixture()
  assert.equal(hasServableOpus(speech), true)

  const wire = pendantSpeechForWire(speech)
  assert.equal(wire.audioBase64, undefined, 'raw PCM must not cross the wire')
  assert.equal(wire.rawPcmOmitted, true)
  // Everything the relay validates against, and the dashboard reports from.
  assert.equal(wire.format, 's16le')
  assert.equal(wire.sampleRate, PENDANT_SPEECH_SAMPLE_RATE)
  assert.equal(wire.channels, 1)
  assert.equal(wire.bitsPerSample, 16)
  assert.equal(wire.pcmBytes, speech.pcmBytes)
  assert.equal(wire.compressedFormat, 'ogg-opus')
  assert.equal(wire.compressedAudioBase64, speech.compressedAudioBase64)
  // The caller's own copy keeps full fidelity for the Mac dashboard preview.
  assert.ok(speech.audioBase64)

  const shrunk = JSON.stringify(wire).length / JSON.stringify(speech).length
  assert.ok(shrunk < 0.05, `wire payload should collapse, got ratio ${shrunk}`)
})

test('raw PCM is KEPT whenever the opus track is missing or unservable', () => {
  for (const speech of [
    speechFixture({ opus: false }),
    speechFixture({ validOpus: false }),
  ]) {
    assert.equal(hasServableOpus(speech), false)
    const wire = pendantSpeechForWire(speech)
    assert.equal(
      wire.audioBase64,
      speech.audioBase64,
      'without servable opus the PCM is the only playable audio',
    )
    assert.equal(wire.rawPcmOmitted, undefined)
  }
})

test('nested briefing audio is stripped too, wherever it rides in the result', () => {
  const served = speechFixture({ pcmBytes: 200_000 })
  const nested = speechFixture({ pcmBytes: 9_000_000 })
  const result = {
    response: 'Your briefing is ready.',
    executed: true,
    pendantSpeech: served,
    execution: {
      ok: true,
      results: [{ type: 'research_brief', seconds: 390, pendantSpeech: nested }],
    },
  }

  const wire = resultForWire(result)
  assert.equal(wire.pendantSpeech.audioBase64, undefined)
  assert.equal(
    wire.execution.results[0].pendantSpeech.audioBase64,
    undefined,
    'the nested copy is what overflowed the row; it must go too',
  )
  assert.equal(wire.execution.results[0].pendantSpeech.compressedAudioBase64, nested.compressedAudioBase64)
  assert.equal(wire.execution.results[0].seconds, 390, 'non-audio detail survives')
  assert.equal(wire.response, 'Your briefing is ready.')
  // Non-mutating: the agent's own result still has every byte.
  assert.ok(result.pendantSpeech.audioBase64)
  assert.ok(result.execution.results[0].pendantSpeech.audioBase64)

  const ratio = JSON.stringify(wire).length / JSON.stringify(result).length
  assert.ok(ratio < 0.05, `whole-result wire size should collapse, got ${ratio}`)
})

test('resultForWire leaves results without audio exactly as they are', () => {
  const plain = { response: 'Done.', executed: true, actions: [] }
  assert.equal(resultForWire(plain), plain)
  assert.equal(resultForWire(null), null)
})
