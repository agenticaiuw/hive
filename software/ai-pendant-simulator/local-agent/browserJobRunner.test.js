import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/* The real definition of "can the cloud browser reach this at all", so the
 * physics half of the routing rule is tested against the thing it will run
 * against rather than a stand-in that agrees with it by construction. */
import { normalizePublicUrl } from '../cloud-relay/serverBrowser.js'
import {
  BROWSER_JOB_CAPABILITIES,
  JOB_STATUS,
  browserJobsLocation,
  cancelBrowserJob,
  drainBrowserJobs,
  dueBrowserJobs,
  getBrowserJob,
  listBrowserJobs,
  registerBrowserJobRoutes,
  routeBrowserJob,
  runBrowserJob,
  submitBrowserJob,
  sweepBrowserJobs,
} from './browserJobRunner.js'
import {
  SESSION_NEED,
  recordSessionObservation,
  sessionNeedFor,
} from './sessionNeedSignal.js'

const T0 = Date.parse('2026-08-07T09:00:00.000Z')
const PAGE = 'https://shop.example/orders'
const NEWS = 'https://news.example/story'

/* The case the whole design exists for: a page that renders perfectly well
 * logged out, and shows the owner something else entirely. */
const LOGGED_OUT_VIEW =
  'Acme Storefront. Browse the catalogue of widgets, gadgets and sprockets. ' +
  'Shipping information, returns policy, contact us. Popular this week.'
const OWNER_VIEW =
  'Acme Storefront. Order 4471 shipped Tuesday by courier. Order 4482 arrives Friday. ' +
  'Order 4490 is being packed now. Manage returns, track a parcel, change delivery address.'
const ARTICLE = 'A long public article about the harbour redevelopment and its funding. '.repeat(4)

function paths(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-jobs-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return {
    filePath: path.join(directory, 'jobs.json'),
    signalPath: path.join(directory, 'signals.json'),
  }
}

function clockAt(start = T0) {
  let value = start
  return {
    now: () => value,
    advance(ms) {
      value += ms
      return value
    },
  }
}

/**
 * A cloud browser that answers from a table.
 *
 * `readPublicPage` returns the same result shape serverBrowser.js does, so the
 * runner's handling of walls, rate limits and HTTP errors is exercised against
 * the contract it will actually see.
 */
function fakeServer({ pages = {}, results = {} } = {}) {
  const calls = []
  return {
    calls,
    normalizePublicUrl,
    readPublicPage: async (url) => {
      calls.push(url)
      if (results[url]) return typeof results[url] === 'function' ? results[url]() : results[url]
      const text = pages[url]
      if (text === undefined) {
        return { ok: false, reason: 'empty', url, error: 'the page rendered no readable text' }
      }
      return { ok: true, url, title: 'cloud title', text, chars: text.length, source: 'fake', untrusted: true }
    },
  }
}

/** The owner's Safari, present or not. */
function fakeBridge({ pages = {}, offline = false } = {}) {
  const calls = []
  return {
    calls,
    read: async (url) => {
      calls.push(url)
      if (offline) throw new Error('The browser extension is not connected.')
      return { text: pages[url] ?? '', title: 'safari title', url, capsuleId: null }
    },
  }
}

const deps = ({ filePath, signalPath }, server, bridge, clock, bridgeUp = true) => ({
  filePath,
  signalPath,
  server,
  bridgeRead: bridge.read,
  bridgeUp,
  clock: clock.now,
})

/* =========================================================== the rule alone */

const job = (extra = {}) => ({ url: PAGE, backend: null, allowDegraded: false, calibrate: null, ...extra })
const unknown = { verdict: SESSION_NEED.UNKNOWN, confidence: 0 }
const required = { verdict: SESSION_NEED.REQUIRED, confidence: 1, why: 'a wall was seen here' }
const publicish = { verdict: SESSION_NEED.PUBLIC, confidence: 1 }

test('a web read with nothing known about it goes to the cloud browser', () => {
  const route = routeBrowserJob(job(), {
    need: unknown,
    serverReady: true,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: true,
  })
  assert.equal(route.backend, 'server')
  assert.equal(route.calibrate, true, 'an unjudged origin is worth settling while the Mac is up')
})

