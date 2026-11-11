import assert from 'node:assert/strict'
import test from 'node:test'

import { isPublicPath, publicHealthPayload } from './httpPolicy.js'

test('public local health contains no operational or filesystem details', () => {
  assert.deepEqual(publicHealthPayload(), {
    ok: true,
    service: 'AI Pendant Mac Local Agent',
    version: '0.5.0',
    // A route name is not an operational detail; it is how a caller finds the
    // manifest instead of probing for it.
    capabilities: '/capabilities',
  })
  assert.equal(publicHealthPayload().permissions, undefined)
  assert.equal(publicHealthPayload().browserExtension, undefined)
  assert.equal(publicHealthPayload().contextGraphPath, undefined)
  assert.equal(publicHealthPayload().tokenConfigured, undefined)
})

test('detailed ops health remains behind agent authentication', () => {
  assert.equal(isPublicPath('/health'), true)
  assert.equal(isPublicPath('/ops/status'), false)
  assert.equal(isPublicPath('/ops/snapshot'), false)
})
