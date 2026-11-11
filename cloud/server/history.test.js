import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildHistoryPage,
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyEntryForJob,
  linkAudioCaptures,
  normalizeHistoryLimit,
  normalizeHistoryQuery,
  matchesHistoryQuery,
  runDetailForJob,
  spokenReplyForJob,
} from './history.js'

function planJob(overrides = {}) {
  return {
    jobId: 'job_plan_1',
    type: 'plan',
    status: 'completed',
    command: 'open Outlook',
    sessionId: 'session_1',
    createdBy: 'nrf9160-pendant',
    inputTelemetry: {
      storage: 'microSD',
      inputMode: 'voice',
      audioBytes: 8123,
      durationMs: 3200,
    },
    actions: [],
    deviceEvents: [],
    result: {
      ok: true,
      status: 'completed',
      response: 'Opened Microsoft Outlook',
      summary: 'Opened Microsoft Outlook',
      planner: 'llm',
      actions: [{ type: 'open_app', label: 'Open Outlook' }],
      results: [{ type: 'open_app', ok: true }],
    },
    error: null,
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:00:05.000Z',
    ...overrides,
  }
}

function capture(overrides = {}) {
  return {
    jobId: 'job_capture_1',
    type: 'audio_capture',
    status: 'completed',
    audioStorage: 'r2',
    audioRef: {
      provider: 'r2',
      key: 'audio-captures/2026/08/02/job_capture_1.ogg',
      contentType: 'audio/ogg',
    },
    audioBytes: 8123,
    format: 'ogg',
    transcript: 'open Outlook',
    transcriptionModel: 'whisper',
    createdAt: '2026-08-02T10:00:00.500Z',
    updatedAt: '2026-08-02T10:00:02.000Z',
    ...overrides,
  }
}

test('surfaces the spoken reply, origin, and status on a history entry', () => {
  const entry = historyEntryForJob(planJob(), {
    capture: capture(),
    link: 'telemetry',
  })

  assert.equal(entry.pipelineId, 'job_plan_1')
  assert.equal(entry.command, 'open Outlook')
  assert.equal(entry.origin, 'microsd')
  assert.equal(entry.inputMode, 'voice')
  assert.equal(entry.status, 'processing')
  assert.equal(entry.reply, 'Opened Microsoft Outlook')
  assert.equal(entry.actionCount, 1)
  assert.equal(entry.audio.available, true)
  assert.equal(entry.audio.captureId, 'job_capture_1')
  assert.equal(entry.audio.storage, 'r2')
})

test('reports a run with no recording as having no audio', () => {
  const entry = historyEntryForJob(
    planJob({
      jobId: 'job_typed',
      inputTelemetry: { storage: 'dashboard', inputMode: 'typed' },
    }),
  )

  assert.equal(entry.origin, 'dashboard')
  assert.equal(entry.inputMode, 'typed')
  assert.equal(entry.audio.available, false)
  assert.equal(entry.audio.captureId, null)
})

test('treats a deleted recording as unplayable without losing its identity', () => {
  const entry = historyEntryForJob(planJob(), {
    capture: capture({
      audioStorage: 'deleted',
      audioRef: null,
      audioDeletedAt: '2026-08-03T00:00:00.000Z',
    }),
    link: 'telemetry',
  })

  assert.equal(entry.audio.available, false)
  assert.equal(entry.audio.captureId, 'job_capture_1')
  assert.equal(entry.audio.deletedAt, '2026-08-03T00:00:00.000Z')
})

test('prefers the recorded captureId over the timestamp heuristic', () => {
  const job = planJob({
    inputTelemetry: {
      storage: 'microSD',
      inputMode: 'voice',
      captureId: 'job_capture_exact',
    },
  })
  const links = linkAudioCaptures(
    [job],
    [
      capture({ jobId: 'job_capture_decoy', createdAt: '2026-08-02T10:00:00.100Z' }),
      capture({ jobId: 'job_capture_exact', createdAt: '2026-08-02T10:00:30.000Z' }),
    ],
  )

  assert.equal(links.get('job_plan_1').capture.jobId, 'job_capture_exact')
  assert.equal(links.get('job_plan_1').link, 'telemetry')
})

test('matches legacy recordings by identical transcript inside the time window', () => {
  const links = linkAudioCaptures([planJob()], [capture()])
  assert.equal(links.get('job_plan_1').capture.jobId, 'job_capture_1')
  assert.equal(links.get('job_plan_1').link, 'heuristic')
})

test('refuses a heuristic match once the recording is far from the run', () => {
  const links = linkAudioCaptures(
    [planJob()],
    [capture({ createdAt: '2026-08-02T11:00:00.000Z' })],
  )
  assert.equal(links.has('job_plan_1'), false)
})