test('an origin known to need the session goes to the owner\'s browser', () => {
  const route = routeBrowserJob(job(), {
    need: required,
    serverReady: true,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: true,
  })
  assert.equal(route.backend, 'bridge')
  assert.match(route.reason, /needs the owner's session/)
})

test('the Mac being unknown is treated as worth trying, not as offline', () => {
  const route = routeBrowserJob(job(), {
    need: required,
    serverReady: true,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: null,
  })
  assert.equal(route.backend, 'bridge')
})

test('a page that needs the session with no Mac parks rather than reading a stranger\'s view', () => {
  const route = routeBrowserJob(job(), {
    need: required,
    serverReady: true,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: false,
  })
  assert.equal(route.backend, null)
  assert.equal(route.park, true)
  assert.match(route.reason, /would not be their record/)
})

test('a caller who accepts a logged-out reading gets one, flagged', () => {
  const route = routeBrowserJob(job({ allowDegraded: true }), {
    need: required,
    serverReady: true,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: false,
  })
  assert.equal(route.backend, 'server')
  assert.equal(route.degraded, true)
})

test('an address the cloud cannot resolve goes to the Mac even when the origin is judged public', () => {
  const lan = job({ url: 'http://192.168.1.10/status' })
  const route = routeBrowserJob(lan, {
    need: publicish,
    serverReady: true,
    reach: normalizePublicUrl(lan.url),
    bridgeUp: true,
  })
  assert.equal(route.backend, 'bridge', 'reachability is physics and outranks any verdict')
  assert.match(route.reason, /private address/)

  const stranded = routeBrowserJob(lan, {
    need: publicish,
    serverReady: true,
    reach: normalizePublicUrl(lan.url),
    bridgeUp: false,
  })
  assert.equal(stranded.backend, null)
  assert.equal(stranded.park, true)

  /* The reason must name the reachability, not the session: a caller told "this
   * needs your login" about a device on their own LAN would go looking for a
   * login that does not exist. */
  const alsoPrivate = routeBrowserJob(lan, {
    need: required,
    serverReady: true,
    reach: normalizePublicUrl(lan.url),
    bridgeUp: true,
  })
  assert.equal(alsoPrivate.backend, 'bridge')
  assert.match(alsoPrivate.reason, /reach/)
  assert.doesNotMatch(alsoPrivate.reason, /needs the owner's session/)
})

test('an unreachable address is refused even when the caller names the cloud browser', () => {
  const lan = job({ url: 'http://192.168.1.10/status', backend: 'server', allowDegraded: true })
  const route = routeBrowserJob(lan, {
    need: publicish,
    serverReady: true,
    reach: normalizePublicUrl(lan.url),
    bridgeUp: true,
  })
  assert.equal(
    route.backend,
    null,
    'no verdict, override or degradation flag can make a datacenter browser see a home LAN',
  )
  assert.equal(route.park, true)
})

test('with no cloud browser configured the Mac takes the read', () => {
  const route = routeBrowserJob(job(), {
    need: unknown,
    serverReady: false,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: true,
  })
  assert.equal(route.backend, 'bridge')
  assert.match(route.reason, /not configured/)

  /* The relay module missing entirely means publicness is UNVERIFIED, not that
   * the page is private. The reason must say which of those it is, or a public
   * news site gets described to the owner as being on their home network. */
  const unverified = routeBrowserJob(job(), { need: unknown, serverReady: false, reach: null, bridgeUp: true })
  assert.equal(unverified.backend, 'bridge')
  assert.doesNotMatch(unverified.reason, /only the owner's browser can reach/)
  assert.match(unverified.reason, /not configured/)
})

test('an explicit backend is honoured and the cost of it is stated', () => {
  const forced = routeBrowserJob(job({ backend: 'server' }), {
    need: required,
    serverReady: true,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: true,
  })
  assert.equal(forced.backend, 'server')
  assert.equal(forced.degraded, true, 'a forced cloud read of a private page is still not the owner\'s record')

  const forcedBridge = routeBrowserJob(job({ backend: 'bridge' }), {
    need: publicish,
    serverReady: true,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: true,
  })
  assert.equal(forcedBridge.backend, 'bridge')
})

test('a settled origin is not re-calibrated, and a caller can decline calibration', () => {
  const settled = routeBrowserJob(job(), {
    need: publicish,
    serverReady: true,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: true,
  })
  assert.equal(settled.backend, 'server')
  assert.equal(settled.calibrate, false)

  const declined = routeBrowserJob(job({ calibrate: false }), {
    need: unknown,
    serverReady: true,
    reach: normalizePublicUrl(PAGE),
    bridgeUp: true,
  })
  assert.equal(declined.calibrate, false)
})

/* ======================================================== running for real */

test('a public page is read by the cloud and never touches the Mac', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const server = fakeServer({ pages: { [NEWS]: ARTICLE } })
  const bridge = fakeBridge()

  const submitted = submitBrowserJob({ url: NEWS, calibrate: false }, { ...store, now: clock.now() })
  const done = await runBrowserJob(submitted.jobId, deps(store, server, bridge, clock))

  assert.equal(done.status, JOB_STATUS.DONE)
  assert.equal(done.result.backend, 'server')
  assert.equal(done.result.authenticated, false)
  assert.equal(done.result.answersOwnerRecord, false, 'a cloud reading is never the owner\'s own record')
  assert.equal(bridge.calls.length, 0, 'the Mac must stay asleep for a public read')
  assert.equal(done.text, ARTICLE, 'the full text goes to the caller')
})

test('a sign-in wall escalates to the Mac and is remembered for next time', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const server = fakeServer({
    results: {
      [PAGE]: { ok: true, url: PAGE, title: 'Sign in', text: 'Sign in to continue.', likelyLoginWall: true },
    },
  })
  const bridge = fakeBridge({ pages: { [PAGE]: OWNER_VIEW } })

  const first = submitBrowserJob({ url: PAGE }, { ...store, now: clock.now() })
  const done = await runBrowserJob(first.jobId, deps(store, server, bridge, clock))

  assert.equal(done.status, JOB_STATUS.DONE)
  assert.equal(done.result.backend, 'bridge')
  assert.equal(done.result.answersOwnerRecord, true)
  assert.equal(server.calls.length, 1)
  assert.equal(bridge.calls.length, 1)

  const learned = sessionNeedFor(PAGE, { filePath: store.signalPath, now: clock.now() })
  assert.equal(learned.verdict, SESSION_NEED.REQUIRED)

  /* The point of learning it: the second read does not pay for the wall again. */
  clock.advance(60_000)
  const second = submitBrowserJob({ url: PAGE }, { ...store, now: clock.now() })
  const again = await runBrowserJob(second.jobId, deps(store, server, bridge, clock))

  assert.equal(again.result.backend, 'bridge')
  assert.equal(server.calls.length, 1, 'the cloud browser should not be spent on a known wall')
  assert.equal(bridge.calls.length, 2)
})

test('a wall is escalated on its own, without leaning on the comparison', async (t) => {
  /* Calibration is off here on purpose. With it on, a wall would also be caught
   * by the two readings disagreeing — so this is the only place that pins the
   * wall detector itself, and it covers the three shapes a wall arrives in. */
  const walls = {
    'https://a.example/x': { ok: true, url: 'https://a.example/x', text: 'Sign in to continue.', likelyLoginWall: true },
    'https://b.example/x': { ok: false, url: 'https://b.example/x', reason: 'empty', error: 'no readable text' },
    'https://c.example/x': { ok: false, url: 'https://c.example/x', reason: 'http-error', status: 403, error: 'HTTP 403' },
  }

  for (const [url, result] of Object.entries(walls)) {
    const store = paths(t)
    const clock = clockAt()
    const server = fakeServer({ results: { [url]: result } })
    const bridge = fakeBridge({ pages: { [url]: OWNER_VIEW } })

    const submitted = submitBrowserJob({ url, calibrate: false }, { ...store, now: clock.now() })
    const done = await runBrowserJob(submitted.jobId, deps(store, server, bridge, clock))

    assert.equal(done.status, JOB_STATUS.DONE, `${url} should have escalated, not failed`)
    assert.equal(done.result.backend, 'bridge', `${url} should not answer from the logged-out browser`)
    assert.equal(done.result.answersOwnerRecord, true)
    assert.equal(
      sessionNeedFor(url, { filePath: store.signalPath, now: clock.now() }).verdict,
      SESSION_NEED.REQUIRED,
      `${url} should have been learned from the wall alone`,
    )
  }
})

test('a wall with the Mac asleep waits instead of reporting the sign-in page as the answer', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const server = fakeServer({
    results: {
      [PAGE]: { ok: true, url: PAGE, text: 'Sign in to continue.', likelyLoginWall: true },
    },
  })
  const bridge = fakeBridge()

  const submitted = submitBrowserJob({ url: PAGE, calibrate: false }, { ...store, now: clock.now() })
  const parked = await runBrowserJob(submitted.jobId, {
    ...deps(store, server, bridge, clock),
    bridgeUp: false,
  })

  assert.equal(parked.status, JOB_STATUS.WAITING)
  assert.equal(parked.result, null)
  assert.match(parked.error, /sign-in wall/)
})

