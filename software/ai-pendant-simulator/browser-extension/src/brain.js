/*
 * The extension's own planning brain. INERT BY DEFAULT, deliberately.
 *
 * WHAT FLIPS IT ON — all three, in storage.local. The endpoint they point at
 * now exists (cloud-relay/nodeInference.js, POST /v1/infer); what does not
 * exist is a credential on this machine, and this module holds none: no API
 * key, no default URL, no fallback secret. normalizeBrainConfig refuses to
 * report `ready` unless all three are present and sane, and chooseBrainRoute
 * sends every command to the Mac planner until then.
 *
 *   brainEnabled:  true            (exactly true; anything else is off)
 *   modelProxyUrl: "<relay origin>/v1/infer"
 *   deviceToken:   "pdt_<id>.<secret>"   a browser_node credential, minted by
 *                                        the owner and pasted in by hand
 *
 * To mint one (prints the token exactly once — the relay keeps only a hash):
 *
 *   node scripts/pendant-credentials.mjs pair \
 *        --device-id <id> --role browser_node --name "<label>"
 *
 * MIGRATION, and the failure everyone will hit first: relay scopes are FROZEN
 * into a credential at pair time and no route updates them. `llm:infer` was
 * added to the existing browser_node role, so any extension credential minted
 * before that deploy is refused inference forever, with
 * 403 code:"credential_predates_capability" — which means RE-PAIR, not "the
 * endpoint is broken". A genuine role denial is code:"scope_denied" instead.
 * interpretInferError below keys on those codes rather than message text.
 *
 * The brain costs the owner money per call (metered per device, 120/hour), so
 * turning it on stays a deliberate act by the owner. Nothing here does it for
 * them.
 *
 * SHAPE OF THE LOOP once it is on:
 *
 *   command → buildBrainMessages(state) → callModel() → parseToolCalls()
 *          → run one of the extension's own 11 page commands as a tool
 *          → fold the result back into the state → around again,
 *   until the model answers, the step budget runs out, or two consecutive
 *   failures — and every non-answer exit is a HANDOFF: the original command
 *   goes to the Mac planner unchanged, so the brain can never be less capable
 *   than not having one.
 *
 * Everything except runBrainLoop is pure (no browser APIs, no fetch), so the
 * reducer and the parser are unit-tested in plain node. The impure edges —
 * calling the model, running a tool — are injected by background.js.
 */
import { COMMAND_TYPES } from './bridge-core.js'

export const BRAIN_STORAGE_KEYS = [
  'brainEnabled',
  'modelProxyUrl',
  'deviceToken',
  /* Written by the extension, never by the owner: the instant before which
   * asking the relay again is certain to be wasted. See COOLDOWN below. */
  'brainRetryAfterAt',
]

export const BRAIN_DEFAULTS = Object.freeze({
  brainEnabled: false,
  modelProxyUrl: null,
  deviceToken: null,
})

export const BRAIN_MAX_STEPS = 6
const MAX_FAILURES = 2

/*
 * The relay's own ceilings, mirrored — cloud-relay/nodeInference.js, read
 * 2026-08-09. Duplicated rather than imported for the same reason
 * PRIVACY_RULES is duplicated in bridge-core.js: an extension cannot import a
 * relay module, and a limit that only exists on the far side is a round trip
 * and a confusing handoff instead of a prompt this side could have trimmed.
 * They will drift; the relay stays authoritative and refuses rather than
 * truncates, so drifting low is safe and drifting high costs one 400.
 */
export const INFER_LIMITS = Object.freeze({
  maxMessages: 40,
  maxPromptChars: 24_000,
  maxOutputTokens: 2_048,
  /* What the relay gives a caller that does not ask — a QUARTER of the
   * ceiling, not the ceiling. Mirrored here because the gap is the whole
   * reason this loop names its own budget instead of omitting the field. */
  defaultOutputTokens: 512,
})

