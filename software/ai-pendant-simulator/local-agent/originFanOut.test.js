import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runBrowserActions } from './browserPage.js'
import { mintCapsule, revokeCapsules } from './evidenceCapsules.js'
import {
  FANOUT_READ_ONLY,
  RELAY_DAILY_BUDGET_MS,
  RELAY_MIN_INTERVAL_MS,
  chooseBackend,
  describeBatch,
  normalizeOrigins,
  readOrigins,
  readRelayBudget,
  selectFresh,
} from './originFanOut.js'

/* Disposable stores, so a test never mints into the owner's real evidence or
 * spends their real Browser Run budget. */
function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const previous = process.env.PENDANT_EVIDENCE_STORE_PATH
  process.env.PENDANT_EVIDENCE_STORE_PATH = path.join(directory, 'capsules.json')
  t.after(() => {
    if (previous === undefined) delete process.env.PENDANT_EVIDENCE_STORE_PATH
    else process.env.PENDANT_EVIDENCE_STORE_PATH = previous
  })

  return { directory, budgetPath: path.join(directory, 'relay-budget.json') }
}

const CALENDAR = 'https://calendar.example.com/day'
const BILLING = 'https://billing.example.com/subscription'
const TRAVEL = 'https://travel.example.com/trips'

const PAGES = {
  [CALENDAR]: 'Today: standup at 9:30, review at 14:00. Flight EZ441 departs 20:40.',
  [BILLING]: 'Your plan renews on Tuesday 12 August and will be charged to the card ending 4429.',
  [TRAVEL]: 'Trip to Lisbon. Outbound EZ441 on 12 August, 20:40 from Gatwick.',
}

/**
 * A Safari lane that answers from a table, and can be told to hang on one URL.
 *
 * Records every options object it was handed, which is how the read-only test
 * checks the allow-set actually travels rather than merely existing.
 */
function fakeSafari({ pages = PAGES, hangOn = null, failOn = null } = {}) {
  const calls = { address: [], read: [], options: [] }

  const urlOf = (target) => target?.__url ?? ''

  return {
    calls,
    deps: {
      address: async (url, { options } = {}) => {
        calls.address.push(url)
        calls.options.push(options)
        if (url === hangOn) await new Promise(() => {})
        if (url === failOn) throw new Error(`${url} refused the connection`)
        return {
          target: { __url: url },
          url,
          title: `page ${url}`,
          disposition: 'reloaded',
        }
      },
      readText: async (target, { options } = {}) => {
        const url = urlOf(target)
        calls.read.push(url)
        calls.options.push(options)
        return {
          content: pages[url] ?? '',
          title: `page ${url}`,
          url,
          capsuleId: null,
        }
      },
      capsule: () => null,
      loadRelay: async () => null,
    },
  }
}

/** A clock the test drives, so an age assertion is exact rather than flaky. */
function fakeClock(start = Date.parse('2026-08-07T09:00:00.000Z')) {
  let value = start
  const clock = () => value
  clock.advance = (ms) => {
    value += ms
    return value
  }
  clock.set = (ms) => {
    value = ms
    return value
  }
  return clock
}

test('reads several authenticated origins for one question and reports each separately', async (t) => {
  const { budgetPath } = workspace(t)
  const safari = fakeSafari()

  const batch = await readOrigins(
    {
      question: 'when does my plan renew and when is the flight',
      origins: [
        { url: CALENDAR, name: 'calendar', look: ['standup'] },
        { url: BILLING, name: 'billing', look: ['renews'] },
        { url: TRAVEL, name: 'travel', look: ['EZ441'] },
      ],
    },
    { ...safari.deps, budgetPath },
  )

  assert.equal(batch.ok, true)
  assert.equal(batch.counts.requested, 3)
  assert.equal(batch.counts.ok, 3)
  assert.equal(batch.counts.authenticated, 3)
  assert.deepEqual(
    batch.results.map((result) => result.name),
    ['calendar', 'billing', 'travel'],
    'results come back in the order the caller asked, not the order they finished',
  )

  const billing = batch.results.find((result) => result.name === 'billing')
  assert.equal(billing.backend, 'safari')
  assert.equal(billing.origin, 'https://billing.example.com')
  const renewal = billing.matches.find((match) => match.term === 'renews')
  assert.equal(renewal.found, true)
  assert.match(renewal.quote, /renews on Tuesday 12 August/)

  /* A term that is not there is an answer, not a gap. */
  const calendar = batch.results.find((result) => result.name === 'calendar')
  assert.equal(calendar.matches[0].term, 'standup')
  assert.equal(calendar.matches[0].found, true)
})

