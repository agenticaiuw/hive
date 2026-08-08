/*
 * The extension's own planning brain. INERT TODAY, deliberately.
 *
 * WHAT FLIPS IT ON — all three, in storage.local, none of which exist yet:
 *
 *   brainEnabled:  true            (exactly true; anything else is off)
 *   modelProxyUrl: "https://…"     (the relay-side model proxy; a separate
 *                                   task builds that endpoint)
 *   deviceToken:   "…"             (a scoped per-device token the relay
 *                                   issues; the same separate task)
 *
 * Until that task lands there is NO working credential, and this module holds
 * none: no API key, no default URL, no fallback secret. normalizeBrainConfig
 * refuses to report `ready` unless all three values are present and sane, and
 * chooseBrainRoute sends every command to the Mac planner until then — which
 * is exactly what the popup does today.
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

export const BRAIN_STORAGE_KEYS = ['brainEnabled', 'modelProxyUrl', 'deviceToken']

export const BRAIN_DEFAULTS = Object.freeze({
  brainEnabled: false,
  modelProxyUrl: null,
  deviceToken: null,
})

export const BRAIN_MAX_STEPS = 6
const MAX_FAILURES = 2

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

export function normalizeBrainConfig(values = {}) {
  const brainEnabled = values.brainEnabled === true
  const modelProxyUrl = validProxyUrl(values.modelProxyUrl)
  const deviceToken = String(values.deviceToken ?? '').trim() || null

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
    ready: brainEnabled && Boolean(modelProxyUrl) && Boolean(deviceToken),
    reason,
  }
}

/**
 * Where a command should go. 'mac-planner' is the answer until the credential
 * task lands; the caller treats anything but 'local-brain' as the Mac path.
 */
export function chooseBrainRoute(config) {
  const normalized =
    config && 'ready' in config ? config : normalizeBrainConfig(config)
  return normalized.ready
    ? { route: 'local-brain', reason: 'Brain configuration is complete.' }
    : { route: 'mac-planner', reason: normalized.reason }
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
 */
export function buildBrainMessages(state) {
  const tools = BROWSER_TOOLS.map(
    (tool) => `- ${tool.name}(${tool.params}): ${tool.description}`,
  ).join('\n')

  const transcript = state.steps
    .map((step, index) => {
      const outcome = step.ok
        ? JSON.stringify(step.result)?.slice(0, 2_000)
        : `ERROR: ${step.error}`
      return `${index + 1}. ${step.tool}(${JSON.stringify(step.params)}) → ${outcome}`
    })
    .join('\n')

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
        state = reduceBrain(state, { type: 'model_error', error: error?.message || String(error) })
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
