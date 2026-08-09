/*
 * Server-side browser harness — Cloudflare Browser Run "Quick Actions".
 *
 * WHY this exists: the pendant is worn, the Mac usually is not. Every browser
 * task today runs through the Safari extension on the owner's desk, so the
 * single most common situation — owner away from the Mac — is exactly the one
 * where web work cannot happen at all. This module gives the relay its own
 * headless browser inside Cloudflare, so a public page can be read with
 * nothing at home switched on.
 *
 * WHY it only reads public pages: that is a CAPABILITY boundary, not a
 * permission gate. The edge browser is a blank Chrome in a Cloudflare
 * datacenter. It holds none of the owner's cookies and sits on none of their
 * networks, so a logged-in dashboard or a box on the home LAN is not
 * "forbidden" — it is unreachable. Those tasks still belong to
 * browser_run_actions, which drives the Mac where the owner's sessions live.
 * Nothing here asks the owner for approval; it reports what the edge browser
 * can and cannot see.
 */

import { setTimeout as sleepMs } from 'node:timers/promises'

import { getCloudflareBindings } from './cloudflareBindings.js'

/** Quick Actions this harness can drive. Text first — the pendant speaks. */
export const BROWSER_ACTIONS = ['markdown', 'content', 'links']

const REST_BASE = 'https://api.cloudflare.com/client/v4/accounts'

/*
 * A page load plus render, not an API answer, so this is longer than the 15s
 * runWebSearch() allows itself. Cloudflare's own browser gives up well before
 * this; the ceiling only stops a wedged socket from holding a voice turn open.
 */
const DEFAULT_TIMEOUT_MS = 20_000

/*
 * Enough page for the model to answer from, small enough that a 20k-character
 * docs page cannot crowd a Realtime session's context out.
 */
const DEFAULT_MAX_CHARS = 12_000

/*
 * Invisible and bidi-override codepoints. Page text is untrusted input that
 * lands in a model prompt, and these are the characters used to hide text
 * from a human reader while leaving it perfectly visible to the model.
 * Stripping them means what the owner would see is what the model sees.
 */
const INVISIBLE_CHARS =
  /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** C0/C1 controls except tab and newline — never meaningful in page text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** Dotted-quad only; anything else numeric is handled as an obfuscated host. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/*
 * Suffixes that only ever resolve inside someone's own network. The edge
 * browser is not on that network, so these can only ever time out.
 */
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.lan']

function isPrivateIpv4(host) {
  const match = IPV4.exec(host)
  if (!match) return false
  const [a, b] = match.slice(1).map(Number)
  if (match.slice(1).some((part) => Number(part) > 255)) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast / reserved
  return false
}

function isPrivateIpv6(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!bare.includes(':')) return false
  if (bare === '::' || bare === '::1') return true
  if (/^f[cd]/.test(bare)) return true // fc00::/7 unique-local
  if (/^fe[89ab]/.test(bare)) return true // fe80::/10 link-local
  /*
   * ::ffff:127.0.0.1 smuggles a v4 address through a v6 literal, and the URL
   * parser rewrites it to the hex form (::ffff:7f00:1) before we ever see it —
   * so decode the hex pair back to dotted quad and judge that.
   */
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare)
  if (dotted) return isPrivateIpv4(dotted[1])
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare)
  if (hex) {
    const high = parseInt(hex[1], 16)
    const low = parseInt(hex[2], 16)
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return false
}

/**
 * Turn owner speech ("check example.com") into a URL the edge browser can
 * actually fetch, or explain which part of the public web it is not.
 */
