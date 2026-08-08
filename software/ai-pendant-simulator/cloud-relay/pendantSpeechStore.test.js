import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import {
  offloadLargePendantSpeech,
  offloadResultSpeechAudio,
  resolvePendantSpeechBuffers,
} from './pendantSpeechStore.js'
import { createRoutine, occurrenceKey, reapDispatchedRuns } from './routines.js'

const NOW = Date.parse('2026-08-08T22:27:53Z')
const silentLogger = { log() {}, warn() {} }

/* A minimal R2 double, same contract as audioStorage.test.js. */
function createFakeR2() {
  const objects = new Map()
  return {
    objects,
    async put(key, body, options) {
      const buffer = Buffer.from(body)
      objects.set(key, { buffer, httpMetadata: options?.httpMetadata })
      return { etag: 'test-etag' }
    },
    async get(key) {
      const object = objects.get(key)
      if (!object) return null
      return {
        httpMetadata: object.httpMetadata,
        async arrayBuffer() {
          return object.buffer.buffer.slice(
            object.buffer.byteOffset,
            object.buffer.byteOffset + object.buffer.byteLength,
          )
        },
      }
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

/*
 * A store that reproduces the production failure: Cloudflare D1 rejects a
 * value/row past its limit, and updateJob() serializes the whole job into one
 * value (d1Store.js). If the fix did not run, storing a reply with megabytes of
 * PCM throws here — exactly the unhandled throw that rendered the bare 500.
 */
function sizeLimitedStore({ limit = 1_000_000 } = {}) {
  const jobs = new Map()
  const runs = new Map()
  const routines = new Map()
  const announcements = new Map()
  return {
    jobs,
    runs,
    routines,
    announcements,
    async createJob(job) {
      jobs.set(job.jobId, { ...job })
      return job
    },
    async getJob(jobId) {
      return jobs.get(jobId) ?? null
    },
    async updateJob(jobId, patch) {
      const current = jobs.get(jobId)
      if (!current) return null
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
      const serialized = JSON.stringify(next)
      if (serialized.length > limit) {
        throw new Error(
          `D1_ERROR: row too big (${serialized.length} bytes > ${limit})`,
        )
      }
      jobs.set(jobId, next)
      return next
    },
    async saveRoutine(routine) {
      routines.set(routine.routineId, { ...routine })
      return routine
    },
    async getRoutine(id) {
      return routines.get(id) ?? null
    },
    async recordRoutineRun(run) {
      runs.set(run.runId, { ...run })
      return run
    },
    async listRoutineRuns({ status = null, limit = 25 } = {}) {
      return [...runs.values()]
        .filter((run) => !status || run.status === status)
        .slice(0, limit)
    },
    async createAnnouncement(announcement) {
      announcements.set(announcement.announcementId, announcement)
      return announcement
    },
  }
}

function oggOpus(bytes = 4096) {
  const buffer = Buffer.alloc(Math.max(bytes, 64), 7)
  buffer.write('OggS', 0, 'ascii')
  return buffer
}

/* The shape local-agent/pendantSpeech.js pendantSpeechPayload() emits. */
function pendantSpeech({ pcmBytes, opusBytes = 4096 }) {
  const pcm = Buffer.alloc(pcmBytes, 1)
  const opus = oggOpus(opusBytes)
  return {
    speech: {
      format: 's16le',
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      pcmBytes: pcm.length,
      audioBase64: pcm.toString('base64'),
      compressedFormat: 'ogg-opus',
      compressedAudioBase64: opus.toString('base64'),
    },
    pcm,
    opus,
  }
}

const dispatchedRun = (routine, jobId) => ({
  runId: 'run_news',
  routineId: routine.routineId,
  routineName: routine.name,
  status: 'dispatched',
  startedAt: new Date(NOW).toISOString(),
  dueAt: new Date(NOW).toISOString(),
  attempt: 1,
  macJobId: jobId,
  occurrenceKey: occurrenceKey(routine.routineId, new Date(NOW).toISOString()),
})

test('an auto-run routine reply with megabytes of PCM stores without throwing, and the reaper still completes the run', async () => {
  const bucket = createFakeR2()
  const store = sizeLimitedStore({ limit: 1_000_000 })
  const routine = createRoutine({
    name: 'Morning news',
    command: 'Give me the top world and US news headlines.',
    schedule: { kind: 'daily', at: '07:00' },
    now: NOW,
  })
  await store.saveRoutine({ ...routine, nextRunAt: NOW + 86_400_000 })

  const jobId = 'job_news'
  await store.createJob({
    jobId,
    type: 'plan',
    status: 'processing',
    inputTelemetry: { storage: 'routine', inputMode: 'routine' },
    createdAt: new Date(NOW).toISOString(),
  })

  // ~9 MB of PCM -> ~12 MB of base64, the size the live incident carried.
  const { speech, pcm } = pendantSpeech({ pcmBytes: 9_000_000, opusBytes: 4096 })
  const result = {
    response: 'Top world and US news, in three short sentences.',
    executed: true,
    phase: 'executed',
    pendantSpeech: speech,
  }

  // Reproduce the bug: storing the raw result overflows the D1 row and throws.
  await assert.rejects(
    store.updateJob(jobId, { status: 'plan_ready', result }),
    /row too big/,
    'raw megabyte audio must overflow the simulated D1 row',
  )

  // The fix, in the same order the handler runs it: offload, then store.
  const stored = await offloadResultSpeechAudio({
    jobId,
    result,
    bindings: { AUDIO_BUCKET: bucket },
  })
  assert.equal(
    stored.pendantSpeech.audioBase64,
    undefined,
    'raw PCM must not remain inline',
  )
  assert.ok(stored.pendantSpeech.audioRef, 'raw PCM must have an R2 reference')
  assert.match(stored.pendantSpeech.audioRef.key, /job_news\.pcm$/)
  assert.equal(stored.pendantSpeech.audioRef.contentType, 'audio/pcm')
  // The small opus is the preferred playback and stays inline.
  assert.ok(stored.pendantSpeech.compressedAudioBase64)
  // Text and execution markers survive untouched for the reaper/dashboard.
  assert.equal(stored.response, result.response)
  assert.equal(stored.phase, 'executed')

  let updated
  await assert.doesNotReject(async () => {
    updated = await store.updateJob(jobId, {
      status: 'plan_ready',
      result: stored,
      error: null,
      actions: [],
    })
  }, 'the slimmed row must fit D1')
  assert.equal(updated.status, 'plan_ready')
  assert.ok(bucket.objects.get(stored.pendantSpeech.audioRef.key))

  // Reaper: a non-parked auto-run is classified completed and announced.
  await store.recordRoutineRun(dispatchedRun(routine, jobId))
  const closed = await reapDispatchedRuns({
    store,
    now: NOW + 60_000,
    logger: silentLogger,
  })
  assert.equal(closed.length, 1)
  assert.equal(closed[0].status, 'completed')
  assert.equal(closed[0].final, true)
  const announcement = [...store.announcements.values()][0]
  assert.ok(announcement, 'a completed routine reply is announced')
  assert.match(announcement.speech, /three short sentences/)

  // The pendant download path resolves the reply audio back out of R2.
  const buffers = await resolvePendantSpeechBuffers({
    speech: updated.result.pendantSpeech,
    bindings: { AUDIO_BUCKET: bucket },
  })
  assert.equal(buffers.pcm.length, pcm.length, 'PCM round-trips through R2')
  assert.ok(buffers.pcm.equals(pcm), 'the PCM bytes returned from R2 are identical')
})

test('with no R2 bucket, oversized audio is dropped so the row still stores and the run still classifies', async () => {
  const store = sizeLimitedStore({ limit: 1_000_000 })
  const routine = createRoutine({
    name: 'Morning news',
    command: 'Give me the top world and US news headlines.',
    schedule: { kind: 'daily', at: '07:00' },
    now: NOW,
  })
  await store.saveRoutine({ ...routine, nextRunAt: NOW + 86_400_000 })

  const jobId = 'job_news'
  await store.createJob({
    jobId,
    type: 'plan',
    status: 'processing',
    createdAt: new Date(NOW).toISOString(),
  })

  const { speech } = pendantSpeech({ pcmBytes: 9_000_000, opusBytes: 4096 })
  const result = {
    response: 'Top world and US news.',
    executed: true,
    phase: 'executed',
    pendantSpeech: speech,
  }

  // No AUDIO_BUCKET binding: the oversized PCM cannot go to R2, so it is
  // dropped rather than allowed to blow up the row.
  const stored = await offloadResultSpeechAudio({ jobId, result, bindings: {} })
  assert.equal(stored.pendantSpeech.audioBase64, undefined)
  assert.equal(stored.pendantSpeech.audioRef, undefined)
  assert.ok(stored.pendantSpeech.audioStorageWarning)

  let updated
  await assert.doesNotReject(async () => {
    updated = await store.updateJob(jobId, {
      status: 'plan_ready',
      result: stored,
      error: null,
      actions: [],
    })
  })
  assert.equal(updated.status, 'plan_ready')

  await store.recordRoutineRun(dispatchedRun(routine, jobId))
  const closed = await reapDispatchedRuns({
    store,
    now: NOW + 60_000,
    logger: silentLogger,
  })
  assert.equal(closed[0].status, 'completed')
})

test('a short voice reply is left inline and untouched (no R2 write)', async () => {
  const bucket = createFakeR2()
  // ~100 KB PCM -> ~133 KB base64, well under the inline budget.
  const { speech } = pendantSpeech({ pcmBytes: 100_000, opusBytes: 4096 })
  const slim = await offloadLargePendantSpeech({
    jobId: 'job_voice',
    speech,
    bindings: { AUDIO_BUCKET: bucket },
  })
  assert.equal(slim, speech, 'small speech is returned unchanged')
  assert.ok(slim.audioBase64, 'raw PCM stays inline for short replies')
  assert.equal(bucket.objects.size, 0, 'no R2 object is written for small audio')
})

test('offloadResultSpeechAudio is a no-op for results without speech', async () => {
  const result = { response: 'done', executed: true }
  const stored = await offloadResultSpeechAudio({
    jobId: 'job_x',
    result,
    bindings: {},
  })
  assert.equal(stored, result)
  assert.equal(await offloadResultSpeechAudio({ jobId: 'y', result: null }), null)
})
