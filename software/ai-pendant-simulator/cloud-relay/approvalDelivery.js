/*
 * Approval-at-origin routing: push the prompt to the node the command came from.
 *
 * A parked plan used to have exactly one address — the dashboard. The owner
 * who asked from the pendant heard silence; the one who asked from the phone
 * saw nothing until they happened to open a browser. The approval record now
 * carries `origin` (stamped at park time from the job's own source), and this
 * module is the switchboard that turns that fact into a delivery:
 *
 *   origin nrf9160 / a paired pendant   → SPOKEN. The record waits in the
 *       approval store and pendantConverse.js reads it out on the next button
 *       press, through speakNextApproval() — which is the existing machinery,
 *       attesting exactly what the stream witnessed. Nothing to push here:
 *       the firmware cannot be woken (see PENDANT_DELIVERY_REALITY), so
 *       "queued to speak" IS the delivery.
 *   origin = a mesh node (iOS phone, browser extension) → a nodeMailbox
 *       envelope, kind 'approval_request', payload {approvalId, summary,
 *       detail, risk, expiresAt}, addressed to the origin node. The decision
 *       comes back as kind 'approval_decision' addressed to '@relay', which
 *       the send route hands to consumeRelayApprovalMail() below.
 *   origin mac ('floating-hud' / 'mac-bridge' / 'dashboard' / 'local') → the
 *       Mac agent's approvalsSurface polls GET /v1/approvals and shows it;
 *       nothing is pushed because the surface is a poller by construction.
 *
 * ORIGIN CONTROLS ONLY WHERE THE PROMPT GOES. Any owner-authenticated surface
 * may still DECIDE any approval — decideApproval() below is one function used
 * by the mesh consumer, the HTTP decision route and (through the Mac agent's
 * forwarder) the local surface, so the venues cannot drift apart on what a
 * decision means.
 *
 * WHAT DECIDING IS NOT. Settling a record grants or denies the DECISION; it
 * runs nothing. The prepare/approve commit loop (local-agent/prepareApprove.js
 * commitApproval) is the only body that executes a prepared plan, and it
 * refuses a record that is already settled — which is the correct guard, not a
 * bug: a decision taken on a screen is consent to the plan as described, and
 * the run itself still belongs to the Mac that holds the manifest.
 */
import {
  approvalIsLive,
  approvalPromptText,
  matchApprovalUtterance,
  presentApproval,
  riskLabelFor,
  settleApproval,
} from '../shared/approvalHandoff.js'
import {
  answerApproval,
  readApproval,
  saveApproval,
  settleStoredApproval,
} from './approvalStore.js'
import { sendNodeMessage } from './nodeMailbox.js'
import { nudgeConverseSession } from './converseSessions.js'
import { RELAY_NODE_ADDRESS, MAX_TTL_MS } from '../shared/nodeMesh.js'

/*
 * The envelope kinds of this exchange. FROZEN, with the underscore: the
 * surface half of this contract lives in shared/approvalMesh.js (the iOS
 * brain and the browser extension both build their cards from it), and
 * shared/nodeMesh.js admits '_' inside a kind segment precisely so these two
 * strings can cross the mesh as written. Spelled as literals here rather than
 * imported so this module and that one can land independently; the mesh tests
 * freeze the strings on both sides.
 */
export const APPROVAL_REQUEST_KIND = 'approval_request'
export const APPROVAL_DECISION_KIND = 'approval_decision'

/*
 * Origin spellings that are not deviceIds. Jobs stamp their source with these
 * — pendant uploads by transport ('live_lte', 'microsd', 'pendant_upload'),
 * dashboard commands by surface, the Mac HUD as 'floating-hud' — and the
 * routing question for each is answered by the alias, not by the registry.
 */
const PENDANT_ORIGINS = new Set([
  'nrf9160',
  'pendant',
  'live_lte',
  'microsd',
  'pendant_upload',
])
const MAC_ORIGINS = new Set([
  'floating-hud',
  'mac-bridge',
  'dashboard',
  'local',
  'prepare-approve',
  'operator-approval',
  'cloudflare',
])

/**
 * Where this approval's prompt belongs, as {channel, to, why}.
 *
 * channel is one of:
 *   'pendant-speech' — spoken by pendantConverse on the next press
 *   'mesh'           — an approval_request envelope to `to`
 *   'mac-agent'      — the Mac agent's surface and the dashboard poll it up
 *
 * Unknown or unregistered origins land on 'mac-agent' deliberately: that is
 * exactly where every approval sat before origin routing existed, so a record
 * whose origin cannot be resolved degrades to the old behaviour rather than
 * to silence.
 */
