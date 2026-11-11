import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildPayload,
  linkElements,
  matchField,
  parseFormHtml,
  renderPreview,
  resolveOption,
} from './formFill.js'
import { getLedger } from './actionLedger.js'
import {
  PREVIEW_TTL_MS,
  approveFormPreview,
  discardFormPreview,
  encodeFormBody,
  formPreviewHandoff,
  getFormPreview,
  listFormPreviews,
  markFormPreviewSubmitted,
  prepareFormPreview,
  prepareMessagePreview,
  recheckFormPreview,
  registerFormPreviewRoutes,
  renderLiteralForm,
  renderLiteralMessage,
  scrubValue,
} from './formPreview.js'

/* The same public Selenium test form formFill.test.js uses, so both files are
 * arguing about a page that exists rather than one written to suit them. */
const FORM_HTML = `<form action="submit-support.php" method="post">
  <label>Text input <input type="text" name="my-text" id="my-text-id" required></label>
  <label>Password <input type="password" name="my-password"></label>
  <label>Textarea <textarea name="my-textarea" rows="3"></textarea></label>
  <label>Dropdown (select) <select name="my-select"><option selected>Open this select menu</option><option value="1">One</option><option value="2">Two</option></select></label>
  <input class="form-check-input" type="checkbox" name="my-check" id="my-check-1" value="on" checked>
  <button class="btn" type="submit">Submit</button>
</form>`

const SNAPSHOT = [
  { ref: 'e0', selector: '#my-text-id', role: 'textbox', tag: 'input', inputType: 'text', name: 'Text input', disabled: false },
  { ref: 'e1', selector: 'form > label:nth-of-type(2) > input', role: 'textbox', tag: 'input', inputType: 'password', name: 'Password', disabled: false },
  { ref: 'e2', selector: 'form > label:nth-of-type(3) > textarea', role: 'textbox', tag: 'textarea', name: 'Textarea', disabled: false },
  { ref: 'e3', selector: 'form > select', role: 'combobox', tag: 'select', name: 'my-select', disabled: false },
  { ref: 'e4', selector: '#my-check-1', role: 'checkbox', tag: 'input', inputType: 'checkbox', name: 'Checked checkbox', checked: true, disabled: false },
  { ref: 'e5', selector: 'form > button', role: 'button', tag: 'button', name: 'Submit', disabled: false },
]

const PAGE_URL = 'https://support.example.com/tickets/new'

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'form-preview-'))
  return {
    root,
    filePath: path.join(root, 'previews.json'),
    ledgerPath: path.join(root, 'ledger.json'),
    raw: () => fs.readFileSync(path.join(root, 'previews.json'), 'utf8'),
  }
}

/*
 * A stand-in for formFill.fillForm built out of formFill's OWN exported parts.
 *
 * The point is that the manifest under test is derived the way the real one is
 * — same parser, same linker, same buildPayload — so a change in how formFill
 * decides what the browser would send reaches these tests instead of sliding
 * past a hand-written fixture. Only the browser round trip is faked.
 */
function fillManifest({ values = {}, html = FORM_HTML, url = PAGE_URL, snapshot = SNAPSHOT } = {}) {
  const { form, controls } = parseFormHtml(html, url)
  const elements = linkElements(snapshot, controls)
  const filledByRef = new Map()

  for (const [key, raw] of Object.entries(values)) {
    const hit = matchField(key, elements)
    if (!hit || hit.element.isSubmit) continue
    if (hit.element.inputType === 'password') {
      /* Exactly what fillForm does: never typed, always named. */
      filledByRef.set(hit.element.ref, { value: '', redacted: true })
      continue
    }
    const value =
      hit.element.tag === 'select'
        ? (resolveOption(hit.element.control, raw)?.value ?? String(raw))
        : raw
    filledByRef.set(hit.element.ref, { value })
  }

  const { entries, omitted } = buildPayload(elements, filledByRef)
  const contract = {
    method: form?.method ?? 'GET',
    submitsTo: form?.submitsTo ?? url,
    enctype: form?.enctype ?? '',
  }
  const submitControl = elements.find((element) => element.isSubmit && !element.disabled)

  return {
    id: 'fill_test',
    name: 'new support ticket',
    at: new Date().toISOString(),
    page: { url, title: 'New ticket', disposition: 'reloaded' },
    stoppedBefore: 'submit',
    submit: {
      label: submitControl?.label ?? null,
      ref: submitControl?.ref ?? null,
      selector: submitControl?.selector ?? null,
      clicked: false,
      howToSend: `browser_click with selector ${submitControl?.selector}`,
    },
    willSend: { ...contract, fields: entries },
    preview: renderPreview(contract, entries),
    filled: [],
    unmatched: [],
    notSent: omitted,
    missingRequired: [],
    warnings: [],
    screenshotPath: null,
    summary: 'Stopped before Submit.',
  }
}

