import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForMacResult } from './macResult.js'

test('polls through transient failures and pending results until execution', async () => {
  let time = 0
  let calls = 0
  const store = { getJob: async (id) => {
    assert.equal(id, 'job-1')
    calls++
    if (calls === 1) throw new Error('transient')
    if (calls === 2) return { status: 'running', result: { phase: 'pending' } }
    return { status: 'running', result: { phase: 'executed', response: 'x'.repeat(500), results: [{ output: 'ok' }] } }
  } }
  const result = await waitForMacResult(store, 'job-1', { now: () => time, sleep: async (ms) => { time += ms } })
  assert.equal(calls, 3)
  assert.equal(result.response.length, 400)
  assert.deepEqual(result.results, [{ output: 'ok' }])
})

test('returns null after nine seconds when no execution result arrives', async () => {
  let time = 0
  let calls = 0
  const result = await waitForMacResult({ getJob: async () => { calls++; return null } }, 'job-2', {
    now: () => time, sleep: async (ms) => { time += ms },
  })
  assert.equal(result, null)
  assert.equal(calls, 30)
  assert.equal(time, 9000)
})

test('accepts a completed job result and caps long action outputs', async () => {
  const result = await waitForMacResult({ getJob: async () => ({ status: 'completed', result: { results: [{ output: 'a'.repeat(500) }] } }) }, 'job-3')
  assert.equal(result.results[0].length, 401)
  assert.ok(result.results[0].endsWith('…'))
})
