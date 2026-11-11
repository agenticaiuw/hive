import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRateLimitedErrorReporter,
  createRetryBackoff,
} from './retryPolicy.js'

test('bridge retry backoff grows, caps, and resets', () => {
  const backoff = createRetryBackoff({
    baseMs: 250,
    maximumMs: 2000,
    jitterRatio: 0.2,
    random: () => 0.5,
  })

  assert.deepEqual(
    Array.from({ length: 6 }, () => backoff.nextDelay()),
    [250, 500, 1000, 2000, 2000, 2000],
  )
  backoff.reset()
  assert.equal(backoff.nextDelay(), 250)
})

test('bridge retry jitter never exceeds its configured cap', () => {
  const high = createRetryBackoff({
    baseMs: 1000,
    maximumMs: 1200,
    jitterRatio: 0.5,
    random: () => 1,
  })
  assert.equal(high.nextDelay(), 1200)
})

test('identical bridge errors are rate-limited and summarized', () => {
  let currentTime = 1000
  const warnings = []
  const report = createRateLimitedErrorReporter({
    intervalMs: 5000,
    now: () => currentTime,
    warn: (message) => warnings.push(message),
  })

  assert.equal(report('[bridge] Work loop error', new Error('relay 503')), true)
  currentTime += 100
  assert.equal(report('[bridge] Work loop error', new Error('relay 503')), false)
  currentTime += 100
  assert.equal(report('[bridge] Work loop error', new Error('relay 503')), false)
  currentTime += 5000
  assert.equal(report('[bridge] Work loop error', new Error('relay 503')), true)

  assert.deepEqual(warnings, [
    '[bridge] Work loop error: relay 503',
    '[bridge] Work loop error: relay 503 (2 identical errors suppressed)',
  ])
})
