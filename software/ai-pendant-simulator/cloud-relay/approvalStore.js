/*
 * APPROVAL_STORE_CONTRACT, as calls instead of as prose.
 *
 * shared/approvalHandoff.js ends with a frozen object listing the store calls a
 * pending approval needs — `getState(approvalStateKey(id))`, `saveState(...)` —
 * written as STRINGS. That is a design note, and for a while it was the only
 * thing standing where an implementation should have been: nothing wrote a
 * record, nothing read one back, and nothing ever set `deliveredAt`. Since
 * evaluateApprovalGrant() refuses any grant whose `deliveredAt` is null, the
 * whole prepare/approve loop could be prepared, spoken and answered, and never
 * once completed. This file is the missing half.
 *
 * IT ADDS NO STORE METHODS, which is what the contract promised. Everything here
 * is the existing saveState/getState pair on cloud-relay/store — present on both
 * the D1 and the memory implementation — so the store modules are untouched.
 *
 * WHAT IT REFUSES TO DO. It does not decide. The relay has no filesystem, so it
 * cannot see whether the world the plan was written against has moved, and
 * evaluateApprovalGrant() takes that fingerprint as a parameter precisely so the
 * body that cannot compute one cannot skip it. This file therefore takes an
 * answer, attests what can be attested about delivery, settles refusals and
 * denials — which need no filesystem — and hands a GRANT onward to the Mac to
 * finish. A relay that settled grants itself would be the one place the whole
 * mechanism could be bypassed, and it would also poison the Mac's commit: a
 * record already marked `granted` comes back from evaluateApprovalGrant() as
 * `already-decided`.
 */
import {
  approvalIndexKey,
  approvalIsLive,
  approvalStateKey,
  attestApprovalDelivery,
  approvalSpeech,
  deliveryRepairSpeech,
  evaluateApprovalGrant,
  indexApproval,
  matchApprovalUtterance,
  presentApproval,
  selectApprovalToSpeak,
  settleApproval,
} from '../shared/approvalHandoff.js'
import { getStore as defaultGetStore } from './store/index.js'

const WRITER = 'approval-store'

/*
 * A store row is `{ stateKey, revision, updatedAt, updatedBy, data }` on both
 * implementations, so the record is always one hop in. Anything else in that
 * slot — a half-written row, a key reused by something else — reads as absent
 * rather than as an approval, because a malformed record with no `approvalId`
 * would otherwise sail through the delivery check on `undefined`.
 */
function unwrap(row) {
  const data = row?.data ?? null
  return data && typeof data === 'object' && data.approvalId ? data : null
}

/* ------------------------------------------------------------ the rows */

export async function readApproval(store, approvalId) {
  const id = String(approvalId ?? '').trim()
  if (!id) return null
  return unwrap(await store.getState(approvalStateKey(id)))
}

/**
 * Write a record and keep the device's index in step.
 *
 * The index is written SECOND on purpose. getState is key-addressed and cannot
 * scan, so the index is the only way to find a device's approvals — and a crash
 * between the two writes should leave an unindexed record (invisible, harmless,
 * expires on its own) rather than an indexed id pointing at nothing, which every
 * later read would have to defend against.
 */
export async function saveApproval(store, record, { updatedBy = WRITER, now = Date.now() } = {}) {
  if (!record?.approvalId) throw new Error('An approval record needs an approvalId before it can be stored.')

  await store.saveState(approvalStateKey(record.approvalId), record, { updatedBy })

  const indexKey = approvalIndexKey(record.deviceId)
  const current = (await store.getState(indexKey))?.data ?? null
  await store.saveState(indexKey, indexApproval(current, record, { now }), { updatedBy })

  return record
}

/**
 * Read every approval a device still has, oldest first.
 *
 * Entries whose row has gone — the store dropped it, the key was never written —
 * are skipped rather than reported as an error. A bounded store losing the tail
 * of an index is ordinary, and it must not make the live approvals unreadable.
 */
export async function listApprovals(store, deviceId, { now = Date.now(), liveOnly = false } = {}) {
  const index = (await store.getState(approvalIndexKey(deviceId)))?.data ?? null
  const entries = Array.isArray(index?.entries) ? index.entries : []

  const records = []
  for (const entry of entries) {
    const record = await readApproval(store, entry?.approvalId)
    if (!record) continue
    if (liveOnly && !approvalIsLive(record, now)) continue
    records.push(record)
  }

  return records.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
}

