import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAudioCapture,
  publicJob,
  voiceRunForJob,
} from './jobs.js'

test('converts a pendant relay job into a dashboard voice run', () => {
  const run = voiceRunForJob({
    jobId: 'job_test',
    type: 'plan',
    status: 'plan_ready',
    command: 'open Outlook',
    inputTelemetry: {
      audioBytes: 148800,
      durationMs: 4650,
      sampleRate: 16000,
      storage: 'microSD',
    },
    result: {
      response: 'Outlook is open.',
      planner: 'llm',
      actions: [
        {
          type: 'open_app',
          label: 'Open Outlook',
          params: { appName: 'Microsoft Outlook' },
        },
      ],
      pendantSpeech: { format: 's16le', sampleRate: 24000, pcmBytes: 32000 },
    },
    deviceEvents: [
      {
        eventId: 'device_done',
        stage: 'device_playback',
        status: 'done',
        label: 'Playback complete',
        detail: 'Done',
        at: '2026-08-01T01:00:04.000Z',
      },
    ],
    createdAt: '2026-08-01T01:00:00.000Z',
    updatedAt: '2026-08-01T01:00:04.000Z',
  })

  assert.equal(run.pipelineId, 'job_test')
  assert.equal(run.status, 'completed')
  assert.deepEqual(
    run.events.map((event) => event.stage),
    ['transcription', 'agent', 'tts', 'relay_result', 'device_playback'],
  )
  assert.equal(run.events[0].meta.inputTelemetry.audioBytes, 148800)
  assert.equal(run.events[1].label, 'Mac action selected')
  assert.equal(run.events[1].meta.actions[0].label, 'Open Outlook')
})

test('ignores plan jobs that did not originate from pendant microSD audio', () => {
  assert.equal(
    voiceRunForJob({ jobId: 'job_mobile', type: 'plan', inputTelemetry: null }),
    null,
  )
})

test('shows a recording immediately while Cloudflare is transcribing it', () => {
  const run = voiceRunForJob({
    jobId: 'job_transcribing',
    type: 'plan',
    status: 'transcribing',
    command: '',
    inputTelemetry: {
      audioBytes: 112044,
      storage: 'microSD',
      format: 'wav',
    },
    deviceEvents: [],
    result: null,
    error: null,
    createdAt: '2026-08-01T01:00:00.000Z',
    updatedAt: '2026-08-01T01:00:00.000Z',
  })

  assert.equal(run.status, 'processing')
  assert.equal(run.command, '')
  assert.equal(run.events.length, 1)
  assert.equal(run.events[0].stage, 'transcription')
  assert.equal(run.events[0].status, 'active')
  assert.match(run.events[0].label, /transcription running/i)
})

test('keeps diagnostic audio out of public job payloads', () => {
  const capture = createAudioCapture({
    audioBase64: 'UklGRg==',
    audioBytes: 4,
    format: 'wav',
    language: 'en',
    transcript: '.',
    transcriptionModel: 'local-test',
  })

  assert.equal(capture.type, 'audio_capture')
  assert.equal(capture.status, 'completed')
  assert.equal(publicJob(capture).audioBase64, undefined)
})
