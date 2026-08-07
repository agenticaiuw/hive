import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/* Point the capsule store at a scratch file before anything reads it.
 * capsulesLocation() consults the environment on every call, so this is enough
 * and no import has to be deferred. */
process.env.PENDANT_EVIDENCE_STORE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-watch-evd-')),
  'capsules.json',
)

import { getBrowserStatus } from './browserBridge.js'
import { mintCapsule, revokeCapsules } from './evidenceCapsules.js'
import {
  acknowledgeReports,
  checkWatch,
  createWatch,
  deleteWatch,
  describeChanges,
  diffValues,
  extractByAnchor,
  getWatch,
  listWatches,
  normalizeFields,
  pendingReports,
  suppressedChanges,
  tickPageWatches,
  updateWatch,
  watchHealth,
} from './pageWatch.js'
import {
  approveDraft,
  draftHandoff,
  listDrafts,
  resolvePlaceholders,
} from './pageWatchDrafts.js'
import { registerPageWatchRoutes } from './pageWatchRoutes.js'

function temporaryStore() {
  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-watch-')),
    `watches-${crypto.randomUUID()}.json`,
  )
  return { filePath }
}

function temporaryDraftStore() {
  return {
    filePath: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-draft-')),
      `drafts-${crypto.randomUUID()}.json`,
    ),
  }
}

/** A page that answers with whatever the test says it says right now. */
function fakePage(pages) {
  let index = 0
  return {
    address: async () => ({
      target: { urlContains: 'example.com/orders/42' },
      url: 'https://example.com/orders/42',
      title: 'Order 42',
      disposition: 'reloaded',
    }),
    read: async () => {
      const page = pages[Math.min(index, pages.length - 1)]
      index += 1
      return { ...page, missing: page.missing ?? [] }
    },
  }
}

/* ------------------------------------------------------------ definitions */

test('fields are named so a report can say which one moved', () => {
  const fields = normalizeFields([
    'h1',
    { name: 'price', selector: '.price', pattern: '\\$[0-9.,]+' },
  ])
  assert.equal(fields[0].name, 'h1')
  assert.equal(fields[0].selector, 'h1')
  assert.equal(fields[1].name, 'price')
  assert.equal(fields[1].pattern, '\\$[0-9.,]+')
})

test('a watch with no fields still watches the whole page', () => {
  assert.deepEqual(
    normalizeFields([]).map((field) => field.name),
    ['page'],
  )
})

test('an unusable pattern fails at create time, not at 3am', () => {
  assert.throws(
    () => normalizeFields([{ name: 'price', pattern: '([0-9]' }]),
    /invalid pattern/,
  )
})

test('a field can carry the owner\u2019s own threshold', () => {
  const [field] = normalizeFields([{ name: 'price', minPercent: 5 }])
  assert.equal(field.minPercent, 5)
  assert.equal(field.minDelta, null)
})

/* --------------------------------------------------------- semantic anchors */

test('a semantic anchor finds a value by the words next to it', () => {
  const page = 'Order #42\nOrder status:   Shipped\nEstimated delivery   Friday'
  assert.equal(extractByAnchor(page, 'Order status'), 'Shipped')
  assert.equal(extractByAnchor(page, 'Estimated delivery'), 'Friday')
  assert.equal(extractByAnchor(page, 'Tracking number'), null)
})

test('an anchor survives the redesign that would break a selector', () => {
  /*
   * A selector is a bet on the page's markup and the owner is not there when
   * it loses: `.order-status-value` stops matching the week the site ships a
   * redesign, and the watch then says "the value is no longer on the page" on
   * every poll until a human fixes it. The words the page shows a human are
   * what survive, so they are offered as an alternative locator.
   */
  const before = 'Order status: Shipped\nTotal: $129.99'
  const after = 'ORDER STATUS\n   Shipped\n\nTotal\n   $129.99'
  assert.equal(extractByAnchor(before, 'order status'), 'Shipped')
  assert.equal(extractByAnchor(after, 'order status'), 'Shipped')
})

/* ------------------------------------------------------------------ diffing */

