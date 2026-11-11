import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MAX_RECORD_BYTES,
  MAX_STORE_BYTES,
  checkClaim,
  claimKeyFor,
  getProvenance,
  isSecretLocator,
  listProvenance,
  logLineFor,
  markUndone,
  normalizeLocator,
  normalizeUrl,
  presentRecord,
  priorValueFor,
  pruneRecords,
  recordBrowserResult,
  recordExtraction,
  recordMutation,
  registerBrowserProvenanceRoutes,
  snippetDigest,
  storeBytesOf,
  traceClaim,
  undoPlanFor,
} from './browserProvenance.js'

function withStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-browser-provenance-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return path.join(directory, 'provenance.json')
}

const ORDER_PAGE =
  'Order #48812\nStatus: Shipped\nYour order ships Tuesday, August 11.\nLast updated 14:32:07'

/* ------------------------------------------------------------- recording */

test('an extraction records where it came from and never the page text', (t) => {
  const filePath = withStore(t)

  const record = recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812?session=abc123',
      requestedUrl: 'https://shop.example.com/orders/48812',
      title: 'Order 48812',
      tabId: 7,
      windowId: 2,
      extensionId: 'ext-a',
      selector: '#order-status',
      mode: 'text',
      commandId: 'browser_1',
      capsuleId: 'evd_deadbeef',
      ledgerId: 'ldg_1',
      stepKey: 'act_1#0',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  assert.equal(record.kind, 'extraction')
  assert.equal(record.tab.tabId, 7)
  assert.equal(record.tab.windowId, 2)
  assert.equal(record.at, '2026-08-07T12:00:00.000Z')
  assert.equal(record.locator.kind, 'selector')
  assert.equal(record.locator.selector, '#order-status')
  assert.match(record.locator.durability, /re-resolvable/)
  assert.ok(record.snippet.hash, 'the snippet is digested')

  /* The join keys are ids and only ids. */
  assert.equal(record.links.capsuleId, 'evd_deadbeef')
  assert.equal(record.links.ledgerId, 'ldg_1')
  assert.equal(record.links.stepKey, 'act_1#0')

  /* The query string carried a session token and is gone. */
  assert.equal(record.source.url, 'https://shop.example.com/orders/48812')
  assert.equal(record.source.queryDropped, true)
  assert.equal(record.source.redirected, false)

  /*
   * The whole point of the digest: the page is not in the store. The claim is,
   * because a briefing already said it out loud, but the sentences around it
   * are not.
   */
  const onDisk = fs.readFileSync(filePath, 'utf8')
  assert.ok(!onDisk.includes('Order #48812'), 'no page text reached the store')
  assert.ok(!onDisk.includes('August 11'), 'no page text reached the store')
  assert.ok(!onDisk.includes('session=abc123'), 'no query string reached the store')
  assert.ok(onDisk.includes('Your order ships Tuesday'), 'the claim itself is kept')
})

