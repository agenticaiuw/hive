/*
 * Approval cards in the browser, tested as the pure modules they are.
 *
 * Four claims worth pinning: an approval_request is ROUTED to render (never
 * to the executor) and only from a trusted sender; the freshness rules that
 * guard commands do not silently swallow a question the owner was meant to
 * see; the decision that goes back is byte-for-byte the frozen contract —
 * payload {approvalId, decision}, corr = the request ENVELOPE's id; and
 * at-least-once delivery collapses to one card and one answer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_MESH_COMMAND_AGE_MS,
  RELAY_NODE_ADDRESS,
  RELAY_ORIGIN_ALLOWLIST,
  acceptEnvelopes,
  normalizeRelayConfig,
} from '../src/relay-peer.js'
import {
  approvalBadge,
  approvalCountdown,
  approvalIsExpired,
  mergeApprovalPrompts,
  prepareApprovalDecision,
} from '../src/approvals.js'
import {
  APPROVAL_DECISION_KIND,
  APPROVAL_REQUEST_KIND,
  MAX_APPROVAL_PROMPTS,
  SETTLED_PROMPT_TTL_MS,
  approvalPromptFromEnvelope,
  pruneApprovalPrompts,
  settleApprovalPrompt,
} from '../../shared/approvalMesh.js'

const NOW = Date.parse('2026-08-09T04:00:00.000Z')

const config = normalizeRelayConfig({
  relayEnabled: true,
  relayUrl: RELAY_ORIGIN_ALLOWLIST[0],
  relayDeviceId: 'evan-safari-bridge',
  deviceToken: 'pdt_not_a_real_token',
})

function requestEnvelope(overrides = {}, payload = {}) {
  return {
    v: 1,
    id: 'nmsg_req_AAAAAAAAAAAAAA',
    from: RELAY_NODE_ADDRESS,
    to: 'evan-safari-bridge',
    kind: APPROVAL_REQUEST_KIND,
    payload: {
      approvalId: 'apv_open_bank_tab_1',
      summary: 'Open your bank in a new tab and download the March statement',
      detail: 'browser.command navigate → click "Statements". Two page actions.',
      risk: 'medium',
      expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
      ...payload,
    },
    corr: null,
    createdAt: new Date(NOW - 2_000).toISOString(),
    expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * Routing: render, never execute — and only for trusted senders.
 * ------------------------------------------------------------------ */

test('an approval_request routes to the approval surface, and is acked', () => {
  const accepted = acceptEnvelopes([requestEnvelope()], { config, now: NOW })
  assert.equal(accepted.run.length, 1)
  assert.equal(accepted.run[0].handling, 'approval')
  assert.deepEqual(accepted.ackIds, ['nmsg_req_AAAAAAAAAAAAAA'])
})

test('an untrusted sender cannot put a prompt on the owner’s screen', () => {
  /* A prompt is a social lever: "Approve: sync your passwords" from a rogue
   * paired node must never render. Still acked — refusal is not a lost ack. */
  const accepted = acceptEnvelopes([requestEnvelope({ from: 'second-browser-node' })], {
    config,
    now: NOW,
  })
  assert.equal(accepted.run.length, 0)
  assert.match(accepted.ignored[0].reason, /not a trusted sender/)
  assert.equal(accepted.ackIds.length, 1)
})

test('the freshness rules that guard commands do not swallow a question', () => {
  /* Older than the command ceiling AND past the envelope's own delivery
   * window — the shape of mail drained on wake after a long suspend. A
   * command like this must be refused; a question must still surface, and
   * the card's payload deadline is what renders it disabled. */
  const stale = {
    createdAt: new Date(NOW - MAX_MESH_COMMAND_AGE_MS - 60_000).toISOString(),
    expiresAt: new Date(NOW - 1_000).toISOString(),
  }

  const approval = acceptEnvelopes([requestEnvelope(stale)], { config, now: NOW })
  assert.equal(approval.run.length, 1, 'the approval must surface')
  assert.equal(approval.run[0].handling, 'approval')

  const command = acceptEnvelopes(
    [
      requestEnvelope({
        ...stale,
        id: 'nmsg_cmd_BBBBBBBBBBBBBB',
        kind: 'browser.command',
        payload: { type: 'list_tabs', params: {} },
      }),
    ],
    { config, now: NOW },
  )
  assert.equal(command.run.length, 0, 'the command ceiling must still stand')
})

/* ------------------------------------------------------------------ *
 * Request → card.
 * ------------------------------------------------------------------ */

test('a request becomes the card the popup renders', () => {
  const card = approvalPromptFromEnvelope(requestEnvelope(), { now: NOW })
  assert.equal(card.approvalId, 'apv_open_bank_tab_1')
  assert.match(card.summary, /March statement/)
  assert.match(card.detail, /Two page actions/)
  assert.equal(card.risk, 'medium')
  assert.equal(card.expiresAt, new Date(NOW + 5 * 60_000).toISOString())
  assert.equal(card.envelopeId, 'nmsg_req_AAAAAAAAAAAAAA')
  assert.equal(card.from, RELAY_NODE_ADDRESS)
  assert.equal(card.decision, null)
})

