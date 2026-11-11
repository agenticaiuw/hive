import crypto from 'node:crypto'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { openLedger, presentLedger } from './actionLedger.js'
import { tabNeedle } from './browserPage.js'
import { workspacePath } from './config.js'
import { fillForm } from './formFill.js'
import { resolvePlaceholders } from './pageWatchDrafts.js'
import { classifySensitivity } from './redaction.js'

/*
 * THE CLAUSE IS THE CAPABILITY.
 *
 * Twenty-five proposals asked for a browser transaction prepared and held, and
 * every one of them carried the same sentence: "show me exactly what will be
 * submitted before I approve it". That clause is not a safety rail bolted onto
 * a form filler — it is the product. Everything else here exists to make one
 * sentence true.
 *
 * WHICH MEANS THE PREVIEW MUST BE THE PAYLOAD, NOT A DESCRIPTION OF IT. A
 * preview that says "3 fields including your email" is a lie the moment the
 * system sends a fourth, and the owner cannot detect the lie because they
 * approved the sentence, not the request. So `payload.text` in this module is
 * the literal bytes: the request line, the content type, the length, and the
 * urlencoded body a browser would put on the wire — or, for a message, the
 * exact recipients, subject and body. Where a byte cannot honestly be shown
 * (a withheld secret, a multipart boundary the browser picks at submit time)
 * the payload says so at that byte and sets `complete: false`, rather than
 * printing a plausible fiction.
 *
 * WHAT THIS MODULE CANNOT DO: submit. It holds no dispatch path of any kind —
 * no browser bridge, no executor, no HTTP client — and the only browser round
 * trip it makes is through formFill.fillForm, whose action allowlist is
 * fill-only and which stops one click short. The submit is produced as DATA: an
 * action object handed back to a caller who is talking to the owner. A test
 * reads this source and fails if a dispatch path ever appears, the same way
 * pageWatchDrafts.js asserts it cannot reach a browser at all.
 *
 * WHY APPROVAL AND SENDING ARE SEPARATE CALLS. pageWatchDrafts.js established
 * the shape and the reason: approval must cross a process boundary the owner
 * is standing at, not a function boundary inside a scheduler running at 4am.
 * Here that separation is given teeth by three things a later run cannot fake:
 *
 *   1. A confirmation code minted at prepare time, returned exactly ONCE to
 *      the caller that is speaking to the owner, and stored only as a hash. A
 *      scheduler that wakes up and finds a pending preview on disk cannot
 *      recover the code, because it is not on disk.
 *   2. The digest of the payload the owner was shown. An approval names the
 *      bytes it approves; if the page moved between the preview and the
 *      approval, the digest no longer matches and the approval is refused.
 *      This is the whole point: nobody approves a summary and gets a different
 *      request sent.
 *   3. A short expiry. An authenticated page's cart, token and CSRF state
 *      move. An approval given against a reading taken an hour ago is an
 *      approval of something else.
 *
 * NONE OF THIS GATES /execute. planPreview.js says plainly that a preview must
 * never become a permission system, and it is right — anyone may still send a
 * click through /execute directly. What is gated is narrower and honest: THIS
 * module will not hand back the submit action until the owner has confirmed
 * the exact bytes. It refuses to be the thing that submits unapproved, which
 * is not the same as refusing to let the owner submit.
 */

const STORE_PATH = path.join(workspacePath, '.pendant-form-previews.json')

/* Bounded like every other durable store here. A preview holds a whole request
 * body, so the cap is small and the payload text is truncated as well. */
const MAX_PREVIEWS = 25
const MAX_PAYLOAD_CHARS = 20_000
const MAX_BODY_CHARS = 20_000

/*
 * How long a gathered payload is worth approving.
 *
 * Twenty minutes because the thing being described is a live authenticated
 * page: a session that may expire, a basket that may reprice, a CSRF token
 * that may rotate. Past that the honest answer is "read it again", not "it is
 * probably still true".
 */
export const PREVIEW_TTL_MS = 20 * 60_000

/*
 * Callers that are, by their own admission, nobody.
 *
 * This catches the honest scheduler — the tick that finds a pending preview and
 * helpfully approves it — and it does not catch a caller that lies about its
 * source. The confirmation code above is what catches that one. Both are here
 * because they fail differently: the list fails loudly at the moment someone
 * wires an automation to this, and the code fails silently forever after.
 */
export const UNATTENDED_SOURCES = Object.freeze([
  'scheduler',
  'schedule',
  'routine',
  'routines',
  'cron',
  'tick',
  'timer',
  'watch',
  'page-watch',
  'pagewatch',
  'briefing',
  'briefing-triage',
  'background',
  'autonomous',
  'unattended',
])

const isValidStore = (value) => Boolean(value) && Array.isArray(value.previews)

function load(filePath = STORE_PATH) {
  ensureJsonStore(filePath, { previews: [] }, { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: { previews: [] },
    validate: isValidStore,
  })
}

function save(store, filePath = STORE_PATH) {
  writeJsonAtomic(filePath, {
    ...store,
    previews: store.previews.slice(0, MAX_PREVIEWS),
  })
}

const sha256 = (value) =>
  crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')

/* ------------------------------------------------------------- withholding */

