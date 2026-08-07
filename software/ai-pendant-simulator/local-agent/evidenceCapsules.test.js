import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildEvidenceLedger,
  capsuleIdFor,
  capsuleState,
  getCapsule,
  linkedCapsuleIds,
  listCapsules,
  mintCapsule,
  normalizeSource,
  presentCapsule,
  pseudonymFor,
  redactionMapFor,
  revokeCapsules,
  scoreCapture,
  sweepCapsules,
  usableCapsuleIds,
} from './evidenceCapsules.js'
import { buildActionReceipt, receiptsForJob } from './actionReceipts.js'
import { journalEntry } from './executionJournal.js'
import { captureBrowserEvidence } from './computerControl.js'

/* A disposable capsule store, so nothing a test reads lands in the owner's
 * real evidence history. */
function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'capsules.json')
  const previous = process.env.PENDANT_EVIDENCE_STORE_PATH
  process.env.PENDANT_EVIDENCE_STORE_PATH = filePath
  t.after(() => {
    if (previous === undefined) delete process.env.PENDANT_EVIDENCE_STORE_PATH
    else process.env.PENDANT_EVIDENCE_STORE_PATH = previous
  })
  return { filePath }
}

const READING = {
  url: 'https://portal.example/orders/4471?session=abc123',
  title: 'Order #4471',
  region: { kind: 'main_text' },
  content: 'Order #4471 shipped on 3 August.\nTotal $184.20.',
  context: 'browser-extension',
  session: 'orders-watch',
  tabId: 226923,
}

const HOUR = 60 * 60 * 1000

/* ------------------------------------------------------------- identity */

test('an unchanged page read twice is one capsule, not two', (t) => {
  const at = store(t)

  const first = mintCapsule({ ...READING, capturedAt: 1_000 }, at)
  /* Ninety minutes later, same bytes: a watch that polls all day must not
   * produce a capsule per poll. */
  const second = mintCapsule({ ...READING, capturedAt: 1_000 + 90 * 60_000 }, at)

  assert.equal(first.minted, true)
  assert.equal(second.minted, false)
  assert.equal(second.collapsed, true)
  assert.equal(second.capsuleId, first.capsuleId)
  assert.equal(
    second.capsule.capturedAt,
    first.capsule.capturedAt,
    'the stored capsule is immutable — a re-capture does not restamp it',
  )
  assert.equal(listCapsules({}, at).length, 1)
})

test('content that moved is different evidence, and says so', (t) => {
  const at = store(t)

  const before = mintCapsule(READING, at)
  const after = mintCapsule({ ...READING, content: 'Order #4471 delivered.' }, at)

  assert.notEqual(after.capsuleId, before.capsuleId)
  assert.equal(listCapsules({}, at).length, 2)
})

test('the same bytes seen through a different session are a different observation', (t) => {
  const at = store(t)

  const watch = mintCapsule(READING, at)
  const adhoc = mintCapsule({ ...READING, session: 'default' }, at)

  assert.notEqual(adhoc.capsuleId, watch.capsuleId)
})

test('the id is a digest of what was seen, not of when', () => {
  const core = {
    sourceKey: 'https://portal.example/orders/4471',
    regionKey: 'main_text|',
    observer: 'obs_abc',
    contentHash: 'sha256:deadbeef',
  }
  assert.equal(capsuleIdFor(core), capsuleIdFor({ ...core }))
  assert.match(capsuleIdFor(core), /^evd_[0-9a-f]{12}$/)
  assert.notEqual(capsuleIdFor(core), capsuleIdFor({ ...core, contentHash: 'sha256:other' }))
})

/* ------------------------------------------------------- pseudonymity */

