import crypto from 'node:crypto'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { redactAction } from './browserBridge.js'
import { redactionMapFor } from './evidenceCapsules.js'
import { classifySensitivity } from './redaction.js'
import { maskNoise, normalize, shapeOf, shortHash } from './pageWatchSignal.js'

/*
 * Provenance for the browser tier: where a claim came from, what was changed,
 * and whether either still stands.
 *
 * The system already drafts forms, watches logged-in pages and speaks briefings
 * that assert facts. A briefing can say "your order ships Tuesday" and nothing
 * connects that sentence to a page. When it turns out to be wrong there are
 * three completely different failures behind it and no way to tell them apart:
 *
 *   1. the page changed after we read it,
 *   2. the extraction was wrong — the page never said that,
 *   3. the model invented it.
 *
 * Those demand opposite responses (re-read / fix the locator / stop trusting the
 * summariser), so a record that cannot separate them is not worth keeping. The
 * whole design below is organised around making that one distinction cheap:
 *
 *   - `grounded` is settled AT CAPTURE. A claim is checked against the text it
 *     was supposedly drawn from at the moment of the read, when that text is
 *     still in hand. grounded:false is case 3, caught before it is ever spoken,
 *     and it is the only one of the three that no later evidence can recover.
 *   - the snippet hash separates 1 from 2 afterwards. The page moved (case 1) or
 *     it did not and the claim still is not in it (case 2).
 *
 * WHY THIS SITS BESIDE actionLedger.js RATHER THAN INSIDE IT
 *
 * actionLedger records a PLAN before it runs, and its whole value is an ordering
 * invariant in the execution path: the "started" row is fsynced before the
 * executor is handed the action. It rewrites and fsyncs its file twice per step,
 * which is why its byte budget is a latency budget as much as a disk budget.
 *
 * This records what the BROWSER saw and did, after the extension has answered.
 * Three things follow, and each one on its own would rule out merging:
 *
 *   - Most browser work has no ledger. pageWatch ticks, relay-driven reads and
 *     anything that goes straight through browserPage.js never open a plan
 *     manifest, so a provenance row hung off a ledger step would have nowhere to
 *     live for the majority of readings this feature exists for.
 *   - A page snippet hash is useless to crash recovery. Adding it to a step
 *     makes every fsync in the execution path bigger to answer a question no
 *     resume asks.
 *   - The lifetimes disagree. A ledger is closed when its plan finishes; a
 *     provenance record has to outlive the run, because "where did this claim
 *     come from" is asked days later, about a briefing, by someone who never saw
 *     the plan.
 *
 * So this store carries JOIN KEYS and no copies: ledgerId, stepKey, receiptId,
 * capsuleId, commandId, jobId. Nothing here re-derives reversibility
 * (planPreview.foreseeAction), risk (actionRisk), execution history
 * (executionJournal) or page bodies (evidenceCapsules) — those modules own those
 * questions and a second answer is a second answer waiting to disagree.
 *
 * WHAT IT DOES NOT DUPLICATE. evidenceCapsules.js already stores the BODY of
 * every browser reading, content-addressed and redacted. This does not store
 * bodies at all; it stores a digest and points at the capsule. What
 * evidenceCapsules has no answer for is the other half of the committee's ask —
 * field MUTATIONS. Its own UNCAPSULED_PATHS says so in as many words: "browser
 * click / type / select / press_key — writes, not readings". A write is exactly
 * the thing the owner most needs to audit and undo, and until now it left no
 * record of what the field said before the agent replaced it.
 *
 * IT OBSERVES. Recording provenance cannot refuse, delay or alter a browser
 * action; every entry point swallows its own failures. The undo path returns a
 * PLAN and never executes it, the same stance actionLedgerRoutes takes about
 * resume. actionReceipts.js, evidenceCapsules.js and actionLedger.js all say
 * this about themselves and the four should keep agreeing.
 *
 * NOTHING HERE MAY REACH A LOG. A provenance record is about a page behind the
 * owner's login. This module makes no console call of any kind (there is a test
 * that asserts that), every outbound shape is built by an allowlist rather than
 * by spreading a record, and the two fields that can hold page text are withheld
 * unless a caller explicitly asks for them. logLineFor is the shape anything
 * that logs should use, and it carries hashes only.
 */

export const PROVENANCE_VERSION = 1

/*
 * BOUNDED BY BYTES, MEASURED THE WAY IT LANDS ON DISK.
 *
 * jobTracker capped a count and reached 129 MB. browserSpool and actionLedger
 * were both born with byte budgets after that, and this one is written the same
 * way — with one correction. Both of those measure JSON.stringify(store) while
 * atomicJsonStore writes JSON.stringify(store, null, 2), so their real files are
 * roughly twice their stated budget. storeBytesOf below uses the same
 * indentation the writer uses, so this number is the size of the file rather
 * than an optimistic proxy for it.
 *
 * 512 KB holds a few hundred records. A record is small ON PURPOSE — it holds
 * digests, ids and a capped claim, never a page — so the budget is a ceiling
 * this store should almost never touch. If it does, something started putting
 * page text in here and the drop counters are how you find out.
 */
export const MAX_STORE_BYTES = 512 * 1024

/*
 * One record may not eat more than a sixty-fourth of the store. The same reason
 * browserSpool caps an entry: without it a single pathological record evicts
 * everything else on the way in and leaves a store that is technically inside
 * its budget and useless.
 */
export const MAX_RECORD_BYTES = MAX_STORE_BYTES / 64

/* A claim is a sentence a briefing already said out loud to the owner, so
 * keeping it is not a new disclosure. A page is not, so it is never kept. */
export const MAX_CLAIM_CHARS = 200

/* What an undo may put back. Longer than a form field's worth of text is not a
 * field restore, it is a document, and re-typing a document from a store that
 * was never meant to hold one is how this becomes a page-text store by
 * accident. Past this the value is not kept and the write is not undoable. */
export const MAX_RESTORE_CHARS = 400

const MAX_URL_CHARS = 500
const MAX_LOCATOR_CHARS = 300
const MAX_TITLE_CHARS = 160
const MAX_REASON_CHARS = 300

/* Order matters: the field whose loss costs least goes first. `after.value` is
 * shed before `claim.text` because the after-value is still on the page and can
 * be re-read, while a claim is a thing that was said and cannot be. `before`
 * goes last because losing it is losing the undo. */
const SHED_ORDER = ['afterValue', 'claimText', 'beforeValue']

const isValidStore = (value) =>
  Boolean(value) && typeof value === 'object' && Array.isArray(value.records)

export function provenanceLocation() {
  return (
    process.env.PENDANT_BROWSER_PROVENANCE_PATH ||
    path.join(workspacePath, '.pendant-browser-provenance.json')
  )
}

const emptyStore = () => ({
  version: PROVENANCE_VERSION,
  records: [],
  dropped: { records: 0, bytes: 0, through: null },
})

function load(filePath) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: emptyStore(),
    validate: isValidStore,
  })
}

/**
 * The size of the store as the writer will actually write it.
 *
 * atomicJsonStore.writeJsonAtomic serialises with an indent of two. Measuring
 * without it understates the file by roughly half, which is the difference
 * between a budget and a hope.
 */