/** A filler that answers each call from a queue, and records what it was given. */
function queueFill(...manifests) {
  const calls = []
  const fill = async (input) => {
    calls.push(input)
    return manifests[Math.min(calls.length - 1, manifests.length - 1)]
  }
  fill.calls = calls
  return fill
}

const bodyOf = (text) => {
  const at = text.indexOf('\n\n')
  return at < 0 ? text.slice(text.indexOf('?') + 1) : text.slice(at + 2)
}

const pairsOf = (query) => [...new URLSearchParams(query).entries()].sort()

async function prepared(box, { values = {}, fill = null, now = Date.now() } = {}) {
  return prepareFormPreview(
    { url: PAGE_URL, values },
    {
      fill: fill ?? queueFill(fillManifest({ values })),
      filePath: box.filePath,
      ledgerPath: box.ledgerPath,
      now,
    },
  )
}

/* ------------------------------------------------- the payload is literal */

test('the body is encoded the way a browser encodes a form, not the way a URL is', () => {
  /* application/x-www-form-urlencoded writes a space as '+', and a textarea's
   * newlines go on the wire as CRLF. encodeURIComponent agrees with neither. */
  const body = encodeFormBody([
    { name: 'my-text', value: 'Evan Liu' },
    { name: 'my-textarea', value: 'line one\nline two' },
  ])
  assert.equal(body, 'my-text=Evan+Liu&my-textarea=line+one%0D%0Aline+two')
})

test('the literal and formFill\'s own sentence describe the same request', () => {
  /* Two renderings of one payload is two chances to disagree. They may differ
   * in encoding — that is deliberate, see encodeFormBody — and must never
   * differ in which fields carry which values. */
  const manifest = fillManifest({ values: { 'Text input': 'Evan Liu', 'Dropdown (select)': 'Two' } })
  const literal = renderLiteralForm(manifest.willSend, manifest.willSend.fields)
  assert.deepEqual(pairsOf(bodyOf(literal.text)), pairsOf(bodyOf(manifest.preview)))
})

test('a field formFill leaves out of its sentence is still in the literal payload', () => {
  /* A password box the fill declined to type into is submitted anyway. Dropping
   * it produces a preview of a request that will not be made. */
  const manifest = fillManifest({ values: { Password: 'hunter2' } })
  const literal = renderLiteralForm(manifest.willSend, [
    ...manifest.willSend.fields.map((field) => ({
      ...field,
      withheld: field.redacted ? { reason: 'password', chars: 0 } : null,
    })),
  ])

  assert.ok(!manifest.preview.includes('my-password'))
  assert.match(literal.text, /my-password=/)
  assert.equal(literal.complete, false)
  assert.ok(literal.withheld.some((entry) => entry.name === 'my-password'))
})

test('the digest covers exactly the characters that were shown', () => {
  const manifest = fillManifest({ values: { 'Text input': 'Evan Liu' } })
  const literal = renderLiteralForm(manifest.willSend, manifest.willSend.fields)
  const rehashed = renderLiteralForm(manifest.willSend, manifest.willSend.fields)
  assert.equal(literal.sha256, rehashed.sha256)
  /* Change one character of the payload and the digest an approval is bound to
   * must move. */
  const moved = renderLiteralForm(manifest.willSend, [
    ...manifest.willSend.fields.slice(0, -1),
    { ...manifest.willSend.fields.at(-1), value: 'something else' },
  ])
  assert.notEqual(literal.sha256, moved.sha256)
})

