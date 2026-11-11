import assert from 'node:assert/strict'
import test from 'node:test'

import { synchronizeProductState } from './productSyncClient.js'

function state(sourceDeviceId, updatedAt, turnId) {
  return {
    accountId: 'single-owner',
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
            id: turnId,
            role: 'user',
            content: sourceDeviceId,
            createdAt: updatedAt,
            updatedAt,
            sourceDeviceId,
          },
        ],
      },
    ],
    memory: { entities: [], relations: [] },
  }
}

test('startup synchronization pulls and applies D1 before publishing the merge', async () => {
  const order = []
  const applied = []
  const local = state('mac', '2026-08-02T12:01:00.000Z', 'turn-mac')
  const cloud = state('ios', '2026-08-02T12:00:00.000Z', 'turn-ios')

  const result = await synchronizeProductState({
    relayUrl: 'https://relay.example',
    authorization: 'Bearer test',
    accountId: 'single-owner',
    sourceDeviceId: 'mac',
    readLocalState() {
      order.push('read-local')
      return local
    },
    applyLocalState(value) {
      order.push('apply-local')
      applied.push(value)
    },
    async fetchImpl(_url, options = {}) {
      if (!options.method) {
        order.push('pull-cloud')
        return {
          ok: true,
          status: 200,
          async json() {
            return { state: cloud }
          },
        }
      }
      order.push('publish-merge')
      const body = JSON.parse(options.body)
      assert.deepEqual(
        body.state.sessions[0].turns.map((turn) => turn.id),
        ['turn-ios', 'turn-mac'],
      )
      return {
        ok: true,
        status: 200,
        async json() {
          return { state: body.state }
        },
      }
    },
  })

  assert.deepEqual(order, [
    'read-local',
    'pull-cloud',
    'apply-local',
    'publish-merge',
    'apply-local',
  ])
  assert.equal(applied.length, 2)
  assert.deepEqual(
    result.sessions[0].turns.map((turn) => turn.id),
    ['turn-ios', 'turn-mac'],
  )
})

test('does not publish again when D1 already contains the same records', async () => {
  const local = state('mac', '2026-08-02T12:01:00.000Z', 'turn-mac')
  let requestCount = 0
  const result = await synchronizeProductState({
    relayUrl: 'https://relay.example',
    authorization: 'Bearer test',
    accountId: 'single-owner',
    sourceDeviceId: 'mac',
    readLocalState() {
      return local
    },
    applyLocalState() {},
    async fetchImpl(_url, options = {}) {
      requestCount += 1
      assert.equal(options.method, undefined)
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            state: {
              ...local,
              sourceDeviceId: 'cloud-d1',
              revision: 4,
              generatedAt: '2026-08-02T12:02:00.000Z',
            },
          }
        },
      }
    },
  })

  assert.equal(requestCount, 1)
  assert.equal(result.revision, 4)
})