/*
 * Why maskSecretValue() is NOT used on a form value.
 *
 * redaction.maskSecretValue keeps the label and drops the value — right for a
 * remembered fact ("bike lock code: 4829" becomes "bike lock code:
 * [withheld]"), wrong here for a different reason than it used to be. It used
 * to be unsafe: a bare token with no colon in it became its own label and was
 * echoed back in full. It no longer is. But a form value has no label worth
 * keeping — the field's own name is already carried beside it — so what that
 * function preserves is exactly what this module does not need, and what it
 * drops is the one thing a reader here wants. The shape this module needs is
 * browserBridge.redactAction's, which is the one written for exactly this case
 * — a typed value that is a credential — and says only how long it was.
 *
 * The length and nothing else. No digest: a four-digit door code has ten
 * thousand possible values, and publishing sha256 of it alongside "4 chars" is
 * publishing the code.
 */
export function withheldMarker(text) {
  return `[withheld ${String(text ?? '').length} chars]`
}

/**
 * Decide what may be written down, per value.
 *
 * `secret` is withheld. `sensitive` — an email address, a phone number — is
 * kept, for the same reason actionLedger.persistableParams keeps it: a support
 * request that cannot name the address it is about is not a support request,
 * and the same string is already in the page the owner is looking at.
 */
export function scrubValue(value) {
  const text = String(value ?? '')
  if (!text) return { value: text, withheld: null }
  if (classifySensitivity(text) !== 'secret') return { value: text, withheld: null }
  return {
    value: withheldMarker(text),
    withheld: { reason: 'secret', chars: text.length },
  }
}

/* ------------------------------------------------------- literal rendering */

/*
 * How a browser actually serialises a form, which is not how encodeURIComponent
 * does it.
 *
 * application/x-www-form-urlencoded turns a space into '+', and the browser
 * normalises a textarea's line endings to CRLF before encoding — so a two-line
 * message really goes on the wire as %0D%0A, not %0A. formFill.renderPreview
 * uses encodeURIComponent, which writes %20 for a space; that is fine for the
 * sentence it prints, and wrong for a payload that claims to be the bytes.
 * URLSearchParams implements the urlencoded serializer, so this is the browser's
 * own answer rather than a second opinion.
 *
 * The two renderings are checked against each other by test: they must name the
 * same fields with the same decoded values. Only the encoding differs, and only
 * on purpose.
 */
export function encodeFormBody(entries = []) {
  const params = new URLSearchParams()
  for (const entry of entries) {
    params.append(
      String(entry?.name ?? ''),
      String(entry?.value ?? '').replace(/\r\n|\r|\n/g, '\r\n'),
    )
  }
  return params.toString()
}

function truncatePayload(text) {
  const value = String(text ?? '')
  if (value.length <= MAX_PAYLOAD_CHARS) return { text: value, truncated: false }
  return {
    text: `${value.slice(0, MAX_PAYLOAD_CHARS)}\n[…${value.length - MAX_PAYLOAD_CHARS} more characters not shown]`,
    truncated: true,
  }
}

function sealPayload(text, { encoding, complete, withheld = [], notes = [] }) {
  const bounded = truncatePayload(text)
  return {
    /* The exact characters the owner is shown, and the exact characters the
     * digest covers. If these two ever come apart, the approval is binding the
     * owner to something they did not read. */
    text: bounded.text,
    sha256: sha256(bounded.text),
    chars: bounded.text.length,
    bytes: Buffer.byteLength(bounded.text, 'utf8'),
    encoding,
    /* False means: this is not, byte for byte, what goes on the wire, and the
     * reasons are listed. It is never quietly false. */
    complete: complete && !bounded.truncated,
    withheld,
    notes: bounded.truncated
      ? [...notes, 'The payload was longer than this record keeps and was truncated for display.']
      : notes,
  }
}

/**
 * The literal request a form submit would make.
 *
 * Every field the browser would send is here, including the ones
 * formFill.renderPreview leaves out of its sentence — a password box the agent
 * declined to type into is still submitted, empty or not, and a payload that
 * omits it is describing a different request.
 */
export function renderLiteralForm({ method, submitsTo, enctype }, entries = []) {
  const verb = String(method || 'GET').toUpperCase()
  const contentType = String(enctype || 'application/x-www-form-urlencoded')
  const withheld = entries
    .filter((entry) => entry.withheld)
    .map((entry) => ({ name: entry.name, label: entry.label ?? null, ...entry.withheld }))

  /*
   * multipart/form-data cannot be shown as bytes and must not be faked.
   *
   * The boundary string is chosen by the browser at submit time, so any body
   * printed here would be a body that will never exist. The fields and values
   * are still exact; only the framing is unknowable, and saying so is the whole
   * difference between a preview and a guess.
   */
  if (/multipart\/form-data/i.test(contentType)) {
    const lines = [
      `${verb} ${submitsTo}`,
      `Content-Type: ${contentType}; boundary=<chosen by the browser at submit time>`,
      '',
      ...entries.map(
        (entry) =>
          `${entry.name}: ${entry.withheld ? entry.value : JSON.stringify(String(entry.value ?? ''))}`,
      ),
    ]
    return sealPayload(lines.join('\n'), {
      encoding: 'multipart/form-data',
      complete: false,
      withheld,
      notes: [
        'This form posts multipart/form-data. The field names and values below are exact; the byte framing is not shown because the browser picks the boundary when you press submit.',
      ],
    })
  }

  const body = encodeFormBody(entries)

  if (verb === 'GET') {
    const separator = String(submitsTo).includes('?') ? '&' : '?'
    return sealPayload(`GET ${submitsTo}${body ? `${separator}${body}` : ''}`, {
      encoding: 'query-string',
      complete: withheld.length === 0,
      withheld,
      notes: withheld.length
        ? ['One or more values are withheld from this record; the request will carry the real value from the page.']
        : [],
    })
  }

  const text = [
    `${verb} ${submitsTo}`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
    '',
    body,
  ].join('\n')

  return sealPayload(text, {
    encoding: contentType,
    complete: withheld.length === 0,
    withheld,
    notes: withheld.length
      ? ['One or more values are withheld from this record; the request will carry the real value from the page.']
      : [],
  })
}

