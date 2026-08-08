/*
 * The popup command box's pure logic: build the command text that goes to the
 * Mac agent, interpret what comes back, and keep a small honest history.
 *
 * THE CONTRACT THIS MATCHES — local-agent/server.js, read 2026-08-08 and
 * verified against the live agent with a real "what time is it" round trip:
 *
 *   POST /plan  {command, sessionId?, source}
 *     200 status:"instant"  → already ran (deterministic fast path or info
 *                             tool). `response`/`summary` is the answer;
 *                             `actions` is []. Nothing left to execute.
 *     200 status:"ready"    → a plan. `actions` is the list, and the planner
 *                             says whether it wants a human first:
 *                             `requiresConfirmation` false → safe to hand
 *                             straight to /execute; anything else → the plan
 *                             PARKS. The /plan call itself already recorded a
 *                             plan_ready job on the Mac, which the dashboard
 *                             renders as "Waiting" — so parking here is not a
 *                             dead end, it is "finish this on the dashboard".
 *     422 status:"unsupported" → refusal; `error` arrives already prefixed
 *                             "Blocked for safety: …" and is shown verbatim.
 *     401                   → {ok:false, status:"blocked", error} bad token.
 *     409/500               → {ok:false, error, cancelled, jobId}.
 *
 *   POST /execute {command, actions, sessionId?, planMeta?, source}
 *     200 → {ok, status:"success"|"failed"|"blocked", results:[{ok, message?,
 *            error?, action:{type,label}}], response, sessionId, jobId}
 *     400/409 → {ok:false, error, cancelled?, logs?, jobId}
 *
 * The popup never invents its own risk policy. The Mac planner's own
 * `requiresConfirmation` is the only gate: false → execute, otherwise park and
 * point at the dashboard, exactly the split local-agent/bridge.js gives the
 * pendant (which parks with "Waiting for your approval on the dashboard").
 */
import {
  PRIVACY_RULES,
  isScriptableUrl,
  truncateTitle,
  withholdSecrets,
} from './bridge-core.js'

export const CONSOLE_SOURCE = 'browser-extension'
export const HISTORY_KEY = 'consoleHistory'
export const SESSION_KEY = 'consoleSessionId'
export const INCLUDE_PAGE_KEY = 'consoleIncludePage'
export const HISTORY_LIMIT = 8
export const MAX_COMMAND_CHARS = 2_000
/* A plan can sit in a model stream for a while; the bridge's 7s poll timeout
 * would kill every real planning call. */
export const PLAN_TIMEOUT_MS = 120_000
export const EXECUTE_TIMEOUT_MS = 180_000
/* A "working" entry older than this is not working: the service worker that
 * owned the fetch is gone (Safari suspends them freely) and nothing will ever
 * finish it. Rendered as lost rather than left spinning forever. */
export const WORKING_STALE_MS = 3 * 60_000

const HEADLINE_MAX = 500
const DETAIL_MAX = 2_000

