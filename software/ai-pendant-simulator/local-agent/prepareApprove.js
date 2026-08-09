/*
 * The Mac half of "prepare this action on my Mac, and let me approve it from
 * the pendant when you're ready."
 *
 * Prepare writes a plan manifest and stops. Approve takes a decision that came
 * back from the pendant, re-checks everything that could have changed while the
 * owner was walking away from the desk, and hands the actions to the caller for
 * /execute. Neither function runs anything — this module has no business owning
 * execution, for the same reason actionLedgerRoutes.js says it does not: a
 * commit path that both decides and acts is a commit nobody can audit.
 *
 * THE SPLIT OF RESPONSIBILITY, which is the only interesting part:
 *
 *   the Mac holds the PLAN      — actionLedger.js, already durable on disk
 *   the relay holds the DECISION — shared/approvalHandoff.js, APPROVAL_STORE_CONTRACT
 *   the pendant holds the OWNER — the readback, and the word they say back
 *
 * and no two of them can commit without the third. The Mac cannot commit because
 * it has no pending record and will refuse a grant it cannot match to one. The
 * relay cannot commit because it has no actions and no filesystem to check them
 * against. The pendant cannot commit because it only ever says a word.
 *
 * WHY THE PENDING RECORD IS NOT KEPT HERE. The owner walks away; the Mac sleeps.
 * A pending approval in this process's memory is unreachable during exactly the
 * interval it exists for. So prepare() RETURNS the record and never stores it,
 * and approve() is handed it back rather than looking it up. That statelessness
 * is the feature.
 */
import {
  getLedger,
  ledgerLocation,
  openLedger,
  planKeyFor,
  presentLedger,
} from './actionLedger.js'
import { capturePreState } from './actionLedgerVerify.js'
import {
  APPROVAL_DEFAULT_TTL_MS,
  APPROVAL_STORE_CONTRACT,
  approvalIndexKey,
  approvalStateKey,
  attestApprovalDelivery,
  buildApprovalRequest,
  evaluateApprovalGrant,
  planDigestFor,
  presentApproval,
  settleApproval,
  worldFingerprintFor,
} from '../shared/approvalHandoff.js'

/*
 * WHAT THE PENDANT CAN ACTUALLY DO TODAY, written down where the feature lives
 * rather than only in a commit message.
 *
 * From cloud-relay/announce.js, which reads firmware/nrf9160/src/main.c: binary
 * downlink is dropped unless `convo_started` is set — i.e. unless the relay has
 * already answered a button press — and text downlink is matched with strstr()
 * against exactly "started", "flush" and "end". Nothing else is understood, and
 * a frame over 640 B closes the socket.
 *
 * So the pendant CANNOT be told that an approval is waiting. It finds out by
 * pressing the button for some other reason and hearing the readback first. The
 * TTL in shared/approvalHandoff.js is therefore racing a human habit, not a
 * network, and that is the honest shape of the feature until the firmware learns
 * an unprompted push.
 */
export const PENDANT_DELIVERY_REALITY = Object.freeze({
  worksToday: 'reply-audio',
  worksTodayNote:
    'The readback is spoken on the ordinary reply path, right after the relay answers a button press with {"type":"started"}. No firmware change is needed for this.',
  doesNotWorkToday: 'unprompted-push',
  doesNotWorkTodayNote:
    'The relay cannot tell the pendant an approval is waiting. Binary downlink is dropped unless convo_started is set, and text downlink is matched with strstr() against only "started", "flush" and "end".',
  firmwareWorkNeeded: Object.freeze([
    'Accept a text downlink frame outside a conversation and treat it as a wake reason, instead of ignoring every token that is not "started"/"flush"/"end".',
    'Allow binary downlink to open a conversation rather than requiring convo_started to already be set, so a readback can be spoken without the owner pressing first.',
    'Signal a waiting approval without audio — the LED or the haptic — so an unheard readback is visible rather than silently expiring.',
    'Raise or chunk around WS_RX_BUF_BYTES (640 B) if the wake frame ever needs to carry more than an id.',
  ]),
})

/* ------------------------------------------------------------- prepare */

/**
 * Write down what a plan intends to do, and build the decision that gates it.
 *
 * Nothing runs. `openLedger` fsyncs the manifest before returning, so the plan
 * survives this process dying between prepare and approve — which, given that
 * the owner is expected to walk away for half an hour, is the normal case rather
 * than the exceptional one.
 *
 * `actions` are returned unchanged alongside the manifest. The manifest's copy
 * has had secret parameters masked (persistableParams in actionLedger.js), which
 * is correct for a file on disk and useless for execution; a caller that intends
 * to commit later must keep these. See commitApproval() for how they are checked
 * back in.
 */