test('one origin timing out does not stop the others', async (t) => {
  const { budgetPath } = workspace(t)
  const safari = fakeSafari({ hangOn: BILLING })

  const batch = await readOrigins(
    {
      question: 'morning check',
      origins: [
        { url: BILLING, name: 'billing' },
        { url: CALENDAR, name: 'calendar' },
        { url: TRAVEL, name: 'travel' },
      ],
      perOriginTimeoutMs: 80,
      budgetMs: 5_000,
    },
    { ...safari.deps, budgetPath },
  )

  assert.equal(batch.ok, true, 'the batch itself succeeds; one dead origin is not a batch failure')
  assert.equal(batch.counts.ok, 2)
  assert.equal(batch.counts.failed, 1)

  const dead = batch.failed[0]
  assert.equal(dead.name, 'billing')
  assert.equal(dead.reason, 'timeout')
  assert.match(dead.error, /did not answer within/)

  /* The two behind it in the serial lane still ran. */
  assert.deepEqual(
    batch.results.filter((result) => result.ok).map((result) => result.name),
    ['calendar', 'travel'],
  )
  assert.match(batch.summary, /billing: could not be read/)
})

test('two timeouts in a row write off the browser instead of making every origin wait', async (t) => {
  const { budgetPath } = workspace(t)
  /* What an offline extension actually looks like from here, measured against
   * the live agent: every origin waits out its own deadline to learn the same
   * thing. The first two pay it; the rest are told. */
  const safari = fakeSafari()
  safari.deps.address = async () => new Promise(() => {})

  const started = Date.now()
  const batch = await readOrigins(
    {
      origins: [
        { url: CALENDAR, name: 'calendar' },
        { url: BILLING, name: 'billing' },
        { url: TRAVEL, name: 'travel' },
        { url: 'https://shop.example.com/orders', name: 'shop' },
      ],
      perOriginTimeoutMs: 100,
      budgetMs: 10_000,
    },
    { ...safari.deps, budgetPath },
  )

  assert.equal(batch.counts.failed, 2, 'two origins prove it, the rest do not have to')
  assert.equal(batch.counts.skipped, 2)
  for (const failed of batch.failed) assert.equal(failed.reason, 'timeout')
  for (const skipped of batch.skipped) {
    assert.equal(skipped.reason, 'backend-down')
    assert.match(skipped.error, /2 origins in a row timed out/)
  }
  assert.ok(
    Date.now() - started < 100 * 4,
    'the batch cost two timeouts, not four',
  )
})

test('a page that answers clears the lane\'s slow streak', async (t) => {
  const { budgetPath } = workspace(t)
  const safari = fakeSafari({ hangOn: CALENDAR })

  const batch = await readOrigins(
    {
      origins: [
        { url: CALENDAR, name: 'calendar' },
        { url: BILLING, name: 'billing' },
        { url: TRAVEL, name: 'travel' },
      ],
      perOriginTimeoutMs: 80,
      budgetMs: 10_000,
    },
    { ...safari.deps, budgetPath },
  )

  /* One slow page between two good ones is a page, not a dead browser. */
  assert.equal(batch.counts.failed, 1)
  assert.equal(batch.counts.skipped, 0)
  assert.equal(batch.counts.ok, 2)
})

test('a timeout does not condemn the lane, but a dead transport does', async (t) => {
  const { budgetPath } = workspace(t)
  /* "fetch failed" is what a local agent that is not running looks like from
   * here, and it is fatal to every origin behind it rather than to one page. */
  const safari = fakeSafari({ failOn: CALENDAR })
  safari.deps.address = async (url) => {
    if (url === CALENDAR) throw new Error('fetch failed')
    return { target: { __url: url }, url, title: '', disposition: 'reloaded' }
  }

  const batch = await readOrigins(
    {
      origins: [
        { url: CALENDAR, name: 'calendar' },
        { url: BILLING, name: 'billing' },
        { url: TRAVEL, name: 'travel' },
      ],
      perOriginTimeoutMs: 500,
    },
    { ...safari.deps, budgetPath },
  )

  assert.equal(batch.counts.failed, 1)
  assert.equal(batch.counts.skipped, 2, 'the rest are told immediately instead of each paying a timeout')
  for (const skipped of batch.skipped) {
    assert.equal(skipped.reason, 'backend-down')
    assert.match(skipped.error, /fetch failed/)
  }
})

