import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { executeMemoryLookup, executeMemorySave } from './domainMemoryActions.js'
import { MEMORY_DOMAINS } from '../shared/domains/index.js'

function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-domain-actions-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return { filePath: path.join(directory, 'facts.json') }
}

test('save then lookup: the explicit tools round-trip through the store', (t) => {
  const at = store(t)

  const saved = executeMemorySave(
    { domain: 'email', name: 'account.school', value: 'liu@uni.edu' },
    at,
  )
  assert.equal(saved.ok, true)
  assert.equal(saved.key, 'dom.email.account.school')
  assert.equal(saved.scope, 'hive', 'deliberate saves default to every node')
  assert.match(saved.message, /bridge heartbeat/, 'the message says when it reaches the fleet')

  const found = executeMemoryLookup({ domain: 'email', query: 'school' }, at)
  assert.equal(found.ok, true)
  assert.equal(found.facts.length, 1)
  assert.equal(found.facts[0].value, 'liu@uni.edu')
  assert.deepEqual(found.lines, ['- email/account.school: liu@uni.edu'])
  assert.match(found.message, /liu@uni\.edu/)
})

test('node scope stays local and the message says so', (t) => {
  const at = store(t)
  const saved = executeMemorySave(
    { domain: 'browser', name: 'site.github', value: 'github.com', scope: 'node' },
    at,
  )
  assert.equal(saved.scope, 'node')
  assert.match(saved.message, /this Mac only/)
  assert.ok(!/heartbeat/.test(saved.message))
})

test('an unknown domain comes back with the real ones, not with nothing', (t) => {
  const at = store(t)
  const result = executeMemoryLookup({ domain: 'teleportation' }, at)
  assert.equal(result.ok, false)
  for (const domain of MEMORY_DOMAINS) {
    assert.ok(result.message.includes(domain), `${domain} missing from the correction`)
  }
})

test('an empty domain answers ok with an honest empty hand', (t) => {
  const at = store(t)
  const result = executeMemoryLookup({ domain: 'calendar' }, at)
  assert.equal(result.ok, true)
  assert.deepEqual(result.facts, [])
  assert.match(result.message, /Nothing remembered under calendar/)
})

test('validation failures are answers, not throws', (t) => {
  const at = store(t)

  const noValue = executeMemorySave({ domain: 'email', name: 'account.x', value: '' }, at)
  assert.equal(noValue.ok, false)
  assert.match(noValue.message, /value/)

  const badDomain = executeMemorySave({ domain: 'nope', name: 'a.b', value: 'c' }, at)
  assert.equal(badDomain.ok, false)
  assert.match(badDomain.message, /domain must be one of/)

  const badScope = executeMemorySave(
    { domain: 'email', name: 'account.x', value: 'x@y.z', scope: 'everywhere' },
    at,
  )
  assert.equal(badScope.ok, false)
  assert.match(badScope.message, /scope/)
})

test('secrets are masked in lookup lines', (t) => {
  const at = store(t)
  executeMemorySave(
    { domain: 'system', name: 'service.relay-key', value: 'RELAY_API_KEY=sk-live-2f8a9b3c4d5e6f7a8b9c' },
    at,
  )
  const found = executeMemoryLookup({ domain: 'system' }, at)
  assert.equal(found.ok, true)
  assert.ok(
    !found.lines.join('\n').includes('sk-live-2f8a9b3c4d5e6f7a8b9c'),
    'a secret value must never render in full for a model',
  )
})