test('a multipart form says the bytes cannot be shown rather than inventing them', () => {
  const literal = renderLiteralForm(
    { method: 'POST', submitsTo: 'https://x.example/upload', enctype: 'multipart/form-data' },
    [{ name: 'note', value: 'hello', label: 'Note' }],
  )
  assert.equal(literal.complete, false)
  assert.match(literal.text, /boundary=<chosen by the browser at submit time>/)
  assert.match(literal.notes.join(' '), /field names and values below are exact/)
  /* And it is not pretending to be a urlencoded body. */
  assert.ok(!literal.text.includes('note=hello'))
})

test('a GET form previews the query string it would actually navigate to', () => {
  const literal = renderLiteralForm(
    { method: 'GET', submitsTo: 'https://x.example/search', enctype: '' },
    [{ name: 'q', value: 'late order' }],
  )
  assert.equal(literal.text, 'GET https://x.example/search?q=late+order')
  assert.equal(literal.complete, true)
})

/* ------------------------------------------------------------- gathering */

test('preparing gathers the page, fills, and stops with the payload spelled out', async () => {
  const box = sandbox()
  const preview = await prepared(box, {
    values: { 'Text input': 'Evan Liu', Textarea: 'My order never arrived.' },
  })

  assert.equal(preview.status, 'awaiting-approval')
  assert.equal(preview.submit.clicked, false)
  assert.match(preview.payload.text, /^POST https:\/\/support\.example\.com\/tickets\/submit-support\.php/)
  assert.match(preview.payload.text, /Content-Type: application\/x-www-form-urlencoded; charset=UTF-8/)
  assert.match(preview.payload.text, /Content-Length: \d+/)
  assert.match(preview.payload.text, /my-text=Evan\+Liu/)
  assert.match(preview.payload.text, /my-textarea=My\+order\+never\+arrived\./)
  /* An untouched control is in the payload too, because the browser sends it. */
  assert.match(preview.payload.text, /my-check=on/)
})

test('the submit action is a click that carries no values at all', async () => {
  const box = sandbox()
  const preview = await prepared(box, { values: { 'Text input': 'Evan Liu' } })
  const action = preview.submit.action

  assert.equal(action.type, 'browser_click')
  assert.deepEqual(Object.keys(action.params).sort(), ['ref', 'selector', 'urlContains'])
  /* Everything it would send is already on the page. That is why a secret can
   * be typed and still never reach any record here. */
  assert.ok(!JSON.stringify(action).includes('Evan Liu'))
})

test('a value that is a credential is typed onto the page and kept out of the record', async () => {
  const box = sandbox()
  const secret = 'my key is sk_live_abcdefghij1234567890'
  const fill = queueFill(fillManifest({ values: { Textarea: secret } }))
  const preview = await prepareFormPreview(
    { url: PAGE_URL, values: { Textarea: secret } },
    { fill, filePath: box.filePath, ledgerPath: box.ledgerPath },
  )

  /* The fill was given the real text — the page is where it belongs. */
  assert.equal(fill.calls[0].values.Textarea, secret)
  /* The retained record is not. This is the hole browserBridge just closed and
   * it stays closed on this path too. */
  assert.ok(!box.raw().includes('sk_live_abcdefghij1234567890'))
  assert.ok(!preview.payload.text.includes('sk_live'))
  assert.ok(preview.payload.withheld.some((entry) => entry.name === 'my-textarea'))
  assert.equal(preview.payload.complete, false)
  assert.deepEqual(preview.valuesWithheld, ['Textarea'])
  /* Length only. A digest of a four-digit door code is the door code. */
  assert.deepEqual(Object.keys(preview.payload.withheld[0]).sort(), ['chars', 'label', 'name', 'reason'])
})

test('the payload says out loud what it cannot see', async () => {
  const box = sandbox()
  const preview = await prepared(box)
  const caveats = preview.caveats.join(' ')
  /* Hidden inputs — CSRF tokens, cart ids — are submitted and are not in the
   * interactive snapshot this is built from. */
  assert.match(caveats, /hidden/i)
  assert.match(caveats, /Nothing re-reads it at the moment of the click/)
})

