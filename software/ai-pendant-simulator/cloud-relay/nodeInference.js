/*
 * POST /v1/infer — a node's brain, on the relay.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 *
 * Every model call the relay could make was locked to one pipeline. Voice went
 * through openaiRealtimeVoice.js behind `pendant:audio:upload`, which the phone
 * does not hold; /v1/ops/proxy is admin-scoped AND returns 503 when the Mac
 * bridge is offline. So a `mobile` credential's only route to a thought was
 * mac:plan / mac:execute, which queue a bridge job — dead the moment the lid
 * closes. A phone with a brain that only works while the Mac is awake is not a
 * node, it is a remote control. Same argument for the extension.
 *
 * ---------------------------------------------------------------------------
 * THE TWO PROPERTIES THAT MATTER
 *
 * 1. NO CLIENT NAMES A KEY, OR A MODEL IT MAY NOT USE. The upstream credential
 *    never leaves the relay, and the model is resolved from server config. A
 *    client MAY ask for a model, but only from an allow-list, and asking for
 *    anything else is a 400 rather than a silent substitution — a caller told
 *    "ok" while being served a different model has been lied to.
 *
 * 2. IT IS A BILLING SURFACE, so it is metered per device. This is the one
 *    route on the relay where a leaked token costs money rather than access,
 *    and the difference deserves a ceiling rather than a comment. The counter
 *    lives in the device's own BridgeHub Durable Object (POST /budget): per
 *    device, strongly consistent, and — unlike an in-process limiter — it
 *    survives the isolate churn a determined caller would otherwise walk
 *    through. Where there is no binding (local `npm run relay`), an in-process
 *    limiter stands in and says so in its report; local dev burns the
 *    developer's own key.
 *
 * v1 is non-streaming. A planner loop returning several hundred tokens will
 * feel slow on a phone, and streaming is the obvious follow-up — it needs a
 * transport decision (SSE over this route, or frames on the mesh socket) that
 * should be made once a real client has measured the wait rather than guessed.
 */
import {
  LLM_API_BASE_URL,
  LLM_API_KEY,
  LLM_MODEL,
} from './config.js'
import { getCloudflareBindings } from './cloudflareBindings.js'

/* Per-device ceiling. Deliberately generous enough that a planner loop never
 * notices and small enough that a leaked token cannot run up a bill unnoticed
 * overnight: 120/h is ~2,880 calls a day if a thief saturates it. */
export const INFER_RATE_LIMIT_PER_HOUR = Number(
  process.env.INFER_RATE_LIMIT_PER_HOUR || 120,
)
export const INFER_RATE_WINDOW_MS = 3_600_000

/* A phone brain's turn, not a document. Caps the bill per call and keeps the
 * request under the relay's tight body parser. */
export const MAX_INFER_MESSAGES = 40
export const MAX_INFER_CHARS = 24_000
export const MAX_INFER_OUTPUT_TOKENS = 2_048

/*
 * What a caller gets when it does NOT ask. Deliberately a quarter of the
 * ceiling — this is a billing surface and the common case is a short planner
 * answer — but the gap between this and MAX_INFER_OUTPUT_TOKENS has misled a
 * reader already ("clamped to 2048" reads as "2048 unless you ask for less"),
 * so it is named rather than buried in a parameter default. A caller that
 * wants the ceiling must ask for it, and one that runs out is told via
 * `truncated` instead of discovering it as malformed JSON.
 */
export const DEFAULT_INFER_OUTPUT_TOKENS = 512
const UPSTREAM_TIMEOUT_MS = 60_000

/**
 * Models a client may name. Defaults to exactly the configured one, so the
 * out-of-the-box behaviour is "the client cannot choose".
 */
