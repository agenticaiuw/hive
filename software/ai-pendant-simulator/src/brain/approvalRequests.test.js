/*
 * The approval card, phone side: fixtures only, no network, no relay.
 *
 * The inbound half runs through the REAL drain pipeline (sortMeshEnvelopes →
 * mergeApprovalPrompts), because the one regression worth catching first is
 * the quiet one: an 'approval_request' kind that shared/nodeMesh.js refuses
 * to parse would make every request vanish before any card logic ran. The
 * outbound half asserts the frozen decision shape against a fake client —
 * payload {approvalId, decision}, corr = the request ENVELOPE's id — and the
 * ack-after-send order.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { resetMeshMailbox, sortMeshEnvelopes } from './meshMailbox.js'
import {
  APPROVAL_DECISION_KIND,
  APPROVAL_REQUEST_KIND,
  approvalCountdown,
  approvalIsAnswerable,
  approvalIsExpired,
  approvalPromptFromEnvelope,
  mergeApprovalPrompts,
  sendApprovalDecision,
  settleApprovalPrompt,
} from './approvalRequests.js'

const NOW = Date.parse('2026-08-09T12:00:00.000Z')

function requestEnvelope(overrides = {}, payload = {}) {
  return {
    v: 1,
    id: 'nmsg_req_AAAAAAAAAAAAAA',
    from: '@relay',
    to: 'evan-iphone',
    kind: APPROVAL_REQUEST_KIND,
    payload: {
      approvalId: 'apv_send_invoice_01',
      summary: 'Send the March invoice email to Dana',
      detail: 'mac_run is about to send "March invoice.pdf" from Mail to dana@example.com.',
      risk: 'high',
      expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
      ...payload,
    },
    corr: null,
    createdAt: new Date(NOW - 2_000).toISOString(),
    expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    ...overrides,
  }
}

/** A client that records every call, in order, and answers like the relay. */
function fakeClient({ failSend = false } = {}) {
  const calls = []
  return {
    calls,
    async sendNodeMessage(message) {
      calls.push(['sendNodeMessage', message])
      if (failSend) throw new Error('The relay is unreachable.')
      return {
        messageId: 'nmsg_dec_BBBBBBBBBBBBBB',
        to: message.to,
        from: 'evan-iphone',
        expiresAt: new Date(NOW + 600_000).toISOString(),
        pushed: true,
      }
    },
    async ackNodeMessages(deviceId, messageIds) {
      calls.push(['ackNodeMessages', deviceId, messageIds])
      return { acknowledged: messageIds.length, pending: 0 }
    },
  }
}

/* ------------------------------------------------------------------ *
 * Inbound: request → card.
 * ------------------------------------------------------------------ */

test('an approval_request survives the real drain pipeline and becomes a card', () => {
  resetMeshMailbox()
  /* Off the wire as JSON, through the same parse the doorbell drain uses —
   * this is the test that pins the underscore kind into the mesh charset. */
  const { fresh } = sortMeshEnvelopes([JSON.stringify(requestEnvelope())], { now: NOW })
  assert.equal(fresh.length, 1, 'the envelope must parse as mesh mail at all')

  const { prompts, changed } = mergeApprovalPrompts([], fresh, { now: NOW })
  assert.equal(changed, true)
  assert.equal(prompts.length, 1)

  const card = prompts[0]
  assert.equal(card.approvalId, 'apv_send_invoice_01')
  assert.equal(card.summary, 'Send the March invoice email to Dana')
  assert.match(card.detail, /dana@example\.com/)
  assert.equal(card.risk, 'high')
  assert.equal(card.expiresAt, new Date(NOW + 5 * 60_000).toISOString())
  assert.equal(card.envelopeId, 'nmsg_req_AAAAAAAAAAAAAA')
  assert.equal(card.from, '@relay')
  assert.equal(card.decision, null)
  assert.equal(approvalIsAnswerable(card, NOW), true)
  resetMeshMailbox()
})

test('only approval_request envelopes with an approvalId become cards', () => {
  assert.equal(
    approvalPromptFromEnvelope(requestEnvelope({ kind: 'browser.command' })),
    null,
  )
  assert.equal(
    approvalPromptFromEnvelope(requestEnvelope({}, { approvalId: '   ' })),
    null,
  )
  assert.equal(approvalPromptFromEnvelope(null), null)
})

test('the payload deadline governs the card; the envelope TTL is only delivery', () => {
  /* Envelope still deliverable for 10 minutes; the APPROVAL itself lapsed. */
  const card = approvalPromptFromEnvelope(
    requestEnvelope({}, { expiresAt: new Date(NOW - 1_000).toISOString() }),
    { now: NOW },
  )
  assert.equal(approvalIsExpired(card, NOW), true)
  assert.equal(approvalCountdown(card, NOW), 'expired')
})

/* ------------------------------------------------------------------ *
 * Dedupe: at-least-once, keyed on approvalId.
 * ------------------------------------------------------------------ */