/**
 * The literal message a send would put in the outbox.
 *
 * `notCarried` is the honest half. computerControl.sendEmail builds one Mail
 * message with exactly one to-recipient and no cc or bcc; a preview that lists
 * three recipients while the action carries one is the precise failure this
 * module exists to prevent, so the extras are printed under a heading that says
 * they are not going.
 */
export function renderLiteralMessage({
  to = [],
  cc = [],
  bcc = [],
  subject = '',
  body = '',
  notCarried = [],
  withheld = [],
}) {
  const headers = [
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${subject}`,
  ]

  const trailer = notCarried.length
    ? ['', '--- not carried by this channel ---', ...notCarried.map((line) => `  ${line}`)]
    : []

  return sealPayload([...headers, '', body, ...trailer].join('\n'), {
    encoding: 'message/rfc822-ish',
    complete: withheld.length === 0 && notCarried.length === 0,
    withheld,
    notes: notCarried.length
      ? ['Some addressing will not survive the hand-off; the lines under "not carried" are shown but will not be sent.']
      : [],
  })
}

/* ---------------------------------------------------------------- manifest */

/*
 * One step, written down before it can happen.
 *
 * The plan manifest is actionLedger's, not a parallel record: the submit is an
 * irreversible off-machine write, which is exactly the thing that file was
 * built to persist ahead of dispatch. The manifest holds the ONE act that has
 * not happened. The typing already ran, in front of the owner, through
 * formFill — reversible by retyping, and already recorded by /execute's own
 * receipt path.
 *
 * A preview with no manifest hands back nothing (see formPreviewHandoff). That
 * is deliberate: if the record of the irreversible act could not be written,
 * the irreversible act does not get handed out.
 */
function openSubmitManifest({ command, action, title, sessionId, ledgerPath }) {
  try {
    const manifest = openLedger({
      command,
      actions: [action],
      source: 'form-preview',
      title,
      sessionId,
      ...(ledgerPath ? { filePath: ledgerPath } : {}),
    })
    const step = presentLedger(manifest).steps[0]
    return {
      ledgerId: manifest.ledgerId,
      stepKey: step.stepKey,
      risk: {
        tier: step.riskTier,
        effect: step.effect,
        reversible: step.reversible,
        irreversibleReason: step.irreversibleReason,
        replaySafety: step.replaySafety,
        needsApproval: step.needsApproval,
      },
      ledgerError: null,
    }
  } catch (error) {
    return {
      ledgerId: null,
      stepKey: null,
      risk: null,
      ledgerError: String(error?.message ?? error),
    }
  }
}

/* --------------------------------------------------------------- approval */

/*
 * Six digits the owner says back.
 *
 * Spoken, because the device this answers on has no screen. Only a hash is
 * persisted, so a process that finds this record on disk later — a scheduler, a
 * resumed job, anything that was not in the room — cannot read the code off it.
 *
 * SIX DIGITS IS A MILLION GUESSES, WHICH IS NOTHING against a plain digest: a
 * sha256 of the code would be a formality, brute-forced in under a second by
 * the same process that read the file. scrypt is what makes the number
 * meaningful. At these parameters one guess costs roughly 30ms, so the whole
 * keyspace costs about eight hours — and the preview it would unlock expires in
 * twenty minutes (PREVIEW_TTL_MS). The KDF and the expiry only work as a pair;
 * lengthen the TTL and this argument has to be redone.
 *
 * What it does NOT claim: this is not a defence against arbitrary local code,
 * which can call /execute directly and never come here at all. It is a defence
 * against this system's own automation — a tick that finds a pending preview
 * and helpfully approves it — and against an approval given by anyone who was
 * not shown the payload.
 */
const CONFIRM_KDF = { N: 8192, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }

const normalizeCode = (value) => String(value ?? '').replace(/\D+/g, '')

function hashConfirm(code, salt) {
  return crypto.scryptSync(normalizeCode(code), String(salt), 32, CONFIRM_KDF).toString('hex')
}

function mintConfirmCode() {
  const digits = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  const code = `${digits.slice(0, 3)}-${digits.slice(3)}`
  const salt = crypto.randomBytes(16).toString('hex')
  return { code, salt, hash: hashConfirm(code, salt) }
}

function codeMatches(supplied, approval) {
  const salt = approval?.confirmSalt
  const stored = String(approval?.confirmHash ?? '')
  if (!salt || !stored) return false
  const given = Buffer.from(hashConfirm(supplied, salt), 'hex')
  const known = Buffer.from(stored, 'hex')
  if (given.length !== known.length || known.length === 0) return false
  return crypto.timingSafeEqual(given, known)
}

const isUnattended = (actor) =>
  UNATTENDED_SOURCES.includes(String(actor ?? '').trim().toLowerCase())

/* ------------------------------------------------------------- preparation */

function persistPreview(record, filePath) {
  const store = load(filePath)
  store.previews.unshift(record)
  save(store, filePath)
  return record
}

/**
 * Gather from the authenticated page, fill the reversible fields, and stop.
 *
 * The gathering and the filling are formFill's — it resolves each field against
 * the live page at fill time, in front of the owner, and reports untouched
 * controls with their real defaults because those are submitted too. What this
 * adds is the literal payload, the plan manifest for the submit that has not
 * happened, and the approval the submit now waits behind.
 */
export async function prepareFormPreview(
  {
    url,
    values = {},
    formSelector = 'form',
    name = null,
    capture = false,
    reload = true,
    note = null,
    sessionId = null,
  } = {},
  { fill = fillForm, filePath = STORE_PATH, ledgerPath = null, now = Date.now() } = {},
) {
  const manifest = await fill({ url, values, formSelector, name, capture, reload })

  const entries = (manifest.willSend?.fields ?? []).map((field) => {
    const scrubbed = scrubValue(field.value)
    return {
      name: field.name,
      label: field.label ?? null,
      value: scrubbed.value,
      source: field.source ?? null,
      verified: field.verified ?? null,
      /* A password box the fill declined to type into is still a field the
       * browser submits. formFill drops it from its sentence; the literal
       * keeps it, marked, because "exactly what will be sent" includes the
       * empty box the owner still has to fill in. */
      withheld:
        scrubbed.withheld ??
        (field.redacted
          ? { reason: 'password', chars: 0, note: 'left for you to type in the browser' }
          : null),
    }
  })

  const contract = {
    method: manifest.willSend?.method ?? 'GET',
    submitsTo: manifest.willSend?.submitsTo ?? manifest.page?.url ?? url,
    enctype: manifest.willSend?.enctype ?? '',
  }
  const payload = renderLiteralForm(contract, entries)

  /*
   * The submit action carries no values at all.
   *
   * It is a click. Everything it would send is already on the page, put there
   * by the fill in front of the owner — which is why a secret can be typed and
   * still never reach this record: the click that sends it holds nothing.
   */
  const submitAction = manifest.submit?.selector
    ? {
        type: 'browser_click',
        label: `submit ${manifest.name}`,
        params: {
          urlContains: needleFor(manifest.page?.url ?? url),
          selector: manifest.submit.selector,
          ...(manifest.submit.ref ? { ref: manifest.submit.ref } : {}),
        },
      }
    : null

  const ledger = submitAction
    ? openSubmitManifest({
        command: `submit ${manifest.name}`,
        action: submitAction,
        title: manifest.name,
        sessionId,
        ledgerPath,
      })
    : { ledgerId: null, stepKey: null, risk: null, ledgerError: 'The page has no submit control to click.' }

  const confirm = mintConfirmCode()
  const withheldValueKeys = Object.entries(values)
    .filter(([, value]) => scrubValue(value).withheld)
    .map(([key]) => key)

  const record = {
    id: `fpv_${crypto.randomUUID()}`,
    kind: 'form',
    name: manifest.name,
    note: note ? String(note).slice(0, 400) : null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    status: 'awaiting-approval',
    page: manifest.page ?? null,
    fillId: manifest.id,
    willSend: { ...contract, fields: entries },
    payload,
    submit: {
      action: submitAction,
      clicked: false,
      label: manifest.submit?.label ?? null,
      howToSend: manifest.submit?.howToSend ?? null,
    },
    ledgerId: ledger.ledgerId,
    stepKey: ledger.stepKey,
    risk: ledger.risk,
    ledgerError: ledger.ledgerError,
    /* Kept so a recheck can re-supply them; secrets are not kept, and a recheck
     * says so rather than reporting a false diff (see recheckFormPreview). */
    values: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, scrubValue(value).value]),
    ),
    valuesWithheld: withheldValueKeys,
    approval: {
      required: true,
      status: 'pending',
      confirmHash: confirm.hash,
      confirmSalt: confirm.salt,
      payloadSha256: payload.sha256,
      approvedAt: null,
      approvedBy: null,
      approvals: 0,
    },
    filled: manifest.filled ?? [],
    unmatched: manifest.unmatched ?? [],
    notSent: manifest.notSent ?? [],
    missingRequired: manifest.missingRequired ?? [],
    warnings: manifest.warnings ?? [],
    screenshotPath: manifest.screenshotPath ?? null,
    caveats: formCaveats(manifest, payload, ledger),
  }

  persistPreview(record, filePath)

  /* The code is returned, never stored. This is the only moment it exists in
   * readable form, and it must reach the owner from here. It goes back through
   * presentPreview so the response never carries the code AND the material to
   * verify it — a log line holding both would be the code. */
  return withConfirmCode(record, confirm.code)
}

function withConfirmCode(record, code) {
  const presented = presentPreview(record)
  return { ...presented, approval: { ...presented.approval, confirm: code } }
}

function needleFor(url) {
  try {
    return tabNeedle(url)
  } catch {
    return String(url ?? '')
  }
}

function formCaveats(manifest, payload, ledger) {
  const caveats = []
  if (!payload.complete) {
    caveats.push(
      'This payload is not byte-complete — see `payload.withheld` and `payload.notes` for exactly which parts are not shown.',
    )
  }
  if (manifest.missingRequired?.length) {
    caveats.push(
      `The page still marks these required and empty: ${manifest.missingRequired.join(', ')}. The submit may bounce.`,
    )
  }
  if (manifest.unmatched?.length) {
    caveats.push(
      `${manifest.unmatched.length} value(s) you gave matched no field on the page and are not in this payload.`,
    )
  }
  if (ledger.ledgerError) {
    caveats.push(`No plan manifest was written (${ledger.ledgerError}), so no submit will be handed back.`)
  }
  /*
   * The one this module cannot fix, said out loud.
   *
   * The payload is a reading of the page taken at gather time. Nothing re-reads
   * it at the instant of the click, so a page that rewrites a hidden token, or
   * a session that expires, changes what is sent without changing what was
   * approved. recheckFormPreview() is the answer, and it is the caller's to
   * run — the honest statement is that it has not been run.
   */
  caveats.push(
    'This is what the page held when it was read. Nothing re-reads it at the moment of the click — run a recheck first if the page may have moved.',
  )
  /*
   * The second one this module cannot fix, and the more surprising of the two.
   *
   * The payload is built from the extension's snapshot, which reports the
   * controls a person can interact with. A hidden input — a CSRF token, a cart
   * id, a campaign tag — is submitted by the browser and may never appear in
   * that snapshot, so it can be in the request without being in this list. Said
   * here rather than discovered from a server log.
   */
  caveats.push(
    'Fields the page does not show you — hidden inputs such as tokens or cart ids — are submitted too and may not be listed above, because this is built from the page\'s interactive controls.',
  )
  return caveats
}

/* ----------------------------------------------------------------- message */

export function normalizeRecipients(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,;]/)
  return list.map((entry) => String(entry ?? '').trim()).filter(Boolean)
}

/*
 * A line at a time, not the whole body.
 *
 * classifySensitivity over an entire support request says "secret" because one
 * line mentions a password, and withholding the whole draft would gut the
 * feature. Line granularity keeps the draft readable and the credential out of
 * the store.
 */
function scrubBody(body) {
  const lines = String(body ?? '').slice(0, MAX_BODY_CHARS).split('\n')
  const withheld = []
  const scrubbed = lines.map((line, index) => {
    const result = scrubValue(line)
    if (result.withheld) {
      withheld.push({ line: index + 1, ...result.withheld })
    }
    return result.value
  })
  return { body: scrubbed.join('\n'), withheld }
}

/**
 * Draft a message from what was gathered, and hold it.
 *
 * The other half of the same proposal: "draft the message, show me exactly what
 * will be sent, and wait". Placeholders resolve from the values gathered off
 * the page, using pageWatchDrafts' resolver so an unresolved `{{order_number}}`
 * stays visibly unresolved rather than becoming a silent hole the owner
 * approves without noticing.
 */
export async function prepareMessagePreview(
  {
    to,
    cc = [],
    bcc = [],
    subject = '',
    body = '',
    values = {},
    name = null,
    note = null,
    sourceUrl = null,
    sessionId = null,
  } = {},
  { filePath = STORE_PATH, ledgerPath = null, now = Date.now() } = {},
) {
  const recipients = normalizeRecipients(to)
  if (!recipients.length) throw new Error('A message preview needs at least one recipient.')

  const resolvedSubject = resolvePlaceholders(String(subject ?? ''), values)
  const resolvedBody = resolvePlaceholders(String(body ?? ''), values)
  const scrubbedSubject = scrubValue(resolvedSubject)
  const scrubbedBody = scrubBody(resolvedBody)

  const ccList = normalizeRecipients(cc)
  const bccList = normalizeRecipients(bcc)

  /*
   * What the hand-off will actually carry, read off the executor rather than
   * assumed. computerControl.sendEmail makes one outgoing Mail message with a
   * single to-recipient and no cc or bcc — so anything beyond the first address
   * is printed under "not carried" instead of being quietly dropped between a
   * preview that listed it and a send that did not.
   */
  const notCarried = [
    ...recipients.slice(1).map((address) => `To: ${address}`),
    ...ccList.map((address) => `Cc: ${address}`),
    ...bccList.map((address) => `Bcc: ${address}`),
  ]

  const withheld = [
    ...(scrubbedSubject.withheld ? [{ field: 'subject', ...scrubbedSubject.withheld }] : []),
    ...scrubbedBody.withheld.map((entry) => ({ field: 'body', ...entry })),
  ]

  /*
   * The header block shows only what is carried.
   *
   * Printing "Cc: me@example.com" above the body and a note about it below
   * would be the worst of both: the owner reads the header, believes the copy
   * is going, and approves. So the headers are the request, and everything that
   * will not survive the hand-off is under its own heading.
   */
  const payload = renderLiteralMessage({
    to: recipients.slice(0, 1),
    cc: [],
    bcc: [],
    subject: scrubbedSubject.value,
    body: scrubbedBody.body,
    notCarried,
    withheld,
  })

  /*
   * A message whose text this record could not keep is drafted and NOT handed
   * off.
   *
   * The alternative is worse in both directions: keep the credential and the
   * store is the hole browserBridge just closed; hand off the scrubbed text and
   * the recipient receives "[withheld 14 chars]" in place of the sentence. So
   * the draft exists, the owner is told which line, and that line is theirs to
   * send. formFill takes exactly this position on a password box.
   */
  const deliverable = withheld.length === 0
  const sendAction = deliverable
    ? {
        type: 'send_email',
        label: `send to ${recipients[0]}`,
        params: {
          to: recipients[0],
          subject: scrubbedSubject.value,
          body: scrubbedBody.body,
        },
      }
    : null

  const ledger = sendAction
    ? openSubmitManifest({
        command: `send message to ${recipients[0]}`,
        action: sendAction,
        title: name ?? resolvedSubject.slice(0, 120),
        sessionId,
        ledgerPath,
      })
    : {
        ledgerId: null,
        stepKey: null,
        risk: null,
        ledgerError:
          'The draft carries a value classified as a credential, which is not written to this record, so no send action was prepared.',
      }

  const confirm = mintConfirmCode()
  const unresolved = [...String(resolvedSubject + '\n' + resolvedBody).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map(
    (match) => match[1],
  )

  const record = {
    id: `fpv_${crypto.randomUUID()}`,
    kind: 'message',
    name: String(name ?? resolvedSubject ?? recipients[0]).slice(0, 120),
    note: note ? String(note).slice(0, 400) : null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    status: 'awaiting-approval',
    page: sourceUrl ? { url: String(sourceUrl) } : null,
    willSend: {
      channel: 'mail',
      to: recipients,
      cc: ccList,
      bcc: bccList,
      subject: scrubbedSubject.value,
      body: scrubbedBody.body,
      notCarried,
    },
    payload,
    submit: {
      action: sendAction,
      clicked: false,
      label: sendAction ? `Send to ${recipients[0]}` : null,
      howToSend: sendAction ? 'send_email through /execute' : null,
    },
    ledgerId: ledger.ledgerId,
    stepKey: ledger.stepKey,
    risk: ledger.risk,
    ledgerError: ledger.ledgerError,
    values: {},
    valuesWithheld: [],
    approval: {
      required: true,
      status: 'pending',
      confirmHash: confirm.hash,
      confirmSalt: confirm.salt,
      payloadSha256: payload.sha256,
      approvedAt: null,
      approvedBy: null,
      approvals: 0,
    },
    unresolved: [...new Set(unresolved)],
    warnings: [],
    caveats: messageCaveats({ notCarried, withheld, unresolved, deliverable }),
  }

  persistPreview(record, filePath)
  return withConfirmCode(record, confirm.code)
}

function messageCaveats({ notCarried, withheld, unresolved, deliverable }) {
  const caveats = []
  if (notCarried.length) {
    caveats.push(
      `The mail hand-off carries one recipient and no cc/bcc, so ${notCarried.length} address(es) shown here will not be sent to.`,
    )
  }
  if (withheld.length) {
    caveats.push(
      `${withheld.length} line(s) look like a credential and are not kept in this record, so this draft is not handed off for sending.`,
    )
  }
  if (unresolved.length) {
    caveats.push(
      `Still unresolved: ${[...new Set(unresolved)].join(', ')}. They will be sent literally, braces and all.`,
    )
  }
  if (deliverable) {
    caveats.push('Sending is a separate call, and it is not made from here.')
  }
  return caveats
}

/* --------------------------------------------------------------- approving */

/**
 * The owner says yes to these exact bytes. Still sends nothing.
 *
 * Three things must line up, and each rejects a different mistake:
 *   - the confirmation code rejects a caller that was not in the conversation;
 *   - `payloadSha256` rejects an approval of a payload other than the one on
 *     record, which is the entire "approved the summary, sent something else"
 *     failure;
 *   - the expiry rejects an approval of a reading old enough to have moved.
 */
export function approveFormPreview(
  id,
  { confirm = '', payloadSha256 = '', approvedBy = null, actor = null } = {},
  { filePath = STORE_PATH, now = Date.now() } = {},
) {
  const store = load(filePath)
  const record = store.previews.find((entry) => entry.id === id)
  if (!record) return null

  const refuse = (reason, code = 'refused') => ({
    ok: false,
    id,
    approved: false,
    code,
    error: reason,
  })

  if (record.status === 'approved' || record.approval?.status === 'approved') {
    /* Single use. A second submit is a second decision, and it gets a second
     * preview taken against the page as it stands then. */
    return refuse('This preview was already approved. Prepare it again to send it again.', 'already-approved')
  }
  if (record.status === 'superseded') {
    return refuse('The page moved after this preview was taken; prepare it again.', 'superseded')
  }
  if (Date.parse(record.expiresAt) <= now) {
    record.status = 'stale'
    save(store, filePath)
    return refuse(
      'This preview is older than the page it describes can be trusted for. Read the page again.',
      'stale',
    )
  }
  if (isUnattended(actor)) {
    return refuse(
      `Approval cannot come from "${actor}". It is the owner's call, made while they are looking at the payload.`,
      'unattended',
    )
  }
  if (!codeMatches(confirm, record.approval)) {
    return refuse(
      'That is not the confirmation code for this preview. The code was spoken once, when the payload was shown.',
      'bad-code',
    )
  }
  if (String(payloadSha256) !== String(record.payload?.sha256)) {
    return refuse(
      'The payload digest supplied is not the digest of the payload on record — you would be approving different bytes than the ones you read.',
      'digest-mismatch',
    )
  }

  record.status = 'approved'
  record.approval = {
    ...record.approval,
    status: 'approved',
    approvedAt: new Date(now).toISOString(),
    approvedBy: approvedBy ? String(approvedBy).slice(0, 80) : 'owner',
    approvals: (record.approval?.approvals ?? 0) + 1,
  }
  save(store, filePath)

  return {
    ok: true,
    approved: true,
    preview: presentPreview(record),
    /* Said here as well as in the record, because this is the response a caller
     * is most likely to act on. */
    note: 'Approved. Nothing has been sent — the submit is a separate call, and the actions for it are on the handoff.',
  }
}

