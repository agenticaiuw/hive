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
      storage: 'live_lte',
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

test('ignores plan jobs the owner did not start from a pendant or the dashboard', () => {
  assert.equal(
    voiceRunForJob({ jobId: 'job_mobile', type: 'plan', inputTelemetry: null }),
    null,
  )
})

test('shows a voice command recorded in a signed-in dashboard browser', () => {
  const run = voiceRunForJob({
    jobId: 'job_dashboard_voice',
    type: 'plan',
    status: 'queued',
    command: 'open Outlook',
    inputTelemetry: {
      storage: 'dashboard',
      source: 'dashboard-web',
      inputMode: 'voice',
      durationMs: 2400,
    },
    deviceEvents: [],
    result: null,
    error: null,
    createdAt: '2026-08-02T01:00:00.000Z',
    updatedAt: '2026-08-02T01:00:00.000Z',
  })

  assert.equal(run.pipelineId, 'job_dashboard_voice')
  assert.equal(run.command, 'open Outlook')
  assert.equal(run.events[0].stage, 'transcription')
  assert.equal(run.events[0].status, 'done')
  assert.equal(run.events[0].source, 'cloudflare')
  assert.equal(run.events[0].meta.inputTelemetry.source, 'dashboard-web')
})

test('labels a typed dashboard command instead of faking a transcription', () => {
  const run = voiceRunForJob({
    jobId: 'job_dashboard_typed',
    type: 'plan',
    status: 'queued',
    command: 'open Outlook',
    inputTelemetry: {
      storage: 'dashboard',
      source: 'dashboard-web',
      inputMode: 'typed',
    },
    deviceEvents: [],
    result: null,
    error: null,
    createdAt: '2026-08-02T01:00:00.000Z',
    updatedAt: '2026-08-02T01:00:00.000Z',
  })

  assert.equal(run.events[0].stage, 'transcription')
  assert.equal(run.events[0].status, 'done')
  assert.equal(run.events[0].source, 'dashboard')
  assert.match(run.events[0].label, /Typed in the dashboard/)
  assert.match(run.events[0].detail, /no audio to transcribe/i)
})

test('shows a recording immediately while Cloudflare is transcribing it', () => {
  const run = voiceRunForJob(
    {
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
    },
    { now: Date.parse('2026-08-01T01:00:30.000Z') },
  )

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

test('a plan parked for approval is neither a completed run nor a failed one', () => {
  const base = {
    jobId: 'job_parked',
    type: 'plan',
    status: 'plan_ready',
    command: 'send the weekly report',
    inputTelemetry: { storage: 'dashboard', inputMode: 'typed' },
    result: {
      executed: false,
      parked: true,
      phase: 'parked_for_approval',
      awaitingApproval: [
        { type: 'send_email', reason: 'Sending email acts on your behalf and needs approval.' },
      ],
      actions: [{ type: 'send_email', label: 'Email the report' }],
    },
    createdAt: '2026-08-08T12:00:00.000Z',
    updatedAt: '2026-08-08T12:00:05.000Z',
  }

  const run = voiceRunForJob(base)
  /*
   * Both wrong answers actually shipped: the pre-fix bridge reported parked as
   * a FAILURE (the 2026-08-08 retry storm), and a parked plan_ready satisfied
   * this feed's "agent done" clause and rendered as COMPLETED. It is neither —
   * the flow is waiting on the owner.
   */
  assert.equal(run.status, 'processing')
  const agent = run.events.find((event) => event.stage === 'agent')
  assert.equal(agent.status, 'waiting')
  assert.match(agent.label, /Waiting for your approval/)
  assert.equal(agent.meta.parked, true)
  assert.equal(agent.meta.awaitingApproval[0].type, 'send_email')

  // An executed plan job still reads as done end-to-end.
  const executed = voiceRunForJob({
    ...base,
    jobId: 'job_done',
    result: { executed: true, phase: 'complete', execution: { ok: true }, actions: [] },
  })
  assert.equal(executed.status, 'completed')

  // Rows a pre-fix bridge recorded as failed keep saying what it claimed; the
  // routine reaper, not this feed, is the compatibility path for those.
  const oldRow = voiceRunForJob({
    ...base,
    jobId: 'job_old',
    status: 'failed',
    error: 'Waiting for your approval on the dashboard.',
    result: { executed: false, awaitingApproval: [{ type: 'run_shell', reason: 'x' }] },
  })
  assert.equal(oldRow.status, 'failed')
})
