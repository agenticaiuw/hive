import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isProtocolOnlyText,
  stripProtocolTerminators,
} from './protocolText.js'

test('standalone provider terminators are removed without changing prose', () => {
  assert.equal(stripProtocolTerminators('[DONE]'), '')
  assert.equal(
    stripProtocolTerminators(
      ['[AGENT', 'RESPONSE', 'COMPLETE]'].join('_'),
    ),
    '',
  )
  assert.equal(
    stripProtocolTerminators('The operation is done.\n[DONE]'),
    'The operation is done.',
  )
  assert.equal(
    stripProtocolTerminators('The provider returned [DONE] in its docs.'),
    'The provider returned [DONE] in its docs.',
  )
  assert.equal(isProtocolOnlyText('<|eot_id|>'), true)
})
