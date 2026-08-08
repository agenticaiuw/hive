import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateTokens, projectContext } from './contextProjection.js'

const NOW = Date.parse('2026-08-07T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

let counter = 0

function fact(overrides = {}) {
  counter += 1
  return {
    id: `fct_${counter}`,
    key: `obs.${counter}`,
    kind: 'observation',
    value: `fact ${counter}`,
    surfaces: [],
    source: { origin: 'local', at: new Date(NOW).toISOString() },
    confidence: 0.7,
    sensitivity: 'normal',
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    expiresAt: null,
    lastUsedAt: null,
    useCount: 0,
    ...overrides,
  }
}

test('the projection sends the task-relevant facts and leaves the rest in the store', () => {
  const facts = [
    fact({ key: 'preference.editor', kind: 'preference', value: 'VS Code' }),
    fact({ key: 'entity.david', kind: 'entity', value: 'David runs the SAIL GPU cluster' }),
    fact({ key: 'entity.laundry', kind: 'entity', value: 'The laundry room closes at 10pm' }),
    fact({ key: 'entity.bike', kind: 'entity', value: 'Bike tire pressure is 80 psi' }),
  ]

  const projected = projectContext({
    surface: 'voice',
    task: 'email David about the GPU cluster',
    facts,
    now: NOW,
  })

  assert.match(projected.text, /David runs the SAIL GPU cluster/)
  assert.doesNotMatch(projected.text, /laundry/)
  assert.doesNotMatch(projected.text, /psi/)
  assert.match(projected.text, /editor: VS Code/, 'stable preferences always ride along')
  assert.equal(projected.stats.considered, 4)
  assert.equal(projected.stats.included, 2)
})

test('the stable head is byte-identical across turns so the prompt prefix stays cacheable', () => {
  const facts = [
    fact({ key: 'preference.timezone', kind: 'preference', value: 'America/Chicago' }),
    fact({ key: 'permission.reminders', kind: 'permission', value: 'may create reminders unprompted' }),
    fact({ key: 'entity.david', kind: 'entity', value: 'David runs the SAIL GPU cluster' }),
    fact({ key: 'entity.laundry', kind: 'entity', value: 'The laundry room closes at 10pm' }),
  ]

  const first = projectContext({ task: 'email David', facts, now: NOW })
  const second = projectContext({ task: 'when does laundry close', facts, now: NOW })
  const head = (text) => text.split('## ').slice(0, 2).join('## ')

  assert.equal(head(first.text), head(second.text))
  assert.notEqual(first.text, second.text)
})

test('expired facts are never projected, whether or not pruning has run', () => {
  const facts = [
    fact({ value: 'yesterday the build was broken', expiresAt: new Date(NOW - DAY).toISOString() }),
    fact({ value: 'the build is green' }),
  ]

  const projected = projectContext({ task: 'is the build ok', facts, now: NOW })
  assert.doesNotMatch(projected.text, /broken/)
  assert.match(projected.text, /green/)
})

test('sensitivity selects what reaches the prompt without hiding it from the owner', () => {
  const facts = [
    fact({
      key: 'cred.relay',
      kind: 'preference',
      value: 'RELAY_API_KEY=sk-live-2f8a9b3c4d5e6f7a',
      sensitivity: 'secret',
    }),
    fact({ key: 'entity.david', kind: 'entity', value: 'david@stanford.edu', sensitivity: 'sensitive' }),
    fact({ key: 'entity.gpu', kind: 'entity', value: 'The GPU cluster is called SAIL' }),
  ]

  const outbound = projectContext({ task: 'what is the gpu cluster called', facts, now: NOW })
  assert.doesNotMatch(outbound.text, /sk-live/, 'a key never rides to a model provider by accident')
  // The separator the owner wrote is kept when the credential can be cut out of
  // the line precisely, so this matches `KEY=[withheld]` as well as `KEY: [withheld]`.
  assert.match(
    outbound.text,
    /RELAY_API_KEY[:=] ?\[withheld\]/,
    'but the model knows the fact exists',
  )
  assert.doesNotMatch(outbound.text, /stanford\.edu/, 'unrelated personal detail stays home')

  const asked = projectContext({ task: 'what is david stanford email', facts, now: NOW })
  assert.match(asked.text, /stanford\.edu/, 'the same detail rides when it is the subject')

  const owner = projectContext({ task: 'relay key', facts, now: NOW, revealSensitive: true })
  assert.match(owner.text, /sk-live/, 'the owner is never gated out of their own memory')
})

test('a secret spoken as a sentence does not ride to the model either', () => {
  /*
   * The test above only ever exercised the `KEY=value` shape, which is the one
   * shape maskSecretValue handled -- so a spoken secret ("my bike lock code is
   * 4829"), which is how a worn pendant actually receives one, went into the
   * prompt in full with "[withheld]" appended after it. This is the projection
   * that gets composed into a third-party prompt, so the marker was a claim the
   * text itself contradicted.
   */
  const facts = [
    fact({
      key: 'obs.lock',
      kind: 'observation',
      value: 'my bike lock code is 4829',
      sensitivity: 'secret',
    }),
    fact({
      key: 'pref.wifi',
      kind: 'preference',
      value: 'the guest wifi password is hunter2',
      sensitivity: 'secret',
    }),
  ]

  const outbound = projectContext({ task: 'what is my bike lock code', facts, now: NOW })

  assert.doesNotMatch(outbound.text, /4829/, 'a spoken code never rides to a model provider')
  assert.doesNotMatch(outbound.text, /hunter2/, 'nor does a spoken password')
  assert.match(outbound.text, /\[withheld\]/, 'the model still learns the fact exists')

  const owner = projectContext({
    task: 'what is my bike lock code',
    facts,
    now: NOW,
    revealSensitive: true,
  })
  assert.match(owner.text, /4829/, 'the owner is never gated out of their own memory')
})

test('browser findings stay out of conversational context until the task asks for them', () => {
  const web = fact({
    key: 'web.united.com.fare',
    value: 'ORD→MSN nonstop $148 on Aug 14',
    source: {
      origin: 'browser-job',
      url: 'https://www.united.com/x',
      host: 'united.com',
      jobId: 'job_42',
      at: new Date(NOW).toISOString(),
    },
  })
  const facts = [fact({ key: 'entity.david', kind: 'entity', value: 'David runs SAIL' }), web]

  assert.doesNotMatch(projectContext({ task: 'email David', facts, now: NOW }).text, /148/)

  const asked = projectContext({ task: 'what was that ORD MSN fare', facts, now: NOW })
  assert.match(
    asked.text,
    /- ORD→MSN nonstop \$148 on Aug 14 \[united\.com 08-07\]$/m,
    'claim plus source and date, never the page',
  )
})

test('the budget is enforced and reported rather than silently exceeded', () => {
  const facts = Array.from({ length: 40 }, (_, index) =>
    fact({ kind: 'entity', value: `David detail number ${index} about the GPU cluster` }),
  )

  const projected = projectContext({ task: 'David GPU cluster', facts, now: NOW, budgetTokens: 20 })
  assert.ok(projected.stats.estimatedTokens <= 20, projected.text)
  assert.ok(projected.stats.droppedForBudget > 0)
})

test('projection reports the facts it used so idle pruning can tell them apart', () => {
  const used = fact({ kind: 'entity', value: 'David runs the SAIL GPU cluster' })
  const unused = fact({ kind: 'entity', value: 'The laundry room closes at 10pm' })

  const projected = projectContext({ task: 'David GPU', facts: [used, unused], now: NOW })
  assert.deepEqual(projected.factIds, [used.id])
})

/*
 * The reason this change exists: the old path serialized the whole memory
 * block on every turn. The fixture below is the shape of a real store on this
 * machine (108 graph entities, mostly telemetry) and the assertion is the money
 * claim — measured for real by scripts/measure-context-projection.mjs.
 */
test('a realistic store projects to a fraction of what sending all of it costs', () => {
  const facts = [
    fact({ key: 'preference.editor', kind: 'preference', value: 'VS Code' }),
    fact({ key: 'preference.timezone', kind: 'preference', value: 'America/Chicago' }),
    ...Array.from({ length: 100 }, (_, index) =>
      fact({
        kind: index % 5 === 0 ? 'entity' : 'observation',
        value: `Action: copy_to_clipboard on 2026-08-0${(index % 7) + 1} — status success, command number ${index}`,
      }),
    ),
    fact({ kind: 'entity', value: 'David runs the SAIL GPU cluster' }),
  ]

  const everything = facts.map((item) => `- ${item.value}`).join('\n')
  const projected = projectContext({ task: 'email David about the GPU cluster', facts, now: NOW })

  const saved = 1 - projected.stats.estimatedTokens / estimateTokens(everything)
  assert.ok(saved > 0.9, `expected >90% smaller, got ${(saved * 100).toFixed(1)}%`)
  assert.match(projected.text, /David runs the SAIL GPU cluster/, 'still says the one thing that mattered')
})

test('knowing twenty times more does not cost more, and does not lose the point', () => {
  const needle = fact({ kind: 'entity', value: 'David runs the SAIL GPU cluster' })
  const small = [
    fact({ key: 'preference.editor', kind: 'preference', value: 'VS Code' }),
    ...Array.from({ length: 20 }, () => fact({ value: 'some unrelated thing that happened' })),
    needle,
  ]
  const large = [
    ...small,
    // A year of accumulation, including preferences, which are the section that
    // would grow without a cap.
    ...Array.from({ length: 200 }, (_, index) =>
      fact({ key: `preference.p${index}`, kind: 'preference', value: `setting ${index} is on` }),
    ),
    ...Array.from({ length: 800 }, () => fact({ value: 'another unrelated thing that happened' })),
  ]

  const before = projectContext({ task: 'email David about the GPU cluster', facts: small, now: NOW })
  const after = projectContext({ task: 'email David about the GPU cluster', facts: large, now: NOW })

  const storeGrowth = after.stats.considered / before.stats.considered
  const promptGrowth = after.stats.estimatedTokens / before.stats.estimatedTokens
  const detail =
    `store ×${storeGrowth.toFixed(1)} (${before.stats.considered}→${after.stats.considered} facts), ` +
    `prompt ×${promptGrowth.toFixed(1)} (${before.stats.estimatedTokens}→${after.stats.estimatedTokens} tokens)`

  assert.ok(storeGrowth > 20, detail)
  assert.ok(promptGrowth * 5 < storeGrowth, detail)
  assert.ok(after.stats.estimatedTokens <= after.stats.budgetTokens, detail)
  assert.match(after.text, /David runs the SAIL GPU cluster/, 'relevance survives the flood')
})
