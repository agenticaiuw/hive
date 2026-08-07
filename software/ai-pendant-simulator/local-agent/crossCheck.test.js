import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CROSSCHECK_READ_ONLY,
  anchorPick,
  buildSurfaces,
  clearCrossChecks,
  crossCheckPage,
  describeCrossCheck,
  extractClaims,
  getCrossCheck,
  independenceBetween,
  normalizeAsks,
  planStrategies,
  reconcile,
  registerCrossCheckRoutes,
  secondLookTargets,
  semanticPick,
} from './crossCheck.js'

/*
 * Everything here runs against a fake browser. Nothing in this file opens a tab,
 * touches the owner's Safari, or spends a Browser Run minute — the point of the
 * dependency injection in crossCheckPage is that the interesting behaviour
 * (which strategies ran, what they disagreed about, how much traffic it cost) is
 * decidable without a live page on the other end.
 */

const URL_UNDER_TEST = 'https://shop.example.com/orders/A-4821'

/* A plausible order page. The main content and the page furniture deliberately
 * carry the same kind of information, because that is the case this feature
 * exists for: a total inside <main> and a second total in a sticky cart bar. */
const MAIN = [
  'Order #A-4821',
  'Order total: $41.98',
  'Delivery: arriving 12 August',
  'Status: parcel held at local depot',
].join('\n')

const FURNITURE = (total) => ['Skip to content', 'Your account', `Cart summary ${total}`, 'Help']

const fullText = (total) => [...FURNITURE(total).slice(0, 2), MAIN, ...FURNITURE(total).slice(2)].join('\n')

const LANDMARKS = [
  'h1: Order #A-4821',
  'nav: Your account',
  'h2: Returns window closes 30 August',
].join('\n')

const ASKS = [
  { name: 'total', aliases: ['Order total', 'Cart summary'] },
  { name: 'delivery', aliases: ['Delivery'] },
  { name: 'returns', aliases: ['Returns window'] },
]

const pagesWith = (total = '$41.98') => ({
  main_text: MAIN,
  text: fullText(total),
  landmarks: LANDMARKS,
})

const ok = (data) => ({ ok: true, message: '', data, error: null })
const bad = (error) => ({ ok: false, message: error, data: null, error })
const reading = (content, tag) => ({
  content,
  title: 'Your orders',
  url: URL_UNDER_TEST,
  evidence: { capsuleId: `cap_${tag}`, contentHash: `hash_${tag}` },
})

/**
 * A browser that answers from a table and records everything it was asked.
 *
 * The recording is what most of these tests actually assert on: how many batches
 * were sent, which action types were in them, and whether the read-only allowlist
 * travelled with each one.
 */
function fakeBrowser({
  pages = pagesWith(),
  selectors = {},
  controls = [],
  failModes = [],
  online = true,
  holdFirstAddress = null,
} = {}) {
  const calls = { batches: 0, actions: [], options: [], addressed: [] }
  let held = false

  const deps = {
    address: async (url, { options } = {}) => {
      if (holdFirstAddress && !held) {
        held = true
        await holdFirstAddress
      }
      calls.addressed.push(url)
      calls.options.push(options)
      return {
        target: { urlContains: 'shop.example.com/orders' },
        url,
        title: 'Your orders',
        disposition: 'reloaded',
      }
    },
    runActions: async (actions, options) => {
      calls.batches += 1
      calls.options.push(options)
      calls.actions.push(...actions)

      return actions.map((action) => {
        const kind = String(action.type).replace(/^browser_/, '')
        if (kind === 'snapshot') return ok({ elements: controls })

        const selector = action.params.selector
        if (selector) {
          return selectors[selector] === undefined
            ? bad(`no element matches ${selector}`)
            : ok(reading(selectors[selector], `sel${selector}`))
        }

        const mode = action.params.mode
        if (failModes.includes(mode)) return bad(`the ${mode} region could not be read`)
        return ok(reading(pages[mode] ?? '', mode))
      })
    },
    browserStatus: () => ({ online }),
    clock: (() => {
      let now = 1_700_000_000_000
      return () => (now += 25)
    })(),
    /* Recent-run history is module state; only the test that is about history
     * lets a run into it. */
    remember: (run) => run,
  }

  return { calls, deps }
}