export function allowedInferModels() {
  const configured = String(process.env.INFER_ALLOWED_MODELS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return configured.length ? configured : [LLM_MODEL]
}

/** Resolve the model for a request, or throw a message safe to return. */
export function resolveInferModel(requested) {
  const allowed = allowedInferModels()
  const asked = String(requested || '').trim()
  if (!asked) return allowed[0]
  if (allowed.includes(asked)) return asked
  const error = new Error(
    `Model "${asked}" is not available on this relay. Allowed: ${allowed.join(', ')}.`,
  )
  error.code = 'model_not_allowed'
  throw error
}

/**
 * Validate a messages array. Returns the normalized array or throws.
 *
 * Rejects rather than truncates: a prompt silently cut in half produces a
 * confident answer to a question nobody asked, which is worse than an error.
 */
export function normalizeInferMessages(input) {
  const messages = Array.isArray(input) ? input : []
  if (!messages.length) {
    const error = new Error('`messages` must be a non-empty array.')
    error.code = 'invalid_messages'
    throw error
  }
  if (messages.length > MAX_INFER_MESSAGES) {
    const error = new Error(
      `messages is ${messages.length} long; the ceiling is ${MAX_INFER_MESSAGES}.`,
    )
    error.code = 'invalid_messages'
    throw error
  }

  let totalChars = 0
  const normalized = messages.map((message) => {
    const role = String(message?.role || '').trim()
    if (!['system', 'user', 'assistant'].includes(role)) {
      const error = new Error(
        'Each message needs role "system", "user" or "assistant".',
      )
      error.code = 'invalid_messages'
      throw error
    }
    const content = String(message?.content ?? '')
    totalChars += content.length
    return { role, content }
  })

  if (totalChars > MAX_INFER_CHARS) {
    const error = new Error(
      `Prompt is ${totalChars} characters; the ceiling is ${MAX_INFER_CHARS}.`,
    )
    error.code = 'prompt_too_large'
    throw error
  }
  return normalized
}

/* Local-dev stand-in for the DO counter. Module scope on purpose: it is the
 * fallback for a single-process relay, and it is honest about being one. */
const inProcessBudget = new Map()

export function resetInProcessInferBudget() {
  inProcessBudget.clear()
}

/**
 * Charge one inference against a device's budget.
 *
 * `enforced: false` means no ceiling was actually applied by a durable
 * counter — the caller reports it rather than letting an unmetered relay look
 * metered.
 */
export async function chargeInferBudget({
  deviceId,
  limit = INFER_RATE_LIMIT_PER_HOUR,
  windowMs = INFER_RATE_WINDOW_MS,
  now = Date.now(),
} = {}) {
  const binding = getCloudflareBindings()?.BRIDGE_HUB
  if (binding?.idFromName && deviceId) {
    try {
      const stub = binding.get(binding.idFromName(deviceId))
      const response = await stub.fetch('https://bridge-hub/budget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit, windowMs }),
        signal: AbortSignal.timeout(5_000),
      })
      const payload = await response.json().catch(() => ({}))
      return {
        allowed: Boolean(payload?.allowed),
        limit: Number(payload?.limit || limit),
        used: Number(payload?.used || 0),
        resetAt: payload?.resetAt ?? null,
        enforced: true,
      }
    } catch {
      /* A wedged hub must not become a free-inference bypass. Fall through to
       * the in-process counter, which is a weaker ceiling but still one. */
    }
  }

  const key = String(deviceId || 'anonymous')
  const current = inProcessBudget.get(key) || { windowStartedAt: 0, count: 0 }
  const expired = now - current.windowStartedAt >= windowMs
  const windowStartedAt = expired ? now : current.windowStartedAt
  const count = expired ? 0 : current.count
  const resetAt = new Date(windowStartedAt + windowMs).toISOString()

  if (count >= limit) {
    return { allowed: false, limit, used: count, resetAt, enforced: false }
  }
  inProcessBudget.set(key, { windowStartedAt, count: count + 1 })
  return { allowed: true, limit, used: count + 1, resetAt, enforced: false }
}

/**
 * One upstream call. Split out so the route is testable without a network:
 * `fetchImpl` is the seam every test uses.
 */
