/*
 * "Prepare this action on my Mac, and let me approve it from the pendant when
 * you're ready."
 *
 * Four surfaces, one commit. The Mac gathers context and fills the reversible
 * fields; the relay holds the pending decision; the pendant speaks the readback
 * and hears the answer; the browser acts once — and only once — someone said
 * yes to a description they actually heard.
 *
 * WHAT THIS FILE IS NOT. It is not a second plan record. actionLedger.js already
 * writes a durable manifest before the first step is dispatched, with per-step
 * riskTier, reversibility and a pre-state capture. A prepare/approve split IS
 * that manifest plus a deferred commit, so everything below is derived FROM a
 * manifest and points BACK at it by ledgerId. Nothing here re-derives risk,
 * reversibility or what a step touches; it asks the modules that own those
 * questions and quotes the answers out loud.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE:
 *
 *     an approval names WHAT it approves, in words the owner heard.
 *
 * A pendant has no screen. "Approve the thing you prepared?" / "yes" is not
 * consent, it is a coin flip with a confirmation dialog painted on it — the
 * owner has no way to tell which of two prepared plans they just committed, or
 * whether the plan still describes the world. So:
 *
 *   1. The readback names the target and the irreversible step by name.
 *   2. A confirm word, derived from the plan itself, is embedded in that
 *      readback. Saying it back is proof the readback was HEARD, which is the
 *      only property a screenless approval can actually establish.
 *   3. An approval whose readback was never delivered is refused outright.
 *   4. An approval is refused when the plan changed, when the world it was
 *      written against moved, or when it simply took too long.
 *
 * DELIVERY, HONESTLY. See the header of cloud-relay/announce.js: the nRF9160
 * firmware drops binary downlink unless `convo_started` is set, and matches text
 * downlink with strstr() against exactly "started", "flush" and "end". There is
 * no unprompted push today. A prepared approval therefore WAITS, and is spoken
 * on the ordinary reply path the next time the owner presses the button. That
 * is a real limitation, not a detail — it is why `deliveredAt` is a precondition
 * for granting rather than a bookkeeping field, and why the TTL below is a
 * compromise between "long enough to walk away" and "short enough that the
 * world has not moved underneath it".
 */
import crypto from 'node:crypto'

import { assertFirmwareSafeControlFrame, speakableText } from '../cloud-relay/announce.js'
import { classifySensitivity } from '../local-agent/redaction.js'

export const APPROVAL_HANDOFF_VERSION = 1

/*
 * Thirty minutes.
 *
 * Bounded from BELOW by the proposal: the owner starts something on the Mac and
 * walks away, so the window has to survive a walk to another room and a pendant
 * button press whenever they get round to it. Bounded from ABOVE by the thing
 * this module refuses to do: honour a decision about a world that has moved.
 * Thirty minutes is roughly how long a prepared plan's claims about a filesystem
 * stay true on a machine somebody else is also using.
 *
 * Deliberately far shorter than ANNOUNCEMENT_DEFAULT_TTL_MS (6 h). A briefing
 * that goes stale is merely useless; an approval that goes stale COMMITS
 * something. The two are not the same kind of expiry and must not share a
 * number.
 */
export const APPROVAL_DEFAULT_TTL_MS = 30 * 60 * 1000
export const APPROVAL_MIN_TTL_MS = 60 * 1000
export const APPROVAL_MAX_TTL_MS = 2 * 60 * 60 * 1000

/*
 * The risk tiers — riskTierFor() in actionLedgerVerify.js — where a plain "yes"
 * is not enough and the confirm word is mandatory.
 *
 * These are the plans whose commit lands somewhere the owner cannot walk back
 * from the pendant: a deleted file with no snapshot, a sent email, a shell
 * command. For a plan made entirely of reversible writes and reads, requiring a
 * code word is friction bought with nothing.
 */
export const WORD_REQUIRED_TIERS = Object.freeze([
  'irreversible-write',
  'off-machine',
  'uncontained',
])

/*
 * The confirm-word vocabulary.
 *
 * Chosen to be distinct over a 16 kHz voice link and to a half-listening human:
 * different first syllables, no rhymes, no homophones of "yes"/"no", nothing
 * that reads as a command. Sixteen words, so one nibble of the plan digest picks
 * one.
 *
 * IT IS A DISAMBIGUATOR, NOT AN AUTHENTICATOR. One in sixteen is trivially
 * guessable and is not trying not to be — the socket is already authenticated by
 * deviceAuth.js, and an attacker who can speak on it does not need to guess a
 * word. What the word buys is the thing a device credential cannot: evidence
 * that the human who said "approve" had ALREADY HEARD the sentence describing
 * what they were approving, and evidence of WHICH pending plan they meant. Both
 * of those are properties of the person, not of the channel.
 *
 * None of these contains "started", "flush" or "end" as a substring, so a
 * readback carrying one can never be mistaken by the firmware's strstr() match
 * for a conversation control frame. assertApprovalSpeechIsFirmwareSafe() makes
 * that a check rather than a promise.
 */
