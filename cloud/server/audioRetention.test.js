import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUDIO_RETENTION_SWEEP_MAX_BATCH,
  audioCaptureExpiresAt,
  audioRetentionPolicy,
  deleteStoredAudio,
  hasStoredAudio,
  isAudioCaptureExpired,
  normalizeMaxAgeMs,
  selectExpiredAudioCaptures,
  sweepExpiredAudio,
} from './audioRetention.js'
import { createMemoryStore } from './store/memoryStore.js'

const DAY_MS = 1000 * 60 * 60 * 24
const NOW = Date.parse('2026-08-02T00:00:00.000Z')

function storedCapture(overrides = {}) {
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
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  }
}

function bucketWith(keys = []) {
  const objects = new Set(keys)
  return {
    objects,
    async delete(key) {
      objects.delete(key)
    },
  }
}

test('defaults stored recordings to a thirty-day retention window', () => {
  const policy = audioRetentionPolicy({ now: NOW })

  assert.equal(policy.maxAgeMs, 30 * DAY_MS)
  assert.equal(policy.maxAgeDays, 30)
  assert.equal(policy.expiresBefore, '2026-07-03T00:00:00.000Z')
  assert.equal(policy.deletePath, '/v1/ops/history/:pipelineId/audio')
})

test('refuses a zero or negative retention window so nothing is erased by a typo', () => {
  assert.equal(normalizeMaxAgeMs(0), 30 * DAY_MS)
  assert.equal(normalizeMaxAgeMs(-1), 30 * DAY_MS)
  assert.equal(normalizeMaxAgeMs('nonsense'), 30 * DAY_MS)
  assert.equal(normalizeMaxAgeMs(DAY_MS), DAY_MS)
})

test('sweeps are opt-in at the deployment level', () => {
  assert.equal(audioRetentionPolicy({ now: NOW }).sweepEnabled, false)
  assert.equal(
    audioRetentionPolicy({ now: NOW, sweepEnabled: true }).sweepEnabled,
    true,
  )
})

test('marks a recording expired only after the window has fully elapsed', () => {
  const old = storedCapture({ createdAt: '2026-07-01T00:00:00.000Z' })
  const fresh = storedCapture({ createdAt: '2026-07-20T00:00:00.000Z' })

  assert.equal(audioCaptureExpiresAt(old), '2026-07-31T00:00:00.000Z')
  assert.equal(isAudioCaptureExpired(old, { now: NOW }), true)
  assert.equal(isAudioCaptureExpired(fresh, { now: NOW }), false)
})

test('leaves a capture with no readable timestamp alone', () => {
  const broken = storedCapture({ createdAt: 'not-a-date' })
  assert.equal(audioCaptureExpiresAt(broken), null)
  assert.equal(isAudioCaptureExpired(broken, { now: NOW }), false)
})

test('ignores captures that hold no audio at all', () => {
  const metadataOnly = storedCapture({
    createdAt: '2020-01-01T00:00:00.000Z',
    audioRef: null,
    audioBase64: undefined,
    audioStorage: 'deleted',
  })

  assert.equal(hasStoredAudio(metadataOnly), false)
  assert.equal(isAudioCaptureExpired(metadataOnly, { now: NOW }), false)
  assert.equal(
    selectExpiredAudioCaptures([metadataOnly], { now: NOW }).length,
    0,
  )
})

test('caps how many recordings one sweep may touch', () => {
  const captures = Array.from({ length: AUDIO_RETENTION_SWEEP_MAX_BATCH + 20 }, (_, index) =>
    storedCapture({
      jobId: `job_capture_${index}`,
      createdAt: '2020-01-01T00:00:00.000Z',
    }),
  )

  assert.equal(
    selectExpiredAudioCaptures(captures, { now: NOW }).length,
    AUDIO_RETENTION_SWEEP_MAX_BATCH,
  )
  assert.equal(selectExpiredAudioCaptures(captures, { now: NOW, limit: 5 }).length, 5)
})

