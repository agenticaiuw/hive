import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import {
  estimateCostUsd,
  estimateTokens,
  readRoutingStats,
  recordRouting,
  resetRoutingStats,
} from './routingStats.js'

beforeEach(() => {
  resetRoutingStats()
  delete process.env.LLM_PRICE_USD_PER_MTOK
})

const plannerCall = () => ({
  model: 'gpt-5.6-luna',
  tier: 'planner',
  promptChars: 26_000,
  completionChars: 400,
})

test('a deterministic request records zero model calls and zero tokens', () => {
  const entry = recordRouting({
    command: 'set volume to 30',
    tier: 'deterministic',
    intent: 'set_volume',
    latencyMs: 12,
  })

  assert.equal(entry.llmCalls, 0)
  assert.equal(entry.promptTokens, 0)
  assert.equal(entry.completionTokens, 0)

  const stats = readRoutingStats()
  assert.equal(stats.tiers.deterministic.requests, 1)
  assert.equal(stats.tiers.deterministic.totalTokens, 0)
  assert.equal(stats.tiers.deterministic.avgLatencyMs, 12)
})

test('savings stay null until a planner request has been measured', () => {
  recordRouting({ tier: 'deterministic', latencyMs: 10 })
  const before = readRoutingStats()
  assert.equal(before.baseline.tokensPerRequest, null)
  assert.equal(before.saved.tokens, null)

  recordRouting({ tier: 'planner', latencyMs: 1800, usage: [plannerCall()] })
  const after = readRoutingStats()
  assert.equal(after.baseline.tokensPerRequest, estimateTokens(26_400))
  assert.equal(after.saved.tokens, estimateTokens(26_400))
  assert.equal(after.saved.latencyMs, 1790)
})

test('an escalated request pays for both calls and is kept out of the baseline', () => {
  recordRouting({ tier: 'planner', latencyMs: 1800, usage: [plannerCall()] })
  const clean = readRoutingStats().baseline.tokensPerRequest

  recordRouting({
    tier: 'planner',
    escalatedFrom: 'background',
    latencyMs: 4000,
    usage: [
      { model: 'gpt-4.1-mini', tier: 'background', promptChars: 6000, completionChars: 200 },
      plannerCall(),
    ],
  })

  const stats = readRoutingStats()
  assert.equal(stats.tiers.planner.requests, 2)
  assert.equal(stats.tiers.planner.llmCalls, 3)
  assert.equal(stats.tiers.planner.escalations, 1)
  // The baseline must not drift upward just because the router guessed wrong.
  assert.equal(stats.baseline.tokensPerRequest, clean)
  assert.equal(stats.baseline.samples, 1)
})

test('the cheap tier is credited only with what it actually avoided', () => {
  recordRouting({ tier: 'planner', latencyMs: 2000, usage: [plannerCall()] })
  recordRouting({
    tier: 'background',
    latencyMs: 900,
    usage: [
      { model: 'gpt-4.1-mini', tier: 'background', promptChars: 6000, completionChars: 200 },
    ],
  })

  const stats = readRoutingStats()
  const baselineTokens = stats.baseline.tokensPerRequest
  const backgroundTokens = stats.tiers.background.totalTokens
  assert.equal(stats.saved.tokens, baselineTokens - backgroundTokens)
  assert.equal(stats.saved.latencyMs, 1100)
  assert.equal(stats.saved.percentOfRequestsOffPlanner, 50)
})

test('dollars stay null unless a price table is configured', () => {
  assert.equal(estimateCostUsd({ model: 'gpt-5.6-luna', promptTokens: 1000 }), null)

  process.env.LLM_PRICE_USD_PER_MTOK = JSON.stringify({
    'gpt-5.6-luna': { in: 1.25, out: 10 },
  })
  assert.equal(
    estimateCostUsd({
      model: 'gpt-5.6-luna',
      promptTokens: 1_000_000,
      completionTokens: 100_000,
    }),
    2.25,
  )
  // A model missing from the table is unpriced, not free.
  assert.equal(estimateCostUsd({ model: 'gpt-4.1-mini', promptTokens: 1000 }), null)
})

test('the recent list is capped so a long-running agent cannot grow it forever', () => {
  for (let index = 0; index < 260; index += 1) {
    recordRouting({ command: `cmd ${index}`, tier: 'deterministic', latencyMs: 1 })
  }
  const stats = readRoutingStats()
  assert.equal(stats.tiers.deterministic.requests, 260)
  assert.equal(stats.recent.length, 50)
  assert.equal(stats.recent[0].command, 'cmd 259')
})
