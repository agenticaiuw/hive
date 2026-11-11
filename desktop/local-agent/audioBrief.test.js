import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BRIEF_MAX_SECONDS,
  briefingSlug,
  renderBriefAudio,
  waveFile,
} from './audioBrief.js'
import {
  PENDANT_SPEECH_SAMPLE_RATE,
  extractWavePcm,
  pendantSpeechPayload,
  prerenderedPendantSpeech,
  synthesizePendantSpeech,
} from './pendantSpeech.js'
import { researchCliCall } from './computerControl.js'

/* The relay's own acceptance test, copied from cloud-relay/server.js
 * pendantSpeechForJob(). If this drifts, the pendant plays nothing. */
function relayWouldForward(speech) {
  if (!speech) return null
  if (String(speech.format).toLowerCase() !== 's16le') return null
  if (Number(speech.sampleRate) !== 24000) return null
  if (Number(speech.channels) !== 1) return null
  if (Number(speech.bitsPerSample) !== 16) return null
  if (!String(speech.audioBase64 || '').trim()) return null

  const compressed = Buffer.from(speech.compressedAudioBase64 || '', 'base64')
  if (
    compressed.length >= 64 &&
    String(speech.compressedFormat).toLowerCase() === 'ogg-opus' &&
    compressed.toString('ascii', 0, 4) === 'OggS'
  ) {
    return { format: 'ogg-opus', bytes: compressed.length }
  }
  const pcm = Buffer.from(speech.audioBase64, 'base64')
  if (!pcm.length || pcm.length % 2 !== 0) return null
  return { format: 's16le', bytes: pcm.length }
}

test('briefingSlug is sortable, readable and filesystem-safe', () => {
  const slug = briefingSlug(
    'Best USB-C hubs for the MacBook Pro (2026 models)!',
    '2026-08-07T09:15:00.000Z',
  )
  assert.match(slug, /^20260807-091500-best-usb-c-hubs-for-the$/)
  assert.equal(briefingSlug('', '2026-08-07T09:15:00.000Z'), '20260807-091500-briefing')
})

test('waveFile round-trips through the pendant PCM reader', () => {
  const pcm = Buffer.alloc(PENDANT_SPEECH_SAMPLE_RATE * 2)
  for (let sample = 0; sample < PENDANT_SPEECH_SAMPLE_RATE; sample += 1) {
    pcm.writeInt16LE(
      Math.round(Math.sin((sample * Math.PI * 2 * 440) / 24000) * 8000),
      sample * 2,
    )
  }
  const decoded = extractWavePcm(waveFile(pcm))
  assert.equal(decoded.length, pcm.length)
  assert.equal(decoded.compare(pcm), 0)
})