test('a diff names the field and carries the sentence it came from', () => {
  const changes = diffValues(
    { status: 'Processing', price: '$129.99' },
    { status: 'Shipped', price: '$129.99' },
    'Order #42 Status: Shipped Estimated delivery Friday',
  )
  assert.equal(changes.length, 1)
  assert.deepEqual(
    { field: changes[0].field, before: changes[0].before, after: changes[0].after },
    { field: 'status', before: 'Processing', after: 'Shipped' },
  )
  assert.match(changes[0].excerpt, /Status: Shipped/)
  assert.match(describeChanges(changes, 'Order 42'), /status Processing → Shipped/)
})

test('a field that disappears is a change, not silence', () => {
  const changes = diffValues({ price: '$129.99' }, { price: null }, '')
  assert.equal(changes[0].after, null)
  assert.match(describeChanges(changes, 'Printer'), /→ \(gone\)/)
})

test('a watch needs a real page to watch', () => {
  assert.throws(() => createWatch({ url: 'not-a-url' }, temporaryStore()), /http\(s\) url/)
})

/* --------------------------------------------------------------- the cycle */

test('the first check is a baseline and reports nothing', async () => {
  const store = temporaryStore()
  const watch = createWatch(
    {
      name: 'Order 42',
      url: 'https://example.com/orders/42',
      fields: [{ name: 'status', selector: '#status' }],
      everyMs: 60_000,
    },
    store,
  )
  const page = fakePage([
    { values: { status: 'Processing' }, pageText: 'Status: Processing', title: 'Order 42', url: 'https://example.com/orders/42' },
  ])

  const first = await checkWatch(watch.id, { ...store, ...page })
  assert.equal(first.baseline, true)
  assert.equal(first.changed, false)
  assert.equal(first.report, null)
  assert.equal(pendingReports(store).length, 0)
})

test('a later check reports only what changed, with before and after', async () => {
  const store = temporaryStore()
  const watch = createWatch(
    {
      name: 'Order 42',
      url: 'https://example.com/orders/42',
      fields: [{ name: 'status' }, { name: 'price' }],
      everyMs: 60_000,
    },
    store,
  )
  const page = fakePage([
    {
      values: { status: 'Processing', price: '$129.99' },
      pageText: 'Status: Processing Price: $129.99',
      title: 'Order 42',
      url: 'https://example.com/orders/42',
    },
    {
      values: { status: 'Processing', price: '$129.99' },
      pageText: 'Status: Processing Price: $129.99',
      title: 'Order 42',
      url: 'https://example.com/orders/42',
    },
    {
      values: { status: 'Shipped', price: '$129.99' },
      pageText: 'Status: Shipped Price: $129.99',
      title: 'Order 42',
      url: 'https://example.com/orders/42',
    },
  ])

  await checkWatch(watch.id, { ...store, ...page })
  const quiet = await checkWatch(watch.id, { ...store, ...page })
  assert.equal(quiet.changed, false)
  assert.equal(pendingReports(store).length, 0)

  const moved = await checkWatch(watch.id, { ...store, ...page })
  assert.equal(moved.changed, true)
  assert.equal(moved.changes.length, 1)
  assert.deepEqual(
    moved.changes.map((change) => [change.field, change.before, change.after]),
    [['status', 'Processing', 'Shipped']],
  )

  const pending = pendingReports(store)
  assert.equal(pending.length, 1)
  assert.match(pending[0].summary, /status Processing → Shipped/)

  assert.equal(acknowledgeReports(watch.id, store), 1)
  assert.equal(pendingReports(store).length, 0)

  const stored = getWatch(watch.id, store)
  assert.equal(stored.checkCount, 3)
  assert.equal(stored.changeCount, 1)
  assert.equal(stored.previous.values.status, 'Processing')
  assert.equal(stored.observed.values.status, 'Shipped')
})

/* ---------------------------------------------------------- meaningfulness */