/* ------------------------------------------------------------- the ledger */

test('the submit is written to the plan manifest before it can happen', async () => {
  const box = sandbox()
  const preview = await prepared(box)

  const ledger = getLedger(preview.ledgerId, { filePath: box.ledgerPath })
  assert.ok(ledger, 'the manifest is on disk')
  assert.equal(ledger.steps.length, 1)
  assert.equal(ledger.steps[0].type, 'browser_click')
  assert.equal(ledger.steps[0].phase, 'pending')
  /* The tier actionLedger already assigns to it: off the machine, and nothing
   * takes it back. That is what makes the approval worth having. */
  assert.equal(preview.risk.tier, 'off-machine')
  assert.equal(preview.risk.reversible, false)
})

test('a message preview books its send on the same ledger, not a parallel record', async () => {
  const box = sandbox()
  const preview = await prepareMessagePreview(
    { to: 'support@example.com', subject: 'Late order', body: 'It never arrived.' },
    { filePath: box.filePath, ledgerPath: box.ledgerPath },
  )
  const ledger = getLedger(preview.ledgerId, { filePath: box.ledgerPath })
  assert.equal(ledger.steps[0].type, 'send_email')
  assert.equal(preview.risk.tier, 'off-machine')
  assert.equal(preview.risk.needsApproval, true)
})

/* ------------------------------------------------------------- approval */

test('preparing approves nothing', async () => {
  const box = sandbox()
  const preview = await prepared(box)
  assert.equal(preview.approval.status, 'pending')
  assert.equal(preview.approval.approvedAt, null)
  assert.equal(formPreviewHandoff(preview.id, { filePath: box.filePath }).ok, false)
})

test('the confirmation code is returned once and never written down', async () => {
  const box = sandbox()
  const preview = await prepared(box)
  const digits = preview.approval.confirm.replace(/\D/g, '')

  assert.match(preview.approval.confirm, /^\d{3}-\d{3}$/)
  /* The one property that matters: a process that finds this record later — a
   * scheduler, a resumed job — cannot recover the code from disk. */
  assert.ok(!box.raw().includes(digits))
  assert.ok(box.raw().includes('confirmHash'))

  /* And the response that carries the code carries nothing to check it with. A
   * log line holding the code and its salted hash together would be the code. */
  assert.equal(preview.approval.confirmHash, undefined)
  assert.equal(preview.approval.confirmSalt, undefined)

  const read = getFormPreview(preview.id, { filePath: box.filePath })
  assert.equal(read.approval.confirmHash, undefined)
  assert.equal(read.approval.confirmSalt, undefined)
})

test('six digits are stretched, not merely hashed', async () => {
  /*
   * A plain digest of a six-digit code is a formality: a million sha256s is
   * under a second, so anything that could read the store could approve. The
   * stored form has to cost enough that the whole keyspace outlives the
   * twenty-minute preview it would unlock — which means each guess has to be
   * measurably expensive, here and not just in a comment.
   */
  const box = sandbox()
  const preview = await prepared(box)

  const started = process.hrtime.bigint()
  const guess = approveFormPreview(
    preview.id,
    { confirm: '000-001', payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath },
  )
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

  assert.equal(guess.code, 'bad-code')
  /* Deliberately far below the real cost (~30ms): the assertion is "this is a
   * key derivation", not a benchmark that fails on a fast machine. */
  assert.ok(elapsedMs > 3, `a wrong code should cost real work, took ${elapsedMs}ms`)
})

test('approval needs the code, and the wrong code is refused', async () => {
  const box = sandbox()
  const preview = await prepared(box)

  const guessed = approveFormPreview(
    preview.id,
    { confirm: '000-000', payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath },
  )
  assert.equal(guessed.approved, false)
  assert.equal(guessed.code, 'bad-code')

  const real = approveFormPreview(
    preview.id,
    { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath },
  )
  assert.equal(real.approved, true)
})