test('renderBriefAudio produces a long brief in the exact format the relay forwards', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pendant-brief-test-'))
  try {
    /* Long enough that the 180-character reply path could not have produced it. */
    const script =
      'Here is your briefing on low power wide area networks. ' +
      'Coverage in rural counties is uneven and carriers publish optimistic maps. '.repeat(6)

    const audio = renderBriefAudio({ text: script, directory, basename: 'test-brief' })

    assert.ok(fs.existsSync(audio.wavPath))
    assert.ok(fs.existsSync(audio.opusPath))
    assert.ok(audio.seconds > 20, `expected a long brief, got ${audio.seconds}s`)
    assert.equal(audio.opus.toString('ascii', 0, 4), 'OggS')
    // Opus is what actually crosses the LTE-M link; it must be far smaller.
    assert.ok(audio.opusBytes < audio.pcmBytes / 20)
    assert.equal(extractWavePcm(fs.readFileSync(audio.wavPath)).length, audio.pcmBytes)

    const forwarded = relayWouldForward(
      pendantSpeechPayload(audio.pcm, audio.opus, audio.truncated),
    )
    assert.deepEqual(forwarded, { format: 'ogg-opus', bytes: audio.opusBytes })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('renderBriefAudio caps runaway scripts and fades instead of cutting', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pendant-brief-test-'))
  try {
    const maxPcmBytes = PENDANT_SPEECH_SAMPLE_RATE * 2 * 2 // two seconds
    const audio = renderBriefAudio({
      text: 'One two three four five six seven eight nine ten. '.repeat(20),
      directory,
      basename: 'capped',
      maxPcmBytes,
    })

    assert.equal(audio.truncated, true)
    assert.equal(audio.pcmBytes, maxPcmBytes)
    // The .wav on disk was rewritten to match the trimmed PCM, not left long.
    assert.equal(extractWavePcm(fs.readFileSync(audio.wavPath)).length, maxPcmBytes)
    // Last sample is silence: a hard cut reads as a dropped connection.
    assert.equal(audio.pcm.readInt16LE(audio.pcm.length - 2), 0)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('renderBriefAudio refuses an empty script', () => {
  assert.throws(() => renderBriefAudio({ text: '   ' }), /needs something to say/)
})

test('the brief ceiling is far above the reply ceiling', () => {
  // A briefing that stopped at the 10 s reply cap would not be a briefing.
  assert.ok(BRIEF_MAX_SECONDS >= 60, `brief ceiling is only ${BRIEF_MAX_SECONDS}s`)
})

test('pre-rendered briefing audio survives the bridge instead of being re-spoken', () => {
  const pcm = Buffer.alloc(PENDANT_SPEECH_SAMPLE_RATE * 2 * 3)
  const speech = pendantSpeechPayload(pcm, Buffer.from('OggS placeholder bytes'), false)

  // Attached to the top-level result...
  const direct = synthesizePendantSpeech({
    response: 'Your briefing on LTE-M is ready.',
    pendantSpeech: speech,
  })
  assert.equal(direct.pendantSpeech.pcmBytes, pcm.length)

  // ...and attached to one action result inside an execute payload.
  const nested = synthesizePendantSpeech({
    response: 'Your briefing on LTE-M is ready.',
    results: [{ ok: true, message: 'no audio' }, { ok: true, pendantSpeech: speech }],
  })
  assert.equal(nested.pendantSpeech.pcmBytes, pcm.length)
})

test('a malformed pre-rendered payload is ignored, not forwarded', () => {
  assert.equal(
    prerenderedPendantSpeech({
      pendantSpeech: { format: 's16le', sampleRate: 16000, channels: 1, bitsPerSample: 16, audioBase64: 'AA==' },
    }),
    null,
  )
  assert.equal(
    prerenderedPendantSpeech({
      pendantSpeech: { format: 's16le', sampleRate: 24000, channels: 1, bitsPerSample: 16, audioBase64: '' },
    }),
    null,
  )
  assert.equal(prerenderedPendantSpeech({ response: 'x' }), null)

  // …and the normal render still happens for a result with no payload.
  const rendered = synthesizePendantSpeech({ response: 'Nothing pre-rendered here.' })
  assert.equal(rendered.pendantSpeech.sampleRate, PENDANT_SPEECH_SAMPLE_RATE)
  assert.ok(rendered.pendantSpeech.pcmBytes > 1000)
})

test('researchCliCall reads the flags the planner is told to emit', () => {
  const call = researchCliCall({
    type: 'run_shell',
    params: {
      command:
        'node /repo/scripts/research-brief.mjs --topic "LTE-M coverage in rural Wisconsin" --mode compare --now',
    },
  })
  assert.equal(call.play, false)
  assert.equal(call.params.topic, 'LTE-M coverage in rural Wisconsin')
  assert.equal(call.params.mode, 'compare')
  assert.equal(call.params.deliver, 'now')
  assert.equal(call.params.openNote, false)
})

test('researchCliCall recognises playback and defaults to the latest', () => {
  const latest = researchCliCall({
    type: 'run_shell',
    params: { command: 'node scripts/research-brief.mjs --play latest' },
  })
  assert.deepEqual(latest, { play: true, params: { id: 'latest' } })

  const specific = researchCliCall({
    type: 'run_shell',
    params: { command: 'node scripts/research-brief.mjs --play brf_123' },
  })
  assert.equal(specific.params.id, 'brf_123')
})

test('researchCliCall leaves every other shell command alone', () => {
  assert.equal(
    researchCliCall({ type: 'run_shell', params: { command: 'ls -la ~/Downloads' } }),
    null,
  )
  assert.equal(
    researchCliCall({ type: 'open_url', params: { url: 'https://research-brief.mjs' } }),
    null,
  )
  // A research invocation with no topic and no --play is not a research call.
  assert.equal(
    researchCliCall({ type: 'run_shell', params: { command: 'node scripts/research-brief.mjs --list' } }),
    null,
  )
})