/*
 * What this loop asks for, per turn. Above the relay's 512 default because a
 * tool call plus a short rationale does not reliably fit in 512, and below the
 * 2048 ceiling because /v1/infer is metered per device and most turns are one
 * small JSON object. escalateOutputTokens takes it the rest of the way only
 * when a reply actually comes back cut off.
 */
export const BRAIN_OUTPUT_TOKENS = 1_024

/**
 * The budget to retry a cut-off reply with, or null when there is no headroom
 * left to buy.
 *
 * A truncated reply in JSON mode is not a bad answer, it is half an answer:
 * the model stopped mid-object and the parse fails downstream looking like
 * garbage. One doubling is worth the second billed call because the handoff it
 * replaces costs a Mac planner call anyway; a second doubling is not, because
 * a reply that will not fit in the ceiling will not fit next time either.
 */
export function escalateOutputTokens(current) {
  const asked = Number(current) || INFER_LIMITS.defaultOutputTokens
  if (asked >= INFER_LIMITS.maxOutputTokens) return null
  return Math.min(asked * 2, INFER_LIMITS.maxOutputTokens)
}

const abnormalStop = (message, code) => {
  const error = new Error(message)
  error.code = code
  /* Fatal in every case here: none of these change on a retry of the same
   * prompt, and the Mac planner has neither a token ceiling nor this
   * provider's filter. */
  error.fatal = true
  return error
}

/**
 * Ask for a reply, and decide what an abnormal ending means.
 *
 * The policy lives here, away from the fetch, because it is the part with a
 * decision in it: when to pay again, and when paying again buys nothing.
 * `send(maxTokens)` is injected and resolves to the relay's
 * `{content, truncated, complete, refusal, finishReason}` — so every branch
 * below is exercised in tests without a relay, which matters because these are
 * the branches no client can reproduce on purpose.
 *
 * ONLY truncation is retried. A length stop is the one ending more room fixes;
 * a content filter or a refusal ends the same way however much budget it is
 * given, so retrying those just bills twice for one refusal.
 */
export async function callModelWithHeadroom(send, maxTokens = BRAIN_OUTPUT_TOKENS) {
  let asked = maxTokens

  /* Bounded by escalateOutputTokens returning null at the ceiling; the guard
   * is here so a future change to that function cannot spend money forever. */
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const reply = await send(asked)

    if (reply?.truncated) {
      const escalated = escalateOutputTokens(asked)
      if (!escalated) {
        throw abnormalStop(
          `The model's reply was cut off at the relay's ${INFER_LIMITS.maxOutputTokens}-token ceiling.`,
          'truncated',
        )
      }
      asked = escalated
      continue
    }

    /*
     * A declined request, said in the provider's own words. Checked before
     * `complete`, because a refusal is a CLEAN stop — finish_reason 'stop',
     * complete true — with the content field empty. Without this the loop
     * receives "" and reports the model as unusable, which blames the wrong
     * party and hides the one sentence explaining what happened.
     */
    const refusal = String(reply?.refusal ?? '').trim()
    if (refusal) {
      throw abnormalStop(`The model declined: ${refusal}`, 'refusal')
    }

    /*
     * Strictly false, never falsy. `complete` is a tri-state and null means
     * the provider sent no finish_reason at all — treating "we could not ask"
     * as "it failed" would reject every good answer from a provider that
     * omits the field, which is the same error as reading presence.observed
     * false as offline.
     */
    if (reply?.complete === false) {
      throw abnormalStop(
        `The model stopped abnormally (${reply?.finishReason || 'unknown reason'}), ` +
          'so its answer is not trustworthy.',
        'incomplete',
      )
    }

    return String(reply?.content ?? '')
  }

  throw abnormalStop(
    `The model's reply was cut off at the relay's ${INFER_LIMITS.maxOutputTokens}-token ceiling.`,
    'truncated',
  )
}

/* Conservative margin under maxPromptChars: the ceiling counts every message,
 * and being one character over costs a whole failed round trip. */
const PROMPT_CHAR_BUDGET = INFER_LIMITS.maxPromptChars - 1_000