test('a redirect is recorded as a fact rather than resolved away', (t) => {
  const filePath = withStore(t)

  const record = recordExtraction(
    {
      text: 'Please sign in to continue.',
      url: 'https://shop.example.com/login',
      requestedUrl: 'https://shop.example.com/orders/48812',
      selector: '#main',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  assert.equal(record.source.redirected, true)
  assert.equal(record.source.requestedUrl, 'https://shop.example.com/orders/48812')
  assert.equal(record.source.url, 'https://shop.example.com/login')
})

/* ------------------------------------------- the three-way distinction */

test('a claim that was never in the text is caught at capture, not later', (t) => {
  const filePath = withStore(t)

  const invented = recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Thursday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  assert.equal(invented.claim.grounded, false)
  assert.equal(invented.claim.source, 'asserted')

  /*
   * And it stays caught. The page can be re-read unchanged forever and the
   * verdict is still "nothing ever said this" — which is the one of the three
   * failures no later evidence can recover, and the one nothing in this project
   * could previously distinguish from the other two.
   */
  const verdict = checkClaim(invented.recordId, ORDER_PAGE, { filePath })
  assert.equal(verdict.verdict, 'unsupported')
  assert.equal(verdict.act, 'retract')
  assert.equal(verdict.groundedAtCapture, false)
})

test('a claim from a page that has since changed reads as stale, not as invented', (t) => {
  const filePath = withStore(t)

  const record = recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )
  assert.equal(record.claim.grounded, true)

  const changed = ORDER_PAGE.replace('ships Tuesday, August 11', 'ships Friday, August 14')
  const verdict = checkClaim(record.recordId, changed, { filePath })

  assert.equal(verdict.verdict, 'stale')
  assert.equal(verdict.act, 're-read')
  assert.equal(verdict.pageChanged, true)
  assert.equal(verdict.meaningChanged, true)
  assert.equal(verdict.claimPresent, false)
})

test('a page that only re-rendered its clock does not invalidate the claim', (t) => {
  const filePath = withStore(t)

  const record = recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  /*
   * This is what makes the check usable at all. Nearly every logged-in page
   * renders a timestamp somewhere; without the noise-masked hash every check of
   * every claim comes back "the page changed" and the owner learns to ignore it.
   */
  const rerendered = ORDER_PAGE.replace('14:32:07', '15:04:51')
  const verdict = checkClaim(record.recordId, rerendered, { filePath })

  assert.equal(verdict.verdict, 'cosmetic')
  assert.equal(verdict.act, 'trust')
  assert.equal(verdict.pageChanged, true, 'the bytes did move')
  assert.equal(verdict.meaningChanged, false, 'but nothing it says did')
})

test('an unchanged page that does not contain the claim contradicts it', (t) => {
  const filePath = withStore(t)

  /* Grounding is skipped by handing the claim in without text to check it
   * against — the shape a caller takes when it stored a claim it did not read
   * itself. The later check is then the only evidence available. */
  const record = recordExtraction(
    {
      text: '',
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )
  assert.equal(record.claim.grounded, null, 'uncheckable is not the same as ungrounded')

  const verdict = checkClaim(record.recordId, ORDER_PAGE, { filePath })
  assert.equal(verdict.verdict, 'unknown', 'nothing was stored to compare against')
  assert.equal(verdict.act, 'ask')

  /* With a snippet to compare against, the same absence is a contradiction. */
  const grounded = recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )
  const stripped = ORDER_PAGE.replace('Your order ships Tuesday, August 11.', '')
  const second = checkClaim(grounded.recordId, stripped, { filePath })
  assert.ok(['stale', 'contradicted'].includes(second.verdict))
})

test('a locator that stopped returning anything reads as gone', (t) => {
  const filePath = withStore(t)

  const record = recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  const verdict = checkClaim(record.recordId, '   ', { filePath })
  assert.equal(verdict.verdict, 'gone')
  assert.equal(verdict.act, 'ask')
})

test('the check needs no disk read when handed the record', (t) => {
  const filePath = withStore(t)
  const record = recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
    },
    { filePath },
  )

  fs.rmSync(filePath)
  fs.rmSync(`${filePath}.bak`, { force: true })

  const verdict = checkClaim(record, ORDER_PAGE)
  assert.equal(verdict.verdict, 'holds')
  assert.equal(verdict.act, 'trust')
})

test('persisting a verdict overwrites rather than appends', (t) => {
  const filePath = withStore(t)
  const record = recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
    },
    { filePath },
  )

  for (let index = 0; index < 20; index += 1) {
    checkClaim(record.recordId, ORDER_PAGE, { filePath, persist: true })
  }

  const stored = getProvenance(record.recordId, { filePath })
  assert.equal(stored.lastCheck.verdict, 'holds')
  assert.equal(listProvenance({}, { filePath }).total, 1, 'checking never adds rows')
})

/* -------------------------------------------------------------- mutations */