test('a page that looks fine logged out is caught by comparing the two browsers', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  /* No wall, no error, no 403 — the cloud reading is a perfectly readable page.
   * Only the comparison can tell that it is not the owner's page. */
  const server = fakeServer({ pages: { [PAGE]: LOGGED_OUT_VIEW } })
  const bridge = fakeBridge({ pages: { [PAGE]: OWNER_VIEW } })

  const first = submitBrowserJob({ url: PAGE }, { ...store, now: clock.now() })
  const done = await runBrowserJob(first.jobId, deps(store, server, bridge, clock))

  assert.equal(done.status, JOB_STATUS.DONE)
  assert.equal(
    done.result.backend,
    'bridge',
    'once the two browsers disagree, the owner\'s reading is the answer',
  )
  assert.equal(done.result.answersOwnerRecord, true)
  assert.equal(done.result.comparison.verdict, 'different')

  const learned = sessionNeedFor(PAGE, { filePath: store.signalPath, now: clock.now() })
  assert.equal(learned.verdict, SESSION_NEED.REQUIRED)

  clock.advance(60_000)
  const second = submitBrowserJob({ url: PAGE }, { ...store, now: clock.now() })
  await runBrowserJob(second.jobId, deps(store, server, bridge, clock))
  assert.equal(server.calls.length, 1, 'a divergent origin should stop costing cloud minutes')
})