test('a capsule carries no session name, no tab number, and no query string', (t) => {
  const at = store(t)
  const { capsule } = mintCapsule(READING, at)
  const serialized = JSON.stringify(capsule)

  assert.equal(serialized.includes('orders-watch'), false)
  assert.equal(serialized.includes('226923'), false)
  assert.equal(serialized.includes('session=abc123'), false)
  assert.equal(serialized.includes('abc123'), false)

  assert.match(capsule.observer.session, /^obs_[0-9a-f]{12}$/)
  assert.match(capsule.observer.tab, /^obs_[0-9a-f]{12}$/)
  assert.equal(capsule.observer.context, 'browser-extension')
  assert.equal(capsule.source.url, 'https://portal.example/orders/4471')
  assert.equal(capsule.source.queryDropped, true)
})

test('a tab id only means something next to the context that issued it', () => {
  const salt = 'a-fixed-salt'
  assert.notEqual(
    pseudonymFor(salt, 'safari#tab', '226923'),
    pseudonymFor(salt, 'chrome#tab', '226923'),
  )
  assert.equal(
    pseudonymFor(salt, 'safari#tab', '226923'),
    pseudonymFor(salt, 'safari#tab', '226923'),
  )
})

test('two stores give the same session different names', (t) => {
  const first = store(t)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-other-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const second = { filePath: path.join(directory, 'capsules.json') }

  const here = mintCapsule(READING, first)
  const there = mintCapsule(READING, second)

  assert.notEqual(
    here.capsule.observer.session,
    there.capsule.observer.session,
    'the salt is store-local, so an exported capsule cannot be joined back to a session name',
  )
})

test('the query string is dropped before a source is ever compared', () => {
  assert.equal(
    normalizeSource('https://portal.example/orders/4471?zx=1&session=tok').key,
    normalizeSource('https://portal.example/orders/4471').key,
  )
})

/* --------------------------------------------------------- redaction */

test('the redaction map is built out of redaction.js, and secrets never land in the body', (t) => {
  const at = store(t)
  const { capsule } = mintCapsule(
    {
      ...READING,
      content:
        'Welcome back.\napi_key: sk-live-9f2b7c1d4e6a8b0c3d5f\nContact us at help@portal.example.\nOrder shipped.',
    },
    at,
  )

  assert.equal(capsule.content.includes('sk-live-9f2b7c1d4e6a8b0c3d5f'), false)
  assert.match(capsule.content, /\[withheld\]/)
  assert.match(capsule.content, /Order shipped\./, 'only the secret line is withheld')

  assert.equal(capsule.redaction.counts.secret, 1)
  assert.equal(capsule.redaction.counts.sensitive, 1)
  assert.equal(capsule.redaction.classification, 'secret')
  assert.match(capsule.redaction.classifier, /redaction\.js/)

  const secret = capsule.redaction.map.find((entry) => entry.class === 'secret')
  assert.equal(secret.action, 'withheld')
  assert.equal(
    capsule.content.slice(secret.start, secret.end),
    'api_key: [withheld]',
    'the map offsets address the body as stored',
  )

  const personal = capsule.redaction.map.find((entry) => entry.class === 'sensitive')
  assert.equal(personal.action, 'flagged')
  assert.match(
    capsule.content.slice(personal.start, personal.end),
    /help@portal\.example/,
    'personal data is flagged and kept — the owner reads their own pages in full',
  )
})

test('one sentence with a secret does not withhold the whole page', () => {
  const long = `${'The order is on its way. '.repeat(20)}The wifi password is hunter2. ${'Delivery is Friday. '.repeat(20)}`
  const { content, counts } = redactionMapFor(long)

  assert.equal(counts.secret, 1)
  assert.equal(content.includes('hunter2'), false)
  assert.match(content, /The order is on its way\./)
  assert.match(content, /Delivery is Friday\./)
})

test('a page with nothing sensitive is stored exactly as it was read', () => {
  const text = 'Order #4471 shipped on 3 August.\nEstimated delivery Friday.'
  const { content, map, classification } = redactionMapFor(text)
  assert.equal(content, text)
  assert.deepEqual(map, [])
  assert.equal(classification, 'normal')
})

/* -------------------------------------------------------- confidence */