test('an approval names the bytes it approves, and refuses any others', async () => {
  const box = sandbox()
  const preview = await prepared(box)
  const result = approveFormPreview(
    preview.id,
    { confirm: preview.approval.confirm, payloadSha256: 'not-the-payload-you-read' },
    { filePath: box.filePath },
  )
  /* The whole failure this module exists to prevent: approving a summary and
   * having something else sent. */
  assert.equal(result.approved, false)
  assert.equal(result.code, 'digest-mismatch')
  assert.equal(getFormPreview(preview.id, { filePath: box.filePath }).status, 'awaiting-approval')
})

test('a scheduler cannot approve, by name as well as by code', async () => {
  const box = sandbox()
  const preview = await prepared(box)
  const result = approveFormPreview(
    preview.id,
    {
      confirm: preview.approval.confirm,
      payloadSha256: preview.payload.sha256,
      actor: 'scheduler',
    },
    { filePath: box.filePath },
  )
  assert.equal(result.approved, false)
  assert.equal(result.code, 'unattended')
})

test('an approval of a reading old enough to have moved is refused', async () => {
  const box = sandbox()
  const start = Date.parse('2026-08-07T10:00:00Z')
  const preview = await prepared(box, { now: start })

  const late = approveFormPreview(
    preview.id,
    { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath, now: start + PREVIEW_TTL_MS + 1 },
  )
  assert.equal(late.approved, false)
  assert.equal(late.code, 'stale')
  assert.equal(getFormPreview(preview.id, { filePath: box.filePath }).status, 'stale')
})

test('one approval buys one submit', async () => {
  const box = sandbox()
  const preview = await prepared(box)
  const args = { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 }

  assert.equal(approveFormPreview(preview.id, args, { filePath: box.filePath }).approved, true)
  const second = approveFormPreview(preview.id, args, { filePath: box.filePath })
  assert.equal(second.approved, false)
  assert.equal(second.code, 'already-approved')
})

/* -------------------------------------------------------------- hand-off */

test('the hand-off is arguments for /execute and hands back nothing before approval', async () => {
  const box = sandbox()
  const preview = await prepared(box, { values: { 'Text input': 'Evan Liu' } })

  const early = formPreviewHandoff(preview.id, { filePath: box.filePath })
  assert.equal(early.ok, false)
  assert.deepEqual(early.actions, [])
  assert.match(early.error, /approval is a separate call/)

  approveFormPreview(
    preview.id,
    { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath },
  )

  const handoff = formPreviewHandoff(preview.id, { filePath: box.filePath })
  assert.equal(handoff.ok, true)
  assert.equal(handoff.submitted, false)
  assert.equal(handoff.actions.length, 1)
  assert.equal(handoff.payloadSha256, preview.payload.sha256)
  /* The join back to the manifest, so the settle lands on the record that was
   * written before any of this rather than beside it. */
  assert.equal(handoff.ledgerId, preview.ledgerId)
  assert.ok(handoff.stepKey)
})

test('no plan manifest means no submit is handed out', async () => {
  const box = sandbox()
  /* A page with nothing to click: formFill reports no submit control, so there
   * is no action to book and nothing to hand over. */
  const manifest = fillManifest({ values: {} })
  manifest.submit = { label: null, ref: null, selector: null, clicked: false, howToSend: 'no submit control was found on the page' }

  const preview = await prepareFormPreview(
    { url: PAGE_URL },
    { fill: queueFill(manifest), filePath: box.filePath, ledgerPath: box.ledgerPath },
  )
  assert.equal(preview.ledgerId, null)
  approveFormPreview(
    preview.id,
    { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath },
  )
  const handoff = formPreviewHandoff(preview.id, { filePath: box.filePath })
  assert.equal(handoff.ok, false)
  assert.match(handoff.error, /no submit control/i)
})

test('recording a submit closes the preview so the approval cannot be spent twice', async () => {
  const box = sandbox()
  const preview = await prepared(box)
  approveFormPreview(
    preview.id,
    { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath },
  )
  const closed = markFormPreviewSubmitted(preview.id, { result: { ok: true } }, { filePath: box.filePath })
  assert.equal(closed.status, 'submitted')
  assert.equal(closed.submit.clicked, true)
})