test('junk never becomes a card', () => {
  assert.equal(approvalPromptFromEnvelope(null), null)
  assert.equal(
    approvalPromptFromEnvelope(requestEnvelope({ kind: 'browser.ping' })),
    null,
  )
  assert.equal(
    approvalPromptFromEnvelope(requestEnvelope({}, { approvalId: '' })),
    null,
  )
})

/* ------------------------------------------------------------------ *
 * Dedupe: at-least-once, keyed on approvalId.
 * ------------------------------------------------------------------ */

test('duplicate delivery collapses to one card under the newest envelope id', () => {
  const first = mergeApprovalPrompts([], [requestEnvelope()], { now: NOW })
  const second = mergeApprovalPrompts(
    first.prompts,
    [requestEnvelope({ id: 'nmsg_req_CCCCCCCCCCCCCC' })],
    { now: NOW + 1_000 },
  )
  assert.equal(second.prompts.length, 1)
  assert.equal(second.prompts[0].envelopeId, 'nmsg_req_CCCCCCCCCCCCCC')

  /* And an EXACT duplicate changes nothing — same array back, so the worker
   * can skip the storage write and the popup fan-out. */
  const third = mergeApprovalPrompts(
    second.prompts,
    [requestEnvelope({ id: 'nmsg_req_CCCCCCCCCCCCCC' })],
    { now: NOW + 2_000 },
  )
  assert.equal(third.changed, false)
  assert.equal(third.prompts, second.prompts)
})

test('a redelivery never un-decides a settled card', () => {
  const { prompts } = mergeApprovalPrompts([], [requestEnvelope()], { now: NOW })
  const settled = settleApprovalPrompt(prompts, 'apv_open_bank_tab_1', 'approve', { now: NOW })
  const after = mergeApprovalPrompts(
    settled,
    [requestEnvelope({ id: 'nmsg_req_DDDDDDDDDDDDDD' })],
    { now: NOW + 3_000 },
  )
  assert.equal(after.prompts.length, 1)
  assert.equal(after.prompts[0].decision, 'approve')
})

/* ------------------------------------------------------------------ *
 * The decision: the frozen shape, on the existing send path.
 * ------------------------------------------------------------------ */

test('the decision request is the contract, exactly', () => {
  const { prompts } = mergeApprovalPrompts([], [requestEnvelope()], { now: NOW })
  const prepared = prepareApprovalDecision(prompts, 'apv_open_bank_tab_1', 'approve', {
    config,
    now: NOW,
  })

  assert.equal(prepared.ok, true)
  assert.equal(prepared.request.method, 'POST')
  assert.equal(prepared.request.path, '/v1/node/messages')
  assert.equal(prepared.request.auth, 'device')
  assert.equal(prepared.request.body.to, RELAY_NODE_ADDRESS)
  assert.equal(prepared.request.body.kind, APPROVAL_DECISION_KIND)
  assert.deepEqual(prepared.request.body.payload, {
    approvalId: 'apv_open_bank_tab_1',
    decision: 'approve',
  })
  /* corr = the REQUEST ENVELOPE's id — not the approvalId. */
  assert.equal(prepared.request.body.correlationId, 'nmsg_req_AAAAAAAAAAAAAA')
  /* `from` stays absent: the relay stamps it from the credential. */
  assert.equal('from' in prepared.request.body, false)

  /* The settle rides with the ok — persisted only after the send succeeds. */
  assert.equal(prepared.envelopeId, 'nmsg_req_AAAAAAAAAAAAAA')
  assert.equal(prepared.prompts[0].decision, 'approve')
})

test('deny goes back as a decision, not as silence', () => {
  const { prompts } = mergeApprovalPrompts([], [requestEnvelope()], { now: NOW })
  const prepared = prepareApprovalDecision(prompts, 'apv_open_bank_tab_1', 'deny', {
    config,
    now: NOW,
  })
  assert.equal(prepared.ok, true)
  assert.deepEqual(prepared.request.body.payload, {
    approvalId: 'apv_open_bank_tab_1',
    decision: 'deny',
  })
})

test('an approval is answered once', () => {
  const { prompts } = mergeApprovalPrompts([], [requestEnvelope()], { now: NOW })
  const first = prepareApprovalDecision(prompts, 'apv_open_bank_tab_1', 'approve', {
    config,
    now: NOW,
  })
  const second = prepareApprovalDecision(first.prompts, 'apv_open_bank_tab_1', 'deny', {
    config,
    now: NOW + 1_000,
  })
  assert.equal(second.ok, false)
  assert.match(second.error, /answered once/)
  /* And the refused list is the input unchanged: still approved. */
  assert.equal(second.prompts[0].decision, 'approve')
})

test('a card this browser no longer holds is refused, not invented', () => {
  const prepared = prepareApprovalDecision([], 'apv_gone', 'approve', { config, now: NOW })
  assert.equal(prepared.ok, false)
  assert.match(prepared.error, /no longer held/)
})