const run = (options = {}, request = {}) => {
  const browser = fakeBrowser(options)
  return crossCheckPage(
    { url: URL_UNDER_TEST, question: 'what did this order come to?', ask: ASKS, ...request },
    browser.deps,
  ).then((result) => ({ result, calls: browser.calls }))
}

const verdictFor = (result, ask) => result.verdicts.find((entry) => entry.ask === ask)

/* ------------------------------------------------------------- extraction */

test('the two extractors have genuinely different blind spots', () => {
  const labelFirst = 'Order total: $41.98'
  const valueFirst = '$41.98 order total'

  /* Both read the ordinary layout. */
  assert.equal(anchorPick(labelFirst, 'Order total').value, '$41.98')
  assert.equal(semanticPick(labelFirst, 'Order total').value, '$41.98')

  /*
   * And they part company on the layout that puts the value first, which is the
   * whole justification for running two of them: a second pass that fails
   * wherever the first one fails is a second pass worth nothing.
   */
  assert.equal(anchorPick(valueFirst, 'order total'), null)
  assert.equal(semanticPick(valueFirst, 'order total').value, '$41.98')
})

test('the nearest value is the one on the label\'s own line, not the nearest character', () => {
  /* "4821" is three characters closer to "Order total" than "$41.98" is. A
   * proximity read that did not respect the rendered line would answer the
   * total with the order number. */
  const pick = semanticPick('Order #A-4821\nOrder total: $41.98', 'Order total')
  assert.equal(pick.value, '$41.98')
  assert.equal(pick.line, 'Order total: $41.98')
})

test('a value the page did not shape is still read from the label\'s line', () => {
  /* A status is not money, a date or a count, and the $41.98 one line up must
   * not be offered as one. */
  const pick = semanticPick('Order total: $41.98\nStatus: parcel held at local depot', 'Status')
  assert.equal(pick.value, 'parcel held at local depot')
})

test('the page furniture is derived by subtraction, so it shares no line with the main region', () => {
  const surfaces = buildSurfaces({
    main: { ok: true, text: MAIN, capsuleId: 'cap_main', contentHash: 'hash_main' },
    full: { ok: true, text: fullText('$39.99'), capsuleId: 'cap_full', contentHash: 'hash_full' },
    landmarks: { ok: true, text: LANDMARKS, capsuleId: 'cap_marks', contentHash: 'hash_marks' },
  })

  const chrome = surfaces.find((surface) => surface.id === 'chrome')
  assert.ok(chrome, 'the subtraction produced a furniture surface')

  /* Not one line of the main region survived into it — which is what makes the
   * pair disjoint rather than nested. */
  for (const line of MAIN.split('\n')) {
    assert.ok(!chrome.raw.includes(line), `main line leaked into the furniture: ${line}`)
  }
  assert.ok(chrome.raw.includes('Cart summary $39.99'))

  /* And it says out loud that it is not its own evidence. */
  assert.equal(chrome.capsuleId, null)
  assert.deepEqual(chrome.derivedFrom, ['main', 'full'])
})

/* ---------------------------------------------------------- reconciliation */

test('agreement across regions that do not contain each other is corroboration', async () => {
  const { result } = await run()
  const total = verdictFor(result, 'total')

  assert.equal(total.verdict, 'corroborated')
  assert.equal(total.answer, '$41.98')
  assert.equal(total.independence, 'disjoint')
  assert.deepEqual(total.answers[0].regions, ['main', 'chrome'])
  assert.equal(result.independence.achieved, 'region-disjoint')
})

test('agreement inside one region is reported as repeated, never as corroboration', async () => {
  const { result } = await run()
  const delivery = verdictFor(result, 'delivery')

  /* Both extractors found it and they agree — but only the main region carries
   * a delivery date, so this is one observation with two names on it. */
  assert.equal(delivery.verdict, 'repeated')
  assert.equal(delivery.answers[0].voices, 2)
  assert.deepEqual(delivery.answers[0].regions, ['main'])
  assert.equal(delivery.independence, 'same-region')
  assert.match(delivery.note, /same bytes/)
  assert.notEqual(delivery.verdict, verdictFor(result, 'total').verdict)
})