export function storeBytesOf(value) {
  try {
    const serialized = JSON.stringify(value ?? null, null, 2)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8')
  } catch {
    /* Unserialisable is unstorable: price it as maximally expensive so it is
     * shed first. jobTracker and actionLedger reach the same conclusion the
     * same way. */
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * What one record costs INSIDE the store, which is not what it costs alone.
 *
 * A record sits two levels down — store object, then `records` array — so every
 * line of it gains the four spaces of that nesting, plus the comma and newline
 * that separate it from the next one. Ignoring that undercounts a store of a
 * few hundred small records by well over ten percent, which is enough to put
 * the file past a budget the code believes it is inside.
 */
function nestedBytesOf(record) {
  const serialized = JSON.stringify(record ?? null, null, 2)
  if (serialized === undefined) return Number.MAX_SAFE_INTEGER
  const lines = serialized.split('\n').length
  return Buffer.byteLength(serialized, 'utf8') + 4 * lines + 2
}

/* The store as it will be written, with the counters at their widest so a
 * budget checked while they are small does not overrun once they grow. */
const envelope = (records) => ({
  version: PROVENANCE_VERSION,
  records,
  dropped: {
    records: Number.MAX_SAFE_INTEGER,
    bytes: Number.MAX_SAFE_INTEGER,
    through: '0000-00-00T00:00:00.000Z',
  },
})

function save(store, filePath, budget = {}) {
  const pruned = pruneRecords(store.records, budget)
  const next = {
    version: PROVENANCE_VERSION,
    records: pruned.records,
    dropped: {
      records: (store.dropped?.records ?? 0) + pruned.dropped,
      bytes: (store.dropped?.bytes ?? 0) + pruned.droppedBytes,
      through: pruned.droppedThrough ?? store.dropped?.through ?? null,
    },
  }
  writeJsonAtomic(filePath, next, { validate: isValidStore })
  return next
}

const clip = (value, max) => String(value ?? '').slice(0, max)

/* ------------------------------------------------------------- addressing */

/**
 * The addressable half of a URL, query dropped.
 *
 * Same rule and same reason as evidenceCapsules.normalizeSource: a query string
 * is where a site puts a one-time session token, and a provenance record is
 * exactly the kind of object that gets read back over HTTP and pasted into a
 * summary. Kept here rather than imported so this module holds no opinion about
 * capsule identity — the two normalisations must agree on the URL and are free
 * to disagree about everything else.
 */
export function normalizeUrl(rawUrl) {
  const text = clip(rawUrl, MAX_URL_CHARS).trim()
  try {
    const parsed = new URL(text)
    return {
      url: `${parsed.origin}${parsed.pathname}`,
      origin: parsed.origin,
      host: parsed.host,
      path: parsed.pathname,
      queryDropped: Boolean(parsed.search || parsed.hash),
    }
  } catch {
    return { url: text, origin: null, host: null, path: null, queryDropped: false }
  }
}

/*
 * How long a locator addresses the same element, which is not a detail — it is
 * whether an undo can be attempted at all.
 *
 * A `ref` is a `data-pendant-ref` attribute that browser-extension/src/
 * background.js stamps on the live DOM during a snapshot. It does not survive a
 * reload, a re-render, or a navigation, and resolveElement throws
 * "Snapshot ref not found" when it has gone. A `selector` is the cssPath the
 * same snapshot computed; it is re-resolvable, and brittle in the ordinary
 * nth-of-type way. Whole-page reads address the document and always resolve.
 */
const LOCATOR_DURABILITY = {
  ref: 'snapshot-scoped — a data-pendant-ref attribute stamped on the live DOM; it does not survive a reload or a re-render.',
  selector: 're-resolvable — a CSS path that can be looked up again, and that can silently address a different element after a re-render.',
  document: 'whole-page — addresses the document, so it always resolves.',
}

/**
 * Where the DOM locator came from and what it is worth later.
 *
 * Both forms are kept when both are present. The extension accepts either and
 * prefers ref (bridge-core.validateCommand requires one of them); an undo
 * attempted minutes later wants the selector, because the ref it was told is
 * probably gone. Recording only the one that was used throws away the only
 * durable half of the address.
 */
export function normalizeLocator(input = {}) {
  const ref = clip(input.ref ?? '', MAX_LOCATOR_CHARS).trim()
  const selector = clip(input.selector ?? '', MAX_LOCATOR_CHARS).trim()
  const mode = clip(input.mode ?? '', 40).trim() || null
  const kind = ref ? 'ref' : selector ? 'selector' : 'document'

  return {
    kind,
    ref: ref || null,
    selector: selector || null,
    mode,
    durability: LOCATOR_DURABILITY[kind],
    /*
     * What "the same place on the same page" means for lookups, and it is an
     * ADDRESS — nothing about how the reading was taken belongs in it.
     *
     * The selector wins over the ref because it is the durable half: two reads
     * of one field taken either side of a snapshot carry different refs and
     * must still join. Neither `kind` nor `mode` is part of it, and both were
     * in an earlier cut: a read that quoted a selector and a write that quoted
     * ref-and-selector produced different keys for the same input, so a write
     * could never inherit the read that would have made it undoable. A key that
     * encodes how you looked is a key that only matches itself.
     */
    key: selector ? `sel|${selector}` : ref ? `ref|${ref}` : 'document',
  }
}

/* --------------------------------------------------------------- digests */

/**
 * What a snippet was, without keeping what it said.
 *
 * Two hashes, because they answer different questions and the second is the one
 * that makes the check worth running. `hash` is over the normalised text, so it
 * moves when any byte moves. `maskedHash` is over the same text with clocks and
 * opaque tokens blanked out (pageWatchSignal.maskNoise), so it moves only when
 * the page says something different. Nearly every logged-in page renders a
 * timestamp somewhere; without the masked hash every check of every claim comes
 * back "changed" and the feature is noise.
 *
 * Both come from pageWatchSignal — the same normalize/shortHash pair a watch
 * baselines with — so a watch digest and a provenance hash over the same text
 * are the same string and can be compared directly. That is the point of
 * borrowing them rather than writing a third hash here.
 */
export function snippetDigest(text) {
  const value = String(text ?? '')
  const normalized = normalize(value)

  if (!normalized) {
    return {
      hash: null,
      maskedHash: null,
      chars: 0,
      words: 0,
      lines: 0,
      shape: 'empty',
      withheld: false,
    }
  }

  return {
    hash: shortHash(normalized),
    maskedHash: shortHash(maskNoise(value)),
    chars: normalized.length,
    words: normalized.split(' ').filter(Boolean).length,
    lines: value.split('\n').filter((line) => line.trim()).length,
    shape: shapeOf(value),
    withheld: false,
  }
}

/* A digest that is deliberately absent, and says which rule removed it. */
const withheldDigest = (chars, why) => ({
  hash: null,
  maskedHash: null,
  chars: Number(chars) || 0,
  words: 0,
  lines: 0,
  shape: 'withheld',
  withheld: true,
  why,
})

/* --------------------------------------------------------------- secrecy */

/**
 * Is this locator one the bridge already refuses to write down a value for?
 *
 * browserBridge.redactAction owns that question — it is the rule that stops a
 * password typed through the bridge from sitting in the completed-results map —
 * and it is asked here rather than answered again. A second credential pattern
 * list is the copy nobody remembers exists; bridge-core.js says the same thing
 * about its own list and takes the drift deliberately only because it cannot
 * import across the extension boundary. This side can, so it does.
 *
 * The probe is shaped as a `type` because that is the action redactAction
 * classifies. The answer is about the FIELD, so it applies equally to a select
 * or a click on the same locator.
 */
export function isSecretLocator(locator = {}) {
  const probe = redactAction({
    type: 'type',
    params: {
      selector: locator.selector ?? '',
      ref: locator.ref ?? '',
      text: 'x',
    },
  })
  return Array.isArray(probe?.secretsWithheld) && probe.secretsWithheld.length > 0
}

/**
 * A short value as it may be stored, or the reason it may not be.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 *   - A secret value is not kept. redaction.classifySensitivity decides and
 *     evidenceCapsules.redactionMapFor does the withholding, so there is one
 *     classifier and one masker in this codebase and this is not a third.
 *   - A withheld value gets NO HASH EITHER. A hash of a long page is a fine
 *     thing to keep; a hash of a four-digit door code or a six-digit OTP is the
 *     value itself with an afternoon of compute in front of it. Low-entropy
 *     secrets are the ones this project actually handles — the pendant hears
 *     "the bike lock code is 4829" — so for anything classified secret the
 *     digest is withheld with the value.
 *
 * A `sensitive` value (an email address, a phone number) IS kept, and that is a
 * deliberate line rather than an oversight: actionLedger.persistableParams
 * reaches the same conclusion for the same reason. A restore that cannot name
 * the address it is putting back cannot restore anything, and the string is
 * already next door in the job store. The rule is "do not open a new hole".
 */
export function persistableValue(rawValue, { locator = {}, max = MAX_RESTORE_CHARS } = {}) {
  const text = String(rawValue ?? '')
  if (!text) {
    return { value: '', digest: snippetDigest(''), withheld: false, why: null, sensitivity: 'normal' }
  }

  if (isSecretLocator(locator)) {
    const why =
      'The locator names a credential field, so neither its value nor a digest of it was recorded.'
    return {
      value: null,
      digest: withheldDigest(text.length, why),
      withheld: true,
      why,
      sensitivity: 'secret',
    }
  }

  const sensitivity = classifySensitivity(text)
  if (sensitivity === 'secret') {
    const why =
      'The value was classified as a secret, so neither it nor a digest of it was recorded — a digest of a short secret is the secret with compute in front of it.'
    return {
      value: null,
      digest: withheldDigest(text.length, why),
      withheld: true,
      why,
      sensitivity,
    }
  }

  if (text.length > max) {
    const why = `The value was ${text.length} characters, past the ${max}-character restore limit, so only its digest was kept.`
    return { value: null, digest: snippetDigest(text), withheld: true, why, sensitivity }
  }

  /* Runs even on a value that classified `normal`: classifySensitivity looks at
   * the whole string, and redactionMapFor looks at it segment by segment, so a
   * secret buried in one sentence of a longer value is caught here and nowhere
   * else. */
  const redacted = redactionMapFor(text)
  return {
    value: redacted.content,
    digest: snippetDigest(text),
    withheld: redacted.counts.secret > 0,
    why: redacted.counts.secret
      ? 'Part of the value was classified as a secret and was withheld from the stored copy.'
      : null,
    sensitivity: redacted.classification,
  }
}

/* ---------------------------------------------------------------- claims */

/**
 * Was this claim actually in the text it is supposed to have come from?
 *
 * The single cheapest lie-detector available, and it only works AT CAPTURE,
 * while the text is still in hand. Both sides are normalised through the same
 * pageWatchSignal.normalize a watch uses, so "ships   Tuesday" and
 * "ships Tuesday" are the same claim.
 *
 * Returns null rather than false when there is nothing to check against. An
 * ungrounded claim and an uncheckable one are different facts and a reader who
 * cannot tell them apart will treat every whole-page read as a fabrication.
 */
export function groundClaim(claimText, snippetText) {
  const claim = normalize(claimText)
  const snippet = normalize(snippetText)
  if (!claim || !snippet) return null
  return snippet.toLowerCase().includes(claim.toLowerCase())
}

/**
 * The lookup key for "where did this sentence come from".
 *
 * A hash, so the question can be asked without the store ever having held the
 * sentence — a claim whose text was withheld is still findable by anyone who
 * has the text, and by nobody who does not.
 */
export const claimKeyFor = (text) => {
  const normalized = normalize(text)
  return normalized ? shortHash(normalized.toLowerCase()) : null
}

/* -------------------------------------------------------------- recording */

function baseRecord({ kind, links, tab, source, locator, at, requestedAt }) {
  const url = normalizeUrl(source.url)
  const requested = source.requestedUrl ? normalizeUrl(source.requestedUrl) : null

  return {
    recordId: `prv_${crypto.randomUUID()}`,
    version: PROVENANCE_VERSION,
    kind,
    at: new Date(at).toISOString(),
    requestedAt: requestedAt ? new Date(requestedAt).toISOString() : null,
    /* Ids only. Every one of these is a row in a store that already exists and
     * already owns its own fields; copying any of them here creates a second
     * copy waiting to disagree with the first. */
    links: {
      commandId: links.commandId ?? null,
      capsuleId: links.capsuleId ?? null,
      ledgerId: links.ledgerId ?? null,
      stepKey: links.stepKey ?? null,
      receiptId: links.receiptId ?? null,
      jobId: links.jobId ?? null,
      sessionId: links.sessionId ? clip(links.sessionId, 80) : null,
      watchId: links.watchId ?? null,
    },
    tab: {
      tabId: Number.isInteger(tab.tabId) ? tab.tabId : null,
      windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
      /* A tab id addresses nothing without the context that issued it — Safari
       * gives every extension context its own namespace and renumbers between
       * commands. browserSessions.js and evidenceCapsules.js both carry this
       * scar; recording the number alone would be recording noise. */
      extensionId: links.extensionId ? clip(links.extensionId, 120) : null,
    },
    source: {
      ...url,
      title: clip(source.title, MAX_TITLE_CHARS),
      requestedUrl: requested?.url ?? null,
      /* A requested URL that differs from the landed one is a fact worth
       * seeing, not a discrepancy to resolve. A claim read off a page you were
       * redirected to is a different claim. */
      redirected: Boolean(requested && requested.url && requested.url !== url.url),
    },
    locator,
  }
}

/*
 * The budget is overridable per call for the same reason browserBridge lets its
 * spool path be pointed elsewhere: a second agent instance, and a test that has
 * to prove the bound HOLDS without writing half a megabyte through six fsyncs
 * per record to do it. The mechanism is identical at any budget — the
 * undercount this guards against is proportional — so a small one proves it.
 */
function commit(record, filePath, budget = {}) {
  const store = load(filePath)
  const written = save({ ...store, records: [record, ...store.records] }, filePath, budget)
  /* Return what was PERSISTED. A record that was shed on the way to disk must
   * not be handed back in its fat in-memory form, or a caller reads fields the
   * audit will never see. */
  return written.records.find((entry) => entry.recordId === record.recordId) ?? null
}

/**
 * Record one reading, and settle at capture whether the claim drawn from it was
 * in it.
 *
 * `text` is the snippet the reading returned. It is used and then dropped: what
 * is stored is its digest. evidenceCapsules.js holds the body, redacted and
 * content-addressed, and `capsuleId` points at it — there is no second copy of
 * a logged-in page in this store.
 */
export function recordExtraction(
  {
    text = '',
    claim = null,
    url = '',
    requestedUrl = null,
    title = '',
    tabId = null,
    windowId = null,
    extensionId = null,
    ref = null,
    selector = null,
    mode = null,
    commandId = null,
    capsuleId = null,
    ledgerId = null,
    stepKey = null,
    receiptId = null,
    jobId = null,
    sessionId = null,
    watchId = null,
    at = Date.now(),
    requestedAt = null,
  } = {},
  { filePath = provenanceLocation(), maxStoreBytes = MAX_STORE_BYTES } = {},
) {
  const locator = normalizeLocator({ ref, selector, mode })
  const record = baseRecord({
    kind: 'extraction',
    links: { commandId, capsuleId, ledgerId, stepKey, receiptId, jobId, sessionId, watchId, extensionId },
    tab: { tabId, windowId },
    source: { url, requestedUrl, title },
    locator,
    at,
    requestedAt,
  })

  const snippet = isSecretLocator(locator)
    ? withheldDigest(
        String(text ?? '').length,
        'The locator names a credential field, so the reading was not digested.',
      )
    : snippetDigest(text)

  /*
   * A read scoped to one element IS a value, and that is what makes a later
   * write to the same element undoable (see priorValueFor).
   *
   * Only when it is scoped and short. A whole-page read is not a field value,
   * and a long scoped read is a region rather than a control — typing either of
   * them back into an input would be a second edit dressed as an undo. The two
   * sources are kept apart in `claim.source` because they mean different
   * things: a `reading` claim is the page's own text and its grounding is
   * trivially true, while an `asserted` claim came from a summariser and its
   * grounding is the only evidence there is about whether it made it up.
   */
  const asserted = claim === null || claim === undefined ? null : String(claim)
  const scoped =
    asserted === null &&
    locator.kind !== 'document' &&
    normalize(text) &&
    normalize(text).length <= MAX_RESTORE_CHARS
      ? String(text)
      : null

  const claimText = asserted ?? scoped
  const stored = claimText
    ? persistableValue(claimText, {
        locator,
        max: scoped ? MAX_RESTORE_CHARS : MAX_CLAIM_CHARS,
      })
    : null

  return commit(
    {
      ...record,
      snippet,
      claim: claimText
        ? {
            source: scoped ? 'reading' : 'asserted',
            text: stored.value,
            withheld: stored.withheld,
            why: stored.why,
            sensitivity: stored.sensitivity,
            /* Findable by hash even when the text was withheld. */
            key: claimKeyFor(claimText),
            chars: claimText.length,
            /* THE FIELD THIS MODULE EXISTS FOR. Settled now, against text that
             * is about to be thrown away, and never recomputable afterwards. */
            grounded: groundClaim(claimText, text),
          }
        : null,
      lastCheck: null,
    },
    filePath,
    { maxStoreBytes },
  )
}

/*
 * Which write actions can be put back by re-issuing one command, and how.
 *
 * Data rather than a switch, for the reason the BROWSER_READINGS table in
 * computerControl.js is data: adding a write action and forgetting whether it
 * can be undone should be one missing line somebody can see, not a silent gap
 * that defaults to "no".
 *
 * `type` and `select` both REPLACE rather than append — background.js calls the
 * HTMLInputElement value setter with the whole string, and sets element.value
 * on the option it matched — so re-issuing with the previous value is an exact
 * restore rather than an approximation. That is checked against the extension
 * source, not assumed; if that changes, this table is wrong and the undo is a
 * second edit.
 */
const UNDO_BY_ACTION = {
  type: {
    needsBefore: true,
    inverse: (before, locator) => ({
      type: 'browser_type',
      label: 'restore the previous value',
      params: {
        ...(locator.selector ? { selector: locator.selector } : {}),
        ...(locator.selector ? {} : { ref: locator.ref }),
        text: before,
      },
    }),
  },
  select: {
    needsBefore: true,
    inverse: (before, locator) => ({
      type: 'browser_select',
      label: 'restore the previously selected option',
      params: {
        ...(locator.selector ? { selector: locator.selector } : {}),
        ...(locator.selector ? {} : { ref: locator.ref }),
        value: before,
      },
    }),
  },
  navigate: {
    needsBefore: true,
    inverse: (before) => ({
      type: 'browser_navigate',
      label: 'go back to the page that was open before',
      params: { url: before },
    }),
  },
  click: {
    needsBefore: false,
    reason:
      'A click is not a value that can be put back. What it did — a submit, an expand, a delete — is a property of the page, and only the page knows how to reverse it.',
  },
  press_key: {
    needsBefore: false,
    reason:
      'A keypress is not a value that can be put back; its effect belongs to whatever had focus.',
  },
  scroll: {
    needsBefore: false,
    reason: 'Scrolling changed nothing on the page, so there is nothing to undo.',
  },
}

/**
 * The previous value of this field, from a reading this store already holds.
 *
 * This is what makes the workbench worth having rather than a log. The bridge
 * does not capture a before-value — nothing in the command contract asks the
 * extension for one — so a caller that does not supply one would leave every
 * write permanently un-undoable. But a read of the same field on the same page
 * IS the before-value, and the agent takes those constantly: browserInspect
 * snapshots before it acts, formFill reads before it drafts, pageWatch reads on
 * every tick.
 *
 * So the lookup is by locator key and page, most recent reading strictly before
 * the write. Nothing site-specific: it matches on the address the caller itself
 * used. When there is no such reading it says so, and names what would have
 * made the write undoable, rather than reporting a false null.
 *
 * Only a `reading` claim qualifies. An `asserted` claim is a summariser's
 * sentence about the page — "your order ships Tuesday" — and typing that into
 * the field it was read near would be a second edit wearing an undo's clothes.
 */
export function priorValueFor(
  { url, locator, before = Date.now(), tabId = null } = {},
  { filePath = provenanceLocation() } = {},
) {
  const page = normalizeUrl(url).url
  const key = locator?.key
  if (!page || !key) return null

  const cutoff = new Date(before).getTime()

  return (
    load(filePath)
      .records.filter(
        (record) =>
          record.kind === 'extraction' &&
          record.claim?.source === 'reading' &&
          record.claim?.text !== null &&
          record.source?.url === page &&
          record.locator?.key === key &&
          /* A tab id only narrows when both sides have one; it is never
           * required, because the same page in a renumbered tab is still the
           * same field. */
          (tabId === null || record.tab?.tabId === null || record.tab.tabId === tabId) &&
          Date.parse(record.at) <= cutoff,
      )
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0] ?? null
  )
}

/**
 * Record one write, with what the field said before it and how to put it back.
 *
 * `before` may be supplied by the caller; when it is not, an earlier reading of
 * the same locator on the same page is used (see priorValueFor). When neither
 * exists the record is honest about it — `undoable:false` with a reason that
 * names the missing read — rather than storing an empty string and offering an
 * undo that would blank the field.
 */
export function recordMutation(
  {
    action = '',
    before = undefined,
    after = '',
    submitted = false,
    url = '',
    requestedUrl = null,
    title = '',
    tabId = null,
    windowId = null,
    extensionId = null,
    ref = null,
    selector = null,
    commandId = null,
    ledgerId = null,
    stepKey = null,
    receiptId = null,
    jobId = null,
    sessionId = null,
    at = Date.now(),
    requestedAt = null,
    ok = true,
  } = {},
  { filePath = provenanceLocation(), maxStoreBytes = MAX_STORE_BYTES } = {},
) {
  const locator = normalizeLocator({ ref, selector })
  const actionType = clip(action, 40).replace(/^browser_/, '')
  const record = baseRecord({
    kind: 'mutation',
    links: { commandId, capsuleId: null, ledgerId, stepKey, receiptId, jobId, sessionId, watchId: null, extensionId },
    tab: { tabId, windowId },
    source: { url, requestedUrl, title },
    locator,
    at,
    requestedAt,
  })

  const rule = UNDO_BY_ACTION[actionType] ?? null

  /* Supplied wins; inherited is a fallback, and which one it was is recorded —
   * an inherited before-value is only as fresh as the read it came from, and a
   * caller deciding whether to trust an undo needs to know that. */
  let beforeSource = 'supplied'
  let inherited = null
  let beforeText = before

  if (beforeText === undefined || beforeText === null) {
    inherited = rule?.needsBefore
      ? priorValueFor({ url, locator, before: at, tabId }, { filePath })
      : null
    beforeText = inherited?.claim?.text ?? null
    beforeSource = inherited ? 'inherited' : 'unknown'
  }

  const beforeValue =
    beforeText === null || beforeText === undefined
      ? null
      : persistableValue(beforeText, { locator })
  const afterValue = persistableValue(after, { locator })

  const undo = buildUndo({
    actionType,
    rule,
    locator,
    beforeValue,
    beforeSource,
    submitted,
    ok,
  })

  return commit(
    {
      ...record,
      action: actionType,
      ok: ok !== false,
      submitted: Boolean(submitted),
      before: {
        known: Boolean(beforeValue && beforeValue.value !== null),
        source: beforeSource,
        from: inherited?.recordId ?? null,
        observedAt: inherited?.at ?? null,
        value: beforeValue?.value ?? null,
        withheld: Boolean(beforeValue?.withheld),
        why: beforeValue?.why ?? null,
        digest: beforeValue?.digest ?? snippetDigest(''),
      },
      after: {
        value: afterValue.value,
        withheld: afterValue.withheld,
        why: afterValue.why,
        digest: afterValue.digest,
      },
      undo,
      undone: null,
    },
    filePath,
    { maxStoreBytes },
  )
}

function buildUndo({ actionType, rule, locator, beforeValue, beforeSource, submitted, ok }) {
  const caveats = []

  /* A ref is a live-DOM attribute from a snapshot that has almost certainly
   * been discarded by the time anyone asks for an undo. Say so rather than
   * handing back a plan that will fail with "Snapshot ref not found". */
  if (locator.kind === 'ref' && !locator.selector) {
    caveats.push(
      'The only address recorded is a snapshot ref, which does not survive a reload. Take a fresh snapshot before running this.',
    )
  }
  if (submitted) {
    caveats.push(
      'The write also submitted the form. Restoring the field does not un-submit it; whatever the submission started has already happened.',
    )
  }
  if (beforeSource === 'inherited') {
    caveats.push(
      'The previous value came from an earlier reading of the same field, not from the write itself, so it is only as current as that reading.',
    )
  }

  if (!rule) {
    return {
      undoable: false,
      reason: `No undo is defined for a ${actionType || 'browser'} action here. Add it to UNDO_BY_ACTION in browserProvenance.js rather than assuming one.`,
      action: null,
      caveats,
    }
  }

  if (!rule.needsBefore) {
    return { undoable: false, reason: rule.reason, action: null, caveats }
  }

  if (ok === false) {
    return {
      undoable: false,
      reason: 'The write failed, so there is nothing to put back.',
      action: null,
      caveats,
    }
  }

  if (!beforeValue || beforeValue.value === null) {
    return {
      undoable: false,
      reason:
        beforeValue?.why ??
        'Nothing recorded what this field said before the write, so restoring it would blank it rather than put it back. Read the field — or snapshot it — before writing to make this undoable.',
      action: null,
      caveats,
    }
  }

  if (!locator.selector && !locator.ref) {
    return {
      undoable: false,
      reason: 'The write recorded no locator, so there is nothing to address the undo at.',
      action: null,
      caveats,
    }
  }

  return {
    undoable: true,
    reason: null,
    action: rule.inverse(beforeValue.value, locator),
    caveats,
  }
}

/* ----------------------------------------------------------- the adapter */

/*
 * Which browser command types are readings and which are writes. `navigate` is
 * a write here even though it extracts nothing: it changes what the tab is
 * showing, and going back is a real undo the owner may want.
 */
const MUTATION_TYPES = new Set(['click', 'type', 'select', 'press_key', 'scroll', 'navigate'])

/**
 * One line to wire this in, wherever the owner decides the seam belongs.
 *
 * Takes the record browserBridge.completeBrowserCommand returns — or anything
 * with the same shape, which includes what computerControl's runBrowserAction
 * holds — and files the right kind of provenance for it. Both sides already
 * carry `result.provenance`: the extension stamps tab, landed URL, title and
 * locator (bridge-core.provenanceFor) and the bridge adds command, session,
 * device and clocks (browserBridge.typedResult). Nothing here re-derives any of
 * that; it reads what is already there and defaults only where it is missing.
 *
 * IT NEVER THROWS. Recording provenance must not turn a page the owner asked
 * for into an error, and this is the function most likely to be called from
 * inside a completion path. Failures come back as a value.
 */
export function recordBrowserResult(completed, options = {}) {
  try {
    const { filePath = provenanceLocation(), ...extra } = options
    const action = completed?.action ?? {}
    const type = String(action.type ?? '').replace(/^browser_/, '')
    const result = completed?.result ?? {}
    const page = result.provenance ?? {}
    const params = action.params ?? {}

    const common = {
      url: page.url || result.url || params.url || '',
      requestedUrl: page.requestedUrl || params.url || null,
      title: page.title || result.title || '',
      tabId: Number.isInteger(page.tabId) ? page.tabId : null,
      windowId: Number.isInteger(page.windowId) ? page.windowId : null,
      extensionId: page.extensionId ?? completed?.claimedBy ?? null,
      ref: params.ref ?? null,
      /* The extension's locator is the authority when it disagrees: it is the
       * side that resolved the element. */
      selector: params.selector ?? (page.locator !== 'document' ? page.locator : null) ?? null,
      commandId: page.commandId ?? completed?.commandId ?? null,
      sessionId: page.sessionId ?? completed?.sessionId ?? null,
      at: Date.parse(page.observedAt ?? page.completedAt ?? '') || Date.now(),
      requestedAt: Date.parse(page.requestedAt ?? '') || null,
      ...extra,
    }

    if (MUTATION_TYPES.has(type)) {
      return {
        ok: true,
        record: recordMutation(
          {
            ...common,
            action: type,
            after: type === 'navigate' ? common.url : (params.text ?? params.value ?? params.label ?? ''),
            /* A navigate's "before" is the page the tab was on. The extension
             * does not report it, so it is inherited or absent like any other
             * before-value — never guessed. */
            submitted: params.submit === true,
            ok: completed?.status !== 'failed',
          },
          { filePath },
        ),
      }
    }

    return {
      ok: true,
      record: recordExtraction(
        {
          ...common,
          mode: params.mode ?? null,
          text: typeof result.content === 'string' ? result.content : '',
          capsuleId: result.evidence?.capsuleId ?? null,
        },
        { filePath },
      ),
    }
  } catch (error) {
    /* A value, not a throw, and no page text in it: the message is this
     * module's own, and the caller is a completion path that must keep going. */
    return { ok: false, record: null, error: clip(error?.message ?? error, MAX_REASON_CHARS) }
  }
}

/* ------------------------------------------------------------- the check */

/*
 * What a caller should do about each verdict. The verdict alone is a label; the
 * pairing is what makes the check something to act on rather than something to
 * display.
 */
const VERDICTS = {
  holds: { act: 'trust', why: 'The page still says it.' },
  cosmetic: {
    act: 'trust',
    why: 'The page re-rendered — only clocks and opaque tokens moved — and the claim is still in it.',
  },
  stale: {
    act: 're-read',
    why: 'The page changed under this claim. Read it again before repeating it.',
  },
  contradicted: {
    act: 'retract',
    why: 'The page has not changed and the claim is not in it, so the extraction was wrong when it was taken.',
  },
  unsupported: {
    act: 'retract',
    why: 'The claim was not in the text it was drawn from at the moment it was read. Nothing on the page ever said it.',
  },
  gone: {
    act: 'ask',
    why: 'The locator no longer returns anything. The page may have changed shape, or the tab may be somewhere else.',
  },
  unknown: {
    act: 'ask',
    why: 'There is nothing stored that this reading can be compared against.',
  },
}

/*
 * The same verdicts said about a write. Only where the meaning genuinely
 * differs — the rest fall through to the wording above rather than being
 * restated, because two copies of a sentence are two sentences to keep in step.
 */
const WRITE_VERDICTS = {
  holds: 'The field still holds what was written to it.',
  cosmetic:
    'The page re-rendered around the field, but what was written to it is still there.',
  stale:
    'Something changed the field after the write. It may have been the site, the owner, or a later action.',
  contradicted:
    'The field is unchanged and does not hold what was written, so the site never accepted the write. It reported success and did nothing.',
  gone: 'The field no longer returns anything. The form may have been replaced or submitted away.',
}

/**
 * Has the page changed under this claim, and does the claim still stand?
 *
 * CHEAP ON PURPOSE. Two hashes over text the caller already has; no disk read of
 * a body, no network, no re-fetch from inside this module — the caller does the
 * read, because the caller owns the browser lifecycle and a provenance store
 * that reaches for the browser is a provenance store that can hang.
 *
 * The three-way distinction the whole feature exists for lands here:
 *
 *   the page moved            -> stale        -> re-read
 *   the page did not move and
 *     the claim is not in it  -> contradicted -> retract, fix the locator
 *   the claim never was in it -> unsupported  -> retract, distrust the summariser
 *
 * `record` is not required to be in the store. Passing a record object checks
 * without touching disk at all, which is what makes this callable in a loop.
 */
export function checkClaim(
  recordOrId,
  freshText,
  { now = Date.now(), filePath = provenanceLocation(), persist = false } = {},
) {
  const record =
    typeof recordOrId === 'string'
      ? getProvenance(recordOrId, { filePath })
      : (recordOrId ?? null)

  if (!record) return null

  const fresh = snippetDigest(freshText)

  /*
   * A write is checked against what it WROTE.
   *
   * "Did my edit stick" is the same question as "does this claim still hold",
   * asked of the other half of the feature, and it has the same three answers:
   * the field still holds it, something changed it since, or the site never
   * accepted it. Sites reformat what you type (a phone number, a date), reject
   * it silently, or re-render the form from the server a second later — and
   * without this the agent reports "typed successfully" and never finds out.
   */
  const stored = record.kind === 'mutation' ? (record.after?.digest ?? {}) : (record.snippet ?? {})
  const claim =
    record.kind === 'mutation'
      ? record.after?.value
        ? { source: 'written', text: record.after.value, withheld: false, grounded: true }
        : null
      : (record.claim ?? null)

  const verdict = judge({ stored, fresh, freshText, claim })
  const subject = record.kind === 'mutation' ? 'write' : 'claim'
  const outcome = {
    recordId: record.recordId,
    checkedAt: new Date(now).toISOString(),
    /* What is being judged. The verdicts are the same words for both because
     * they are the same question — does the page still bear this out — but
     * "contradicted" means "the extraction was wrong" about a reading and "the
     * site did not accept it" about a write, and a caller acting on one must
     * not read it as the other. */
    subject,
    verdict,
    act: VERDICTS[verdict].act,
    why: (subject === 'write' ? WRITE_VERDICTS[verdict] : null) ?? VERDICTS[verdict].why,
    /* The observable facts behind the verdict, so a caller can disagree with
     * the judgement without having to re-derive the inputs. */
    pageChanged: stored.hash && fresh.hash ? stored.hash !== fresh.hash : null,
    meaningChanged: stored.maskedHash && fresh.maskedHash ? stored.maskedHash !== fresh.maskedHash : null,
    claimPresent: claim && !claim.withheld && claim.text ? groundClaim(claim.text, freshText) : null,
    groundedAtCapture: claim?.grounded ?? null,
    observedAt: record.at,
    ageMs: Math.max(0, now - Date.parse(record.at)),
    source: record.source?.url ?? null,
    locator: record.locator?.key ?? null,
  }

  /* Optional, and bounded by construction: lastCheck is a fixed-size field that
   * overwrites, so recording a verdict never grows the store. The default is
   * off because a check is a read and a read should not have to write. */
  if (persist && typeof recordOrId === 'string') {
    mutateRecord(record.recordId, filePath, (entry) => ({
      ...entry,
      lastCheck: {
        at: outcome.checkedAt,
        verdict: outcome.verdict,
        act: outcome.act,
        freshHash: fresh.hash,
      },
    }))
  }

  return outcome
}

function judge({ stored, fresh, freshText, claim }) {
  if (claim?.grounded === false) return 'unsupported'
  if (stored.withheld || !stored.hash) return 'unknown'
  if (!normalize(freshText)) return stored.chars ? 'gone' : 'unknown'

  const pageChanged = stored.hash !== fresh.hash
  const meaningChanged = stored.maskedHash !== fresh.maskedHash

  /* No claim to test: the record stands for the reading itself, and the only
   * question is whether the reading is still current. */
  if (!claim || claim.withheld || !claim.text) {
    if (!pageChanged) return 'holds'
    return meaningChanged ? 'stale' : 'cosmetic'
  }

  const present = groundClaim(claim.text, freshText)

  if (meaningChanged) return present ? 'cosmetic' : 'stale'
  /* The page says the same thing it did. If the claim is not in it now it was
   * not in it then either, whatever the summariser reported. */
  if (!present) return 'contradicted'
  return pageChanged ? 'cosmetic' : 'holds'
}

/* ---------------------------------------------------------------- reads */

export function getProvenance(recordId, { filePath = provenanceLocation() } = {}) {
  return load(filePath).records.find((entry) => entry.recordId === recordId) ?? null
}

function mutateRecord(recordId, filePath, change) {
  const store = load(filePath)
  const index = store.records.findIndex((entry) => entry.recordId === recordId)
  if (index === -1) return null

  const records = [...store.records]
  records[index] = change(records[index])
  const written = save({ ...store, records }, filePath)
  return written.records.find((entry) => entry.recordId === recordId) ?? null
}

/**
 * A record as anything downstream may display it.
 *
 * Built by allowlist, never by spreading the stored record: a field added to
 * the store later must be added here deliberately before it can leave. The two
 * fields that can hold page-derived text — the claim and the before/after
 * values — are withheld unless the caller asks for them, because the common
 * readers of this (a list route, a dashboard, a summary) want to know a claim
 * EXISTS and where it came from, not what it said.
 */
export function presentRecord(record, { reveal = false } = {}) {
  if (!record) return null

  const claim = record.claim
    ? {
        key: record.claim.key,
        chars: record.claim.chars,
        grounded: record.claim.grounded,
        withheld: record.claim.withheld,
        why: record.claim.why,
        sensitivity: record.claim.sensitivity,
        text: reveal && !record.claim.withheld ? record.claim.text : null,
      }
    : null

  const shared = {
    recordId: record.recordId,
    kind: record.kind,
    at: record.at,
    requestedAt: record.requestedAt,
    links: record.links,
    tab: record.tab,
    source: record.source,
    locator: record.locator,
    snippet: record.snippet,
    revealed: Boolean(reveal),
  }

  if (record.kind === 'extraction') {
    return { ...shared, claim, lastCheck: record.lastCheck ?? null }
  }

  return {
    ...shared,
    action: record.action,
    ok: record.ok,
    submitted: record.submitted,
    before: {
      known: record.before?.known ?? false,
      source: record.before?.source ?? 'unknown',
      from: record.before?.from ?? null,
      observedAt: record.before?.observedAt ?? null,
      withheld: record.before?.withheld ?? false,
      why: record.before?.why ?? null,
      digest: record.before?.digest ?? null,
      value: reveal ? (record.before?.value ?? null) : null,
    },
    after: {
      withheld: record.after?.withheld ?? false,
      why: record.after?.why ?? null,
      digest: record.after?.digest ?? null,
      value: reveal ? (record.after?.value ?? null) : null,
    },
    undo: {
      undoable: record.undo?.undoable ?? false,
      reason: record.undo?.reason ?? null,
      caveats: record.undo?.caveats ?? [],
      /* The action carries the value it would put back, so it is revealed on
       * the same terms as the value itself. GET /undo is the route that wants
       * it and asks for it explicitly. */
      action: reveal ? (record.undo?.action ?? null) : null,
    },
    undone: record.undone ?? null,
    lastCheck: record.lastCheck ?? null,
  }
}

/**
 * The only shape anything is allowed to log.
 *
 * Fixed keys, all of them ids, hashes, hosts and counts. No claim, no field
 * value, no page text, no path — a URL path on a logged-in site is itself a
 * disclosure ("/orders/48812/return"), so the host is as far as this goes.
 * There is a test that puts a sentinel string into every text-bearing field of
 * a record and asserts it cannot be found anywhere in this output.
 */
export function logLineFor(record) {
  if (!record) return null
  return {
    recordId: record.recordId ?? null,
    kind: record.kind ?? null,
    action: record.action ?? null,
    at: record.at ?? null,
    host: record.source?.host ?? null,
    redirected: record.source?.redirected ?? null,
    tabId: record.tab?.tabId ?? null,
    locatorKind: record.locator?.kind ?? null,
    snippetHash: record.snippet?.hash ?? null,
    claimKey: record.claim?.key ?? null,
    claimGrounded: record.claim?.grounded ?? null,
    undoable: record.undo?.undoable ?? null,
    commandId: record.links?.commandId ?? null,
    capsuleId: record.links?.capsuleId ?? null,
    ledgerId: record.links?.ledgerId ?? null,
  }
}

export function listProvenance(
  {
    kind = null,
    host = null,
    url = null,
    claim = null,
    undoable = null,
    grounded = null,
    limit = 25,
    reveal = false,
  } = {},
  { filePath = provenanceLocation() } = {},
) {
  const store = load(filePath)
  const pageKey = url ? normalizeUrl(url).url : null
  const claimKey = claim ? claimKeyFor(claim) : null

  const matched = store.records.filter((record) => {
    if (kind && record.kind !== kind) return false
    if (host && record.source?.host !== host) return false
    if (pageKey && record.source?.url !== pageKey) return false
    if (claimKey && record.claim?.key !== claimKey) return false
    if (undoable !== null && Boolean(record.undo?.undoable) !== Boolean(undoable)) return false
    if (grounded !== null && record.claim?.grounded !== grounded) return false
    return true
  })

  const bounded = Math.max(1, Number(limit) || 25)

  return {
    ok: true,
    readOnly: true,
    storePath: filePath,
    budget: {
      maxStoreBytes: MAX_STORE_BYTES,
      maxRecordBytes: MAX_RECORD_BYTES,
      usedBytes: storeBytesOf(store),
      note: 'Measured with the same indentation atomicJsonStore writes, so this is the size of the file rather than a proxy for it.',
    },
    /* Said out loud: a bounded store drops things, and a reader who does not
     * know that reads an absence as "the agent never did it". */
    dropped: store.dropped,
    total: matched.length,
    records: matched.slice(0, bounded).map((record) => presentRecord(record, { reveal })),
  }
}

/**
 * Where a sentence came from, found by hash.
 *
 * The owner hears "your order ships Tuesday" and asks which page said so. The
 * text is hashed and matched; the store never had to hold the sentence for this
 * to work, so a claim whose text was withheld as a secret is still traceable by
 * whoever already knows it.
 */
export function traceClaim(text, { limit = 10, reveal = false, filePath = provenanceLocation() } = {}) {
  const key = claimKeyFor(text)
  if (!key) {
    return { ok: false, error: 'A claim to trace is required.', key: null, records: [] }
  }

  const records = load(filePath)
    .records.filter((record) => record.claim?.key === key)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, Math.max(1, Number(limit) || 10))

  return {
    ok: true,
    readOnly: true,
    key,
    found: records.length,
    note: records.length
      ? 'Matched by hash of the normalised claim. The store does not need to have kept the text for this to match.'
      : 'Nothing in the store was recorded as having produced this claim. That is not proof it was invented — provenance is only recorded where it is wired in — but nothing here stands behind it.',
    records: records.map((record) => presentRecord(record, { reveal })),
  }
}