test('a junk decision word never reaches the wire', () => {
  const { prompts } = mergeApprovalPrompts([], [requestEnvelope()], { now: NOW })
  const prepared = prepareApprovalDecision(prompts, 'apv_open_bank_tab_1', 'yes please', {
    config,
    now: NOW,
  })
  assert.equal(prepared.ok, false)
  assert.match(prepared.error, /"approve" or "deny"/)
})

/* ------------------------------------------------------------------ *
 * Expiry: disabled, visible, and never answerable.
 * ------------------------------------------------------------------ */

test('an expired request renders disabled with "expired" and refuses answers', () => {
  const card = approvalPromptFromEnvelope(
    requestEnvelope({}, { expiresAt: new Date(NOW - 1_000).toISOString() }),
    { now: NOW },
  )
  assert.equal(approvalIsExpired(card, NOW), true)
  assert.equal(approvalCountdown(card, NOW), 'expired')

  const prepared = prepareApprovalDecision([card], card.approvalId, 'approve', {
    config,
    now: NOW,
  })
  assert.equal(prepared.ok, false)
  assert.match(prepared.error, /expired/)
})

test('a live card expires on the clock, not on redraw luck', () => {
  const card = approvalPromptFromEnvelope(requestEnvelope(), { now: NOW })
  assert.equal(approvalIsExpired(card, NOW), false)
  assert.equal(approvalCountdown(card, NOW), '5m 00s left')
  assert.equal(approvalCountdown(card, NOW + 30_000), '4m 30s left')
  assert.equal(approvalCountdown(card, NOW + 5 * 60_000 - 1_000), '1s left')
  assert.equal(approvalIsExpired(card, NOW + 5 * 60_000), true)
  assert.equal(approvalCountdown(card, NOW + 5 * 60_000), 'expired')
})

/* ------------------------------------------------------------------ *
 * The badge, and the bounded store behind it.
 * ------------------------------------------------------------------ */

test('the badge counts exactly the prompts still waiting on the owner', () => {
  assert.equal(approvalBadge([], NOW), null)

  const live = approvalPromptFromEnvelope(requestEnvelope(), { now: NOW })
  const expired = approvalPromptFromEnvelope(
    requestEnvelope(
      { id: 'nmsg_req_EEEEEEEEEEEEEE' },
      { approvalId: 'apv_expired', expiresAt: new Date(NOW - 1).toISOString() },
    ),
    { now: NOW },
  )
  const decided = {
    ...approvalPromptFromEnvelope(
      requestEnvelope({ id: 'nmsg_req_FFFFFFFFFFFFFF' }, { approvalId: 'apv_done' }),
      { now: NOW },
    ),
    decision: 'deny',
    decidedAt: new Date(NOW).toISOString(),
  }

  const badge = approvalBadge([live, expired, decided], NOW)
  assert.deepEqual(badge, { text: '1', color: '#B07C1F' })
})

test('the store is bounded, and live questions are shed last', () => {
  const cards = []
  for (let index = 0; index < MAX_APPROVAL_PROMPTS + 3; index += 1) {
    cards.push(
      approvalPromptFromEnvelope(
        requestEnvelope(
          { id: `nmsg_req_over_${String(index).padStart(8, '0')}` },
          { approvalId: `apv_over_${index}` },
        ),
        { now: NOW + index },
      ),
    )
  }
  /* Three settled receipts scattered in: they are what the cap sheds. */
  for (const index of [0, 5, 9]) {
    cards[index] = { ...cards[index], decision: 'approve', decidedAt: new Date(NOW).toISOString() }
  }

  const pruned = pruneApprovalPrompts(cards, NOW + 100)
  assert.equal(pruned.length, MAX_APPROVAL_PROMPTS)
  assert.equal(pruned.filter((card) => card.decision).length, 0, 'receipts go first')
  assert.equal(pruned.every((card) => !approvalIsExpired(card, NOW + 100)), true)
})

test('settled and long-expired receipts are swept after their showing time', () => {
  const decided = {
    ...approvalPromptFromEnvelope(requestEnvelope(), { now: NOW }),
    decision: 'approve',
    decidedAt: new Date(NOW).toISOString(),
  }
  const staleExpired = approvalPromptFromEnvelope(
    requestEnvelope(
      { id: 'nmsg_req_GGGGGGGGGGGGGG' },
      {
        approvalId: 'apv_long_gone',
        expiresAt: new Date(NOW - SETTLED_PROMPT_TTL_MS - 1_000).toISOString(),
      },
    ),
    { now: NOW },
  )

  /* Both still visible inside the receipt window… */
  assert.equal(pruneApprovalPrompts([decided, staleExpired], NOW + 1_000).length, 1)
  /* …the freshly decided one, whose window runs from decidedAt. */
  assert.equal(
    pruneApprovalPrompts([decided, staleExpired], NOW + 1_000)[0].approvalId,
    decided.approvalId,
  )
  /* And past the window, both are gone. */
  assert.equal(
    pruneApprovalPrompts([decided, staleExpired], NOW + SETTLED_PROMPT_TTL_MS + 2_000).length,
    0,
  )
})