test('a disagreement is handed over whole, with no answer chosen', async () => {
  const { result } = await run({ pages: pagesWith('$39.99') })
  const total = verdictFor(result, 'total')

  assert.equal(total.verdict, 'contested')
  assert.equal(total.answer, null, 'a contested ask must not answer with one of the readings')
  assert.equal(total.answers.length, 2)
  assert.deepEqual(
    total.answers.map((group) => group.value).sort(),
    ['$39.99', '$41.98'],
  )

  /* And it names which kind of disagreement it is: two parts of the page
   * carrying different values is the page's problem, not the reader's. */
  assert.equal(total.conflict.kind, 'page')
  assert.match(result.summary, /\$41\.98/)
  assert.match(result.summary, /\$39\.99/)
  assert.match(result.summary, /not picking one/)
})

test('two extractors disagreeing over one region is named as an extraction problem', () => {
  const surfaces = [
    { id: 'main', sees: 'main', raw: 'x', normalized: 'x', mode: 'main_text', capsuleId: 'c' },
  ]
  const claims = [
    {
      ask: 'total',
      strategy: 'main-anchor',
      surface: 'main',
      value: '$41.98',
      line: 'Order total: $41.98 or $39.99',
      quote: 'q',
    },
    {
      ask: 'total',
      strategy: 'main-semantic',
      surface: 'main',
      value: '$39.99',
      line: 'Order total: $41.98 or $39.99',
      quote: 'q',
    },
  ]
  const strategies = [
    { id: 'main-anchor', surface: 'main' },
    { id: 'main-semantic', surface: 'main' },
  ]

  const { verdicts } = reconcile({ asks: [{ name: 'total', aliases: ['total'] }], claims, surfaces, strategies })
  assert.equal(verdicts[0].verdict, 'contested')
  assert.equal(verdicts[0].conflict.kind, 'extraction')
})

test('one strategy finding something is not dressed up as agreement', async () => {
  const { result } = await run()
  const returns = verdictFor(result, 'returns')

  assert.equal(returns.verdict, 'single-source')
  assert.equal(returns.answers[0].voices, 1)
  /* The strategies that looked and did not find it are named, because "only one
   * reader saw this" is only meaningful if you can see who else looked. */
  assert.ok(returns.lookedAndMissed.length >= 3)
  assert.ok(returns.lookedAndMissed.every((entry) => entry.region && entry.strategy))
  assert.match(result.summary, /nothing else confirmed it/)
})

test('absence is an answer, and it names who looked', async () => {
  const { result } = await run({}, { ask: [{ name: 'refund', aliases: ['Refund'] }] })
  const refund = verdictFor(result, 'refund')

  assert.equal(refund.verdict, 'absent')
  assert.equal(refund.answer, null)
  assert.equal(refund.lookedAndMissed.length, result.strategies.length)
  assert.match(refund.note, /none of them found this/)
})

test('every reconciled claim carries the strategy, the region and the text it came from', async () => {
  const { result } = await run()

  for (const verdict of result.verdicts) {
    for (const group of verdict.answers) {
      for (const support of group.support) {
        assert.ok(support.strategy, 'a claim with no strategy is not evidence-backed')
        assert.ok(support.region, 'a claim with no region cannot be checked')
        assert.ok(support.sees, 'the region has to say what it can see')
        assert.ok(support.how, 'the extraction method has to be stated')
        assert.ok(support.locator, 'a claim needs to say where in the region it came from')
        assert.ok(support.line, 'a claim carries the rendered line it was read off')
        assert.ok(support.quote, 'a claim carries the surrounding text')
        assert.ok(
          result.strategies.some((strategy) => strategy.id === support.strategy),
          'the strategy named on a claim is one that actually ran',
        )
      }
    }
  }
})

test('differently worded readings of the same sentence are one answer, and say how they merged', () => {
  const surfaces = [
    {
      id: 'main',
      raw: 'Status: parcel held at local depot',
      normalized: 'Status: parcel held at local depot',
      mode: 'main_text',
      sees: 'main',
    },
    {
      id: 'chrome',
      raw: 'Status parcel being held at depot',
      normalized: 'Status parcel being held at depot',
      mode: 'text minus main_text',
      sees: 'furniture',
    },
  ]
  const strategies = planStrategies(surfaces)
  const asks = [{ name: 'status', aliases: ['Status'], take: 120 }]
  const claims = extractClaims({ asks, surfaces, strategies })
  const { verdicts } = reconcile({ asks, claims, surfaces, strategies })

  assert.equal(verdicts[0].answers.length, 1, 'the same sentence in different words is one answer')
  assert.ok(
    verdicts[0].answers[0].mergedBy.some((entry) => entry.reason === 'wording'),
    'the fuzzy merge is disclosed rather than silent',
  )
  assert.equal(verdicts[0].verdict, 'corroborated')
})