/* ------------------------------------------------------------- rechecking */

test('a page that moved after approval revokes the approval rather than warning about it', async () => {
  const box = sandbox()
  const before = fillManifest({ values: { 'Text input': 'Evan Liu' } })
  const after = fillManifest({ values: { 'Text input': 'Evan Liu', 'Dropdown (select)': 'Two' } })
  const fill = queueFill(before, after)

  const preview = await prepareFormPreview(
    { url: PAGE_URL, values: { 'Text input': 'Evan Liu' } },
    { fill, filePath: box.filePath, ledgerPath: box.ledgerPath },
  )
  approveFormPreview(
    preview.id,
    { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath },
  )

  const recheck = await recheckFormPreview(preview.id, {}, { fill, filePath: box.filePath })
  assert.equal(recheck.changed, true)
  assert.ok(recheck.differences.some((entry) => entry.name === 'my-select'))
  /* The reread must not reload, or it would wipe the fields it is checking. */
  assert.equal(fill.calls[1].reload, false)

  const stored = getFormPreview(preview.id, { filePath: box.filePath })
  assert.equal(stored.status, 'superseded')
  assert.equal(stored.approval.status, 'revoked')
  assert.equal(formPreviewHandoff(preview.id, { filePath: box.filePath }).ok, false)
})

test('an unchanged page keeps the approval', async () => {
  const box = sandbox()
  const manifest = fillManifest({ values: { 'Text input': 'Evan Liu' } })
  const fill = queueFill(manifest, manifest)
  const preview = await prepareFormPreview(
    { url: PAGE_URL, values: { 'Text input': 'Evan Liu' } },
    { fill, filePath: box.filePath, ledgerPath: box.ledgerPath },
  )
  approveFormPreview(
    preview.id,
    { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath },
  )
  const recheck = await recheckFormPreview(preview.id, {}, { fill, filePath: box.filePath })
  assert.equal(recheck.changed, false)
  assert.equal(formPreviewHandoff(preview.id, { filePath: box.filePath }).ok, true)
})

test('a recheck refuses rather than reporting a difference its own redaction caused', async () => {
  const box = sandbox()
  const secret = 'token: ghp_abcdefghijklmnopqrstuvwx'
  const fill = queueFill(fillManifest({ values: { Textarea: secret } }))
  const preview = await prepareFormPreview(
    { url: PAGE_URL, values: { Textarea: secret } },
    { fill, filePath: box.filePath, ledgerPath: box.ledgerPath },
  )
  const recheck = await recheckFormPreview(preview.id, {}, { fill, filePath: box.filePath })
  assert.equal(recheck.ok, false)
  assert.match(recheck.error, /not kept here/)
})

/* --------------------------------------------------------------- messages */

test('a message preview is the exact recipients, subject and body', async () => {
  const box = sandbox()
  const preview = await prepareMessagePreview(
    {
      to: 'support@example.com',
      subject: 'Order {{order_number}} never arrived',
      body: 'Hello,\n\nOrder {{order_number}} was due {{eta}}.\n\nEvan',
      values: { order_number: 'A-4471', eta: 'Tuesday' },
      sourceUrl: PAGE_URL,
    },
    { filePath: box.filePath, ledgerPath: box.ledgerPath },
  )

  assert.equal(preview.payload.complete, true)
  assert.match(preview.payload.text, /^To: support@example\.com\nSubject: Order A-4471 never arrived\n\n/)
  assert.match(preview.payload.text, /Order A-4471 was due Tuesday\./)
  assert.equal(preview.submit.action.params.body, preview.willSend.body)
  assert.equal(preview.submit.clicked, false)
})