export function normalizePublicUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) return { ok: false, reason: 'invalid-url', error: 'no URL given' }

  // Speech-to-text hands us bare hostnames far more often than full URLs.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`

  let url
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, reason: 'invalid-url', error: `not a URL: ${text}` }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'invalid-url',
      error: `${url.protocol} is not a web page`,
    }
  }

  /*
   * user:pass@host would ship the owner's credentials to Cloudflare's browser
   * in a URL. Credentials belong on the Mac, where the session already exists.
   */
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'not-public-web',
      error: 'URL carries embedded credentials',
    }
  }

  const host = url.hostname.toLowerCase()
  const bareHost = host.replace(/^\[|\]$/g, '')

  if (isPrivateIpv4(bareHost) || isPrivateIpv6(host)) {
    return { ok: false, reason: 'not-public-web', error: `${host} is a private address` }
  }
  if (host === 'localhost' || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: 'not-public-web', error: `${host} is a local name` }
  }
  /*
   * A bare number (2130706433) or a zero-padded octet (0177.0.0.1) is still a
   * valid IPv4 literal to a browser, and both of those decode to loopback.
   * Anything made only of digits and dots that is not a plain dotted quad is
   * one of those obfuscated forms — refuse it rather than out-parse Chrome.
   */
  if (/^[\d.]+$/.test(bareHost) && !IPV4.test(bareHost)) {
    return { ok: false, reason: 'not-public-web', error: `${host} is not a public hostname` }
  }
  // Single-label names ("router", "nas") only resolve on a local network.
  if (!bareHost.includes('.') && !bareHost.includes(':')) {
    return { ok: false, reason: 'not-public-web', error: `${host} is not a public hostname` }
  }

  return { ok: true, url: url.toString(), hostname: host }
}

/*
 * Markdown comes back with a YAML-ish front matter block carrying the page
 * title and meta description. Lift the title out and drop the block — the
 * model gets a clean document plus a real title instead of parsing YAML.
 */
function takeFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { title: '', body: text }
  const titleLine = /^title:\s*(.+)$/m.exec(match[1])
  const title = titleLine
    ? titleLine[1].trim().replace(/^["']|["']$/g, '').trim()
    : ''
  return { title, body: text.slice(match[0].length) }
}

/**
 * Make a rendered page safe and cheap to hand to the model: real title, no
 * hidden characters, no megabyte data: blobs, bounded length.
 */
export function sanitizePageText(raw, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const { title, body } = takeFrontMatter(String(raw || ''))

  let text = body
    .replace(INVISIBLE_CHARS, '')
    .replace(CONTROL_CHARS, '')
    // Inline base64 images are pure weight — keep the link, drop the payload.
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]*;base64,[A-Za-z0-9+/=]+/gi, 'data:[inline]')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const full = text.length
  let truncated = false
  if (full > maxChars) {
    truncated = true
    const cut = text.slice(0, maxChars)
    // Prefer a paragraph boundary, but never throw away most of the budget.
    const lastBreak = cut.lastIndexOf('\n')
    text = lastBreak > maxChars * 0.8 ? cut.slice(0, lastBreak) : cut
    text = text.trimEnd()
  }

  return {
    title: title.replace(INVISIBLE_CHARS, '').replace(CONTROL_CHARS, '').trim(),
    text,
    chars: text.length,
    truncated,
    sourceChars: full,
  }
}

/**
 * Cloudflare answers a rate limit with `Retry-After` in seconds. Returns null
 * when there is nothing usable, so callers do not invent a wait.
 */
export function parseRetryAfterMs(headerValue) {
  const value = String(headerValue ?? '').trim()
  if (!value) return null
  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? seconds * 1000 : null
  }
  const at = Date.parse(value)
  if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  return null
}

/*
 * A page that renders to a few words about signing in is not an answer — it
 * is the edge browser hitting the wall it can never climb. Spotting it lets
 * the model hand the task to the Mac instead of reading a login form aloud.
 */
const LOGIN_WALL = /\b(sign in|log in|login|signin|create an account|session expired|access denied|forbidden|verify you are human|enable javascript)\b/i

export function looksLikeLoginWall({ text, chars }) {
  if (chars > 900) return false
  return LOGIN_WALL.test(String(text || ''))
}

/**
 * Request body for a Quick Action. Shared by both transports so the binding
 * and the REST call cannot drift apart.
 */