/* ----------------------------------------------------------------- undo */

/**
 * The plan for putting one write back. It runs nothing.
 *
 * Same stance as actionLedgerRoutes' resume: deciding is not doing. The action
 * comes back in the shape /execute takes, and the caller — which owns the abort
 * controller, the job tracker and the focus coordinator — decides whether to
 * send it. A module that both decided and acted would be a module nobody can
 * audit, which is the opposite of the point.
 *
 * It deliberately does NOT re-derive reversibility. planPreview.foreseeAction
 * and actionReceipts.describeReversibility own that question for Mac actions;
 * this answers the narrower one they cannot — whether the previous contents of
 * a specific field on a specific page were recorded.
 */
export function undoPlanFor(recordId, { filePath = provenanceLocation() } = {}) {
  const record = getProvenance(recordId, { filePath })
  if (!record) return null

  if (record.kind !== 'mutation') {
    return {
      ok: false,
      recordId,
      executed: false,
      undoable: false,
      reason: 'This record is a reading. Nothing was changed, so there is nothing to undo.',
      action: null,
      caveats: [],
    }
  }

  if (record.undone) {
    return {
      ok: true,
      recordId,
      executed: false,
      undoable: false,
      reason: `This write was already put back at ${record.undone.at}.`,
      action: null,
      caveats: [],
      undone: record.undone,
    }
  }

  return {
    ok: true,
    recordId,
    executed: false,
    undoable: Boolean(record.undo?.undoable),
    reason: record.undo?.reason ?? null,
    action: record.undo?.action ?? null,
    caveats: record.undo?.caveats ?? [],
    context: {
      wrote: record.action,
      to: record.source?.url ?? null,
      at: record.at,
      locator: record.locator,
    },
    note: 'Nothing has run. Send `action` to /execute to put the field back.',
  }
}

