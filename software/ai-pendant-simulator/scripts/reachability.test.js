import assert from 'node:assert/strict'
import test from 'node:test'

import { checkReachability, knownPrimitives, normalize } from './reachability.mjs'

/* Shaped like a real commons entry: an inventory payload under `items`. */
const ENTRIES = [
  { key: 'discover:routes' },
  { key: 'discover:tools' },
]

const CONTENT = {
  'discover:routes': {
    items: [
      { name: 'GET /jobs' },
      { name: 'GET /jobs/:jobId' },
      { name: 'GET /jobs/:jobId/receipts' },
      { name: 'POST /jobs/:jobId/cancel' },
      { name: 'GET /health' },
    ],
  },
  'discover:tools': { items: [{ name: 'mac_run_actions' }, { name: 'browser_run_actions' }] },
}

const known = () => knownPrimitives(ENTRIES, (entry) => CONTENT[entry.key])

test('primitives are read from the payloads, not from a curated list', () => {
  const primitives = known()
  assert.ok(primitives.has('/jobs'))
  assert.ok(primitives.has('/jobs/:jobid/receipts'))
  assert.ok(primitives.has('mac_run_actions'))
})

test('the method prefix is not part of the name', () => {
  assert.equal(normalize('GET /jobs/:jobId'), '/jobs/:jobid')
  assert.equal(normalize('  POST /v1/pendant/speak/  '), '/v1/pendant/speak')
})

/*
 * The case that motivated all of this: the most-restated proposal in the corpus,
 * asked eighteen times, every piece of which already ships.
 */
test('a proposal made entirely of existing pieces is reported as assembled', () => {
  const check = checkReachability(
    ['GET /jobs', 'GET /jobs/:jobId/receipts', 'POST /jobs/:jobId/cancel'],
    known(),
  )
  assert.equal(check.verdict, 'assembled')
  assert.equal(check.unseen.length, 0)
  assert.equal(check.claimed, 3)
})

test('a proposal needing something that does not exist names it as the real ask', () => {
  const check = checkReachability(['GET /jobs', '/v1/pendant/announce'], known())
  assert.equal(check.verdict, 'partly')
  assert.deepEqual(check.unseen, ['/v1/pendant/announce'])
})

/*
 * "unrecognised", never "novel". The commons holds what agents have observed,
 * and nobody has inventoried the relay's routes — so a shipped endpoint like
 * /v1/pendant/announce reads as absent here. Calling that novel would hand an
 * agent a confident falsehood, which is what the known-absent records in
 * commons.mjs exist to prevent.
 */
test('a proposal built on nothing the collective has seen is unrecognised, not novel', () => {
  const check = checkReachability(['/v1/telepathy', '/v1/time-travel'], known())
  assert.equal(check.verdict, 'unrecognised')
  assert.equal(check.found.length, 0)
})

test('the longest matching primitive wins, so distinct pieces stay distinct', () => {
  const check = checkReachability(['GET /jobs', 'GET /jobs/:jobId/receipts'], known())
  assert.deepEqual(check.found.sort(), ['/jobs', '/jobs/:jobid/receipts'])
})

/*
 * An agent writing /jobs/:id for a route recorded as /jobs/:jobId has identified
 * the right thing. Failing it there would teach vagueness rather than precision.
 */
test('a near-miss on a path parameter still counts as found', () => {
  assert.equal(checkReachability(['/jobs/:id'], known()).found.length, 1)
})

test('naming nothing is called out rather than passing quietly', () => {
  assert.equal(checkReachability([], known()).verdict, 'unnamed')
  assert.equal(checkReachability(undefined, known()).verdict, 'unnamed')
  /* Filler short enough to carry no reference is the same as naming nothing. */
  assert.equal(checkReachability(['n/a'], known()).verdict, 'unnamed')
})

test('several pieces crammed into one string are separated', () => {
  const check = checkReachability(['GET /jobs, GET /health'], known())
  assert.equal(check.claimed, 2)
  assert.equal(check.verdict, 'assembled')
})

test('an unreadable entry does not take the whole check down', () => {
  const primitives = knownPrimitives(
    [{ key: 'ok' }, { key: 'broken' }],
    (entry) => {
      if (entry.key === 'broken') throw new Error('content file missing')
      return { items: [{ name: 'GET /jobs' }] }
    },
  )
  assert.ok(primitives.has('/jobs'))
})