/**
 * The actions a caller would send to /execute, once — and only once — the owner
 * has approved the exact payload.
 *
 * Arguments, not a call. The separation is the same one pageWatchDrafts.js
 * makes and for the same reason: the send has to cross a boundary the owner is
 * standing at. `ledgerId`/`stepKey` come back so the caller can hang
 * actionLedger.ledgerStepObserver on the run and have the settle land on the
 * manifest that was written before any of this.
 */
export function formPreviewHandoff(id, { filePath = STORE_PATH } = {}) {
  const record = load(filePath).previews.find((entry) => entry.id === id)
  if (!record) return null

  if (record.approval?.status !== 'approved') {
    return {
      ok: false,
      id,
      actions: [],
      error: 'This preview has not been approved. Approve the payload first; approval is a separate call.',
    }
  }
  if (!record.submit?.action || !record.ledgerId) {
    return {
      ok: false,
      id,
      actions: [],
      error:
        record.ledgerError ??
        'There is no submit action for this preview, so there is nothing to hand off.',
    }
  }

  return {
    ok: true,
    id,
    kind: record.kind,
    /* The bytes the approval was given against, carried alongside the actions
     * so the caller can prove at send time that these are those. */
    payloadSha256: record.payload?.sha256 ?? null,
    approvedAt: record.approval?.approvedAt ?? null,
    ledgerId: record.ledgerId,
    stepKey: record.stepKey,
    risk: record.risk,
    actions: [record.submit.action],
    submitted: false,
    note: 'Nothing has been sent. These are the arguments for /execute; sending them is the caller\'s act, made with the owner present.',
  }
}

