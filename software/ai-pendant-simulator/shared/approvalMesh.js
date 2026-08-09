/*
 * The mesh approval contract: one question from the relay, one answer from a
 * node that can put it in front of the owner.
 *
 *   request   kind 'approval_request'
 *             payload { approvalId, summary, detail, risk, expiresAt }
 *   answer    kind 'approval_decision'
 *             payload { approvalId, decision: 'approve' | 'deny' }
 *             corr = the REQUEST ENVELOPE's id
 *
 * THE SHAPE IS FROZEN. The relay sends exactly this and expects exactly this
 * back; both receiving surfaces (the iOS app's brain and the browser
 * extension) build against it here, in one place, so neither can drift from
 * the other. Note what `corr` is: the envelope id, NOT the approvalId. corr's
 * contract (shared/nodeMesh.js) is "the id of the message you are answering",
 * and the approvalId already rides inside the payload — carrying it twice
 * under two names would only invite a reader to trust the wrong one.
 *
 * THIS IS NOT shared/approvalHandoff.js. That module is the pendant's VOICE
 * approval — readbacks, confirm words, delivery evidence — and it imports
 * node:crypto, which no browser surface can load. This one is the screen
 * version of the same idea, kept as import-clean as nodeMesh.js: no Node
 * imports, no DOM, loadable by an MV3 service worker and a Capacitor WebView.
 *
 * WHY DEDUPE IS ON approvalId AND NOT envelope.id. Delivery is at-least-once,
 * and both surfaces already dedupe redelivered ENVELOPES by id. But a request
 * can also be re-SENT as a new envelope — a relay retry after a lapsed lease,
 * a nudge while the first copy sits unanswered — and an envelope-id ledger
 * cannot see that those are the same question. Two cards for one approval is
 * how an owner approves twice, or approves the copy whose deadline already
 * passed. So the surfaces key their cards on approvalId; a redelivery updates
 * the envelope id it would ack and answer under, and never un-decides
 * anything.
 *
 * TWO CLOCKS, DELIBERATELY. The ENVELOPE's expiresAt is the delivery window —
 * how long the relay will keep trying to hand the message over. The PAYLOAD's
 * expiresAt is the APPROVAL's deadline — how long the requester will honour an
 * answer. The card runs on the payload's clock: a request that expires while
 * it is on screen flips to a disabled "expired" card rather than vanishing,
 * because a question that silently disappears reads as a question that was
 * never asked.
 */

export const APPROVAL_REQUEST_KIND = 'approval_request'
export const APPROVAL_DECISION_KIND = 'approval_decision'
export const APPROVAL_DECISIONS = Object.freeze(['approve', 'deny'])

/* Bounded like every other list in this project. Twenty unanswered questions
 * for one owner is already a malfunction; the cap doubles as the signal. */
export const MAX_APPROVAL_PROMPTS = 20

/* How long a settled or expired card stays visible as a receipt before the
 * next merge sweeps it. Long enough to read what happened, short enough that
 * the surface never fills with history. */
export const SETTLED_PROMPT_TTL_MS = 10 * 60_000

const clean = (value, max) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

/**
 * One approval_request envelope, as the card a surface renders. Returns null
 * for anything else — wrong kind, no approvalId — so a caller can feed it a
 * whole drained page and keep only the questions.
 *
 * The texts are bounded here, once, because both surfaces put them straight
 * into UI: a summary is a sentence, a detail is a paragraph, and a payload
 * that claims otherwise gets trimmed rather than trusted with the layout.
 */
export function approvalPromptFromEnvelope(envelope, { now = Date.now() } = {}) {
  if (envelope?.kind !== APPROVAL_REQUEST_KIND) return null
  const payload = envelope.payload ?? {}
  const approvalId = clean(payload.approvalId, 80)
  if (!approvalId || !envelope.id) return null

  /* The payload's deadline governs; the envelope's is only the fallback for a
   * sender that named none, because a card with no clock at all would sit
   * approvable forever against a requester that gave up. */
  const payloadExpiry = Date.parse(String(payload.expiresAt ?? ''))
  const envelopeExpiry = Date.parse(String(envelope.expiresAt ?? ''))
  const expiresAt = Number.isFinite(payloadExpiry) ? payloadExpiry : envelopeExpiry

  return {
    approvalId,
    summary: clean(payload.summary, 200) || 'An action is waiting for your approval.',
    detail: clean(payload.detail, 600),
    risk: clean(payload.risk, 40),
    expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
    /* What the answer is addressed to and correlated with. `from` is stamped
     * by the relay from the sender's credential, so it can be trusted. */
    envelopeId: envelope.id,
    from: envelope.from,
    receivedAt: new Date(now).toISOString(),
    decision: null,
    decidedAt: null,
  }
}

/** Past the approval's own deadline. A prompt with no deadline never expires. */
export function approvalIsExpired(prompt, now = Date.now()) {
  const expiresAt = Date.parse(String(prompt?.expiresAt ?? ''))
  return Number.isFinite(expiresAt) && expiresAt <= now
}

