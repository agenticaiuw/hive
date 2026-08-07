import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ABSENT_TTL_MS,
  BASE_TTL_MS,
  commonsKey,
  deposit,
  directory,
  fold,
  lifetimeMs,
  looksAbsent,
  recall,
} from './commons.mjs'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commons-'))
}

test('the address of a fact comes from the question, not the asker', () => {
  const dir = tempDir()
  const args = { category: 'routes' }

  deposit(dir, { tool: 'discover', args, result: { items: [1, 2] }, agent: 'mac-planner', round: 3 })
  deposit(dir, { tool: 'discover', args, result: { items: [1, 2] }, agent: 'relay-realtime', round: 9 })

  const entries = fold(dir)
  assert.equal(entries.size, 1, 'two agents asking the same thing land on one entry')
  assert.deepEqual(entries.get('discover:routes').observers.sort(), ['mac-planner', 'relay-realtime'])
})

test('argument order does not change the address', () => {
  assert.equal(
    commonsKey('probe_http', { method: 'GET', path: '/health' }),
    commonsKey('probe_http', { path: '/health', method: 'GET' }),
  )
})

test('identical content from different agents is stored once', () => {
  const dir = tempDir()
  const result = { items: ['a', 'b'] }

  deposit(dir, { tool: 'discover', args: { category: 'devices' }, result, agent: 'one', round: 1 })
  deposit(dir, { tool: 'describe', args: { name: 'devices' }, result, agent: 'two', round: 1 })

  const files = fs.readdirSync(path.join(dir, 'commons-content'))
  assert.equal(files.length, 1, 'content-addressed on disk: one payload, two keys')
})

test('recall returns the payload and how old it is', () => {
  const dir = tempDir()
  const now = Date.UTC(2026, 7, 7, 6, 0, 0)
  deposit(dir, { tool: 'discover', args: { category: 'owner' }, result: { items: ['said'] }, agent: 'a', round: 1, now })

  const found = recall(dir, 'discover:owner', { now: now + 120_000 })
  assert.deepEqual(found.content, { items: ['said'] })
  assert.equal(found.ageSeconds, 120)
})

/*
 * The property the whole store rests on. If an agent re-derives what it read,
 * the derivation cost was paid anyway and the commons bought nothing — so the
 * directory has to be readable without spending a call, and that means it has
 * to stay small while the content does not.
 */
test('the directory stays small while the content does not', () => {
  const dir = tempDir()
  const fat = { items: Array.from({ length: 500 }, (_, i) => ({ i, blurb: 'x'.repeat(200) })) }

  for (let n = 0; n < 20; n += 1) {
    deposit(dir, { tool: 'discover', args: { category: `cat${n}` }, result: fat, agent: 'a', round: 1 })
  }

  const index = directory(dir)
  const bytes = Buffer.byteLength(index.lines.join('\n'))
  assert.equal(index.total, 20)
  assert.ok(bytes < 2_000, `directory should stay tiny, was ${bytes}B`)
  assert.ok(Buffer.byteLength(JSON.stringify(fat)) > 100_000, 'against genuinely large content')
})

test('the directory is capped so it cannot crowd out the prompt', () => {
  const dir = tempDir()
  for (let n = 0; n < 90; n += 1) {
    deposit(dir, { tool: 'discover', args: { category: `c${n}` }, result: { items: [n] }, agent: 'a', round: 1 })
  }
  const index = directory(dir, { limit: 60 })
  assert.equal(index.total, 90)
  assert.equal(index.lines.length, 60)
})

test('absence is recorded as a fact, and expires sooner than presence', () => {
  const dir = tempDir()
  const now = Date.UTC(2026, 7, 7, 6, 0, 0)

  deposit(dir, { tool: 'probe_http', args: { method: 'GET', path: '/nope' }, result: { status: 404 }, agent: 'a', round: 1, now })
  deposit(dir, { tool: 'probe_http', args: { method: 'GET', path: '/health' }, result: { status: 200, service: 'agent' }, agent: 'a', round: 1, now })

  const absent = fold(dir, { now }).get('probe_http:method=GET path=/nope')
  assert.equal(absent.absent, true)
  assert.match(absent.summary, /absent \(HTTP 404\)/)
  assert.ok(lifetimeMs(absent) < lifetimeMs(fold(dir, { now }).get('probe_http:method=GET path=/health')))

  /* Past the absent TTL, the negative claim is gone but the positive one stays:
   * a thing that was missing is the claim most likely to be overtaken. */
  const later = now + ABSENT_TTL_MS + 1000
  const surviving = [...fold(dir, { now: later }).keys()]
  assert.deepEqual(surviving, ['probe_http:method=GET path=/health'])
})

