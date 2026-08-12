/*
 * The PAGE-SIDE fallback engine.
 *
 * WHY THIS EXISTS, measured live on 2026-08-12 (owner's Safari, macOS 26):
 * Safari would not evaluate this extension's background content AT ALL — not
 * as a service_worker, not as a background.scripts page (1.7.4) — across
 * relaunches, a State.plist cache reset, and a full extension re-registration.
 * The bundle itself is proven clean: it evaluates in node AND in jsc, and the
 * installed appex's bytes hash-match the build. The popup document, meanwhile,
 * ALWAYS runs, and extension pages fetch loopback fine. So on this Safari the
 * background is unreliable in ways outside our control, and the extension
 * pages must be able to carry the load themselves.
 *
 * Stage 1 (shipped 1.7.5): pairing. The popup gives the worker one bounded
 * chance to answer 'pair:run'; when nothing answers, the popup performs the
 * /pair/browser exchange itself under the SAME storage contract the worker
 * uses (pairStoragePatch → storage.local, session sentinel, escrow,
 * PAIR_OUTCOME_KEY), so everything that renders pairing state keeps working
 * unchanged.
 *
 * The decisions are pure functions; the one effectful step (runDirectPairing)
 * takes `api` and `fetchImpl` as parameters so node tests can drive the whole
 * exchange against fakes.
 */
import {
  PAIR_OUTCOME_KEY,
  normalizePairLifetime,
  pairOutcomeRecord,
  pairRequest,
  pairStoragePatch,
  shouldEscrow,
} from './pairing.js'

/*
 * How long the popup waits for the worker to answer 'pair:run' before pairing
 * from the page itself. Generous enough for a healthy worker to at least
 * ACCEPT the message (its fetch takes longer, but acceptance resolves nothing
 * — Safari resolves sendMessage with undefined immediately when no listener
 * evaluated), tight enough that the owner is not left staring at "Pairing…"
 * while a dead background says nothing.
 */
export const PAIR_REPLY_TIMEOUT_MS = 2_500

/**
 * Should the POPUP run the pairing exchange itself?
 *
 * Inputs are the three ways the 'pair:run' send can end plus what storage
 * already says:
 *   - `failed`: sendMessage threw (Chromium's "receiving end does not exist").
 *   - `replied` with a real reply object: the worker is alive and answered —
 *     its answer narrates, the page must NOT double-run.
 *   - `replied` with undefined/null, or the wait timed out: EITHER the worker
 *     never evaluated (tonight's Safari) OR it is alive and Safari dropped the
 *     async reply (the 2026-08-12 war story). The tiebreaker is the outcome
 *     record: a PAIR_OUTCOME_KEY stamped at/after this attempt started means
 *     the worker acted, reply or no reply.
 *
 * Running direct when the worker is merely slow is deliberately accepted: the
 * pairing code is a static owner secret (not single-use — the agent compares
 * it timing-safe against PAIRING_CODE), so a second exchange just re-mints the
 * same device's credential and the later storage write wins. The one hazard —
 * a direct FAILURE overwriting the worker's later SUCCESS — is what
 * directOutcomeWritePlan guards.
 */
export function pairFallbackVerdict({
  failed = false,
  replied = false,
  reply = null,
  outcome = null,
  startedAt = 0,
} = {}) {
  if (replied && reply !== undefined && reply !== null) {
    return { run: false, why: 'worker-answered' }
  }
  if (outcome && Number(outcome.at ?? 0) >= startedAt) {
    return { run: false, why: 'worker-outcome-landed' }
  }
  return { run: true, why: failed ? 'send-failed' : 'no-reply' }
}

/**
 * May this direct outcome be written under PAIR_OUTCOME_KEY?
 *
 * One rule: a failure must never bury a success from the same attempt. If the
 * worker (alive after all, reply dropped) already recorded a fresh success,
 * the page's own failed fetch — most likely a second exchange racing it — is
 * noise, and writing it would flip the popup from "Paired." to an error the
 * owner has no reason to see. Everything else writes: the record is the one
 * channel renderPairOutcome trusts.
 */
export function directOutcomeWritePlan({ existing, startedAt, outcome, now = Date.now() } = {}) {
  if (
    existing &&
    existing.ok === true &&
    Number(existing.at ?? 0) >= startedAt &&
    !outcome?.ok
  ) {
    return { write: false, record: existing, reason: 'a fresher success already landed' }
  }
  return { write: true, record: pairOutcomeRecord(outcome, now) }
}

/* Best-effort escrow, same contract as the worker's escrowStorePairing: the
 * Safari wrapper app keeps a copy the next extension update cannot wipe.
 * Chromium has no native host — the try/catch turns that into a no-op. */
async function escrowStore(api, values) {
  if (typeof api?.runtime?.sendNativeMessage !== 'function') return
  try {
    await api.runtime.sendNativeMessage('application.id', { type: 'escrow:store', values })
  } catch {
    /* No native host in this browser; the pairing itself already succeeded. */
  }
}

/**
 * The pairing exchange, run from THIS document — the worker's 'pair:run' body
 * under the identical storage contract, for the Safari where no worker runs.
 *
 * Order of writes mirrors background.js exactly:
 *   1. session sentinel BEFORE the credentials (no instant where a session
 *      credential exists that a crash would promote to forever),
 *   2. the credential patch into storage.local (this is what restarts both
 *      peers' loops whenever a worker IS alive to watch storage),
 *   3. drop any synced copy of an old token,
 *   4. escrow (never for session-only — shouldEscrow),
 *   5. the outcome record, guarded by directOutcomeWritePlan.
 *
 * Returns the outcome record that now stands (written or kept), shaped for
 * renderPairOutcome.
 */
export async function runDirectPairing(
  api,
  { agentUrl, code, deviceId, deviceName, lifetime, startedAt = 0 },
  fetchImpl = globalThis.fetch,
) {
  const chosen = normalizePairLifetime(lifetime)
  const request = pairRequest(agentUrl, { code, deviceId, deviceName, lifetime: chosen })
  const origin = request ? new URL(request.url).origin : ''
  let outcome

  try {
    if (!request) throw new Error('No agent URL to pair against.')
    const response = await fetchImpl(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(20_000),
    })
    const payload = await response.json().catch(() => null)
    outcome = pairStoragePatch(
      payload ?? {
        ok: false,
        error: `The agent returned HTTP ${response.status} with no body.`,
      },
      { agentUrl: origin, lifetime: chosen },
    )

    if (outcome.ok) {
      if (chosen === 'session' && api.storage.session) {
        await api.storage.session.set({ pairSessionAlive: true })
      }
      await api.storage.local.set(outcome.values)
      if (api.storage.sync) {
        await api.storage.sync.remove('agentToken').catch?.(() => {})
      }
      if (shouldEscrow(chosen)) {
        await escrowStore(api, outcome.values)
      }
    }
  } catch (error) {
    outcome = {
      ok: false,
      error:
        error?.name === 'TimeoutError'
          ? 'The agent did not answer within 20s. Is it running on this Mac?'
          : error?.message || String(error),
    }
  }

  const stored = await api.storage.local.get(PAIR_OUTCOME_KEY).catch(() => ({}))
  const plan = directOutcomeWritePlan({
    existing: stored?.[PAIR_OUTCOME_KEY],
    startedAt,
    outcome,
  })
  if (plan.write) {
    await api.storage.local.set({ [PAIR_OUTCOME_KEY]: plan.record }).catch(() => {})
  }
  return plan.record
}