test('two browsers that agree settle the origin and stop the extra Mac round-trip', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const server = fakeServer({ pages: { [NEWS]: ARTICLE } })
  const bridge = fakeBridge({ pages: { [NEWS]: ARTICLE } })

  const first = submitBrowserJob({ url: NEWS }, { ...store, now: clock.now() })
  const done = await runBrowserJob(first.jobId, deps(store, server, bridge, clock))

  assert.equal(done.result.backend, 'server')
  assert.equal(done.result.comparison.verdict, 'same')
  assert.equal(bridge.calls.length, 1, 'calibration costs exactly one Mac read')

  clock.advance(60_000)
  const second = submitBrowserJob({ url: NEWS }, { ...store, now: clock.now() })
  const again = await runBrowserJob(second.jobId, deps(store, server, bridge, clock))

  assert.equal(again.result.backend, 'server')
  assert.equal(bridge.calls.length, 1, 'a settled origin must not keep waking the Mac')
  assert.equal(
    sessionNeedFor(NEWS, { filePath: store.signalPath, now: clock.now() }).verdict,
    SESSION_NEED.PUBLIC,
  )
})

test('the Mac being away during calibration keeps the page and leaves the origin unjudged', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const server = fakeServer({ pages: { [NEWS]: ARTICLE } })
  const bridge = fakeBridge({ offline: true })

  const submitted = submitBrowserJob({ url: NEWS }, { ...store, now: clock.now() })
  const done = await runBrowserJob(submitted.jobId, deps(store, server, bridge, clock))

  assert.equal(done.status, JOB_STATUS.DONE, 'a failed comparison must not lose a page already read')
  assert.equal(done.result.backend, 'server')
  assert.equal(
    sessionNeedFor(NEWS, { filePath: store.signalPath, now: clock.now() }).verdict,
    SESSION_NEED.UNKNOWN,
  )
})

