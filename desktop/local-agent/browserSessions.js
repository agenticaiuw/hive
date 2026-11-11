import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import {
  enqueueBrowserCommand,
  getBrowserStatus,
  waitForBrowserResult,
} from './browserBridge.js'
import { workspacePath } from './config.js'

/*
 * A browser tab an agent can keep coming back to.
 *
 * Two failures kept showing up in live runs and both came from the same gap:
 * the browser tier had no memory of which tab it was working in.
 *
 * 1. With Safari open but no web tab, the extension answers every non-navigate
 *    command with "No matching browser tab is available." An agent's first
 *    move is almost always read_page or snapshot, so the whole browser tier
 *    looked broken when it was one navigate away from working. navigate is the
 *    only command that can conjure a tab, so anything that needs a tab and has
 *    none now navigates first instead of failing.
 * 2. Every /execute call resolved the target tab from scratch ("the active
 *    one"), so a two-step task could act on two different pages. A named
 *    session pins one page for the length of a task, which is what makes
 *    "open the form, then fill it in" reliable rather than lucky.
 *
 * This gates nothing. The recovery ladder only ever adds a tab; no command is
 * refused here that the extension would have accepted.
 */
const STORE_PATH = path.join(workspacePath, '.pendant-browser-sessions.json')

/*
 * Unnamed work still gets a session so the page is remembered, but it is only
 * consulted to recover from a lost tab — never to override the extension's own
 * "active tab" choice. Pinning implicit callers would silently retarget every
 * existing browser_* caller at whatever page was last touched.
 */
const DEFAULT_SESSION_ID = 'default'
const MAX_SESSIONS = 40

/* Somewhere scriptable to land when a command needs a tab and nothing is open. */
const HOME_URL = process.env.PENDANT_BROWSER_HOME_URL || 'https://www.google.com'

const SESSION_PARAM_KEYS = [
  'session',
  'sessionId',
  'browserSession',
  'sessionName',
]
const CONTROL_PARAM_KEYS = [...SESSION_PARAM_KEYS, 'bootstrapUrl']

/* Observability only: nothing branches on this, it just labels the trace. */
const MUTATING_ACTIONS = new Set([
  'navigate',
  'click',
  'type',
  'select',
  'press_key',
  'scroll',
])

/** The tab is gone but the browser is there — navigate and the run continues. */
export class BrowserTabMissingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrowserTabMissingError'
    this.code = 'browser_no_tab'
    this.recoverable = true
  }
}

/** Nothing on the other end of the bridge — retrying cannot help. */
export class BrowserOfflineError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BrowserOfflineError'
    this.code = 'browser_offline'
    this.recoverable = false
  }
}

/*
 * The extension reports both conditions as plain strings, and Safari and
 * Chrome word the lost-tab case differently, so the wording is matched here
 * rather than in the extension where a fix needs a rebuild and a browser
 * reload. Safari says "Invalid call to tabs.get(). Tab not found."
 */
const NO_TAB_PATTERNS = [
  /no matching browser tab/i,
  /no tab with id/i,
  /invalid tab id/i,
  /tabs\.get\(\)/i,
  /tab not found/i,
  /(?:destination )?tab closed/i,
  /tab (?:was )?closed/i,
]

/**
 * Turn an extension error into something a caller can act on: recover by
 * opening a tab, or stop because the bridge itself is down.
 */
export function classifyBrowserError(error) {
  if (
    error instanceof BrowserTabMissingError ||
    error instanceof BrowserOfflineError
  ) {
    return error
  }

  const message = String(error?.message ?? error ?? '')

  if (/did not respond in time/i.test(message)) {
    const status = getBrowserStatus()
    return new BrowserOfflineError(
      status.online
        ? 'The browser extension is online but did not answer in time. Safari may be blocked on a dialog or a page that never finished loading.'
        : 'The browser extension is offline. Open Safari and enable the AI Pendant Browser Bridge extension; no browser_* action can run until it is polling.',
    )
  }

  if (NO_TAB_PATTERNS.some((pattern) => pattern.test(message))) {
    return new BrowserTabMissingError(message)
  }

  return error
}

