import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  acknowledgeReports,
  checkWatch,
  createWatch,
  deleteWatch,
  describeChanges,
  diffValues,
  getWatch,
  listWatches,
  normalizeFields,
  pendingReports,
  updateWatch,
} from './pageWatch.js'

function temporaryStore() {
  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-watch-')),
    `watches-${crypto.randomUUID()}.json`,
  )
  return { filePath }
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
  assert.equal(getWatch(watch.id, store).observed, null)

  assert.equal(listWatches(store).length, 1)
  assert.equal(deleteWatch(watch.id, store), true)
  assert.equal(listWatches(store).length, 0)
})
