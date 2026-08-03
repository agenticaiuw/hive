import assert from 'node:assert/strict'
import test from 'node:test'

import { planCommand } from './planner.js'

test('rules planner never string-matches spoken commands', () => {
  const plan = planCommand('Open Finder')

  assert.equal(plan.status, 'unsupported')
  assert.deepEqual(plan.actions, [])
  assert.match(plan.error, /No string-matching|LLM planner|audio-native/i)
})

test('empty command is unsupported without inventing actions', () => {
  const plan = planCommand('')

  assert.equal(plan.status, 'unsupported')
  assert.deepEqual(plan.actions, [])
  assert.match(plan.error, /Empty/i)
})

test('greetings are not keyword-handled by the rules planner', () => {
  const plan = planCommand('Hi, my name is Evan.')

  assert.equal(plan.status, 'unsupported')
  assert.deepEqual(plan.actions, [])
})
