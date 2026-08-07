import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TransactionAttemptError,
  assertNoTransactionClaim,
  checkSource,
  composeBrief,
  extractReadableText,
  fallbackQueries,
  gatherSources,
  harvestSourceUrls,
  planSearchQueries,
  readOpenTabs,
  readableSources,
  renderBriefMarkdown,
  researchTopic,
  spokenScript,
} from './research.js'

const htmlPage = (body, title = 'Example Page') => `<!doctype html>
<html><head><title>${title}</title><style>.a{color:red}</style></head>
<body><nav>Home About</nav><script>alert(1)</script>
<article><h1>Heading</h1><p>${body}</p></article>
<footer>&copy; 2026</footer></body></html>`

const longBody = 'Hubs with dual HDMI hold 4K at sixty hertz. '.repeat(20)

function stubFetch(pages) {
  return async (url) => {
    const page = pages[url]
    if (!page) throw new Error('connect ECONNREFUSED')
    return {
      ok: page.status >= 200 && page.status < 300,
      status: page.status,
      headers: { get: () => page.contentType ?? 'text/html; charset=utf-8' },
      text: async () => page.body ?? '',
    }
  }
}

test('extractReadableText drops furniture and keeps the prose', () => {
  const { title, text } = extractReadableText(
    htmlPage('Pass-through charging is capped at 85 watts &amp; drops under load.'),
  )
  assert.equal(title, 'Example Page')
  assert.match(text, /Pass-through charging is capped at 85 watts & drops under load\./)
  assert.doesNotMatch(text, /alert\(1\)/)
  assert.doesNotMatch(text, /color:red/)
  assert.doesNotMatch(text, /Home About/)
  // Block boundaries survive so a heading does not fuse into the paragraph.
  assert.match(text, /Heading\nPass-through/)
})

test('extractReadableText decodes numeric and named entities', () => {
  const { text } = extractReadableText(
    `<p>a&nbsp;b &#8212; c &#x2014; d &unknownentity;</p>`,
  )
  assert.match(text, /a b — c — d &unknownentity;/)
})

test('harvestSourceUrls strips tracking params, punctuation and duplicate hosts', () => {
  const sources = harvestSourceUrls([
    'See ([techradar.com](https://www.techradar.com/review-a?utm_source=openai)).',
    'Also https://www.techradar.com/review-b and https://plugable.com/guide#specs.',
    'Dupe: https://techradar.com/review-a/',
  ])
  assert.deepEqual(
    sources.map((source) => source.url),
    ['https://www.techradar.com/review-a', 'https://plugable.com/guide'],
  )
})

test('harvestSourceUrls ignores non-http schemes and honours the cap', () => {
  const sources = harvestSourceUrls(
    ['mailto:a@b.com ftp://x.example/f https://a.example/1 https://b.example/2 https://c.example/3'],
    { maxSources: 2 },
  )
  assert.deepEqual(
    sources.map((source) => source.host),
    ['a.example', 'b.example'],
  )
})

test('checkSource reads a real body and reports how it checked out', async () => {
  const url = 'https://good.example/post'
  const source = await checkSource(url, {
    fetchImpl: stubFetch({ [url]: { status: 200, body: htmlPage(longBody) } }),
  })
  assert.equal(source.ok, true)
  assert.equal(source.status, 200)
  assert.equal(source.title, 'Example Page')
  assert.ok(source.text.length > 300)
  assert.ok(Date.parse(source.checkedAt) > 0)
})

test('checkSource refuses to call an unread page a source', async () => {
  const pages = {
    'https://wall.example/a': { status: 403, body: 'nope' },
    'https://thin.example/b': { status: 200, body: htmlPage('short') },
    'https://pdf.example/c': {
      status: 200,
      body: '%PDF-1.7',
      contentType: 'application/pdf',
    },
  }
  const fetchImpl = stubFetch(pages)

  const blocked = await checkSource('https://wall.example/a', { fetchImpl })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /blocked automated readers/)

  const thin = await checkSource('https://thin.example/b', { fetchImpl })
  assert.equal(thin.ok, false)
  assert.match(thin.error, /no readable body text/)

  const binary = await checkSource('https://pdf.example/c', { fetchImpl })
  assert.equal(binary.ok, false)
  assert.match(binary.error, /not a readable document/)

  const dead = await checkSource('https://dead.example/d', { fetchImpl })
  assert.equal(dead.ok, false)
  assert.equal(dead.status, 0)
})

