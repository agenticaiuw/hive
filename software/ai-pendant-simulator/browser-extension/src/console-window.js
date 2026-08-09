/*
 * The pop-out console: the popup's whole UI, in a window Safari cannot close.
 *
 * Safari dismisses an extension popover on ANY outside click — platform
 * behavior, not a bug this extension can fix — which makes the popover a bad
 * place to watch a long command or to leave an approval card waiting. The
 * pin control opens console.html: the SAME page (same DOM ids, same popup.js,
 * same storage.local state), standing alone. Nothing here talks to
 * background.js — windows.create and tabs.create are callable from the popup
 * document itself, so the worker's surface is untouched.
 *
 * The mechanism is windows.create({type: 'popup'}), with fallbacks decided as
 * a TABLE (planConsoleOpen) rather than inline try/catch soup, because which
 * rung actually works varies by browser and can only be discovered at
 * runtime: Chrome honors type 'popup'; Safari has historically either ignored
 * the type (a plain window — fine, still persistent) or refused the call
 * outright, and when every window shape is refused a PINNED TAB is the
 * honest last resort — still a page that survives clicking elsewhere.
 *
 * EVERYTHING HERE IS PURE. The impure edge — the actual browser.windows /
 * browser.tabs calls — lives in popup.js, the same split every other module
 * in this directory uses.
 */

/* The standalone page. Ships as a real file (see package.mjs): entry-point
 * html, not a bundled-only module. */
export const CONSOLE_PAGE = 'console.html'

/* A popup-type window with no browser chrome wants to be exactly one column
 * of console. Height leaves room for a few history entries and a card. */
export const CONSOLE_WINDOW_WIDTH = 420
export const CONSOLE_WINDOW_HEIGHT = 680

/**
 * The windows.create payload. `type: 'popup'` is what drops the tab strip
 * and address bar in Chrome; browsers that do not honor it fall back to a
 * normal window, which is acceptable — persistence is the point, not chrome.
 */
export function consoleWindowOptions(url) {
  return {
    url,
    type: 'popup',
    width: CONSOLE_WINDOW_WIDTH,
    height: CONSOLE_WINDOW_HEIGHT,
    focused: true,
  }
}

/**
 * The fallback ladder for one open attempt, in order. Pure so the order is
 * a test, not an archaeology dig:
 *
 *   1. 'window'     — windows.create({type:'popup'}) (skipped entirely when
 *                     the API is absent, as it is in some Safari builds)
 *   2. 'pinned-tab' — tabs.create({pinned:true}); the rung that exists
 *                     because Safari may refuse windows.create at runtime
 */
export function planConsoleOpen({ hasWindows = false } = {}) {
  const attempts = []
  if (hasWindows) attempts.push({ how: 'window' })
  attempts.push({ how: 'pinned-tab' })
  return attempts
}

/**
 * Is this document the standalone console rather than the popover? The page
 * declares it on <body class="standalone"> so the answer never depends on
 * URL parsing, which Safari rewrites under the extension's own scheme.
 */
export function isStandaloneSurface(doc) {
  return Boolean(doc?.body?.classList?.contains('standalone'))
}

/**
 * Given the tabs that already show the console, the one to focus instead of
 * opening a duplicate — newest first, because the owner's most recent pop-out
 * is the one they arranged where they wanted it.
 */
export function existingConsoleTab(tabs) {
  const list = Array.isArray(tabs) ? tabs : []
  const usable = list.filter((tab) => tab && tab.id !== undefined && tab.id !== null)
  if (!usable.length) return null
  return usable[usable.length - 1]
}