/*
 * Errors there is no point retrying: a stale credential, a denied scope, an
 * unconfigured relay or a model outside the allow-list will answer exactly the
 * same way the second time. Two-strike retry exists for flaky transport, not
 * for a settled "no" — so these hand off to the Mac planner immediately.
 */
const FATAL_INFER_CODES = new Set([
  'credential_predates_capability',
  'scope_denied',
  'not_configured',
  'model_not_allowed',
  'invalid_messages',
  'prompt_too_large',
  'rate_limited',
])

/**
 * The brain's model endpoint is either the relay (https) or a local dev proxy
 * on loopback. Anything else — plain http to a LAN address, a file URL — is a
 * misconfiguration, not a brain.
 */
function validProxyUrl(value) {
  try {
    const url = new URL(String(value ?? ''))
    if (url.protocol === 'https:') return url.href
    if (
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost'].includes(url.hostname)
    ) {
      return url.href
    }
    return null
  } catch {
    return null
  }
}

/* ===================================================================== *
 * COOLDOWN: "fatal until an operator acts", encoded rather than described.
 *
 * Two failures are settled for now without being settled forever — a spent
 * hourly budget, and a relay with no model key. Handing off is right in the
 * moment either way, but marking the brain permanently dead over them would
 * be wrong, and picking a retry delay myself would be inventing a fact I have
 * no access to: only the relay knows when a budget window ends, and only an
 * operator knows when a key gets configured.
 *
 * So the relay says. `retryAfter` is a real deadline on a 429 (the window's
 * end, computed) and an honest floor on a 503 ("a human must act, and humans
 * do not act in seconds"). Both are recorded the same way here, because both
 * answer the only question this side has: how long is asking again certainly
 * wasted?
 * ===================================================================== */

