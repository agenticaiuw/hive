/*
 * Voice input for the command box, tested as the pure module it is.
 *
 * The claims worth pinning: the backend table matches the simulator's desktop
 * rule (Web Speech first, the relay pipeline only as fallback, honesty when
 * neither exists); the /v1/transcribe descriptor is the dashboard pipeline's
 * request — deviceId included, bare language code, and NEVER the token, which
 * rides only as popup.js's Authorization header; the capture format table is
 * byte-for-byte the dashboard's so Safari lands on m4a and Chrome on webm;
 * the scope refusal today's browser_node tokens will hit is reported in
 * owner-actionable words, not disguised as a network failure; and the
 * transcript LANDS IN THE BOX by appending, clipped to the box's own limit.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_AUDIO_BYTES,
  RECORDER_MIME_CANDIDATES,
  blobToBase64,
  chooseVoiceBackend,
  describeRecognitionError,
  interpretTranscribeResponse,
  mergeTranscript,
  mimeToFormat,
  pickRecorderMimeType,
  speechLang,
  transcribeLanguage,
  transcribeRequest,
  transcriptHasSpeech,
} from '../src/voice-input.js'
import { MAX_COMMAND_CHARS } from '../src/command-console.js'
import { RELAY_ORIGIN_ALLOWLIST, normalizeRelayConfig } from '../src/relay-peer.js'

const config = normalizeRelayConfig({
  relayEnabled: true,
  relayUrl: RELAY_ORIGIN_ALLOWLIST[0],
  relayDeviceId: 'evan-safari-bridge',
  deviceToken: 'pdt_not_a_real_token',
})

/* ------------------------------------------------------------------ *
 * Backend choice: the simulator's desktop rule, as a table.
 * ------------------------------------------------------------------ */

test('Web Speech wins whenever the browser has it, even with a relay paired', () => {
  const choice = chooseVoiceBackend({ hasSpeechRecognition: true, relayReady: true })
  assert.equal(choice.backend, 'webspeech')
})

test('without Web Speech, a paired relay carries the dashboard pipeline', () => {
  const choice = chooseVoiceBackend({ hasSpeechRecognition: false, relayReady: true })
  assert.equal(choice.backend, 'cloud')
})

test('with neither, the mic says so instead of pretending', () => {
  const choice = chooseVoiceBackend({ hasSpeechRecognition: false, relayReady: false })
  assert.equal(choice.backend, 'none')
  assert.match(choice.reason, /type instead/i)
})

/* ------------------------------------------------------------------ *
 * The /v1/transcribe descriptor: the dashboard's request, device-authed.
 * ------------------------------------------------------------------ */

test('the transcribe descriptor is the relay speech route with this device named', () => {
  const request = transcribeRequest(config, {
    audioBase64: 'QUJD',
    format: 'audio/webm;codecs=opus',
    language: 'en-US',
    durationMs: 1234.6,
  })
  assert.equal(request.method, 'POST')
  assert.equal(request.path, '/v1/transcribe')
  assert.equal(request.auth, 'device')
  assert.equal(request.body.audioBase64, 'QUJD')
  assert.equal(request.body.format, 'webm')
  /* /v1/transcribe wants a bare two-letter code, not a BCP-47 tag. */
  assert.equal(request.body.language, 'en')
  assert.equal(request.body.durationMs, 1235)
  /* The relay refuses a device principal whose body deviceId is not its own. */
  assert.equal(request.body.deviceId, 'evan-safari-bridge')
})

test('the descriptor never carries the token — that is the fetch header\'s job', () => {
  const request = transcribeRequest(config, { audioBase64: 'QUJD', format: 'webm' })
  assert.ok(!JSON.stringify(request).includes('pdt_not_a_real_token'))
})

test('an unready relay config refuses with its own reason instead of a doomed request', () => {
  const off = normalizeRelayConfig({})
  assert.throws(() => transcribeRequest(off, { audioBase64: 'QUJD', format: 'webm' }), {
    message: off.reason,
  })
})

test('empty audio and oversized audio are refused locally', () => {
  assert.throws(() => transcribeRequest(config, { audioBase64: '  ', format: 'webm' }), {
    message: /No audio captured/,
  })
  const oversized = 'A'.repeat(Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 8)
  assert.throws(
    () => transcribeRequest(config, { audioBase64: oversized, format: 'webm' }),
    { message: /8 MB/ },
  )
})

/* ------------------------------------------------------------------ *
 * Capture plumbing: the dashboard's tables, verbatim.
 * ------------------------------------------------------------------ */

