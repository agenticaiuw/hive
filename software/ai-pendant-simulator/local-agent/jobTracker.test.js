import assert from 'node:assert/strict'
import test from 'node:test'
import { compactJobForStore } from './jobTracker.js'

const MAX_RESULT_BYTES = 64 * 1024

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

function bulkyArray(entryCount) {
  return Array.from({ length: entryCount }, (_, index) => ({
    index,
    text: 'x'.repeat(512),
  }))
}

test('a small result is stored exactly as it was returned', () => {
  const job = { jobId: 'a', result: { response: 'Opened Safari', ok: true } }

  assert.deepEqual(compactJobForStore(job), job)
})

test('a result over budget is shed down to the budget', () => {
  const job = {
    jobId: 'a',
    result: {
      response: 'done',
      logs: bulkyArray(400),
      contextGraph: { entities: bulkyArray(300) },
    },
  }

  const compacted = compactJobForStore(job)

  assert.ok(bytes(job.result) > MAX_RESULT_BYTES)
  assert.ok(bytes(compacted.result) <= MAX_RESULT_BYTES)
})

test('shedding starts with the largest field and stops once it fits', () => {
  const job = {
    jobId: 'a',
    result: {
      response: 'done',
      huge: bulkyArray(400),
      modest: bulkyArray(20),
    },
  }

  const compacted = compactJobForStore(job)

  assert.equal(compacted.result.huge.elided, 'array too large for the job store')
  // Once the largest field is gone the record fits, so nothing else is touched.
  assert.deepEqual(compacted.result.modest, job.result.modest)
  assert.equal(compacted.result.response, 'done')
})

test('a shed field records what it was and how big it was', () => {
  const logs = bulkyArray(400)
  const job = { jobId: 'a', result: { logs } }

  const compacted = compactJobForStore(job)

  assert.equal(compacted.result.logs.length, 400)
  assert.equal(compacted.result.logs.bytes, bytes(logs))
})

test('identifying scalars survive so a caller can still fetch the real value', () => {
  const job = {
    jobId: 'a',
    result: {
      thinking: {
        traceId: 'trace-42',
        status: 'done',
        steps: bulkyArray(400),
      },
    },
  }

  const compacted = compactJobForStore(job)

  assert.equal(compacted.result.thinking.traceId, 'trace-42')
  assert.equal(compacted.result.thinking.status, 'done')
  assert.deepEqual(compacted.result.thinking.elided, ['steps'])
})

test('an oversized string keeps a readable prefix', () => {
  const job = { jobId: 'a', result: { output: 'y'.repeat(200_000) } }

  const compacted = compactJobForStore(job)

  assert.equal(compacted.result.output.preview.length, 256)
  assert.equal(compacted.result.output.bytes, 200_002)
})

test('jobs without an object result are left alone', () => {
  for (const result of [null, undefined, 'text', ['a']]) {
    const job = { jobId: 'a', result }
    assert.deepEqual(compactJobForStore(job), job)
  }
})

test('shedding every field still leaves a record inside the budget', () => {
  const job = {
    jobId: 'a',
    result: {
      first: bulkyArray(300),
      second: bulkyArray(300),
      third: bulkyArray(300),
    },
  }

  const compacted = compactJobForStore(job)

  assert.ok(bytes(compacted.result) <= MAX_RESULT_BYTES)
  assert.equal(compacted.jobId, 'a')
})
