import assert from 'node:assert/strict'
import test from 'node:test'

import { createD1Store } from './d1Store.js'
import { createMemoryStore } from './memoryStore.js'

function expiredJob(jobId, type) {
  return {
    jobId,
    type,
    status: 'completed',
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
  }
}

test('memory queue cleanup retains durable audio-capture metadata', async () => {
  const store = createMemoryStore()
  await store.createJob(expiredJob('job_old_audio', 'audio_capture'))
  await store.createJob(expiredJob('job_old_plan', 'plan'))

  // Creating another job triggers cleanup of records older than JOB_TTL_MS.
  await store.createJob({
    jobId: 'job_current',
    type: 'plan',
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  assert.ok(await store.getJob('job_old_audio'))
  assert.equal(await store.getJob('job_old_plan'), null)
})

test('D1 queue cleanup explicitly excludes audio-capture metadata', async () => {
  const cleanupSql = []
  const db = {
    prepare(sql) {
      return {
        bind() {
          return this
        },
        async run() {
          if (sql.includes('DELETE FROM relay_jobs')) {
            cleanupSql.push(sql)
          }
          return { meta: { changes: 1 } }
        },
      }
    },
  }
  const store = createD1Store(db)

  await store.createJob(expiredJob('job_audio_metadata', 'audio_capture'))
  await store.createJob(expiredJob('job_audio_metadata_2', 'audio_capture'))

  assert.equal(cleanupSql.length, 1)
  assert.match(cleanupSql[0], /type\s*<>\s*'audio_capture'/)
})