test('independence is measured against the text, not asserted from region names', () => {
  const surfaceText = new Map([
    ['main', 'Order total: $41.98 Delivery: 12 August'],
    ['landmarks', 'h1: Order total: $41.98'],
    ['chrome', 'Cart summary $41.98'],
  ])

  /* A heading that also appears verbatim in the main region is one sighting,
   * whatever two read modes call it. */
  assert.equal(
    independenceBetween(
      { surface: 'main', line: 'Order total: $41.98' },
      { surface: 'landmarks', line: 'h1: Order total: $41.98' },
      surfaceText,
    ),
    'overlapping-bytes',
  )

  assert.equal(
    independenceBetween(
      { surface: 'main', line: 'Order total: $41.98' },
      { surface: 'chrome', line: 'Cart summary $41.98' },
      surfaceText,
    ),
    'disjoint',
  )

  assert.equal(
    independenceBetween(
      { surface: 'main', line: 'a' },
      { surface: 'main', line: 'b' },
      surfaceText,
    ),
    'same-region',
  )
})

/* --------------------------------------------------------------- traffic */

test('the strategies are parallel over one page read, not parallel fetches', async () => {
  const { result, calls } = await run({}, { secondLook: false })

  assert.equal(calls.addressed.length, 1, 'one navigation for every strategy')
  assert.equal(calls.batches, 1, 'every region read goes out in one batch')
  assert.equal(result.traffic.navigations, 1)
  assert.equal(result.traffic.batches, 1)
  assert.equal(result.traffic.reReads, 0)
  assert.ok(result.strategies.length > result.traffic.browserActions)
})

test('nothing but reading is reachable, and the allowlist travels with every call', async () => {
  const { calls } = await run()

  for (const action of calls.actions) {
    const kind = String(action.type).replace(/^browser_/, '')
    assert.ok(CROSSCHECK_READ_ONLY.has(kind), `${kind} is not a read`)
  }
  assert.ok(calls.options.length > 0)
  for (const options of calls.options) {
    assert.equal(options.allow, CROSSCHECK_READ_ONLY)
    assert.equal(options.source, 'cross-check')
  }
})

test('a second cross-check of the same origin is refused rather than queued behind the first', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const browser = fakeBrowser({ holdFirstAddress: gate })
  const request = { url: URL_UNDER_TEST, ask: ASKS }

  const first = crossCheckPage(request, browser.deps)
  const second = await crossCheckPage(request, browser.deps)

  assert.equal(second.ok, false)
  assert.equal(second.reason, 'origin-busy')
  assert.match(second.error, /same serial browser lane/)

  release()
  const finished = await first
  assert.equal(finished.ok, true)
  assert.equal(browser.calls.addressed.length, 1, 'the refused run navigated nowhere')
})

/* ----------------------------------------------------- targeted second look */

test('a contested ask earns one extra scoped read, and it says why it was taken', async () => {
  const { result, calls } = await run({
    pages: pagesWith('$39.99'),
    controls: [
      { role: 'group', name: 'Order total $41.98', selector: '#order-total' },
      { role: 'link', name: 'Help', selector: '#help' },
    ],
    selectors: { '#order-total': 'Order total: $41.98' },
  })

  assert.equal(calls.batches, 2, 'the second look is a second batch, and only one')
  assert.equal(result.reReads.length, 1)
  assert.equal(result.reReads[0].ask, 'total')
  assert.equal(result.reReads[0].selector, '#order-total')
  assert.match(result.reReads[0].why, /two different values/)
  assert.equal(result.traffic.reReads, 1)
  assert.match(result.traffic.note, /says why/)

  /* It is a subtree of what was already read, so it adds location and not a
   * second witness — and the output says so rather than letting the extra voice
   * read as confirmation. */
  const surface = result.regions.find((region) => region.id.startsWith('second-look:'))
  assert.equal(surface.adds, 'location')

  const total = verdictFor(result, 'total')
  assert.equal(total.verdict, 'contested', 'a second look does not resolve a disagreement by itself')
  const supported = total.answers.find((group) => group.value === '$41.98')
  assert.ok(supported.support.some((entry) => entry.strategy.startsWith('second-look:')))
})

