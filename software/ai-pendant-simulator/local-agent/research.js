import { requestLlmMessages } from './llmPlanner.js'
import { AGENT_TOKEN, PORT } from './config.js'
import {
  clampSpokenToBudget,
  parseSpokenBudget,
  spokenBudgetPromptRule,
} from './spokenBudget.js'

/*
 * Research the owner is not waiting for.
 *
 * Four of the capabilities the agents kept re-proposing are the same job with
 * different nouns: "research this and send me a cited answer later", "leave me
 * a source-linked briefing with an audio version", "compare the best options
 * and leave me an audio recommendation", "summarize this page and read it to
 * me later". All four are: go read things, then hand back something the owner
 * consumes on their own schedule.
 *
 * Two things make this different from the voice path and both are load-bearing:
 *
 * 1. Nobody is waiting, so it runs on the cheap text tier (LLM_MODEL) and the
 *    production web search — never Realtime. Realtime exists to keep a person
 *    from sitting in silence; there is no person sitting here.
 * 2. "Check the sources" is in the owner's own words, so a source is not a
 *    source until it has been fetched and read. A URL the model emitted and
 *    nothing ever opened is a citation-shaped guess, and shipping those in a
 *    briefing the owner will act on is worse than shipping fewer facts.
 */

/* Reading the page is the check. Slower than a HEAD, but a 200 that renders a
 * cookie wall is not a source, and only the body text tells you that. */
const SOURCE_FETCH_TIMEOUT_MS = Number(
  process.env.PENDANT_RESEARCH_FETCH_TIMEOUT_MS || 12_000,
)
const SOURCE_TEXT_MAX_CHARS = 6_000
const SOURCE_BODY_MAX_BYTES = 3_000_000
const MIN_USEFUL_SOURCE_CHARS = 300
const DEFAULT_MAX_SOURCES = 6

/* Sites that answer a bot with a login wall or an anti-scrape page. Their URLs
 * still appear in the note as "seen but not read" — silently dropping them
 * would misrepresent how wide the search actually went. */
const UNREADABLE_STATUS = new Set([401, 402, 403, 405, 429, 451])

/* Some search backends staple their own attribution parameter onto every URL.
 * Left in, the same page arrives twice under two spellings. */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'ref_src',
]

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export const RESEARCH_MODES = new Set(['brief', 'compare', 'page'])

/*
 * The production web search lives in the relay module, and it is loaded on
 * first use rather than at import time. That module is enormous and pulls in
 * the whole Realtime front door; making the Mac agent's research path depend
 * on it parsing cleanly means an unrelated edit over there takes this down
 * with it, at import, before any code runs. Deferring it also keeps the cost
 * off every process that merely imports research.js — the CLI, the tests, and
 * the executor's dispatch table all do.
 */
export async function defaultWebSearch(query) {
  const { runWebSearch } = await import('../cloud-relay/openaiRealtimeVoice.js')
  return runWebSearch(query)
}

/*
 * The owner said "don't buy anything" out loud, which means it is a thing the
 * product does, not a prompt the owner has to keep repeating. Research reads
 * and recommends; it never has a way to transact, because no code path here
 * takes an action on a page. This list is the belt to that suspenders: it
 * catches a model that starts narrating itself into a purchase, so the failure
 * shows up in a test rather than in a briefing that claims an order was placed.
 */
const TRANSACTION_CLAIM =
  /\b(i|we)\s+(have\s+)?(bought|purchased|ordered|booked|reserved|subscribed|paid|checked\s+out)\b|\b(order|purchase|booking|payment)\s+(has\s+been\s+)?(placed|completed|confirmed|submitted)\b/i

export class TransactionAttemptError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TransactionAttemptError'
  }
}

/** Strip the parts of a page that are furniture, then flatten to plain text. */
export function extractReadableText(html) {
  const source = String(html ?? '')
  if (!source) return { title: '', text: '' }

  const titleMatch = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = decodeEntities(String(titleMatch?.[1] ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)

  const body = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    /* Block tags become newlines so headings do not fuse onto the paragraph
     * below them; the model reads the seams as structure. */
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const text = decodeEntities(body)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()

  return { title, text }
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity) => {
      const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        mdash: '—',
        ndash: '–',
        hellip: '…',
        rsquo: '’',
        lsquo: '‘',
        ldquo: '“',
        rdquo: '”',
      }[entity.toLowerCase()]
      if (named) return named
      if (entity[0] !== '#') return whole
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    })
}