/*
 * Read, change, write. There is no compare-and-swap on the store — saveState
 * bumps a revision but will not refuse a stale write — so the read is repeated
 * inside this helper rather than trusting whatever the caller was holding. That
 * closes the window that matters here: a delivery attestation racing an answer
 * must not drop the other's field.
 */
async function mutateApproval(store, approvalId, change, { updatedBy = WRITER, now = Date.now() } = {}) {
  const current = await readApproval(store, approvalId)
  if (!current) return { ok: false, reason: 'not-found', why: 'No approval is stored under that id.', approval: null }

  const outcome = change(current)
  if (!outcome.ok) return { ...outcome, approval: current }

  await saveApproval(store, outcome.record, { updatedBy, now })
  return { ...outcome, approval: outcome.record }
}

/* ---------------------------------------------------------- delivery */

/**
 * Speak the next waiting readback, and record what the speaking actually
 * witnessed.
 *
 * `speak` is injected and returns whatever it managed: `{ sentBytes, totalBytes,
 * stopped }`, the same shape streamAnnouncementPcm() already returns, so the
 * converse path can hand its result straight through without inventing a number.
 *
 * FAILING CLOSED IS THE WHOLE JOB HERE. A `speak` that throws, returns nothing,
 * or reports zero bytes leaves the record exactly as it was — still pending,
 * still deliverable on the next button press. There is no branch in this function
 * that reaches `deliveredAt`, and there cannot be: streaming is witnessed by a
 * socket, and a socket is not an ear.
 */
export async function speakNextApproval({ store, deviceId, speak, now = Date.now() } = {}) {
  const records = await listApprovals(store, deviceId, { now })
  const chosen = selectApprovalToSpeak(records, { deviceId, now })
  if (!chosen.approval) return { spoke: false, reason: 'nothing-waiting', approval: null, waiting: 0 }

  const speech = chosen.speech ?? approvalSpeech(chosen.approval)

  let delivery = null
  try {
    delivery = await speak({ approval: chosen.approval, speech, waiting: chosen.waiting })
  } catch (error) {
    /* An outage is not a delivery. Left pending deliberately — the alternative is
     * an approval that silently expires having never been read out. */
    return {
      spoke: false,
      reason: 'speak-failed',
      why: String(error?.message ?? error),
      approval: presentApproval(chosen.approval),
      waiting: chosen.waiting,
    }
  }

  const attested = await mutateApproval(
    store,
    chosen.approval.approvalId,
    (record) =>
      attestApprovalDelivery(record, {
        evidence: 'stream-complete',
        sentBytes: delivery?.sentBytes ?? 0,
        totalBytes: delivery?.totalBytes ?? 0,
        stopped: Boolean(delivery?.stopped),
        path: delivery?.path ?? 'reply-audio',
        now,
      }),
    { now },
  )

  return {
    spoke: attested.ok,
    reason: attested.ok ? null : attested.reason,
    why: attested.why ?? null,
    /* Said plainly because it is the thing a reader will otherwise assume wrong:
     * the readback went out, and that is not yet consent. */
    note: attested.ok
      ? 'The readback was streamed. This is not delivery — nothing yet witnesses that the owner heard it.'
      : null,
    evidence: attested.evidence ?? null,
    speech,
    approval: presentApproval(attested.approval),
    waiting: chosen.waiting,
  }
}

/* ------------------------------------------------------------ answers */

/**
 * Take what the owner said, and get as far as the relay honestly can.
 *
 * The order is not decoration. Delivery is attested FIRST, from the transcript,
 * because the transcript is the only thing on this system that witnesses a human
 * having heard the readback — and evaluateApprovalGrant() checks delivery before
 * it reads the answer. Attesting afterwards would refuse every grant on a
 * precondition the very same utterance had just satisfied.
 *
 * Three outcomes:
 *   denied    — settled here and done. A refusal needs no filesystem.
 *   refused   — settled here: expired, replayed, or answered without a witness.
 *   granted   — NOT settled. Returned with `handOff: true` for the Mac's
 *               /approve, which is the only body that can check the world.
 */
