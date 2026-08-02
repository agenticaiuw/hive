import assert from 'node:assert/strict'
import test from 'node:test'

import { createD1Store } from './d1Store.js'
import { createMemoryStore } from './memoryStore.js'

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
          if (!sql.includes('INSERT INTO relay_state')) {
            throw new Error(`Unexpected D1 test query: ${sql}`)
          }

          const [stateKey, updatedAt, updatedBy, data] = values
          const current = rows.get(stateKey)
          rows.set(stateKey, {
            state_key: stateKey,
            revision: Number(current?.revision || 0) + 1,
            updated_at: updatedAt,
            updated_by: updatedBy,
            data,
          })
          return { meta: { changes: 1 } }
        },

        async first() {
          if (!sql.includes('FROM relay_state')) {
            throw new Error(`Unexpected D1 test query: ${sql}`)
          }

          return rows.get(values[0]) ?? null
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
  test(`${name} state store returns null for an unpublished key`, async () => {
    assert.equal(await store.getState(`missing-${name}`), null)
  })

  test(`${name} state store overwrites atomically and advances revision`, async () => {
    const stateKey = `agent-snapshot-${name}`
    const first = await store.saveState(
      stateKey,
      { sessions: [{ sessionId: 'session-1' }], jobs: [] },
      { updatedBy: 'home-mac' },
    )
    const second = await store.saveState(
      stateKey,
      { sessions: [{ sessionId: 'session-1' }], jobs: [{ jobId: 'job-1' }] },
      { updatedBy: 'home-mac' },
    )
    const stored = await store.getState(stateKey)

    assert.equal(first.revision, 1)
    assert.equal(second.revision, 2)
    assert.equal(stored.revision, 2)
    assert.equal(stored.updatedBy, 'home-mac')
    assert.deepEqual(stored.data, {
      sessions: [{ sessionId: 'session-1' }],
      jobs: [{ jobId: 'job-1' }],
    })
    assert.ok(!Number.isNaN(Date.parse(stored.updatedAt)))
  })

  test(`${name} state store isolates independently named documents`, async () => {
    const leftKey = `left-${name}`
    const rightKey = `right-${name}`
    await store.saveState(leftKey, { value: 'left' })
    await store.saveState(rightKey, { value: 'right' })

    assert.deepEqual((await store.getState(leftKey)).data, { value: 'left' })
    assert.deepEqual((await store.getState(rightKey)).data, { value: 'right' })
  })
}