/** Pull every http(s) URL out of search prose and normalize it for dedupe. */
export function harvestSourceUrls(texts, { maxSources = DEFAULT_MAX_SOURCES } = {}) {
  const byKey = new Map()

  for (const text of Array.isArray(texts) ? texts : [texts]) {
    for (const match of String(text ?? '').matchAll(
      /https?:\/\/[^\s)\]<>"'`]+/g,
    )) {
      /* Markdown link punctuation clings to the end of the match. */
      const raw = match[0].replace(/[.,;:!?)\]}>'"]+$/, '')
      let url
      try {
        url = new URL(raw)
      } catch {
        continue
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      for (const param of TRACKING_PARAMS) url.searchParams.delete(param)
      url.hash = ''
      const key = `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`
      if (byKey.has(key)) continue
      byKey.set(key, { url: url.toString(), host: url.hostname })
    }
  }

  /* One page per host: five links into the same review site read as five
   * sources in a citation list while being one editorial opinion. */
  const seenHosts = new Set()
  const sources = []
  for (const entry of byKey.values()) {
    const host = entry.host.replace(/^www\./, '')
    if (seenHosts.has(host)) continue
    seenHosts.add(host)
    sources.push(entry)
    if (sources.length >= maxSources) break
  }
  return sources
}

/**
 * Fetch one candidate and decide whether it is really a source. Never throws:
 * an unreachable page is a result about that page, not a failed research run.
 */
export async function checkSource(url, { fetchImpl = fetch, signal = null } = {}) {
  const checkedAt = new Date().toISOString()
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: signal ?? AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })

    const contentType = String(
      response.headers?.get?.('content-type') || '',
    ).toLowerCase()

    if (!response.ok) {
      return {
        url,
        ok: false,
        status: response.status,
        checkedAt,
        title: '',
        text: '',
        error: UNREADABLE_STATUS.has(response.status)
          ? `blocked automated readers (HTTP ${response.status})`
          : `HTTP ${response.status}`,
      }
    }

    if (contentType && !/text\/|xml|json/.test(contentType)) {
      return {
        url,
        ok: false,
        status: response.status,
        checkedAt,
        title: '',
        text: '',
        error: `not a readable document (${contentType.split(';')[0]})`,
      }
    }

    const body = (await response.text()).slice(0, SOURCE_BODY_MAX_BYTES)
    const { title, text } = /json/.test(contentType)
      ? { title: '', text: body }
      : extractReadableText(body)

    if (text.length < MIN_USEFUL_SOURCE_CHARS) {
      return {
        url,
        ok: false,
        status: response.status,
        checkedAt,
        title,
        text: '',
        error: 'page had no readable body text',
      }
    }

    return {
      url,
      ok: true,
      status: response.status,
      checkedAt,
      title: title || new URL(url).hostname,
      text: text.slice(0, SOURCE_TEXT_MAX_CHARS),
      chars: text.length,
    }
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      checkedAt,
      title: '',
      text: '',
      error: String(error?.message || error).slice(0, 160),
    }
  }
}

/**
 * Angles to search from. The owner gives one topic; one query answers the
 * topic as the model already believes it, which is how a "briefing" ends up
 * being one blog post laundered through three paragraphs.
 */
export function fallbackQueries(topic, mode) {
  const subject = String(topic ?? '').trim()
  if (mode === 'compare') {
    return [
      `best ${subject} 2026 comparison`,
      `${subject} review pros and cons`,
      `${subject} problems complaints to avoid`,
    ]
  }
  return [
    subject,
    `${subject} latest news 2026`,
    `${subject} criticism limitations evidence`,
  ]
}

export async function planSearchQueries(
  topic,
  mode,
  { llm = requestLlmMessages } = {},
) {
  try {
    const raw = await llm({
      maxTokens: 300,
      messages: [
        {
          role: 'system',
          content:
            'You plan web research. Return ONLY JSON: {"queries":["...","...","..."]}. ' +
            'Exactly three short search-engine queries that attack the topic from ' +
            'different angles (what it is, current state, the counter-case or the ' +
            'downsides). No prose, no numbering.',
        },
        { role: 'user', content: `Topic: ${topic}\nGoal: ${mode} briefing` },
      ],
    })
    const queries = JSON.parse(raw)?.queries
    const cleaned = (Array.isArray(queries) ? queries : [])
      .map((query) => String(query ?? '').trim())
      .filter(Boolean)
      .slice(0, 3)
    if (cleaned.length) return cleaned
  } catch {
    /* The planner is an optimisation over three canned angles, never a gate. */
  }
  return fallbackQueries(topic, mode)
}