export function quickActionBody(url, { action = 'markdown', gotoOptions } = {}) {
  const body = {
    url,
    /*
     * Markdown never needs pixels or webfonts, and every skipped request is
     * browser-seconds off a daily budget measured in minutes on the free plan.
     */
    rejectResourceTypes: ['image', 'font', 'media'],
    /*
     * Client-rendered pages hand back an empty document under the default
     * load event. networkidle2 costs a second or two and is the difference
     * between a real answer and "the page was blank".
     */
    gotoOptions: gotoOptions || { waitUntil: 'networkidle2' },
  }
  if (action === 'links') delete body.gotoOptions
  return body
}

function resolveCredentials(options) {
  const bindings = getCloudflareBindings() || {}
  const binding = options.binding || bindings.BROWSER || null
  const accountId =
    options.accountId ||
    bindings.CLOUDFLARE_ACCOUNT_ID ||
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    ''
  const apiToken =
    options.apiToken ||
    bindings.CLOUDFLARE_API_TOKEN ||
    process.env.CLOUDFLARE_API_TOKEN ||
    ''
  return { binding, accountId, apiToken }
}

/*
 * One Quick Action, either transport. The Workers binding is preferred
 * because inside the Worker it needs no API token at all; the REST call is
 * what the plain-node relay and the test harness use.
 */