export const CONFIRM_WORDS = Object.freeze([
  'anchor',
  'basket',
  'cobalt',
  'dolphin',
  'ember',
  'falcon',
  'granite',
  'harbor',
  'indigo',
  'jasmine',
  'kettle',
  'lantern',
  'marlin',
  'nutmeg',
  'orchid',
  'pelican',
])

/*
 * Denial is checked before assent and wins every tie.
 *
 * "don't approve it" contains "approve"; "no, cancel" contains neither a clean
 * yes nor a clean no if you match loosely. A transcript that contains both a
 * refusal marker and an assent marker is a transcript nobody should be
 * committing an irreversible action on, so it is read as a refusal and, where
 * genuinely muddled, as `unclear` — which grants nothing.
 */
const DENY_PATTERNS = [
  /\bno\b/,
  /\bnope\b/,
  /\bnot\b/,
  /\bdon'?t\b/,
  /\bcancel\b/,
  /\bstop\b/,
  /\bdeny\b/,
  /\breject\b/,
  /\babort\b/,
  /\bwait\b/,
  /\bnever\s?mind\b/,
  /\bforget\s+it\b/,
]

const ASSENT_PATTERNS = [
  /\bapprove\b/,
  /\bapproved\b/,
  /\bconfirm\b/,
  /\bconfirmed\b/,
  /\byes\b/,
  /\byep\b/,
  /\byeah\b/,
  /\bgo\s+ahead\b/,
  /\bdo\s+it\b/,
  /\bsend\s+it\b/,
  /\bship\s+it\b/,
]

const sha256 = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex')

/* ------------------------------------------------------------- identity */

