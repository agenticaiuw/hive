import { AGENT_TOKEN, PORT } from './config.js'

/*
 * How to point at a page and keep pointing at it.
 *
 * Both "watch this page" and "fill this form" are the same three moves —
 * address a page, pull structured state out of it, say what changed or what is
 * ready — so the addressing lives here once instead of twice.
 *
 * The addressing is by URL, not by tab id, and that is not a preference. On
 * this Mac's Safari the extension hands out a *different* tab id on each wake:
 * two list_tabs calls one second apart returned 226923/229550/230928 and then
 * 226919/229546/230924 for the same three tabs, and a navigate that reported
 * tabId 230928 could not be read back through that id a moment later ("Invalid
 * call to tabs.get(). Tab not found."). A remembered tab id is therefore a
 * dead reference by the next command, while urlContains resolves against a
 * fresh tabs.query() every time and always lands on the right page.
 *
 * Everything here goes to the running agent over loopback HTTP rather than
 * importing the bridge directly. The bridge is being rewritten underneath us;
 * /execute is the contract that does not move.
 */

const AGENT_ORIGIN =
  process.env.LOCAL_AGENT_URL || `http://127.0.0.1:${PORT || 8000}`

/* A browser round trip is the extension's poll interval plus page load. */
const EXECUTE_TIMEOUT_MS = Number(
  process.env.PENDANT_BROWSER_EXECUTE_TIMEOUT_MS || 90_000,
)

/** The extension refuses anything else, and so should we before the trip. */
export function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(String(value)).protocol)
  } catch {
    return false
  }
}

/**
 * The stable half of a URL: host plus path, no scheme, no query.
 *
 * pickTargetTab does a lowercased substring match against the live tab URL, so
 * the needle has to survive the things a real page does to its own address —
 * appended tracking parameters, a session id in the query, http→https. Host and
 * path survive all three.
 */
