/*
 * Runs in every page (manifest content_scripts, document_start): applies the owner's page rules for
 * this page (page-rules-core.js), straight from what the extension already has so the page never
 * flashes its old look, then asks the cloud board for this site's current rules. While a request the
 * owner just made here is still with Hive, it keeps asking, so the page changes the moment Hive's
 * rule lands, without a reload.
 */
import {
  BOARD_KEY,
  BOARD_URL,
  RULES_KEY,
  WAITING_KEY,
  keeps,
  rulesFor,
  siteOf,
  styleFor,
  validSelector,
} from './page-rules-core.js'

const api = globalThis.browser ?? globalThis.chrome
const site = siteOf(location.hostname)
const STYLE_ID = 'hive-page-rules'
const HIDDEN = 'data-hive-hidden'
let current = []
let observer = null
let pending = 0

function applyKeeps() {
  pending = 0
  for (const r of current) {
    for (const keep of r.rule?.keep || []) {
      if (!validSelector(keep.items)) continue
      let items
      try {
        items = document.querySelectorAll(keep.items)
      } catch {
        continue
      }
      for (const item of items) {
        const stay = keeps(item.textContent, keep.text || [])
        if (!stay && !item.hasAttribute(HIDDEN)) {
          item.setAttribute(HIDDEN, '')
          item.style.setProperty('display', 'none', 'important')
        } else if (stay && item.hasAttribute(HIDDEN)) {
          item.removeAttribute(HIDDEN)
          item.style.removeProperty('display')
        }
      }
    }
  }
}

function showAll() {
  for (const item of document.querySelectorAll(`[${HIDDEN}]`)) {
    item.removeAttribute(HIDDEN)
    item.style.removeProperty('display')
  }
}

function apply(rules) {
  current = rulesFor(rules, location.pathname)
  let style = document.getElementById(STYLE_ID)
  const css = styleFor(current)
  if (css) {
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      ;(document.head || document.documentElement).appendChild(style)
    }
    style.textContent = css
  } else if (style) {
    style.remove()
  }
  showAll()
  const keeping = current.some((r) => (r.rule?.keep || []).length)
  if (keeping) {
    applyKeeps()
    // Pages like Canvas draw their lists after load: hide new items as they appear.
    if (!observer) {
      observer = new MutationObserver(() => {
        if (!pending) pending = requestAnimationFrame(applyKeeps)
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }
  } else if (observer) {
    observer.disconnect()
    observer = null
  }
}

async function stored() {
  const got = await api.storage.local.get([RULES_KEY, BOARD_KEY, WAITING_KEY])
  return { rules: got[RULES_KEY] || {}, board: got[BOARD_KEY] || null, waiting: got[WAITING_KEY] || null }
}

async function ask(board, path) {
  const response = await fetch(`${board.url || BOARD_URL}${path}`, {
    headers: { authorization: `Bearer ${board.key}` },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`the board said ${response.status}`)
  return response.json()
}

/** This site's rules from the cloud, into storage (which applies them through onChanged). */
async function refresh() {
  const { rules, board } = await stored()
  if (!board?.key) return
  const answer = await ask(board, `/v1/page-rules?host=${encodeURIComponent(site)}`)
  const fresh = (answer.rules || []).map(({ id, path, title, rule, request }) => ({ id, path, title, rule, request }))
  if (JSON.stringify(fresh) !== JSON.stringify(rules[site] || [])) {
    await api.storage.local.set({ [RULES_KEY]: { ...rules, [site]: fresh } })
  }
}

/** While a request made on this site is with Hive, ask every few seconds until it's answered. */
async function follow() {
  for (;;) {
    const { board, waiting } = await stored()
    if (!board?.key || !waiting || waiting.site !== site || Date.now() > waiting.until) return
    try {
      const { request } = await ask(board, `/v1/requests/state?id=${waiting.request}`)
      if (request && (request.status === 'done' || request.status === 'failed')) {
        await refresh()
        const now = await stored()
        if (now.waiting?.request === waiting.request) {
          await api.storage.local.set({ [WAITING_KEY]: { ...waiting, status: request.status, outcome: request.outcome, until: 0 } })
        }
        return
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }
}

async function start() {
  if (!api?.storage?.local) return
  const { rules } = await stored()
  apply(rules[site] || [])
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes[RULES_KEY]) apply((changes[RULES_KEY].newValue || {})[site] || [])
    if (changes[WAITING_KEY]?.newValue?.site === site && changes[WAITING_KEY].newValue.until > Date.now()) follow()
  })
  refresh().catch(() => {})
  follow().catch(() => {})
}

start()