test('a page whose only movement is its clock is watched in silence', async () => {
  /*
   * The whole point of the feature, end to end. A watch that reports every
   * diff is a notification the owner turns off in a day — and once it is off
   * it also fails to tell them the one thing that mattered, so it is worse
   * than not having built it.
   */
  const store = temporaryStore()
  const watch = createWatch(
    {
      name: 'Order 42',
      url: 'https://example.com/orders/42',
      fields: [{ name: 'status', selector: '#status' }, { name: 'updated', selector: '.updated' }],
      everyMs: 60_000,
    },
    store,
  )
  const page = fakePage([
    { values: { status: 'Processing', updated: 'Updated 14:32:07' }, pageText: '', title: '', url: '' },
    { values: { status: 'Processing', updated: 'Updated 14:41:52' }, pageText: '', title: '', url: '' },
    { values: { status: 'Shipped', updated: 'Updated 14:52:01' }, pageText: '', title: '', url: '' },
  ])

  await checkWatch(watch.id, { ...store, ...page })

  const noise = await checkWatch(watch.id, { ...store, ...page })
  assert.equal(noise.changed, false, 'the clock moved and the owner was not told')
  assert.equal(noise.suppressed.length, 1)
  assert.equal(pendingReports(store).length, 0)
  assert.match(noise.summary, /none of them meaningful/)

  const news = await checkWatch(watch.id, { ...store, ...page })
  assert.equal(news.changed, true)
  assert.deepEqual(
    news.changes.map((change) => change.field),
    ['status'],
    'the status is reported and the clock that moved with it is not',
  )
  /* The report records what it decided not to say, so the judgement is part of
   * the artefact rather than something only the log remembers. */
  assert.deepEqual(
    news.report.alsoChanged.map((change) => change.field),
    ['updated'],
  )
})

test('what a watch is not saying is auditable, so quiet and broken look different', async () => {
  const store = temporaryStore()
  const watch = createWatch(
    {
      name: 'Order 42',
      url: 'https://example.com/orders/42',
      fields: [{ name: 'updated' }],
      everyMs: 60_000,
    },
    store,
  )
  const page = fakePage([
    { values: { updated: '2 minutes ago' }, pageText: '', title: '', url: '' },
    { values: { updated: '17 minutes ago' }, pageText: '', title: '', url: '' },
  ])

  await checkWatch(watch.id, { ...store, ...page })
  await checkWatch(watch.id, { ...store, ...page })

  const hidden = suppressedChanges(watch.id, store)
  assert.equal(hidden.length, 1)
  assert.equal(hidden[0].field, 'updated')
  assert.ok(hidden[0].score < hidden[0].threshold)
  assert.match(hidden[0].reasons.join(' '), /timestamp/)
  assert.equal(getWatch(watch.id, store).suppressedCount, 1)
})

test('a threshold the owner set is honoured, and cannot be defeated by drift', async () => {
  const store = temporaryStore()
  const watch = createWatch(
    {
      name: 'Printer',
      url: 'https://example.com/printer',
      fields: [{ name: 'price', minPercent: 1 }],
      everyMs: 60_000,
    },
    store,
  )
  /* Each step is under 1%; the total is not. Measuring every step against the
   * previous reading would mean the owner is never told, having asked to be. */
  const page = fakePage([
    { values: { price: '$100.00' }, pageText: '', title: '', url: '' },
    { values: { price: '$100.40' }, pageText: '', title: '', url: '' },
    { values: { price: '$100.80' }, pageText: '', title: '', url: '' },
    { values: { price: '$101.20' }, pageText: '', title: '', url: '' },
  ])

  await checkWatch(watch.id, { ...store, ...page })
  assert.equal((await checkWatch(watch.id, { ...store, ...page })).changed, false)
  assert.equal((await checkWatch(watch.id, { ...store, ...page })).changed, false)

  const told = await checkWatch(watch.id, { ...store, ...page })
  assert.equal(told.changed, true, 'the move since the owner was last told crossed their threshold')
  assert.equal(getWatch(watch.id, store).anchors.price, '$101.20')
})

test('a change three screens down the page is seen', async () => {
  /*
   * The field value used to be truncated to 400 characters before comparison,
   * so a whole-page watch compared the top of the page and was blind to
   * everything below it. Detection now runs on a digest of the whole reading
   * and the report is built from the lines that moved.
   */
  const store = temporaryStore()
  const watch = createWatch(
    { name: 'Portal', url: 'https://example.com/portal', everyMs: 60_000 },
    store,
  )
  const filler = Array.from({ length: 20 }, (_, index) => `Notice ${index}: nothing to do here.`).join('\n')
  const before = `${filler}\nStatus: Processing`
  const after = `${filler}\nStatus: Shipped`
  assert.ok(before.length > 400, 'the change has to sit past the old truncation point')

  const page = fakePage([
    { values: { page: before }, raw: { page: before }, pageText: before, title: '', url: '' },
    { values: { page: after }, raw: { page: after }, pageText: after, title: '', url: '' },
  ])

  await checkWatch(watch.id, { ...store, ...page })
  const moved = await checkWatch(watch.id, { ...store, ...page })

  assert.equal(moved.changed, true)
  assert.equal(moved.changes[0].kind, 'segments')
  assert.deepEqual(
    [moved.changes[0].segments.edits[0].before, moved.changes[0].segments.edits[0].after],
    ['Status: Processing', 'Status: Shipped'],
  )
})