export function tabNeedle(url) {
  const parsed = new URL(String(url))
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.host}${path}`.toLowerCase()
}

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(AGENT_TOKEN ? { Authorization: `Bearer ${AGENT_TOKEN}` } : {}),
  }
}

/**
 * Run browser actions through the agent's own /execute endpoint.
 *
 * Batched on purpose: every action costs one extension poll, so a navigate and
 * a read in one call is roughly half the wall clock of two calls.
 */
export async function runBrowserActions(
  actions,
  {
    command = 'browser page access',
    source = 'browser-page',
    timeoutMs = EXECUTE_TIMEOUT_MS,
    allow = null,
  } = {},
) {
  /*
   * A caller that promised the owner it would not touch the page passes its
   * allowlist here. This is not a permission system — nothing prompts, nothing
   * is refused that the owner asked for — it is how "don't click anything"
   * becomes impossible to get wrong later rather than a comment saying we
   * currently don't.
   */
  if (allow) {
    for (const action of actions) {
      const kind = String(action?.type ?? '').replace(/^browser_/, '')
      if (!allow.has(kind)) {
        throw new Error(
          `This task only reads the page; ${kind || 'that action'} is not one of the things it does.`,
        )
      }
    }
  }

  const response = await fetch(`${AGENT_ORIGIN}/execute`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ command, source, actions }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const payload = await response.json().catch(() => null)

  if (!response.ok && !Array.isArray(payload?.results)) {
    throw new Error(
      payload?.error || `The local agent refused the browser batch (${response.status}).`,
    )
  }

  return (payload?.results ?? []).map((result) => ({
    ok: Boolean(result?.ok),
    message: String(result?.message ?? ''),
    /* computerControl nests the extension's own payload under `browser`. */
    data: result?.browser ?? null,
    error: result?.ok ? null : String(result?.reason || result?.message || 'Browser action failed.'),
  }))
}

/** One action, unwrapped: the extension's result, or its error as a throw. */
export async function runBrowserAction(type, params = {}, options = {}) {
  const [result] = await runBrowserActions(
    [{ type: `browser_${type}`, label: options.label || type, params }],
    options,
  )
  if (!result) throw new Error('The local agent returned no result for the browser action.')
  if (!result.ok) throw new Error(result.error)
  return result.data ?? {}
}

export async function listBrowserTabs(options = {}) {
  const result = await runBrowserAction('list_tabs', { limit: 60 }, options)
  return Array.isArray(result?.tabs) ? result.tabs : []
}

/** Tabs already showing this page, most recently used first. */
export function matchTabs(tabs, url) {
  const needle = tabNeedle(url)
  return tabs.filter((tab) => String(tab?.url ?? '').toLowerCase().includes(needle))
}

/**
 * Make sure a tab is showing this URL and return how to address it afterwards.
 *
 * `reload` is what makes a watcher a watcher: a tab that is never re-fetched
 * shows the same status forever. It is still only a GET of the page the owner
 * named — the same thing pressing ⌘R would do.
 */
export async function addressPage(
  url,
  { reload = true, options = {} } = {},
) {
  if (!isHttpUrl(url)) {
    throw new Error(`Only http(s) pages can be addressed: ${String(url)}`)
  }

  const needle = tabNeedle(url)
  const before = await listBrowserTabs(options)
  const open = matchTabs(before, url)
  let disposition
  let after = before

  if (!open.length) {
    /* Nothing to reuse. navigate is the only command that can make a tab, and
     * with no tab at all every other command answers "No matching browser tab
     * is available" — verified live. */
    disposition = 'opened'
  } else if (reload) {
    /* urlContains keeps the reload in the tab that is already there instead of
     * stacking a new one on every poll. */
    disposition = 'reloaded'
  } else {
    disposition = 'reused'
  }

  if (disposition !== 'reused') {
    /* Navigate and re-list in one trip: the re-list is only there to catch a
     * redirect, and paying a second extension poll for it doubled the time a
     * watch spends holding the browser. */
    const [navigated, listed] = await runBrowserActions(
      [
        {
          type: 'browser_navigate',
          label: `open ${url}`,
          params:
            disposition === 'opened'
              ? { url, newTab: true }
              : { url, urlContains: needle },
        },
        { type: 'browser_list_tabs', label: 'confirm landing', params: { limit: 60 } },
      ],
      options,
    )
    if (!navigated?.ok) throw new Error(navigated?.error || `Could not open ${url}.`)
    after = Array.isArray(listed?.data?.tabs) ? listed.data.tabs : []
  }

  const landed = matchTabs(after, url)

  if (landed.length) {
    return {
      target: { urlContains: needle },
      url: landed[0].url ?? url,
      title: landed[0].title ?? '',
      disposition,
      ambiguous: landed.length > 1,
    }
  }

  /*
   * The page redirected somewhere else — a login wall, a country splash, a
   * shortened link. The active tab is still ours, so re-derive the address from
   * where we actually landed rather than failing on a needle that can no longer
   * match anything.
   */
  const active = after.find((tab) => tab.active) ?? after[0]
  if (!active?.url || !isHttpUrl(active.url)) {
    throw new Error(
      `The browser did not end up on ${url}, and no readable tab was left to fall back to.`,
    )
  }

  return {
    target: { urlContains: tabNeedle(active.url) },
    url: active.url,
    title: active.title ?? '',
    disposition,
    redirectedFrom: url,
    ambiguous: false,
  }
}

/*
 * The evidence capsule the agent minted for this reading, if it minted one.
 *
 * Callers do not mint their own. computerControl.js mints once, at the point
 * the extension answers, and everything downstream carries the id it was given
 * — otherwise the same page read once would end up as two capsules that
 * disagree about nothing, and "which evidence is this summary standing on"
 * would have two answers.
 */
export function evidenceIdOf(result) {
  return result?.evidence?.capsuleId ?? null
}

/** Page text in one of the extension's read modes. */
export async function readPageText(
  target,
  { mode = 'main_text', selector = null, maxChars = 12_000, options = {} } = {},
) {
  const result = await runBrowserAction(
    'read_page',
    {
      ...target,
      mode,
      ...(selector ? { selector } : {}),
      maxChars,
    },
    options,
  )
  return {
    content: String(result?.content ?? ''),
    title: String(result?.title ?? ''),
    url: String(result?.url ?? ''),
    capsuleId: evidenceIdOf(result),
  }
}

/** Interactive elements with refs the extension can act on later. */
export async function snapshotPage(target, { maxElements = 80, options = {} } = {}) {
  const result = await runBrowserAction(
    'snapshot',
    { ...target, maxElements },
    options,
  )
  return {
    elements: Array.isArray(result?.elements) ? result.elements : [],
    title: String(result?.title ?? ''),
    url: String(result?.url ?? ''),
    capsuleId: evidenceIdOf(result),
  }
}

/** Collapse the whitespace a page re-flows on every load; keep the words. */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A few words either side of a match, so a change report carries the sentence
 * it came from rather than a bare value the owner has to go and verify.
 */
export function excerptAround(text, needle, radius = 90) {
  const haystack = normalizeText(text)
  const target = normalizeText(needle)
  if (!haystack || !target) return ''
  const at = haystack.toLowerCase().indexOf(target.toLowerCase())
  if (at < 0) return haystack.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(haystack.length, at + target.length + radius)
  return `${start > 0 ? '…' : ''}${haystack.slice(start, end)}${end < haystack.length ? '…' : ''}`
}