test('planSearchQueries falls back to canned angles when the model misbehaves', async () => {
  const bad = await planSearchQueries('usb-c hubs', 'compare', {
    llm: async () => 'not json at all',
  })
  assert.deepEqual(bad, fallbackQueries('usb-c hubs', 'compare'))

  const good = await planSearchQueries('usb-c hubs', 'brief', {
    llm: async () => JSON.stringify({ queries: ['a', 'b', 'c', 'd'] }),
  })
  assert.deepEqual(good, ['a', 'b', 'c', 'd'].slice(0, 3))
})

test('gatherSources searches every angle and checks what it finds', async () => {
  const seen = []
  const result = await gatherSources({
    topic: 'usb-c hubs',
    llm: async () => JSON.stringify({ queries: ['q1', 'q2'] }),
    search: async (query) => {
      seen.push(query)
      return {
        ok: true,
        query,
        summary: `Answer for ${query} ([x](https://${query}.example/p))`,
      }
    },
    fetchImpl: stubFetch({
      'https://q1.example/p': { status: 200, body: htmlPage(longBody) },
      'https://q2.example/p': { status: 500, body: 'boom' },
    }),
  })

  assert.deepEqual(seen, ['q1', 'q2'])
  assert.match(result.overview, /Answer for q1/)
  assert.equal(result.sources.length, 2)
  assert.equal(readableSources(result.sources).length, 1)
})

test('gatherSources survives a search backend that throws', async () => {
  const result = await gatherSources({
    topic: 'x',
    llm: async () => JSON.stringify({ queries: ['only'] }),
    search: async () => {
      throw new Error('search is down')
    },
    fetchImpl: stubFetch({}),
  })
  assert.deepEqual(result.sources, [])
  assert.deepEqual(result.searchFailures, ['search is down'])
})

test('composeBrief drops citations that point past what was read', async () => {
  const sources = [
    { ok: true, url: 'https://a.example', title: 'A', text: 'body', status: 200, checkedAt: new Date().toISOString() },
  ]
  const brief = await composeBrief({
    topic: 't',
    sources,
    llm: async () =>
      JSON.stringify({
        headline: 'H',
        keyPoints: [
          { point: 'real', sources: [1] },
          { point: 'invented', sources: [7] },
          { point: '   ' },
        ],
        recommendation: 'Get the cheaper one.',
        openQuestions: ['price in Europe'],
        spoken: 'Spoken script.',
      }),
  })

  assert.equal(brief.keyPoints.length, 2)
  assert.deepEqual(brief.keyPoints[0].sources, [1])
  assert.deepEqual(brief.keyPoints[1].sources, [])
  assert.deepEqual(brief.openQuestions, ['price in Europe'])
})

test('composeBrief refuses a brief that claims it transacted', async () => {
  await assert.rejects(
    composeBrief({
      topic: 't',
      sources: [],
      llm: async () =>
        JSON.stringify({
          headline: 'Done',
          keyPoints: [],
          recommendation: 'I ordered the Anker 563 for you.',
          spoken: 'All set.',
        }),
    }),
    TransactionAttemptError,
  )
})

test('assertNoTransactionClaim lets recommendations through', () => {
  assert.equal(
    assertNoTransactionClaim({
      recommendation: 'Buy the Anker if you need dual HDMI; you can order it from Anker directly.',
      spoken: 'Worth buying.',
      keyPoints: [{ point: 'It is on sale.' }],
    }),
    true,
  )
})

