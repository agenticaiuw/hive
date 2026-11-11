import assert from 'node:assert/strict'
import test from 'node:test'

import { parseByteRange, RANGE_UNSATISFIABLE } from './httpRange.js'

test('serves the whole recording when no range is requested', () => {
  assert.equal(parseByteRange(undefined, 1000), null)
  assert.equal(parseByteRange('', 1000), null)
  assert.equal(parseByteRange('bytes=-', 1000), null)
})

test('reads an explicit byte window', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseByteRange('bytes=100-199', 1000), { start: 100, end: 199 })
})

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseByteRange('bytes=900-', 1000), { start: 900, end: 999 })
})

test('a suffix range counts back from the end', () => {
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseByteRange('bytes=-5000', 1000), { start: 0, end: 999 })
})

test('clamps an end past the object instead of reading out of bounds', () => {
  assert.deepEqual(parseByteRange('bytes=990-5000', 1000), { start: 990, end: 999 })
})

test('reports an unsatisfiable range so the caller can answer 416', () => {
  assert.equal(parseByteRange('bytes=1000-1200', 1000), RANGE_UNSATISFIABLE)
  assert.equal(parseByteRange('bytes=500-100', 1000), RANGE_UNSATISFIABLE)
  assert.equal(parseByteRange('bytes=-0', 1000), RANGE_UNSATISFIABLE)
})

test('ignores multi-range and nonsense headers rather than guessing', () => {
  assert.equal(parseByteRange('bytes=0-99,200-299', 1000), null)
  assert.equal(parseByteRange('items=0-99', 1000), null)
  assert.equal(parseByteRange('bytes=abc-def', 1000), null)
})

test('an empty object can never produce a range', () => {
  assert.equal(parseByteRange('bytes=0-10', 0), null)
})