test('every result records when it was actually fetched, and staleness is re-judged on read', async (t) => {
  const { budgetPath } = workspace(t)
  const safari = fakeSafari()
  const clock = fakeClock()

  const batch = await readOrigins(
    {
      question: 'does my plan renew next month',
      origins: [{ url: BILLING, name: 'billing', look: ['renews'] }],
      maxAgeMs: 60_000,
    },
    { ...safari.deps, budgetPath, clock },
  )

  const billing = batch.results[0]
  assert.equal(billing.observedAt, new Date(clock()).toISOString())
  assert.equal(batch.counts.fresh, 1)
  assert.equal(batch.counts.stale, 0)
  assert.equal(batch.freshness.freshAsOf, billing.observedAt)
  assert.equal(batch.freshness.maxAgeMs, 60_000)

  /* The same batch, consulted later, is not still fresh. This is the whole
   * point: a cached "renews Tuesday" from three weeks ago is not evidence. */
  const later = selectFresh(batch, { maxAgeMs: 60_000, now: clock() + 21 * 24 * 3_600_000 })
  assert.equal(later.fresh.length, 0)
  assert.equal(later.stale.length, 1)
  assert.match(later.stale[0].staleBecause, /older than the 60s this caller accepts/)
  assert.ok(later.stale[0].ageMs > 21 * 24 * 3_600_000 - 1_000)

  /* And a caller with a looser bar still gets it. Rejecting stale evidence is
   * the caller's decision, taken with the current clock. */
  const lenient = selectFresh(batch, { maxAgeMs: 30 * 24 * 3_600_000, now: clock() + 21 * 24 * 3_600_000 })
  assert.equal(lenient.fresh.length, 1)
})

test('revoking a source makes the reading stale even when it was just fetched', async (t) => {
  const { budgetPath } = workspace(t)

  /* Mint the capsule the read will collapse onto, then revoke it — "forget what
   * you read on that page", after the page was read. */
  const { capsuleId } = mintCapsule({
    url: BILLING,
    title: 'subscription',
    region: { kind: 'main_text' },
    content: PAGES[BILLING],
    context: 'browser-extension',
  })
  revokeCapsules({ capsuleId, reason: 'owner asked' })

  const safari = fakeSafari()
  safari.deps.readText = async () => ({
    content: PAGES[BILLING],
    title: 'subscription',
    url: BILLING,
    capsuleId,
  })
  delete safari.deps.capsule

  const batch = await readOrigins(
    { origins: [{ url: BILLING, name: 'billing', look: ['renews'] }], maxAgeMs: 60_000 },
    { ...safari.deps, budgetPath },
  )

  const billing = batch.results[0]
  assert.equal(billing.ok, true, 'the read itself still happened — revocation never blocks a fetch')
  assert.equal(billing.evidenceState, 'revoked')
  assert.equal(billing.evidenceUsable, false)

  /*
   * The coupling that matters: a caller consuming `fresh` stops quoting a
   * revoked source without knowing capsules exist. Age alone would have called
   * this fresh — it was fetched milliseconds ago.
   */
  assert.equal(batch.counts.fresh, 0)
  assert.equal(batch.counts.stale, 1)
  assert.match(batch.stale[0].staleBecause, /evidence for this reading is revoked/)
  assert.equal(batch.freshness.freshAsOf, null)
})

test('the batch is only as fresh as its stalest reading', async (t) => {
  const { budgetPath } = workspace(t)
  const safari = fakeSafari()
  const clock = fakeClock()

  /* The serial lane means the second origin is read later than the first. */
  const slowRead = safari.deps.readText
  safari.deps.readText = async (...args) => {
    clock.advance(30_000)
    return slowRead(...args)
  }

  const batch = await readOrigins(
    {
      origins: [
        { url: CALENDAR, name: 'calendar' },
        { url: BILLING, name: 'billing' },
      ],
      maxAgeMs: 10 * 60_000,
    },
    { ...safari.deps, budgetPath, clock },
  )

  const [first, second] = batch.results
  assert.ok(second.observedAtMs > first.observedAtMs)
  assert.equal(
    batch.freshness.freshAsOf,
    first.observedAt,
    'freshAsOf is the oldest usable reading, so one just-fetched page cannot vouch for the rest',
  )
})