test('a re-sent approval folds into the one card it already has', () => {
  const first = mergeApprovalPrompts([], [requestEnvelope()], { now: NOW })
  /* Same approval, NEW envelope id — a relay retry, not a redelivery the
   * envelope-id ledger could have caught. */
  const second = mergeApprovalPrompts(
    first.prompts,
    [requestEnvelope({ id: 'nmsg_req_CCCCCCCCCCCCCC' })],
    { now: NOW + 1_000 },
  )
  assert.equal(second.prompts.length, 1)
  /* The card answers and acks under the message the relay still holds. */
  assert.equal(second.prompts[0].envelopeId, 'nmsg_req_CCCCCCCCCCCCCC')
})

test('a redelivery never un-decides a card', () => {
  const { prompts } = mergeApprovalPrompts([], [requestEnvelope()], { now: NOW })
  const settled = settleApprovalPrompt(prompts, 'apv_send_invoice_01', 'deny', { now: NOW })
  const after = mergeApprovalPrompts(
    settled,
    [requestEnvelope({ id: 'nmsg_req_DDDDDDDDDDDDDD' })],
    { now: NOW + 2_000 },
  )
  assert.equal(after.prompts.length, 1)
  assert.equal(after.prompts[0].decision, 'deny')
})

test('an unchanged batch returns the same array, so React can skip the render', () => {
  const first = mergeApprovalPrompts([], [requestEnvelope()], { now: NOW })
  const again = mergeApprovalPrompts(first.prompts, [requestEnvelope()], { now: NOW + 500 })
  assert.equal(again.changed, false)
  assert.equal(again.prompts, first.prompts)
})

/* ------------------------------------------------------------------ *
 * Outbound: the frozen decision shape, on the existing mesh_send path.
 * ------------------------------------------------------------------ */

test('a tap sends the exact decision envelope, then acks the request', async () => {
  const client = fakeClient()
  const card = approvalPromptFromEnvelope(requestEnvelope(), { now: NOW })

  const outcome = await sendApprovalDecision({
    card,
    decision: 'approve',
    client,
    deviceId: 'evan-iphone',
    now: NOW,
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.delivered, true)
  assert.equal(outcome.acknowledged, 1)

  assert.equal(client.calls.length, 2)
  const [sendName, sent] = client.calls[0]
  assert.equal(sendName, 'sendNodeMessage', 'the decision goes out FIRST')
  assert.equal(sent.to, '@relay')
  assert.equal(sent.kind, APPROVAL_DECISION_KIND)
  assert.deepEqual(sent.payload, { approvalId: 'apv_send_invoice_01', decision: 'approve' })
  /* corr is the REQUEST ENVELOPE's id — the frozen contract's one subtlety. */
  assert.equal(sent.correlationId, 'nmsg_req_AAAAAAAAAAAAAA')

  const [ackName, ackDevice, ackIds] = client.calls[1]
  assert.equal(ackName, 'ackNodeMessages', 'the ack comes AFTER the send')
  assert.equal(ackDevice, 'evan-iphone')
  assert.deepEqual(ackIds, ['nmsg_req_AAAAAAAAAAAAAA'])
})

test('deny is a first-class answer, not an absence', async () => {
  const client = fakeClient()
  const card = approvalPromptFromEnvelope(requestEnvelope(), { now: NOW })
  const outcome = await sendApprovalDecision({
    card,
    decision: 'deny',
    client,
    deviceId: 'evan-iphone',
    now: NOW,
  })
  assert.equal(outcome.ok, true)
  assert.deepEqual(client.calls[0][1].payload, {
    approvalId: 'apv_send_invoice_01',
    decision: 'deny',
  })
})

test('an expired card refuses to answer and touches nothing', async () => {
  const client = fakeClient()
  const card = approvalPromptFromEnvelope(
    requestEnvelope({}, { expiresAt: new Date(NOW - 1).toISOString() }),
    { now: NOW },
  )
  const outcome = await sendApprovalDecision({
    card,
    decision: 'approve',
    client,
    deviceId: 'evan-iphone',
    now: NOW,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /expired/)
  assert.equal(client.calls.length, 0)
})

test('a decided card refuses a second answer', async () => {
  const client = fakeClient()
  const card = {
    ...approvalPromptFromEnvelope(requestEnvelope(), { now: NOW }),
    decision: 'approve',
    decidedAt: new Date(NOW).toISOString(),
  }
  const outcome = await sendApprovalDecision({
    card,
    decision: 'deny',
    client,
    deviceId: 'evan-iphone',
    now: NOW,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /answered once/)
  assert.equal(client.calls.length, 0)
})

test('a failed send leaves the request unacked and the card pressable', async () => {
  const client = fakeClient({ failSend: true })
  const card = approvalPromptFromEnvelope(requestEnvelope(), { now: NOW })
  const outcome = await sendApprovalDecision({
    card,
    decision: 'approve',
    client,
    deviceId: 'evan-iphone',
    now: NOW,
  })
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /unreachable/)
  /* No ack: a deleted request whose answer never sent is a question the
   * relay can no longer re-ask. */
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0][0], 'sendNodeMessage')
})
