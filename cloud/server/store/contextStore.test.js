import assert from 'node:assert/strict'
import test from 'node:test'

import { createD1Store } from './d1Store.js'
import { createMemoryStore } from './memoryStore.js'
import { packContext, verifyContextHandle } from '../../shared/contextHandoff.js'
import { createPlanJob, publicJob } from '../jobs.js'

/* Same shape as the other store tests: a fake D1 that only answers the queries
 * this feature issues, so a typo in the SQL or a mis-ordered bind is a test
 * failure rather than a production 500. */
function createFakeD1() {
  const rows = new Map()

  return {
    prepare(sql) {
      let values = []

      return {
        bind(...nextValues) {
          values = nextValues
          return this
        },

        async run() {
          if (sql.includes('INSERT INTO relay_contexts')) {
            const [handleId, secretHash, origin, createdAt, expiresAt, bytes, data] = values
            rows.set(handleId, {
              handle_id: handleId,
              secret_hash: secretHash,
              origin,
              created_at: createdAt,
              expires_at: expiresAt,
              bytes,
              data,
            })
            return { meta: { changes: 1 } }
          }

          if (sql.includes('DELETE FROM relay_contexts WHERE expires_at')) {
            let changes = 0
            for (const [handleId, row] of rows.entries()) {
              if (row.expires_at <= values[0]) {
                rows.delete(handleId)
                changes += 1
              }
            }
            return { meta: { changes } }
          }

          if (sql.includes('DELETE FROM relay_contexts WHERE handle_id')) {
            return { meta: { changes: rows.delete(values[0]) ? 1 : 0 } }
          }

          throw new Error(`Unexpected D1 test query: ${sql}`)
        },

        async first() {
          if (!sql.includes('FROM relay_contexts')) {
            throw new Error(`Unexpected D1 test query: ${sql}`)
          }
          const row = rows.get(values[0])
          // The read filters on the deadline as well as the sweep.
          return row && row.expires_at > values[1] ? row : null
        },
      }
    },
  }
}

function adapters() {
  return [
    ['memory', createMemoryStore()],
    ['d1', createD1Store(createFakeD1())],
  ]
}

for (const [name, store] of adapters()) {
  test(`${name}: a context round-trips by handle id`, async () => {
    const { handle, record } = packContext({
      items: [{ kind: 'message', role: 'user', text: 'open the quarterly notes' }],
      origin: 'cloud-relay/realtime',
    })

    await store.saveContext(record)
    const loaded = await store.getContext(record.handleId)

    assert.equal(loaded.handleId, record.handleId)
    assert.equal(verifyContextHandle(handle, loaded), true)
    assert.equal(loaded.items[0].text, 'open the quarterly notes')
  })

  test(`${name}: an expired context is gone on read, not merely marked`, async () => {
    const { record } = packContext({
      items: [{ kind: 'message', role: 'user', text: 'stale' }],
      origin: 'cloud-relay/realtime',
      ttlMs: -1,
    })

    await store.saveContext(record)

    assert.equal(await store.getContext(record.handleId), null)
  })

  test(`${name}: a context can be deleted before its deadline`, async () => {
    const { record } = packContext({
      items: [{ kind: 'message', role: 'user', text: 'forget this' }],
      origin: 'cloud-relay/realtime',
    })

    await store.saveContext(record)

    assert.equal(await store.deleteContext(record.handleId), true)
    assert.equal(await store.getContext(record.handleId), null)
  })
}

test('the handle rides on the job, and the context does not', () => {
  const job = createPlanJob({
    command: 'voice command',
    deviceId: 'pendant-1',
    sessionId: 'session-1',
    contextHandle: 'pcx_abcdefghijklmnop.0123456789012345678901234567890123456789012',
  })

  assert.equal(job.contextHandle.startsWith('pcx_'), true)
  // A handle is small enough that carrying it costs nothing; that is the point
  // of handing over a handle instead of pushing the context on every hop.
  assert.ok(JSON.stringify(job).length < 1024)
})

test('the handle does not leak through the job-status read API', () => {
  const job = createPlanJob({
    command: 'voice command',
    deviceId: 'pendant-1',
    sessionId: 'session-1',
    contextHandle: 'pcx_abcdefghijklmnop.0123456789012345678901234567890123456789012',
  })

  // mac:jobs:read is held by the pendant and the phone; the handle is a bearer
  // capability for whatever the owner said.
  assert.equal(publicJob(job).contextHandle, undefined)
  assert.equal(JSON.stringify(publicJob(job)).includes('pcx_'), false)
})

test('a job without a handle is the ordinary cold-start job it always was', () => {
  const job = createPlanJob({ command: 'hello', deviceId: 'pendant-1', sessionId: null })

  assert.equal(job.contextHandle, null)
})
