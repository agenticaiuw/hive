import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import {
  D1_VALUE_MAX_BYTES,
  STORED_ROW_TARGET_BYTES,
  offloadLargePendantSpeech,
  offloadResultSpeechAudio,
  prepareResultForStorage,
  resolvePendantSpeechBuffers,
  serializedBytes,
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

test('a real short voice reply stays inline and writes nothing to R2', async () => {
  const bucket = createFakeR2()
  /*
   * What the hot voice path actually sends now that the bridge drops raw PCM
   * when a servable opus exists: ~10 s of 16 kbps opus, ~27 KB of base64.
   */
  const speech = {
    format: 's16le',
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    pcmBytes: 480_000,
    compressedFormat: 'ogg-opus',
    compressedAudioBase64: oggOpus(20_000).toString('base64'),
    rawPcmOmitted: true,
  }
  const slim = await offloadLargePendantSpeech({
    jobId: 'job_voice',
    speech,
    bindings: { AUDIO_BUCKET: bucket },
  })
  assert.equal(slim, speech, 'a small reply is returned unchanged')
  assert.ok(slim.compressedAudioBase64, 'its opus stays inline')
  assert.equal(bucket.objects.size, 0, 'no R2 object is written for small audio')
})

test('a reply still carrying six figures of raw PCM is offloaded, not inlined', async () => {
  const bucket = createFakeR2()
  /*
   * The no-opus fallback shape: ~100 KB of PCM is ~133 KB of base64. That is
   * small next to the old 700 KB guess but a sixth of everything D1 will accept
   * for the WHOLE row, so it belongs in R2 rather than in the value.
   */
  const { speech } = pendantSpeech({ pcmBytes: 100_000, opusBytes: 4096 })
  const slim = await offloadLargePendantSpeech({
    jobId: 'job_voice_pcm',
    speech,
    bindings: { AUDIO_BUCKET: bucket },
  })
  assert.notEqual(slim, speech)
  assert.equal(slim.audioBase64, undefined)
  assert.ok(slim.audioRef, 'the PCM is addressable in R2')
  assert.equal(bucket.objects.size, 1)
})

test('audio nested in an executed plan is stripped too, so the whole row fits', async () => {
  const bucket = createFakeR2()
  const store = sizeLimitedStore({ limit: 1_000_000 })
  const jobId = 'job_nested'
  await store.createJob({
    jobId,
    type: 'plan',
    status: 'processing',
    createdAt: new Date(NOW).toISOString(),
  })

  /*
   * The live shape (job_c26aee36): the served payload at the top level AND the
   * briefing's own full-length copy nested under execution.results[], which is
   * what overflowed D1 after only the top level had been offloaded.
   */
  const served = pendantSpeech({ pcmBytes: 4_000_000 }).speech
  const nested = pendantSpeech({ pcmBytes: 9_000_000 }).speech
  const result = {
    response: 'Your briefing is ready.',
    executed: true,
    pendantSpeech: served,
    execution: {
      ok: true,
      results: [
        { type: 'research_brief', ok: true, seconds: 390, pendantSpeech: nested },
      ],
    },
  }

  await assert.rejects(
    store.updateJob(jobId, { status: 'plan_ready', result }),
    /row too big/,
    'the nested copy alone must overflow the simulated D1 row',
  )

  const stored = await offloadResultSpeechAudio({
    jobId,
    result,
    bindings: { AUDIO_BUCKET: bucket },
  })

  // Served payload: offloaded to R2 and still downloadable.
  assert.equal(stored.pendantSpeech.audioBase64, undefined)
  assert.ok(stored.pendantSpeech.audioRef)
  // Nested duplicate: dropped, not given its own R2 object nothing would read.
  const nestedStored = stored.execution.results[0].pendantSpeech
  assert.equal(nestedStored.audioBase64, undefined)
  assert.equal(nestedStored.audioOmitted, true)
  // Descriptive metadata survives for the dashboard.
  assert.equal(nestedStored.format, 's16le')
  assert.equal(nestedStored.pcmBytes, 9_000_000)
  // Non-audio execution detail is untouched.
  assert.equal(stored.execution.results[0].seconds, 390)
  assert.equal(stored.response, 'Your briefing is ready.')

  await assert.doesNotReject(async () => {
    await store.updateJob(jobId, { status: 'plan_ready', result: stored })
  }, 'the fully slimmed row must fit D1')
})

/* ---------------------------------------------------------------------------
 * SQLITE_TOOBIG. D1 keeps the whole job in one JSON value, and SQLite's own
 * per-value ceiling (~1 MB) is far below the 32 MiB binding-RPC limit. Once the
 * bridge stopped shipping raw PCM, a ~1.5 MB opus track base64-encoded inside
 * that value still blew it -- and a brief carries markdown and source text in
 * the same row. The decision has to come from the measured serialized size.
 * ------------------------------------------------------------------------- */

test('an opus track that alone exceeds the D1 value limit is offloaded, and the run still completes', async () => {
  const bucket = createFakeR2()
  const store = sizeLimitedStore({ limit: D1_VALUE_MAX_BYTES })
  const routine = createRoutine({
    name: 'Morning news',
    command: 'Give me the top world and US news headlines.',
    schedule: { kind: 'daily', at: '07:00' },
    now: NOW,
  })
  await store.saveRoutine({ ...routine, nextRunAt: NOW + 86_400_000 })

  const jobId = 'job_toobig'
  const baseRow = {
    jobId,
    type: 'plan',
    status: 'processing',
    command: 'Give me the top world and US news headlines.',
    createdAt: new Date(NOW).toISOString(),
  }
  await store.createJob(baseRow)

  // No raw PCM (the bridge strips it now); the opus alone is ~2 MB of base64.
  const opus = oggOpus(1_500_000)
  const speech = {
    format: 's16le',
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
    pcmBytes: 18_000_000,
    compressedFormat: 'ogg-opus',
    compressedAudioBase64: opus.toString('base64'),
    rawPcmOmitted: true,
  }
  const result = {
    response: 'Here are the top headlines.',
    executed: true,
    phase: 'complete',
    pendantSpeech: speech,
    // A brief also carries prose in the same row.
    markdown: 'x'.repeat(200_000),
    sources: [{ title: 'Example', text: 'y'.repeat(200_000) }],
  }

  assert.ok(
    serializedBytes({ ...baseRow, result }) > D1_VALUE_MAX_BYTES,
    'the untouched row must exceed the D1 value limit',
  )
  await assert.rejects(
    store.updateJob(jobId, { status: 'plan_ready', result }),
    /row too big/,
  )

  const prepared = await prepareResultForStorage({
    jobId,
    baseRow,
    result,
    bindings: { AUDIO_BUCKET: bucket },
  })

  // Decided by measurement, and now genuinely under the ceiling.
  assert.ok(
    prepared.bytes <= STORED_ROW_TARGET_BYTES,
    `prepared row should fit the target, got ${prepared.bytes}`,
  )
  assert.ok(prepared.startedBytes > prepared.bytes)
  // The opus went to R2 and is still fetchable; nothing was silently lost.
  assert.equal(prepared.result.pendantSpeech.compressedAudioBase64, undefined)
  assert.ok(prepared.result.pendantSpeech.compressedAudioRef)
  assert.ok(bucket.objects.get(prepared.result.pendantSpeech.compressedAudioRef.key))
  assert.equal(prepared.result.response, 'Here are the top headlines.')

  let updated
  await assert.doesNotReject(async () => {
    updated = await store.updateJob(jobId, {
      status: 'plan_ready',
      result: prepared.result,
      error: null,
      actions: [],
    })
  }, 'the prepared row must store without throwing')

  // The audio round-trips back out of R2 for the pendant download.
  const buffers = await resolvePendantSpeechBuffers({
    speech: updated.result.pendantSpeech,
    bindings: { AUDIO_BUCKET: bucket },
  })
  assert.ok(buffers.opus.equals(opus), 'opus round-trips through R2')

  // And the reaper still closes the run as completed, with an announcement.
  await store.recordRoutineRun(dispatchedRun(routine, jobId))
  const closed = await reapDispatchedRuns({
    store,
    now: NOW + 60_000,
    logger: silentLogger,
  })
  assert.equal(closed[0].status, 'completed')
  assert.equal(closed[0].final, true)
  assert.match(
    [...store.announcements.values()][0].speech,
    /top headlines/,
  )
})

test('with R2 unavailable the audio is dropped explicitly and the row still stores', async () => {
  const store = sizeLimitedStore({ limit: D1_VALUE_MAX_BYTES })
  const jobId = 'job_no_r2'
  const baseRow = { jobId, type: 'plan', status: 'processing' }
  await store.createJob(baseRow)

  const result = {
    response: 'Here are the top headlines.',
    executed: true,
    pendantSpeech: {
      format: 's16le',
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      compressedFormat: 'ogg-opus',
      compressedAudioBase64: oggOpus(1_500_000).toString('base64'),
    },
  }

  // No AUDIO_BUCKET binding at all.
  const prepared = await prepareResultForStorage({
    jobId,
    baseRow,
    result,
    bindings: {},
  })

  assert.ok(prepared.bytes <= STORED_ROW_TARGET_BYTES)
  const speech = prepared.result.pendantSpeech
  assert.equal(speech.compressedAudioBase64, undefined)
  // Explicit about the loss rather than pretending there was never audio.
  assert.ok(
    speech.audioOmitted || speech.audioStorageWarning,
    'the drop must be recorded in the stored result',
  )
  // The spoken text -- the reason the row exists -- survives.
  assert.equal(prepared.result.response, 'Here are the top headlines.')

  await assert.doesNotReject(async () => {
    await store.updateJob(jobId, { status: 'plan_ready', result: prepared.result })
  })
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