/** The instant a `retryAfter` in seconds points at. Null when there isn't one. */
export function cooldownUntil(retryAfterSeconds, now = Date.now()) {
  const seconds = Number(retryAfterSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(now + seconds * 1_000).toISOString()
}

/** Milliseconds still to wait, or 0 when the window has passed or never was. */
export function cooldownRemainingMs(retryAfterAt, now = Date.now()) {
  const at = Date.parse(String(retryAfterAt ?? ''))
  if (!Number.isFinite(at)) return 0
  return Math.max(0, at - now)
}

export function normalizeBrainConfig(values = {}) {
  const brainEnabled = values.brainEnabled === true
  const modelProxyUrl = validProxyUrl(values.modelProxyUrl)
  const deviceToken = String(values.deviceToken ?? '').trim() || null
  const brainRetryAfterAt =
    String(values.brainRetryAfterAt ?? '').trim() || null

  let reason = ''
  if (!brainEnabled) {
    reason = 'The local brain is switched off (brainEnabled is not true).'
  } else if (!modelProxyUrl) {
    reason = 'No usable modelProxyUrl is configured — the relay-side model proxy has not been set up yet.'
  } else if (!deviceToken) {
    reason = 'No deviceToken is configured — scoped device tokens land with the relay proxy task.'
  }

  return {
    brainEnabled,
    modelProxyUrl,
    deviceToken,
    brainRetryAfterAt,
    /* `ready` stays a statement about CONFIGURATION only. A cooldown is a
     * fully configured brain that is temporarily pointless to ask, which is a
     * different thing and belongs to the router below — collapsing them would
     * make a spent budget indistinguishable from a missing credential. */
    ready: brainEnabled && Boolean(modelProxyUrl) && Boolean(deviceToken),
    reason,
  }
}

/**
 * Where a command should go. 'mac-planner' is the answer until the credential
 * task lands; the caller treats anything but 'local-brain' as the Mac path.
 */
export function chooseBrainRoute(config, now = Date.now()) {
  const normalized =
    config && 'ready' in config ? config : normalizeBrainConfig(config)

  if (!normalized.ready) {
    return { route: 'mac-planner', reason: normalized.reason }
  }

  /* Configured, but the relay already said when it is worth asking again. */
  const waitMs = cooldownRemainingMs(normalized.brainRetryAfterAt, now)
  if (waitMs > 0) {
    return {
      route: 'mac-planner',
      reason:
        `The relay asked not to be called again for ${Math.ceil(waitMs / 1_000)}s ` +
        `(until ${normalized.brainRetryAfterAt}).`,
      cooldownMs: waitMs,
    }
  }

  return { route: 'local-brain', reason: 'Brain configuration is complete.' }
}

/* ===================================================================== *
 * Tools: the extension's own 11 page commands, described for a model.
 * ===================================================================== */

export const BROWSER_TOOLS = Object.freeze([
  { name: 'navigate', description: 'Open an http(s) URL in a tab.', params: 'url, newTab?' },
  { name: 'click', description: 'Click an element.', params: 'selector | ref' },
  { name: 'type', description: 'Type text into a field.', params: 'selector | ref, text, submit?' },
  { name: 'read_page', description: 'Read page text/html/forms/landmarks.', params: 'mode?, selector?, maxChars?' },
  { name: 'snapshot', description: 'List interactive elements with refs.', params: 'maxElements?' },
  { name: 'wait_for', description: 'Wait until a selector or text appears.', params: 'selector | textContains, timeoutMs?' },
  { name: 'scroll', description: 'Scroll the page or to an element.', params: 'dx?, dy?, selector?, ref?' },
  { name: 'select', description: 'Choose an option in a <select>.', params: 'selector | ref, value | label' },
  { name: 'list_tabs', description: 'List open web tabs.', params: 'limit?' },
  { name: 'capture', description: 'Screenshot the visible tab.', params: '' },
  { name: 'press_key', description: 'Press a keyboard key.', params: 'key, selector?' },
])

/* The catalog must never drift from what the executor accepts. Checked at
 * module load, in tests and in every bundle, because both sides live in this
 * extension and there is no server to arbitrate. */
for (const tool of BROWSER_TOOLS) {
  if (!COMMAND_TYPES.has(tool.name)) {
    throw new Error(`brain tool ${tool.name} is not an executable command`)
  }
}
if (BROWSER_TOOLS.length !== COMMAND_TYPES.size) {
  throw new Error('brain tool catalog does not cover every executable command')
}

/* ===================================================================== *
 * Planning state: one plain object, advanced only by reduceBrain().
 * ===================================================================== */

export function createBrainState({
  command,
  page = null,
  maxSteps = BRAIN_MAX_STEPS,
  now = Date.now(),
} = {}) {
  return {
    status: 'thinking', // thinking | acting | done | handoff
    command: String(command ?? ''),
    page,
    steps: [], // {tool, params, ok, result|error} in execution order
    stepCount: 0,
    maxSteps,
    failures: 0,
    pendingCall: null,
    response: null,
    handoffReason: null,
    startedAt: new Date(now).toISOString(),
  }
}

const TERMINAL = new Set(['done', 'handoff'])

/**
 * The reducer. Every transition the loop can make is here, pure, so the whole
 * lifecycle is testable without a model, a browser, or a network.
 *
 * Events:
 *   {type:'model_reply', text}          — while thinking
 *   {type:'model_error', error}         — while thinking
 *   {type:'tool_result', ok, result?, error?} — while acting
 *   {type:'hand_off', reason}           — from anywhere
 */
export function reduceBrain(state, event) {
  if (!state || TERMINAL.has(state.status)) return state

  if (event?.type === 'hand_off') {
    return {
      ...state,
      status: 'handoff',
      pendingCall: null,
      handoffReason: event.reason || 'Handed off to the Mac planner.',
    }
  }

  if (state.status === 'thinking' && event?.type === 'model_reply') {
    const parsed = parseToolCalls(event.text)

    if (parsed.done) {
      return { ...state, status: 'done', response: parsed.response }
    }

    if (parsed.malformed || !parsed.calls.length) {
      const failures = state.failures + 1
      if (failures >= MAX_FAILURES) {
        return {
          ...state,
          failures,
          status: 'handoff',
          handoffReason: `The model reply was unusable twice (${parsed.reason || 'no tool call'}).`,
        }
      }
      return { ...state, failures }
    }

    const call = parsed.calls[0]
    if (!COMMAND_TYPES.has(call.type)) {
      const failures = state.failures + 1
      return failures >= MAX_FAILURES
        ? {
            ...state,
            failures,
            status: 'handoff',
            handoffReason: `The model asked for an unknown tool twice (${call.type}).`,
          }
        : { ...state, failures }
    }

    if (state.stepCount >= state.maxSteps) {
      return {
        ...state,
        status: 'handoff',
        handoffReason: `Step budget of ${state.maxSteps} spent without an answer.`,
      }
    }

    return { ...state, status: 'acting', pendingCall: call, failures: 0 }
  }

  if (state.status === 'thinking' && event?.type === 'model_error') {
    /* A settled "no" — stale credential, denied scope, spent budget — answers
     * identically next time, so retrying it just makes the owner wait for the
     * same refusal twice before the handoff they were always going to get. */
    if (event.fatal) {
      return {
        ...state,
        status: 'handoff',
        handoffReason: event.error,
      }
    }
    const failures = state.failures + 1
    return failures >= MAX_FAILURES
      ? {
          ...state,
          failures,
          status: 'handoff',
          handoffReason: `The model endpoint failed twice: ${event.error}`,
        }
      : { ...state, failures }
  }

  if (state.status === 'acting' && event?.type === 'tool_result') {
    const step = {
      tool: state.pendingCall?.type ?? 'unknown',
      params: state.pendingCall?.params ?? {},
      ok: event.ok === true,
      ...(event.ok === true
        ? { result: event.result ?? null }
        : { error: String(event.error ?? 'Tool failed.') }),
    }
    const next = {
      ...state,
      steps: [...state.steps, step],
      stepCount: state.stepCount + 1,
      pendingCall: null,
      failures: event.ok === true ? 0 : state.failures + 1,
      status: 'thinking',
    }
    if (next.failures >= MAX_FAILURES) {
      return {
        ...next,
        status: 'handoff',
        handoffReason: 'Tools failed twice in a row.',
      }
    }
    if (next.stepCount >= next.maxSteps) {
      /* The budget is checked again on the next model reply; reaching it with
       * a failed final step hands off immediately rather than burning a model
       * call on a lost cause. */
      return step.ok ? next : { ...next, status: 'handoff', handoffReason: 'Out of steps.' }
    }
    return next
  }

  return state
}

/* ===================================================================== *
 * Model I/O shapes, pure on both sides of the fetch.
 * ===================================================================== */

/**
 * The prompt is rebuilt from state every turn rather than kept as chat history
 * so the reducer stays the single source of truth.
 *
 * Bounded against the relay's prompt ceiling here rather than discovering it
 * as a 400: a `read_page` result is up to 50 kB on its own, so a few steps of
 * transcript can outgrow the whole budget. The system block and the owner's
 * command are never dropped — without either there is nothing to answer — and
 * the transcript keeps the MOST RECENT steps, which are the ones the next
 * decision turns on. Dropped steps are declared in the prompt rather than
 * silently omitted, so the model is never told a partial history is complete.
 */
export function buildBrainMessages(state) {
  const tools = BROWSER_TOOLS.map(
    (tool) => `- ${tool.name}(${tool.params}): ${tool.description}`,
  ).join('\n')

  const lines = state.steps.map((step, index) => {
    const outcome = step.ok
      ? JSON.stringify(step.result)?.slice(0, 2_000)
      : `ERROR: ${step.error}`
    return `${index + 1}. ${step.tool}(${JSON.stringify(step.params)}) → ${outcome}`
  })

  const fixedChars = tools.length + String(state.command).length + 400
  let budget = Math.max(0, PROMPT_CHAR_BUDGET - fixedChars)
  const kept = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cost = lines[index].length + 1
    if (cost > budget) break
    budget -= cost
    kept.unshift(lines[index])
  }

  const dropped = lines.length - kept.length
  const transcript = kept.length
    ? (dropped ? `(${dropped} earlier step(s) omitted to fit the prompt limit)\n` : '') +
      kept.join('\n')
    : ''

  return [
    {
      role: 'system',
      content:
        'You are the planning brain of a browser extension. You may either ' +
        'answer the user directly or drive the page with one tool per turn.\n' +
        `Tools:\n${tools}\n` +
        'Reply with EXACTLY ONE JSON object and nothing else. Either\n' +
        '  {"tool": "<name>", "params": {…}}\n' +
        'or, when you are finished,\n' +
        '  {"done": true, "response": "<what to tell the user>"}\n' +
        (state.page
          ? `The user is looking at: "${state.page.title}" — ${state.page.url}\n`
          : '') +
        `You have ${Math.max(0, state.maxSteps - state.stepCount)} tool call(s) left.`,
    },
    { role: 'user', content: state.command },
    ...(transcript
      ? [{ role: 'user', content: `Tool results so far:\n${transcript}` }]
      : []),
  ]
}

