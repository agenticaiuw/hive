import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  MAX_ENTRY_BYTES,
  MAX_SPOOL_BYTES,
  clearBrowserSpool,
  fitEntry,
  readBrowserSpool,
  spoolBrowserCommand,
  spoolBytesOf,
} from './browserSpool.js'

function withTemporaryStore(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pendant-browser-spool-test-'),
  )
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return path.join(directory, 'browser-spool.json')
}

const commandOfSize = (bytes, index) => ({
  commandId: `browser_${index}`,
  action: { type: 'type', params: { selector: '#note', text: 'x'.repeat(bytes) } },
  reason: 'expired',
  queuedAt: new Date(1_700_000_000_000 + index).toISOString(),
})

test('an offline command is recorded with why it never ran', (t) => {
  const filePath = withTemporaryStore(t)

  spoolBrowserCommand(
    {
      commandId: 'browser_1',
      action: { type: 'navigate', params: { url: 'https://example.com' } },
      reason: 'expired',
      detail: 'no extension ran it before the TTL',
      queuedAt: '2026-08-07T12:00:00.000Z',
    },
    { filePath },
  )

  const spool = readBrowserSpool({ filePath })
  assert.equal(spool.count, 1)
  assert.equal(spool.entries[0].reason, 'expired')
  assert.equal(spool.entries[0].action.params.url, 'https://example.com')
  assert.equal(spool.dropped.entries, 0)
})

/*
 * The bound is in BYTES, and this is the test that says so.
 *
 * This project has been wedged once already by a store that capped a count. A
 * count is a budget in the wrong unit: the same five hundred entries are fifty
 * kilobytes or fifty megabytes depending on what happened to be in them, and
 * the counter reads identically either way. Thirty oversized commands here would
 * sit well inside any plausible entry cap while being several times the byte
 * budget, so a count-based store would pass a test like this and still fill the
 * disk.
 */
test('the spool is bounded in bytes, whatever the entries weigh', (t) => {
  const filePath = withTemporaryStore(t)

  for (let index = 0; index < 30; index += 1) {
    spoolBrowserCommand(commandOfSize(12_000, index), { filePath })
  }

  const spool = readBrowserSpool({ filePath })
  assert.ok(
    spool.bytes <= MAX_SPOOL_BYTES,
    `spool grew to ${spool.bytes} bytes, past the ${MAX_SPOOL_BYTES} ceiling`,
  )
  assert.ok(spool.count < 30, 'entries were evicted to stay inside the budget')
  assert.ok(spool.dropped.entries > 0)
  /* Eviction is oldest-first, so the most recent loss is always the one still
   * on the list — the one somebody might still act on. */
  assert.equal(spool.entries.at(-1).commandId, 'browser_29')
  /* No slack factor. The ten percent this once allowed was the undercount
   * below wearing a tolerance's clothes. */
  assert.ok(
    fs.statSync(filePath).size <= MAX_SPOOL_BYTES,
    `the file is ${fs.statSync(filePath).size} bytes, past the ${MAX_SPOOL_BYTES} ceiling`,
  )
})

/*
 * The budget is measured against the FILE, not against a proxy for it.
 *
 * Being in bytes was never enough on its own. atomicJsonStore writes with
 * JSON.stringify(store, null, 2) and this measured JSON.stringify(store) — the
 * compact form — so every check was made against a number the writer never
 * produced. Two undercounts compounded: the indentation itself, and the four
 * further spaces every line of an entry gains from sitting two levels down
 * inside `entries`.
 *
 * Measured, not reasoned about: four hundred entries of six hundred characters
 * each wrote a 306,682-byte file against the 262,144-byte budget — 17% over,
 * while readBrowserSpool cheerfully reported 261,902. The overshoot is
 * proportional to the number of LINES, so it takes MANY SMALL entries to
 * expose; the thirty fat ones above are nowhere near enough, which is precisely
 * why that test passed throughout. browserProvenance carries the same test for
 * the same reason.
 */
