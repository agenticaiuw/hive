import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/*
 * HOW THE BRAIN LOOP WIRES THE MEMORY VERBS — asserted as source shape, the
 * same way popup-lifecycle.test.js asserts listener registration. The engine
 * imports the chrome runtime at module scope and its loop is not exported, so
 * behavior-testing it here would mean building a chrome+fetch+journal harness
 * this suite deliberately does not have. The POLICY is in brain.js and tested
 * there (descriptors, scope pinning, compaction, parsing, the pinned
 * grounding); these assertions keep console-engine holding the ends together:
 *
 *   1. every brain run is grounded from the hive BEFORE the first thought,
 *      and losing the relay costs the lines, never the run;
 *   2. a memory call goes to the relay INSIDE the loop, before the outward
 *      guard, journaled, step-counted;
 *   3. a clarify finishes the run as a question through the existing answer
 *      path — no new approval type.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const engine = fs.readFileSync(path.join(here, '..', 'src', 'console-engine.js'), 'utf8')

/* The loop body, so ordering assertions cannot be satisfied by an import. */
const loop = engine.slice(engine.indexOf('async function runBrainLocally'))
assert.ok(loop.length > 0, 'runBrainLocally must exist')

test('every brain run fetches domain memory first, and survives losing it', () => {
  /* The opening lookup rides the command's own words, bounded. */
  assert.match(loop, /memoryLookupRequest\(\{ query: command, limit: 10 \}\)/)
  /* ...and lands in the transcript as pinned grounding. */
  assert.match(loop, /createBrainTranscript\(\{ command, page, memoryLines \}\)/)

  /* The fetch sits in a try whose catch swallows: grounding is optional. */
  const fetchAt = loop.indexOf('memoryLookupRequest({ query: command')
  const guardBlock = loop.slice(0, loop.indexOf('createBrainTranscript'))
  assert.ok(guardBlock.includes('try {'), 'the opening lookup must be tried, not trusted')
  assert.match(guardBlock, /catch\s*\{/)
  assert.ok(fetchAt > 0)
})

test('a memory call runs against the relay before the guard, journaled, step-counted', () => {
  const localAt = loop.indexOf('if (turn.local)')
  const guardAt = loop.indexOf('guard.assess(turn.call)')
  assert.ok(localAt > 0, 'the loop must branch on the local flag parseBrainReply sets')
  assert.ok(guardAt > localAt, 'memory calls must never reach the outward guard')

  const branch = loop.slice(localAt, guardAt)
  /* Saves carry this device's relay identity as the author... */
  assert.match(branch, /memorySaveRequest\(relayConfig\.relayDeviceId, call\.params\)/)
  /* ...lookups carry the model's own params... */
  assert.match(branch, /memoryLookupRequest\(call\.params\)/)
  /* ...both are journaled so the run record shows the consult... */
  assert.match(branch, /journal\.recordStep\(id, \{\s*\n\s*tool: call\.type/)
  /* ...as a non-page effect the verdict cannot claim as an interaction... */
  assert.match(branch, /effect: EFFECT_READ/)
  /* ...the model sees the compact result, and a failure is information... */
  assert.match(branch, /compactMemoryResult\(call\.type, call\.params, payload\)/)
  assert.match(branch, /That step failed:/)
  /* ...and the turn spends a step like any other inference. */
  assert.match(branch, /steps \+= 1\s*\n\s*continue/)
})

test('a clarify finishes as the answer — a question, not a new approval type', () => {
  /* The clarify turn ends the loop through the answer channel. */
  assert.match(loop, /turn\.kind === 'clarify'/)
  assert.match(loop, /clarifyQuestion = turn\.question/)
  const clarifyAt = loop.indexOf("turn.kind === 'clarify'")
  const clarifyBlock = loop.slice(clarifyAt, clarifyAt + 400)
  assert.match(clarifyBlock, /answer = clarifyQuestion/)
  assert.match(clarifyBlock, /break/)

  /* The verdict reads as a question waiting on the owner: the headline IS the
   * question and the detail says where to answer it. */
  assert.match(loop, /verdict: 'needs-answer'/)
  assert.match(loop, /headline: clarifyQuestion/)
  assert.match(loop, /Needs your answer — reply in the console/)

  /* And no new pending/approval furniture was invented for it: the only
   * pending shapes the engine mints are the existing localStepPending cards. */
  const pendingKinds = engine.match(/localStepPending\(/g) ?? []
  assert.ok(pendingKinds.length >= 2, 'the existing pending card path must be untouched')
  assert.equal(engine.includes("kind: 'clarify-pending'"), false)
})
