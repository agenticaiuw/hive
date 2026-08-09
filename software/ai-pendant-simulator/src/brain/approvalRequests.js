/*
 * Approval requests, as this phone answers them.
 *
 * The contract and every pure rule — what a card is, dedupe by approvalId,
 * the two clocks, the frozen decision shape — live in shared/approvalMesh.js,
 * where the browser extension reads the same ones. This file is only the
 * phone-shaped edge: the decision goes out through the EXISTING mesh_send
 * tool and the ack through the existing mesh_ack, so an approval answered
 * from the card and one answered by the model (if it ever is) take the same
 * authenticated path, with no second sender to keep in sync.
 *
 * HOW CARDS ARRIVE. The mesh doorbell (meshMailbox.createMeshListener) drains
 * on connect and on every mail frame, and App.jsx hands its onMail batch to
 * mergeApprovalPrompts. The same envelopes are also buffered for mesh_inbox —
 * the model may READ an approval request like any other mail — but the card
 * is the only surface that DECIDES, because deciding is the owner's tap, not
 * the model's inference.
 */
import { runMobileTool } from './mobileTools.js'
import { approvalDecisionBody, approvalIsAnswerable, approvalIsExpired } from '../../shared/approvalMesh.js'

export {
  APPROVAL_DECISION_KIND,
  APPROVAL_REQUEST_KIND,
  approvalCountdown,
  approvalIsAnswerable,
  approvalIsExpired,
  approvalPromptFromEnvelope,
  mergeApprovalPrompts,
  settleApprovalPrompt,
  undecidedApprovalCount,
} from '../../shared/approvalMesh.js'

/**
 * Send one decision and then ack the request envelope. Never throws — the
 * card's buttons need a sentence, not a stack.
 *
 * The ORDER is the contract: the decision goes out first, the ack second. An
 * ack means "I have this", and the doorbell drain already said so on receipt,
 * making this one usually a no-op — but a card can only exist because SOME
 * drain delivered it, and re-acking under the newest envelope id costs one
 * idempotent call while covering any path that never acked. What must never
 * happen is the reverse order wearing this function's name: a decision that
 * failed to send, with the request already deleted, is a question the relay
 * can no longer re-ask.
 */
export async function sendApprovalDecision({ card, decision, client, deviceId, now = Date.now() }) {
  if (card?.decision) {
    return {
      ok: false,
      error: `Already answered: ${card.decision === 'approve' ? 'approved' : 'denied'}${
        card.decidedAt ? ` at ${card.decidedAt}` : ''
      }. An approval is answered once.`,
    }
  }
  if (approvalIsExpired(card, now)) {
    return {
      ok: false,
      error: 'This approval expired before it was answered. Whoever asked must send a fresh one.',
    }
  }
  if (!approvalIsAnswerable(card, now)) {
    return { ok: false, error: 'This is not an answerable approval card.' }
  }

  let params
  try {
    params = approvalDecisionBody(card, decision)
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }

  const ctx = { client, deviceId }
  const sent = await runMobileTool('mesh_send', params, ctx)
  if (!sent.ok) {
    /* The card stays undecided: the relay never heard the answer, so the
     * button must remain pressable rather than lie about a decision sent. */
    return { ok: false, error: sent.error ?? 'The decision could not be sent.' }
  }

  /* A failed ack is not a failed decision — the answer is already on the
   * wire. The lease lapses, the request may arrive once more, and the
   * approvalId dedupe folds it back into this same, now-decided card. */
  const acked = await runMobileTool('mesh_ack', { messageIds: [card.envelopeId] }, ctx)

  return {
    ok: true,
    decision,
    messageId: sent.result?.messageId ?? null,
    delivered: sent.result?.delivered === true,
    acknowledged: acked.ok ? Number(acked.result?.acknowledged ?? 0) : 0,
  }
}
