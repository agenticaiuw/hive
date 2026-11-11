import assert from 'node:assert/strict'
import test from 'node:test'

import { createD1Store } from './d1Store.js'
import { createMemoryStore } from './memoryStore.js'
import {
  compareJobsNewestFirst,
  jobIsBeforeCursor,
  jobMatchesSearch,
  likePatternForSearch,
  normalizeJobCursor,
  normalizeJobListLimit,
} from './jobQuery.js'

function recordingD1({ rows = [] } = {}) {
  const calls = []
  const db = {
    prepare(sql) {
      const call = { sql, bindings: [] }
      return {
        bind(...bindings) {
          call.bindings = bindings
          return this
        },
        async all() {
          calls.push(call)
          return { results: rows }
        },
        async first() {
          calls.push(call)
          return rows[0] ?? null
        },
        async run() {
          calls.push(call)
          return { meta: { changes: 1 } }
        },
      }
    },
  }
  return { db, calls }
}

test('a cursor falls back to first-page semantics when it cannot be parsed', () => {
  assert.equal(normalizeJobCursor(null), null)
  assert.equal(normalizeJobCursor('garbage'), null)
  assert.equal(normalizeJobCursor({ createdAt: 'garbage' }), null)
  assert.deepEqual(normalizeJobCursor('2026-08-02T10:00:00.000Z'), {
    createdAt: '2026-08-02T10:00:00.000Z',
    jobId: '￿',
  })
})

test('keyset ordering breaks ties on job id so no run hides behind another', () => {
  const older = { jobId: 'job_a', createdAt: '2026-08-02T10:00:00.000Z' }
  const newer = { jobId: 'job_b', createdAt: '2026-08-02T10:00:00.000Z' }

  assert.ok(compareJobsNewestFirst(newer, older) < 0)
  const cursor = normalizeJobCursor({
    createdAt: '2026-08-02T10:00:00.000Z',
    jobId: 'job_b',
  })
  assert.equal(jobIsBeforeCursor(older, cursor), true)
  assert.equal(jobIsBeforeCursor(newer, cursor), false)
})

test('search covers the transcript and the spoken reply', () => {
  const job = {
    command: 'open Outlook',
    result: { response: 'Opened Microsoft Outlook' },
  }
  assert.equal(jobMatchesSearch(job, 'OUTLOOK'), true)
  assert.equal(jobMatchesSearch(job, 'microsoft'), true)
  assert.equal(jobMatchesSearch(job, 'safari'), false)
  assert.equal(jobMatchesSearch(job, ''), true)
})

test('LIKE wildcards typed by the owner are escaped, not honoured', () => {
  assert.equal(likePatternForSearch('100%'), '%100\\%%')
  assert.equal(likePatternForSearch('a_b'), '%a\\_b%')
  assert.equal(likePatternForSearch('c:\\x'), '%c:\\\\x%')
})

test('page size stays inside the store limit', () => {
  assert.equal(normalizeJobListLimit(undefined), 40)
  assert.equal(normalizeJobListLimit(0), 40)
  assert.equal(normalizeJobListLimit(7), 7)
  assert.equal(normalizeJobListLimit(9999), 100)
})

test('the in-memory store pages newest-first through a cursor', async () => {
  const store = createMemoryStore()
  const base = {
    type: 'plan',
    status: 'completed',
    command: 'open Outlook',
    updatedAt: new Date().toISOString(),
  }
  await store.createJob({ ...base, jobId: 'jq_c', createdAt: '2026-08-02T10:00:02.000Z' })
  await store.createJob({ ...base, jobId: 'jq_b', createdAt: '2026-08-02T10:00:01.000Z' })
  await store.createJob({ ...base, jobId: 'jq_a', createdAt: '2026-08-02T10:00:01.000Z' })

  const first = await store.listJobs({ type: 'plan', limit: 2 })
  assert.deepEqual(
    first.map((job) => job.jobId),
    ['jq_c', 'jq_b'],
  )

  const second = await store.listJobs({
    type: 'plan',
    limit: 2,
    before: { createdAt: ' 2026-08-02T10:00:01.000Z'.trim(), jobId: 'jq_b' },
  })
  assert.deepEqual(
    second.map((job) => job.jobId),
    ['jq_a'],
  )
})

test('the in-memory store filters by search text', async () => {
  const store = createMemoryStore()
  await store.createJob({
    jobId: 'jq_search_hit',
    type: 'plan',
    status: 'completed',
    command: 'draft an email to Dana',
    createdAt: '2026-08-02T09:00:00.000Z',
    updatedAt: new Date().toISOString(),
  })

  const hits = await store.listJobs({ type: 'plan', search: 'DANA' })
  assert.deepEqual(
    hits.map((job) => job.jobId),
    ['jq_search_hit'],
  )
  assert.equal((await store.listJobs({ type: 'plan', search: 'zzz' })).length, 0)
})

test('the in-memory store deletes a job on request', async () => {
  const store = createMemoryStore()
  await store.createJob({
    jobId: 'jq_delete_me',
    type: 'audio_capture',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  assert.equal(await store.deleteJob('jq_delete_me'), true)
  assert.equal(await store.getJob('jq_delete_me'), null)
  assert.equal(await store.deleteJob('jq_never_existed'), false)
})

test('D1 keeps the legacy list statement untouched when nothing new is asked for', async () => {
  const { db, calls } = recordingD1()
  await createD1Store(db).listJobs({ type: 'plan', limit: 12 })

  const [call] = calls
  assert.match(call.sql, /ORDER BY created_at DESC\s+LIMIT \?2/)
  assert.doesNotMatch(call.sql, /job_id DESC/)
  assert.doesNotMatch(call.sql, /json_extract/)
  assert.deepEqual(call.bindings, ['plan', 12])
})

test('D1 switches to a keyset window when a cursor is supplied', async () => {
  const { db, calls } = recordingD1()
  await createD1Store(db).listJobs({
    type: 'plan',
    limit: 5,
    before: { createdAt: '2026-08-02T10:00:01.000Z', jobId: 'job_b' },
  })

  const [call] = calls
  assert.match(call.sql, /ORDER BY created_at DESC, job_id DESC/)
  assert.match(call.sql, /created_at < \?2 OR \(created_at = \?3 AND job_id < \?4\)/)
  assert.deepEqual(call.bindings, [
    'plan',
    '2026-08-02T10:00:01.000Z',
    '2026-08-02T10:00:01.000Z',
    'job_b',
    5,
  ])
})

test('D1 searches the stored JSON with escaped LIKE patterns', async () => {
  const { db, calls } = recordingD1()
  await createD1Store(db).listJobs({ type: 'plan', limit: 5, search: '100%' })

  const [call] = calls
  assert.match(call.sql, /json_extract\(data, '\$\.command'\)/)
  assert.match(call.sql, /json_extract\(data, '\$\.transcript'\)/)
  assert.match(call.sql, /json_extract\(data, '\$\.result\.response'\)/)
  assert.match(call.sql, /ESCAPE '\\'/)
  assert.deepEqual(call.bindings, ['plan', '%100\\%%', '%100\\%%', '%100\\%%', 5])
})

test('D1 deletes a job by id and reports whether a row went away', async () => {
  const { db, calls } = recordingD1()
  const store = createD1Store(db)

  assert.equal(await store.deleteJob('job_capture_1'), true)
  const call = calls.at(-1)
  assert.match(call.sql, /DELETE FROM relay_jobs WHERE job_id = \?1/)
  assert.deepEqual(call.bindings, ['job_capture_1'])
})
