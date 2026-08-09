/*
 * The pop-out console's pure half.
 *
 * Two claims carry the feature: the open ladder always ends at a pinned tab
 * (Safari may refuse windows.create at runtime, and the fallback must exist
 * BEFORE the refusal is observed), and the standalone surface is declared by
 * the page itself rather than parsed out of a URL Safari rewrites.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONSOLE_PAGE,
  consoleWindowOptions,
  existingConsoleTab,
  isStandaloneSurface,
  planConsoleOpen,
} from '../src/console-window.js'

test('the console page is a real shipped file name, not a route', () => {
  assert.equal(CONSOLE_PAGE, 'console.html')
})

test('the window request asks for a popup-type window at a console-shaped size', () => {
  const options = consoleWindowOptions('chrome-extension://abc/console.html')
  assert.equal(options.url, 'chrome-extension://abc/console.html')
  assert.equal(options.type, 'popup')
  assert.ok(Number.isFinite(options.width) && options.width >= 360)
  assert.ok(Number.isFinite(options.height) && options.height >= 480)
  assert.equal(options.focused, true)
})

test('the open ladder tries a window first and ALWAYS keeps the pinned tab behind it', () => {
  assert.deepEqual(planConsoleOpen({ hasWindows: true }), [
    { how: 'window' },
    { how: 'pinned-tab' },
  ])
  /* Some Safari builds simply have no windows.create; the ladder must not
   * start with a rung that cannot exist. */
  assert.deepEqual(planConsoleOpen({ hasWindows: false }), [{ how: 'pinned-tab' }])
  assert.deepEqual(planConsoleOpen(), [{ how: 'pinned-tab' }])
})

test('an already-open console is focused, newest first, instead of duplicated', () => {
  assert.equal(existingConsoleTab([]), null)
  assert.equal(existingConsoleTab(undefined), null)
  const chosen = existingConsoleTab([
    { id: 3, windowId: 7 },
    { id: undefined },
    { id: 9, windowId: 8 },
  ])
  assert.equal(chosen.id, 9)
})

test('the standalone surface is declared on <body>, not inferred from the URL', () => {
  const standaloneDoc = {
    body: { classList: { contains: (name) => name === 'standalone' } },
  }
  const popoverDoc = { body: { classList: { contains: () => false } } }
  assert.equal(isStandaloneSurface(standaloneDoc), true)
  assert.equal(isStandaloneSurface(popoverDoc), false)
  assert.equal(isStandaloneSurface(null), false)
  assert.equal(isStandaloneSurface({}), false)
})