test('a second look taken for one ask is not counted as having looked at the others', async () => {
  const { result } = await run({
    pages: pagesWith('$39.99'),
    controls: [{ role: 'group', name: 'Order total $41.98', selector: '#order-total' }],
    selectors: { '#order-total': 'Order total: $41.98' },
  })

  const delivery = verdictFor(result, 'delivery')
  assert.ok(
    delivery.lookedAndMissed.every((entry) => !entry.strategy.startsWith('second-look:')),
    'a bounded re-read must not become evidence of absence for an ask it never examined',
  )
})

test('no control carrying the label means no second look, not a guessed selector', async () => {
  const { result, calls } = await run({
    pages: pagesWith('$39.99'),
    controls: [{ role: 'link', name: 'Help', selector: '#help' }],
  })

  assert.equal(calls.batches, 1)
  assert.equal(result.reReads.length, 0)
  assert.equal(verdictFor(result, 'total').verdict, 'contested')
})

test('second-look targets come only from asks the first pass could not settle', () => {
  const verdicts = [
    { ask: 'total', verdict: 'contested', answers: [{ variants: ['$41.98'] }, { variants: ['$39.99'] }] },
    { ask: 'delivery', verdict: 'corroborated', answers: [{ variants: ['12 August'] }] },
  ]
  const asks = [
    { name: 'total', aliases: ['Order total'] },
    { name: 'delivery', aliases: ['Delivery'] },
  ]
  const controls = [
    { name: 'Order total $41.98', selector: '#total' },
    { name: 'Delivery 12 August', selector: '#delivery' },
  ]

  const targets = secondLookTargets(verdicts, asks, controls)
  assert.deepEqual(
    targets.map((target) => target.ask),
    ['total'],
  )
})

/* ------------------------------------------------------------ degradation */

test('one readable region degrades to a clearly marked single-source answer', async () => {
  const { result } = await run({ failModes: ['text', 'landmarks'] })

  assert.equal(result.degraded.degraded, true)
  assert.match(result.degraded.because, /only main could be read/)
  assert.equal(result.independence.achieved, 'method-only')
  assert.match(result.independence.detail, /share every byte/)

  /* Nothing may come back corroborated when there was only ever one region. */
  assert.equal(result.counts.corroborated, 0)
  assert.equal(verdictFor(result, 'total').verdict, 'repeated')
  assert.deepEqual(
    result.unreadable.map((entry) => entry.region).sort(),
    ['full', 'landmarks'],
  )
})

test('the last surviving strategy answers alone rather than agreeing with itself', async () => {
  /* Only the landmarks region survives, and only the anchor extractor runs on
   * it — one strategy, so there is nothing for a consensus to be made out of. */
  const { result } = await run({ failModes: ['main_text', 'text'] })

  assert.deepEqual(
    result.strategies.map((strategy) => strategy.id),
    ['landmarks-anchor'],
  )
  assert.equal(result.degraded.degraded, true)
  assert.equal(result.independence.achieved, 'method-only')
  assert.equal(verdictFor(result, 'returns').verdict, 'single-source')
  assert.equal(result.counts.corroborated, 0)
  assert.equal(result.counts.repeated, 0)
})

test('a page whose main region cannot be read is reported under its own name', async () => {
  const { result } = await run({ failModes: ['main_text'] })

  /* Not relabelled as "main". The whole body is a different thing from the main
   * content region, and a claim that says which one it came from has to be
   * telling the truth about which one it came from. */
  assert.deepEqual(
    result.regions.map((region) => region.id),
    ['page', 'landmarks'],
  )
  assert.match(result.regions[0].sees, /whole rendered page/)
  assert.equal(result.unreadable[0].mode, 'main_text')
})

test('several regions read but nothing found twice is not called corroboration', async () => {
  const { result } = await run(
    { failModes: [] },
    { ask: [{ name: 'returns', aliases: ['Returns window'] }] },
  )

  assert.equal(verdictFor(result, 'returns').verdict, 'single-source')
  assert.equal(result.independence.achieved, 'regions-read-but-nothing-corroborated')
  assert.equal(result.degraded.degraded, false)
})