/* ============================================== degrading and waiting well */

test('a private page with the Mac asleep waits for it and reads it when it returns', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  recordSessionObservation(
    { url: PAGE, kind: 'login-wall', detail: 'seen before' },
    { filePath: store.signalPath, now: clock.now() },
  )
  const server = fakeServer({ pages: { [PAGE]: LOGGED_OUT_VIEW } })
  const bridge = fakeBridge({ pages: { [PAGE]: OWNER_VIEW } })

  const submitted = submitBrowserJob({ url: PAGE }, { ...store, now: clock.now() })
  const parked = await runBrowserJob(submitted.jobId, {
    ...deps(store, server, bridge, clock),
    bridgeUp: false,
  })

  assert.equal(parked.status, JOB_STATUS.WAITING)
  assert.equal(parked.result, null, 'nothing may be returned as an answer here')
  assert.equal(server.calls.length, 0, 'a cloud reading of a private page is not a consolation prize')
  assert.ok(Date.parse(parked.nextAttemptAt) > clock.now(), 'it must be scheduled to try again')

  /* Not due yet. */
  assert.equal(dueBrowserJobs({ now: clock.now(), filePath: store.filePath }).length, 0)

  clock.advance(31_000)
  const drained = await drainBrowserJobs(deps(store, server, bridge, clock))
  assert.equal(drained.attempted, 1)
  assert.equal(drained.done, 1)

  const finished = getBrowserJob(submitted.jobId, { filePath: store.filePath })
  assert.equal(finished.status, JOB_STATUS.DONE)
  assert.equal(finished.result.answersOwnerRecord, true)
})

test('a caller who asked for a degraded reading gets one, labelled as not their record', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  recordSessionObservation({ url: PAGE, kind: 'login-wall' }, { filePath: store.signalPath, now: clock.now() })
  const server = fakeServer({ pages: { [PAGE]: LOGGED_OUT_VIEW } })
  const bridge = fakeBridge()

  const submitted = submitBrowserJob({ url: PAGE, allowDegraded: true }, { ...store, now: clock.now() })
  const done = await runBrowserJob(submitted.jobId, {
    ...deps(store, server, bridge, clock),
    bridgeUp: false,
  })

  assert.equal(done.status, JOB_STATUS.DONE)
  assert.equal(done.result.degraded, true)
  assert.equal(done.result.answersOwnerRecord, false)
  assert.match(done.result.warning, /not your own record/)
})

test('a job that waited out its whole deadline fails saying what was missing', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  recordSessionObservation({ url: PAGE, kind: 'login-wall' }, { filePath: store.signalPath, now: clock.now() })
  const server = fakeServer()
  const bridge = fakeBridge()

  const submitted = submitBrowserJob({ url: PAGE, deadlineMs: 60_000 }, { ...store, now: clock.now() })
  await runBrowserJob(submitted.jobId, { ...deps(store, server, bridge, clock), bridgeUp: false })

  clock.advance(61_000)
  const failed = await runBrowserJob(submitted.jobId, {
    ...deps(store, server, bridge, clock),
    bridgeUp: false,
  })
  assert.equal(failed.status, JOB_STATUS.FAILED)
  assert.equal(failed.reason, 'deadline')
  assert.match(failed.error, /needs your own browser/)
})

/* ====================================================== retries and repair */