test('confidence carries the reasons it is not 1', () => {
  const clean = scoreCapture({
    requestedUrl: 'https://portal.example/orders/4471',
    landedUrl: 'https://portal.example/orders/4471',
    contentChars: 4000,
  })
  assert.equal(clean.score, 1)

  const messy = scoreCapture({
    requestedUrl: 'https://portal.example/orders/4471',
    landedUrl: 'https://login.example/sso',
    contentChars: 900,
    truncated: true,
    recovery: ['bootstrap_navigate'],
  })
  assert.ok(messy.score < clean.score)
  assert.match(messy.reasons.join(' '), /different host/)
  assert.match(messy.reasons.join(' '), /prefix/)
  assert.match(messy.reasons.join(' '), /tab had to be opened/)
})

/* --------------------------------------------------------------- TTL */

test('past its TTL a capsule stops being shown but keeps its row', (t) => {
  const at = store(t)
  const { capsule } = mintCapsule({ ...READING, capturedAt: 0, ttlMs: HOUR }, at)

  const fresh = presentCapsule(capsule, { now: 30 * 60_000 })
  assert.equal(fresh.state, 'live')
  assert.ok(fresh.content)

  const stale = presentCapsule(capsule, { now: 2 * HOUR })
  assert.equal(stale.state, 'expired')
  assert.equal(stale.content, null)
  assert.match(stale.withheld, /TTL/)
  assert.equal(stale.tombstone.contentHash, capsule.contentHash)

  assert.equal(getCapsule(capsule.capsuleId, at).content !== null, true, 'expiry withholds on read; it does not erase')
})

test('sweeping drops the body of a long-expired reading and never the row', (t) => {
  const at = store(t)
  const { capsule } = mintCapsule({ ...READING, capturedAt: 0, ttlMs: HOUR }, at)

  const early = sweepCapsules({ now: 2 * HOUR, graceMs: 24 * HOUR }, at)
  assert.equal(early.retired.length, 0, 'inside the grace window the text is still there')

  const later = sweepCapsules({ now: 48 * HOUR, graceMs: 24 * HOUR }, at)
  assert.equal(later.retired.length, 1)

  const row = getCapsule(capsule.capsuleId, at)
  assert.equal(row.content, null)
  assert.equal(row.contentHash, capsule.contentHash)
  assert.equal(capsuleState(row, 48 * HOUR), 'retired')
  assert.equal(listCapsules({}, at).length, 1)
})

/* -------------------------------------------------------- revocation */

test('revoking a source removes the reading and leaves a tombstone', (t) => {
  const at = store(t)
  const { capsule } = mintCapsule(READING, at)

  const outcome = revokeCapsules(
    { url: 'https://portal.example/orders/4471', reason: 'owner deleted the source' },
    at,
  )

  assert.equal(outcome.revoked.length, 1)
  assert.equal(outcome.revoked[0].capsuleId, capsule.capsuleId)
  assert.equal(outcome.revoked[0].contentHash, capsule.contentHash)
  assert.match(outcome.revoked[0].revokedReason, /owner deleted/)

  const row = getCapsule(capsule.capsuleId, at)
  assert.equal(row.content, null)
  assert.equal(row.capturedAt, capsule.capturedAt, 'nothing but the body is ever rewritten')
  assert.equal(row.source.url, capsule.source.url)

  const shown = presentCapsule(row)
  assert.equal(shown.state, 'revoked')
  assert.equal(shown.content, null)
  assert.ok(shown.tombstone.revokedAt)
})

test('re-reading the same unchanged page does not resurrect revoked evidence', (t) => {
  const at = store(t)
  const first = mintCapsule({ ...READING, capturedAt: 1_000 }, at)
  revokeCapsules({ capsuleId: first.capsuleId }, at)

  const again = mintCapsule({ ...READING, capturedAt: 2_000 }, at)
  assert.equal(again.capsuleId, first.capsuleId)
  assert.equal(again.minted, false)
  assert.equal(again.state, 'revoked')
  assert.equal(again.capsule.content, null)
})