/**
 * Record that a caller says it sent. A claim, not proof.
 *
 * The proof lives on the ledger step this joins to — that is where a receipt
 * id and a settled phase end up, written by the execution path rather than by
 * anyone's assertion here. What this does is close the preview so the same
 * approval cannot be spent twice.
 */
export function markFormPreviewSubmitted(
  id,
  { result = null, now = Date.now() } = {},
  { filePath = STORE_PATH } = {},
) {
  const store = load(filePath)
  const record = store.previews.find((entry) => entry.id === id)
  if (!record) return null

  record.status = result?.ok === false ? 'submit-failed' : 'submitted'
  record.submit = {
    ...record.submit,
    clicked: true,
    submittedAt: new Date(now).toISOString(),
    ok: result?.ok !== false,
    message: String(result?.message ?? result?.error ?? '').slice(0, 400) || null,
  }
  save(store, filePath)
  return presentPreview(record)
}

/* --------------------------------------------------------------- rechecking */

/**
 * Read the page again and find out whether the approved bytes are still the
 * bytes.
 *
 * The gap this closes is the one named in the caveats: a payload gathered at
 * 10:02 and submitted at 10:19 describes a page that had seventeen minutes to
 * change its mind. A drift here revokes the approval rather than warning about
 * it, because a warning attached to a still-valid approval is a warning nobody
 * has to read.
 */