/** May the owner still answer this? One predicate for every disabled button. */
export function approvalIsAnswerable(prompt, now = Date.now()) {
  return Boolean(prompt?.approvalId) && !prompt.decision && !approvalIsExpired(prompt, now)
}

/**
 * The countdown line under a card. Returns exactly 'expired' past the
 * deadline — both surfaces render that word, per the contract's own wording.
 */
export function approvalCountdown(prompt, now = Date.now()) {
  const expiresAt = Date.parse(String(prompt?.expiresAt ?? ''))
  if (!Number.isFinite(expiresAt)) return 'no deadline'
  const left = expiresAt - now
  if (left <= 0) return 'expired'
  const minutes = Math.floor(left / 60_000)
  const seconds = Math.floor((left % 60_000) / 1_000)
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s left` : `${seconds}s left`
}

/**
 * Fold freshly drained envelopes into the held prompts. Pure; the caller owns
 * where the list lives (React state on the phone, storage.local in the
 * extension).
 *
 * Returns { prompts, changed } — and the SAME array when nothing changed, so
 * a React setState or a storage write can be skipped instead of churned.
 */
export function mergeApprovalPrompts(prompts, envelopes, { now = Date.now() } = {}) {
  const held = Array.isArray(prompts) ? prompts : []
  let list = held
  let changed = false

  for (const envelope of Array.isArray(envelopes) ? envelopes : []) {
    const prompt = approvalPromptFromEnvelope(envelope, { now })
    if (!prompt) continue

    const index = list.findIndex((entry) => entry?.approvalId === prompt.approvalId)
    if (index === -1) {
      list = changed ? list : [...held]
      list.push(prompt)
      changed = true
      continue
    }

    /* A re-send of an approval this surface already holds. Keep the card —
     * and above all keep its decision — but adopt the newest envelope id, so
     * the ack and the corr name a message the relay still knows about. */
    const current = list[index]
    if (current.envelopeId === prompt.envelopeId && current.from === prompt.from) continue
    list = changed ? list : [...held]
    list[index] = { ...current, envelopeId: prompt.envelopeId, from: prompt.from }
    changed = true
  }

  if (!changed) return { prompts: held, changed: false }
  return { prompts: pruneApprovalPrompts(list, now), changed: true }
}

/** Mark one prompt decided. Pure; answering is the caller's job, first. */
export function settleApprovalPrompt(prompts, approvalId, decision, { now = Date.now() } = {}) {
  return (Array.isArray(prompts) ? prompts : []).map((prompt) =>
    prompt?.approvalId === approvalId
      ? { ...prompt, decision, decidedAt: new Date(now).toISOString() }
      : prompt,
  )
}

/** How many prompts still need the owner: live and undecided. */
export function undecidedApprovalCount(prompts, now = Date.now()) {
  return (Array.isArray(prompts) ? prompts : []).filter((prompt) =>
    approvalIsAnswerable(prompt, now),
  ).length
}

/**
 * Sweep receipts and enforce the cap. Settled and long-expired cards go
 * first; a live question is the last thing this will ever drop, and dropping
 * one at all means MAX_APPROVAL_PROMPTS questions are already unanswered.
 */
export function pruneApprovalPrompts(prompts, now = Date.now(), max = MAX_APPROVAL_PROMPTS) {
  const list = (Array.isArray(prompts) ? prompts : []).filter((prompt) => {
    if (!prompt?.approvalId) return false
    if (prompt.decidedAt && Date.parse(prompt.decidedAt) + SETTLED_PROMPT_TTL_MS <= now) {
      return false
    }
    if (!prompt.decision && approvalIsExpired(prompt, now)) {
      return Date.parse(prompt.expiresAt) + SETTLED_PROMPT_TTL_MS > now
    }
    return true
  })
  if (list.length <= max) return list

  const weight = (prompt) =>
    prompt.decision ? 0 : approvalIsExpired(prompt, now) ? 1 : 2
  const drop = new Set(
    [...list]
      .sort(
        (left, right) =>
          weight(left) - weight(right) ||
          String(left.receivedAt ?? '').localeCompare(String(right.receivedAt ?? '')),
      )
      .slice(0, list.length - max)
      .map((prompt) => prompt.approvalId),
  )
  return list.filter((prompt) => !drop.has(prompt.approvalId))
}

/**
 * The answer, in the exact frozen shape. Returns the fields a sender hands to
 * its own transport — mesh_send params on the phone, sendRequest() in the
 * extension — so the payload and the corr cannot be assembled differently on
 * different surfaces.
 */
export function approvalDecisionBody(prompt, decision) {
  if (!APPROVAL_DECISIONS.includes(decision)) {
    throw new Error(`An approval decision is "approve" or "deny", not "${String(decision)}".`)
  }
  if (!prompt?.approvalId || !prompt?.envelopeId || !prompt?.from) {
    throw new Error('A decision needs the prompt it answers: approvalId, envelopeId and from.')
  }
  return {
    to: prompt.from,
    kind: APPROVAL_DECISION_KIND,
    payload: { approvalId: prompt.approvalId, decision },
    correlationId: prompt.envelopeId,
  }
}