test('a rate limit is waited out, a 404 is not', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const server = fakeServer({
    results: {
      [NEWS]: { ok: false, reason: 'rate-limited', error: 'Browser Run rate limit reached', retryAfterMs: 10_000 },
      [PAGE]: { ok: false, reason: 'http-error', status: 404, error: 'HTTP 404' },
    },
  })
  const bridge = fakeBridge()

  const limited = submitBrowserJob({ url: NEWS, calibrate: false }, { ...store, now: clock.now() })
  const retried = await runBrowserJob(limited.jobId, deps(store, server, bridge, clock))
  assert.equal(retried.status, JOB_STATUS.QUEUED)
  assert.match(retried.error, /rate limit/)
  assert.ok(Date.parse(retried.nextAttemptAt) > clock.now())

  const missing = submitBrowserJob({ url: PAGE, calibrate: false }, { ...store, now: clock.now() })
  const gone = await runBrowserJob(missing.jobId, deps(store, server, bridge, clock))
  assert.equal(gone.status, JOB_STATUS.FAILED, 'a 404 will still be a 404 in ten minutes')
})

test('a job interrupted mid-read is recovered rather than lost, because reads are safe to repeat', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const submitted = submitBrowserJob({ url: NEWS }, { ...store, now: clock.now() })

  /* Simulate the agent dying with the job in flight. */
  const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'))
  raw.jobs[submitted.jobId].status = JOB_STATUS.RUNNING
  raw.jobs[submitted.jobId].leasedAt = new Date(clock.now()).toISOString()
  fs.writeFileSync(store.filePath, JSON.stringify(raw))

  assert.equal(sweepBrowserJobs({ now: clock.now(), filePath: store.filePath }).recovered.length, 0)

  clock.advance(4 * 60_000)
  const swept = sweepBrowserJobs({ now: clock.now(), filePath: store.filePath })
  assert.deepEqual(swept.recovered, [submitted.jobId])
  assert.equal(getBrowserJob(submitted.jobId, { filePath: store.filePath }).status, JOB_STATUS.QUEUED)
})

test('sweeping expires jobs past their deadline', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const submitted = submitBrowserJob({ url: NEWS, deadlineMs: 60_000 }, { ...store, now: clock.now() })
  clock.advance(61_000)
  const swept = sweepBrowserJobs({ now: clock.now(), filePath: store.filePath })
  assert.deepEqual(swept.expired, [submitted.jobId])
  assert.equal(getBrowserJob(submitted.jobId, { filePath: store.filePath }).status, JOB_STATUS.FAILED)
})

test('one act asked for twice is one job', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const first = submitBrowserJob({ url: NEWS, idempotencyKey: 'catch-up' }, { ...store, now: clock.now() })
  const second = submitBrowserJob({ url: NEWS, idempotencyKey: 'catch-up' }, { ...store, now: clock.now() })

  assert.equal(second.jobId, first.jobId)
  assert.equal(second.deduplicated, true)
  assert.equal(listBrowserJobs({ filePath: store.filePath }).length, 1)
})

test('a job can be cancelled and a bad URL is refused at the door', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const submitted = submitBrowserJob({ url: NEWS }, { ...store, now: clock.now() })
  const cancelled = cancelBrowserJob(submitted.jobId, { filePath: store.filePath, now: clock.now() })
  assert.equal(cancelled.status, JOB_STATUS.CANCELLED)

  const server = fakeServer({ pages: { [NEWS]: ARTICLE } })
  const bridge = fakeBridge()
  const after = await runBrowserJob(submitted.jobId, deps(store, server, bridge, clock))
  assert.equal(after.status, JOB_STATUS.CANCELLED, 'a cancelled job must not run later')
  assert.equal(server.calls.length, 0)

  assert.throws(() => submitBrowserJob({ url: 'not a url' }, store), /http\(s\) URL/)
})

/* ============================================================== the record */

test('the page itself is not written to disk; the caller gets it and the store gets a preview', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const buried = `${'public harbour news filler text. '.repeat(60)}QUIETMARKER47 tail.`
  const server = fakeServer({ pages: { [NEWS]: buried } })
  const bridge = fakeBridge()

  const submitted = submitBrowserJob({ url: NEWS, calibrate: false }, { ...store, now: clock.now() })
  const done = await runBrowserJob(submitted.jobId, deps(store, server, bridge, clock))

  assert.ok(done.text.includes('QUIETMARKER47'), 'the caller that ran the job gets the whole page')
  const raw = fs.readFileSync(store.filePath, 'utf8')
  assert.ok(!raw.includes('QUIETMARKER47'), 'the stored job must not become a copy of the page')
  assert.ok(done.result.preview.length <= 400)
  assert.equal(done.result.chars, buried.length)
})