test('writes are unreachable from the fan-out, not merely absent', async (t) => {
  const { budgetPath } = workspace(t)

  /* 1. The vocabulary itself contains nothing that changes a page. */
  for (const write of ['click', 'type', 'select', 'press_key', 'scroll', 'capture']) {
    assert.equal(FANOUT_READ_ONLY.has(write), false, `${write} must not be in the fan-out allow-set`)
  }
  assert.deepEqual([...FANOUT_READ_ONLY].sort(), ['list_tabs', 'navigate', 'read_page'])

  /* 2. The allow-set travels with every single browser call the fan-out makes,
   * which is what makes the guard apply rather than merely exist. */
  const safari = fakeSafari()
  await readOrigins(
    { origins: [{ url: CALENDAR }, { url: BILLING }] },
    { ...safari.deps, budgetPath },
  )
  assert.ok(safari.calls.options.length >= 4)
  for (const options of safari.calls.options) {
    assert.equal(options.allow, FANOUT_READ_ONLY)
    assert.equal(options.source, 'origin-fanout')
  }

  /* 3. The guard bites one layer down: handed the fan-out's allow-set, a click
   * is refused before any request is built. A fetch that is never called is the
   * proof — "unreachable" has to mean the browser never hears about it. */
  const realFetch = globalThis.fetch
  let reached = false
  globalThis.fetch = async () => {
    reached = true
    throw new Error('the fan-out must never reach the network with a write')
  }
  t.after(() => {
    globalThis.fetch = realFetch
  })

  await assert.rejects(
    () =>
      runBrowserActions([{ type: 'browser_click', label: 'submit', params: { ref: 'e1' } }], {
        allow: FANOUT_READ_ONLY,
      }),
    /only reads the page/,
  )
  assert.equal(reached, false, 'the click never made it as far as a request')
})

test('routes owner-private pages to Safari and public pages to the relay', () => {
  const publicUrlCheck = (url) =>
    url.includes('intranet.local')
      ? { ok: false, reason: 'not-public-web', error: 'intranet.local is a local name' }
      : { ok: true }

  const context = { safariUp: true, relayReady: true, relayBudgetMs: RELAY_DAILY_BUDGET_MS, publicUrlCheck }

  const [owned] = normalizeOrigins([{ url: BILLING }])
  assert.equal(chooseBackend(owned, context).backend, 'safari')
  assert.match(chooseBackend(owned, context).reason, /sessions exist only in their own Safari/)

  const [openWeb] = normalizeOrigins([{ url: 'https://status.example.com/', auth: 'public' }])
  assert.equal(chooseBackend(openWeb, context).backend, 'relay')

  /* Only Safari sits on the owner's network, whatever the caller asked for. */
  const [lan] = normalizeOrigins([{ url: 'http://intranet.local/dash', auth: 'public' }])
  assert.equal(chooseBackend(lan, context).backend, 'safari')

  /* Mac asleep: an owner-private page is NOT handed to the relay just because
   * the relay is free. It cannot hold the owner's session, so the whole trip
   * buys a login wall at the price of one of ten daily browser-minutes. */
  const asleep = chooseBackend(owned, { ...context, safariUp: false })
  assert.equal(asleep.backend, null)
  assert.match(asleep.reason, /none of the owner's sessions/)

  /* Unless the caller insists, in which case they get it and it is flagged. */
  const [forced] = normalizeOrigins([{ url: BILLING, backend: 'relay' }])
  const insisted = chooseBackend(forced, { ...context, safariUp: false })
  assert.equal(insisted.backend, 'relay')
  assert.equal(insisted.degraded, true, 'a forced relay read of a private page is never authenticated')

  /* The public leg still runs while the Mac sleeps — that is what the relay is
   * for, and reserving its budget is what keeps it able to. */
  assert.equal(chooseBackend(openWeb, { ...context, safariUp: false }).backend, 'relay')

  /* Both down is a named skip, never a guess. */
  const nothing = chooseBackend(owned, { ...context, safariUp: false, relayReady: false })
  assert.equal(nothing.backend, null)
  assert.match(nothing.reason, /not configured/)

  /* A spent daily budget takes the relay out of the routing, not out of the
   * explanation. */
  const broke = chooseBackend(openWeb, { ...context, relayBudgetMs: 0 })
  assert.equal(broke.backend, 'safari')
  assert.match(broke.reason, /minutes are spent/)
})

test('the relay lane paces itself to the free tier and books what it spent', async (t) => {
  const { budgetPath } = workspace(t)
  const clock = fakeClock()
  const slept = []

  const relay = {
    normalizePublicUrl: () => ({ ok: true }),
    readPublicPage: async (url) => ({
      ok: true,
      url,
      title: 'status',
      text: 'All systems operational. Next maintenance window is 14 August.',
      action: 'markdown',
      browserMs: 2_400,
    }),
  }

  const batch = await readOrigins(
    {
      origins: [
        { url: 'https://status.example.com/a', auth: 'public', look: ['maintenance'] },
        { url: 'https://status.example.com/b', auth: 'public' },
      ],
      budgetMs: 120_000,
    },
    {
      relay,
      budgetPath,
      clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock.advance(ms)
      },
      loadRelay: async () => relay,
    },
  )

  assert.equal(batch.counts.ok, 2)
  assert.equal(batch.results[0].backend, 'relay')
  assert.equal(batch.results[0].authenticated, false, 'the relay browser holds none of the owner\'s sessions')
  assert.equal(batch.results[0].untrusted, true)

  /* One action per ten seconds: the second page waits it out rather than
   * spending an action to be told 429. */
  assert.equal(slept.length, 1)
  assert.ok(slept[0] >= RELAY_MIN_INTERVAL_MS - 100, `waited ${slept[0]}ms`)

  const spent = readRelayBudget({ now: clock(), filePath: budgetPath })
  assert.equal(spent.actions, 2)
  assert.equal(spent.browserMs, 4_800)
  assert.equal(batch.relayBudget.remainingMs, RELAY_DAILY_BUDGET_MS - 4_800)

  /* Relay readings are evidence too: minted here, because unlike the tool that
   * runs on the relay this call was made from the Mac. */
  assert.ok(batch.results[0].capsuleId, 'a relay reading still gets a capsule')
  assert.ok(batch.capsuleIds.includes(batch.results[0].capsuleId))
})

