/*
 * Page rules: how the owner asked Hive to make a web page look ("when I come to this page, show just
 * my five courses for this semester"). Hive's cloud agent writes each rule (cloud/vm-agent/
 * orchestrator.mjs handlePage) and the cloud board keeps it (/v1/page-rules); page-rules.js applies
 * the ones for the page in front of it every time a page loads, and again the moment one changes.
 *
 * A rule is declarative, never code, so the page runs nothing Hive didn't spell out:
 *   { hide: ["selector", ...],                       elements hidden outright
 *     keep: [{ items: "selector", text: ["..."] }],  of these items, only those containing a text stay
 *     css:  "..." }                                  any other style
 *
 * Everything here is pure, so node tests can run it; page-rules.js and ask-hive.js own the DOM.
 */

/** Where the extension keeps the rules it has (by site) and its key to the cloud board. */
export const RULES_KEY = 'hivePageRules'
export const BOARD_KEY = 'hiveBoard'
/** A request the owner just made on a site: the page polls the cloud until Hive answers it. */
export const WAITING_KEY = 'hivePageWaiting'
export const BOARD_URL = 'https://hive-tasks.your-subdomain.workers.dev'

export const siteOf = (hostname) => String(hostname || '').toLowerCase().replace(/^www\./, '')

const trimSlash = (path) => (String(path || '/').replace(/\/+$/, '') || '/')

/** The rules for one page: a rule for the whole site (path '') or for exactly this path. */
export function rulesFor(rules, pathname) {
  const here = trimSlash(pathname)
  return (Array.isArray(rules) ? rules : []).filter((r) => !r.path || trimSlash(r.path) === here)
}

/** The style sheet for these rules: their CSS and every hidden selector. */
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

/** Whether a selector is safe to put in a style sheet (no braces to break out of the rule). */
export function validSelector(selector) {
  const s = String(selector || '').trim()
  return Boolean(s) && !/[{}<>]/.test(s) && s.length < 400
}

/** Whether an item stays under a keep: its text contains one of the texts (case doesn't matter). */
export function keeps(itemText, texts) {
  const t = String(itemText || '').toLowerCase()
  return texts.some((want) => t.includes(String(want).toLowerCase()))
}

/*
 * The page as an outline for the agent: one line per element worth naming, indented by depth,
 * `tag#id.class.class "its own text"`. This function runs inside the page (ask-hive.js passes it to
 * scripting.executeScript), so it must not use anything from this module.
 */
export function outlinePage(maxChars = 50000) {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'TEMPLATE', 'IFRAME', 'LINK', 'META'])
  const lines = []
  let size = 0
  const ownText = (el) => {
    let t = ''
    for (const node of el.childNodes) if (node.nodeType === 3) t += node.textContent
    return t.replace(/\s+/g, ' ').trim().slice(0, 80)
  }
  const walk = (el, depth) => {
    if (size > maxChars || skip.has(el.tagName)) return
    const style = el.ownerDocument.defaultView.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return
    const classes = [...el.classList].filter((c) => c.length < 48).slice(0, 4)
    const text = ownText(el)
    const label = el.getAttribute('aria-label') || ''
    const named = el.id || classes.length || text || label
    let next = depth
    if (named) {
      const line = `${'  '.repeat(Math.min(depth, 20))}${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}` +
        `${classes.map((c) => `.${c}`).join('')}${text ? ` "${text}"` : ''}${label && !text ? ` [${label.slice(0, 60)}]` : ''}`
      lines.push(line)
      size += line.length + 1
      next = depth + 1
    }
    for (const child of el.children) walk(child, next)
  }
  if (document.body) walk(document.body, 0)
  return lines.join('\n').slice(0, maxChars)
}