export async function recheckFormPreview(
  id,
  { values = null, now = Date.now() } = {},
  { fill = fillForm, filePath = STORE_PATH } = {},
) {
  const store = load(filePath)
  const record = store.previews.find((entry) => entry.id === id)
  if (!record) return null
  if (record.kind !== 'form') {
    return { ok: false, id, error: 'Only a form preview can be rechecked; a message draft has no page to reread.' }
  }
  if (record.valuesWithheld?.length && !values) {
    /*
     * Refuse rather than mislead. Those values were never written down, so a
     * recheck without them would retype nothing into those fields and report a
     * difference that is an artefact of this record's own redaction.
     */
    return {
      ok: false,
      id,
      error: `This preview was filled with value(s) that are not kept here (${record.valuesWithheld.join(', ')}). Supply them again to recheck, or take a fresh preview.`,
    }
  }

  const fresh = await fill({
    url: record.page?.url,
    values: values ?? record.values ?? {},
    name: record.name,
    /* Never reload: a reload would wipe the fields that were typed and the
     * recheck would report the page as empty. */
    reload: false,
  })

  const entries = (fresh.willSend?.fields ?? []).map((field) => {
    const scrubbed = scrubValue(field.value)
    return {
      name: field.name,
      label: field.label ?? null,
      value: scrubbed.value,
      withheld:
        scrubbed.withheld ??
        (field.redacted ? { reason: 'password', chars: 0 } : null),
    }
  })
  const payload = renderLiteralForm(
    {
      method: fresh.willSend?.method ?? record.willSend.method,
      submitsTo: fresh.willSend?.submitsTo ?? record.willSend.submitsTo,
      enctype: fresh.willSend?.enctype ?? record.willSend.enctype,
    },
    entries,
  )

  const changed = payload.sha256 !== record.payload?.sha256
  if (!changed) {
    record.recheckedAt = new Date(now).toISOString()
    save(store, filePath)
    return { ok: true, id, changed: false, payload, note: 'The page still sends exactly what you approved.' }
  }

  const before = new Map((record.willSend?.fields ?? []).map((field) => [field.name, field.value]))
  const after = new Map(entries.map((entry) => [entry.name, entry.value]))
  const differences = [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key))
    .map((key) => ({ name: key, was: before.get(key) ?? null, now: after.get(key) ?? null }))

  record.status = 'superseded'
  record.approval = { ...record.approval, status: 'revoked', revokedAt: new Date(now).toISOString() }
  record.payload = payload
  record.willSend = { ...record.willSend, fields: entries }
  record.recheckedAt = new Date(now).toISOString()
  save(store, filePath)

  return {
    ok: true,
    id,
    changed: true,
    differences,
    payload,
    note: 'The page no longer sends what was approved, so the approval was revoked. Take a fresh preview.',
  }
}