export function prepareAction({
  command = '',
  actions = [],
  deviceId = 'nrf9160-pendant',
  title = null,
  jobId = null,
  sessionId = null,
  source = 'prepare-approve',
  /*
   * The node the command came from, threaded into the approval record so the
   * relay can push the prompt back there instead of leaving it to whichever
   * dashboard happens to be open. Defaults to `source` because for every
   * caller today they are the same fact ('floating-hud', 'dashboard', a mesh
   * node's deviceId); the separate parameter exists for the caller whose
   * source label is not a routable origin.
   */
  origin = null,
  pendingCount = 1,
  ttlMs = APPROVAL_DEFAULT_TTL_MS,
  now = Date.now(),
  filePath = ledgerLocation(),
} = {}) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) throw new Error('A prepared action needs at least one action.')

  const manifest = openLedger({
    command,
    actions: list,
    jobId,
    sessionId,
    source,
    title,
    now,
    filePath,
  })

  const approval = buildApprovalRequest({
    manifest,
    deviceId,
    origin: origin ?? source,
    pendingCount,
    ttlMs,
    now,
  })

  return {
    ok: true,
    prepared: true,
    executed: false,
    approval,
    ledger: presentLedger(manifest),
    /* Handed back so the caller knows where to put it. This module does not talk
     * to the relay; the bridge does. */
    relay: {
      stateKey: approvalStateKey(approval.approvalId),
      indexKey: approvalIndexKey(approval.deviceId),
      contract: APPROVAL_STORE_CONTRACT,
    },
    delivery: PENDANT_DELIVERY_REALITY,
    /* The one sentence a reader of this response should not have to derive. */
    note: 'The manifest is on disk and the approval is pending. Nothing has run. The readback must be spoken to the pendant before any grant against it will be honoured.',
  }
}

/* --------------------------------------------------------------- world */

/**
 * Re-read, right now, the state of everything the plan was going to change.
 *
 * Same capture the manifest took at prepare time (capturePreState), folded by
 * the same function (worldFingerprintFor), so the two hashes are comparable by
 * construction rather than by a matching pair of hand-written walks that will
 * drift.
 *
 * `degraded` is the case that must not be misread as movement. A step whose
 * parameters were withheld as secret or shed to fit the byte budget has no path
 * left to re-read, so its fresh reading would differ from its recorded one for a
 * reason that has nothing to do with the world. Reporting that separately is
 * what keeps "we cannot check" from being announced to the owner as "someone
 * changed your files".
 */
export function currentWorldFingerprint(manifest, { now = Date.now() } = {}) {
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : []
  const degraded = []

  const rehydrated = steps.map((step) => {
    const hadObservableTarget = step?.preState && step.preState.kind !== 'unobservable'
    const lost = hadObservableTarget ? lostTargetParams(step) : null
    if (lost) {
      degraded.push({ seq: step.seq, stepKey: step.stepKey, why: lost })
      /* Keep the ORIGINAL reading rather than a fresh empty one: an unreadable
       * step must not contribute a spurious difference to the hash. It is
       * reported through `degraded` instead, and commitApproval refuses on it. */
      return step
    }
    return {
      ...step,
      preState: capturePreState({ type: step?.type, params: step?.params ?? {} }, { now }),
    }
  })

  return { ...worldFingerprintFor({ steps: rehydrated }), degraded }
}

/*
 * Which parameters capturePreState() actually navigates by. Only these matter
 * for re-reading the world; everything else in a step can be gone without
 * costing a verdict.
 */
const TARGET_PARAMS = {
  write_file: ['path'],
  delete_path: ['path'],
  move_path: ['from', 'to'],
  copy_path: ['from', 'to'],
}

/**
 * Why this step's target cannot be re-read, or null if it can be.
 *
 * THE DISTINCTION THIS DRAWS IS THE WHOLE POINT. `step.resumable === false` is
 * too blunt to use here: a write_file whose CONTENT was masked as secret is
 * unresumable — the bytes are genuinely lost — but its `path` is untouched, so
 * the world around it can still be checked perfectly well. Refusing that commit
 * as unverifiable would reject a plan we can in fact verify.
 *
 * What actually breaks the check is losing a parameter capturePreState()
 * navigates by. If `path` was the secret, the manifest holds a masked string, a
 * fresh reading of it describes a file that does not exist, and the fingerprint
 * would differ for a reason that has nothing to do with the world — which would
 * be reported to the owner as "someone changed your files". So the check is
 * against the target parameters by name, not against resumability.
 */