test('empty results count as absence without naming any particular payload shape', () => {
  assert.equal(looksAbsent({ items: [] }), true)
  assert.equal(looksAbsent([]), true)
  assert.equal(looksAbsent({}), true)
  assert.equal(looksAbsent(null), true)
  assert.equal(looksAbsent({ error: 'boom' }), true)
  assert.equal(looksAbsent({ status: 500 }), true)
  assert.equal(looksAbsent({ items: [1] }), false)
  assert.equal(looksAbsent({ status: 200 }), false)
})

test('a fact seen the same way twice outlives one seen once', () => {
  const dir = tempDir()
  const now = Date.UTC(2026, 7, 7, 6, 0, 0)
  const args = { category: 'hardware' }

  deposit(dir, { tool: 'discover', args, result: { items: ['ram'] }, agent: 'a', round: 1, now })
  const once = lifetimeMs(fold(dir, { now }).get('discover:hardware'))

  deposit(dir, { tool: 'discover', args, result: { items: ['ram'] }, agent: 'b', round: 1, now: now + 1000 })
  const twice = lifetimeMs(fold(dir, { now: now + 1000 }).get('discover:hardware'))

  assert.ok(twice > once, `confirmation should extend life: ${once} -> ${twice}`)
})

/*
 * The store learns volatility instead of being told it. Nothing here names a
 * category or an endpoint — a per-feature TTL table would be a guess about
 * which facts move, frozen at the moment it was written.
 */
test('a fact caught changing is trusted for less time', () => {
  const dir = tempDir()
  const now = Date.UTC(2026, 7, 7, 6, 0, 0)
  const args = { category: 'devices' }

  deposit(dir, { tool: 'discover', args, result: { items: ['pendant'] }, agent: 'a', round: 1, now })
  const stable = lifetimeMs(fold(dir, { now }).get('discover:devices'))

  deposit(dir, { tool: 'discover', args, result: { items: ['pendant', 'bridge'] }, agent: 'b', round: 2, now: now + 1000 })
  const churned = lifetimeMs(fold(dir, { now: now + 1000 }).get('discover:devices'))

  assert.ok(churned < stable, `contradiction should shorten life: ${stable} -> ${churned}`)
})

test('a fact that churned once and then settled is allowed to settle', () => {
  const dir = tempDir()
  const now = Date.UTC(2026, 7, 7, 6, 0, 0)
  const args = { category: 'devices' }

  deposit(dir, { tool: 'discover', args, result: { items: ['a'] }, agent: 'x', round: 1, now })
  deposit(dir, { tool: 'discover', args, result: { items: ['b'] }, agent: 'x', round: 2, now: now + 1000 })
  const afterChurn = lifetimeMs(fold(dir, { now: now + 1000 }).get('discover:devices'))

  for (const n of [2, 3, 4]) {
    deposit(dir, { tool: 'discover', args, result: { items: ['b'] }, agent: 'x', round: n, now: now + n * 1000 })
  }
  const afterSettling = lifetimeMs(fold(dir, { now: now + 5000 }).get('discover:devices'))

  assert.ok(
    afterSettling > afterChurn,
    `one change must not penalise a key forever: ${afterChurn} -> ${afterSettling}`,
  )
})

test('a torn line is skipped rather than poisoning the fold', () => {
  const dir = tempDir()
  deposit(dir, { tool: 'discover', args: { category: 'routes' }, result: { items: [1] }, agent: 'a', round: 1 })
  fs.appendFileSync(path.join(dir, 'commons.jsonl'), '{"key":"discover:half","tool":"disc\n')
  deposit(dir, { tool: 'discover', args: { category: 'tools' }, result: { items: [2] }, agent: 'a', round: 1 })

  assert.deepEqual([...fold(dir).keys()].sort(), ['discover:routes', 'discover:tools'])
})

test('an unwieldy argument gets a hashed address rather than a colliding one', () => {
  const long = 'x'.repeat(300)
  const a = commonsKey('describe', { name: `${long}A` })
  const b = commonsKey('describe', { name: `${long}B` })

  assert.notEqual(a, b)
  assert.ok(a.length <= 80 && b.length <= 80)
})

test('an entry outlives nothing once its whole lifetime has passed', () => {
  const dir = tempDir()
  const now = Date.UTC(2026, 7, 7, 6, 0, 0)
  deposit(dir, { tool: 'discover', args: { category: 'routes' }, result: { items: [1] }, agent: 'a', round: 1, now })

  assert.equal(fold(dir, { now: now + BASE_TTL_MS - 1000 }).size, 1)
  assert.equal(fold(dir, { now: now + BASE_TTL_MS + 1000 }).size, 0)
  assert.equal(recall(dir, 'discover:routes', { now: now + BASE_TTL_MS + 1000 }), null)
})
