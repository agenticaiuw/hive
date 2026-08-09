/*
 * The phone's model transport — the one seam between the brain and the network.
 *
 * The phone must never hold a provider API key. A key shipped inside an app
 * bundle is a key published, and this is the most-stolen device in the fleet.
 * So the relay holds the key and the phone authenticates with its own scoped,
 * revocable `mobile` device token: revoke the token and the phone's ability to
 * spend model budget stops with it.
 *
 * THE CONTRACT (agreed with the relay owner, task #26):
 *
 *   POST /v1/infer            scope: llm:infer
 *   →  { model?, messages: [{role, content}], maxTokens?, responseFormat? }
 *   ←  { ok: true, content: "...", model: "...", usage?: {...} }
 *
 * Non-streaming. The model is resolved server-side from the relay's LLM_MODEL
 * unless the caller names one, so no client ever names a key and the owner can
 * change models fleet-wide without shipping an app build.
 *
 * WHY THIS IS ITS OWN MODULE. The relay owner may land this as a frame type on
 * the phone's WebSocket rather than an HTTP route. Everything above this file
 * calls `infer({ messages })` and awaits a string; swapping HTTP for a socket
 * is a change to createRelayInference and nothing else. The same seam is what
 * lets tests run the whole brain against a stub with no network at all.
 *
 * STATUS AT TIME OF WRITING: the route is built but NOT DEPLOYED — the live
 * relay still answers 403, because its scope table denies unlisted routes by
 * default and the Worker has not been redeployed. That is why unavailability is
 * a named, explained error rather than a generic failure: an owner staring at
 * "the phone can't think" deserves to be told which half is missing.
 *
 * FOUR THINGS THE ROUTE ENFORCES that this file exists to keep the loop inside.
 * They are refusals, never truncation — a prompt silently cut in half returns a
 * confident answer to a question nobody asked — so the caller has to fit, not
 * hope. mobileBrain.js does the fitting; the numbers live here so there is one
 * copy of them.
 */

export const DEFAULT_INFERENCE_PATH = '/v1/infer'

/*
 * The relay's caps, mirrored so the loop can stay under them. If these ever
 * disagree with cloud-relay/nodeInference.js the symptom is a 400 with a `code`
 * naming which one, which is why the error path below surfaces the code
 * verbatim instead of flattening it into a sentence.
 */
export const INFERENCE_LIMITS = Object.freeze({
  maxMessages: 40,
  maxPromptChars: 24000,
  maxTokens: 2048,
})

export class InferenceUnavailableError extends Error {
  constructor(
    message,
    { status = 0, path = DEFAULT_INFERENCE_PATH, code = null, staleCredential = false } = {},
  ) {
    super(message)
    this.name = 'InferenceUnavailableError'
    this.status = status
    this.path = path
    /* The relay's own code — `credential_predates_capability` or
     * `scope_denied` — so a caller keys on the field rather than matching
     * prose that will be reworded. */
    this.code = code
    /* True when re-pairing fixes it. The UI can offer the button. */
    this.staleCredential = staleCredential
  }
}