test('a relay origin that does not fit the pacing is skipped, not stalled', async (t) => {
  const { budgetPath } = workspace(t)
  const clock = fakeClock()

  const relay = {
    normalizePublicUrl: () => ({ ok: true }),
    readPublicPage: async (url) => ({ ok: true, url, title: '', text: 'fine', browserMs: 100 }),
  }

  const batch = await readOrigins(
    {
      origins: [
        { url: 'https://status.example.com/a', auth: 'public' },
        { url: 'https://status.example.com/b', auth: 'public' },
      ],
      /* Less than one rate-limit interval: the second page cannot be reached
       * inside this batch and says so. */
      budgetMs: 4_000,
    },
    { relay, budgetPath, clock, loadRelay: async () => relay, sleep: async () => {} },
  )

  assert.equal(batch.counts.ok, 1)
  assert.equal(batch.counts.failed, 1)
  assert.equal(batch.failed[0].reason, 'rate-limit-wait')
  assert.match(batch.failed[0].error, /one page every 10s/)
})

test('secrets on a page are withheld from the quotes this layer hands back', async (t) => {
  const { budgetPath } = workspace(t)
  const safari = fakeSafari({
    pages: {
      [BILLING]: 'Account ready. The wifi password is hunter2. Your plan renews on Tuesday.',
    },
  })

  const batch = await readOrigins(
    { origins: [{ url: BILLING, name: 'billing', look: ['wifi', 'renews'] }] },
    { ...safari.deps, budgetPath },
  )

  const billing = batch.results[0]
  const secret = billing.matches.find((match) => match.term === 'wifi')
  assert.ok(secret.found)
  assert.equal(/hunter2/.test(secret.quote), false, 'the secret must not survive into a quote')
  assert.match(secret.quote, /withheld/)
  assert.equal(/hunter2/.test(billing.preview), false)
  assert.equal(/hunter2/.test(JSON.stringify(batch)), false, 'nothing in the batch carries it')
  assert.equal(billing.redaction.counts.secret >= 1, true)
})

test('normalizeOrigins refuses what the browser cannot address', () => {
  assert.throws(() => normalizeOrigins([]), /at least one origin/)
  assert.throws(() => normalizeOrigins([{ url: 'file:///etc/passwd' }]), /not an http\(s\) page/)
  assert.throws(() => normalizeOrigins(['mailto:someone@example.com']), /not an http\(s\) page/)

  const [entry] = normalizeOrigins(['https://shop.example.com/orders?session=abc123'])
  assert.equal(entry.origin, 'https://shop.example.com')
  assert.equal(entry.auth, 'owner', 'this is the authenticated read layer; owner is the default')
})

test('describeBatch says what was not seen as plainly as what was', () => {
  const line = describeBatch({
    results: [{}, {}, {}],
    fresh: [{ name: 'billing', matches: [{ term: 'renews', found: true, quote: 'renews on Tuesday' }] }],
    stale: [{ name: 'calendar', staleBecause: 'read 4000s ago, older than the 900s this caller accepts' }],
    failed: [{ name: 'travel', error: 'travel.example.com did not answer within 45s' }],
    skipped: [],
  })

  assert.match(line, /billing: renews — “renews on Tuesday”/)
  assert.match(line, /calendar: read 4000s ago/)
  assert.match(line, /travel: could not be read/)
})
