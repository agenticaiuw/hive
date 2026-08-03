import assert from 'node:assert/strict'
import test from 'node:test'

import { bridgeClaimDelay } from './polling.js'

test('empty bridge claims back off quickly and stay bounded', () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, attempt) => bridgeClaimDelay(attempt)),
    [250, 400, 640, 1000, 1000, 1000, 1000, 1000],
  )
})

test('bridge claim delay normalizes unsafe configuration', () => {
  assert.equal(
    bridgeClaimDelay(20, { minimumMs: 1, maximumMs: 10 }),
    50,
  )
})