/* ------------------------------------------------------------- scheduling */

test('a poll claims its slot before it starts, so a slow check is not doubled', async () => {
  const store = temporaryStore()
  const watch = createWatch(
    { name: 'Slow page', url: 'https://example.com/slow', everyMs: 60_000 },
    store,
  )
  const dueBefore = getWatch(watch.id, store).nextRunAt

  let dueDuringTheCheck = null
  await checkWatch(watch.id, {
    ...store,
    now: Date.now() + 5_000,
    address: async () => {
      /* Mid-check: this is what a second tick would read off the store. */
      dueDuringTheCheck = getWatch(watch.id, store).nextRunAt
      return { target: {}, url: 'https://example.com/slow', title: '', disposition: 'reloaded' }
    },
    read: async () => ({ values: { page: 'x' }, pageText: 'x', title: '', url: '' }),
  })

  assert.ok(
    dueDuringTheCheck > dueBefore,
    'the next run was pushed out before the work started, not after it finished',
  )
})

test('a page that cannot be read is recorded, and the watch keeps its schedule', async () => {
  const store = temporaryStore()
  const watch = createWatch(
    { name: 'Portal', url: 'https://example.com/portal', everyMs: 60_000 },
    store,
  )
  const outcome = await checkWatch(watch.id, {
    ...store,
    address: async () => {
      throw new Error('The browser extension is offline.')
    },
  })

  assert.equal(outcome.ok, false)
  assert.match(outcome.summary, /could not be checked/)
  const stored = getWatch(watch.id, store)
  assert.match(stored.lastError, /offline/)
  assert.ok(stored.nextRunAt > Date.now())
})

test('a scheduled watch queues nothing when the extension is not connected', async () => {
  /*
   * The state this system has been in for most of its life. browserBridge
   * expires an unclaimed command after 90s, which bounds the damage but does
   * not prevent it: a watch on a fifteen-minute cadence against an extension
   * that has been offline for weeks would enqueue and expire thousands of
   * navigations, and any claimed late would open tabs in the owner's browser
   * hours after anyone wanted them.
   */
  const store = temporaryStore()
  const watch = createWatch(
    { name: 'Bank', url: 'https://example.com/bank', schedule: { kind: 'daily', at: '08:00' } },
    store,
  )
  const due = getWatch(watch.id, store).nextRunAt
  const queuedBefore = getBrowserStatus().pendingCommands

  const results = await tickPageWatches(due, {
    ...store,
    status: () => ({ online: false, devices: [], pendingCommands: 0 }),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0].skipped, 'browser-offline')
  assert.equal(
    getBrowserStatus().pendingCommands,
    queuedBefore,
    'nothing was put in a queue with nobody to drain it',
  )

  const stored = getWatch(watch.id, store)
  assert.equal(stored.missedChecks, 1)
  assert.ok(stored.offlineSince)
  /* A daily watch must not lose its day because Safari happened to be closed
   * at 08:00, so it retries on a short cadence rather than on its own. */
  assert.equal(stored.nextRunAt - due, 60_000)
})

test('a watch that has never managed to read its page says so', async () => {
  const store = temporaryStore()
  createWatch({ name: 'Bank', url: 'https://example.com/bank', everyMs: 60_000 }, store)

  const health = watchHealth(store)
  assert.equal(health.watches[0].neverChecked, true)
  assert.match(health.summary, /never managed to read their page/)
})

/* -------------------------------------------------------------- evidence */