/**
 * Search, then actually open what came back. Returns the raw search prose
 * (useful context on its own) alongside every source and its check result.
 */
export async function gatherSources({
  topic,
  mode = 'brief',
  maxSources = DEFAULT_MAX_SOURCES,
  search = defaultWebSearch,
  fetchImpl = fetch,
  llm = requestLlmMessages,
  onProgress = null,
} = {}) {
  const queries = await planSearchQueries(topic, mode, { llm })
  onProgress?.({ phase: 'search', queries })

  const searches = await Promise.all(
    queries.map(async (query) => {
      try {
        return await search(query)
      } catch (error) {
        return { ok: false, query, error: String(error?.message || error) }
      }
    }),
  )

  const overview = searches
    .filter((result) => result?.ok && result.summary)
    .map((result) => `Q: ${result.query}\n${result.summary}`)
    .join('\n\n')

  const candidates = harvestSourceUrls(
    searches.map((result) => result?.summary || ''),
    { maxSources },
  )
  onProgress?.({ phase: 'check', count: candidates.length })

  const sources = await Promise.all(
    candidates.map((candidate) => checkSource(candidate.url, { fetchImpl })),
  )

  return {
    queries,
    overview,
    searchFailures: searches
      .filter((result) => !result?.ok)
      .map((result) => result?.error || 'search failed'),
    sources,
  }
}

/** Number only what was read: a citation index must point at a real page. */
export function readableSources(sources) {
  return (Array.isArray(sources) ? sources : []).filter((source) => source?.ok)
}

const MODE_GOALS = {
  brief:
    'Write a short factual briefing. Lead with what changed or what is true now.',
  compare:
    'Compare the realistic options against each other. End with one recommendation ' +
    'and say plainly what would change it. You are advising, not buying: never ' +
    'claim anything was ordered, booked, reserved or paid for.',
  page:
    'Summarize the key points of the supplied page(s) for someone who will hear ' +
    'this and not see the screen.',
}

/*
 * The standing spoken-length rule. Unchanged, and used verbatim whenever the
 * owner said nothing about length — a command with no length instruction must
 * produce the same prompt, byte for byte, that it produced before this feature
 * existed. spokenBudget.test.js asserts exactly that against the captured
 * pre-change string.
 */
const SPOKEN_RULE_DEFAULT =
  '- 3 to 6 keyPoints. "spoken" is 150-320 words of plain spoken English: no markdown, no URLs, no bullet characters, no "click here". Name outlets by name ("according to TechRadar") instead of reading links.'

/* Same rule with the word count removed, so the budget below is the only thing
 * in the prompt saying how long the script may be. Everything that is about
 * QUALITY rather than length — no markdown, no URLs, name the outlets, and the
 * 3-to-6 keyPoint count that belongs to the WRITTEN brief — is kept. */
const SPOKEN_RULE_BUDGETED =
  '- 3 to 6 keyPoints. "spoken" is plain spoken English: no markdown, no URLs, no bullet characters, no "click here". Name outlets by name ("according to TechRadar") instead of reading links.'

