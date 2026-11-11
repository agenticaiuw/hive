import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appendedText,
  assessSignal,
  compareTranscript,
  diagnoseRun,
  parseSerialLine,
} from './inspect-pendant-workflow.mjs'

test('parses a weak PDM capture and unrecognized transcription', () => {
  const recording = parseSerialLine(
    'PDM capture totals: samples=52800 mean=101 peak=1458',
  )
  const transcription = parseSerialLine('Remote transcript: "."')

  assert.equal(recording.stage, 'recording')
  assert.equal(recording.meta.durationMs, 3300)
  assert.equal(recording.meta.signalAssessment, 'very_low')
  assert.equal(transcription.stage, 'transcription')
  assert.equal(transcription.status, 'failed')

  const diagnosis = diagnoseRun({
    expectedTranscript: 'open Outlook',
    events: [recording, transcription],
  })
  assert.equal(diagnosis.ok, false)
  assert.equal(diagnosis.stage, 'transcription')
  assert.match(diagnosis.summary, /STT returned "\."/)
})

test('parses live PDM signal telemetry', () => {
  const started = parseSerialLine(
    'PDM live: status=active sample_limit=480000',
  )
  const live = parseSerialLine(
    'PDM live: samples=16000 mean=101 peak=1458 rms=180 min=-1410 max=1458 zero_crossings=912',
  )
  assert.equal(started.status, 'active')
  assert.equal(started.startsRun, true)
  assert.equal(live.meta.durationMs, 1000)
  assert.equal(live.meta.rms, 180)
  assert.equal(live.meta.signalAssessment, 'very_low')
})

test('parses the successful downstream stages', () => {
  assert.deepEqual(
    parseSerialLine(
      'Transcript queued for Mac job job_6e4b7014-ef38-4a89-aba2-5de968613a34',
    ).meta,
    { jobId: 'job_6e4b7014-ef38-4a89-aba2-5de968613a34' },
  )
  assert.equal(
    parseSerialLine('Downloaded 55338 bytes of Mac agent speech PCM').stage,
    'reply_download',
  )
  assert.equal(
    parseSerialLine('Played 58914 samples of agent speech at 24000 Hz').terminal,
    true,
  )
})

test('parses Opus compression and decode telemetry', () => {
  const encoded = parseSerialLine(
    'Opus encoded 156250 PCM bytes to 10123 Ogg bytes (250 packets, 16000 Hz)',
  )
  const uploaded = parseSerialLine(
    'Uploaded 10123 Ogg Opus bytes representing 156250 PCM bytes',
  )
  const decoded = parseSerialLine(
    'Opus decoded 8450 Ogg bytes to 192000 PCM bytes (96000 samples at 24000 Hz)',
  )

  assert.equal(encoded.meta.opusBytes, 10123)
  assert.equal(uploaded.stage, 'lte_upload')
  assert.equal(decoded.stage, 'reply_download')
  assert.equal(decoded.meta.samples, 96000)
})

test('compares expected words without punctuation or case sensitivity', () => {
  assert.equal(compareTranscript('Open Outlook', 'open Outlook.').matches, true)
  assert.equal(compareTranscript('Open Outlook', 'You').matches, false)
  assert.equal(compareTranscript('Open Outlook', '.').score, 0)
})

test('rates signal levels conservatively', () => {
  assert.equal(assessSignal({ meanAbs: 0, peak: 0 }), 'silent')
  assert.equal(assessSignal({ meanAbs: 90, peak: 1365 }), 'very_low')
  assert.equal(assessSignal({ meanAbs: 101, peak: 1458 }), 'very_low')
  assert.equal(assessSignal({ meanAbs: 600, peak: 9000 }), 'usable')
})

test('finds appended serial output after screen scrollback rotates', () => {
  assert.equal(appendedText('a\nb\nc', 'a\nb\nc\nd'), '\nd')
  assert.equal(appendedText('a\nb\nc', 'b\nc\nd'), 'd')
})