test('mime candidates are the dashboard/simulator order — Safari lands on mp4', () => {
  assert.deepEqual(
    [...RECORDER_MIME_CANDIDATES],
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'],
  )
  const safariLike = { isTypeSupported: (type) => type === 'audio/mp4' }
  assert.equal(pickRecorderMimeType(safariLike), 'audio/mp4')
  const chromeLike = { isTypeSupported: () => true }
  assert.equal(pickRecorderMimeType(chromeLike), 'audio/webm;codecs=opus')
  assert.equal(pickRecorderMimeType(undefined), '')
})

test('mime → relay format naming matches the dashboard, and is idempotent', () => {
  assert.equal(mimeToFormat('audio/webm;codecs=opus'), 'webm')
  assert.equal(mimeToFormat('audio/mp4'), 'm4a')
  assert.equal(mimeToFormat('audio/ogg;codecs=opus'), 'ogg')
  assert.equal(mimeToFormat('audio/wav'), 'wav')
  assert.equal(mimeToFormat(''), 'webm')
  for (const format of ['webm', 'm4a', 'ogg', 'wav', 'mp3']) {
    assert.equal(mimeToFormat(format), format)
  }
})

test('blobToBase64 encodes the recorded bytes, not an approximation of them', async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
  const encoded = await blobToBase64(new Blob([bytes]))
  assert.deepEqual(Uint8Array.from(Buffer.from(encoded, 'base64')), bytes)
})

test('the language rule is the simulator\'s: Korean keyboards get Korean STT', () => {
  assert.equal(speechLang('ko-KR'), 'ko-KR')
  assert.equal(speechLang('en-US'), 'en-US')
  assert.equal(speechLang(undefined), 'en-US')
  assert.equal(transcribeLanguage('ko-KR'), 'ko')
  assert.equal(transcribeLanguage('fr-FR'), 'en')
})

/* ------------------------------------------------------------------ *
 * What one answer means for the box.
 * ------------------------------------------------------------------ */

test('a transcript comes back as a transcript', () => {
  const outcome = interpretTranscribeResponse({
    status: 200,
    payload: { text: '  open the dashboard  ' },
  })
  assert.deepEqual(outcome, { kind: 'transcript', text: 'open the dashboard' })
})

test('punctuation-only speech recognition is "no speech", the dashboard\'s own rule', () => {
  assert.equal(transcriptHasSpeech('. . .'), false)
  assert.equal(transcriptHasSpeech('ok'), true)
  const outcome = interpretTranscribeResponse({ status: 200, payload: { text: '...' } })
  assert.equal(outcome.kind, 'no-speech')
})

test('the scope refusal names the real problem instead of blaming the network', () => {
  const outcome = interpretTranscribeResponse({ status: 403, payload: { error: 'Blocked for safety.' } })
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.message, /browser_node/)
  assert.match(outcome.message, /speech:transcribe/)
  assert.doesNotMatch(outcome.message, /network/i)
})

test('401 says pair again; other failures keep the relay\'s own sentence', () => {
  assert.match(
    interpretTranscribeResponse({ status: 401, payload: {} }).message,
    /[Pp]air again/,
  )
  assert.equal(
    interpretTranscribeResponse({ status: 500, payload: { error: 'Workers AI fell over.' } })
      .message,
    'Workers AI fell over.',
  )
  assert.match(
    interpretTranscribeResponse({ status: 502, payload: null }).message,
    /HTTP 502/,
  )
})

/* ------------------------------------------------------------------ *
 * Landing in the box.
 * ------------------------------------------------------------------ */

test('a transcript appends to what was already typed, one space between', () => {
  assert.equal(mergeTranscript('open gmail', 'and archive everything'), 'open gmail and archive everything')
  assert.equal(mergeTranscript('', '  open gmail  '), 'open gmail')
  assert.equal(mergeTranscript('  typed  ', ''), 'typed')
})

test('the merged command respects the box\'s own length limit', () => {
  const merged = mergeTranscript('x'.repeat(MAX_COMMAND_CHARS), 'overflow')
  assert.equal(merged.length, MAX_COMMAND_CHARS)
})

/* ------------------------------------------------------------------ *
 * Web Speech errors → what the popup does about them.
 * ------------------------------------------------------------------ */

test('aborted is the owner\'s own click and says nothing', () => {
  assert.equal(describeRecognitionError('aborted').silent, true)
})

test('a network failure falls back to the relay pipeline ONLY when one is paired', () => {
  const withRelay = describeRecognitionError('network', { relayReady: true })
  assert.equal(withRelay.fallbackToCloud, true)
  const without = describeRecognitionError('network', { relayReady: false })
  assert.equal(without.fallbackToCloud, false)
  assert.match(without.message, /type instead/i)
})

test('a blocked microphone tells the owner where the fix lives', () => {
  const outcome = describeRecognitionError('not-allowed')
  assert.equal(outcome.fallbackToCloud, false)
  assert.match(outcome.message, /mic access/i)
})
