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
  CANONICAL_SPEECH_PATH,
  hasServableOpus,
  pendantSpeechCacheSize,
  pendantSpeechForWire,
  resultForWire,
  spokenConfirmation,
  spokenTextForResult,
  synthesizePendantSpeech,
  telemetryForWire,
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

test('spokenConfirmation speaks the goal verdict, not the steps, when the goal was not met', () => {
  // Clean reconnaissance steps with a goal-grounded 'incomplete' verdict:
  // the pendant must say what was NOT done, never recite steps that sound
  // like success.
  assert.equal(
    spokenConfirmation(
      { response: 'Cancelling your recurring investments' },
      {
        status: 'incomplete',
        response:
          'Opened the page and looked around — nothing was cancelled. The next step needs your approval.',
        results: [
          { ok: true, message: 'Browser session "ibkr" opened' },
          { ok: true, message: 'Snapshot: 40 interactive element(s)' },
        ],
      },
    ),
    'Opened the page and looked around — nothing was cancelled. The next step needs your approval.',
  )
  // A step failure still wins: 'incomplete' phrasing never masks a real error.
  assert.match(
    spokenConfirmation(
      {},
      {
        status: 'incomplete',
        response: 'Opened the page — nothing was cancelled.',
        results: [{ ok: false, message: 'browser crashed' }],
      },
    ),
    /That didn't work/,
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
  // The nested copy's opus is the same bytes as the canonical one, so it is a
  // reference now rather than a second copy.
  assert.equal(
    wire.execution.results[0].pendantSpeech.compressedAudioBase64,
    undefined,
  )
  assert.equal(
    wire.execution.results[0].pendantSpeech.audioSameAs,
    'pendantSpeech',
  )
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

/* ---------------------------------------------------------------------------
 * The non-duplication invariant. One 58.5 s briefing is ~3.9 MB, yet a live
 * posted body was 45,967,944 B: /execute returns `logs: readLogs()` -- the
 * agent's GLOBAL 200-entry ring, 40 MB on disk, holding ~30 earlier briefings'
 * audio -- and the bridge spread that whole response into the relay result.
 * The audio must cross the wire ONCE, at the canonical path every relay reader
 * actually reads, and the ring must not cross it at all.
 * ------------------------------------------------------------------------- */

/** Every base64-ish blob in a payload, with how many times it appears. */
function blobOccurrences(value, minChars = 4096, counts = new Map()) {
  if (Array.isArray(value)) {
    for (const entry of value) blobOccurrences(entry, minChars, counts)
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (typeof entry === 'string' && entry.length > minChars) {
        counts.set(entry, (counts.get(entry) || 0) + 1)
      } else {
        blobOccurrences(entry, minChars, counts)
      }
    }
  }
  return counts
}

test('the reply audio crosses the wire exactly once, however many places hold it', () => {
  const speech = () => speechFixture({ pcmBytes: 900_000 })
  const result = {
    response: 'Your briefing is ready.',
    executed: true,
    pendantSpeech: speech(),
    execution: {
      ok: true,
      results: [{ type: 'research_brief', seconds: 58.5, pendantSpeech: speech() }],
      trace: { rendered: { pendantSpeech: speech() } },
    },
  }

  const wire = resultForWire(result)
  const counts = blobOccurrences(wire)
  assert.equal(
    Math.max(0, ...counts.values()),
    1,
    'no audio blob may appear twice at any depth',
  )

  // The one copy lives where every relay reader looks for it.
  assert.ok(wire.pendantSpeech.compressedAudioBase64)
  assert.equal(wire.pendantSpeech.audioSameAs, undefined)
  // The others point at it instead of repeating it, and keep their metadata.
  for (const copy of [
    wire.execution.results[0].pendantSpeech,
    wire.execution.trace.rendered.pendantSpeech,
  ]) {
    assert.equal(copy.compressedAudioBase64, undefined)
    assert.equal(copy.audioBase64, undefined)
    assert.equal(copy.audioSameAs, CANONICAL_SPEECH_PATH)
    assert.equal(copy.audioOmitted, true)
    assert.equal(copy.format, 's16le', 'metadata survives the reference')
  }
  assert.equal(wire.execution.results[0].seconds, 58.5)
})

test("the agent's global activity ring is summarised, never shipped", () => {
  const noisy = Array.from({ length: 200 }, (_, index) => ({
    id: `log_${index}`,
    command: 'Give me the top world and US news headlines',
    payload: 'z'.repeat(50_000),
  }))
  const result = {
    response: 'Done.',
    execution: { ok: true, logs: noisy, results: [] },
  }

  const before = Buffer.byteLength(JSON.stringify(result), 'utf8')
  const wire = resultForWire(result)
  const after = Buffer.byteLength(JSON.stringify(wire), 'utf8')

  assert.ok(before > 10_000_000, 'the fixture must be the real order of size')
  assert.ok(after < 2_000, `the ring must not cross the wire, got ${after} B`)
  // Summarised, not silently dropped: the count still says what was there.
  assert.equal(wire.execution.logs.length, 200)
  assert.match(wire.execution.logs.elided, /not shipped to the relay/)
  // Everything else is untouched.
  assert.equal(wire.response, 'Done.')
  assert.equal(wire.execution.ok, true)
})

/* ---------------------------------------------------------------------------
 * Pipeline telemetry. The bridge's POST to the agent's own /pipeline/events was
 * still fat after the relay reports were fixed: it carried meta.results, which
 * is where a briefing payload rides. It came back 413 and the WHOLE event was
 * lost — including the stage transition the dashboard strip renders. The
 * receiver drops audio anyway (pipelineTrace.js sanitizeMeta strips /base64/
 * keys), so those bytes could never have been displayed.
 * ------------------------------------------------------------------------- */

test('telemetry carries no audio bytes and no activity ring, but keeps the event', () => {
  const speech = speechFixture({ pcmBytes: 900_000 })
  const body = {
    pipelineId: 'job_1',
    kind: 'plan',
    stage: 'agent',
    status: 'done',
    label: 'Executing actions — done',
    detail: 'Finished in 812 ms.',
    text: 'Your briefing is ready.',
    meta: {
      resultCount: 1,
      results: [{ type: 'research_brief', ok: true, pendantSpeech: speech }],
      logs: Array.from({ length: 200 }, (_, i) => ({ id: i, blob: 'z'.repeat(20_000) })),
    },
  }

  const before = Buffer.byteLength(JSON.stringify(body), 'utf8')
  const wire = telemetryForWire(body)
  const after = Buffer.byteLength(JSON.stringify(wire), 'utf8')

  assert.ok(before > 4_000_000, 'the fixture must be the real order of size')
  assert.ok(after < 2_000, `telemetry must stay small, got ${after} B`)

  // No audio blob survives anywhere, at any depth.
  const counts = blobOccurrences(wire, 1024)
  assert.equal(counts.size, 0, 'telemetry must carry no audio bytes at all')

  // The event itself — the part the dashboard strip actually renders — is intact.
  assert.equal(wire.stage, 'agent')
  assert.equal(wire.status, 'done')
  assert.equal(wire.label, 'Executing actions — done')
  assert.equal(wire.detail, 'Finished in 812 ms.')
  assert.equal(wire.text, 'Your briefing is ready.')
  // Useful action metadata survives; only the bytes go.
  assert.equal(wire.meta.resultCount, 1)
  assert.equal(wire.meta.results[0].type, 'research_brief')
  assert.equal(wire.meta.results[0].ok, true)
  assert.equal(wire.meta.results[0].pendantSpeech.audioOmitted, true)
  assert.equal(wire.meta.results[0].pendantSpeech.format, 's16le')
  assert.equal(wire.meta.logs.length, 200)
})

test('telemetry passes through ordinary events untouched', () => {
  const body = {
    pipelineId: 'job_2',
    stage: 'tts',
    status: 'active',
    label: 'Rendering response speech',
    meta: { pcmBytes: 480_000, durationMs: 812 },
  }
  const wire = telemetryForWire(body)
  assert.deepEqual(wire, body)
})