test('renderBriefMarkdown numbers only read sources and keeps their URLs', () => {
  const checkedAt = new Date('2026-08-07T09:00:00Z').toISOString()
  const markdown = renderBriefMarkdown({
    topic: 'USB-C hubs',
    mode: 'compare',
    queries: ['usb-c hubs 2026'],
    brief: {
      headline: 'Two hubs are worth it.',
      keyPoints: [{ point: 'Dual HDMI works.', sources: [1] }],
      recommendation: 'Take the Anker.',
      openQuestions: ['EU pricing'],
      spoken: 'x',
    },
    sources: [
      { ok: true, url: 'https://a.example/x', title: 'A review', status: 200, checkedAt },
      { ok: false, url: 'https://b.example/y', error: 'blocked automated readers (HTTP 403)' },
    ],
  })

  assert.match(markdown, /# USB-C hubs/)
  assert.match(markdown, /Dual HDMI works\. \[\^1\]/)
  assert.match(markdown, /1\. \[A review\]\(https:\/\/a\.example\/x\) — read .*HTTP 200/)
  assert.match(markdown, /### Seen but not read/)
  assert.match(markdown, /https:\/\/b\.example\/y — blocked automated readers/)
  // The owner reading this later must not have to wonder if it acted.
  assert.match(markdown, /Nothing was bought, booked or ordered/)
  assert.match(markdown, /Searched: “usb-c hubs 2026”/)
})

test('renderBriefMarkdown says so plainly when nothing could be read', () => {
  const markdown = renderBriefMarkdown({
    topic: 'x',
    brief: { headline: '', keyPoints: [], openQuestions: [] },
    sources: [{ ok: false, url: 'https://a.example', error: 'HTTP 500' }],
  })
  assert.match(markdown, /_No source could be fetched and read\._/)
})

test('spokenScript is speakable: no markdown, no URLs, and says the source count', () => {
  const script = spokenScript({
    topic: 'USB-C hubs',
    brief: { spoken: 'TechRadar rates the Plugable highest.' },
    sources: [{ ok: true }, { ok: true }, { ok: false }],
  })
  assert.match(script, /^Here's your briefing on USB-C hubs\. I read 2 sources\./)
  assert.doesNotMatch(script, /https?:\/\//)
  assert.doesNotMatch(script, /[#*_`]/)
})

test('spokenScript falls back to the key points when the model gave no script', () => {
  const script = spokenScript({
    topic: 't',
    brief: {
      spoken: '',
      keyPoints: [{ point: 'One thing.' }, { point: 'Another.' }],
      recommendation: 'Do the first.',
    },
    sources: [{ ok: true }],
  })
  assert.match(script, /I read 1 source\. One thing\. Another\. My recommendation: Do the first\./)
})

test('spokenScript admits it when nothing was readable', () => {
  const script = spokenScript({ topic: 't', brief: { keyPoints: [] }, sources: [] })
  assert.match(script, /couldn't read enough/)
})

test('readOpenTabs reads the owner tabs over the agent HTTP surface', async () => {
  const calls = []
  const { sources } = await readOpenTabs({
    match: 'pricing',
    agentFetch: async (routePath, body) => {
      calls.push(body.actions[0].type)
      if (body.actions[0].type === 'browser_list_tabs') {
        return {
          results: [
            {
              result: {
                tabs: [
                  { tabId: 1, url: 'https://stripe.com/pricing', title: 'Pricing' },
                  { tabId: 2, url: 'https://news.example/x', title: 'News' },
                  { tabId: 3, url: 'chrome://settings', title: 'Settings' },
                ],
              },
            },
          ],
        }
      }
      return {
        results: [{ result: { title: 'Pricing', content: 'Per seat pricing. '.repeat(40) } }],
      }
    },
  })

  assert.deepEqual(calls, ['browser_list_tabs', 'browser_read_page'])
  assert.equal(sources.length, 1)
  assert.equal(sources[0].url, 'https://stripe.com/pricing')
  assert.equal(sources[0].via, 'browser')
  assert.equal(sources[0].ok, true)
})

test('page mode falls back to the web when no tab matched', async () => {
  const searched = []
  const result = await researchTopic({
    topic: 'ltem coverage',
    mode: 'page',
    agentFetch: async () => ({ results: [{ result: { tabs: [] } }] }),
    llm: async ({ messages }) => {
      const system = messages[0].content
      if (system.includes('You plan web research')) {
        return JSON.stringify({ queries: ['ltem coverage'] })
      }
      return JSON.stringify({
        headline: 'Coverage is patchy.',
        keyPoints: [{ point: 'Rural fill-in is uneven.', sources: [1] }],
        recommendation: '',
        openQuestions: [],
        spoken: 'Coverage is patchy in rural areas.',
      })
    },
    search: async (query) => {
      searched.push(query)
      return { ok: true, query, summary: `see https://carrier.example/map` }
    },
    fetchImpl: stubFetch({
      'https://carrier.example/map': { status: 200, body: htmlPage(longBody) },
    }),
  })

  assert.deepEqual(searched, ['ltem coverage'])
  assert.equal(result.sourcesRead, 1)
  assert.match(result.markdown, /carrier\.example/)
  assert.match(result.spoken, /Coverage is patchy in rural areas\./)
})

test('researchTopic refuses an empty topic and normalizes an unknown mode', async () => {
  await assert.rejects(() => researchTopic({ topic: '   ' }), /needs a topic/)

  const result = await researchTopic({
    topic: 't',
    mode: 'nonsense',
    llm: async ({ messages }) =>
      messages[0].content.includes('You plan web research')
        ? JSON.stringify({ queries: ['t'] })
        : JSON.stringify({ headline: 'h', keyPoints: [], spoken: 's' }),
    search: async (query) => ({ ok: true, query, summary: 'no links here' }),
    fetchImpl: stubFetch({}),
  })
  assert.equal(result.mode, 'brief')
  assert.equal(result.sourcesSeen, 0)
})