test('the budget is measured against the file, not against a proxy for it', (t) => {
  const filePath = withTemporaryStore(t)

  for (let index = 0; index < 400; index += 1) {
    spoolBrowserCommand(commandOfSize(600, index), { filePath })
  }

  const fileBytes = fs.statSync(filePath).size
  assert.ok(
    fileBytes <= MAX_SPOOL_BYTES,
    `the file on disk is ${fileBytes} bytes, past the ${MAX_SPOOL_BYTES}-byte budget`,
  )

  const spool = readBrowserSpool({ filePath })
  assert.equal(
    spool.bytes,
    fileBytes,
    'the reported size is the size of the file, not an optimistic proxy for it',
  )
  assert.equal(spool.maxBytes, MAX_SPOOL_BYTES, 'the shipped budget is what shipped')
  assert.ok(spool.count < 400, 'the store really did shed entries')
  assert.ok(spool.dropped.entries > 0, 'and counted what it shed')
  /* Eviction stayed oldest-first: the newest arrival is still the one on the
   * end, which is the one somebody might still act on. */
  assert.equal(spool.entries.at(-1).commandId, 'browser_399')
})

/*
 * A silently overflowed spool looks exactly like a spool nothing was ever
 * written to, and telling those two apart is the only reason to keep one.
 */
test('overflow is counted rather than hidden', (t) => {
  const filePath = withTemporaryStore(t)

  for (let index = 0; index < 30; index += 1) {
    spoolBrowserCommand(commandOfSize(12_000, index), { filePath })
  }

  const { dropped } = readBrowserSpool({ filePath })
  assert.ok(dropped.entries > 0)
  assert.ok(dropped.bytes > 0)
  assert.ok(dropped.firstAt)
  assert.ok(dropped.lastAt)
})

/*
 * One huge command must not be able to evict everything else on its way in.
 * Without a per-entry ceiling a single read_page of a large page leaves the
 * spool holding exactly one item — inside its byte budget, and useless.
 */
test('an oversized entry is trimmed rather than allowed to clear the store', (t) => {
  const filePath = withTemporaryStore(t)

  spoolBrowserCommand(commandOfSize(200, 1), { filePath })
  const huge = spoolBrowserCommand(commandOfSize(200_000, 2), { filePath })

  assert.equal(huge.action.paramsTruncated, true)
  assert.ok(spoolBytesOf(huge) <= MAX_ENTRY_BYTES)
  assert.equal(huge.action.type, 'type', 'what it was is still legible')
  assert.ok(huge.action.paramsBytes > MAX_ENTRY_BYTES, 'and how big it was')

  const spool = readBrowserSpool({ filePath })
  assert.equal(spool.count, 2, 'the entry that was already there survived')
})

test('trimming keeps the identity when there is nothing left to trim', () => {
  const entry = fitEntry(
    {
      commandId: 'browser_x',
      reason: 'expired',
      queuedAt: '2026-08-07T12:00:00.000Z',
      spooledAt: '2026-08-07T12:01:30.000Z',
      action: { type: 'type', params: { text: 'x'.repeat(50_000) } },
    },
    120,
  )

  assert.equal(entry.commandId, 'browser_x')
  assert.equal(entry.oversized, true)
  assert.ok(spoolBytesOf(entry) <= 400)
})

test('one spooled command can be cleared without clearing the rest', (t) => {
  const filePath = withTemporaryStore(t)

  spoolBrowserCommand({ commandId: 'a', reason: 'expired' }, { filePath })
  spoolBrowserCommand({ commandId: 'b', reason: 'expired' }, { filePath })

  assert.deepEqual(clearBrowserSpool('a', { filePath }), {
    cleared: 1,
    remaining: 1,
  })
  assert.equal(readBrowserSpool({ filePath }).entries[0].commandId, 'b')

  clearBrowserSpool(null, { filePath })
  const emptied = readBrowserSpool({ filePath })
  assert.equal(emptied.count, 0)
  assert.equal(emptied.dropped.entries, 0)
})

/* The spool is a record, not a queue. Nothing here hands work back to an
 * extension, because a command that fires hours late opens tabs in the owner's
 * Safari unrelated to anything they were doing — the failure the whole TTL
 * exists to prevent. */
test('reading the spool never revives anything', (t) => {
  const filePath = withTemporaryStore(t)
  spoolBrowserCommand({ commandId: 'a', reason: 'expired' }, { filePath })

  const first = readBrowserSpool({ filePath })
  const second = readBrowserSpool({ filePath })

  assert.deepEqual(first.entries, second.entries)
  assert.equal(Object.keys(first).includes('claim'), false)
})
