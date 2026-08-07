import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  BrowserOfflineError,
  BrowserTabMissingError,
  classifyBrowserError,
  forgetBrowserSession,
  getBrowserSession,
  listBrowserSessions,
  openBrowserSession,
  rememberBrowserSession,
  resolveSessionRef,
  runBrowserSessionAction,
  tabNeedle,
} from './browserSessions.js'

function withTemporaryStore(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pendant-browser-session-test-'),
  )
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return path.join(directory, 'browser-sessions.json')
}

const NO_TAB =
  'No matching browser tab is available. Open a web page or specify a valid tabId.'
const SAFARI_STALE_TAB = 'Invalid call to tabs.get(). Tab not found.'

/** Stand-in extension: scripted replies plus a log of what was sent. */
function fakeExtension(handlers) {
  const calls = []
  const dispatch = async ({ type, params, label }) => {
    calls.push({ type, params, label })
    const handler = handlers[type]
    if (!handler) throw new Error(`unexpected command: ${type}`)
    return handler(params)
  }
  return { dispatch, calls }
}

test('a named session keeps later actions on the same page across calls', async (t) => {
  const filePath = withTemporaryStore(t)
  const { dispatch, calls } = fakeExtension({
    navigate: () => ({
      message: 'Navigated',
      tabId: 210031,
      windowId: 210025,
      url: 'https://example.com/pricing',
    }),
    read_page: (params) => {
      assert.equal(params.urlContains, 'https://example.com/pricing')
      return { message: 'read', tabId: 229546, url: 'https://example.com/pricing' }
    },
  })

  const navigated = await runBrowserSessionAction(
    {
      type: 'navigate',
      params: { url: 'https://example.com/pricing', session: 'work' },
    },
    { dispatch, filePath },
  )
  assert.equal(navigated.session.id, 'work')
  assert.equal(navigated.session.url, 'https://example.com/pricing')
  assert.equal(navigated.kind, 'mutating')

  const read = await runBrowserSessionAction(
    { type: 'read_page', params: { mode: 'main_text', session: 'work' } },
    { dispatch, filePath },
  )
  assert.equal(read.kind, 'read_only')
  assert.deepEqual(read.session.recovery, [])
  /* The session name is ours, not the extension's vocabulary. */
  assert.equal(calls.at(-1).params.session, undefined)

  /* Survives the process: a fresh read of the store still finds the page. */
  assert.equal(
    getBrowserSession('work', { filePath }).url,
    'https://example.com/pricing',
  )
})

test('a session targets by URL because Safari renumbers tabs per command', async (t) => {
  const filePath = withTemporaryStore(t)
  rememberBrowserSession(
    { id: 'work', tabId: 226923, url: 'https://example.com/pricing?zx=1' },
    { filePath },
  )
  const { dispatch, calls } = fakeExtension({
    click: () => ({ message: 'clicked', tabId: 226919, url: 'https://example.com/pricing' }),
  })

  await runBrowserSessionAction(
    { type: 'click', params: { selector: '#buy', session: 'work' } },
    { dispatch, filePath },
  )

  /* The remembered id is never replayed; the query string is dropped because
   * sites rewrite it between loads. */
  assert.equal(calls[0].params.tabId, undefined)
  assert.equal(calls[0].params.urlContains, 'https://example.com/pricing')
})

test('an explicit tabId from the caller still wins over the session', async (t) => {
  const filePath = withTemporaryStore(t)
  rememberBrowserSession({ id: 'work', url: 'https://example.com/' }, { filePath })
  const { dispatch, calls } = fakeExtension({
    snapshot: () => ({ message: 'snapshot', tabId: 12, url: 'https://other.example/' }),
  })

  await runBrowserSessionAction(
    { type: 'snapshot', params: { session: 'work', tabId: 12 } },
    { dispatch, filePath },
  )

  assert.equal(calls[0].params.tabId, 12)
  assert.equal(calls[0].params.urlContains, undefined)
})