/** Write down that an undo was carried out. Records; does not act. */
export function markUndone(
  recordId,
  { jobId = null, receiptId = null, ok = true, now = Date.now(), filePath = provenanceLocation() } = {},
) {
  return mutateRecord(recordId, filePath, (record) => ({
    ...record,
    undone: {
      at: new Date(now).toISOString(),
      ok: ok !== false,
      jobId: jobId ?? null,
      receiptId: receiptId ?? null,
    },
  }))
}

/* -------------------------------------------------------------- bounding */

/**
 * Shrink one record to its budget by shedding the fields that can hold text.
 *
 * Lossy, and it says so at the field it lost — a reader can tell an absent value
 * from an elided one, and a write whose before-value went is marked un-undoable
 * rather than quietly offering an undo that would blank the field. Every value
 * here is already capped at write time, so this is a backstop; the day it fires
 * is the day something started putting a page in a provenance record, and the
 * shed markers are how that gets noticed.
 */
export function fitRecord(record, { maxBytes = MAX_RECORD_BYTES } = {}) {
  if (storeBytesOf(record) <= maxBytes) return record

  let next = record
  const shed = []

  for (const field of SHED_ORDER) {
    if (storeBytesOf(next) <= maxBytes) break

    if (field === 'afterValue' && next.after?.value) {
      next = { ...next, after: { ...next.after, value: null, elided: true } }
      shed.push('after.value')
      continue
    }
    if (field === 'claimText' && next.claim?.text) {
      next = { ...next, claim: { ...next.claim, text: null, elided: true } }
      shed.push('claim.text')
      continue
    }
    if (field === 'beforeValue' && next.before?.value) {
      next = {
        ...next,
        before: { ...next.before, value: null, known: false, elided: true },
        undo: {
          undoable: false,
          reason:
            'The previous value was shed to keep the record inside its byte budget, so it can no longer be put back. Its digest was kept, so whether the field still holds it can still be checked.',
          action: null,
          caveats: next.undo?.caveats ?? [],
        },
      }
      shed.push('before.value')
    }
  }

  return { ...next, compacted: shed.length ? shed : null }
}