test('a write inherits its before-value from an earlier read of the same field', (t) => {
  const filePath = withStore(t)

  /* A scoped read IS the field's value — this is what makes read-then-write
   * undoable without asking any caller to change how it reads. */
  const read = recordExtraction(
    {
      text: 'evan@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
      mode: 'text',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )
  assert.equal(read.claim.source, 'reading')
  assert.equal(read.claim.text, 'evan@example.com')

  const write = recordMutation(
    {
      action: 'type',
      after: 'new@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
      ref: 'ref_4',
      commandId: 'browser_2',
      at: Date.parse('2026-08-07T12:05:00.000Z'),
    },
    { filePath },
  )

  assert.equal(write.kind, 'mutation')
  assert.equal(write.before.known, true)
  assert.equal(write.before.source, 'inherited')
  assert.equal(write.before.from, read.recordId)
  assert.equal(write.before.value, 'evan@example.com')
  assert.equal(write.after.value, 'new@example.com')

  assert.equal(write.undo.undoable, true)
  assert.deepEqual(write.undo.action, {
    type: 'browser_type',
    label: 'restore the previous value',
    params: { selector: '#email', text: 'evan@example.com' },
  })
  assert.ok(
    write.undo.caveats.some((note) => note.includes('earlier reading')),
    'an inherited before-value says it is only as current as the read it came from',
  )
})

test('a write with nothing read before it is not undoable, and says what would have made it so', (t) => {
  const filePath = withStore(t)

  const write = recordMutation(
    {
      action: 'type',
      after: 'new@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
    },
    { filePath },
  )

  assert.equal(write.before.known, false)
  assert.equal(write.before.source, 'unknown')
  assert.equal(write.undo.undoable, false)
  assert.match(write.undo.reason, /blank it rather than put it back/)
  assert.match(write.undo.reason, /Read the field/)
})

test('a summariser assertion is never mistaken for a field value', (t) => {
  const filePath = withStore(t)

  recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/account',
      selector: '#email',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  const write = recordMutation(
    {
      action: 'type',
      after: 'new@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
      at: Date.parse('2026-08-07T12:05:00.000Z'),
    },
    { filePath },
  )

  /* Typing a briefing sentence into the field it was read near would be a
   * second edit wearing an undo's clothes. */
  assert.equal(write.before.known, false)
  assert.equal(write.undo.undoable, false)
})

test('an explicit before-value beats an inherited one', (t) => {
  const filePath = withStore(t)

  recordExtraction(
    {
      text: 'stale@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  const write = recordMutation(
    {
      action: 'type',
      before: 'live@example.com',
      after: 'new@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
      at: Date.parse('2026-08-07T12:05:00.000Z'),
    },
    { filePath },
  )

  assert.equal(write.before.source, 'supplied')
  assert.equal(write.before.value, 'live@example.com')
  assert.equal(write.undo.action.params.text, 'live@example.com')
  assert.ok(!write.undo.caveats.some((note) => note.includes('earlier reading')))
})

test('a click carries provenance and an honest refusal to undo it', (t) => {
  const filePath = withStore(t)

  const click = recordMutation(
    {
      action: 'click',
      url: 'https://shop.example.com/orders/48812',
      selector: 'button.cancel',
      tabId: 7,
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  assert.equal(click.undo.undoable, false)
  assert.match(click.undo.reason, /not a value that can be put back/)
  /* But it is still fully recorded: which tab, which page, which control, when. */
  assert.equal(click.tab.tabId, 7)
  assert.equal(click.locator.selector, 'button.cancel')
  assert.equal(click.source.url, 'https://shop.example.com/orders/48812')
})

test('a submit and a ref-only locator each add a caveat the undo cannot fix', (t) => {
  const filePath = withStore(t)

  const write = recordMutation(
    {
      action: 'type',
      before: 'old note',
      after: 'new note',
      submitted: true,
      url: 'https://shop.example.com/notes',
      ref: 'ref_12',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  assert.equal(write.undo.undoable, true)
  assert.equal(write.undo.action.params.ref, 'ref_12')
  assert.ok(write.undo.caveats.some((note) => note.includes('un-submit')))
  assert.ok(write.undo.caveats.some((note) => note.includes('snapshot ref')))
})

test('a failed write has nothing to put back', (t) => {
  const filePath = withStore(t)

  const write = recordMutation(
    {
      action: 'type',
      before: 'old note',
      after: 'new note',
      ok: false,
      url: 'https://shop.example.com/notes',
      selector: '#note',
    },
    { filePath },
  )

  assert.equal(write.ok, false)
  assert.equal(write.undo.undoable, false)
  assert.match(write.undo.reason, /write failed/)
})

test('a write can be checked against what it wrote, so a silent rejection is visible', (t) => {
  const filePath = withStore(t)

  const write = recordMutation(
    {
      action: 'type',
      before: '555-0100',
      after: '555-0199',
      url: 'https://shop.example.com/account',
      selector: '#phone',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  const stuck = checkClaim(write.recordId, '555-0199', { filePath })
  assert.equal(stuck.subject, 'write')
  assert.equal(stuck.verdict, 'holds')
  assert.match(stuck.why, /still holds what was written/)

  /*
   * The failure this catches: the site accepted the keystrokes, re-rendered the
   * form from the server, and put the old value back. The extension reported
   * "Typed into #phone" and nothing downstream ever found out.
   */
  const rejected = checkClaim(write.recordId, '555-0100', { filePath })
  assert.equal(rejected.verdict, 'stale')
  assert.match(rejected.why, /changed the field after the write/)

  const gone = checkClaim(write.recordId, '', { filePath })
  assert.equal(gone.verdict, 'gone')
  assert.match(gone.why, /form may have been replaced/)
})

/* ------------------------------------------------------------- sensitivity */

test('a credential field records neither its value nor a digest of it', (t) => {
  const filePath = withStore(t)

  assert.equal(isSecretLocator({ selector: '#password' }), true)
  assert.equal(isSecretLocator({ selector: '#email' }), false)

  const write = recordMutation(
    {
      action: 'type',
      before: '1234',
      after: 'hunter2',
      url: 'https://shop.example.com/login',
      selector: 'input#password',
    },
    { filePath },
  )

  assert.equal(write.before.value, null)
  assert.equal(write.after.value, null)
  /*
   * And no hash either. A digest of a page is fine to keep; a digest of a
   * four-digit door code or a six-character password is the value itself with
   * an afternoon of compute in front of it, and low-entropy secrets are exactly
   * what this product handles.
   */
  assert.equal(write.before.digest.hash, null)
  assert.equal(write.after.digest.hash, null)
  assert.equal(write.after.digest.shape, 'withheld')
  assert.equal(write.undo.undoable, false)

  const onDisk = fs.readFileSync(filePath, 'utf8')
  assert.ok(!onDisk.includes('hunter2'))
  assert.ok(!onDisk.includes('1234'))
})

test('a spoken secret inside an ordinary field is withheld from the record', (t) => {
  const filePath = withStore(t)

  const write = recordMutation(
    {
      action: 'type',
      before: 'nothing yet',
      after: 'the bike lock code is 4829',
      url: 'https://notes.example.com/list',
      selector: '#note-body',
    },
    { filePath },
  )

  assert.ok(!fs.readFileSync(filePath, 'utf8').includes('4829'))
  assert.equal(write.after.withheld, true)
  /* The before-value was innocent, so the undo survives. */
  assert.equal(write.undo.undoable, true)
})

test('a value longer than the restore limit keeps its digest and loses its undo', (t) => {
  const filePath = withStore(t)

  const write = recordMutation(
    {
      action: 'type',
      before: 'x'.repeat(5_000),
      after: 'y',
      url: 'https://notes.example.com/list',
      selector: '#note-body',
    },
    { filePath },
  )

  assert.equal(write.before.value, null)
  assert.ok(write.before.digest.hash, 'the digest still answers "did this land"')
  assert.equal(write.undo.undoable, false)
  assert.match(write.undo.reason, /restore limit/)
})

/* -------------------------------------------------------------- leakage */

test('nothing that can hold page text reaches a log line', (t) => {
  const filePath = withStore(t)
  const SENTINEL = 'zzqqxsentinelvaluezz'

  const read = recordExtraction(
    {
      text: `Account holder ${SENTINEL} lives here`,
      claim: `Account holder ${SENTINEL}`,
      url: `https://shop.example.com/account/${SENTINEL}`,
      title: `Account ${SENTINEL}`,
      selector: `#field-${SENTINEL}`,
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  const write = recordMutation(
    {
      action: 'type',
      before: SENTINEL,
      after: `${SENTINEL}-new`,
      url: `https://shop.example.com/account/${SENTINEL}`,
      selector: `#field-${SENTINEL}`,
      at: Date.parse('2026-08-07T12:05:00.000Z'),
    },
    { filePath },
  )

  for (const record of [read, write]) {
    const line = JSON.stringify(logLineFor(record))
    assert.ok(!line.includes(SENTINEL), 'a log line carries hashes, ids and hosts only')
  }

  /* A URL path on a logged-in site is itself a disclosure. */
  assert.equal(logLineFor(read).host, 'shop.example.com')
  assert.ok(!JSON.stringify(logLineFor(read)).includes('/account/'))
})

test('the module makes no console call at all', () => {
  /*
   * Asserted against the source rather than left to review. Every other
   * protection here is about what a caller chooses to print; this is the one
   * that stops the module printing something itself, which is the failure mode
   * nobody reviews for because it does not appear in any signature.
   */
  const source = fs.readFileSync(
    fileURLToPath(new URL('./browserProvenance.js', import.meta.url)),
    'utf8',
  )
  assert.ok(!/\bconsole\s*\./.test(source), 'browserProvenance.js must never log')
})

test('the claim and the field values are withheld from a presentation unless asked for', (t) => {
  const filePath = withStore(t)

  const write = recordMutation(
    {
      action: 'type',
      before: 'evan@example.com',
      after: 'new@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
    },
    { filePath },
  )

  const quiet = presentRecord(write)
  assert.equal(quiet.before.value, null)
  assert.equal(quiet.after.value, null)
  assert.equal(quiet.undo.action, null)
  assert.equal(quiet.before.known, true, 'that a value exists is not itself secret')
  assert.equal(quiet.undo.undoable, true)

  const revealed = presentRecord(write, { reveal: true })
  assert.equal(revealed.before.value, 'evan@example.com')
  assert.equal(revealed.undo.action.params.text, 'evan@example.com')

  /* Allowlisted, not spread: a field added to the store later cannot leave
   * until somebody adds it here on purpose. */
  const listed = listProvenance({}, { filePath }).records[0]
  assert.ok(!('undone' in listed) || listed.undone === null)
  assert.equal(listed.before.value, null)
})

/* ------------------------------------------------------------- the trace */

test('a spoken sentence can be traced back to its page by hash alone', (t) => {
  const filePath = withStore(t)

  recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  /* Normalisation is shared with pageWatch, so whitespace does not defeat it. */
  const found = traceClaim('your   order ships tuesday', { filePath })
  assert.equal(found.ok, true)
  assert.equal(found.found, 1)
  assert.equal(found.records[0].source.url, 'https://shop.example.com/orders/48812')
  assert.equal(found.records[0].claim.grounded, true)

  const missing = traceClaim('your order ships next March', { filePath })
  assert.equal(missing.found, 0)
  assert.match(missing.note, /not proof it was invented/)
})

test('a claim withheld as a secret is still traceable by whoever knows the text', (t) => {
  const filePath = withStore(t)

  recordExtraction(
    {
      text: 'the wifi password is swordfish99',
      claim: 'the wifi password is swordfish99',
      url: 'https://router.example.com/status',
      selector: '#wifi',
    },
    { filePath },
  )

  assert.ok(!fs.readFileSync(filePath, 'utf8').includes('swordfish99'))

  const found = traceClaim('the wifi password is swordfish99', { filePath })
  assert.equal(found.found, 1)
  assert.equal(found.records[0].claim.withheld, true)
  assert.equal(found.records[0].claim.text, null)
  assert.equal(found.records[0].claim.key, claimKeyFor('the wifi password is swordfish99'))
})

/* ---------------------------------------------------------------- undo */

test('the undo path returns a plan and runs nothing', (t) => {
  const filePath = withStore(t)

  recordExtraction(
    {
      text: 'evan@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )
  const write = recordMutation(
    {
      action: 'type',
      after: 'new@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
      at: Date.parse('2026-08-07T12:05:00.000Z'),
    },
    { filePath },
  )

  const plan = undoPlanFor(write.recordId, { filePath })
  assert.equal(plan.executed, false)
  assert.equal(plan.undoable, true)
  assert.equal(plan.action.type, 'browser_type')
  assert.equal(plan.context.wrote, 'type')
  assert.match(plan.note, /Nothing has run/)

  markUndone(write.recordId, { jobId: 'job_9', filePath })
  const after = undoPlanFor(write.recordId, { filePath })
  assert.equal(after.undoable, false)
  assert.match(after.reason, /already put back/)
  assert.equal(after.undone.jobId, 'job_9')

  const reading = listProvenance({ kind: 'extraction' }, { filePath }).records[0]
  const notAWrite = undoPlanFor(reading.recordId, { filePath })
  assert.equal(notAWrite.undoable, false)
  assert.match(notAWrite.reason, /nothing to undo/)
})

test('a select is put back by its previous option', (t) => {
  const filePath = withStore(t)

  const write = recordMutation(
    {
      action: 'select',
      before: 'standard',
      after: 'overnight',
      url: 'https://shop.example.com/checkout',
      selector: '#shipping',
    },
    { filePath },
  )

  assert.deepEqual(write.undo.action, {
    type: 'browser_select',
    label: 'restore the previously selected option',
    params: { selector: '#shipping', value: 'standard' },
  })
})

/* --------------------------------------------------------------- bounding */

test('the budget is measured against the file, not against a proxy for it', (t) => {
  const filePath = withStore(t)

  /*
   * A count cap is a budget in the wrong unit and this project has been wedged
   * once already by one. But the trap this test is actually aimed at is the
   * second one, which the first cut of this module walked straight into:
   * measuring the budget with a different serializer than the writer uses.
   *
   * atomicJsonStore writes with an indent of two, and a record nested two levels
   * inside the store gains four spaces on every one of its lines. Summing
   * records at indent zero put the real file 14% over a budget the code believed
   * it was inside — an assertion away from being a bound that was never a bound.
   *
   * The budget is overridable so this can be proven in forty writes rather than
   * a thousand; the undercount is proportional, so a small budget catches it
   * exactly as a large one does. The default is asserted separately below.
   */
  const maxStoreBytes = 24 * 1024

  for (let index = 0; index < 80; index += 1) {
    recordExtraction(
      {
        text: `${'page body '.repeat(40)} ${index}`,
        claim: `claim number ${index} `.repeat(6).slice(0, 190),
        url: `https://shop.example.com/orders/${index}?token=${'t'.repeat(80)}`,
        title: `Order ${index} ${'title '.repeat(20)}`,
        selector: `#field-${index}-${'x'.repeat(60)}`,
        at: Date.parse('2026-08-07T12:00:00.000Z') + index * 1000,
      },
      { filePath, maxStoreBytes },
    )
  }

  const fileBytes = fs.statSync(filePath).size
  assert.ok(
    fileBytes <= maxStoreBytes,
    `the file on disk is ${fileBytes} bytes, past the ${maxStoreBytes}-byte budget`,
  )

  const listed = listProvenance({ limit: 1 }, { filePath })
  assert.equal(
    listed.budget.usedBytes,
    fileBytes,
    'the measured budget is the size of the file, not a proxy for it',
  )
  assert.equal(listed.budget.maxStoreBytes, MAX_STORE_BYTES, 'the default is what ships')
  assert.ok(listed.dropped.records > 0, 'what fell off is counted')
  assert.ok(listed.dropped.through, 'and dated')
  assert.ok(listed.total < 80, 'the store really did shed records')

  /* And the survivors are the newest, not whatever happened to be first. */
  assert.equal(listed.records[0].source.url, 'https://shop.example.com/orders/79')
})

test('the shipped budget holds at the shipped constants', () => {
  /*
   * The same arithmetic at the real numbers, without paying six fsyncs a record
   * to find out. pruneRecords is what save() calls, so this is the production
   * path with the production budget — only the disk is missing.
   */
  const records = Array.from({ length: 4_000 }, (_unused, index) => ({
    recordId: `prv_${index}`,
    kind: 'extraction',
    at: new Date(Date.parse('2026-08-07T12:00:00.000Z') + index * 1000).toISOString(),
    links: { commandId: `browser_${index}`, capsuleId: `evd_${index}`, ledgerId: null },
    tab: { tabId: index % 12, windowId: 1, extensionId: 'ext-a' },
    source: {
      url: `https://shop.example.com/orders/${index}`,
      host: 'shop.example.com',
      title: `Order ${index} ${'title '.repeat(20)}`,
    },
    locator: { kind: 'selector', selector: `#field-${'x'.repeat(60)}`, key: `sel|#field-${index}` },
    snippet: { hash: 'a'.repeat(16), maskedHash: 'b'.repeat(16), chars: 4_000 },
    claim: { source: 'asserted', text: 'c'.repeat(190), key: 'd'.repeat(16), grounded: true },
  }))

  const pruned = pruneRecords(records)
  assert.ok(pruned.dropped > 0, 'the shipped budget bites')
  assert.ok(
    pruned.bytes <= MAX_STORE_BYTES,
    `pruned to ${pruned.bytes} bytes, past the ${MAX_STORE_BYTES}-byte budget`,
  )

  /* Measured the way the writer writes, including the nesting. */
  const asWritten = Buffer.byteLength(
    JSON.stringify(
      { version: 1, records: pruned.records, dropped: { records: 1, bytes: 1, through: null } },
      null,
      2,
    ),
    'utf8',
  )
  assert.ok(
    asWritten <= MAX_STORE_BYTES,
    `serialized as the writer writes it this is ${asWritten} bytes`,
  )
})

test('an un-undone write outranks a reading under pressure, but is not exempt', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')

  const reading = (index) => ({
    recordId: `prv_read_${index}`,
    kind: 'extraction',
    at: new Date(now + index * 1000).toISOString(),
    snippet: { hash: 'abc', filler: 'f'.repeat(600) },
  })
  const write = (index) => ({
    recordId: `prv_write_${index}`,
    kind: 'mutation',
    at: new Date(now - 500_000 + index).toISOString(),
    before: { known: true, value: 'old' },
    undo: { undoable: true, action: { type: 'browser_type' }, caveats: [] },
    undone: null,
  })

  const records = [
    ...Array.from({ length: 400 }, (_unused, index) => reading(index)),
    write(0),
    write(1),
  ]

  const pruned = pruneRecords(records, { maxStoreBytes: 40 * 1024 })
  assert.ok(pruned.dropped > 0, 'the budget bit')
  assert.ok(pruned.bytes <= 40 * 1024)

  /* The writes are the oldest records here and survive anyway: a reading can be
   * re-taken from the page and an undo whose before-value is gone cannot be
   * reconstructed from anything. */
  assert.ok(pruned.records.some((record) => record.recordId === 'prv_write_0'))
  assert.ok(pruned.records.some((record) => record.recordId === 'prv_write_1'))

  /* Not exempt, though. Enough of them and they compete like everything else —
   * an exemption is how a bounded store becomes an unbounded one. */
  const manyWrites = Array.from({ length: 4_000 }, (_unused, index) => ({
    ...write(index),
    recordId: `prv_write_${index}`,
    padding: 'p'.repeat(200),
  }))
  const squeezed = pruneRecords(manyWrites, { maxStoreBytes: 40 * 1024 })
  assert.ok(squeezed.dropped > 0, 'un-undone writes are ranked first, never exempted')
  assert.ok(squeezed.bytes <= 40 * 1024)
})

test('an oversized record is shed field by field and says which undo it cost', () => {
  const record = {
    recordId: 'prv_big',
    kind: 'mutation',
    at: '2026-08-07T12:00:00.000Z',
    claim: null,
    before: { known: true, value: 'b'.repeat(MAX_RECORD_BYTES) },
    after: { value: 'a'.repeat(MAX_RECORD_BYTES) },
    undo: { undoable: true, action: { type: 'browser_type' }, caveats: [] },
  }

  const [fitted] = pruneRecords([record]).records
  assert.ok(storeBytesOf(fitted) <= MAX_RECORD_BYTES)
  assert.equal(fitted.after.value, null)
  assert.equal(fitted.before.value, null)
  assert.equal(fitted.before.known, false)
  assert.equal(fitted.undo.undoable, false)
  assert.match(fitted.undo.reason, /byte budget/)
  assert.deepEqual(fitted.compacted, ['after.value', 'before.value'])
})

/* --------------------------------------------------------------- adapter */

test('a completed bridge command becomes provenance in one call', (t) => {
  const filePath = withStore(t)

  /* The shape browserBridge.completeBrowserCommand returns: the extension
   * stamped tab, landed URL and locator, and the bridge added the command,
   * the session and the clocks. Nothing below re-derives any of that. */
  const completed = {
    commandId: 'browser_77',
    status: 'completed',
    sessionId: 'orders',
    action: { type: 'read_page', params: { selector: '#order-status', mode: 'text' } },
    result: {
      content: ORDER_PAGE,
      resultType: 'page_text',
      evidence: { capsuleId: 'evd_1234' },
      provenance: {
        commandId: 'browser_77',
        tabId: 7,
        windowId: 2,
        url: 'https://shop.example.com/orders/48812?session=abc',
        requestedUrl: 'https://shop.example.com/orders/48812',
        title: 'Order 48812',
        locator: '#order-status',
        extensionId: 'ext-a',
        sessionId: 'orders',
        observedAt: '2026-08-07T12:00:00.000Z',
        requestedAt: '2026-08-07T11:59:58.000Z',
      },
    },
  }

  const filed = recordBrowserResult(completed, { filePath })
  assert.equal(filed.ok, true)
  assert.equal(filed.record.kind, 'extraction')
  assert.equal(filed.record.tab.tabId, 7)
  assert.equal(filed.record.tab.extensionId, 'ext-a')
  assert.equal(filed.record.links.capsuleId, 'evd_1234')
  assert.equal(filed.record.links.commandId, 'browser_77')
  assert.equal(filed.record.source.url, 'https://shop.example.com/orders/48812')
  assert.equal(filed.record.at, '2026-08-07T12:00:00.000Z')
  assert.equal(filed.record.requestedAt, '2026-08-07T11:59:58.000Z')

  const typed = recordBrowserResult(
    {
      commandId: 'browser_78',
      status: 'completed',
      action: {
        type: 'type',
        params: { selector: '#email', text: 'new@example.com', submit: true },
      },
      result: {
        provenance: {
          tabId: 7,
          url: 'https://shop.example.com/account',
          locator: '#email',
          observedAt: '2026-08-07T12:01:00.000Z',
        },
      },
    },
    { filePath },
  )

  assert.equal(typed.record.kind, 'mutation')
  assert.equal(typed.record.action, 'type')
  assert.equal(typed.record.after.value, 'new@example.com')
  assert.equal(typed.record.submitted, true)
})

test('the adapter never throws into a completion path', () => {
  const broken = recordBrowserResult(
    { action: { type: 'read_page', params: {} }, result: { content: 'x' } },
    { filePath: '/dev/null/not-a-directory/store.json' },
  )
  assert.equal(broken.ok, false)
  assert.equal(broken.record, null)
  assert.ok(broken.error)
})

/* ---------------------------------------------------------------- routes */

test('the routes register, read, and never execute', (t) => {
  const filePath = withStore(t)
  const registered = []
  const app = {
    get: (route, handler) => registered.push(['GET', route, handler]),
    post: (route, handler) => registered.push(['POST', route, handler]),
  }

  const routes = registerBrowserProvenanceRoutes(app, { filePath })
  assert.deepEqual(routes, [
    'GET /browser/provenance',
    'POST /browser/provenance/trace',
    'GET /browser/provenance/:recordId',
    'POST /browser/provenance/:recordId/check',
    'GET /browser/provenance/:recordId/undo',
    'POST /browser/provenance/:recordId/undone',
  ])

  /* The literal is registered before the parameterised route, or Express
   * answers /trace with the record lookup. */
  const traceAt = registered.findIndex(([, route]) => route.endsWith('/trace'))
  const byIdAt = registered.findIndex(([, route]) => route.endsWith('/:recordId'))
  assert.ok(traceAt < byIdAt)

  assert.throws(() => registerBrowserProvenanceRoutes({}), /Express-style app/)

  const record = recordExtraction(
    {
      text: ORDER_PAGE,
      claim: 'Your order ships Tuesday',
      url: 'https://shop.example.com/orders/48812',
      selector: '#order-status',
    },
    { filePath },
  )

  const call = (method, suffix, { params = {}, query = {}, body = {} } = {}) => {
    const entry = registered.find(([verb, route]) => verb === method && route.endsWith(suffix))
    let payload = null
    let status = 200
    entry[2](
      { params, query, body },
      {
        json: (value) => {
          payload = value
          return value
        },
        status: (code) => {
          status = code
          return { json: (value) => (payload = value) }
        },
      },
    )
    return { payload, status }
  }

  const check = call('POST', '/:recordId/check', {
    params: { recordId: record.recordId },
    body: { text: ORDER_PAGE },
  })
  assert.equal(check.payload.executed, false)
  assert.equal(check.payload.verdict, 'holds')

  const listed = call('GET', '/browser/provenance')
  assert.equal(listed.payload.readOnly, true)
  assert.equal(listed.payload.records[0].claim.text, null, 'reveal is opt-in')

  const revealed = call('GET', '/browser/provenance', { query: { reveal: '1' } })
  assert.equal(revealed.payload.records[0].claim.text, 'Your order ships Tuesday')

  const missing = call('GET', '/:recordId', { params: { recordId: 'prv_nope' } })
  assert.equal(missing.status, 404)
})

/* --------------------------------------------------------------- helpers */

test('the digest borrows pageWatch normalisation so a watch and a claim agree', () => {
  const spaced = snippetDigest('Ships   Tuesday')
  const plain = snippetDigest('Ships Tuesday')
  assert.equal(spaced.hash, plain.hash)
  assert.equal(snippetDigest('').hash, null)
  assert.equal(snippetDigest('  ').shape, 'empty')
  assert.equal(snippetDigest('$129.99').shape, 'number')
})

test('a locator key is an address, not a description of how you looked', () => {
  const read = normalizeLocator({ selector: '#email', mode: 'text' })
  const write = normalizeLocator({ selector: '#email', ref: 'ref_4' })
  assert.equal(read.key, write.key, 'a read and a write of one field must join')
  assert.equal(read.kind, 'selector')
  assert.equal(write.kind, 'ref')
  assert.equal(normalizeLocator({}).key, 'document')
  assert.match(normalizeLocator({ ref: 'ref_1' }).durability, /does not survive a reload/)
})

test('a prior value is only inherited from the same page and the same field', (t) => {
  const filePath = withStore(t)

  recordExtraction(
    {
      text: 'evan@example.com',
      url: 'https://shop.example.com/account',
      selector: '#email',
      at: Date.parse('2026-08-07T12:00:00.000Z'),
    },
    { filePath },
  )

  const locator = normalizeLocator({ selector: '#email' })
  assert.ok(
    priorValueFor(
      { url: 'https://shop.example.com/account', locator, before: Date.now() },
      { filePath },
    ),
  )
  assert.equal(
    priorValueFor(
      { url: 'https://other.example.com/account', locator, before: Date.now() },
      { filePath },
    ),
    null,
  )
  assert.equal(
    priorValueFor(
      {
        url: 'https://shop.example.com/account',
        locator: normalizeLocator({ selector: '#phone' }),
        before: Date.now(),
      },
      { filePath },
    ),
    null,
  )
  /* A read taken after the write is not a before-value. */
  assert.equal(
    priorValueFor(
      {
        url: 'https://shop.example.com/account',
        locator,
        before: Date.parse('2026-08-07T11:00:00.000Z'),
      },
      { filePath },
    ),
    null,
  )
})

test('a URL keeps its address and loses its query', () => {
  const parsed = normalizeUrl('https://shop.example.com/orders/48812?token=secret#frag')
  assert.equal(parsed.url, 'https://shop.example.com/orders/48812')
  assert.equal(parsed.host, 'shop.example.com')
  assert.equal(parsed.queryDropped, true)
  assert.equal(normalizeUrl('not a url').url, 'not a url')
})
