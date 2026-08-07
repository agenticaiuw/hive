import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { deposit } from './commons.mjs'
import { MAX_IDLE_CYCLES, assess, markRan, schedule } from './eligibility.mjs'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eligibility-'))
}

test('an agent that has never run is eligible', () => {
  const dir = tempDir()
  const verdict = assess(dir, 'mac-planner', { cycle: 0 })
  assert.equal(verdict.eligible, true)
  assert.match(verdict.reason, /never run/)
})

/*
 * The whole point. An agent that has already seen everything in the store, and
 * has no mail, has no reason to think — and under the old shell loop it burned
 * a full round anyway.
 */
test('an agent with nothing new is not run', () => {
  const dir = tempDir()
  deposit(dir, { tool: 'discover', args: { category: 'routes' }, result: { items: [1] }, agent: 'a', round: 1 })
  markRan(dir, 'mac-planner', { cycle: 1 })

  const verdict = assess(dir, 'mac-planner', { cycle: 2 })
  assert.equal(verdict.eligible, false)
  assert.match(verdict.reason, /nothing new/)
})

test('a fact re-observed unchanged is not novelty', () => {
  const dir = tempDir()
  const args = { category: 'routes' }
  deposit(dir, { tool: 'discover', args, result: { items: [1] }, agent: 'a', round: 1 })
  markRan(dir, 'mac-planner', { cycle: 1 })

  deposit(dir, { tool: 'discover', args, result: { items: [1] }, agent: 'b', round: 2 })

  assert.equal(assess(dir, 'mac-planner', { cycle: 2 }).eligible, false)
})

test('a fact another agent contradicted wakes this one', () => {
  const dir = tempDir()
  const args = { category: 'devices' }
  deposit(dir, { tool: 'discover', args, result: { items: ['pendant'] }, agent: 'a', round: 1 })
  markRan(dir, 'mac-planner', { cycle: 1 })

  deposit(dir, { tool: 'discover', args, result: { items: ['pendant', 'bridge'] }, agent: 'b', round: 2 })

  const verdict = assess(dir, 'mac-planner', { cycle: 2 })
  assert.equal(verdict.eligible, true)
  assert.match(verdict.reason, /1 contradicted/)
})

test('a contradiction outranks a merely new fact', () => {
  const dir = tempDir()
  const devices = { category: 'devices' }

  /* The two agents must hold DIFFERENT beliefs for this to test anything —
   * matched watermarks give matched scores no matter how they are weighted. */
  deposit(dir, { tool: 'discover', args: devices, result: { items: ['a'] }, agent: 'x', round: 1 })
  markRan(dir, 'contradicted-agent', { cycle: 1 })

  deposit(dir, { tool: 'discover', args: devices, result: { items: ['b'] }, agent: 'x', round: 2 })
  markRan(dir, 'newfact-agent', { cycle: 1 })

  /* Now both are equally behind on one new key, and only one of them believed
   * something that has since been overturned. */
  deposit(dir, { tool: 'discover', args: { category: 'routes' }, result: { items: [1] }, agent: 'x', round: 3 })

  const { run, assessed } = schedule(dir, ['newfact-agent', 'contradicted-agent'], { cycle: 2, slots: 2 })
  assert.equal(run[0].agent, 'contradicted-agent')
  assert.match(assessed.find((row) => row.agent === 'contradicted-agent').reason, /1 contradicted/)
  assert.match(assessed.find((row) => row.agent === 'newfact-agent').reason, /^1 new$/)
})

test('unread mail is a reason to run on its own', () => {
  const dir = tempDir()
  deposit(dir, { tool: 'discover', args: { category: 'routes' }, result: { items: [1] }, agent: 'a', round: 1 })
  markRan(dir, 'mac-vision', { cycle: 1 })

  assert.equal(assess(dir, 'mac-vision', { cycle: 2 }).eligible, false)
  const withMail = assess(dir, 'mac-vision', { cycle: 2, unreadMail: 1 })
  assert.equal(withMail.eligible, true)
  assert.match(withMail.reason, /1 unread/)
})

/*
 * Starvation floor. An agent whose corner of the system is quiet must not be
 * silenced permanently by a store that happens to be busy elsewhere — being
 * wrong about an agent's own irrelevance is expensive to discover late.
 */
test('a quiet agent is eventually run anyway', () => {
  const dir = tempDir()
  deposit(dir, { tool: 'discover', args: { category: 'routes' }, result: { items: [1] }, agent: 'a', round: 1 })
  markRan(dir, 'mac-vision', { cycle: 1 })

  assert.equal(assess(dir, 'mac-vision', { cycle: 1 + MAX_IDLE_CYCLES - 1 }).eligible, false)
  const floored = assess(dir, 'mac-vision', { cycle: 1 + MAX_IDLE_CYCLES })
  assert.equal(floored.eligible, true)
  assert.match(floored.reason, /idle/)
})

test("an agent's own reads do not make it eligible again", () => {
  const dir = tempDir()
  deposit(dir, { tool: 'discover', args: { category: 'routes' }, result: { items: [1] }, agent: 'mac-planner', round: 1 })
  markRan(dir, 'mac-planner', { cycle: 1 })

  assert.equal(assess(dir, 'mac-planner', { cycle: 2 }).eligible, false)
})

test('nothing eligible means nobody runs, which is an answer', () => {
  const dir = tempDir()
  deposit(dir, { tool: 'discover', args: { category: 'routes' }, result: { items: [1] }, agent: 'a', round: 1 })
  for (const agent of ['one', 'two', 'three']) markRan(dir, agent, { cycle: 1 })

  const { run, held } = schedule(dir, ['one', 'two', 'three'], { cycle: 2, slots: 3 })
  assert.equal(run.length, 0)
  assert.equal(held.length, 3)
})

test('slots cap how many run at once, and the rest keep their evidence', () => {
  const dir = tempDir()
  const { run, assessed } = schedule(dir, ['a', 'b', 'c', 'd'], { cycle: 0, slots: 2 })
  assert.equal(run.length, 2)
  assert.equal(assessed.filter((row) => row.eligible).length, 4, 'unrun agents stay eligible next cycle')
})

test('ties go to whoever has waited longest', () => {
  const dir = tempDir()
  markRan(dir, 'waited-longer', { cycle: 1 })
  markRan(dir, 'waited-less', { cycle: 5 })
  deposit(dir, { tool: 'discover', args: { category: 'routes' }, result: { items: [1] }, agent: 'x', round: 1 })

  const { run } = schedule(dir, ['waited-less', 'waited-longer'], { cycle: 6, slots: 1 })
  assert.equal(run[0].agent, 'waited-longer')
})

test('an expired entry stops counting as something to catch up on', () => {
  const dir = tempDir()
  const now = Date.UTC(2026, 7, 7, 6, 0, 0)

  /* Mark first, against an empty store: a watermark taken at a timestamp
   * earlier than a deposit still folds that deposit in (its age reads as
   * negative, which is not expiry), and would record the agent as having
   * already seen a fact that did not exist yet. */
  markRan(dir, 'late', { cycle: 1, now })
  deposit(dir, { tool: 'probe_http', args: { method: 'GET', path: '/gone' }, result: { status: 404 }, agent: 'a', round: 1, now })

  assert.equal(assess(dir, 'late', { cycle: 2, now }).eligible, true)

  const afterExpiry = now + 24 * 60 * 60 * 1000
  assert.equal(assess(dir, 'late', { cycle: 2, now: afterExpiry }).eligible, false)
})
