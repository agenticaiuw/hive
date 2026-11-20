/*
 * Page rules: how the owner asked Hive to make a web page look ("when I come to this page, show just
 * my five courses for this semester"). Hive's cloud agent writes each rule (cloud/vm-agent/
 * orchestrator.mjs handlePage) and the cloud board keeps it (/v1/page-rules); page-rules.js applies
 * the ones for the page in front of it every time a page loads, and again the moment one changes.
 *
 * A rule is declarative, never code, so the page runs nothing Hive didn't spell out:
 *   { hide: ["selector", ...],                       elements hidden outright
 *     keep: [{ items: "selector", text: ["..."] }],  of these items, only those containing a text stay
 *     css:  "...",                                   any other style
 *     go:   "/feed/subscriptions",                   this page opens that page of the same site instead
 *     add:  [{ after: "selector", text: "Watch later", href: "/playlist?list=WL" }],
 *                                                    a link (a.hive-added, styled by css) after or
 *                                                    before ("before": "selector") an element
 *     frames: "..." }                                style inside every frame of the page (a document
 *                                                    viewer, an embedded player), wherever it's from
 * (2026-11-17: the owner asked YouTube to open on Subscriptions and show Watch later in the sidebar,
 * and a rule could only hide and style, so Hive had to say it couldn't. 2026-11-19: the owner asked
 * for Canvas's PDF viewer to be truly dark, full screen too; it's a canvadocs iframe, a rule's CSS
 * stopped at it and the outline didn't even show it, so Hive said it couldn't: hence frames.)
 *
 * Everything here is pure, so node tests can run it; page-rules.js and ask-hive.js own the DOM.
 */

/** Where the extension keeps the rules it has (by site) and its key to the cloud board. */
export const RULES_KEY = 'hivePageRules'
export const BOARD_KEY = 'hiveBoard'
/** A request the owner just made on a site: the page polls the cloud until Hive answers it. */
export const WAITING_KEY = 'hivePageWaiting'
/**
 * The board's address, as Hive on this Mac handed it over with the key (the native "hive:key"
 * answer, kept under BOARD_KEY); '' until it has. The extension carries no address of its own, so
 * a build holds nobody's cloud, and a key is never sent to a guessed host.
 */