export async function answerApproval({
  store,
  approvalId,
  utterance = null,
  decidedBy = 'pendant',
  now = Date.now(),
} = {}) {
  const record = await readApproval(store, approvalId)
  if (!record) {
    return { ok: false, decision: 'refused', reason: 'not-found', why: 'No approval is stored under that id.', approval: null }
  }

  /* Attempted, not asserted. A transcript with no confirm word in it leaves the
   * record untouched and the grant will be refused below with the repair line. */
  const attested = attestApprovalDelivery(record, { evidence: 'owner-echo', transcript: utterance, now })
  const heardOn = attested.ok ? attested.record : record
  if (attested.ok) await saveApproval(store, heardOn, { now })

  const verdict = evaluateApprovalGrant(heardOn, { utterance, decidedBy, now })

  if (verdict.ok) {
    /*
     * Deliberately not settled. The relay has no filesystem and cannot run the
     * world check; settling here would mark the record `granted` and the Mac's
     * own evaluateApprovalGrant() would then refuse it as `already-decided`,
     * which is how a "helpful" write on this side would quietly break the commit.
     */
    return {
      ok: true,
      decision: 'granted',
      reason: null,
      why: verdict.why,
      handOff: true,
      note: 'The relay cannot commit. POST this record and the utterance to the Mac /approve, then settle it with settleApproval().',
      heard: verdict.heard ?? null,
      approval: presentApproval(heardOn),
    }
  }

  const settled = settleApproval(heardOn, verdict, { now, decidedBy })
  if (settled !== heardOn) await saveApproval(store, settled, { now })

  return {
    ok: false,
    decision: verdict.decision,
    reason: verdict.reason,
    why: verdict.why,
    handOff: false,
    /*
     * What to say next, when there is something worth saying.
     *
     * Both of these are recoverable by one more sentence, and they are the two
     * outcomes where the owner is standing there waiting: the answer was muddled,
     * or nothing witnessed that they heard the readback. An expiry or a replay is
     * not repaired by talking, so those get nothing rather than a placeholder.
     */
    speak:
      verdict.reason === 'not-delivered'
        ? deliveryRepairSpeech(heardOn)
        : verdict.reason === 'unclear'
          ? verdict.why
          : null,
    heard: verdict.heard ?? matchApprovalUtterance(utterance, {
      confirmWord: heardOn.confirmWord ?? null,
      requiresConfirmWord: heardOn.requiresConfirmWord ?? false,
    }),
    approval: presentApproval(settled),
  }
}

/**
 * Write back the outcome the Mac reached.
 *
 * The Mac is stateless by design — commitApproval() is handed the record rather
 * than looking it up — so the durable copy only learns what happened if somebody
 * tells it. Without this the same approval could be committed twice: the replay
 * guard lives in `state`, and `state` lives here.
 *
 * Only the decision fields are taken across. The delivery fields stay whatever
 * this side attested, because delivery was witnessed here and a record round
 * -tripped through an HTTP body is not a witness to anything.
 */
export async function settleStoredApproval({ store, approvalId, outcome, now = Date.now() } = {}) {
  return mutateApproval(
    store,
    approvalId,
    (record) => {
      if (record.state !== 'pending') {
        return { ok: false, reason: 'already-decided', why: `This approval was already ${record.state}.` }
      }
      const decision = String(outcome?.decision ?? '')
      if (!decision) return { ok: false, reason: 'no-decision', why: 'The outcome carried no decision to record.' }

      return {
        ok: true,
        reason: null,
        why: outcome?.why ?? null,
        record: {
          ...record,
          state: decision === 'granted' ? 'granted' : decision === 'denied' ? 'denied' : 'refused',
          decision,
          decidedAt: outcome?.decidedAt ?? new Date(now).toISOString(),
          decidedBy: outcome?.decidedBy ?? 'pendant',
          refusal: decision === 'granted' ? null : { reason: outcome?.reason ?? 'unknown', why: outcome?.why ?? null },
          committedAt: outcome?.committedAt ?? (decision === 'granted' ? new Date(now).toISOString() : null),
        },
      }
    },
    { now },
  )
}

/* ------------------------------------------------------------- routes */

/**
 * HTTP, as a registration function.
 *
 * cloud-relay/server.js is a large shared surface several people are editing at
 * once, so this is handed over as one call to add rather than a block to merge:
 *
 *     registerApprovalRoutes(app)
 *
 * NO ROUTE HERE COMMITS ANYTHING. /answer can settle a denial or a refusal,
 * because neither needs to look at a filesystem; a grant is returned for the Mac
 * to finish and comes back through /settle.
 */
