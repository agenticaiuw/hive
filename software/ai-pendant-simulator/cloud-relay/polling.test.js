import assert from 'node:assert/strict'
import test from 'node:test'

import { bridgeClaimDelay } from './polling.js'

test('empty bridge claims use a fixed small yield, not exponential backoff', () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, attempt) => bridgeClaimDelay(attempt)),
    [25, 25, 25, 25, 25, 25, 25, 25],
  )
})

test('bridge claim delay can be fully disabled', () => {
  assert.equal(bridgeClaimDelay(20, { minimumMs: 0, maximumMs: 0 }), 0)
})

test('bridge claim delay uses minimum when set', () => {
  assert.equal(bridgeClaimDelay(3, { minimumMs: 10, maximumMs: 50 }), 10)
})
