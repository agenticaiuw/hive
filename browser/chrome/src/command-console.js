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
 * `requiresConfirmation` is the only gate: false → execute, otherwise the plan
 * PARKS — and parking now means "decide it here", not "go somewhere else".
 *
 * WHY THE PARKED PLAN IS ANSWERABLE IN THE POPUP (owner, 2026-08-09: "i
 * shouldn't have to open up the dashboard to approve"). A parked plan used to
 * carry only a link to the dashboard, which is a second window, a second app
 * and a second scroll away from the one place the owner already is. The plan's
 * own `actions` are now kept on the history entry, so Approve runs exactly the
 * steps that were shown and Deny drops them.
 *
 * THE DOUBLE-FIRE THAT MAKES THIS SAFE TO DO. Two approve buttons for one plan
 * — one here, one on the dashboard — could each run the same actions once. The
 * arbiter is the agent, not either button: the Mac recorded this plan as a
 * `plan_ready` job, and approving re-reads that job first and refuses unless it
 * is STILL `plan_ready` (background.js). Whichever surface gets there first
 * moves the job off that status and the other one is told, in the agent's own
 * words, that the plan is no longer waiting.
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
/*
 * How long a parked plan stays approvable FROM HERE. The same reasoning as
 * execution-status.js's APPROVAL_TTL_MS: these steps act on live pages, and an
 * "approve" pressed hours later lands on whatever is there now, which may be
 * neither the page nor the state the plan was written against. Expiring only
 * closes the popup's shortcut — the job itself is still on the Mac, and the
 * card says so instead of going quiet.
 */
export const PLAN_APPROVAL_TTL_MS = 10 * 60_000

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
 * What goes in the /plan `command` field.
 *
 * THE TRAILER IS STILL HERE ON PURPOSE, even though /plan now takes a
 * first-class `context` (see commandContext below and local-agent/
 * callerContext.js). It is the only channel an agent older than that field has,
 * and an extension that dropped it would go silent about the page against every
 * such agent — a regression paid by the owner, to tidy a wire format.
 *
 * A current agent strips it: receiving `context` means it has the page
 * properly, so the redundant copy comes off the command before anything reads
 * that command as a sentence. Belt and braces, and the braces cost nothing.
 */
export function buildCommandText(command, page = null) {
  const text = clip(command, MAX_COMMAND_CHARS)
  if (!page) return text
  const label = page.title ? `"${page.title}" — ${page.url}` : page.url
  return `${text}\n\n[Sent from the browser extension. Active page: ${label}]`
}

/**
 * The same page as a first-class `context` field, which is where an agent that
 * understands it will read it from.
 *
 * Why this beats the trailer, from one live command on 2026-08-09: as text, the
 * page became part of the owner's sentence. goalVerdict reads that sentence to
 * decide whether the run did what was asked, took the words after "cancel",
 * stopped at the first full stop — which "…browser extension." supplied — and
 * told the owner "Cancelling all your recurring investments on ibkr [Sent is
 * still to do." Every display that titles a job with its command showed the
 * provenance instead of the ask, too.
 */
export function commandContext(page = null) {
  if (!page?.url) return null
  return {
    surface: CONSOLE_SOURCE,
    page: { url: page.url, ...(page.title ? { title: page.title } : {}) },
  }
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
        payload.error || 'The local agent rejected the token. Pair again from the popup.',
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

    /* `actions` rides along so the parked card can be decided in the popup
     * rather than only described there. */
    return {
      kind: 'parked',
      actions,
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
    /* What Approve would run, once something parks. See PENDING SHAPES. */
    pending: null,
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
  }
}

/* ===================================================================== *
 * PENDING SHAPES — what an entry's Approve button is holding.
 *
 * Two things park, and they park for different reasons, so they are two
 * shapes rather than one loose bag:
 *
 *   {kind:'mac-plan',   actions, jobId, sessionId, planner, parkedAt}
 *     The MAC PLANNER asked for a human before any of it runs. Approve runs
 *     the whole plan — locally if every step is browser work, otherwise back
 *     through the Mac's /execute — and the Mac's `plan_ready` job is the
 *     arbiter between this button and the dashboard's.
 *
 *   {kind:'local-step', call, effect, reason, runId, approvalId, parkedAt}
 *     A plan already RUNNING in this browser reached an outward step (see
 *     affinity.js). Approve runs exactly that one call and nothing after it:
 *     the steps behind it never ran, and pretending otherwise would be the
 *     kind of "it said done" this whole path exists to prevent.
 * ===================================================================== */

export function macPlanPending({ actions, jobId = null, sessionId = null, planner = null }, now = Date.now()) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) return null
  return {
    kind: 'mac-plan',
    actions: list,
    jobId,
    sessionId,
    planner,
    parkedAt: new Date(now).toISOString(),
  }
}