test('a message names the addressing the channel will not carry', async () => {
  const box = sandbox()
  const preview = await prepareMessagePreview(
    {
      to: ['support@example.com', 'billing@example.com'],
      cc: 'me@example.com',
      subject: 'Late order',
      body: 'It never arrived.',
    },
    { filePath: box.filePath, ledgerPath: box.ledgerPath },
  )

  /* computerControl.sendEmail makes one message with one to-recipient and no
   * cc. A preview that listed three and sent one would be the exact lie. */
  assert.equal(preview.submit.action.params.to, 'support@example.com')
  assert.equal(preview.payload.complete, false)
  /* The header block is the request: one recipient, no Cc. */
  assert.match(preview.payload.text, /^To: support@example\.com\nSubject: Late order\n\n/)
  const [request, notCarried] = preview.payload.text.split('--- not carried by this channel ---')
  assert.ok(!request.includes('Cc:'))
  assert.match(notCarried, /To: billing@example\.com/)
  assert.match(notCarried, /Cc: me@example\.com/)
  assert.match(preview.caveats.join(' '), /one recipient and no cc\/bcc/)
})

test('an unresolved placeholder is reported, not quietly blanked', async () => {
  const box = sandbox()
  const preview = await prepareMessagePreview(
    { to: 'support@example.com', subject: 'Order {{order_number}}', body: 'Where is it?' },
    { filePath: box.filePath, ledgerPath: box.ledgerPath },
  )
  assert.deepEqual(preview.unresolved, ['order_number'])
  assert.match(preview.payload.text, /Subject: Order \{\{order_number\}\}/)
  assert.match(preview.caveats.join(' '), /Still unresolved/)
})

test('a draft carrying a credential is written down without it, and not handed off', async () => {
  const box = sandbox()
  const preview = await prepareMessagePreview(
    {
      to: 'support@example.com',
      subject: 'Cannot log in',
      body: 'Hello,\nmy password: hunter2seventeen\nplease help.',
    },
    { filePath: box.filePath, ledgerPath: box.ledgerPath },
  )

  assert.ok(!box.raw().includes('hunter2seventeen'))
  /* Line granularity: the rest of the draft survives. */
  assert.match(preview.payload.text, /please help\./)
  assert.match(preview.payload.text, /\[withheld \d+ chars\]/)
  /* And it is not handed off, because sending the marker would be worse than
   * not sending: the recipient would get "[withheld 30 chars]". */
  assert.equal(preview.submit.action, null)
  assert.equal(preview.ledgerId, null)
  approveFormPreview(
    preview.id,
    { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 },
    { filePath: box.filePath },
  )
  assert.equal(formPreviewHandoff(preview.id, { filePath: box.filePath }).ok, false)
})

test('a message with no recipient is refused before anything is written', async () => {
  const box = sandbox()
  await assert.rejects(
    () => prepareMessagePreview({ subject: 'hi', body: 'there' }, { filePath: box.filePath }),
    /at least one recipient/,
  )
})

/* ------------------------------------------------------------- structure */

test('this module cannot dispatch anything at a browser', () => {
  const source = fs.readFileSync(new URL('./formPreview.js', import.meta.url), 'utf8')

  /* The same promise pageWatchDrafts.js makes about itself, narrowed to what
   * this file actually needs: it fills through formFill (allowlisted, stops one
   * click short) and it reaches nothing else. The submit exists here only as
   * data. */
  for (const forbidden of [
    'runBrowserActions',
    'runBrowserAction',
    './browserBridge.js',
    './computerControl.js',
    './executor.js',
    './orchestrator.js',
    'enqueueBrowserCommand',
    'fetch(',
  ]) {
    assert.ok(!source.includes(forbidden), `formPreview.js must not reference ${forbidden}`)
  }

  /* browserPage.js can reach the browser; only its pure URL helper is taken. */
  const imported = source.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/browserPage\.js'/)
  assert.deepEqual(
    imported[1].split(',').map((name) => name.trim()).filter(Boolean),
    ['tabNeedle'],
  )
})

test('a credential is marked by length alone and never by a guessable digest', () => {
  const scrubbed = scrubValue('the gate code is 4829')
  assert.equal(scrubbed.value, '[withheld 21 chars]')
  assert.deepEqual(Object.keys(scrubbed.withheld).sort(), ['chars', 'reason'])
  /* An ordinary sentence is left alone; withholding everything would make the
   * preview useless and the owner stop reading it. */
  assert.equal(scrubValue('my order never arrived').withheld, null)
})