function lostTargetParams(step) {
  if (!step?.params || step.paramsElided) {
    return (
      step?.notResumableReason ??
      'This step has no parameters left in the manifest, so its target cannot be re-read.'
    )
  }

  const targets = TARGET_PARAMS[String(step.type ?? '')] ?? []
  const withheld = Array.isArray(step.withheldParams) ? step.withheldParams : []
  const lost = targets.filter((name) => withheld.includes(name))

  return lost.length
    ? `Its ${lost.join(' and ')} parameter(s) were withheld as secret, so the file this step names cannot be re-read to check whether it changed.`
    : null
}

/* -------------------------------------------------------------- commit */

const refusal = (reason, why, extra = {}) => ({
  ok: false,
  committed: false,
  executed: false,
  decision: 'refused',
  reason,
  why,
  ...extra,
})

/**
 * Recover the executable actions for a prepared plan.
 *
 * Two sources, and the caller-supplied one is checked against the manifest
 * rather than trusted. planKeyFor() hashes types and params, so a supplied list
 * that hashes to the manifest's planKey IS the list the manifest describes —
 * which lets a caller carry the un-redacted actions across the gap without the
 * approval becoming a channel for substituting a different plan.
 *
 * Falling back to the manifest's own copy works for ordinary plans and
 * deliberately fails for plans containing a credential: actionLedger.js masks
 * secret parameters on the way to disk, so those actions cannot be reconstructed
 * from it. That is a real limit of prepare/approve — a plan whose parameters are
 * secret must be committed by the process that still holds them — and it is
 * reported rather than papered over with a masked value that would execute
 * wrongly.
 */
export function actionsForCommit(manifest, supplied = null) {
  const steps = Array.isArray(manifest?.steps) ? manifest.steps : []

  if (Array.isArray(supplied) && supplied.length) {
    if (planKeyFor(supplied) !== manifest?.planKey) {
      return {
        ok: false,
        reason: 'plan-changed',
        why: 'The actions supplied for the commit do not hash to the plan that was prepared and read back.',
      }
    }
    return { ok: true, actions: supplied, source: 'supplied' }
  }

  const unreadable = steps.filter((step) => step?.resumable === false)
  if (unreadable.length) {
    return {
      ok: false,
      reason: 'plan-unreadable',
      why: `${unreadable.length} step(s) cannot be rebuilt from the manifest: ${unreadable
        .map((step) => step.notResumableReason ?? 'parameters are missing')
        .join(' ')} Supply the original actions with the commit, or prepare the plan again.`,
      steps: unreadable.map((step) => ({ seq: step.seq, stepKey: step.stepKey, type: step.type })),
    }
  }

  return {
    ok: true,
    source: 'manifest',
    actions: steps.map((step) => ({
      type: step.type,
      ...(step.label ? { label: step.label } : {}),
      params: step.params ?? {},
    })),
  }
}

/**
 * Honour or refuse a decision that came back from the pendant.
 *
 * Returns actions; runs none of them. The order of checks is the order in which
 * a refusal is most useful — can we still see the plan at all, is it still
 * readable, has the world moved, and only then what the owner actually said —
 * except that the utterance is evaluated inside evaluateApprovalGrant, which
 * puts liveness and delivery ahead of it for the same reason.
 *
 * WHY THE WORLD IS RE-READ HERE AND NOT ON THE RELAY. The relay has no
 * filesystem. A stale approval is refused by the only body that can actually
 * see whether it is stale, and evaluateApprovalGrant takes the fingerprint as a
 * parameter precisely so it cannot be quietly skipped by the body that cannot
 * compute one.
 */