export async function approvalPromptRoute({ store, record }) {
  const origin = String(record?.origin ?? '').trim()
  if (!origin) {
    return { channel: 'mac-agent', to: null, why: 'no origin recorded' }
  }
  if (PENDANT_ORIGINS.has(origin)) {
    return { channel: 'pendant-speech', to: record?.deviceId ?? null, why: `origin "${origin}" is the pendant` }
  }
  if (MAC_ORIGINS.has(origin)) {
    return { channel: 'mac-agent', to: null, why: `origin "${origin}" is a Mac surface` }
  }

  const device = await Promise.resolve(store?.getDevice?.(origin)).catch(() => null)
  if (!device) {
    return {
      channel: 'mac-agent',
      to: null,
      why: `origin "${origin}" is not a registered node; falling back to the Mac surface`,
    }
  }
  if (device.deviceType === 'nrf_pendant') {
    return { channel: 'pendant-speech', to: origin, why: 'origin is a paired pendant' }
  }
  if (device.deviceType === 'mac_bridge') {
    return { channel: 'mac-agent', to: origin, why: 'origin is the Mac bridge' }
  }
  /* mobile, browser_node, and whatever node types come later: they hold mesh
   * inboxes, so the prompt travels as mail. */
  return { channel: 'mesh', to: origin, why: `origin is a paired ${device.deviceType} node` }
}

/** True when this record is one the pendant should read out. Used by
 * pendantConverse to keep mesh- and Mac-routed prompts off the speaker. */
export function isPendantRoutedApproval(record) {
  const origin = String(record?.origin ?? '').trim()
  if (!origin) return false
  return PENDANT_ORIGINS.has(origin) || origin === String(record?.deviceId ?? '')
}

/**
 * Push one freshly stored approval to its origin. Best-effort by contract:
 * the record is already durable when this runs, and a push failure costs the
 * origin node its nudge, never the approval — the fallback surfaces still
 * list it. Never throws.
 */
export async function routeApprovalPrompt({ store, record, now = Date.now(), send = sendNodeMessage } = {}) {
  try {
    const route = await approvalPromptRoute({ store, record })
    if (route.channel !== 'mesh') {
      /*
       * 'pendant-speech' used to end here with "the next press will read it",
       * which was true and useless when the owner's conversation was OPEN at
       * that very moment — the plan they had just asked for by voice parked
       * in silence. So the queue is still the delivery (the record is durable
       * and the next press still speaks it), but if this device holds a live
       * converse socket in THIS isolate, nudge it to read the store now. Not
       * awaited past scheduling: the nudge hands the work to the session's
       * own serialised readback and returns, because a stored approval's 201
       * must not wait out seconds of paced audio. See converseSessions.js for
       * why a different isolate honestly reports no-live-session.
       */
      const live =
        route.channel === 'pendant-speech'
          ? nudgeConverseSession(route.to ?? record?.deviceId)
          : null
      return {
        channel: route.channel,
        to: route.to,
        pushed: false,
        /* 'queued' here means "a delivery mechanism will pick it up without
         * another write": the pendant speaks the store, the Mac surface polls
         * it. Only a mesh push has a separate act that can fail. */
        queued: true,
        /* Whether an open conversation was told to speak it immediately. */
        nudged: live?.nudged === true,
        why: route.why,
      }
    }

    const { summary, detail } = approvalPromptText(record)
    const expiresIn = Date.parse(record?.expiresAt ?? '') - now
    const outcome = await send({
      store,
      from: RELAY_NODE_ADDRESS,
      to: route.to,
      kind: APPROVAL_REQUEST_KIND,
      payload: {
        approvalId: record.approvalId,
        summary,
        detail,
        /* A short phrase, not the manifest's risk object: the card renderer
         * (shared/approvalMesh.js) prints this field verbatim, bounded to 40
         * chars, and "[object Object]" on an approval card would be worse
         * than nothing. */
        risk: riskLabelFor(record.risk),
        expiresAt: record.expiresAt ?? null,
      },
      /* The prompt dies with the approval. A nudge for a decision that can no
       * longer be taken is worse than none. */
      ttlMs: Math.min(Math.max(expiresIn, 60_000), MAX_TTL_MS),
      now,
    })
    return {
      channel: 'mesh',
      to: route.to,
      pushed: outcome.pushed,
      queued: outcome.queued,
      messageId: outcome.envelope?.id ?? null,
      why: route.why,
    }
  } catch (error) {
    console.warn(
      `[relay] approval prompt for ${record?.approvalId ?? 'unknown'} not pushed: ${error?.message || error}`,
    )
    return { channel: 'mesh', to: null, pushed: false, queued: false, error: String(error?.message ?? error) }
  }
}

/* --------------------------------------------------------------- deciding */