/**
 * Fit the whole store inside its byte budget.
 *
 * A mutation nobody has undone ranks ahead of a reading, because it is the only
 * record here that something still needs: a reading can be re-taken from the
 * page, and an undo whose before-value is gone cannot be reconstructed from
 * anything. It is NOT exempt — an exemption is how a bounded store becomes an
 * unbounded one, and a hundred un-undone writes would each be "the one we must
 * keep". They compete on the same budget, and what falls off is counted and
 * dated rather than vanishing.
 */
export function pruneRecords(
  records,
  { maxStoreBytes = MAX_STORE_BYTES, maxRecordBytes = MAX_RECORD_BYTES } = {},
) {
  const fitted = (Array.isArray(records) ? records : []).map((record) =>
    fitRecord(record, { maxBytes: maxRecordBytes }),
  )

  const rank = (record) =>
    record?.kind === 'mutation' && record?.undo?.undoable && !record?.undone ? 0 : 1

  const ranked = [...fitted].sort(
    (left, right) =>
      rank(left) - rank(right) || Date.parse(right?.at ?? 0) - Date.parse(left?.at ?? 0),
  )

  const kept = []
  const dropped = []
  /* The store is more than its records — the version and the drop counters are
   * written too — so the envelope is priced before anything is admitted.
   * Charging only for records is how a byte budget quietly overruns its file. */
  let used = storeBytesOf(envelope([]))

  for (const record of ranked) {
    const bytes = nestedBytesOf(record)
    if (used + bytes <= maxStoreBytes) {
      kept.push(record)
      used += bytes
    } else {
      dropped.push(record)
    }
  }

  /*
   * Then verify, because the estimate above is an estimate.
   *
   * The greedy pass is cheap and close, and it was wrong: the first cut summed
   * each record at indent zero and the real file came out 14% over budget,
   * because a record nested two levels inside the store gains four spaces on
   * every one of its lines. That is exactly the shape of failure this project
   * has been bitten by before — a budget measured with a different serializer
   * than the writer uses is not a budget, it is a hope with a number on it.
   *
   * So the loop below measures the store as it will actually be written and
   * drops from the tail — the lowest-ranked record — until it genuinely fits.
   * `kept` is still in rank order here, which is what makes popping the right
   * end of it the right thing to drop. It runs a handful of times at most
   * because the estimate is close, and it is what turns the budget into a
   * guarantee rather than an intention.
   */
  while (kept.length && storeBytesOf(envelope(kept)) > maxStoreBytes) {
    dropped.push(kept.pop())
  }
  used = storeBytesOf(envelope(kept))

  kept.sort((left, right) => Date.parse(right?.at ?? 0) - Date.parse(left?.at ?? 0))

  return {
    records: kept,
    bytes: used,
    dropped: dropped.length,
    droppedBytes: dropped.reduce((total, record) => total + storeBytesOf(record), 0),
    droppedThrough: dropped.length
      ? dropped
          .map((record) => record?.at ?? null)
          .filter(Boolean)
          .sort()
          .pop()
      : null,
  }
}

