import { TIER_BACKGROUND, TIER_DETERMINISTIC, TIER_PLANNER } from './policyRouter.js'

/*
 * What each request actually cost, so the routing change is visible instead of
 * asserted.
 *
 * Deliberately in memory only. The whole point of the deterministic tier is
 * that it answers in single-digit milliseconds; making it pay for an atomic
 * JSON write on the way out would eat a measurable slice of the win it exists
 * to deliver. The numbers survive as long as the agent process does, which is
 * the window the owner is looking at them in anyway.
 *
 * Tokens, not dollars, are the honest unit here: the price of gpt-5.6-luna is
 * not something this file can know. Set LLM_PRICE_USD_PER_MTOK to a JSON map
 * like {"gpt-5.6-luna":{"in":1.25,"out":10}} and the dollar columns fill in;
 * leave it unset and they stay null rather than made up.
 */
const MAX_RECENT = 200

const recent = []
const totals = new Map()

/*
 * The planner baseline is what the cheap tiers are measured against, so it only
 * counts planner requests that went straight there. An escalated request pays
 * for two calls; folding those in would inflate the baseline and flatter the
 * router in exactly the case where it guessed wrong.
 */
const baseline = { requests: 0, tokens: 0, latencyMs: 0 }

function priceTable() {
  const raw = String(process.env.LLM_PRICE_USD_PER_MTOK || '').trim()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    console.warn('[routing] LLM_PRICE_USD_PER_MTOK is not valid JSON — costs stay unpriced.')
    return null
  }
}

/* ~4 characters per token is the standard English approximation. Every number
 * derived from it is labelled `estimated` wherever it surfaces, because the
 * streaming completions API this planner uses does not return a usage block. */
export function estimateTokens(chars) {
  return Math.ceil(Math.max(0, Number(chars) || 0) / 4)
}

export function estimateCostUsd({ model, promptTokens = 0, completionTokens = 0 }) {
  const table = priceTable()
  const price = table?.[model]
  if (!price) return null
  const input = (Number(price.in) || 0) * (promptTokens / 1_000_000)
  const output = (Number(price.out) || 0) * (completionTokens / 1_000_000)
  return Number((input + output).toFixed(6))
}

function blankTotals() {
  return {
    requests: 0,
    llmCalls: 0,
    latencyMsTotal: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    priced: false,
    escalations: 0,
  }
}

/**
 * Record one routed request. `usage` is a list because an escalated request
 * really did pay for two model calls, and hiding the first one would make the
 * cheap tier look better than it is.
 */
export function recordRouting({
  command = '',
  tier,
  reason = '',
  intent = null,
  latencyMs = 0,
  escalatedFrom = null,
  usage = [],
  ok = true,
}) {
  const calls = usage.map((call) => {
    const promptTokens = call.promptTokens ?? estimateTokens(call.promptChars)
    const completionTokens =
      call.completionTokens ?? estimateTokens(call.completionChars)
    return {
      model: call.model ?? null,
      tier: call.tier ?? tier,
      promptTokens,
      completionTokens,
      costUsd: estimateCostUsd({ model: call.model, promptTokens, completionTokens }),
    }
  })

  const entry = {
    at: new Date().toISOString(),
    command: String(command).slice(0, 160),
    tier,
    reason,
    intent,
    latencyMs: Math.round(latencyMs),
    ok,
    escalatedFrom,
    llmCalls: calls.length,
    promptTokens: calls.reduce((sum, call) => sum + call.promptTokens, 0),
    completionTokens: calls.reduce((sum, call) => sum + call.completionTokens, 0),
    costUsd: calls.some((call) => call.costUsd !== null)
      ? Number(calls.reduce((sum, call) => sum + (call.costUsd || 0), 0).toFixed(6))
      : null,
    calls,
  }

  recent.unshift(entry)
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT

  if (!totals.has(tier)) totals.set(tier, blankTotals())
  const bucket = totals.get(tier)
  bucket.requests += 1
  bucket.llmCalls += entry.llmCalls
  bucket.latencyMsTotal += entry.latencyMs
  bucket.promptTokens += entry.promptTokens
  bucket.completionTokens += entry.completionTokens
  if (entry.costUsd !== null) {
    bucket.costUsd += entry.costUsd
    bucket.priced = true
  }
  if (escalatedFrom) bucket.escalations += 1

  if (tier === TIER_PLANNER && !escalatedFrom) {
    baseline.requests += 1
    baseline.tokens += entry.promptTokens + entry.completionTokens
    baseline.latencyMs += entry.latencyMs
  }

  return entry
}