/* ------------------------------------------------------------------- reads */

/**
 * A preview as it may be read back.
 *
 * The confirmation material never leaves — neither the hash nor its salt, since
 * together they are what a brute-forcer needs. The payload always does, in
 * full, because that is the one thing the owner is being asked to read.
 */
export function presentPreview(record) {
  if (!record) return null
  const { approval = {}, ...rest } = record
  /* Named rather than destructured-and-dropped: an allow list of what may be
   * read back cannot leak a field somebody adds to the record later. */
  return {
    ...rest,
    approval: {
      required: approval.required ?? true,
      status: approval.status ?? null,
      payloadSha256: approval.payloadSha256 ?? null,
      approvedAt: approval.approvedAt ?? null,
      approvedBy: approval.approvedBy ?? null,
      approvals: approval.approvals ?? 0,
      ...(approval.revokedAt ? { revokedAt: approval.revokedAt } : {}),
    },
  }
}

export function listFormPreviews({ status = null, kind = null } = {}, { filePath = STORE_PATH } = {}) {
  return load(filePath)
    .previews.filter((record) => (status ? record.status === status : true))
    .filter((record) => (kind ? record.kind === kind : true))
    .map(presentPreview)
}

export function getFormPreview(id, { filePath = STORE_PATH } = {}) {
  return presentPreview(load(filePath).previews.find((record) => record.id === id) ?? null)
}

