import assert from 'node:assert/strict'
import test from 'node:test'

import { isSmallRequest } from './intentRouter.js'

test('small requests are recognised with their intent named', () => {
  assert.deepEqual(isSmallRequest('what time is it'), { small: true, intent: 'time' })
  assert.deepEqual(isSmallRequest('오늘 날씨 어때?'), { small: true, intent: 'weather' })
  assert.deepEqual(isSmallRequest('is it raining right now'), { small: true, intent: 'weather' })
  assert.deepEqual(isSmallRequest('translate hello to korean'), { small: true, intent: 'translate' })
  assert.deepEqual(isSmallRequest('set brightness to 50%'), { small: true, intent: 'brightness' })
  assert.deepEqual(isSmallRequest('mute the sound'), { small: true, intent: 'volume' })
  assert.deepEqual(isSmallRequest('remind me to call mom at 6'), { small: true, intent: 'reminder' })
})

test('media wording defeats weather words, and open-ended work is not small', () => {
  assert.equal(isSmallRequest('play rain sounds on spotify').small, false)
  assert.equal(isSmallRequest('set a timer for ten minutes').small, false)
  assert.deepEqual(isSmallRequest('research the best standing desk and write me a summary'), {
    small: false,
    intent: null,
  })
  assert.deepEqual(isSmallRequest(''), { small: false, intent: null })
  assert.deepEqual(isSmallRequest(null), { small: false, intent: null })
})