/**
 * Read a model reply. Accepts a fenced ```json block or a bare JSON object;
 * plain prose with no JSON at all is taken as a final answer, because a model
 * that just answered the question should not be punished for skipping the
 * envelope. Returns {done, response, calls:[{type, params}], malformed, reason}.
 */
export function parseToolCalls(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { done: false, response: null, calls: [], malformed: true, reason: 'empty reply' }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : raw).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')

  if (start === -1) {
    /* No JSON anywhere: prose is a final answer. */
    return { done: true, response: raw, calls: [], malformed: false, reason: '' }
  }

  if (end <= start) {
    /* An opened envelope with no close is a cut-off reply, not an answer. */
    return {
      done: false,
      response: null,
      calls: [],
      malformed: true,
      reason: 'truncated JSON',
    }
  }

  let parsed
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch (error) {
    return {
      done: false,
      response: null,
      calls: [],
      malformed: true,
      reason: `unparseable JSON: ${error.message}`,
    }
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.done === true || (typeof parsed.response === 'string' && !parsed.tool)) {
      return {
        done: true,
        response: String(parsed.response ?? '').trim() || raw,
        calls: [],
        malformed: false,
        reason: '',
      }
    }

    const list = Array.isArray(parsed.tool_calls)
      ? parsed.tool_calls
      : Array.isArray(parsed.tools)
        ? parsed.tools
        : parsed.tool
          ? [parsed]
          : []

    const calls = list
      .map((item) => ({
        type: String(item?.tool ?? item?.name ?? item?.type ?? '').trim(),
        params:
          item?.params && typeof item.params === 'object' && !Array.isArray(item.params)
            ? item.params
            : {},
      }))
      .filter((item) => item.type)

    if (calls.length) {
      return { done: false, response: null, calls, malformed: false, reason: '' }
    }
  }

  return {
    done: false,
    response: null,
    calls: [],
    malformed: true,
    reason: 'JSON had neither a tool call nor a done response',
  }
}