test('deleting a run recording drops the R2 object but keeps the transcript', async () => {
  const store = createMemoryStore()
  const capture = storedCapture({ jobId: 'job_capture_delete_1' })
  capture.audioRef.key = 'audio-captures/2026/08/02/job_capture_delete_1.ogg'
  await store.createJob(capture)
  const bucket = bucketWith([capture.audioRef.key])

  const report = await deleteStoredAudio(store, capture, {
    bindings: { AUDIO_BUCKET: bucket },
    now: '2026-08-03T00:00:00.000Z',
  })

  assert.equal(report.objectDeleted, true)
  assert.equal(report.recordDeleted, false)
  assert.equal(bucket.objects.size, 0)

  const remaining = await store.getJob('job_capture_delete_1')
  assert.equal(remaining.audioStorage, 'deleted')
  assert.equal(remaining.audioRef, null)
  assert.equal(remaining.audioDeletedAt, '2026-08-03T00:00:00.000Z')
  assert.equal(remaining.transcript, 'open Outlook')
})

test('record mode removes the D1 row as well', async () => {
  const store = createMemoryStore()
  const capture = storedCapture({ jobId: 'job_capture_delete_2' })
  capture.audioRef.key = 'audio-captures/2026/08/02/job_capture_delete_2.ogg'
  await store.createJob(capture)

  const report = await deleteStoredAudio(store, capture, {
    mode: 'record',
    bindings: { AUDIO_BUCKET: bucketWith([capture.audioRef.key]) },
  })

  assert.equal(report.mode, 'record')
  assert.equal(report.recordDeleted, true)
  assert.equal(await store.getJob('job_capture_delete_2'), null)
})

test('a dry-run sweep reports expired recordings and deletes nothing', async () => {
  const store = createMemoryStore()
  const expired = storedCapture({
    jobId: 'job_capture_sweep_1',
    createdAt: '2020-01-01T00:00:00.000Z',
  })
  expired.audioRef.key = 'audio-captures/2020/01/01/job_capture_sweep_1.ogg'
  const fresh = storedCapture({ jobId: 'job_capture_sweep_2' })
  await store.createJob(expired)
  await store.createJob(fresh)
  const bucket = bucketWith([expired.audioRef.key])

  const report = await sweepExpiredAudio(store, {
    now: NOW,
    bindings: { AUDIO_BUCKET: bucket },
  })

  const expiredIds = report.expired.map((item) => item.captureId)
  assert.equal(report.dryRun, true)
  assert.equal(report.deleted.length, 0)
  assert.ok(expiredIds.includes('job_capture_sweep_1'))
  assert.ok(!expiredIds.includes('job_capture_sweep_2'))
  assert.equal(bucket.objects.size, 1)
  assert.equal((await store.getJob('job_capture_sweep_1')).audioStorage, 'r2')
})

test('an explicit sweep removes only the expired recordings', async () => {
  const store = createMemoryStore()
  const expired = storedCapture({
    jobId: 'job_capture_sweep_3',
    createdAt: '2020-01-01T00:00:00.000Z',
  })
  expired.audioRef.key = 'audio-captures/2020/01/01/job_capture_sweep_3.ogg'
  const fresh = storedCapture({ jobId: 'job_capture_sweep_4' })
  fresh.audioRef.key = 'audio-captures/2026/08/02/job_capture_sweep_4.ogg'
  await store.createJob(expired)
  await store.createJob(fresh)
  const bucket = bucketWith([expired.audioRef.key, fresh.audioRef.key])

  const report = await sweepExpiredAudio(store, {
    now: NOW,
    dryRun: false,
    bindings: { AUDIO_BUCKET: bucket },
  })

  const deletedIds = report.deleted.map((item) => item.captureId)
  assert.equal(report.dryRun, false)
  assert.ok(deletedIds.includes('job_capture_sweep_3'))
  assert.ok(!deletedIds.includes('job_capture_sweep_4'))
  assert.deepEqual([...bucket.objects], [fresh.audioRef.key])
  assert.equal((await store.getJob('job_capture_sweep_3')).audioStorage, 'deleted')
  assert.equal((await store.getJob('job_capture_sweep_4')).audioStorage, 'r2')
})