export async function composeBrief({
  topic,
  mode = 'brief',
  overview = '',
  sources = [],
  llm = requestLlmMessages,
  /*
   * The length the owner asked for out loud, or null for "they didn't". Parsed
   * once in researchTopic() and handed down; see spokenBudget.js for why the
   * parse lives there and not in the planner.
   */
  spokenBudget = null,
} = {}) {
  const readable = readableSources(sources)
  const corpus = readable
    .map(
      (source, index) =>
        `[${index + 1}] ${source.title}\nURL: ${source.url}\n${source.text}`,
    )
    .join('\n\n---\n\n')

  const raw = await llm({
    maxTokens: 1600,
    messages: [
      {
        role: 'system',
        content: `You write briefings that are READ ALOUD to their owner later. ${
          MODE_GOALS[mode] || MODE_GOALS.brief
        }

Return ONLY JSON:
{
  "headline": "one sentence, under 100 characters",
  "keyPoints": [{"point": "one sentence", "sources": [1, 2]}],
  "recommendation": "one or two sentences, or empty string",
  "openQuestions": ["what the sources did not settle"],
  "spoken": "the script to read aloud"
}

Rules:
- Every keyPoint cites at least one source number from the numbered sources below. Never cite a number that is not there.
- If the sources do not support a claim, leave it out and add it to openQuestions instead.
${
  spokenBudget
    ? `${SPOKEN_RULE_BUDGETED}\n${spokenBudgetPromptRule(spokenBudget)}`
    : SPOKEN_RULE_DEFAULT
}
- You cannot buy, book, order or pay for anything and you never claim to have done so. Recommending is the whole job.`,
      },
      {
        role: 'user',
        content: [
          `Topic: ${topic}`,
          overview ? `Search overview:\n${overview}` : '',
          corpus
            ? `Numbered sources that were fetched and read:\n\n${corpus}`
            : 'No sources could be read. Say so plainly and keep keyPoints empty.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
  })

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('The briefing model did not return JSON.')
  }

  const brief = {
    headline: String(parsed?.headline ?? '').trim().slice(0, 200),
    keyPoints: (Array.isArray(parsed?.keyPoints) ? parsed.keyPoints : [])
      .map((entry) => ({
        point: String(entry?.point ?? '').trim(),
        /* Drop citations that point past the end of what was read — an index
         * the owner cannot follow is indistinguishable from an invented one. */
        sources: (Array.isArray(entry?.sources) ? entry.sources : [])
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= readable.length),
      }))
      .filter((entry) => entry.point),
    recommendation: String(parsed?.recommendation ?? '').trim(),
    openQuestions: (Array.isArray(parsed?.openQuestions)
      ? parsed.openQuestions
      : []
    )
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean),
    spoken: String(parsed?.spoken ?? '').trim(),
  }

  assertNoTransactionClaim(brief)
  return brief
}

export function assertNoTransactionClaim(brief) {
  const text = [
    brief?.headline,
    brief?.recommendation,
    brief?.spoken,
    ...(brief?.keyPoints || []).map((entry) => entry?.point),
  ]
    .filter(Boolean)
    .join(' ')

  if (TRANSACTION_CLAIM.test(text)) {
    throw new TransactionAttemptError(
      'The briefing claimed a purchase or booking was made. Research recommends; it never transacts.',
    )
  }
  return true
}

/** The written artifact. Citations carry the URL so "check the sources" works. */
export function renderBriefMarkdown({
  topic,
  mode = 'brief',
  brief,
  sources = [],
  queries = [],
  generatedAt = new Date().toISOString(),
  audio = null,
}) {
  const readable = readableSources(sources)
  const unreadable = (sources || []).filter((source) => !source?.ok)
  const cite = (numbers) =>
    numbers?.length ? ` [${numbers.map((n) => `^${n}`).join('][')}]` : ''

  const lines = [
    `# ${topic}`,
    '',
    `*${mode === 'compare' ? 'Comparison' : mode === 'page' ? 'Page summary' : 'Research briefing'} — ${new Date(generatedAt).toLocaleString()}*`,
    '',
    brief?.headline ? `**${brief.headline}**` : '',
    '',
  ]

  if (brief?.keyPoints?.length) {
    lines.push('## Key points', '')
    for (const entry of brief.keyPoints) {
      lines.push(`- ${entry.point}${cite(entry.sources)}`)
    }
    lines.push('')
  }

  if (brief?.recommendation) {
    lines.push(
      '## Recommendation',
      '',
      brief.recommendation,
      '',
      /* Said in the artifact, not just in the prompt: the owner reading this
       * later should not have to wonder whether the agent acted on it. */
      '*Nothing was bought, booked or ordered — this is a recommendation only.*',
      '',
    )
  }

  if (brief?.openQuestions?.length) {
    lines.push('## Still open', '')
    for (const question of brief.openQuestions) lines.push(`- ${question}`)
    lines.push('')
  }

  lines.push('## Sources', '')
  if (readable.length) {
    readable.forEach((source, index) => {
      lines.push(
        `${index + 1}. [${source.title || source.url}](${source.url}) — read ${new Date(source.checkedAt).toLocaleTimeString()}, HTTP ${source.status}`,
      )
    })
  } else {
    lines.push('_No source could be fetched and read._')
  }
  lines.push('')

  if (unreadable.length) {
    lines.push('### Seen but not read', '')
    for (const source of unreadable) {
      lines.push(`- ${source.url} — ${source.error}`)
    }
    lines.push('')
  }

  if (audio?.path) {
    lines.push(
      '## Audio',
      '',
      `\`${audio.path}\`${audio.seconds ? ` — ${audio.seconds}s` : ''}`,
      '',
    )
  }

  if (queries.length) {
    lines.push(
      '---',
      '',
      `<sub>Searched: ${queries.map((q) => `“${q}”`).join(', ')}</sub>`,
      '',
    )
  }

  return lines.filter((line) => line !== undefined).join('\n')
}