export function registerApprovalRoutes(app, { getStore = defaultGetStore } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerApprovalRoutes requires an Express-style app.')
  }

  /* The Mac's /prepare hands the record here. The relay holds the decision. */
  app.post('/v1/approvals', async (request, response) => {
    const record = request.body?.approval ?? null
    if (!record?.approvalId || !record?.ledgerId) {
      response.status(400).json({ ok: false, error: 'An approval record with an approvalId and a ledgerId is required.' })
      return
    }
    if (record.deliveredAt || record.spokenAt) {
      /*
       * Delivery is witnessed on this side and nowhere else. A record arriving
       * over HTTP already claiming to have been heard is the exact forgery the
       * delivery check exists to stop, so it is rejected rather than normalised.
       */
      response.status(400).json({
        ok: false,
        error: 'A newly prepared approval cannot already claim delivery. Delivery is attested by the relay that spoke it.',
      })
      return
    }

    try {
      const store = await getStore()
      await saveApproval(store, record)
      response.status(201).json({ ok: true, approval: presentApproval(record) })
    } catch (error) {
      response.status(400).json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  /* What is waiting, and which one would be read out next. Asking is not doing. */
  app.get('/v1/approvals', async (request, response) => {
    const store = await getStore()
    const deviceId = String(request.query?.deviceId ?? '').trim() || 'nrf9160-pendant'
    const records = await listApprovals(store, deviceId)
    const next = selectApprovalToSpeak(records, { deviceId })
    response.json({
      ok: true,
      readOnly: true,
      deviceId,
      approvals: records.map((record) => presentApproval(record)),
      next: next.approval ? { approval: presentApproval(next.approval), speech: next.speech } : null,
      waiting: next.waiting,
    })
  })

  app.get('/v1/approvals/:approvalId', async (request, response) => {
    const store = await getStore()
    const record = await readApproval(store, request.params?.approvalId)
    if (!record) {
      response.status(404).json({ ok: false, error: 'Approval not found.' })
      return
    }
    response.json({ ok: true, approval: presentApproval(record) })
  })

  /*
   * What the speaking witnessed. Byte counts, not a boolean — the grade is
   * derived from them, so a caller cannot talk its way up the ladder.
   */
  app.post('/v1/approvals/:approvalId/spoken', async (request, response) => {
    const store = await getStore()
    const result = await mutateApproval(store, request.params?.approvalId, (record) =>
      attestApprovalDelivery(record, {
        evidence: String(request.body?.evidence ?? 'stream-complete'),
        sentBytes: Number(request.body?.sentBytes ?? 0),
        totalBytes: Number(request.body?.totalBytes ?? 0),
        stopped: Boolean(request.body?.stopped),
        path: request.body?.path ?? 'reply-audio',
      }),
    )

    if (!result.ok && result.reason === 'not-found') {
      response.status(404).json({ ok: false, error: result.why })
      return
    }
    response.json({
      ok: result.ok,
      reason: result.reason ?? null,
      why: result.why ?? null,
      evidence: result.evidence ?? null,
      approval: presentApproval(result.approval),
    })
  })

  app.post('/v1/approvals/:approvalId/answer', async (request, response) => {
    const store = await getStore()
    const result = await answerApproval({
      store,
      approvalId: request.params?.approvalId,
      utterance: request.body?.utterance ?? null,
      decidedBy: String(request.body?.decidedBy ?? 'pendant'),
    })

    if (result.reason === 'not-found') {
      response.status(404).json({ ok: false, error: result.why })
      return
    }
    /*
     * A refusal is a 200. "You said no" and "nothing witnesses that you heard
     * it" are correct outcomes of a working approval, and every one of them
     * carries a line written to be read out loud. Returned as errors they invite
     * a retry, and a retried commit is the accident this path exists to prevent.
     */
    response.json(result)
  })

  app.post('/v1/approvals/:approvalId/settle', async (request, response) => {
    const store = await getStore()
    const result = await settleStoredApproval({
      store,
      approvalId: request.params?.approvalId,
      outcome: request.body?.outcome ?? request.body ?? null,
    })

    if (!result.ok && result.reason === 'not-found') {
      response.status(404).json({ ok: false, error: result.why })
      return
    }
    response.json({
      ok: result.ok,
      reason: result.reason ?? null,
      why: result.why ?? null,
      approval: presentApproval(result.approval),
    })
  })

  return app
}