test('an offline browser reads nothing and says so instead of answering', async () => {
  const browser = fakeBrowser({ online: false })
  const result = await crossCheckPage({ url: URL_UNDER_TEST, ask: ASKS }, browser.deps)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'browser-offline')
  assert.equal(browser.calls.batches, 0)
  assert.equal(browser.calls.addressed.length, 0)
  assert.match(result.error, /Nothing here is a reading of it/)
})

/* ------------------------------------------------------------------- asks */

test('asks derived from the question are marked as guesses', async () => {
  const { result } = await run({}, { ask: null, question: 'what is the delivery date on this order?' })

  assert.equal(result.asksDerivedFrom, 'question')
  assert.ok(result.asks.includes('delivery'))
})

test('a caller\'s own labels are kept, deduplicated, and tried in order', () => {
  const { asks, derivedFrom } = normalizeAsks([
    { name: 'total', aliases: ['Order total', 'order TOTAL', 'Cart summary'] },
  ])
  assert.equal(derivedFrom, 'caller')
  assert.deepEqual(asks[0].aliases, ['total', 'Order total', 'Cart summary'])
})

test('a cross-check with nothing to look for is refused rather than guessed at', async () => {
  await assert.rejects(
    () => crossCheckPage({ url: URL_UNDER_TEST, question: 'ok?' }, fakeBrowser().deps),
    /needs something to look for/,
  )
  await assert.rejects(
    () => crossCheckPage({ url: 'ftp://shop.example.com', ask: ASKS }, fakeBrowser().deps),
    /http\(s\) page/,
  )
})

test('the spoken summary keeps the disagreement in it', () => {
  const line = describeCrossCheck({
    strategies: [{ id: 'main-anchor' }, { id: 'chrome-anchor' }],
    verdicts: [
      {
        ask: 'total',
        verdict: 'contested',
        conflict: { kind: 'page' },
        answers: [
          { value: '$41.98', regions: ['main'] },
          { value: '$39.99', regions: ['chrome'] },
        ],
        lookedAndMissed: [],
      },
    ],
  })

  assert.match(line, /\$41\.98/)
  assert.match(line, /\$39\.99/)
  assert.match(line, /different parts of the page/)
})

/* ----------------------------------------------------------------- routes */

test('the register function mounts read-only routes and serves a stored run', async (t) => {
  clearCrossChecks()
  t.after(() => clearCrossChecks())

  const handlers = new Map()
  const app = {}
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (routePath, handler) => handlers.set(`${method.toUpperCase()} ${routePath}`, handler)
  }

  const browser = fakeBrowser()
  const routes = registerCrossCheckRoutes(app, {
    /* The real store, this once: the history is the thing under test. */
    deps: { ...browser.deps, remember: undefined },
  })

  assert.deepEqual(routes, [
    'POST /crosscheck',
    'GET /crosscheck',
    'GET /crosscheck/:runId',
  ])

  const responses = []
  const response = {
    status(code) {
      this.code = code
      return this
    },
    json(body) {
      responses.push({ code: this.code ?? 200, body })
      return this
    },
  }

  await handlers.get('POST /crosscheck')(
    { body: { url: URL_UNDER_TEST, ask: ASKS } },
    { ...response, code: undefined },
  )
  const created = responses.at(-1).body
  assert.equal(created.ok, true)

  handlers.get('GET /crosscheck/:runId')({ params: { runId: created.runId } }, { ...response })
  assert.equal(responses.at(-1).body.run.runId, created.runId)
  assert.equal(getCrossCheck(created.runId).runId, created.runId)

  handlers.get('GET /crosscheck')({ query: {} }, { ...response })
  assert.equal(responses.at(-1).body.runs.length, 1)
  assert.match(responses.at(-1).body.note, /one page fetch/)

  handlers.get('GET /crosscheck/:runId')({ params: { runId: 'nope' } }, { ...response })
  assert.equal(responses.at(-1).code, 404)
})

test('the report states the independence it actually achieved, not the one it wanted', async () => {
  const { result } = await run()

  assert.equal(result.independence.fetches, 1)
  assert.match(result.independence.note, /none of them is a second source/)
  assert.deepEqual(result.independence.regionsRead, ['main', 'chrome', 'landmarks'])
  assert.equal(result.independence.strategies, result.strategies.length)
})