/*
 * Safari hands every extension context its own tab-id namespace: two commands
 * seconds apart reported the same page as 226923 and then 226919, and an id
 * from one command is rejected by the next. A stored tabId is therefore a
 * diagnostic, not a handle. The URL is what survives, and the extension can
 * already resolve a tab from `urlContains`, so that is what a session targets
 * with. The query string is dropped because sites rewrite it (Google appends
 * a per-load `zx=`), which would make the handle stale on arrival.
 */
export function tabNeedle(url) {
  const text = String(url ?? '').trim()
  if (!text) return ''
  try {
    const parsed = new URL(text)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return text
  }
}

const isValidStore = (value) => value && Array.isArray(value.sessions)

function load(filePath) {
  ensureJsonStore(filePath, { sessions: [] }, { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: { sessions: [] },
    validate: isValidStore,
  })
}

function save(store, filePath) {
  writeJsonAtomic(filePath, store)
}

export function listBrowserSessions({ filePath = STORE_PATH } = {}) {
  return load(filePath).sessions
}

export function getBrowserSession(id, { filePath = STORE_PATH } = {}) {
  return load(filePath).sessions.find((session) => session.id === id) ?? null
}

export function forgetBrowserSession(id, { filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const before = store.sessions.length
  store.sessions = store.sessions.filter((session) => session.id !== id)
  if (store.sessions.length === before) return false
  save(store, filePath)
  return true
}

/**
 * Record where a session currently is. Called after every successful command,
 * so a session follows its tab as the page navigates.
 */
export function rememberBrowserSession(
  { id, tabId = null, windowId = null, url = '', title = '', lastAction = null },
  { filePath = STORE_PATH } = {},
) {
  const numericTabId = Number.isInteger(tabId) ? tabId : null
  if (numericTabId === null && !url) return null

  const store = load(filePath)
  const now = new Date().toISOString()
  const existing = store.sessions.find((session) => session.id === id)
  const session = existing ?? { id, createdAt: now }

  if (numericTabId !== null) session.tabId = numericTabId
  if (Number.isInteger(windowId)) session.windowId = windowId
  /* Keep the last known URL when a command reports none: it is the only thing
   * that can find this session's tab again, or reopen it. */
  if (url) session.url = url
  if (title) session.title = String(title).slice(0, 120)
  session.lastAction = lastAction
  session.lastUsedAt = now

  if (!existing) store.sessions.push(session)
  store.sessions.sort((left, right) =>
    String(right.lastUsedAt).localeCompare(String(left.lastUsedAt)),
  )
  store.sessions = store.sessions.slice(0, MAX_SESSIONS)
  save(store, filePath)
  return session
}

/** Which session a caller means, and whether they asked for one by name. */
export function resolveSessionRef(params = {}) {
  for (const key of SESSION_PARAM_KEYS) {
    const named = String(params?.[key] ?? '').trim()
    if (named) return { id: named.slice(0, 80), pinned: true }
  }
  return { id: DEFAULT_SESSION_ID, pinned: false }
}

function toWireParams(params = {}) {
  const wire = { ...params }
  for (const key of CONTROL_PARAM_KEYS) delete wire[key]
  /* The extension checks Number.isInteger, so a tabId that arrived as JSON
   * text would be silently ignored and the command would hit the wrong tab. */
  const tabId = Number(wire.tabId)
  if (Number.isInteger(tabId)) wire.tabId = tabId
  else delete wire.tabId
  return wire
}

/** Send one command to the extension and unwrap its result. */
export async function dispatchBrowserCommand({ type, params, label }) {
  const command = enqueueBrowserCommand({
    type,
    params: params ?? {},
    label: label ?? type,
  })
  const outcome = await waitForBrowserResult(command.commandId).catch(
    (error) => {
      throw classifyBrowserError(error)
    },
  )

  if (outcome.status === 'failed') {
    throw classifyBrowserError(
      new Error(outcome.error || 'Browser extension action failed.'),
    )
  }

  return outcome.result ?? {}
}

async function openTab(url, dispatch) {
  const result = await dispatch({
    type: 'navigate',
    params: { url, newTab: true },
    label: `open ${url}`,
  })
  return { ...result, url: result?.url || url }
}

const isTabMissing = (error) =>
  classifyBrowserError(error) instanceof BrowserTabMissingError

/**
 * Run one browser command against a session, opening a tab when the command
 * needs one and none is usable.
 *
 * Returns the extension result plus the session it landed in, so a caller can
 * chain further actions at the same page.
 */
export async function runBrowserSessionAction(
  { type, params = {}, label } = {},
  { dispatch = dispatchBrowserCommand, filePath = STORE_PATH } = {},
) {
  const { id: sessionId, pinned } = resolveSessionRef(params)
  const session = getBrowserSession(sessionId, { filePath })
  const base = toWireParams(params)
  const needle = tabNeedle(session?.url)
  /* A caller's own tabId or urlContains always wins: they are addressing a
   * specific tab and the session must not second-guess that. */
  const addressed = Number.isInteger(base.tabId) || Boolean(base.urlContains)
  const targeted =
    pinned && needle && !addressed ? { ...base, urlContains: needle } : base

  const recovery = []
  let result
  try {
    result = await dispatch({ type, params: targeted, label })
  } catch (error) {
    const typed = classifyBrowserError(error)
    if (!(typed instanceof BrowserTabMissingError)) throw typed
    result = await recoverAndRetry({
      type,
      label,
      params,
      base,
      targeted,
      needle,
      session,
      dispatch,
      recovery,
    })
  }

  /* Commands like list_tabs report no tab of their own; keep the mapping the
   * session already had rather than blanking it. */
  const stored =
    rememberBrowserSession(
      {
        id: sessionId,
        tabId: Number.isInteger(result?.tabId) ? result.tabId : null,
        windowId: Number.isInteger(result?.windowId) ? result.windowId : null,
        url: result?.url ?? '',
        title: result?.title ?? '',
        lastAction: type,
      },
      { filePath },
    ) ?? session

  return {
    ...result,
    session: {
      id: sessionId,
      pinned,
      tabId: stored?.tabId ?? null,
      windowId: stored?.windowId ?? null,
      url: stored?.url ?? '',
      recovery,
    },
    kind: MUTATING_ACTIONS.has(type) ? 'mutating' : 'read_only',
  }
}

async function recoverAndRetry({
  type,
  label,
  params,
  base,
  targeted,
  needle,
  session,
  dispatch,
  recovery,
}) {
  /* navigate is the one command that can make its own tab. */
  if (type === 'navigate') {
    recovery.push('new_tab')
    return dispatch({ type, params: { ...base, newTab: true }, label })
  }

  /* The session's page may still be open but no longer the active tab. */
  if (needle && !targeted.urlContains) {
    try {
      recovery.push('remembered_page')
      return await dispatch({
        type,
        params: { ...base, urlContains: needle },
        label,
      })
    } catch (error) {
      if (!isTabMissing(error)) throw classifyBrowserError(error)
    }
  }

  const target =
    String(params.bootstrapUrl || params.url || session?.url || '').trim() ||
    HOME_URL
  recovery.push('bootstrap_navigate')
  const opened = await openTab(target, dispatch)

  /* Address the fresh tab by URL, not by the id navigate just reported: that
   * id belongs to the extension context that ran navigate, and the retry may
   * well be answered by a different one. */
  const retry = { ...base, urlContains: tabNeedle(opened.url) }
  delete retry.tabId
  return dispatch({ type, params: retry, label })
}

/**
 * Get a session pointing at a usable page, adopting or opening one as needed,
 * so the caller can address it by name for the rest of the task.
 */
export async function openBrowserSession(
  params = {},
  { dispatch = dispatchBrowserCommand, filePath = STORE_PATH } = {},
) {
  const { id: sessionId } = resolveSessionRef(params)
  const requestedTabId = Number(params.tabId)
  const urlContains = String(params.urlContains ?? '').trim()
  const url = String(params.url ?? '').trim()

  if (Number.isInteger(requestedTabId)) {
    const adopted = await adoptExistingTab(
      (tab) => tab.tabId === requestedTabId,
      dispatch,
    )
    if (adopted) return finishOpen(sessionId, adopted, 'adopted', filePath)
    throw new BrowserTabMissingError(
      `Tab ${requestedTabId} is not open. Safari renumbers tabs between commands — adopt by urlContains instead, or pass url to open a new one.`,
    )
  }

  if (urlContains) {
    const adopted = await adoptExistingTab(
      (tab) =>
        String(tab.url ?? '')
          .toLowerCase()
          .includes(urlContains.toLowerCase()),
      dispatch,
    )
    if (adopted) return finishOpen(sessionId, adopted, 'adopted', filePath)
  }

  if (url) {
    const opened = await openTab(url, dispatch)
    return finishOpen(sessionId, opened, 'opened', filePath)
  }

  /*
   * A NAMED TARGET THAT IS NOT OPEN IS A MISS, NOT A FREE CHOICE.
   *
   * Observed live on 2026-08-09: the planner asked for
   * {session:"ibkr", urlContains:"interactivebrokers.com"} with no `url`.
   * Nothing matched, and the fallback below adopted the ACTIVE tab — GitHub.
   * The session then answered to the name "ibkr" while pointing at
   * github.com, so every later step in the plan snapshotted GitHub and the
   * run reported "adopted … looked at the page — nothing was cancelled".
   * Nothing was wrong with any single step; the session was bound to the
   * wrong page before step two ever ran.
   *
   * So when the caller named a page: open THAT page if the needle says which
   * one (a host is a URL missing only its scheme), and otherwise refuse.
   * Adopting an unrelated tab under the requested name is the one outcome
   * that cannot be recovered from downstream, because every later step
   * believes it is somewhere it is not.
   */
  if (urlContains) {
    const target = urlFromNeedle(urlContains)
    if (target) {
      const opened = await openTab(target, dispatch)
      return finishOpen(sessionId, opened, 'opened', filePath)
    }
    throw new BrowserTabMissingError(
      `No open tab matches "${urlContains}", and it does not name a site this can open ` +
        '(pass url to open one). Refusing to bind the session to an unrelated tab.',
    )
  }

  /* No target named at all: reuse whatever is already open before making noise. */
  const active = await adoptExistingTab(() => true, dispatch)
  if (active) return finishOpen(sessionId, active, 'adopted', filePath)

  const opened = await openTab(HOME_URL, dispatch)
  return finishOpen(sessionId, opened, 'opened', filePath)
}

/*
 * A tab needle is written to be matched against `tab.url`, so the useful ones
 * are already most of an address: "interactivebrokers.com",
 * "mail.google.com/u/0". Only a needle that resolves to a real host becomes a
 * URL — a bare word ("inbox"), a path fragment ("/orders") or anything with
 * whitespace names no site, and guessing one from it would open a page the
 * owner never asked for.
 */
const HOST_SHAPED = /^(?:https?:\/\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d+)?(?:[/?#]\S*)?$/i

export function urlFromNeedle(needle) {
  const text = String(needle ?? '').trim()
  if (!text || !HOST_SHAPED.test(text)) return ''
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).toString()
  } catch {
    return ''
  }
}

async function adoptExistingTab(predicate, dispatch) {
  const listed = await dispatch({
    type: 'list_tabs',
    params: {},
    label: 'list tabs for session',
  })
  /* list_tabs already sorts by last accessed, so the first match is the tab
   * the owner most recently looked at. */
  return (listed?.tabs ?? []).find(predicate) ?? null
}

function finishOpen(sessionId, tab, origin, filePath) {
  const stored = rememberBrowserSession(
    {
      id: sessionId,
      tabId: Number.isInteger(Number(tab.tabId)) ? Number(tab.tabId) : null,
      windowId: Number.isInteger(Number(tab.windowId)) ? Number(tab.windowId) : null,
      url: tab.url ?? '',
      title: tab.title ?? '',
      lastAction: 'open_session',
    },
    { filePath },
  )

  if (!stored) {
    throw new BrowserTabMissingError(
      'The browser reported a tab with neither an id nor a URL, so no session could be established.',
    )
  }

  return {
    message: `Browser session "${sessionId}" ${origin} ${stored.url || `tab ${stored.tabId}`}`,
    origin,
    session: stored,
    sessionId,
    tabId: stored.tabId ?? null,
    windowId: stored.windowId ?? null,
    url: stored.url ?? '',
  }
}

export const browserSessionsLocation = () => STORE_PATH