export function boardUrl(board) {
  try {
    const url = new URL(String(board?.url || ''))
    return url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

/** Hive's dashboard beside that board (hive-tasks.<account> → hive-dashboard.<account>); '' if unknown. */
export function dashboardUrl(board) {
  const base = boardUrl(board)
  if (!base) return ''
  const url = new URL(base)
  if (!url.hostname.startsWith('hive-tasks.')) return ''
  url.hostname = `hive-dashboard.${url.hostname.slice('hive-tasks.'.length)}`
  return `${url.origin}/`
}

/** Says why there's no call to make: Hive on this Mac hasn't given this browser its board yet. */
export const NO_BOARD = "Hive on this Mac hasn't connected this browser to its board yet"

export const siteOf = (hostname) => String(hostname || '').toLowerCase().replace(/^www\./, '')

const trimSlash = (path) => (String(path || '/').replace(/\/+$/, '') || '/')

/** The rules for one page: a rule for the whole site (path '') or for exactly this path. */
export function rulesFor(rules, pathname) {
  const here = trimSlash(pathname)
  return (Array.isArray(rules) ? rules : []).filter((r) => !r.path || trimSlash(r.path) === here)
}

/** The style sheet for these rules: their CSS and every hidden selector (add and go aren't style). */
export function styleFor(rules) {
  const parts = []
  for (const r of rules) {
    const rule = r.rule || {}
    const hide = (rule.hide || []).filter(validSelector)
    if (hide.length) parts.push(`${hide.join(',\n')} { display: none !important; }`)
    if (rule.css) parts.push(String(rule.css))
  }
  return parts.join('\n')
}

/** The style sheet a frame inside the page gets from these rules: their "frames" CSS. */
export function frameStyleFor(rules) {
  return rules.map((r) => r.rule?.frames).filter(Boolean).map(String).join('\n')
}

/**
 * The site of the page a frame is in (its rules are that page's): the top page's host, from the
 * frame's location.ancestorOrigins (the top one is last), else its referrer; '' when neither says.
 */
export function topSiteOf(ancestorOrigins, referrer) {
  const top = ancestorOrigins?.length ? ancestorOrigins[ancestorOrigins.length - 1] : referrer
  try {
    return siteOf(new URL(String(top || '')).hostname)
  } catch {
    return ''
  }
}

/** Whether a selector is safe to put in a style sheet (no braces to break out of the rule). */
export function validSelector(selector) {
  const s = String(selector || '').trim()
  return Boolean(s) && !/[{}<>]/.test(s) && s.length < 400
}

/** An address on the same site as `here` (a URL), or null: rules only ever lead within the site. */
export function sameSite(target, here) {
  try {
    const to = new URL(String(target || ''), here)
    if (!/^https?:$/.test(to.protocol) || siteOf(to.hostname) !== siteOf(new URL(here).hostname)) return null
    return to
  } catch {
    return null
  }
}

/**
 * Where this page should go instead, or null. Only a rule for one path can send the page on (a rule
 * for every page would send its own target on too), and never to the page it's on.
 */
export function goFor(rules, here) {
  const page = new URL(here)
  for (const r of rules) {
    if (!r.path || !r.rule?.go) continue
    const to = sameSite(r.rule.go, here)
    if (to && to.pathname + to.search !== page.pathname + page.search) return to.href
  }
  return null
}

/** The links these rules add, each checked: where (after or before a selector), its text and address. */
export function linksFor(rules, here) {
  const links = []
  for (const r of rules) {
    ;(r.rule?.add || []).forEach((add, i) => {
      const anchor = add?.after || add?.before
      const to = sameSite(add?.href, here)
      const text = String(add?.text || '').trim().slice(0, 80)
      if (!validSelector(anchor) || !to || !text) return
      links.push({ key: `${r.id ?? 'r'}-${i}`, where: add.after ? 'after' : 'before', anchor: String(anchor).trim(), text, href: to.href })
    })
  }
  return links
}

/** Whether an item stays under a keep: its text contains one of the texts (case doesn't matter). */
export function keeps(itemText, texts) {
  const t = String(itemText || '').toLowerCase()
  return texts.some((want) => t.includes(String(want).toLowerCase()))
}

/*
 * The page as an outline for the agent: one line per element worth naming, indented by depth,
 * `tag#id.class.class[attr] "its own text"`. A list of many alike items (a feed, a grid of cards)
 * shows its first two in full and every other one as a single line with its text, so a long page
 * still fits and what's further down it (YouTube's Shorts shelf below the first videos) is in it.
 * A custom element's own attributes are named, since sites mark kinds with them (is-shorts). An
 * iframe is one line naming the site it's from; run in every frame (ask-hive.js, allFrames) with
 * frameChars, a frame outlines itself too, under a heading naming its site, and the top page's
 * outline comes back as before.
 * This function runs inside the page (ask-hive.js passes it to scripting.executeScript), so it must
 * not use anything from this module.
 */
export function outlinePage(maxChars = 50000, frameChars = 0) {
  let inFrame = false
  try {
    inFrame = typeof window !== 'undefined' && window.top !== window
  } catch {
    inFrame = true
  }
  if (inFrame && !frameChars) return ''
  if (inFrame) maxChars = frameChars
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'TEMPLATE', 'LINK', 'META'])
  const hostOf = (address) => {
    try {
      return new URL(String(address || '')).hostname
    } catch {
      return ''
    }
  }
  const lines = []
  let size = 0
  const clean = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n)
  const ownText = (el) => {
    let t = ''
    for (const node of el.childNodes) if (node.nodeType === 3) t += node.textContent
    return clean(t, 80)
  }
  const classesOf = (el) => [...el.classList].filter((c) => c.length < 48).slice(0, 4)
  const attrsOf = (el) => (el.tagName.includes('-')
    ? [...el.attributes].map((a) => a.name)
      .filter((n) => !/^(id|class|style|role|tabindex|hidden|aria-|data-|on)/.test(n) && n.length < 30).slice(0, 3)
    : [])
  const head = (el, depth) => `${'  '.repeat(Math.min(depth, 20))}${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` +
    `${classesOf(el).map((c) => `.${c}`).join('')}${attrsOf(el).map((a) => `[${a}]`).join('')}`
  const shown = (el) => {
    if (skip.has(el.tagName)) return false
    const style = el.ownerDocument.defaultView.getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const push = (line) => {
    lines.push(line)
    size += line.length + 1
  }
  const walk = (el, depth) => {
    if (size > maxChars || !shown(el)) return
    if (el.tagName === 'IFRAME' || el.tagName === 'EMBED' || el.tagName === 'OBJECT') {
      const from = hostOf(el.src || el.data || el.getAttribute('src') || el.getAttribute('data'))
      const type = el.getAttribute('type') || ''
      push(`${head(el, depth)}${from ? ` [frame from ${from}]` : ''}${type ? ` [${type.slice(0, 40)}]` : ''}`)
      return
    }
    const text = ownText(el)
    const label = el.getAttribute('aria-label') || ''
    const named = el.id || classesOf(el).length || attrsOf(el).length || text || label
    let next = depth
    if (named) {
      push(`${head(el, depth)}${text ? ` "${text}"` : ''}${label && !text ? ` [${label.slice(0, 60)}]` : ''}`)
      next = depth + 1
    }
    // Alike siblings: same tag and classes. Past the first two of four or more, one line each.
    const kind = (child) => `${child.tagName}${classesOf(child).join('.')}`
    const counts = new Map()
    for (const child of el.children) counts.set(kind(child), (counts.get(kind(child)) || 0) + 1)
    const seen = new Map()
    for (const child of el.children) {
      if (size > maxChars) return
      const k = kind(child)
      const n = (seen.get(k) || 0) + 1
      seen.set(k, n)
      if (counts.get(k) >= 4 && n > 2) {
        if (shown(child)) push(`${head(child, next)} "${clean(child.textContent, 100)}"`)
      } else walk(child, next)
    }
  }
  if (inFrame) push(`--- inside a frame from ${location.hostname} (styled by the rule's "frames" CSS) ---`)
  if (document.body) walk(document.body, 0)
  return lines.join('\n').slice(0, maxChars)
}