test('a report cites both readings it compared, and each can be withheld alone', async () => {
  /*
   * A change is a claim about two readings. Citing only the current one makes
   * the "since the last time I looked" half of the promise unverifiable — and
   * the two expire independently, since the capsule TTL is 24 hours and
   * once-a-day is the cadence the owner asked for by name.
   */
  const store = temporaryStore()
  const first = mintCapsule({
    url: 'https://example.com/orders/42',
    content: 'Status: Processing',
    context: 'test',
  })
  const second = mintCapsule({
    url: 'https://example.com/orders/42',
    content: 'Status: Shipped',
    context: 'test',
  })

  const watch = createWatch(
    {
      name: 'Order 42',
      url: 'https://example.com/orders/42',
      fields: [{ name: 'status' }],
      everyMs: 60_000,
    },
    store,
  )
  const page = fakePage([
    { values: { status: 'Processing' }, pageText: '', title: '', url: '', capsuleIds: [first.capsuleId] },
    { values: { status: 'Shipped' }, pageText: '', title: '', url: '', capsuleIds: [second.capsuleId] },
  ])

  await checkWatch(watch.id, { ...store, ...page })
  const moved = await checkWatch(watch.id, { ...store, ...page })

  assert.deepEqual(moved.report.capsuleIds, [second.capsuleId])
  assert.deepEqual(moved.report.priorCapsuleIds, [first.capsuleId])

  /* Revoking the baseline leaves the news standing and says the before-value
   * can no longer be checked. Withholding the whole report for this would
   * delete the feature on its most-requested schedule. */
  revokeCapsules({ capsuleId: first.capsuleId, reason: 'test' })
  const partial = pendingReports(store)[0]
  assert.equal(partial.changes.length, 1)
  assert.match(partial.evidenceNote, /cannot be re-verified/)

  /* Revoking the reading the report stands on leaves nothing to show. */
  revokeCapsules({ capsuleId: second.capsuleId, reason: 'test' })
  const gone = pendingReports(store)[0]
  assert.deepEqual(gone.changes, [])
  assert.match(gone.summary, /no longer available/)
})

/* ---------------------------------------------------------------- drafts */

test('a follow-up is prepared and not sent', async () => {
  const store = temporaryStore()
  const draftStore = temporaryDraftStore()
  const watch = createWatch(
    {
      name: 'Order 42',
      url: 'https://example.com/orders/42',
      fields: [{ name: 'status' }, { name: 'order' }],
      everyMs: 60_000,
      followUp: {
        name: 'Ask about order {{order}}',
        url: 'https://example.com/support/contact',
        values: { subject: 'Order {{order}}', message: 'My order {{order}} is now {{status}}.' },
        onFields: ['status'],
      },
    },
    store,
  )
  const page = fakePage([
    { values: { status: 'Processing', order: '42' }, pageText: '', title: '', url: '' },
    { values: { status: 'Delayed', order: '42' }, pageText: '', title: '', url: '' },
  ])

  await checkWatch(watch.id, { ...store, ...page, draftStore })
  const moved = await checkWatch(watch.id, { ...store, ...page, draftStore })

  assert.ok(moved.draft, 'a change on a watched field prepared the follow-up')
  assert.equal(moved.draft.status, 'draft')
  assert.equal(moved.draft.values.subject, 'Order 42')
  assert.equal(moved.draft.values.message, 'My order 42 is now Delayed.')
  assert.equal(moved.draft.name, 'Ask about order 42')
  assert.deepEqual(moved.draft.because.changes, [
    { field: 'status', before: 'Processing', after: 'Delayed' },
  ])

  const handoff = draftHandoff(moved.draft.id, draftStore)
  assert.equal(handoff.submitted, false)
  assert.equal(handoff.fillForm.url, 'https://example.com/support/contact')
  assert.match(handoff.note, /stops before the submit control/)

  const approved = approveDraft(moved.draft.id, draftStore)
  assert.equal(approved.status, 'approved')
  assert.ok(approved.approvedAt, 'approval is recorded so the audit trail shows a human')
  assert.equal(listDrafts({ status: 'approved' }, draftStore).length, 1)
})

test('a follow-up scoped to one field stays quiet for the others', async () => {
  const store = temporaryStore()
  const draftStore = temporaryDraftStore()
  const watch = createWatch(
    {
      name: 'Order 42',
      url: 'https://example.com/orders/42',
      fields: [{ name: 'status' }, { name: 'price' }],
      everyMs: 60_000,
      followUp: {
        url: 'https://example.com/support/contact',
        values: { message: 'Where is it?' },
        onFields: ['status'],
      },
    },
    store,
  )
  const page = fakePage([
    { values: { status: 'Processing', price: '$129.99' }, pageText: '', title: '', url: '' },
    { values: { status: 'Processing', price: '$139.99' }, pageText: '', title: '', url: '' },
  ])

  await checkWatch(watch.id, { ...store, ...page, draftStore })
  const moved = await checkWatch(watch.id, { ...store, ...page, draftStore })

  assert.equal(moved.changed, true, 'the price change is still reported')
  assert.equal(moved.draft, null, 'but it is not the change this follow-up was for')
})