test('a page that changed after a revocation is live evidence again', (t) => {
  const at = store(t)
  const first = mintCapsule(READING, at)
  revokeCapsules({ capsuleId: first.capsuleId }, at)

  const moved = mintCapsule({ ...READING, content: 'Order #4471 delivered.' }, at)
  assert.equal(moved.minted, true)
  assert.equal(moved.state, 'live')
  assert.ok(moved.capsule.content)
})

test('a whole host can be forgotten at once', (t) => {
  const at = store(t)
  mintCapsule(READING, at)
  mintCapsule({ ...READING, url: 'https://portal.example/orders/9', content: 'Order #9.' }, at)
  mintCapsule({ ...READING, url: 'https://other.example/x', content: 'Unrelated.' }, at)

  const outcome = revokeCapsules({ host: 'portal.example', reason: 'stop reading that site' }, at)
  assert.equal(outcome.revoked.length, 2)
  assert.equal(
    listCapsules({ state: 'live' }, at).map((item) => item.source.host).join(),
    'other.example',
  )
  assert.equal(listCapsules({}, at).length, 3, 'tombstones are never removed')
})

test('revoking twice reports the tombstone rather than rewriting it', (t) => {
  const at = store(t)
  const { capsuleId } = mintCapsule(READING, at)
  const first = revokeCapsules({ capsuleId, reason: 'first' }, at)
  const second = revokeCapsules({ capsuleId, reason: 'second' }, at)

  assert.equal(second.revoked.length, 0)
  assert.equal(second.alreadyRevoked.length, 1)
  assert.equal(
    second.alreadyRevoked[0].revokedReason,
    first.revoked[0].revokedReason,
    'the original reason survives',
  )
})

test('revoking needs something to match', (t) => {
  const at = store(t)
  assert.throws(() => revokeCapsules({}, at), /capsuleId, a url, or a host/)
})

/* ------------------------------------------------------------ linking */

test('capsule ids are found wherever a result happens to carry them', () => {
  assert.deepEqual(
    linkedCapsuleIds({ browser: { evidence: { capsuleId: 'evd_aaa' } } }),
    ['evd_aaa'],
  )
  assert.deepEqual(
    linkedCapsuleIds({ findings: [{ citation: { capsuleId: 'evd_a' } }], capsuleIds: ['evd_b'] }).sort(),
    ['evd_a', 'evd_b'],
  )
  assert.deepEqual(linkedCapsuleIds({ nothing: 'here' }), [])
})

test('usable ids exclude what has been revoked, and say why', (t) => {
  const at = store(t)
  const live = mintCapsule(READING, at)
  const dead = mintCapsule({ ...READING, content: 'Older text.' }, at)
  revokeCapsules({ capsuleId: dead.capsuleId }, at)

  const verdict = usableCapsuleIds([live.capsuleId, dead.capsuleId, 'evd_neverminted'], at)
  assert.deepEqual(verdict.usable, [live.capsuleId])
  assert.deepEqual(
    verdict.withheld.map((entry) => entry.state).sort(),
    ['revoked', 'unknown'],
  )
})

test('an empty link list never touches the store', () => {
  /* No env override in scope here on purpose: a caller with nothing to check
   * must not create the owner's capsule file as a side effect. */
  assert.deepEqual(usableCapsuleIds([]), { usable: [], withheld: [] })
})

/* -------------------------------------------------------- the mint point */

