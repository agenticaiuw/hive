import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeProductSync,
  normalizeProductSync,
  PRODUCT_SYNC_LIMITS,
  visibleProductSync,
} from './productSync.js'

function state({
  sourceDeviceId,
  sessionUpdatedAt = '2026-08-02T12:00:00.000Z',
  sessionDeletedAt = null,
  turns = [],
} = {}) {
  return {
    schemaVersion: 'product-sync.v1',
    accountId: 'single-owner',
    sourceDeviceId,
    generatedAt: sessionUpdatedAt,
    sessions: [
      {
        sessionId: 'session-1',
        title: `From ${sourceDeviceId}`,
        createdAt: '2026-08-02T11:00:00.000Z',
        updatedAt: sessionUpdatedAt,
        deletedAt: sessionDeletedAt,
        sourceDeviceId,
        turns,
      },
    ],
    memory: { entities: [], relations: [] },
  }
}

test('merges sessions and turns deterministically by stable IDs and versions', () => {
  const left = state({
    sourceDeviceId: 'mac',
    turns: [
      {
        id: 'turn-1',
        role: 'user',
        content: 'hello',
        createdAt: '2026-08-02T11:01:00.000Z',
        updatedAt: '2026-08-02T11:01:00.000Z',
        sourceDeviceId: 'mac',
      },
    ],
  })
  const right = state({
    sourceDeviceId: 'ios',
    sessionUpdatedAt: '2026-08-02T12:01:00.000Z',
    turns: [
      {
        id: 'turn-2',
        role: 'assistant',
        content: 'hi',
        createdAt: '2026-08-02T11:02:00.000Z',
        updatedAt: '2026-08-02T11:02:00.000Z',
        sourceDeviceId: 'ios',
      },
    ],
  })

  const forward = mergeProductSync(left, right)
  const reverse = mergeProductSync(right, left)
  assert.deepEqual(forward.sessions, reverse.sessions)
  assert.equal(forward.sessions[0].title, 'From ios')
  assert.deepEqual(
    forward.sessions[0].turns.map((turn) => turn.id),
    ['turn-1', 'turn-2'],
  )
})

test('a deletion tombstone wins an equal-time update and stays hidden', () => {
  const active = state({ sourceDeviceId: 'ios' })
  const deleted = state({
    sourceDeviceId: 'mac',
    sessionDeletedAt: '2026-08-02T12:00:00.000Z',
  })
  const merged = mergeProductSync(active, deleted)
  assert.equal(merged.sessions[0].deletedAt, '2026-08-02T12:00:00.000Z')
  assert.equal(visibleProductSync(merged).sessions.length, 0)
})

test('rejects oversized turn records before they reach D1', () => {
  assert.throws(
    () =>
      normalizeProductSync(
        state({
          sourceDeviceId: 'mac',
          turns: [
            {
              id: 'turn-large',
              role: 'user',
              content: 'x'.repeat(PRODUCT_SYNC_LIMITS.maxTurnBytes),
              createdAt: '2026-08-02T11:01:00.000Z',
              updatedAt: '2026-08-02T11:01:00.000Z',
            },
          ],
        }),
      ),
    /exceeds/,
  )
})

test('refuses to merge records across account boundaries', () => {
  const other = {
    ...state({ sourceDeviceId: 'ios' }),
    accountId: 'other-owner',
  }
  assert.throws(
    () => mergeProductSync(state({ sourceDeviceId: 'mac' }), other),
    /different accounts/,
  )
})