export function commitApproval({
  approval = null,
  utterance = null,
  decision = null,
  actions = null,
  decidedBy = 'pendant',
  now = Date.now(),
  filePath = ledgerLocation(),
} = {}) {
  if (!approval?.approvalId || !approval?.ledgerId) {
    return refusal('not-found', 'No pending approval record was supplied with this commit.')
  }

  /*
   * THE UTTERANCE IS EVIDENCE BEFORE IT IS AN ANSWER.
   *
   * evaluateApprovalGrant() checks delivery before it reads what was said, and
   * on this system the only witness that a HUMAN heard the readback is the owner
   * saying back a word that nothing but the readback carried. Reading the answer
   * without first letting it stand as evidence would refuse every grant on a
   * precondition the same sentence had just satisfied — which is precisely the
   * shape the loop was stuck in.
   *
   * This is not a way around the delivery check, and it cannot become one. An
   * echo is refused outright unless the record already carries `spokenAt` from
   * the relay that streamed it; the confirm word is derived from the plan digest
   * and was never a secret, so an echo with no stream behind it proves only that
   * somebody holds the record. Both halves, or nothing.
   */
  const attested = attestApprovalDelivery(approval, {
    evidence: 'owner-echo',
    transcript: utterance,
    now,
  })
  const record = attested.ok ? attested.record : approval

  /*
   * The record's own checks first, before anything touches the disk.
   *
   * Two reasons, and the second is the one that matters. Cheapness is the
   * obvious one: an expired or already-answered approval should not cost a
   * filesystem walk and a pile of SHA-256s. The real reason is that A REFUSAL
   * MUST NOT DEPEND ON THE PLAN STILL BEING THERE. If the owner says "no" and
   * the manifest has since been pruned out of the bounded ledger store, the
   * answer is "you declined", not "I lost the plan" — reporting the latter would
   * leave a declined action looking like a system fault worth retrying.
   *
   * worldNow is deliberately omitted here; this pass decides only what can be
   * decided from the record itself, and the world is checked below once the
   * plan is in hand.
   */
  const liveness = evaluateApprovalGrant(record, { utterance, decision, decidedBy, now })
  if (!liveness.ok) {
    const settledEarly = settleApproval(record, liveness, { now, decidedBy })
    return {
      ok: false,
      committed: false,
      executed: false,
      decision: liveness.decision,
      reason: liveness.reason,
      why: liveness.why,
      heard: liveness.heard ?? null,
      approval: presentApproval(settledEarly),
    }
  }

  const manifest = getLedger(record.ledgerId, { filePath })
  if (!manifest) {
    return refusal(
      'plan-missing',
      `The manifest ${record.ledgerId} is no longer on this Mac. A bounded store drops the oldest records, so an approval can outlive the plan it names — refusing rather than guessing what it described.`,
      { approval: presentApproval(settleApproval(record, { decision: 'refused', reason: 'plan-missing' }, { now, decidedBy })) },
    )
  }

  const recovered = actionsForCommit(manifest, actions)
  if (!recovered.ok) {
    return refusal(recovered.reason, recovered.why, {
      steps: recovered.steps ?? null,
      approval: presentApproval(
        settleApproval(record, { decision: 'refused', reason: recovered.reason, why: recovered.why }, { now, decidedBy }),
      ),
    })
  }

  const world = currentWorldFingerprint(manifest, { now })
  if (world.degraded.length) {
    /* Not `world-moved`: nothing is known to have changed, we simply cannot
     * look. Saying "someone edited your file" when the truth is "we shredded the
     * parameter" would be the worse lie of the two. */
    return refusal(
      'world-unverifiable',
      `The world this plan was written against cannot be re-checked: ${world.degraded
        .map((entry) => entry.why)
        .join(' ')} Refusing a commit whose staleness cannot be established.`,
      { degraded: world.degraded },
    )
  }

  const verdict = evaluateApprovalGrant(record, {
    utterance,
    decision,
    decidedBy,
    /* Recomputed from the manifest as it is on disk NOW, so a manifest that was
     * altered between prepare and commit fails the digest check rather than
     * being read back into a grant that named the old one. The digest covers the
     * fields the readback was BUILT from, so a mismatch means the sentence the
     * owner heard no longer describes this plan. */
    planDigest: planDigestFor(manifest),
    worldNow: { hash: world.hash, observedSteps: world.observedSteps, blindSteps: world.blindSteps },
    now,
  })

  const settled = settleApproval(record, verdict, { now, decidedBy })

  if (!verdict.ok) {
    return {
      ok: false,
      committed: false,
      executed: false,
      decision: verdict.decision,
      reason: verdict.reason,
      why: verdict.why,
      heard: verdict.heard ?? null,
      approval: presentApproval(settled),
    }
  }

  return {
    ok: true,
    committed: true,
    /* The word that keeps this module honest. A commit produces actions; it does
     * not perform them. Hand `actions` to /execute. */
    executed: false,
    decision: 'granted',
    why: verdict.why,
    heard: verdict.heard ?? null,
    approval: presentApproval({ ...settled, committedAt: new Date(now).toISOString() }),
    ledgerId: manifest.ledgerId,
    actionsFrom: recovered.source,
    actions: recovered.actions,
    /* Carried forward so the caller can attach the ledger's step observer to the
     * run rather than opening a second manifest for the same plan. */
    ledger: presentLedger(manifest),
    verified: {
      observedSteps: world.observedSteps,
      /* Repeated at the commit boundary on purpose. The world check is partial
       * by construction, and a caller that logs "verified" should be able to see
       * how much of the plan nothing could vouch for. */
      blindSteps: world.blindSteps,
      note: world.blindSteps
        ? `${world.blindSteps} step(s) leave no local state to compare, so nothing could confirm the world around them is unchanged.`
        : 'Every step in this plan had an observable target and all of them still match.',
      /* WHICH WITNESS VOUCHED FOR THE CONSENT, carried out with the commit for
       * the same reason blindSteps is: a caller writing "the owner approved this"
       * into a receipt should be able to see what that claim actually rests on. */
      delivery: {
        state: settled.deliveryState ?? 'undelivered',
        spokenAt: settled.spokenAt ?? null,
        deliveredAt: settled.deliveredAt ?? null,
        evidence: Array.isArray(settled.deliveryEvidence) ? settled.deliveryEvidence : [],
      },
    },
  }
}