export class InferenceRateLimitedError extends Error {
  constructor(message, { resetAt = null, retryAfterSeconds = null } = {}) {
    super(message)
    this.name = 'InferenceRateLimitedError'
    /* The relay counts per device in that device's Durable Object and answers
     * with when the window turns over. Back off to THAT, not to a fixed delay:
     * a retry loop against a per-device budget just spends the next window. */
    this.resetAt = resetAt
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/* A 400 from the route is the loop's own fault — too many messages, too much
 * prompt, a model it may not ask for. Carrying `code` through is what lets a
 * caller fix the right thing instead of retrying the same request. */
export class InferenceRejectedError extends Error {
  constructor(message, { code = 'invalid_request' } = {}) {
    super(message)
    this.name = 'InferenceRejectedError'
    this.code = code
  }
}

/**
 * Build the phone's `infer` function.
 *
 * @param client   src/cloudClient.js — owns the paired credential and is the
 *                 only thing in the app that touches the token.
 * @param path     override for the relay's inference route.
 * @param model    optional model name; omit and the relay chooses.
 */
export function createRelayInference({
  client,
  path = DEFAULT_INFERENCE_PATH,
  model = null,
} = {}) {
  if (!client?.postJson) {
    throw new TypeError('createRelayInference needs a cloud client with postJson().')
  }

  return async function infer({
    messages,
    maxTokens = 1200,
    responseFormat = 'json_object',
    signal = null,
  } = {}) {
    if (!Array.isArray(messages) || !messages.length) {
      throw new TypeError('infer() needs a non-empty messages array.')
    }

    const { response, payload } = await client.postJson(path, {
      messages,
      maxTokens,
      ...(responseFormat ? { responseFormat } : {}),
      ...(model ? { model } : {}),
    }, { signal })

    /*
     * A 403 used to be a guess between two very different failures, and the
     * error text said so — "either the relay has no inference route yet, or
     * this phone's credential is missing the scope". The relay now names which
     * one (server.js:458, `credentialPredatesScopes`), so this stops guessing.
     *
     * The distinction is not cosmetic. Scopes are frozen into a credential when
     * it is created and NOTHING updates them, so the hour after a deploy that
     * widens a role, every already-paired node fails this way at once — and the
     * generic message points the owner at the new feature instead of at the
     * stale token. One is "re-pair, it takes a click"; the other is "this role
     * genuinely may not do that".
     */
    if (response.status === 403 && payload?.code === 'credential_predates_capability') {
      throw new InferenceUnavailableError(
        `This phone's credential was issued before it was allowed to reach a model. Re-pair the phone — scopes are frozen into a credential when it is created, so a phone paired before the relay gained this capability never picks it up on its own. Relay said: ${payload.error}`,
        { status: 403, path, code: payload.code, staleCredential: true },
      )
    }

    if (response.status === 403 && payload?.code === 'scope_denied') {
      throw new InferenceUnavailableError(
        "This phone is not allowed to reach a model: its role does not carry the llm:infer scope. Re-pairing will not help — the role itself has to grant it.",
        { status: 403, path, code: payload.code },
      )
    }

    if (response.status === 404 || response.status === 403) {
      /* No code: an older relay build, so the honest answer is still both. */
      throw new InferenceUnavailableError(
        `This phone cannot reach a model: the relay answered ${response.status} for ${path}. Either the relay has no inference route deployed yet, or this phone's credential is missing the llm:infer scope — re-pair the phone from the Hive dashboard.`,
        { status: response.status, path, code: payload?.code ?? null },
      )
    }

    if (response.status === 401) {
      throw new InferenceUnavailableError(
        "This phone's relay credential was refused. It has probably been revoked — re-pair the phone to get a new one.",
        { status: 401, path },
      )
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers?.get?.('retry-after'))
      throw new InferenceRateLimitedError(
        payload?.error || 'This phone has hit its model rate limit on the relay.',
        {
          resetAt: payload?.resetAt ?? null,
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
        },
      )
    }

    if (response.status === 400) {
      throw new InferenceRejectedError(
        payload?.error || 'The relay refused this request.',
        { code: payload?.code || 'invalid_request' },
      )
    }

    if (!response.ok || payload?.ok === false) {
      /* 502 upstream_error deliberately carries no provider text — do not go
       * looking for it, and do not imply to the owner that we know more. */
      throw new Error(payload?.error || `Model call failed (${response.status}).`)
    }

    const content = String(payload?.content ?? '')
    if (!content.trim()) {
      throw new Error('The model returned an empty answer.')
    }

    return {
      content,
      model: payload?.model ?? null,
      usage: payload?.usage ?? null,
      /* `enforced: false` means no durable counter was reachable and the
       * ceiling is advisory. Passed through rather than smoothed over, so
       * nobody reads a number that is not a guarantee. */
      budget: payload?.budget ?? null,
    }
  }
}

/*
 * Pull the JSON object out of a model answer.
 *
 * Lifted in spirit from local-agent/llmPlanner.js: even with
 * response_format json_object, models fence blocks and add a sentence of
 * preamble often enough that a bare JSON.parse loses whole turns. Brace
 * matching beats a regex here because the object contains prose with braces in
 * it — quoted strings and escapes are tracked so a `{` inside a string does not
 * move the depth.
 */
export function extractJsonObject(raw) {
  const body = String(raw ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body)
  const candidate = (fenced ? fenced[1] : body).trim()

  const start = candidate.indexOf('{')
  if (start < 0) {
    throw new Error(`The model did not return JSON: ${candidate.slice(0, 160)}`)
  }

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index]

    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }

    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return candidate.slice(start, index + 1)
    }
  }

  throw new Error(`The model returned an unterminated JSON object: ${candidate.slice(0, 160)}`)
}

/** Parse a model answer into an object, or throw with the text that failed. */
export function parseModelJson(raw) {
  return JSON.parse(extractJsonObject(raw))
}