/**
 * One decision path for every surface. Idempotent by design: deciding an
 * approval that is already settled is a no-op with its own code, because the
 * mesh delivers at-least-once and a phone that retries a tap must not turn a
 * granted record into an error cascade.
 *
 * Codes:
 *   settled          — this call settled it; `state` is the new state
 *   already_settled  — somebody got there first; `state` says how it ended
 *   expired          — an approve arrived after expiry; settled as refused
 *   not_found        — no record under that id
 *   invalid_decision — the body named neither 'approve' nor 'deny'
 */
export async function decideApproval({
  store,
  approvalId,
  decision,
  decidedBy = 'owner',
  now = Date.now(),
} = {}) {
  const asked = String(decision ?? '').trim().toLowerCase()
  const settledDecision = asked === 'approve' ? 'granted' : asked === 'deny' ? 'denied' : null
  if (!settledDecision) {
    return {
      ok: false,
      code: 'invalid_decision',
      state: null,
      why: 'decision must be "approve" or "deny".',
    }
  }

  const record = await readApproval(store, approvalId)
  if (!record) {
    return { ok: false, code: 'not_found', state: null, why: 'No approval is stored under that id.' }
  }
  if (record.state !== 'pending') {
    return {
      ok: false,
      code: 'already_settled',
      noop: true,
      state: record.state,
      why: `This approval was already ${record.state}.`,
      approval: presentApproval(record),
    }
  }

  /*
   * A late "approve" is refused, not honoured: the TTL exists because the plan
   * described a world that moves. A late "deny" still lands as denied — a
   * refusal can never be wrong to record, and settling it stops the record
   * being resurrected by anything else.
   */
  if (settledDecision === 'granted' && !approvalIsLive(record, now)) {
    const settled = settleApproval(
      record,
      {
        decision: 'refused',
        reason: 'expired',
        why: `This approval expired at ${record.expiresAt} before anyone approved it. Prepare the plan again for a fresh window.`,
      },
      { now, decidedBy },
    )
    await saveApproval(store, settled, { now })
    return {
      ok: false,
      code: 'expired',
      state: settled.state,
      why: settled.refusal?.why ?? 'This approval expired before it was approved.',
      approval: presentApproval(settled),
    }
  }

  const outcome = await settleStoredApproval({
    store,
    approvalId,
    outcome: { decision: settledDecision, decidedBy },
    now,
  })
  if (!outcome.ok) {
    /* The read above raced another decision. Same answer as if we had lost by
     * a wider margin: somebody settled it, and here is how. */
    return {
      ok: false,
      code: outcome.reason === 'already-decided' ? 'already_settled' : outcome.reason ?? 'not_settled',
      noop: outcome.reason === 'already-decided',
      state: outcome.approval?.state ?? null,
      why: outcome.why ?? null,
      approval: presentApproval(outcome.approval),
    }
  }
  return {
    ok: true,
    code: 'settled',
    state: outcome.approval?.state ?? settledDecision,
    why: null,
    approval: presentApproval(outcome.approval),
  }
}

/**
 * The relay's half of the mesh decision exchange.
 *
 * Called by the node-mesh send route for mail addressed to '@relay'. Returns
 * `{consumed:false}` for kinds this module does not own (they queue exactly as
 * before), and ALWAYS consumes an approval decision — including a malformed or
 * unmatchable one — because an at-least-once queue would otherwise redeliver
 * the same undecidable envelope forever. The receipt carries the code instead.
 */
export async function consumeRelayApprovalMail({ store, envelope, now = Date.now() } = {}) {
  if (String(envelope?.kind ?? '') !== APPROVAL_DECISION_KIND) {
    return { consumed: false }
  }

  const payload = envelope?.payload ?? {}
  const result = await decideApproval({
    store,
    approvalId: payload.approvalId,
    decision: payload.decision,
    /* The sender's address, as stamped by the relay from its credential —
     * never from the payload. This is what `decidedBy` on the record means. */
    decidedBy: String(envelope?.from ?? 'mesh-node'),
    now,
  })

  const receipt = {
    kind: APPROVAL_DECISION_KIND,
    approvalId: String(payload.approvalId ?? '') || null,
    corr: envelope?.corr ?? null,
    ok: result.ok,
    code: result.code,
    state: result.state ?? null,
  }
  console.log(
    `[relay] approval decision from ${envelope?.from ?? '?'}: ${receipt.approvalId ?? 'no-id'} -> ${receipt.code}`,
  )
  return { consumed: true, receipt }
}

/* ------------------------------------------------------- pendant answers */

/**
 * Read one owner utterance against one spoken approval, settling only what a
 * yes or a no settles.
 *
 * This wraps answerApproval() with the gate that makes it safe to run on live
 * conversation transcripts: answerApproval settles ANY decisive-or-muddled
 * reading (an unclear answer becomes `refused`), which is right for a reply
 * addressed to the readback and wrong for the owner changing the subject —
 * "what's my battery" must not torch a pending approval. So ordinary speech
 * returns `not_an_answer` and touches nothing, a bare confirm-word echo gets
 * the repair line and stays pending, and only a real yes or no reaches the
 * graded machinery. A granted verdict is then settled here: delivery was
 * witnessed (the stream attested it, the echo proved the ear), so the record
 * may honestly say `granted` — running the plan remains the Mac's job.
 */