/* -------------------------------------------------------------- routes */

/**
 * HTTP, as a registration function.
 *
 * A function rather than route definitions in server.js because server.js is a
 * large shared surface several people are editing at once — the same reasoning
 * registerActionLedgerRoutes() gives. Wire it with:
 *
 *     registerPrepareApproveRoutes(app)
 *
 * NEITHER ROUTE EXECUTES. POST /prepare writes a manifest and a pending
 * approval; POST /approve returns actions for /execute or a refusal. If you are
 * here to make /approve run the plan, put that call in server.js next to
 * /execute where the abort controller, the job tracker and the focus coordinator
 * already live.
 */
export function registerPrepareApproveRoutes(app, { filePath = ledgerLocation() } = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerPrepareApproveRoutes requires an Express-style app.')
  }

  app.post('/prepare', (request, response) => {
    const actions = Array.isArray(request.body?.actions) ? request.body.actions : []
    if (!actions.length) {
      response.status(400).json({ ok: false, error: 'No actions provided.' })
      return
    }

    try {
      response.status(201).json(
        prepareAction({
          command: String(request.body?.command ?? ''),
          actions,
          deviceId: String(request.body?.deviceId ?? '').trim() || 'nrf9160-pendant',
          title: request.body?.title ?? null,
          jobId: request.body?.jobId ?? null,
          sessionId: String(request.body?.sessionId ?? '').trim() || null,
          /* The job's source doubles as the origin unless the caller names one
           * explicitly — same defaulting as prepareAction itself. */
          source: String(request.body?.source ?? '').trim() || 'prepare-approve',
          origin: request.body?.origin ?? null,
          pendingCount: Number(request.body?.pendingCount ?? 1),
          ttlMs: request.body?.ttlMs ?? APPROVAL_DEFAULT_TTL_MS,
          filePath,
        }),
      )
    } catch (error) {
      response.status(400).json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  /*
   * Is this prepared plan still committable? GET, because asking is not doing.
   *
   * The relay uses this to avoid spending a button press reading out a readback
   * for a plan that is already stale — the owner hearing "ready to delete X" for
   * a file that changed ten minutes ago is worse than hearing nothing, because
   * they would approve it.
   */
  app.get('/prepare/:ledgerId/world', (request, response) => {
    const manifest = getLedger(String(request.params?.ledgerId ?? ''), { filePath })
    if (!manifest) {
      response.status(404).json({ ok: false, error: 'Ledger not found.' })
      return
    }
    const world = currentWorldFingerprint(manifest)
    const before = worldFingerprintFor(manifest)
    response.json({
      ok: true,
      readOnly: true,
      ledgerId: manifest.ledgerId,
      matches: world.hash === before.hash && world.degraded.length === 0,
      before,
      now: world,
      note: world.blindSteps
        ? `${world.blindSteps} step(s) leave no local state to compare; a match here means the observable part is unchanged, not that nothing changed.`
        : 'Every step in this plan has an observable target.',
    })
  })

  app.post('/approve', (request, response) => {
    const result = commitApproval({
      approval: request.body?.approval ?? null,
      utterance: request.body?.utterance ?? null,
      decision: request.body?.decision ?? null,
      actions: Array.isArray(request.body?.actions) ? request.body.actions : null,
      decidedBy: String(request.body?.decidedBy ?? 'pendant'),
      filePath,
    })

    /*
     * A refusal is a 200, not a 4xx.
     *
     * "The world moved" and "you said no" are correct, expected outcomes of a
     * working approval, and every one of them carries a `why` written to be read
     * out loud. Returning them as errors invites a caller to treat them as
     * transport failures and retry, and a retried commit against a moved world
     * is the accident this whole path exists to prevent. Only a malformed
     * request is a 400.
     */
    if (!result.ok && result.reason === 'not-found') {
      response.status(400).json(result)
      return
    }
    response.json({ ...result, delivery: PENDANT_DELIVERY_REALITY })
  })

  return app
}