/**
 * Read a failed POST /v1/infer. Pure, so every branch is testable without a
 * relay — which matters more than usual here, because the branch the owner
 * will actually hit first (a credential minted before `llm:infer` joined the
 * browser_node role) cannot be reproduced locally at all.
 *
 * Keys on `code`, never on message text: the relay's own comment says the
 * generic denial stays deliberately vague so a probing token gets no
 * scope-enumeration oracle out of it, and vague text is exactly what a text
 * match would break on.
 */
export function interpretInferError({ status, payload } = {}) {
  const code = String(payload?.code ?? '').trim() || 'unknown'
  const relayText = String(payload?.error ?? '').trim()

  const message =
    code === 'credential_predates_capability'
      ? 'The browser credential was issued before the relay gave this role the ' +
        'ability to think. Re-pair the extension (pendant-credentials.mjs pair ' +
        '--role browser_node) — scopes are frozen when a credential is created.'
      : code === 'scope_denied'
        ? 'This credential\'s role is not allowed to use the relay\'s inference route.'
        : code === 'rate_limited'
          ? `This device has spent its hourly inference budget${
              payload?.resetAt ? `; it resets at ${payload.resetAt}` : ''
            }.`
          : code === 'not_configured'
            ? 'The relay has no model key configured, so it cannot think for this node.'
            : code === 'prompt_too_large' || code === 'invalid_messages'
              ? relayText || 'The relay refused the prompt.'
              : code === 'upstream_error'
                ? `The model provider refused the request (HTTP ${status ?? '?'}).`
                : relayText || `The relay returned HTTP ${status ?? '?'}.`

  /*
   * Recorded whatever the code is. A 429 sends the budget window's real end
   * and a 503 sends a floor; both answer "how long is asking again certainly
   * wasted", which is the only question this side has. Keyed off the field
   * rather than off the two codes so a route that starts sending it for a
   * third reason is honoured without a change here.
   */
  const retryAfter = Number(payload?.retryAfter)
  const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null

  return {
    code,
    status: status ?? null,
    message,
    fatal: FATAL_INFER_CODES.has(code),
    retryAfter: seconds,
    retryAt: cooldownUntil(seconds),
  }
}