test('every browser reading mints its own kind of evidence', (t) => {
  const at = store(t)

  const read = captureBrowserEvidence(
    { type: 'browser_read_page', params: { mode: 'main_text', url: READING.url } },
    'read_page',
    {
      url: 'https://portal.example/orders/4471',
      title: 'Order #4471',
      content: 'Order #4471 shipped.',
      session: { id: 'orders-watch', recovery: [] },
      tabId: 226923,
    },
  )
  assert.match(read.capsuleId, /^evd_/)
  assert.equal(getCapsule(read.capsuleId, at).region.kind, 'main_text')

  const snapshot = captureBrowserEvidence(
    { type: 'browser_snapshot', params: {} },
    'snapshot',
    {
      url: 'https://portal.example/orders/4471',
      elements: [{ role: 'link', name: 'Download invoice', selector: '#invoice-link' }],
      session: { id: 'orders-watch' },
    },
  )
  assert.match(
    getCapsule(snapshot.capsuleId, at).content,
    /link "Download invoice" @ #invoice-link/,
  )

  const capture = captureBrowserEvidence({ type: 'browser_capture', params: {} }, 'capture', {
    url: 'https://portal.example/orders/4471',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo',
    session: { id: 'orders-watch' },
  })
  const shot = getCapsule(capture.capsuleId, at)
  assert.equal(shot.region.kind, 'screenshot')
  assert.equal(shot.content, '', 'screenshot bytes are never stored in a capsule')
  assert.equal(JSON.stringify(shot).includes('iVBORw0KGgo'), false)
})

test('an action that only writes to a page mints nothing', (t) => {
  store(t)
  assert.equal(
    captureBrowserEvidence({ type: 'browser_click', params: { ref: 'e1' } }, 'click', {
      url: 'https://portal.example/orders/4471',
    }),
    null,
  )
})

test('a store that cannot be written loses the capsule, never the reading', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-broken-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const previous = process.env.PENDANT_EVIDENCE_STORE_PATH
  /* A path whose parent is a file, so every write throws. */
  fs.writeFileSync(path.join(directory, 'blocked'), 'not a directory')
  process.env.PENDANT_EVIDENCE_STORE_PATH = path.join(directory, 'blocked', 'capsules.json')
  t.after(() => {
    if (previous === undefined) delete process.env.PENDANT_EVIDENCE_STORE_PATH
    else process.env.PENDANT_EVIDENCE_STORE_PATH = previous
  })

  const evidence = captureBrowserEvidence(
    { type: 'browser_read_page', params: {} },
    'read_page',
    { url: 'https://portal.example/x', content: 'text', session: { id: 'default' } },
  )

  assert.equal(evidence.capsuleId, null)
  assert.ok(evidence.error, 'the failure is recorded on the result, not thrown at the caller')
})

/* ------------------------------------------------------------ receipts */

test('a receipt links back to the capsule the reading produced', (t) => {
  store(t)
  const receipt = buildActionReceipt({
    action: { type: 'browser_read_page', params: { mode: 'main_text' } },
    result: {
      ok: true,
      browser: { evidence: { capsuleId: 'evd_abcdef123456' } },
    },
    startedAt: new Date(0).toISOString(),
  })

  assert.deepEqual(receipt.evidence.capsuleIds, ['evd_abcdef123456'])
  assert.equal(receipt.evidence.source, 'result')
})

test('a Mac action links evidence only when its caller tagged it', (t) => {
  store(t)

  const action = {
    type: 'write_file',
    params: { path: '~/Downloads/order.md', capsuleIds: ['evd_abcdef123456'] },
  }
  const tagged = buildActionReceipt({
    action,
    /* The executor echoes the action back inside the result. A declaration
     * bouncing off that echo must not be reported as an independent fact from
     * the browser — measured live before this was fixed. */
    result: { action, ok: true, path: '/Users/x/Downloads/order.md' },
    startedAt: new Date(0).toISOString(),
  })
  assert.deepEqual(tagged.evidence.capsuleIds, ['evd_abcdef123456'])
  assert.equal(tagged.evidence.source, 'declared')

  const untagged = buildActionReceipt({
    action: { type: 'write_file', params: { path: '~/Downloads/order.md' } },
    result: { ok: true },
    startedAt: new Date(0).toISOString(),
  })
  assert.deepEqual(untagged.evidence.capsuleIds, [])
  assert.equal(
    untagged.evidence.source,
    'unlinked',
    'an unlinked step says so rather than being attributed to a nearby capsule',
  )
})