test('an action that needs a tab opens one instead of failing', async (t) => {
  const filePath = withTemporaryStore(t)
  const { dispatch, calls } = fakeExtension({
    read_page: (params) => {
      if (!params.urlContains) throw new Error(NO_TAB)
      return { message: 'read', tabId: 4242, url: 'https://www.google.com/' }
    },
    navigate: (params) => ({
      message: 'Navigated',
      tabId: 4240,
      windowId: 11,
      url: `${params.url}?zx=1786081086668`,
    }),
  })

  const result = await runBrowserSessionAction(
    { type: 'read_page', params: { mode: 'main_text' } },
    { dispatch, filePath },
  )

  assert.equal(result.tabId, 4242)
  assert.deepEqual(result.session.recovery, ['bootstrap_navigate'])
  assert.equal(calls[1].type, 'navigate')
  assert.equal(calls[1].params.newTab, true)
  /* The id navigate reported belongs to that command's context only. */
  assert.equal(calls[2].params.tabId, undefined)
  assert.equal(calls[2].params.urlContains, 'https://www.google.com/')
})

test('bootstrap reopens the page the session was on', async (t) => {
  const filePath = withTemporaryStore(t)
  rememberBrowserSession(
    { id: 'work', tabId: 900, url: 'https://news.example.com/live' },
    { filePath },
  )
  const { dispatch, calls } = fakeExtension({
    snapshot: (params) => {
      if (params.reopened !== true) throw new Error(SAFARI_STALE_TAB)
      return { message: 'snapshot', tabId: 77, url: 'https://news.example.com/live' }
    },
    navigate: (params) => ({ message: 'Navigated', tabId: 77, url: params.url }),
  })
  /* Make the retry distinguishable from the first attempt. */
  const original = dispatch
  const wrapped = async (command) =>
    original(
      command.type === 'snapshot' && calls.length > 1
        ? { ...command, params: { ...command.params, reopened: true } }
        : command,
    )

  await runBrowserSessionAction(
    { type: 'snapshot', params: { session: 'work' } },
    { dispatch: wrapped, filePath },
  )

  assert.equal(calls[0].params.urlContains, 'https://news.example.com/live')
  assert.equal(calls[1].type, 'navigate')
  assert.equal(calls[1].params.url, 'https://news.example.com/live')
  assert.equal(getBrowserSession('work', { filePath }).tabId, 77)
})

test('an unnamed action retries the remembered page before opening a new one', async (t) => {
  const filePath = withTemporaryStore(t)
  rememberBrowserSession(
    { id: 'default', tabId: 500, url: 'https://example.com/' },
    { filePath },
  )
  const { dispatch, calls } = fakeExtension({
    click: (params) => {
      if (!params.urlContains) throw new Error(NO_TAB)
      return { message: 'clicked', tabId: 501, url: 'https://example.com/' }
    },
  })

  const result = await runBrowserSessionAction(
    { type: 'click', params: { selector: '#go' } },
    { dispatch, filePath },
  )

  /* Unnamed callers must still get the extension's own active-tab choice first. */
  assert.equal(calls[0].params.urlContains, undefined)
  assert.deepEqual(result.session.recovery, ['remembered_page'])
  assert.equal(calls.length, 2)
})

test('navigate recovers by opening its own tab', async (t) => {
  const filePath = withTemporaryStore(t)
  const { dispatch, calls } = fakeExtension({
    navigate: (params) => {
      if (params.newTab !== true) throw new Error(NO_TAB)
      return { message: 'Navigated', tabId: 8, url: 'https://example.com/' }
    },
  })

  const result = await runBrowserSessionAction(
    { type: 'navigate', params: { url: 'https://example.com' } },
    { dispatch, filePath },
  )

  assert.deepEqual(result.session.recovery, ['new_tab'])
  assert.equal(calls.length, 2)
})

test('an offline bridge is reported as unrecoverable and never bootstrapped', async (t) => {
  const filePath = withTemporaryStore(t)
  const { dispatch, calls } = fakeExtension({
    read_page: () => {
      throw new Error('Browser extension did not respond in time.')
    },
  })

  await assert.rejects(
    runBrowserSessionAction({ type: 'read_page', params: {} }, { dispatch, filePath }),
    (error) => {
      assert.ok(error instanceof BrowserOfflineError)
      assert.equal(error.code, 'browser_offline')
      assert.equal(error.recoverable, false)
      return true
    },
  )
  assert.equal(calls.length, 1)
})

test('classifyBrowserError separates a missing tab from a missing bridge', () => {
  const missing = classifyBrowserError(new Error(NO_TAB))
  assert.ok(missing instanceof BrowserTabMissingError)
  assert.equal(missing.recoverable, true)

  for (const message of [
    SAFARI_STALE_TAB,
    'No tab with id: 4242.',
    'The destination tab closed before it finished loading.',
  ]) {
    assert.ok(
      classifyBrowserError(new Error(message)) instanceof BrowserTabMissingError,
      message,
    )
  }

  assert.ok(
    classifyBrowserError(
      new Error('Browser extension did not respond in time.'),
    ) instanceof BrowserOfflineError,
  )

  /* Anything else is the page's problem and must reach the caller unchanged. */
  const other = new Error('Invalid CSS selector: #(')
  assert.equal(classifyBrowserError(other), other)
})