/**
 * Per-tier rollup plus the only number that answers "was this worth it": what
 * the cheap tiers would have cost had they gone through the full planner.
 *
 * The baseline is measured, not assumed — it is this process's own observed
 * average for the planner tier. Before any planner request has been seen there
 * is no honest baseline, so savings report null rather than a guess.
 */
export function readRoutingStats() {
  const tiers = {}
  for (const tier of [TIER_DETERMINISTIC, TIER_BACKGROUND, TIER_PLANNER]) {
    const bucket = totals.get(tier) ?? blankTotals()
    tiers[tier] = {
      requests: bucket.requests,
      llmCalls: bucket.llmCalls,
      avgLatencyMs: bucket.requests
        ? Math.round(bucket.latencyMsTotal / bucket.requests)
        : null,
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      totalTokens: bucket.promptTokens + bucket.completionTokens,
      avgTokensPerRequest: bucket.requests
        ? Math.round((bucket.promptTokens + bucket.completionTokens) / bucket.requests)
        : null,
      costUsd: bucket.priced ? Number(bucket.costUsd.toFixed(6)) : null,
      escalations: bucket.escalations,
    }
  }

  const planner = tiers[TIER_PLANNER]
  const plannerBaselineTokens = baseline.requests
    ? Math.round(baseline.tokens / baseline.requests)
    : null
  const plannerBaselineMs = baseline.requests
    ? Math.round(baseline.latencyMs / baseline.requests)
    : null
  const cheapRequests = tiers[TIER_DETERMINISTIC].requests + tiers[TIER_BACKGROUND].requests
  const cheapTokens =
    tiers[TIER_DETERMINISTIC].totalTokens + tiers[TIER_BACKGROUND].totalTokens
  const cheapLatencyMs =
    (tiers[TIER_DETERMINISTIC].avgLatencyMs ?? 0) * tiers[TIER_DETERMINISTIC].requests +
    (tiers[TIER_BACKGROUND].avgLatencyMs ?? 0) * tiers[TIER_BACKGROUND].requests

  const totalRequests = cheapRequests + planner.requests

  return {
    unit: 'estimated tokens (chars/4); the streaming API returns no usage block',
    priced: Boolean(priceTable()),
    totalRequests,
    tiers,
    baseline: {
      source: 'observed non-escalated planner-tier average in this process',
      tokensPerRequest: plannerBaselineTokens,
      latencyMs: plannerBaselineMs,
      samples: baseline.requests,
    },
    saved:
      plannerBaselineTokens === null || !cheapRequests
        ? { tokens: null, latencyMs: null, requests: cheapRequests }
        : {
            requests: cheapRequests,
            tokens: Math.max(0, plannerBaselineTokens * cheapRequests - cheapTokens),
            latencyMs: Math.max(
              0,
              Math.round(plannerBaselineMs * cheapRequests - cheapLatencyMs),
            ),
            percentOfRequestsOffPlanner: Math.round(
              (cheapRequests / Math.max(1, totalRequests)) * 100,
            ),
          },
    recent: recent.slice(0, 50),
  }
}

/** Test hook: the counters are module state, so tests must be able to zero them. */
export function resetRoutingStats() {
  recent.length = 0
  totals.clear()
  baseline.requests = 0
  baseline.tokens = 0
  baseline.latencyMs = 0
}
