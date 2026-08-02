import assert from 'node:assert/strict'
import test from 'node:test'

import { planCommand } from './planner.js'

test('answers a spoken name introduction without requiring an action', () => {
  const plan = planCommand('Hi, my name is Evan.')

  assert.equal(plan.status, 'instant')
  assert.equal(plan.requiresConfirmation, false)
  assert.equal(plan.response, 'Hi Evan, nice to meet you. How can I help?')
  assert.deepEqual(plan.actions, [])
})

test('keeps unmatched commands blocked when no LLM planner is configured', () => {
  const plan = planCommand('Do something unknown and unsafe')

  assert.equal(plan.status, 'unsupported')
  assert.match(plan.error, /No safe predefined action/)
})