export function localStepPending({ call, effect, reason, runId, approvalId }, now = Date.now()) {
  if (!call?.type) return null
  return {
    kind: 'local-step',
    call: { type: String(call.type), params: call.params ?? {} },
    effect: effect ?? 'outward',
    reason: String(reason ?? ''),
    runId: runId ?? null,
    approvalId: approvalId ?? null,
    parkedAt: new Date(now).toISOString(),
  }
}

/**
 * May this entry still be decided from the popup? Pure, and the SAME check
 * the popup renders from and background.js gates on — a button that is
 * pressable must be a button that works, and the only way to guarantee that
 * is for both sides to ask one function.
 *
 * The agent's own `plan_ready` re-check happens on top of this, in
 * background.js, because it needs the network. This covers everything
 * knowable from the entry alone.
 */
export function planDecisionPreflight(entry, now = Date.now()) {
  if (!entry) return { ok: false, error: 'That command is no longer in this list.' }
  if (entry.state !== 'parked') {
    return {
      ok: false,
      error: `That plan is no longer waiting — it is "${entry.state}".`,
    }
  }
  const pending = entry.pending
  if (!pending?.kind) {
    return {
      ok: false,
      error:
        'This plan parked before the popup could keep its steps, so it can only be approved on the dashboard.',
    }
  }
  const parkedAt = Date.parse(pending.parkedAt ?? entry.finishedAt ?? '')
  if (Number.isFinite(parkedAt) && now - parkedAt > PLAN_APPROVAL_TTL_MS) {
    return {
      ok: false,
      expired: true,
      error:
        'This plan has been waiting too long to run from here — the pages it was written against have moved on. Send the command again.',
    }
  }
  return { ok: true, pending }
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
        pending: macPlanPending(
          {
            actions: outcome.actions,
            jobId: outcome.jobId ?? null,
            sessionId: outcome.sessionId ?? null,
            planner: outcome.planner ?? null,
          },
          now,
        ),
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

/**
 * The ordered ways a browser might agree to show the standalone console.
 *
 * THE BUG THIS SHAPE FIXES (owner, 2026-08-10: "after I first expand the
 * pop-up and then collapse it, I'm not able to open the pop-up again"). The
 * ladder used to be `if (await rung())` — treating a FALSY RETURN as "this
 * rung declined, try the next one". But a browser that opens the window and
 * returns nothing is indistinguishable from one that refused, so a successful
 * `windows.create` fell through and also opened a pinned tab, then a plain
 * tab, then another window. The right test is whether the METHOD EXISTS,
 * decided here, before anything is called; the caller then treats "did not
 * throw" as success and stops.
 *
 * @returns rung names in order, skipping any the browser cannot do at all.
 */
export function consoleWindowRungs({ hasWindowsCreate = false, hasTabsCreate = false } = {}) {
  const rungs = []
  /* A popup-type window first: no tab strip in Chrome, a plain window where
   * the type is ignored. Persistence is the point, not chrome. */
  if (hasWindowsCreate) rungs.push('popup-window')
  /* Then a pinned tab, then a plain one — Safari has refused the pinned
   * flavor before. Both still survive clicking elsewhere. */
  if (hasTabsCreate) rungs.push('pinned-tab', 'tab')
  /* Last: a plain window, for Safari running with NO window open, where the
   * tab rungs have nowhere to put a tab. */
  if (hasWindowsCreate) rungs.push('window')
  return rungs
}

/**
 * WHERE THE THINKING WILL HAPPEN, said out loud before a command is sent.
 *
 * THE DEFECT THIS FIXES, found 2026-08-09 by the owner asking why everything
 * went to the Mac. Routing is brain-first (background.js runConsoleCommand),
 * but the brain needs a relay credential, and with none paired
 * `brainAvailability()` fails at its first line and EVERY command falls
 * through to the Mac. That is the designed fallback working — and it was
 * invisible: the popup went on saying "this browser thinks for itself", which
 * for an unpaired browser is simply false.
 *
 * A capability that silently degrades to its fallback, under a UI that claims
 * otherwise, is worse than one that is plainly missing: there is nothing to
 * notice and nothing to fix. So the popup states which brain is about to be
 * used, and when it is not this one, why, and what to do.
 */
export function describeBrainState({ relayStatus, agentConfigured = false } = {}) {
  const state = String(relayStatus?.state ?? 'off')

  if (state === 'connected' || state === 'degraded') {
    return {
      brain: 'local',
      label: 'Thinks here',
      tone: 'ok',
      /* One sentence (owner: no long paragraphs in the popup). The full
       * explanation lives in the chip tooltip via this same string. */
      help:
        'Thinks and acts in your signed-in tabs; anything that submits or sends ' +
        'waits for your approval.',
    }
  }

  /* A credential this relay rejects is not the same as never having had one:
   * the fix is a fresh token, not first-time setup. */
  if (state === 'unauthorized') {
    return {
      brain: 'mac',
      label: 'Bad token',
      tone: 'error',
      help:
        'The relay rejected this browser’s credential, so it cannot think for itself ' +
        'and every command is going to your Mac. Paste the pairing code in this popup ' +
        'and press Connect — one paste replaces both credentials.',
    }
  }

  return {
    brain: 'mac',
    label: 'No brain',
    tone: 'warn',
    /* The settings page is gone (owner, 2026-08-12); pairing lives in this
     * popup, so the directions point at the box the reader is looking at. */
    help: agentConfigured
      ? 'This browser has no brain of its own yet, so every command goes to the agent ' +
        'on your Mac and needs it awake. Paste the pairing code in this popup and press ' +
        'Connect to let it think here instead.'
      : 'This browser is not set up: paste the pairing code above (PAIRING_CODE in the ' +
        'repo .env) and press Connect. One paste configures everything.',
  }
}

/**
 * THE ONE ENTRY THE POPUP SHOWS.
 *
 * The owner, 2026-08-09: "it should not show my past tasks in this popup, only
 * the current task." The list itself is unchanged — the background still keeps
 * the last HISTORY_LIMIT so a finished run is not lost, and the dashboard still
 * has every one of them. This is only about what the popup paints: the command
 * in flight, or if nothing is in flight, the last one's outcome, which is the
 * answer the owner is standing there waiting for.
 */
export function currentEntry(history) {
  const list = Array.isArray(history) ? history : []
  return list[0] ?? null
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
        canDecide: false,
        showDashboardLink: true,
      }
    }
    /*
     * THE HEADLINE THE BACKGROUND WROTE, not a guess about where the work is.
     *
     * This used to return the fixed string 'Asking the Mac agent…' for every
     * working entry, which was true when the Mac was the only place a command
     * could go and became a lie the moment this node grew a brain. The owner
     * saw it on the very first command after the brain shipped and asked why
     * it said that immediately — it says it immediately because it was never
     * looking at anything.
     *
     * background.js already narrates the route as it happens ('Thinking in
     * this browser…', 'Handing this to the Mac — <reason>', 'Approved —
     * running it…'), and every one of those was being thrown away here. So:
     * show what was actually written, and fall back to a phrase that claims
     * nothing about which machine is busy.
     */
    return {
      state: 'working',
      label: 'Working…',
      headline: String(entry?.headline ?? '').trim() || 'Working on it…',
      canDecide: false,
      showDashboardLink: false,
    }
  }

  const labels = {
    answered: 'Answered',
    executed: 'Done',
    parked: 'Parked for approval',
    denied: 'Denied',
    refused: 'Refused',
    failed: 'Failed',
  }

  /*
   * A parked plan offers its own Approve/Deny when it still can, and points at
   * the dashboard only when it cannot — expired, or parked by a build that did
   * not keep the steps. The link is the fallback now, not the whole offer.
   */
  const decision = state === 'parked' ? planDecisionPreflight(entry, now) : { ok: false }

  return {
    state,
    label: labels[state] ?? state,
    headline: entry?.headline ?? '',
    canDecide: decision.ok === true,
    decisionNote: decision.ok ? '' : state === 'parked' ? decision.error : '',
    showDashboardLink: (state === 'parked' && !decision.ok) || state === 'lost',
  }
}