async function callQuickAction(action, body, options) {
  const { binding, accountId, apiToken } = resolveCredentials(options)
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS

  if (binding && typeof binding.quickAction === 'function') {
    const response = await binding.quickAction(action, body)
    return { response, transport: 'binding' }
  }

  if (!accountId || !apiToken) {
    return { response: null, transport: 'none' }
  }

  const fetchImpl = options.fetchImpl || fetch
  const response = await fetchImpl(
    `${REST_BASE}/${accountId}/browser-rendering/${action}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    },
  )
  return { response, transport: 'rest' }
}

function headerOf(response, name) {
  try {
    return response?.headers?.get?.(name) ?? null
  } catch {
    return null
  }
}

/**
 * Read a public web page with Cloudflare's browser and hand back speakable
 * text. Never throws: a failure is a described result the model can voice.
 *
 * options.maxRateLimitWaitMs — the free plan allows one Quick Action every
 * ten seconds. A live voice turn must not stall that long, so the default is
 * 0: report the wait and let the owner ask again. Background jobs, which have
 * the time, can pass ~11000 to absorb it silently.
 */
export async function readPublicPage(rawUrl, options = {}) {
  const action = BROWSER_ACTIONS.includes(options.action) ? options.action : 'markdown'
  const target = normalizePublicUrl(rawUrl)
  if (!target.ok) {
    return {
      ok: false,
      reason: target.reason,
      error: target.error,
      requested: String(rawUrl || ''),
      hint:
        target.reason === 'not-public-web'
          ? 'The relay browser runs in Cloudflare, not on the owner\'s network — it cannot reach that address. Use browser_run_actions on the Mac.'
          : 'Ask the owner for a full web address.',
    }
  }

  const { binding, accountId, apiToken } = resolveCredentials(options)
  if (!binding && (!accountId || !apiToken)) {
    return {
      ok: false,
      reason: 'not-configured',
      url: target.url,
      error: 'Browser Run is not configured for this relay',
      hint: 'Server-side browsing is unavailable; use browser_run_actions on the Mac.',
    }
  }

  const body = quickActionBody(target.url, { action, gotoOptions: options.gotoOptions })
  const sleep = options.sleep || sleepMs
  const maxWaitMs = Math.max(0, Number(options.maxRateLimitWaitMs) || 0)

  let transport = 'none'
  let waited = false

  for (;;) {
    let response
    try {
      const call = await callQuickAction(action, body, options)
      response = call.response
      transport = call.transport
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      return {
        ok: false,
        reason: timedOut ? 'timeout' : 'transport-error',
        url: target.url,
        error: error?.message || 'browser request failed',
        hint: timedOut ? 'That page took too long to render.' : undefined,
      }
    }

    if (!response) {
      return {
        ok: false,
        reason: 'not-configured',
        url: target.url,
        error: 'Browser Run is not configured for this relay',
      }
    }

    const browserMs = Number(headerOf(response, 'x-browser-ms-used')) || 0

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(headerOf(response, 'retry-after')) ?? 10_000
      if (!waited && retryAfterMs > 0 && retryAfterMs <= maxWaitMs) {
        waited = true
        await sleep(retryAfterMs)
        continue
      }
      return {
        ok: false,
        reason: 'rate-limited',
        url: target.url,
        transport,
        rateLimited: true,
        retryAfterMs,
        error: 'Browser Run rate limit reached',
        hint: `The cloud browser allows one page every ${Math.ceil(retryAfterMs / 1000)}s on this plan — say the word and I will try again.`,
      }
    }

    const payload = await response.json?.().catch(() => null)

    if (!response.ok || !payload || payload.success === false) {
      const message =
        payload?.errors?.[0]?.message ||
        payload?.error ||
        `HTTP ${response.status}`
      return {
        ok: false,
        reason: 'http-error',
        url: target.url,
        transport,
        status: response.status,
        browserMs,
        error: String(message),
      }
    }

    if (action === 'links') {
      const links = Array.isArray(payload.result) ? payload.result.map(String) : []
      return {
        ok: true,
        action,
        url: target.url,
        transport,
        browserMs,
        links: links.slice(0, 100),
        source: 'cloudflare-browser-run',
        untrusted: true,
      }
    }

    const cleaned = sanitizePageText(payload.result, { maxChars: options.maxChars })
    if (!cleaned.chars) {
      return {
        ok: false,
        reason: 'empty',
        url: target.url,
        transport,
        browserMs,
        error: 'the page rendered no readable text',
        hint: 'It may need a sign-in or heavy scripting. Use browser_run_actions on the Mac.',
      }
    }

    const result = {
      ok: true,
      action,
      url: target.url,
      title: cleaned.title,
      text: cleaned.text,
      chars: cleaned.chars,
      truncated: cleaned.truncated,
      transport,
      browserMs,
      source: 'cloudflare-browser-run',
      /*
       * Flagged so the caller frames this as page content, never as
       * instructions: it is text a stranger wrote, read by a blank browser.
       */
      untrusted: true,
    }
    if (looksLikeLoginWall(cleaned)) {
      result.likelyLoginWall = true
      result.hint =
        'This looks like a sign-in wall. The cloud browser has no logged-in session — use browser_run_actions on the Mac for the real page.'
    }
    return result
  }
}

/**
 * Sixth Realtime tool. Deliberately narrow: fetch one named public page.
 * web_search still owns "look something up"; this owns "read that page".
 */
export const READ_WEB_PAGE_TOOL = {
  type: 'function',
  name: 'read_web_page',
  description:
    'PROACTIVE for reading a specific public web page without the Mac. Fetches one public URL with a cloud browser on the relay and returns its readable text — works when the Mac is asleep, closed, or offline. Use when: the owner names a page/site/article to read, or web_search returned a link whose contents you now need. Do NOT use when: the page needs the owner\'s login, is on their home network, or must be clicked/typed into — that browser has no sessions and no LAN access, so use browser_run_actions (Mac extension) instead. Do NOT use for open-ended lookups with no page in mind (web_search) or Mac state (get_mac_status). Read-only: it cannot click, type, or submit.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'Full public URL to read (a bare hostname like "example.com" is fine).',
      },
      spoken_reply: {
        type: 'string',
        description:
          'Short pendant confirmation (e.g. "Reading that page."). One sentence.',
      },
    },
    required: ['url'],
  },
}

/**
 * Tool-call shim: takes the model's arguments, returns the object that goes
 * straight into a function_call_output.
 */
export async function runReadWebPage(args = {}, options = {}) {
  return readPublicPage(args?.url, options)
}