test('an unresolvable placeholder is left visible rather than blanked', () => {
  /* A draft with a silent hole in it is one the owner approves without
   * noticing. */
  assert.equal(resolvePlaceholders('Order {{order}}', { order: '42' }), 'Order 42')
  assert.equal(resolvePlaceholders('Order {{order}}', {}), 'Order {{order}}')
})

test('a malformed follow-up fails while the owner is setting it up', () => {
  assert.throws(
    () =>
      createWatch(
        {
          url: 'https://example.com/orders/42',
          followUp: { url: 'mailto:someone@example.com' },
        },
        temporaryStore(),
      ),
    /http\(s\) form url/,
  )
})

/* ----------------------------------------------------------- the brakes */

test('the watcher has no way to reach a page except by reading it', () => {
  /*
   * "Prepare drafts but do not submit" was in every proposal that asked for
   * this feature, so the brake is the deliverable and not a caveat. It is
   * asserted against the source because a flag defaulting to false can be
   * switched off by a caller, a config value, or a parameter someone adds in a
   * hurry — an import that does not exist cannot be.
   */
  const watcher = fs.readFileSync(new URL('./pageWatch.js', import.meta.url), 'utf8')
  for (const forbidden of ['browser_click', 'browser_type', 'browser_select', 'browser_press_key']) {
    assert.ok(!watcher.includes(forbidden), `the watcher must never emit ${forbidden}`)
  }

  const drafts = fs.readFileSync(new URL('./pageWatchDrafts.js', import.meta.url), 'utf8')
  for (const forbidden of ['browserPage', 'browserBridge', 'formFill', 'computerControl']) {
    assert.ok(
      !new RegExp(`from '\\./${forbidden}\\.js'`).test(drafts),
      `the draft module must not be able to reach ${forbidden}`,
    )
  }
})

/* ---------------------------------------------------------------- routes */

test('the routes mount fixed paths before the wildcard, and cover what the server already served', () => {
  /*
   * Express answers with whichever route was registered first, so registering
   * /watches/:watchId before /watches/drafts makes "drafts" a watch id and
   * every draft route 404s — silently, with a plausible-looking error. The
   * first cut of pageWatchRoutes.js did exactly that.
   */
  const registered = []
  const app = {
    get: (route) => registered.push(route),
    post: (route) => registered.push(route),
    patch: (route) => registered.push(route),
    delete: (route) => registered.push(route),
  }

  const result = registerPageWatchRoutes(app)
  const wildcard = registered.indexOf('/watches/:watchId')

  assert.ok(wildcard >= 0)
  for (const fixed of ['/watches/reports', '/watches/health', '/watches/drafts']) {
    assert.ok(
      registered.indexOf(fixed) < wildcard,
      `${fixed} must be registered before the wildcard or it can never match`,
    )
  }

  /* Everything the inline block in server.js serves today, so it can be
   * replaced with one call rather than half-replaced. */
  for (const existing of [
    '/watches',
    '/watches/reports',
    '/watches/:watchId',
    '/watches/:watchId/check',
    '/watches/:watchId/ack',
  ]) {
    assert.ok(registered.includes(existing), `${existing} is still served`)
  }
  assert.ok(result.mounted.length)
})

/* ------------------------------------------------------------ definitions */

test('retargeting a watch drops the baseline it no longer applies to', async () => {
  const store = temporaryStore()
  const watch = createWatch(
    { name: 'Order', url: 'https://example.com/a', everyMs: 60_000 },
    store,
  )
  await checkWatch(watch.id, {
    ...store,
    ...fakePage([{ values: { page: 'one' }, pageText: 'one', title: '', url: '' }]),
  })
  assert.ok(getWatch(watch.id, store).observed)

  updateWatch(watch.id, { url: 'https://example.com/b' }, store)
  const retargeted = getWatch(watch.id, store)
  assert.equal(retargeted.observed, null)
  /* The learned churn described a different page's fields and is worthless
   * against the new one. */
  assert.deepEqual(retargeted.history, {})

  assert.equal(listWatches(store).length, 1)
  assert.equal(deleteWatch(watch.id, store), true)
  assert.equal(listWatches(store).length, 0)
})