test('the quotes a caller asked for come back with the reading', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const server = fakeServer({ pages: { [NEWS]: 'The harbour works finish on 14 September, the council said.' } })
  const bridge = fakeBridge()

  const submitted = submitBrowserJob(
    { url: NEWS, look: ['14 September', 'demolition'], calibrate: false },
    { ...store, now: clock.now() },
  )
  const done = await runBrowserJob(submitted.jobId, deps(store, server, bridge, clock))

  const found = done.result.matches.find((match) => match.term === '14 September')
  assert.equal(found.found, true)
  assert.match(found.quote, /harbour works/)
  assert.equal(done.result.matches.find((match) => match.term === 'demolition').found, false)
})

test('the routing decision and its reason are stored with the job', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const server = fakeServer({ pages: { [NEWS]: ARTICLE } })
  const bridge = fakeBridge()

  const submitted = submitBrowserJob(
    { url: NEWS, requestText: 'what does the story say', calibrate: false },
    { ...store, now: clock.now() },
  )
  const done = await runBrowserJob(submitted.jobId, deps(store, server, bridge, clock))

  assert.equal(done.route.backend, 'server')
  assert.ok(done.route.reason.length > 10, 'a route with no stated reason cannot be argued with')
  assert.equal(done.route.need.verdict, SESSION_NEED.UNKNOWN)
  assert.ok(done.history.some((entry) => entry.event === 'routed'))
})

test('the request wording alone can send a job to the Mac', async (t) => {
  const store = paths(t)
  const clock = clockAt()
  const server = fakeServer({ pages: { [PAGE]: LOGGED_OUT_VIEW } })
  const bridge = fakeBridge({ pages: { [PAGE]: OWNER_VIEW } })

  const submitted = submitBrowserJob(
    { url: PAGE, requestText: 'when do my orders arrive' },
    { ...store, now: clock.now() },
  )
  const done = await runBrowserJob(submitted.jobId, deps(store, server, bridge, clock))

  assert.equal(done.result.backend, 'bridge')
  assert.equal(server.calls.length, 0)
  assert.equal(
    sessionNeedFor(PAGE, { filePath: store.signalPath, now: clock.now() }).observations,
    0,
    'a guess about wording must never be written down as a fact about the origin',
  )
})

/* ================================================================== wiring */

test('the routes register in an order where /drain is not read as a job id', () => {
  const registered = []
  const app = {
    get: (routePath) => registered.push(`GET ${routePath}`),
    post: (routePath) => registered.push(`POST ${routePath}`),
    delete: (routePath) => registered.push(`DELETE ${routePath}`),
  }

  const routes = registerBrowserJobRoutes(app, { basePath: '/browser-jobs' })
  assert.deepEqual(routes, registered)
  assert.ok(routes.includes('POST /browser-jobs'))
  assert.ok(routes.includes('GET /browser-jobs/signals'))
  assert.ok(
    routes.indexOf('POST /browser-jobs/drain') < routes.indexOf('GET /browser-jobs/:jobId'),
    'a literal route registered after the parameterised one would never be reached',
  )
  assert.ok(
    routes.indexOf('GET /browser-jobs/signals') < routes.indexOf('GET /browser-jobs/:jobId'),
  )
})

test('the module announces itself in the capability registry\'s own vocabulary', async () => {
  const { defineCapability } = await import('../shared/capabilityRegistry.js')
  for (const capability of BROWSER_JOB_CAPABILITIES) {
    const defined = defineCapability(capability)
    assert.equal(defined.surface, 'browser')
    assert.ok(defined.what)
  }
  assert.match(browserJobsLocation(), /\.json$/)
})
