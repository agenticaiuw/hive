/*
 * Approval requests, surfaced in THIS browser and answered from its popup.
 *
 * The contract and the pure rules — dedupe by approvalId, the two clocks, the
 * frozen decision shape — live in shared/approvalMesh.js, where the iOS app
 * reads the same ones. This file is the extension-shaped edge: where the list
 * persists, what the toolbar badge says, and the one prepared step between a
 * popup button and the relay request background.js sends.
 *
 * WHY THE LIST LIVES IN storage.local AND NOT MODULE SCOPE: the same reason
 * the envelope ledger does (relay-peer.js). Safari suspends the worker inside
 * the very window an approval waits through, and a prompt the owner was about
 * to answer must not evaporate with the worker that received it. The popup
 * reads the same key, so a card survives the popup closing too.
 *
 * EVERYTHING HERE IS PURE. No fetch, no storage, no browser APIs — the impure
 * edges live in background.js and popup.js, the same split relay-peer.js uses.
 */
import { sendRequest } from './relay-peer.js'
import {
  approvalDecisionBody,
  approvalIsExpired,
  settleApprovalPrompt,
  undecidedApprovalCount,
} from '../../shared/approvalMesh.js'

/* Only the names background.js and popup.js actually consume ride through
 * this barrel; everything else is imported from shared/approvalMesh.js
 * directly (as the tests do). */
export {
  approvalCountdown,
  approvalIsAnswerable,
  approvalIsExpired,
  mergeApprovalPrompts,
} from '../../shared/approvalMesh.js'

/* Where the prompt list persists. Read by the popup, written by the worker. */
export const APPROVALS_KEY = 'pendingApprovals'

/**
 * What the toolbar badge shows: the number of prompts still waiting on the
 * owner, or null to fall back to the connection badge. A count outranks 'ON'
 * because 'ON' is reassurance and a count is a request — amber, like every
 * "parked, waiting for you" state in this extension's UI.
 */
export function approvalBadge(prompts, now = Date.now()) {
  const waiting = undecidedApprovalCount(prompts, now)
  if (!waiting) return null
  return { text: String(Math.min(waiting, 99)), color: '#B07C1F' }
}

/**
 * Everything between "the owner pressed a button" and "background.js performs
 * a fetch", as one pure step so the whole decision path is assertable:
 *
 *   { ok: true,  request, envelopeId, prompts }   — send `request`, and only
 *     AFTER it succeeds persist `prompts` (the settled list) and ack
 *     `envelopeId`. The settle rides in the return value rather than being
 *     applied by the caller so the two can never disagree about what was
 *     decided.
 *   { ok: false, error, prompts }                 — nothing to send; `prompts`
 *     is the input unchanged, because a refused decision must leave the card
 *     exactly as pressable or as settled as it already was.
 *
 * Refusals mirror the phone's: a prompt this browser no longer holds, one
 * already answered (an approval is answered once — the double-click and the
 * stale popup land here), and one past its own deadline.
 */
export function prepareApprovalDecision(prompts, approvalId, decision, { config, now = Date.now() } = {}) {
  const list = Array.isArray(prompts) ? prompts : []
  const prompt = list.find((entry) => entry?.approvalId === approvalId)

  if (!prompt) {
    return {
      ok: false,
      error: 'That approval is no longer held here — it may have been pruned or answered elsewhere.',
      prompts: list,
    }
  }
  if (prompt.decision) {
    return {
      ok: false,
      error: `Already answered: ${prompt.decision === 'approve' ? 'approved' : 'denied'}${
        prompt.decidedAt ? ` at ${prompt.decidedAt}` : ''
      }. An approval is answered once.`,
      prompts: list,
    }
  }
  if (approvalIsExpired(prompt, now)) {
    return {
      ok: false,
      error: 'This approval expired before it was answered. Whoever asked must send a fresh one.',
      prompts: list,
    }
  }

  let request
  try {
    /* approvalDecisionBody is the frozen shape — payload {approvalId,
     * decision}, corr = the request envelope's id — and sendRequest is the
     * SAME descriptor builder every other relay answer here uses, so the
     * decision leaves by the door results and pongs already leave by. */
    request = sendRequest(config, approvalDecisionBody(prompt, decision))
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), prompts: list }
  }

  return {
    ok: true,
    request,
    envelopeId: prompt.envelopeId,
    prompts: settleApprovalPrompt(list, approvalId, decision, { now }),
  }
}