/* ---------------------------------------------------------------- routes */

/**
 * Wire the provenance surface onto an app.
 *
 * A registration function rather than route definitions in server.js, for the
 * reason actionLedgerRoutes and pageWatchRoutes give: server.js is shared
 * surface several people edit at once, and a feature that owns its routes can be
 * mounted, moved or removed in one line there. Mount with:
 *
 *     registerBrowserProvenanceRoutes(app)
 *
 * EVERY ROUTE IS A READ OR A NOTE. Nothing here executes a browser command.
 * POST /check compares text the caller already holds. GET /undo returns an
 * action for /execute and does not send it. POST /undone writes down that the
 * caller ran one. If you are here to add a route that performs an undo, put it
 * next to /execute in server.js where the abort controller and the job tracker
 * live — an undo that both decides and acts is an undo nobody can audit.
 *
 * `reveal=1` is what returns the claim text and the field values. It is opt-in
 * rather than default because the ordinary reader of these routes wants to know
 * a claim exists and where it came from, not to have a page behind the owner's
 * login copied into another response.
 */
export function registerBrowserProvenanceRoutes(
  app,
  { basePath = '/browser/provenance', filePath = provenanceLocation() } = {},
) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerBrowserProvenanceRoutes requires an Express-style app.')
  }

  const routes = []
  const add = (method, routePath, handler) => {
    app[method](routePath, handler)
    routes.push(`${method.toUpperCase()} ${routePath}`)
  }

  const truthy = (value) => value === '1' || value === 'true' || value === true
  const fail = (response, error, code = 400) =>
    response.status(code).json({ ok: false, error: String(error?.message || error) })

  add('get', basePath, (request, response) => {
    const limit = Number.parseInt(String(request.query?.limit ?? ''), 10)
    try {
      response.json(
        listProvenance(
          {
            kind: String(request.query?.kind ?? '').trim() || null,
            host: String(request.query?.host ?? '').trim() || null,
            url: String(request.query?.url ?? '').trim() || null,
            undoable: request.query?.undoable === undefined ? null : truthy(request.query.undoable),
            grounded: request.query?.grounded === undefined ? null : truthy(request.query.grounded),
            limit: Number.isFinite(limit) && limit > 0 ? limit : 25,
            reveal: truthy(request.query?.reveal),
          },
          { filePath },
        ),
      )
    } catch (error) {
      fail(response, error)
    }
  })

  /* Registered before the :recordId routes so the literal wins the match. */
  add('post', `${basePath}/trace`, (request, response) => {
    const result = traceClaim(String(request.body?.claim ?? ''), {
      limit: Number(request.body?.limit) || 10,
      reveal: truthy(request.body?.reveal),
      filePath,
    })
    response.status(result.ok ? 200 : 400).json(result)
  })

  add('get', `${basePath}/:recordId`, (request, response) => {
    const record = getProvenance(String(request.params?.recordId ?? ''), { filePath })
    if (!record) {
      fail(response, new Error('No provenance record with that id.'), 404)
      return
    }
    response.json({
      ok: true,
      readOnly: true,
      record: presentRecord(record, { reveal: truthy(request.query?.reveal) }),
    })
  })

  /*
   * Has the page changed under this claim?
   *
   * POST because the fresh text travels in the body — it is page content and has
   * no business in a query string — not because it changes anything. It writes
   * only when asked (`persist`), and then only a fixed-size verdict that
   * overwrites the last one, so checking can never grow the store.
   */
  add('post', `${basePath}/:recordId/check`, (request, response) => {
    const outcome = checkClaim(
      String(request.params?.recordId ?? ''),
      String(request.body?.text ?? ''),
      { filePath, persist: truthy(request.body?.persist) },
    )
    if (!outcome) {
      fail(response, new Error('No provenance record with that id.'), 404)
      return
    }
    response.json({ ok: true, executed: false, ...outcome })
  })

  add('get', `${basePath}/:recordId/undo`, (request, response) => {
    const plan = undoPlanFor(String(request.params?.recordId ?? ''), { filePath })
    if (!plan) {
      fail(response, new Error('No provenance record with that id.'), 404)
      return
    }
    response.json({ readOnly: true, ...plan })
  })

  add('post', `${basePath}/:recordId/undone`, (request, response) => {
    const record = markUndone(String(request.params?.recordId ?? ''), {
      jobId: request.body?.jobId ?? null,
      receiptId: request.body?.receiptId ?? null,
      ok: request.body?.ok !== false,
      filePath,
    })
    if (!record) {
      fail(response, new Error('No provenance record with that id.'), 404)
      return
    }
    response.json({ ok: true, record: presentRecord(record) })
  })

  return routes
}