test('a job recorded before capsules existed still recovers its ids from the result', (t) => {
  store(t)
  const [receipt] = receiptsForJob({
    result: {
      results: [
        {
          action: { type: 'browser_read_page', params: {} },
          ok: true,
          browser: { evidence: { capsuleId: 'evd_from_result' } },
        },
      ],
    },
  })
  assert.equal(receipt.synthesized, true)
  assert.deepEqual(receipt.evidence.capsuleIds, ['evd_from_result'])
})

test('the journal reports which steps stood on evidence and which did not', (t) => {
  store(t)
  const entry = journalEntry({
    jobId: 'local_1',
    type: 'execute',
    status: 'completed',
    command: 'read my orders page',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(1_000).toISOString(),
    result: {
      results: [
        {
          action: { type: 'browser_read_page', params: {} },
          ok: true,
          receipt: buildActionReceipt({
            action: { type: 'browser_read_page', params: {} },
            result: { ok: true, browser: { evidence: { capsuleId: 'evd_page' } } },
            startedAt: new Date(0).toISOString(),
          }),
        },
        {
          action: { type: 'copy_to_clipboard', params: { text: 'Shipped' } },
          ok: true,
          receipt: buildActionReceipt({
            action: { type: 'copy_to_clipboard', params: { text: 'Shipped' } },
            result: { ok: true },
            startedAt: new Date(0).toISOString(),
          }),
        },
      ],
    },
  })

  assert.deepEqual(entry.capsuleIds, ['evd_page'])
  assert.equal(entry.counts.evidenced, 1)
  assert.equal(entry.actions[0].evidence.source, 'result')
  assert.equal(entry.actions[1].evidence.source, 'unlinked')
})

/* -------------------------------------------------------------- ledger */

test('the ledger counts states, names its gaps, and joins receipts to capsules', (t) => {
  const at = store(t)
  const live = mintCapsule(READING, at)
  const revoked = mintCapsule({ ...READING, content: 'Older text.' }, at)
  revokeCapsules({ capsuleId: revoked.capsuleId }, at)

  const ledger = buildEvidenceLedger(
    {
      jobs: [
        {
          jobId: 'local_9',
          result: {
            results: [
              { receipt: { type: 'browser_read_page', evidence: { capsuleIds: [live.capsuleId] } } },
            ],
          },
        },
      ],
    },
    at,
  )

  assert.equal(ledger.readOnly, true)
  assert.equal(ledger.counts.capsules, 2)
  assert.equal(ledger.counts.live, 1)
  assert.equal(ledger.counts.revoked, 1)
  assert.equal(ledger.counts.cited, 1)
  assert.deepEqual(ledger.hosts, ['portal.example'])

  const shown = ledger.capsules.find((item) => item.capsuleId === live.capsuleId)
  assert.deepEqual(shown.citedBy, [{ jobId: 'local_9', type: 'browser_read_page' }])

  assert.ok(
    ledger.notCovered.some((line) => /read_web_page/.test(line)),
    'the relay-side reader that mints nothing is named, not hidden',
  )
})

test('nothing on this path can gate a browser action', (t) => {
  const at = store(t)
  const { capsule } = mintCapsule(READING, at)

  /* No token, no expiry the owner has to clear, no approval. Evidence is a
   * record of a reading that already happened. */
  for (const forbidden of [
    'requiresApproval',
    'approvedAt',
    'confirmationToken',
    'blocked',
    'pending',
  ]) {
    assert.equal(forbidden in capsule, false)
  }

  /* Assert the promise, not one phrasing of it — the note said "Nothing on
   * this path can block, refuse, or delay" and the old pattern demanded
   * "cannot", so a reworded sentence failed a test that guards behaviour. */
  const ledger = buildEvidenceLedger({}, at)
  assert.match(ledger.note, /block, refuse, or delay/)
})