/**
 * What the pendant reads out. Falls back to the written points if needed.
 *
 * This is THE spoken script — the only artifact a stated length budget applies
 * to. The markdown note built by renderBriefMarkdown() above shares no text
 * with it (headline, keyPoints, recommendation, openQuestions and the full
 * source list are written there in full), so capping this can never gut the
 * filed brief. That separation is the reason the budget can be honoured here
 * at all.
 *
 * THE PREFACE IS PART OF THE LENGTH. "Here's your briefing on <topic>. I read
 * 1 source." was 130 characters and roughly 7 seconds in the live 2026-08-09
 * run, and the topic it repeats is the owner's entire command. Asked for three
 * sentences, two of them would be that. So under a budget the preface is
 * dropped and the script opens on the news itself — which is also what the
 * composer is told to write. Without a budget it is unchanged.
 */
export function spokenScript({ topic, brief, sources = [], spokenBudget = null }) {
  const spoken = String(brief?.spoken ?? '').trim()
  const readCount = readableSources(sources).length
  const preface = spokenBudget
    ? ''
    : `Here's your briefing on ${topic}. I read ${readCount} source${
        readCount === 1 ? '' : 's'
      }.`
  const lead = preface ? `${preface} ` : ''

  if (spoken) return clampSpokenToBudget(`${lead}${spoken}`, spokenBudget)

  const points = (brief?.keyPoints || []).map((entry) => entry.point)
  if (!points.length) {
    return clampSpokenToBudget(
      `${lead}I couldn't read enough to say anything useful. The note on your Mac lists what I tried.`,
      spokenBudget,
    )
  }
  const tail = brief?.recommendation ? ` My recommendation: ${brief.recommendation}` : ''
  return clampSpokenToBudget(`${lead}${points.join(' ')}${tail}`, spokenBudget)
}

/*
 * Reading the owner's own open tabs, rather than the public web.
 *
 * Two of the asks are explicitly about pages the owner already has open ("the
 * relevant pages in my open browser tabs", "summarize this page"). Those live
 * behind their logins, so the public fetch path cannot see them — only the
 * extension, in the owner's real profile, can. It is driven over the agent's
 * own HTTP surface on purpose: the browser tier owns tab selection and
 * recovery, and a second caller reaching into it directly would be a second
 * place for that logic to drift.
 */
export async function readOpenTabs({
  match = '',
  maxTabs = 4,
  agentFetch = callAgent,
} = {}) {
  const listed = await agentFetch('/execute', {
    command: 'research: list open tabs',
    source: 'research',
    actions: [
      { type: 'browser_list_tabs', label: 'List open browser tabs', params: {} },
    ],
  })

  const tabs = (browserPayload(listed)?.tabs || [])
    .map((tab) => ({
      tabId: tab?.tabId ?? tab?.id ?? null,
      url: String(tab?.url ?? ''),
      title: String(tab?.title ?? ''),
    }))
    .filter((tab) => /^https?:/.test(tab.url))

  const needle = String(match ?? '').trim().toLowerCase()
  const wanted = (
    needle
      ? tabs.filter((tab) =>
          `${tab.title} ${tab.url}`.toLowerCase().includes(needle),
        )
      : tabs
  ).slice(0, maxTabs)

  const sources = []
  for (const tab of wanted) {
    const read = await agentFetch('/execute', {
      command: `research: read ${tab.url}`,
      source: 'research',
      actions: [
        {
          type: 'browser_read_page',
          label: `Read ${tab.title || tab.url}`,
          params: { mode: 'main_text', maxChars: SOURCE_TEXT_MAX_CHARS, tabId: tab.tabId },
        },
      ],
    })
    const payload = browserPayload(read) ?? {}
    const text = String(payload.content ?? '').trim()
    sources.push(
      text.length >= MIN_USEFUL_SOURCE_CHARS
        ? {
            url: tab.url,
            ok: true,
            status: 200,
            checkedAt: new Date().toISOString(),
            title: payload.title || tab.title || tab.url,
            text: text.slice(0, SOURCE_TEXT_MAX_CHARS),
            chars: text.length,
            via: 'browser',
          }
        : {
            url: tab.url,
            ok: false,
            status: 0,
            checkedAt: new Date().toISOString(),
            title: tab.title || '',
            text: '',
            error: read?.results?.[0]?.reason || 'tab had no readable text',
            via: 'browser',
          },
    )
  }

  return { tabs, sources }
}