export function createApprovalId() {
  /* Same alphabet rules as createAnnouncementId(): short and [A-Za-z0-9_-] only,
   * because this id ends up inside a control frame that safeId() will reject if
   * it is anything else. */
  return `apv_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
}

/**
 * A fingerprint of WHAT is being approved.
 *
 * Not `planKeyFor()` from actionLedger.js, and the difference matters. planKey
 * hashes the raw actions, which is right for "is this the same plan I wrote
 * down". This hashes the plan AS DESCRIBED TO THE OWNER — the type, the things
 * it touches, the risk tier, and the intent hash of any content it writes. Those
 * are the fields the readback is built from, so a plan that is re-planned into a
 * different shape but described identically produces the same digest, and a plan
 * whose SPOKEN description would change produces a different one.
 *
 * That is the property an approval needs: the grant is bound to the sentence the
 * owner heard, not to an internal encoding they never saw.
 */
export function planDigestFor(manifest) {
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : []
  return sha256(
    JSON.stringify(
      steps.map((step) => ({
        seq: step?.seq ?? null,
        type: step?.type ?? '',
        riskTier: step?.riskTier ?? null,
        reversible: step?.reversible ?? null,
        touches: (Array.isArray(step?.touches) ? step.touches : []).map(
          (touch) => `${touch?.kind ?? ''}:${touch?.ref ?? ''}`,
        ),
        intent: step?.intent ?? null,
      })),
    ),
  )
}

/**
 * The confirm word for a plan. Deterministic, so the Mac that prepared it and
 * the relay that heard the answer arrive at the same word without either of them
 * having to carry it as a secret.
 */
export function confirmWordFor(planDigest) {
  const nibble = Number.parseInt(String(planDigest ?? '0').slice(-1), 16)
  return CONFIRM_WORDS[Number.isFinite(nibble) ? nibble % CONFIRM_WORDS.length : 0]
}

/* --------------------------------------------------------------- world */

/**
 * The world this plan was written against, insofar as anything can see it.
 *
 * The manifest's per-step `preState` is a content hash of what each filesystem
 * step was about to change (capturePreState in actionLedgerVerify.js). Folded
 * together, it answers the question a late approval has to answer: is the thing
 * I am about to overwrite still the thing that was there when this was
 * described to me?
 *
 * IT IS PARTIAL AND SAYS SO. Only write_file, delete_path, move_path and
 * copy_path have an observable target; a send_email or a run_shell records
 * `unobservable`, and no fingerprint can ever notice that the world moved
 * underneath one of those. `blind` counts them. A caller that reads `matches:
 * true` as "nothing changed" rather than "nothing I can see changed" has
 * misread it, which is why the count travels with the hash instead of being
 * quietly dropped.
 */
export function worldFingerprintFor(manifest) {
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : []
  const observed = []
  let blind = 0

  for (const step of steps) {
    const pre = step?.preState
    if (!pre || pre.kind === 'unobservable') {
      blind += 1
      continue
    }
    if (pre.kind === 'path') {
      observed.push({ seq: step.seq, target: pathMark(pre.target) })
      continue
    }
    if (pre.kind === 'path-pair') {
      observed.push({ seq: step.seq, from: pathMark(pre.from), to: pathMark(pre.to) })
      continue
    }
    blind += 1
  }

  return {
    hash: sha256(JSON.stringify(observed)),
    observedSteps: observed.length,
    blindSteps: blind,
  }
}

/*
 * What of a path reading is load-bearing for "has this moved".
 *
 * `mtimeMs` is deliberately excluded, for the reason actionLedgerVerify.js gives
 * where it captures it: `touch` moves an mtime without changing a byte, and a
 * restore from a snapshot can preserve one. Including it would refuse approvals
 * for edits that never happened. Content is the only honest answer, and where
 * there is no content hash (a directory, a file too large to hash) the absence
 * is itself part of the mark — so a file that grew past the hash ceiling since
 * prepare time reads as changed rather than as unchanged-by-default.
 */
function pathMark(target) {
  if (!target) return null
  return {
    path: target.path ?? null,
    existed: target.existed ?? false,
    directory: target.directory ?? false,
    bytes: target.bytes ?? null,
    sha256: target.sha256 ?? null,
    hashSkipped: target.hashSkipped ?? null,
  }
}

/* ------------------------------------------------------------ readback */

/* Cap at half of ANNOUNCEMENT_MAX_CHARS. A readback is a thing the owner stands
 * still for with their thumb on a button; it is not a briefing. */
export const READBACK_MAX_CHARS = 700

/* At most this many named targets before it becomes a list nobody follows by
 * ear. */
const MAX_SPOKEN_TARGETS = 3

/**
 * What the owner hears before approving.
 *
 * The order is the whole design, and it is ordered against how listening
 * actually degrades:
 *
 *   1. THE ASK, in the owner's own words, while attention is highest.
 *   2. WHAT CANNOT BE TAKEN BACK, named with its actual target. This is the one
 *      sentence that must never be summarised into a count — "one irreversible
 *      step" tells the owner nothing they can check, whereas "deleting
 *      ~/Documents/taxes-2025" is checkable by ear against what they asked for.
 *   3. THE SHAPE of the rest, as counts. Counts are fine here precisely because
 *      these are the steps that can be walked back.
 *   4. THE DEADLINE, then THE CONFIRM WORD, last and adjacent. Last because it
 *      is what they are about to say, and speech memory is recency-weighted;
 *      adjacent to the deadline so "this expires" and "say this" arrive as one
 *      instruction rather than two.
 *
 * THE COMMAND IS NOT ALWAYS QUOTED. It is whatever the owner said out loud, and
 * that sometimes contains a card number or a gate code. redaction.js is the
 * project's one answer to "is this a credential", so a command that classifies
 * as `secret` is replaced by the plan's own title rather than read back over a
 * speaker. Losing the phrasing costs recognisability; speaking it aloud costs
 * the secret.
 */
export function approvalReadback(manifest, { confirmWord, ttlMs = APPROVAL_DEFAULT_TTL_MS } = {}) {
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : []
  const ask = spokenAsk(manifest)
  const irreversible = steps.filter((step) => step?.reversible === false)
  const writes = steps.filter((step) => step?.effect === 'write')
  const reversibleWrites = writes.length - irreversible.length

  const head = ask ? `Ready to ${ask}.` : 'A prepared action is waiting for you.'

  /* Named, never counted — see (2) above. */
  const danger = irreversible.length
    ? `${irreversible.length === 1 ? 'One step cannot' : `${irreversible.length} steps cannot`} be undone: ${describeSteps(irreversible)}.`
    : null

  /*
   * EVERY WRITE IS NAMED, not just the irreversible ones.
   *
   * The first draft of this counted them — "1 change that can be undone" — and a
   * single-step plan to delete a small file came out as exactly that, with the
   * delete never spoken aloud. Undoable is not the same as unimportant: the
   * owner approving "clear out the old tax folder" has no way to hear WHICH
   * folder, and a readback that cannot be checked against what they asked for is
   * the failure this module exists to prevent, arriving through the back door.
   *
   * Reads stay a count. They change nothing, so there is nothing to verify.
   */
  const named = new Set(irreversible)
  const remainingWrites = writes.filter((step) => !named.has(step))
  const doing = remainingWrites.length
    ? `It will ${irreversible.length ? 'also ' : ''}${describeSteps(remainingWrites)}.`
    : null

  const reads = steps.length - writes.length
  const shape = reads > 0 ? `Plus ${reads} step${reads === 1 ? '' : 's'} that only look${reads === 1 ? 's' : ''} at things.` : null

  const minutes = Math.max(1, Math.round(ttlMs / 60000))
  const tail = confirmWord
    ? `Nothing has run yet. You have about ${minutes} minute${minutes === 1 ? '' : 's'}. To approve, say: approve ${confirmWord}. To cancel, say cancel.`
    : `Nothing has run yet. You have about ${minutes} minute${minutes === 1 ? '' : 's'}. Say approve, or say cancel.`

  /*
   * The middle is shed, never the tail.
   *
   * speakableText() truncates from the END, and the end is where the confirm
   * word lives. Letting it clip would produce a readback that asks the owner to
   * say a word it never told them — an approval nobody can give, produced by a
   * function that looked like it worked. So the optional sentences are dropped
   * one at a time, most-summarisable first, until the required head and tail
   * fit. `danger` is shed LAST of the optional parts because it is the only one
   * whose absence changes what the owner is agreeing to.
   */
  const required = [spokenSafe(head), tail]
  /* Shed order: the read count first (it verifies nothing), then the named
   * reversible writes, and `danger` last — it is the only sentence whose absence
   * changes what the owner is agreeing to. */
  const optional = [shape, doing, danger].filter(Boolean).map(spokenSafe)
  let parts = [
    spokenSafe(head),
    ...(danger ? [spokenSafe(danger)] : []),
    ...(doing ? [spokenSafe(doing)] : []),
    ...(shape ? [spokenSafe(shape)] : []),
    tail,
  ]

  while (joined(parts).length > READBACK_MAX_CHARS && optional.length) {
    const drop = optional.shift()
    parts = parts.filter((part) => part !== drop)
  }

  let text = speakableText(joined(parts), { maxChars: READBACK_MAX_CHARS })

  /* Belt and braces: if the head alone was long enough to push the tail out, the
   * head is what goes. A readback with no confirm word is not a shorter
   * readback, it is a broken one. */
  if (confirmWord && !text.includes(confirmWord)) {
    text = speakableText(joined(required), { maxChars: READBACK_MAX_CHARS })
  }
  if (confirmWord && !text.includes(confirmWord)) {
    text = speakableText(tail, { maxChars: READBACK_MAX_CHARS })
  }

  return text
}

const joined = (parts) => parts.filter(Boolean).join(' ')

/*
 * A READBACK IS A SPEAKER IN A ROOM, WHICH IS NOT THE THREAT MODEL redaction.js
 * WAS WRITTEN FOR.
 *
 * classifySensitivity() sorts values by whether they may be pasted into a prompt
 * bound for a model provider, and under that question a card number is merely
 * `sensitive` — the same bucket as an email address. actionLedger.js keeps
 * `sensitive` values deliberately, because a send_email that cannot name its
 * recipient cannot be resumed.
 *
 * Spoken aloud the two are not alike at all. Naming "sam@example.com" is the
 * entire point of a readback: it is what lets the owner check by ear that this
 * is the email they meant. Reading sixteen digits out of a pendant on a train is
 * a disclosure to everyone in the carriage, and it verifies nothing — nobody
 * confirms a card number by ear. So long digit runs are masked and everything
 * else `sensitive` is kept, which is the opposite trade from the manifest and
 * correct for the opposite reason.
 */
const LONG_DIGIT_RUN = /\d(?:[ .-]?\d){11,18}/g

function spokenSafe(value) {
  return String(value ?? '').replace(LONG_DIGIT_RUN, 'a long number I will not read out')
}

function spokenAsk(manifest) {
  const command = String(manifest?.command ?? '').trim()
  const title = String(manifest?.title ?? '').trim()

  /* A secret in the command never reaches a speaker. The title is written by the
   * planner rather than transcribed from the owner, so it is the safe fallback —
   * and if there is no title either, the step labels describe the plan without
   * quoting anything the owner said. */
  if (command && classifySensitivity(command) !== 'secret') return trimTo(command, 160)
  if (title) return trimTo(title, 160)
  if (command) return 'run the action you asked for, whose wording is being withheld because it contains something secret'

  const steps = Array.isArray(manifest?.steps) ? manifest.steps : []
  return steps.length ? describeSteps(steps.slice(0, 1)) : ''
}

/**
 * Steps, as a listener can check them.
 *
 * `label` first — planPreview and the receipt both carry the same one, so what
 * the owner hears is what the history will later say. Falling back to the type
 * plus its target keeps a bare action nameable; falling back to the type alone
 * is the last resort and is still better than "a step".
 */
function describeSteps(steps, limit = MAX_SPOKEN_TARGETS) {
  const spoken = steps.slice(0, limit).map((step) => {
    const label = String(step?.label ?? '').trim()
    if (label) return trimTo(label, 90)

    const type = String(step?.type ?? 'a step').replaceAll('_', ' ')
    const target = (Array.isArray(step?.touches) ? step.touches : [])
      .map((touch) => String(touch?.ref ?? '').trim())
      .filter(Boolean)[0]
    return target ? `${type} ${trimTo(target, 70)}` : type
  })

  const extra = steps.length - spoken.length
  const list = spoken.join(', then ')
  return extra > 0 ? `${list}, and ${extra} more` : list
}

function trimTo(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text
}

/* ------------------------------------------------------- the request */

function clampTtl(ttlMs) {
  const value = Number(ttlMs)
  if (!Number.isFinite(value)) return APPROVAL_DEFAULT_TTL_MS
  return Math.min(APPROVAL_MAX_TTL_MS, Math.max(APPROVAL_MIN_TTL_MS, value))
}

/**
 * True when a plain "yes" will not do.
 *
 * Two independent triggers. The first is the plan itself: anything that lands
 * off this machine, runs uncontained, or cannot be taken back. The second is
 * AMBIGUITY — with two approvals pending, "yes" does not identify one, and the
 * failure mode is committing the wrong prepared plan, which is the exact
 * accident this module was written to prevent.
 */
export function confirmWordRequired(manifest, { pendingCount = 1 } = {}) {
  if (Number(pendingCount) > 1) return true
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : []
  return steps.some(
    (step) =>
      WORD_REQUIRED_TIERS.includes(String(step?.riskTier ?? '')) ||
      ALWAYS_CONFIRMED_TYPES.has(String(step?.type ?? '')),
  )
}

/*
 * A delete is worth stopping for even when it is technically undoable.
 *
 * planPreview.js reaches the same conclusion in its own words — delete_path is
 * the sole member of its HARD_TO_REVERSE set, and isBulkFileOperation() returns
 * true for a plan containing one however small it is. The tier alone would not
 * catch this: a small file's delete is snapshotted into the undo vault, so it
 * scores `reversible-write` and would otherwise be committed on a bare "yes".
 * "Recoverable from a vault the owner has never opened" is not the same as
 * "safe to approve without hearing which file".
 */
const ALWAYS_CONFIRMED_TYPES = new Set(['delete_path'])

/**
 * Build the pending-approval record from a manifest that has NOT run.
 *
 * Returns the record only. It does not store it, deliver it, or execute
 * anything — this module owns the description of a decision, never the decision
 * and never the act. The record is what the relay persists (see
 * APPROVAL_STORE_CONTRACT); `readback` is carried inside it on purpose, so the
 * sentence the owner hears is fixed at prepare time and cannot be re-derived
 * differently later by a body holding a different version of this file.
 */
export function buildApprovalRequest({
  manifest,
  deviceId = 'nrf9160-pendant',
  pendingCount = 1,
  ttlMs = APPROVAL_DEFAULT_TTL_MS,
  now = Date.now(),
} = {}) {
  if (!manifest?.ledgerId) {
    throw new Error('An approval must point at a plan manifest; open one with openLedger() first.')
  }
  const steps = Array.isArray(manifest.steps) ? manifest.steps : []
  if (!steps.length) throw new Error('An approval needs a plan with at least one step.')

  const ttl = clampTtl(ttlMs)
  const planDigest = planDigestFor(manifest)
  const needsWord = confirmWordRequired(manifest, { pendingCount })
  const confirmWord = needsWord ? confirmWordFor(planDigest) : null
  const readback = approvalReadback(manifest, { confirmWord, ttlMs: ttl })

  return {
    version: APPROVAL_HANDOFF_VERSION,
    approvalId: createApprovalId(),
    deviceId: String(deviceId || '').trim() || 'nrf9160-pendant',

    /* The join back to the record that already exists. Nothing about the plan is
     * copied here beyond what has to be SAID or COMPARED — the manifest is the
     * plan, and a second copy is a second thing to disagree with the first. */
    ledgerId: manifest.ledgerId,
    planKey: manifest.planKey ?? null,
    jobId: manifest.jobId ?? null,
    sessionId: manifest.sessionId ?? null,

    planDigest,
    world: worldFingerprintFor(manifest),
    risk: manifest.risk ?? null,

    confirmWord,
    requiresConfirmWord: needsWord,
    readback,

    state: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),

    /* Delivery is a precondition for granting, not a statistic. See
     * evaluateApprovalGrant(): a readback that was never spoken cannot have been
     * heard, and an approval nobody heard is not an approval. */
    deliveredAt: null,
    deliveryPath: null,
    attempts: 0,

    decidedAt: null,
    decision: null,
    decidedBy: null,
    refusal: null,
    committedAt: null,
  }
}

/** What may be read back over HTTP or logged: everything. There is no secret in
 * an approval record — the confirm word is spoken aloud by design. */
export function presentApproval(record) {
  if (!record) return null
  return {
    approvalId: record.approvalId,
    deviceId: record.deviceId,
    ledgerId: record.ledgerId,
    planKey: record.planKey ?? null,
    state: record.state,
    requiresConfirmWord: record.requiresConfirmWord ?? false,
    confirmWord: record.confirmWord ?? null,
    readback: record.readback,
    risk: record.risk ?? null,
    world: record.world ?? null,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    deliveredAt: record.deliveredAt ?? null,
    deliveryPath: record.deliveryPath ?? null,
    attempts: record.attempts ?? 0,
    decision: record.decision ?? null,
    decidedAt: record.decidedAt ?? null,
    decidedBy: record.decidedBy ?? null,
    refusal: record.refusal ?? null,
    committedAt: record.committedAt ?? null,
  }
}

/* ------------------------------------------------------------ listening */

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    /* ASR punctuates; a trailing comma must not stop "marlin," matching
     * "marlin". Apostrophes survive so "don't" stays one word. */
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Read a spoken reply as a decision. Grants nothing on its own.
 *
 * Three verdicts, and `unclear` is the important one. A pendant transcript over
 * LTE is not reliable prose, and the two failure directions are not symmetric:
 * hearing "no" as "go" commits something irreversible, while hearing "go" as
 * nothing at all costs one more button press. So anything ambiguous — a refusal
 * marker present, an assent with the wrong word, an assent with no word when a
 * word was required — lands on `unclear` or `denied`, never on `granted`.
 */
export function matchApprovalUtterance(text, { confirmWord = null, requiresConfirmWord = false } = {}) {
  const said = normalize(text)
  if (!said) {
    return { decision: 'unclear', why: 'Nothing was said.', said, matchedWord: null }
  }

  const denied = DENY_PATTERNS.some((pattern) => pattern.test(said))
  const assented = ASSENT_PATTERNS.some((pattern) => pattern.test(said))
  const matchedWord = confirmWord && new RegExp(`\\b${confirmWord}\\b`).test(said) ? confirmWord : null

  /* Refusal wins outright, even alongside an assent marker. "no, don't approve
   * that" contains "approve". */
  if (denied) {
    return {
      decision: 'denied',
      why: assented
        ? 'The reply contained both a refusal and an assent; a mixed answer is treated as a refusal.'
        : 'The reply was a refusal.',
      said,
      matchedWord,
    }
  }

  if (!assented) {
    /* The confirm word alone is not consent. It is a word the readback just
     * said out loud, so the pendant may well have caught the tail of its own
     * speech, or the owner may be repeating it back while thinking. */
    return {
      decision: 'unclear',
      why: matchedWord
        ? 'The confirm word was heard but no approval was: say "approve" with it.'
        : 'The reply was neither an approval nor a refusal.',
      said,
      matchedWord,
    }
  }

  if (requiresConfirmWord && !matchedWord) {
    return {
      decision: 'unclear',
      why: confirmWord
        ? `This plan needs its confirm word: say "approve ${confirmWord}".`
        : 'This plan needs its confirm word, but no word was set on the request.',
      said,
      matchedWord: null,
    }
  }

  return { decision: 'granted', why: 'The reply approved the plan.', said, matchedWord }
}

/* ------------------------------------------------------------- verdict */

const refuse = (reason, why, extra = {}) => ({
  ok: false,
  decision: 'refused',
  reason,
  why,
  ...extra,
})

/**
 * Decide whether a grant may be honoured. Pure; commits nothing.
 *
 * Every branch below is a way an approval can be technically valid and still
 * wrong, and they are checked in the order that produces the most useful
 * refusal — identity, then liveness, then whether the owner could possibly have
 * heard it, then whether the plan and the world still match the description.
 *
 * `worldNow` is the fingerprint taken AT COMMIT TIME by the body holding the
 * filesystem (the Mac). It is a parameter rather than a call because this module
 * runs on the relay too, where there is no filesystem to look at — and a relay
 * that silently skipped the world check would be the one place the whole
 * mechanism could be bypassed.
 */
export function evaluateApprovalGrant(
  record,
  { utterance = null, decision = null, decidedBy = 'pendant', planDigest = null, worldNow = null, now = Date.now() } = {},
) {
  if (!record) {
    return refuse(
      'not-found',
      'There is no pending approval with that id. It may have expired and been pruned, or it was never stored.',
    )
  }

  /* Replay. A grant that arrives twice — a retried delivery, a double button
   * press — must commit once. */
  if (record.state !== 'pending') {
    return refuse(
      'already-decided',
      `This approval was already ${record.state}${record.decidedAt ? ` at ${record.decidedAt}` : ''}. An approval is answered once.`,
      { state: record.state },
    )
  }

  const expiresAt = Date.parse(record.expiresAt ?? '')
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return refuse(
      'expired',
      `This approval was prepared at ${record.createdAt} and expired at ${record.expiresAt}. It is being refused rather than honoured because the plan described a world that may have moved since. Prepare it again to get a fresh readback.`,
      { expiredAt: record.expiresAt ?? null },
    )
  }

  /*
   * The rule that makes this a readback rather than a prompt.
   *
   * A pending approval that was never spoken to the owner cannot have been
   * heard, so a "yes" against it approves a description nobody received. Given
   * that delivery today rides the reply path after a button press (see the file
   * header), an undelivered-but-granted record is not a hypothetical — it is
   * what you get if any caller ever wires the grant path before the speak path.
   */
  if (!record.deliveredAt) {
    return refuse(
      'not-delivered',
      'The readback for this approval was never spoken to the pendant, so nobody can have heard what they were approving. Deliver it first.',
    )
  }

  const heard = utterance !== null && utterance !== undefined
    ? matchApprovalUtterance(utterance, {
        confirmWord: record.confirmWord ?? null,
        requiresConfirmWord: record.requiresConfirmWord ?? false,
      })
    : { decision: String(decision ?? 'unclear'), why: 'Decision supplied directly.', said: null, matchedWord: null }

  if (heard.decision === 'denied') {
    return { ok: false, decision: 'denied', reason: 'denied', why: heard.why, heard }
  }
  if (heard.decision !== 'granted') {
    return refuse('unclear', heard.why, { heard })
  }

  /*
   * A grant that was carried alongside a plan digest is checked against the
   * record's. This catches the case the readback cannot: the Mac re-planned
   * between prepare and commit, so the actions about to run are no longer the
   * ones the sentence described.
   */
  if (planDigest && planDigest !== record.planDigest) {
    return refuse(
      'plan-changed',
      'The plan changed after the readback was spoken, so the approval no longer describes what would run. Prepare it again.',
      { heard },
    )
  }

  if (worldNow) {
    const before = record.world ?? {}
    if (worldNow.hash !== before.hash) {
      return refuse(
        'world-moved',
        `Something the plan was going to change is no longer as it was when this was described to you — ${before.observedSteps ?? 0} step(s) were checked and the check failed. Refusing rather than committing an approval that named a different world.`,
        { heard, before, after: worldNow },
      )
    }
  }

  return {
    ok: true,
    decision: 'granted',
    reason: null,
    why: 'The approval names this plan, the plan is unchanged, and the world it was written against still matches.',
    heard,
    decidedBy: String(decidedBy || 'pendant'),
    /* Said out loud rather than left implicit: the world check is partial by
     * construction, and a caller that logs "verified" needs to know how much was
     * verified. */
    blindSteps: record.world?.blindSteps ?? 0,
  }
}

/** Apply a verdict to a record. Pure — returns the next record, stores nothing. */
export function settleApproval(record, verdict, { now = Date.now(), decidedBy = null } = {}) {
  if (!record) return null
  const at = new Date(now).toISOString()

  if (verdict?.ok) {
    return {
      ...record,
      state: 'granted',
      decision: 'granted',
      decidedAt: at,
      decidedBy: decidedBy ?? verdict.decidedBy ?? 'pendant',
      refusal: null,
    }
  }

  /* A refusal whose reason is `not-found` or `already-decided` describes the
   * record's own state rather than a new decision, so it must not overwrite it —
   * a second grant against an already-granted approval leaves it granted. */
  if (verdict?.reason === 'already-decided' || verdict?.reason === 'not-found') return record

  return {
    ...record,
    state: verdict?.decision === 'denied' ? 'denied' : 'refused',
    decision: verdict?.decision ?? 'refused',
    decidedAt: at,
    decidedBy: decidedBy ?? verdict?.decidedBy ?? 'pendant',
    refusal: { reason: verdict?.reason ?? 'unknown', why: verdict?.why ?? null },
  }
}

/** Mark that the readback actually reached the pendant. */
export function markApprovalDelivered(record, { path = 'reply-audio', now = Date.now() } = {}) {
  if (!record) return null
  return {
    ...record,
    deliveredAt: record.deliveredAt ?? new Date(now).toISOString(),
    deliveryPath: record.deliveryPath ?? String(path),
    attempts: (record.attempts ?? 0) + 1,
  }
}

/** Live means pending and not yet expired. Nothing else is deliverable. */
export function approvalIsLive(record, now = Date.now()) {
  if (!record || record.state !== 'pending') return false
  const expiresAt = Date.parse(record.expiresAt ?? '')
  return Number.isFinite(expiresAt) && expiresAt > now
}

/**
 * What to read out on the next button press, and what to say about the rest.
 *
 * ONE AT A TIME, oldest first. Reading two approvals back to back and then
 * asking for a decision is how the owner approves the second while picturing the
 * first — the failure this module exists to prevent, reintroduced at the
 * delivery layer. The others are counted, not described, so the owner knows to
 * press again rather than assuming they have seen everything.
 */
export function selectApprovalToSpeak(records, { deviceId = null, now = Date.now() } = {}) {
  const live = (Array.isArray(records) ? records : [])
    .filter((record) => approvalIsLive(record, now))
    .filter((record) => !deviceId || record.deviceId === deviceId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))

  if (!live.length) return { approval: null, speech: null, waiting: 0 }

  const [next, ...rest] = live
  const more = rest.length
    ? ` ${rest.length} other prepared action${rest.length === 1 ? '' : 's'} ${rest.length === 1 ? 'is' : 'are'} waiting; press again after this one.`
    : ''

  return {
    approval: next,
    speech: `${next.readback}${more}`,
    waiting: live.length,
  }
}

/* -------------------------------------------------- firmware & delivery */

/**
 * Guard a readback against the pendant's downlink rules before it is spoken.
 *
 * The firmware matches TEXT downlink with strstr() on "started", "flush" and
 * "end" (cloud-relay/announce.js documents this). A readback travels as AUDIO on
 * the reply path, so those tokens in prose are harmless — but the id-carrying
 * control frame beside it is not, and a future unprompted push would put this
 * text near that boundary. Checking the id here means the wire contract is
 * asserted in the same place the speech is built, rather than discovered on a
 * device.
 */
export function approvalControlFrame({ approvalId, seconds = 0 }) {
  return assertFirmwareSafeControlFrame(
    JSON.stringify({ type: 'approval', id: safeApprovalId(approvalId), s: Math.round(seconds) }),
  )
}

/*
 * WHY THE ID IS CHECKED HERE AND NOT LEFT TO assertFirmwareSafeControlFrame.
 *
 * That guard scans the SERIALISED frame for the literal token `"flush"`. An id
 * containing a quote does not survive serialisation as a quote — JSON.stringify
 * escapes it — so `a"flush"b` reaches the wire as `a\"flush\"b`, the guard's
 * substring search misses it because of the backslashes, and the firmware's
 * strstr(), which knows nothing about JSON escaping, matches it anyway and
 * flushes the conversation.
 *
 * announce.js closes this by validating ids with safeId() before they are
 * serialised, but does not export it. This is that same three-line check rather
 * than an edit to a module that other work depends on; if safeId is ever
 * exported, delete this and call it.
 */
function safeApprovalId(id) {
  const text = String(id ?? '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(text)) {
    throw new Error('An approval id must be short and alphanumeric.')
  }
  return text
}

/**
 * The speech, normalised the same way an announcement is.
 *
 * Same function, same boundary: everything upstream writes for a screen, and a
 * readback assembled from step labels can easily pick up a path with underscores
 * or a markdown artefact from a planner. Producers get it for free and none of
 * them has to remember.
 */
export function approvalSpeech(record) {
  return speakableText(record?.readback ?? '', { maxChars: READBACK_MAX_CHARS })
}

/* ---------------------------------------------------- relay persistence */

/*
 * WHERE A PENDING APPROVAL LIVES, AND WHY IT IS NOT ON THE MAC.
 *
 * The whole point of the proposal is that the owner walks away from the Mac. A
 * Mac that sleeps loses in-memory state and stops answering the bridge poll, so
 * an approval parked in Mac memory is an approval that cannot be delivered
 * during exactly the interval it was created for. The pending record therefore
 * lives on the relay, which is awake whenever the pendant is.
 *
 * IT NEEDS NO NEW STORE METHODS. cloud-relay/store already exposes
 * saveState(stateKey, data, { updatedBy }) and getState(stateKey) on both the
 * D1 and memory implementations, which is exactly a durable keyed blob. So an
 * approval is a state row, and the per-device index below is another one. This
 * is deliberate: the store modules are being edited by someone else, and a
 * feature that can ship without touching them should.
 *
 * The Mac keeps the MANIFEST — it is already durable on disk in
 * .pendant-action-ledger.json — and nothing else. Relay holds the decision,
 * Mac holds the plan, and neither can commit without the other.
 */
export const APPROVAL_STORE_CONTRACT = Object.freeze({
  reads: Object.freeze(['getState(approvalStateKey(id))', 'getState(approvalIndexKey(deviceId))']),
  writes: Object.freeze(['saveState(approvalStateKey(id), record)', 'saveState(approvalIndexKey(deviceId), index)']),
  note:
    'Uses the existing saveState/getState pair on cloud-relay/store; no new store method is required. ' +
    'The index is a bounded id list per device because getState is key-addressed and cannot scan.',
})

export function approvalStateKey(approvalId) {
  return `approval:${String(approvalId ?? '').trim()}`
}

export function approvalIndexKey(deviceId) {
  return `approvals:${String(deviceId || '').trim() || 'nrf9160-pendant'}`
}

/*
 * The index is bounded, like every other store in this project.
 *
 * Unbounded is how a keyed blob becomes a 129 MB row. Twenty pending approvals
 * for one device is already a malfunction — nobody is going to answer twenty
 * readbacks by ear — so the cap doubles as a signal.
 */
export const MAX_INDEXED_APPROVALS = 20

/**
 * Add an id to a device's index, newest first, dropping the oldest past the cap
 * and anything whose expiry has passed.
 *
 * Pure. The caller does the getState/saveState round trip, because this module
 * must stay loadable in a Worker isolate with no store bound.
 */
export function indexApproval(index, record, { now = Date.now(), max = MAX_INDEXED_APPROVALS } = {}) {
  const entries = Array.isArray(index?.entries) ? index.entries : []
  const kept = entries.filter(
    (entry) =>
      entry?.approvalId &&
      entry.approvalId !== record?.approvalId &&
      Date.parse(entry.expiresAt ?? '') > now,
  )
  const next = record
    ? [{ approvalId: record.approvalId, expiresAt: record.expiresAt, createdAt: record.createdAt }, ...kept]
    : kept

  return {
    version: APPROVAL_HANDOFF_VERSION,
    deviceId: record?.deviceId ?? index?.deviceId ?? null,
    updatedAt: new Date(now).toISOString(),
    entries: next.slice(0, Math.max(1, max)),
    dropped: (index?.dropped ?? 0) + Math.max(0, next.length - Math.max(1, max)),
  }
}