export function discardFormPreview(id, { filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const before = store.previews.length
  store.previews = store.previews.filter((record) => record.id !== id)
  if (store.previews.length === before) return false
  save(store, filePath)
  return true
}

export const formPreviewLocation = () => STORE_PATH

/* ------------------------------------------------------------------ routes */

/**
 * The HTTP surface, as a registration function the server calls.
 *
 * server.js is shared ground that several people edit at once, so this mounts
 * in one line there. The route list is the shape of the promise: preparing,
 * approving and handing off are three separate requests, and there is
 * deliberately no route that submits. The submit goes to /execute, from a
 * caller holding the handoff, with the owner present.
 */
export function registerFormPreviewRoutes(
  app,
  { basePath = '', filePath = STORE_PATH, ledgerPath = null, fill = fillForm } = {},
) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerFormPreviewRoutes requires an Express-style app.')
  }

  const route = (suffix) => `${basePath}${suffix}`
  const fail = (response, error, code = 400) =>
    response.status(code).json({ ok: false, error: String(error?.message || error) })

  app.get(route('/form-previews'), (request, response) => {
    response.json({
      ok: true,
      previews: listFormPreviews(
        { status: request.query?.status || null, kind: request.query?.kind || null },
        { filePath },
      ),
      storePath: formPreviewLocation(),
      note: 'Prepared, not sent. Nothing here has been submitted.',
    })
  })

  /* Prepare: reads the page and fills the reversible fields. The one route here
   * that touches the browser, and it stops one click short. */
  app.post(route('/form-previews'), async (request, response) => {
    try {
      const body = request.body || {}
      const preview =
        String(body.kind ?? 'form') === 'message'
          ? await prepareMessagePreview(body, { filePath, ledgerPath })
          : await prepareFormPreview(body, { fill, filePath, ledgerPath })
      response.status(201).json({
        ok: true,
        submitted: false,
        note: 'Nothing has been sent. Read `payload.text` — that is the request, literally — then approve it with its digest and the spoken code.',
        preview,
      })
    } catch (error) {
      fail(response, error)
    }
  })

  app.get(route('/form-previews/:id'), (request, response) => {
    const preview = getFormPreview(request.params.id, { filePath })
    if (!preview) {
      response.status(404).json({ ok: false, error: 'No such preview.' })
      return
    }
    response.json({ ok: true, preview })
  })

  /*
   * Approve. A POST of its own, carrying the digest of the bytes the owner read
   * and the code they were told — neither of which a background tick has.
   */
  app.post(route('/form-previews/:id/approve'), (request, response) => {
    const result = approveFormPreview(request.params.id, request.body || {}, { filePath })
    if (!result) {
      response.status(404).json({ ok: false, error: 'No such preview.' })
      return
    }
    response.status(result.ok ? 200 : 409).json(result)
  })

  /* Read the page again and revoke the approval if it moved. */
  app.post(route('/form-previews/:id/recheck'), async (request, response) => {
    try {
      const result = await recheckFormPreview(request.params.id, request.body || {}, { fill, filePath })
      if (!result) {
        response.status(404).json({ ok: false, error: 'No such preview.' })
        return
      }
      response.json(result)
    } catch (error) {
      fail(response, error)
    }
  })

  /* GET, because reading what would be sent is not sending it. */
  app.get(route('/form-previews/:id/handoff'), (request, response) => {
    const handoff = formPreviewHandoff(request.params.id, { filePath })
    if (!handoff) {
      response.status(404).json({ ok: false, error: 'No such preview.' })
      return
    }
    response.status(handoff.ok ? 200 : 409).json(handoff)
  })

  app.post(route('/form-previews/:id/submitted'), (request, response) => {
    const record = markFormPreviewSubmitted(request.params.id, request.body || {}, { filePath })
    if (!record) {
      response.status(404).json({ ok: false, error: 'No such preview.' })
      return
    }
    response.json({ ok: true, preview: record })
  })

  if (typeof app.delete === 'function') {
    app.delete(route('/form-previews/:id'), (request, response) => {
      response.json({ ok: discardFormPreview(request.params.id, { filePath }) })
    })
  }

  return {
    mounted: [
      'GET/POST /form-previews',
      'GET/DELETE /form-previews/:id',
      'POST /form-previews/:id/approve',
      'POST /form-previews/:id/recheck',
      'GET /form-previews/:id/handoff',
      'POST /form-previews/:id/submitted',
    ],
  }
}