export function summarizeBrainRun(state) {
  if (state.status === 'done') {
    return `Brain answered after ${state.stepCount} tool call(s).`
  }
  if (state.status === 'handoff') {
    return `Brain handed off to the Mac planner: ${state.handoffReason}`
  }
  return `Brain is ${state.status} (${state.stepCount} tool call(s) so far).`
}

/* ===================================================================== *
 * The loop. Impure edges are injected; with config not ready it returns a
 * handoff before touching any of them, which is today's only behavior.
 * ===================================================================== */

/**
 * @param {object} options
 * @param {string} options.command      what the owner asked for
 * @param {object|null} options.page    {url, title} context, already scrubbed
 * @param {object} options.config      normalizeBrainConfig() output
 * @param {(messages: object[]) => Promise<string>} options.callModel
 *        POSTs to config.modelProxyUrl with the device token; resolves to the
 *        model's text reply. Injected by background.js — and never invoked
 *        unless config.ready, which today it never is.
 * @param {(call: {type, params}) => Promise<object>} options.runTool
 *        runs one of the 11 page commands through the extension's own
 *        validated executor and returns its sanitized result.
 */
export async function runBrainLoop({ command, page = null, config, callModel, runTool }) {
  const normalized =
    config && 'ready' in config ? config : normalizeBrainConfig(config)

  let state = createBrainState({ command, page })

  if (!normalized.ready) {
    return reduceBrain(state, { type: 'hand_off', reason: normalized.reason })
  }

  /* Hard iteration cap: even a pathological reducer bug cannot spin forever. */
  for (let turn = 0; turn < state.maxSteps * 2 + 2; turn += 1) {
    if (state.status === 'thinking') {
      try {
        const text = await callModel(buildBrainMessages(state))
        state = reduceBrain(state, { type: 'model_reply', text })
      } catch (error) {
        /* `fatal` is set by the caller's error (see brainCallModel in
         * background.js, which stamps it from interpretInferError). */
        state = reduceBrain(state, {
          type: 'model_error',
          error: error?.message || String(error),
          fatal: error?.fatal === true,
        })
      }
    } else if (state.status === 'acting') {
      try {
        const result = await runTool(state.pendingCall)
        state = reduceBrain(state, { type: 'tool_result', ok: true, result })
      } catch (error) {
        state = reduceBrain(state, {
          type: 'tool_result',
          ok: false,
          error: error?.message || String(error),
        })
      }
    } else {
      break
    }
  }

  if (!TERMINAL.has(state.status)) {
    state = reduceBrain(state, {
      type: 'hand_off',
      reason: 'The loop ran out of turns without finishing.',
    })
  }

  return state
}
