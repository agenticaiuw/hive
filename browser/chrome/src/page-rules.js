/*
 * Runs in every page (manifest content_scripts, document_start): applies the owner's page rules for
 * this page (page-rules-core.js), straight from what the extension already has so the page never
 * flashes its old look, then asks the cloud board for this site's current rules. While a request the
 * owner just made here is still with Hive, it keeps asking, so the page changes the moment Hive's
 * rule lands, without a reload. A rule can also send the page on to another page of the site (go) and
 * add links (add); sites like YouTube change pages without loading one, so a change of address
 * applies the new page's rules too. It runs in each frame of the page as well (a document viewer
 * from another site, like Canvas's canvadocs PDF viewer): there it applies only the rules' "frames"
 * CSS, the rules of the page the frame is in.
 */
import {
  BOARD_KEY,
  NO_BOARD,
  RULES_KEY,
  WAITING_KEY,
  boardUrl,
  frameStyleFor,
  goFor,
  keeps,
  linksFor,
  rulesFor,
  siteOf,
  styleFor,
  topSiteOf,
  validSelector,
} from './page-rules-core.js'
import { nodeHeaders } from './version.js'

const api = globalThis.browser ?? globalThis.chrome
const inFrame = (() => {
  try {
    return window.top !== window
  } catch {
    return true
  }
})()
/* In a frame, the site of the page it's in: Canvas's viewer frame is canvadocs, its rules Canvas's. */
const site = (inFrame && topSiteOf(location.ancestorOrigins, document.referrer)) || siteOf(location.hostname)
const STYLE_ID = 'hive-page-rules'
const HIDDEN = 'data-hive-hidden'
const ADDED = 'data-hive-add'
const WENT = 'hive-page-went'
let siteRules = []
let current = []
let links = []
let observer = null
let pending = 0
let address = location.href

/** Links the rules add, each once, where it belongs; any no rule asks for any more go. */
function applyAdds() {
  const keys = new Set(links.map((l) => l.key))
  for (const old of document.querySelectorAll(`[${ADDED}]`)) {
    if (!keys.has(old.getAttribute(ADDED))) old.remove()
  }
  for (const link of links) {
    if (document.querySelector(`[${ADDED}="${link.key}"]`)) continue
    let anchor = null
    try {
      anchor = document.querySelector(link.anchor)
    } catch {}
    if (!anchor) continue
    const a = document.createElement('a')
    a.className = 'hive-added'
    a.setAttribute(ADDED, link.key)
    a.href = link.href
    a.textContent = link.text
    // Dressed like the words next to it (a rule's CSS can't know the site's colours: YouTube's
    // --yt-spec-text-primary is gone, so its link came out black on black); !important overrides.
    const near = textOf(anchor)
    if (near) {
      const look = getComputedStyle(near)
      for (const name of ['color', 'font-family', 'font-size', 'font-weight', 'letter-spacing']) {
        a.style.setProperty(name, look.getPropertyValue(name))
      }
    }
    if (link.where === 'after') anchor.after(a)
    else anchor.before(a)
  }
}

/** The element holding an element's first visible words, whose look an added link copies. */
function textOf(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.trim() && node.parentElement?.getClientRects().length) return node.parentElement
  }
  return null
}

function tidy() {
  pending = 0
  applyKeeps()
  applyAdds()
}

/** Sends the page on when a rule says so, unless this page is where one just sent it (no loops). */
function goOn() {
  const to = goFor(current, location.href)
  if (!to) return false
  try {
    const went = JSON.parse(sessionStorage.getItem(WENT) || 'null')
    if (went && went.to === location.href && Date.now() - went.at < 5000) return false
    sessionStorage.setItem(WENT, JSON.stringify({ to, at: Date.now() }))
  } catch {}
  location.replace(to)
  return true
}

function applyKeeps() {
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

/** This page's style sheet from the rules ('' takes it away). */
function setStyle(css) {
  let style = document.getElementById(STYLE_ID)
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
}

function apply(rules) {
  siteRules = rules
  current = rulesFor(rules, location.pathname)
  if (goOn()) return
  setStyle(styleFor(current))
  showAll()
  links = linksFor(current, location.href)
  const watching = links.length || current.some((r) => (r.rule?.keep || []).length)
  tidy()
  if (watching) {
    // Pages like Canvas and YouTube draw their lists after load: tidy new items as they appear.
    if (!observer) {
      observer = new MutationObserver(() => {
        if (!pending) pending = requestAnimationFrame(tidy)
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    }
  } else if (observer) {
    observer.disconnect()
    observer = null
  }
}

/** A page that changes its address without loading (YouTube, Canvas) gets the new address's rules. */
function followAddress() {
  setInterval(() => {
    if (location.href === address) return
    address = location.href
    apply(siteRules)
  }, 400)
}

async function stored() {
  const got = await api.storage.local.get([RULES_KEY, BOARD_KEY, WAITING_KEY])
  return { rules: got[RULES_KEY] || {}, board: got[BOARD_KEY] || null, waiting: got[WAITING_KEY] || null }
}

async function ask(board, path) {
  const base = boardUrl(board)
  if (!base) throw new Error(NO_BOARD)
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${board.key}`, ...nodeHeaders(String(board.key).split('.')[1]) },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`the board said ${response.status}`)
  return response.json()
}

/** This site's rules from the cloud, into storage (which applies them through onChanged). */
async function refresh() {
  const { rules, board } = await stored()
  if (!board?.key || !boardUrl(board)) return
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

/*
 * In a frame only the rules' "frames" CSS applies: hiding, keeping, sending on and adding are the
 * page's, and the page keeps the rules fresh from the cloud, so a frame just follows storage. A rule
 * for one path needs the page's path, which a frame from another site can't read: the background
 * says the tab's address; without it, only the whole site's rules apply.
 */
let pagePath

async function framePath() {
  if (pagePath !== undefined) return pagePath
  pagePath = null
  try {
    const answer = await api.runtime.sendMessage({ type: 'hive:page' })
    const url = new URL(String(answer?.url || ''))
    if (siteOf(url.hostname) === site) pagePath = url.pathname
  } catch {}
  return pagePath
}

async function applyInFrame(rules) {
  const framed = (Array.isArray(rules) ? rules : []).filter((r) => r.rule?.frames)
  const path = framed.some((r) => r.path) ? await framePath() : null
  setStyle(frameStyleFor(path === null ? framed.filter((r) => !r.path) : rulesFor(framed, path)))
}

async function startInFrame() {
  const { rules } = await stored()
  await applyInFrame(rules[site] || [])
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[RULES_KEY]) applyInFrame((changes[RULES_KEY].newValue || {})[site] || [])
  })
}

async function start() {
  if (!api?.storage?.local) return
  if (inFrame) return startInFrame()
  const { rules } = await stored()
  apply(rules[site] || [])
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes[RULES_KEY]) apply((changes[RULES_KEY].newValue || {})[site] || [])
    if (changes[WAITING_KEY]?.newValue?.site === site && changes[WAITING_KEY].newValue.until > Date.now()) follow()
  })
  followAddress()
  refresh().catch(() => {})
  follow().catch(() => {})
}

start()