/* The extension's own payload rides under `browser` on the action result;
 * `result` is accepted too so a shape change over there degrades to the web
 * fallback instead of throwing. */
function browserPayload(execution) {
  const first = execution?.results?.[0]
  return first?.browser ?? first?.result ?? null
}

async function callAgent(routePath, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}${routePath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AGENT_TOKEN}`,
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload?.error || `Agent ${routePath} failed (${response.status}).`)
  }
  return payload
}

/**
 * The whole job: search or read tabs, check every source, write the brief.
 * Returns the data; rendering it to a note and to audio is the caller's half
 * (see audioBrief.js) so this stays testable without touching the disk.
 */
export async function researchTopic({
  topic,
  mode = 'brief',
  maxSources = DEFAULT_MAX_SOURCES,
  match = '',
  search = defaultWebSearch,
  fetchImpl = fetch,
  llm = requestLlmMessages,
  agentFetch = callAgent,
  onProgress = null,
  /*
   * Leave this undefined and the budget is read out of the owner's own words.
   * Pass null to force today's unbudgeted behaviour, or a budget object to set
   * one explicitly — both are for callers and tests that already know the
   * answer. THIS IS THE ONLY PLACE THE COMMAND IS PARSED: composeBrief() and
   * spokenScript() are handed the result rather than each sniffing the topic,
   * so there is one answer per run and one place to change it.
   */
  spokenBudget = undefined,
} = {}) {
  const subject = String(topic ?? '').trim()
  if (!subject) throw new Error('Research needs a topic.')
  const kind = RESEARCH_MODES.has(mode) ? mode : 'brief'
  const startedAt = Date.now()
  const budget =
    spokenBudget === undefined ? parseSpokenBudget(subject) : spokenBudget

  let queries = []
  let overview = ''
  let sources

  if (kind === 'page') {
    const tabs = await readOpenTabs({ match: match || subject, agentFetch })
    sources = tabs.sources
    onProgress?.({ phase: 'tabs', count: sources.length })
    /* An open-tab request with nothing matching is not an error worth failing
     * on — fall through to the public web so the owner still gets a briefing. */
    if (!readableSources(sources).length) {
      const web = await gatherSources({
        topic: subject,
        mode: 'brief',
        maxSources,
        search,
        fetchImpl,
        llm,
        onProgress,
      })
      queries = web.queries
      overview = web.overview
      sources = [...sources, ...web.sources]
    }
  } else {
    const web = await gatherSources({
      topic: subject,
      mode: kind,
      maxSources,
      search,
      fetchImpl,
      llm,
      onProgress,
    })
    queries = web.queries
    overview = web.overview
    sources = web.sources
  }

  onProgress?.({
    phase: 'compose',
    readable: readableSources(sources).length,
    spokenBudget: budget,
  })
  const brief = await composeBrief({
    topic: subject,
    mode: kind,
    overview,
    sources,
    llm,
    spokenBudget: budget,
  })

  const generatedAt = new Date().toISOString()
  return {
    topic: subject,
    mode: kind,
    generatedAt,
    durationMs: Date.now() - startedAt,
    queries,
    brief,
    sources,
    sourcesRead: readableSources(sources).length,
    sourcesSeen: sources.length,
    /* The written artifact is composed and rendered exactly as it always was.
     * A budget is a budget on what is READ ALOUD; the filed brief keeps its
     * headline, its 3-6 cited key points, its recommendation, its open
     * questions and every source. */
    markdown: renderBriefMarkdown({
      topic: subject,
      mode: kind,
      brief,
      sources,
      queries,
      generatedAt,
    }),
    spoken: spokenScript({ topic: subject, brief, sources, spokenBudget: budget }),
    spokenBudget: budget,
  }
}