test('never lends one recording to two runs', () => {
  const links = linkAudioCaptures(
    [planJob({ jobId: 'job_a' }), planJob({ jobId: 'job_b' })],
    [capture()],
  )

  assert.equal(links.size, 1)
  assert.ok(links.has('job_a'))
})

test('paginates newest-first with a cursor that survives a shared timestamp', () => {
  const jobs = [
    planJob({ jobId: 'job_c', createdAt: '2026-08-02T10:00:02.000Z' }),
    planJob({ jobId: 'job_b', createdAt: '2026-08-02T10:00:01.000Z' }),
    planJob({ jobId: 'job_a', createdAt: '2026-08-02T10:00:01.000Z' }),
  ]
  const page = buildHistoryPage({ jobs, captures: [], limit: 2, scanLimit: 50 })

  assert.deepEqual(
    page.entries.map((entry) => entry.pipelineId),
    ['job_c', 'job_b'],
  )
  assert.equal(page.hasMore, true)
  assert.equal(page.nextCursor, '2026-08-02T10:00:01.000Z|job_b')
  assert.deepEqual(decodeHistoryCursor(page.nextCursor), {
    createdAt: '2026-08-02T10:00:01.000Z',
    jobId: 'job_b',
  })
})

test('stops paging when the page is the last one', () => {
  const page = buildHistoryPage({
    jobs: [planJob()],
    captures: [],
    limit: 20,
    scanLimit: 50,
  })

  assert.equal(page.entries.length, 1)
  assert.equal(page.hasMore, false)
  assert.equal(page.nextCursor, null)
})

test('keeps paging past a scan window that held no owner-initiated runs', () => {
  const jobs = [
    { jobId: 'job_noise_1', type: 'plan', inputTelemetry: null, createdAt: '2026-08-02T10:00:02.000Z' },
    { jobId: 'job_noise_2', type: 'plan', inputTelemetry: null, createdAt: '2026-08-02T10:00:01.000Z' },
  ]
  const page = buildHistoryPage({ jobs, captures: [], limit: 20, scanLimit: 2 })

  assert.equal(page.entries.length, 0)
  assert.equal(page.hasMore, true)
  assert.equal(page.nextCursor, '2026-08-02T10:00:01.000Z|job_noise_2')
})

test('searches the transcript and the spoken reply, case-insensitively', () => {
  const job = planJob()
  assert.equal(matchesHistoryQuery(job, 'OUTLOOK'), true)
  assert.equal(matchesHistoryQuery(job, 'opened microsoft'), true)
  assert.equal(matchesHistoryQuery(job, 'calendar'), false)
  assert.equal(matchesHistoryQuery(job, '   '), true)
})

test('rejects a malformed cursor instead of returning an empty history', () => {
  assert.equal(decodeHistoryCursor('not-a-date'), null)
  assert.equal(decodeHistoryCursor(''), null)
  assert.equal(decodeHistoryCursor(undefined), null)
  assert.equal(encodeHistoryCursor({ createdAt: null, pipelineId: 'x' }), null)
})

test('clamps the page size to a sane range', () => {
  assert.equal(normalizeHistoryLimit(undefined), 20)
  assert.equal(normalizeHistoryLimit(0), 20)
  assert.equal(normalizeHistoryLimit(5), 5)
  assert.equal(normalizeHistoryLimit(9999), 50)
  assert.equal(normalizeHistoryQuery('  hi  ').length, 2)
})

test('run detail carries the timeline, actions, execution results, and reply', () => {
  const detail = runDetailForJob(planJob(), {
    capture: capture(),
    link: 'telemetry',
  })

  assert.equal(detail.pipelineId, 'job_plan_1')
  assert.equal(detail.reply, 'Opened Microsoft Outlook')
  assert.ok(detail.events.some((event) => event.stage === 'transcription'))
  assert.ok(detail.events.some((event) => event.stage === 'agent'))
  assert.equal(detail.actions[0].label, 'Open Outlook')
  assert.equal(detail.execution.ok, true)
  assert.deepEqual(detail.execution.results, [{ type: 'open_app', ok: true }])
  assert.equal(detail.execution.response, 'Opened Microsoft Outlook')
  assert.equal(detail.transcript, 'open Outlook')
  assert.equal(detail.createdBy, 'nrf9160-pendant')
})

test('run detail is null for jobs the owner never started', () => {
  assert.equal(runDetailForJob({ jobId: 'x', type: 'plan' }), null)
  assert.equal(spokenReplyForJob({ result: null }), '')
})