test('tabNeedle keeps the stable part of a URL', () => {
  assert.equal(
    tabNeedle('https://www.google.com/?zx=1786081086668'),
    'https://www.google.com/',
  )
  assert.equal(tabNeedle('https://example.com'), 'https://example.com/')
  assert.equal(tabNeedle('https://a.example/x/y?q=1#z'), 'https://a.example/x/y')
  assert.equal(tabNeedle(''), '')
  assert.equal(tabNeedle(null), '')
})

test('open_session adopts a matching open tab rather than opening another', async (t) => {
  const filePath = withTemporaryStore(t)
  const { dispatch, calls } = fakeExtension({
    list_tabs: () => ({
      tabs: [
        { tabId: 12, windowId: 3, url: 'https://mail.example.com/inbox', title: 'Inbox' },
        { tabId: 13, windowId: 3, url: 'https://example.com/', title: 'Example' },
      ],
    }),
  })

  const opened = await openBrowserSession(
    { session: 'mail', urlContains: 'mail.example.com' },
    { dispatch, filePath },
  )

  assert.equal(opened.origin, 'adopted')
  assert.equal(opened.tabId, 12)
  assert.equal(
    calls.some((call) => call.type === 'navigate'),
    false,
  )
  assert.equal(
    getBrowserSession('mail', { filePath }).url,
    'https://mail.example.com/inbox',
  )
})

test('open_session opens a tab when the browser has none', async (t) => {
  const filePath = withTemporaryStore(t)
  const { dispatch } = fakeExtension({
    list_tabs: () => ({ tabs: [] }),
    navigate: (params) => ({
      message: 'Navigated',
      tabId: 99,
      windowId: 4,
      url: params.url,
    }),
  })

  const opened = await openBrowserSession({ session: 'work' }, { dispatch, filePath })

  assert.equal(opened.origin, 'opened')
  assert.equal(opened.tabId, 99)
  assert.equal(listBrowserSessions({ filePath }).length, 1)
})

test('open_session refuses to invent a tab id that is not open', async (t) => {
  const filePath = withTemporaryStore(t)
  const { dispatch } = fakeExtension({
    list_tabs: () => ({ tabs: [{ tabId: 1, url: 'https://a.example/' }] }),
  })

  await assert.rejects(
    openBrowserSession({ session: 'work', tabId: 4242 }, { dispatch, filePath }),
    (error) => error instanceof BrowserTabMissingError,
  )
})

test('session names come from any of the accepted param spellings', () => {
  assert.deepEqual(resolveSessionRef({ session: 'a' }), { id: 'a', pinned: true })
  assert.deepEqual(resolveSessionRef({ sessionId: 'b' }), { id: 'b', pinned: true })
  assert.deepEqual(resolveSessionRef({ browserSession: 'c' }), {
    id: 'c',
    pinned: true,
  })
  assert.deepEqual(resolveSessionRef({}), { id: 'default', pinned: false })
  assert.deepEqual(resolveSessionRef({ session: '  ' }), {
    id: 'default',
    pinned: false,
  })
})

test('a tabId that arrived as JSON text still reaches the extension as a number', async (t) => {
  const filePath = withTemporaryStore(t)
  const { dispatch, calls } = fakeExtension({
    scroll: (params) => ({ message: 'scrolled', tabId: params.tabId }),
  })

  await runBrowserSessionAction(
    { type: 'scroll', params: { selector: '#end', tabId: '210031' } },
    { dispatch, filePath },
  )

  assert.equal(calls[0].params.tabId, 210031)
})

test('sessions are released by name and the store stays owner-only', async (t) => {
  const filePath = withTemporaryStore(t)
  rememberBrowserSession({ id: 'work', tabId: 1, url: 'https://a.example/' }, { filePath })
  rememberBrowserSession({ id: 'mail', tabId: 2, url: 'https://b.example/' }, { filePath })

  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
  assert.equal(forgetBrowserSession('work', { filePath }), true)
  assert.equal(forgetBrowserSession('work', { filePath }), false)
  assert.deepEqual(
    listBrowserSessions({ filePath }).map((session) => session.id),
    ['mail'],
  )
})