export async function runInference({
  model,
  messages,
  maxTokens = DEFAULT_INFER_OUTPUT_TOKENS,
  responseFormat = null,
  apiKey = LLM_API_KEY,
  baseUrl = LLM_API_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) {
    const error = new Error(
      'Inference is not configured on this relay (no model API key).',
    )
    error.code = 'not_configured'
    error.status = 503
    throw error
  }

  const body = {
    model,
    messages,
    max_completion_tokens: Math.min(
      Math.max(Number(maxTokens) || DEFAULT_INFER_OUTPUT_TOKENS, 1),
      MAX_INFER_OUTPUT_TOKENS,
    ),
  }
  if (responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' }
  }

  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })

  if (!response.ok) {
    /* The upstream body can quote the request, and the request can quote the
     * owner. Report the status, never the body. */
    const error = new Error(
      `The model provider refused the request (HTTP ${response.status}).`,
    )
    error.code = 'upstream_error'
    error.status = response.status === 429 ? 429 : 502
    throw error
  }

  const payload = await response.json()
  const choice = payload?.choices?.[0] ?? null
  const content = choice?.message?.content ?? ''
  const finishReason = choice?.finish_reason ?? null

  /*
   * Surface the cut-off, or a truncated answer arrives looking like a bad one.
   *
   * This was dropped on the floor until an extension client pointed out that
   * maxTokens DEFAULTS to 512 rather than to the 2048 ceiling — so a caller
   * that omits it gets a quarter of the budget it thinks it has. Combine that
   * with responseFormat:'json_object' and the failure is genuinely nasty: the
   * model stops mid-object, the JSON does not parse, and every layer downstream
   * reports a malformed model response. The one fact that explains it —
   * finish_reason:'length' — was sitting in the upstream payload and being
   * thrown away here.
   *
   * `truncated` is computed rather than left to each caller to derive, because
   * the whole point is that the callers hitting this are the ones who did not
   * know to look.
   */
  return {
    content: String(content),
    model: String(payload?.model || model),
    usage: payload?.usage ?? null,
    finishReason,
    truncated: finishReason === 'length',
  }
}

/**
 * Registered from server.js after the auth middleware. The `llm:infer` scope
 * gate is in relayScopes.js; what this adds is the metering and the model
 * allow-list, neither of which a scope can express.
 */
export function registerInferenceRoutes(app, { fetchImpl } = {}) {
  app.post('/v1/infer', async (request, response) => {
    const principal = request.relayPrincipal
    const deviceId =
      principal?.kind === 'device' ? principal.deviceId : 'admin'

    let model
    let messages
    try {
      model = resolveInferModel(request.body?.model)
      messages = normalizeInferMessages(request.body?.messages)
    } catch (error) {
      response.status(400).json({
        ok: false,
        code: error?.code || 'invalid_request',
        error: error.message,
      })
      return
    }

    /* Charged BEFORE the upstream call, so a caller cannot get free
     * inferences by hanging up mid-response. */
    const budget = await chargeInferBudget({ deviceId })
    if (!budget.allowed) {
      response.status(429).json({
        ok: false,
        code: 'rate_limited',
        error: `This device has used its inference budget (${budget.limit}/hour).`,
        resetAt: budget.resetAt,
      })
      return
    }

    try {
      const result = await runInference({
        model,
        messages,
        maxTokens: request.body?.maxTokens,
        responseFormat: request.body?.responseFormat ?? null,
        fetchImpl,
      })
      response.json({
        ok: true,
        content: result.content,
        model: result.model,
        usage: result.usage,
        /* A caller that omitted maxTokens got 512, not the 2048 ceiling. If it
         * ran out mid-answer, say so here rather than letting the client
         * diagnose its own unparseable JSON. */
        finishReason: result.finishReason,
        truncated: result.truncated,
        budget: {
          limit: budget.limit,
          used: budget.used,
          resetAt: budget.resetAt,
          /* False means the ceiling above is advisory: no durable counter was
           * available, so it resets with the process. */
          enforced: budget.enforced,
        },
      })
    } catch (error) {
      response.status(error?.status || 502).json({
        ok: false,
        code: error?.code || 'inference_failed',
        error: error?.message || 'Inference failed.',
      })
    }
  })
}