const clip = (value, max) => {
  const text = String(value ?? '').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * The page the owner was looking at, reduced to what may leave the browser.
 *
 * Full URL on purpose — "summarize this page" needs the path — but through the
 * same value-pattern scrub list_tabs uses, so a magic-link token in the query
 * string is withheld while the address stays targetable. Label patterns are
 * skipped for the same reason sanitizeExtraction skips them for tab URLs: a
 * URL containing the word "password" is an address, not a secret.
 */
export function scrubPageContext(page) {
  const url = String(page?.url ?? '')
  if (!isScriptableUrl(url)) return null

  const valuesOnly = { ...PRIVACY_RULES, secretLabelPatterns: [] }
  return {
    url: clip(withholdSecrets(url, valuesOnly).text, 400),
    title: truncateTitle(page?.title ?? '', 120),
  }
}

/**
 * What actually goes in the /plan `command` field. The agent's contract has no
 * separate context parameter — the command text is the only channel — so the
 * page rides along as a clearly-labelled trailer the planner can use or ignore.
 */
export function buildCommandText(command, page = null) {
  const text = clip(command, MAX_COMMAND_CHARS)
  if (!page) return text
  const label = page.title ? `"${page.title}" — ${page.url}` : page.url
  return `${text}\n\n[Sent from the browser extension. Active page: ${label}]`
}

export function dashboardUrlFor(agentUrl) {
  try {
    const url = new URL(agentUrl)
    /* The agent prints "http://localhost:8000/dashboard" as its own address;
     * 127.0.0.1 is the same interface wearing its config name. */
    if (url.hostname === '127.0.0.1') url.hostname = 'localhost'
    return `${url.origin}/dashboard`
  } catch {
    return 'http://localhost:8000/dashboard'
  }
}

/* ===================================================================== *
 * Response interpretation. One function per leg, fed {status, payload}
 * where `status` is the HTTP status and `payload` the parsed JSON body
 * (null when the body was not JSON). Errors are kept verbatim.
 * ===================================================================== */

export function interpretPlanResponse({ status, payload }) {
  if (!payload || typeof payload !== 'object') {
    return {
      kind: 'error',
      message: `The local agent returned HTTP ${status} with no readable body.`,
    }
  }

  const common = {
    jobId: payload.jobId ?? null,
    sessionId: payload.sessionId ?? null,
    planner: payload.planner ?? null,
  }

  if (status === 401) {
    return {
      kind: 'error',
      unauthorized: true,
      message:
        payload.error || 'The local agent rejected the token. Open settings.',
      ...common,
    }
  }

  if (status === 422 || payload.status === 'unsupported') {
    return {
      kind: 'refused',
      message: payload.error || 'The planner refused this request.',
      ...common,
    }
  }

  if (status < 200 || status >= 300 || payload.ok === false) {
    return {
      kind: 'error',
      cancelled: Boolean(payload.cancelled),
      message: payload.error || `The local agent returned HTTP ${status}.`,
      ...common,
    }
  }

  if (payload.status === 'instant') {
    return {
      kind: 'answered',
      message: payload.response || payload.summary || 'Done.',
      ...common,
    }
  }

  const actions = Array.isArray(payload.actions) ? payload.actions : []

  if (payload.status === 'ready' && actions.length) {
    const planLine =
      payload.summary ||
      payload.response ||
      payload.preview?.spoken ||
      `Prepared ${actions.length} step${actions.length === 1 ? '' : 's'}.`

    if (payload.requiresConfirmation === false) {
      return { kind: 'execute', actions, message: planLine, ...common }
    }

    return {
      kind: 'parked',
      message: planLine,
      detail: describePlanSteps(actions, payload.preview),
      safety: payload.safety || '',
      ...common,
    }
  }

  if (payload.status === 'ready' && payload.response) {
    return { kind: 'answered', message: payload.response, ...common }
  }

  return {
    kind: 'error',
    message:
      payload.error ||
      `The planner returned an empty ${payload.status ?? 'unknown'} plan.`,
    ...common,
  }
}

export function interpretExecuteResponse({ status, payload }) {
  if (!payload || typeof payload !== 'object') {
    return {
      kind: 'error',
      message: `The local agent returned HTTP ${status} with no readable body.`,
    }
  }

  const common = {
    jobId: payload.jobId ?? null,
    sessionId: payload.sessionId ?? null,
  }

  if (status < 200 || status >= 300) {
    return {
      kind: 'error',
      cancelled: Boolean(payload.cancelled),
      message: payload.error || `The local agent returned HTTP ${status}.`,
      ...common,
    }
  }

  const steps = describeResults(payload.results)
  const message =
    payload.response ||
    steps.join(' ') ||
    (payload.ok ? 'Done.' : payload.error || 'Execution failed.')

  return {
    kind: payload.ok ? 'executed' : 'exec-failed',
    status: payload.status ?? (payload.ok ? 'success' : 'failed'),
    message,
    steps,
    ...common,
  }
}

export function describeResults(results) {
  if (!Array.isArray(results)) return []
  return results.map((result) => {
    const label =
      result?.action?.label || result?.action?.type || 'step'
    const text = result?.message || result?.error || ''
    const mark = result?.ok ? '✓' : '✗'
    return clip(`${mark} ${label}${text ? ` — ${text}` : ''}`, 300)
  })
}

function describePlanSteps(actions, preview) {
  const lines = actions
    .slice(0, 6)
    .map(
      (action, index) =>
        `${index + 1}. ${clip(action?.label || action?.type || 'step', 120)}`,
    )
  if (actions.length > 6) lines.push(`… and ${actions.length - 6} more`)
  const touched = [
    ...(preview?.affected?.apps ?? []),
    ...(preview?.affected?.urls ?? []),
    ...(preview?.affected?.paths ?? []),
  ]
  if (touched.length) {
    lines.push(`Touches: ${clip(touched.join(', '), 200)}`)
  }
  return lines.join('\n')
}

/* ===================================================================== *
 * History: a bounded list in storage.local, newest first. The popup renders
 * it and the background writes it, so an entry survives the popup closing.
 * ===================================================================== */

export function newHistoryEntry({ id, command, page = null, now = Date.now() }) {
  return {
    id,
    command: clip(command, MAX_COMMAND_CHARS),
    page: page ? { url: page.url, title: page.title } : null,
    state: 'working',
    headline: '',
    detail: '',
    jobId: null,
    sessionId: null,
    planner: null,
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
  }
}

export function appendHistory(history, entry) {
  const list = Array.isArray(history) ? history : []
  return [entry, ...list].slice(0, HISTORY_LIMIT)
}

export function patchHistory(history, id, patch) {
  const list = Array.isArray(history) ? history : []
  return list.map((entry) =>
    entry?.id === id
      ? {
          ...entry,
          ...patch,
          headline: clip(patch.headline ?? entry.headline, HEADLINE_MAX),
          detail: clip(patch.detail ?? entry.detail, DETAIL_MAX),
        }
      : entry,
  )
}

/** Outcome (from the interpreters above) → history entry patch. */
export function outcomeToPatch(outcome, now = Date.now()) {
  const finishedAt = new Date(now).toISOString()
  const base = {
    finishedAt,
    jobId: outcome.jobId ?? null,
    sessionId: outcome.sessionId ?? null,
    planner: outcome.planner ?? null,
  }

  switch (outcome.kind) {
    case 'answered':
      return { ...base, state: 'answered', headline: outcome.message }
    case 'executed':
      return {
        ...base,
        state: 'executed',
        headline: outcome.message,
        detail: (outcome.steps ?? []).join('\n'),
      }
    case 'exec-failed':
      return {
        ...base,
        state: 'failed',
        headline: outcome.message,
        detail: (outcome.steps ?? []).join('\n'),
      }
    case 'parked':
      return {
        ...base,
        state: 'parked',
        headline: outcome.message,
        detail: [outcome.safety, outcome.detail].filter(Boolean).join('\n'),
      }
    case 'refused':
      return { ...base, state: 'refused', headline: outcome.message }
    default:
      return {
        ...base,
        state: 'failed',
        headline: outcome.message || 'Something went wrong.',
      }
  }
}

/** How the popup should render one entry right now. Pure, so testable. */
export function describeEntry(entry, now = Date.now()) {
  const state = entry?.state ?? 'failed'

  if (state === 'working') {
    const startedAt = Date.parse(entry?.startedAt ?? '')
    const stale =
      Number.isFinite(startedAt) && now - startedAt > WORKING_STALE_MS
    if (stale) {
      return {
        state: 'lost',
        label: 'Lost',
        headline:
          'The browser suspended the bridge before this finished. Check the dashboard for what actually happened.',
        showDashboardLink: true,
      }
    }
    return {
      state: 'working',
      label: 'Working…',
      headline: 'Asking the Mac agent…',
      showDashboardLink: false,
    }
  }

  const labels = {
    answered: 'Answered',
    executed: 'Done',
    parked: 'Parked for approval',
    refused: 'Refused',
    failed: 'Failed',
  }

  return {
    state,
    label: labels[state] ?? state,
    headline: entry?.headline ?? '',
    showDashboardLink: state === 'parked' || state === 'lost',
  }
}
