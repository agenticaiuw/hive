import assert from 'node:assert/strict'
import test from 'node:test'

import { createD1Store } from './d1Store.js'
import { createMemoryStore } from './memoryStore.js'

function createFakeD1() {
  const tables = {
    sessions: new Map(),
    turns: new Map(),
    entities: new Map(),
    relations: new Map(),
  }
  let revision = 0

  function statement(sql) {
    let values = []
    return {
      bind(...nextValues) {
        values = nextValues
        return this
      },
      async run() {
        if (sql.includes('INSERT INTO product_sync_events')) {
          revision += 1
        } else if (sql.includes('INSERT INTO product_sessions')) {
          upsert(tables.sessions, `${values[0]}:${values[1]}`, values[8], {
            data: values[9],
          })
        } else if (sql.includes('INSERT INTO product_turns')) {
          upsert(
            tables.turns,
            `${values[0]}:${values[1]}:${values[2]}`,
            values[8],
            { session_id: values[1], data: values[9] },
          )
        } else if (sql.includes('INSERT INTO product_memory_entities')) {
          upsert(tables.entities, `${values[0]}:${values[1]}`, values[9], {
            data: values[10],
          })
        } else if (sql.includes('INSERT INTO product_memory_relations')) {
          upsert(tables.relations, `${values[0]}:${values[1]}`, values[10], {
            data: values[11],
          })
        }
        return { meta: { changes: 1 } }
      },
      async all() {
        const accountPrefix = `${values[0]}:`
        if (sql.includes('FROM product_sessions')) {
          return result(tables.sessions, accountPrefix)
        }
        if (sql.includes('FROM product_turns')) {
          return result(tables.turns, accountPrefix)
        }
        if (sql.includes('FROM product_memory_entities')) {
          return result(tables.entities, accountPrefix)
        }
        if (sql.includes('FROM product_memory_relations')) {
          return result(tables.relations, accountPrefix)
        }
        throw new Error(`Unexpected all query: ${sql}`)
      },
      async first() {
        if (sql.includes('MAX(revision)')) return { revision }
        throw new Error(`Unexpected first query: ${sql}`)
      },
    }
  }

  return {
    prepare: statement,
    async batch(statements) {
      for (const item of statements) await item.run()
    },
  }
}

function upsert(table, key, versionKey, row) {
  const current = table.get(key)
  if (!current || versionKey > current.versionKey) {
    table.set(key, { ...row, versionKey })
  }
}

function result(table, prefix) {
  return {
    results: [...table.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => row),
  }
}

function fixture(accountId, sourceDeviceId, updatedAt) {
  return {
    accountId,
    sourceDeviceId,
    generatedAt: updatedAt,
    sessions: [
      {
        sessionId: 'session-1',
        title: sourceDeviceId,
        createdAt: '2026-08-02T10:00:00.000Z',
        updatedAt,
        sourceDeviceId,
        turns: [
          {
            id: `turn-${sourceDeviceId}`,
            role: 'user',
            content: sourceDeviceId,
            createdAt: updatedAt,
            updatedAt,
            sourceDeviceId,
          },
        ],
      },
    ],
    memory: {
      entities: [
        {
          id: `entity-${sourceDeviceId}`,
          type: 'Note',
          name: sourceDeviceId,
          attributes: {},
          createdAt: updatedAt,
          updatedAt,
          sourceDeviceId,
        },
      ],
      relations: [],
    },
  }
}

for (const [name, createStore] of [
  ['memory', () => createMemoryStore()],
  ['d1', () => createD1Store(createFakeD1())],
]) {
  test(`${name} product store retains normalized sessions, turns, and memory`, async () => {
    const accountId = `owner-${name}-${crypto.randomUUID()}`
    const store = createStore()
    await store.mergeProductState(
      fixture(accountId, 'mac', '2026-08-02T12:00:00.000Z'),
    )
    const stored = await store.mergeProductState(
      fixture(accountId, 'ios', '2026-08-02T12:01:00.000Z'),
    )

    assert.equal(stored.schemaVersion, 'product-sync.v1')
    assert.equal(stored.revision, 2)
    assert.equal(stored.sessions[0].title, 'ios')
    assert.deepEqual(
      stored.sessions[0].turns.map((turn) => turn.id),
      ['turn-mac', 'turn-ios'],
    )
    assert.equal(stored.memory.entities.length, 2)
  })
}