export async function answerSpokenApproval({ store, approvalId, utterance, now = Date.now() } = {}) {
  const record = await readApproval(store, approvalId)
  if (!record) return { settled: false, code: 'not_found', state: null, speak: null }
  if (record.state !== 'pending') {
    return { settled: false, code: 'already_settled', state: record.state, speak: null }
  }

  const heard = matchApprovalUtterance(utterance, {
    confirmWord: record.confirmWord ?? null,
    requiresConfirmWord: record.requiresConfirmWord ?? false,
  })

  if (heard.decision === 'unclear') {
    if (heard.matchedWord) {
      /* The word came back without an "approve": prompt for the missing half
       * and leave the record pending, so the retry the prompt invites can
       * still land. Handing this to answerApproval would settle it refused. */
      return {
        settled: false,
        code: 'confirm_word_alone',
        state: 'pending',
        heard,
        speak: `I heard ${heard.matchedWord}, but not an approval. Say "approve ${record.confirmWord}" to approve, or say cancel.`,
      }
    }
    /*
     * "Yes, go ahead" against a plan whose word is mandatory: an answer, just
     * an incomplete one. Detected by re-reading the utterance without the
     * word requirement — assent-shaped speech gets the repair; everything
     * else genuinely changed the subject.
     */
    const assent = matchApprovalUtterance(utterance, {
      confirmWord: record.confirmWord ?? null,
      requiresConfirmWord: false,
    })
    if (assent.decision === 'granted') {
      return {
        settled: false,
        code: 'needs_confirm_word',
        state: 'pending',
        heard,
        speak: record.confirmWord
          ? `This one needs its confirm word. Say "approve ${record.confirmWord}", or say cancel.`
          : heard.why,
      }
    }
    /* Not addressed to the readback at all. The owner moved on. */
    return { settled: false, code: 'not_an_answer', state: 'pending', heard, speak: null }
  }

  const result = await answerApproval({ store, approvalId, utterance, decidedBy: 'pendant', now })

  if (result.ok && result.decision === 'granted' && result.handOff) {
    const settled = await settleStoredApproval({
      store,
      approvalId,
      outcome: { decision: 'granted', decidedBy: 'pendant' },
      now,
    })
    return {
      settled: settled.ok,
      code: settled.ok ? 'granted' : settled.reason ?? 'not_settled',
      state: settled.approval?.state ?? 'granted',
      heard: result.heard ?? heard,
      speak: settled.ok ? 'Approved.' : null,
    }
  }

  if (result.decision === 'denied') {
    return {
      settled: true,
      code: 'denied',
      state: 'denied',
      heard: result.heard ?? heard,
      speak: 'Cancelled. Nothing will run.',
    }
  }

  /* Refusals: expired, replayed, not-delivered, or an unclear the machinery
   * itself found (a "yes" missing its required word). answerApproval already
   * settled what needed settling and wrote the repair line where one helps. */
  return {
    settled: !['not-delivered', 'unclear'].includes(result.reason ?? ''),
    code: result.reason ?? 'refused',
    state: result.approval?.state ?? null,
    heard: result.heard ?? heard,
    speak:
      result.speak ??
      (result.reason === 'expired'
        ? 'That approval expired while it waited. Ask again and I will prepare it fresh.'
        : null),
  }
}

/* ---------------------------------------------------------------- routes */

/**
 * The one decision route, mounted by cloud-relay/server.js after the auth
 * middleware. Scope: approval:decide (see relayScopes.js) — held by every
 * owner surface role, because origin controls the prompt, never the decision.
 */
export function registerApprovalDeliveryRoutes(app, { getStore }) {
  app.post('/v1/approvals/:approvalId/decision', async (request, response) => {
    const store = await getStore()
    const principal = request.relayPrincipal
    const decidedBy =
      principal?.kind === 'device'
        ? principal.deviceId
        : String(request.body?.decidedBy ?? '').trim() || 'owner'

    const result = await decideApproval({
      store,
      approvalId: request.params?.approvalId,
      decision: request.body?.decision,
      decidedBy,
    })

    const status =
      result.code === 'not_found'
        ? 404
        : result.code === 'invalid_decision'
          ? 400
          : result.code === 'already_settled'
            ? 409
            : result.code === 'expired'
              ? 410
              : 200
    response.status(status).json({
      ok: result.ok,
      code: result.code,
      state: result.state ?? null,
      why: result.why ?? null,
      approval: result.approval ?? null,
    })
  })

  return app
}