test('the store is bounded', async () => {
  const box = sandbox()
  for (let index = 0; index < 27; index += 1) {
    await prepareMessagePreview(
      { to: 'support@example.com', subject: `note ${index}`, body: 'hi' },
      { filePath: box.filePath, ledgerPath: box.ledgerPath },
    )
  }
  const stored = listFormPreviews({}, { filePath: box.filePath })
  assert.equal(stored.length, 25)
  assert.equal(stored[0].name, 'note 26')
})

test('a discarded preview is gone', async () => {
  const box = sandbox()
  const preview = await prepared(box)
  assert.equal(discardFormPreview(preview.id, { filePath: box.filePath }), true)
  assert.equal(getFormPreview(preview.id, { filePath: box.filePath }), null)
  assert.equal(discardFormPreview(preview.id, { filePath: box.filePath }), false)
})

/* ---------------------------------------------------------------- routes */

function fakeApp() {
  const routes = new Map()
  const app = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
    delete: (route, handler) => routes.set(`DELETE ${route}`, handler),
  }
  const call = async (method, route, { params = {}, query = {}, body = {} } = {}) => {
    const handler = routes.get(`${method} ${route}`)
    assert.ok(handler, `no handler for ${method} ${route}`)
    let statusCode = 200
    let payload = null
    await handler(
      { params, query, body },
      {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        },
      },
    )
    return { statusCode, payload }
  }
  return { app, call, routes }
}

test('the routes make preparing, approving and handing off three separate requests', async () => {
  const box = sandbox()
  const { app, call, routes } = fakeApp()
  registerFormPreviewRoutes(app, {
    filePath: box.filePath,
    ledgerPath: box.ledgerPath,
    fill: queueFill(fillManifest({ values: { 'Text input': 'Evan Liu' } })),
  })

  /* There is deliberately no route that submits. */
  assert.ok(![...routes.keys()].some((key) => /submit$|\/send/.test(key)))

  const created = await call('POST', '/form-previews', {
    body: { url: PAGE_URL, values: { 'Text input': 'Evan Liu' } },
  })
  assert.equal(created.statusCode, 201)
  assert.equal(created.payload.submitted, false)
  const preview = created.payload.preview

  const early = await call('GET', '/form-previews/:id/handoff', { params: { id: preview.id } })
  assert.equal(early.statusCode, 409)

  const refused = await call('POST', '/form-previews/:id/approve', {
    params: { id: preview.id },
    body: { confirm: preview.approval.confirm, payloadSha256: 'wrong', actor: 'owner' },
  })
  assert.equal(refused.statusCode, 409)

  const approved = await call('POST', '/form-previews/:id/approve', {
    params: { id: preview.id },
    body: { confirm: preview.approval.confirm, payloadSha256: preview.payload.sha256 },
  })
  assert.equal(approved.statusCode, 200)
  assert.equal(approved.payload.approved, true)

  const handoff = await call('GET', '/form-previews/:id/handoff', { params: { id: preview.id } })
  assert.equal(handoff.statusCode, 200)
  assert.equal(handoff.payload.actions[0].type, 'browser_click')
})

test('an unknown preview is a 404 on every route that names one', async () => {
  const box = sandbox()
  const { app, call } = fakeApp()
  registerFormPreviewRoutes(app, { filePath: box.filePath, ledgerPath: box.ledgerPath })

  for (const [method, route] of [
    ['GET', '/form-previews/:id'],
    ['POST', '/form-previews/:id/approve'],
    ['POST', '/form-previews/:id/recheck'],
    ['GET', '/form-previews/:id/handoff'],
    ['POST', '/form-previews/:id/submitted'],
  ]) {
    const result = await call(method, route, { params: { id: 'fpv_nope' } })
    assert.equal(result.statusCode, 404, `${method} ${route}`)
  }
})

test('renderLiteralMessage puts the body verbatim under the headers', () => {
  const literal = renderLiteralMessage({
    to: ['a@example.com'],
    subject: 'Subject line',
    body: 'first\nsecond',
  })
  assert.equal(literal.text, 'To: a@example.com\nSubject: Subject line\n\nfirst\nsecond')
  assert.equal(literal.complete, true)
})
