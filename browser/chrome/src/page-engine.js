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
import { createCommandLedger, retryDelay } from './bridge-core.js'
import {
  MAC_FRESH_MS,
  choosePeer,
  describeRelayFailure,
  describeRelayPeer,
} from './relay-peer.js'
import {
  HEARTBEAT_INTERVAL_MS,
  POLL_INTERVAL_MS,
  delay,
  getConfig,
  heartbeat,
  pollOnce,
  updateStatus,
  updateRelayStatus,
} from './executor.js'
import {
  createMeshSocket,
  decideApproval,
  decidePlan,
  drainRelayUntilEmpty,
  getRelayConfig,
  handleConsoleSubmit,
} from './console-engine.js'

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

/* ===================================================================== *
 * Stage 2: the full page engine — dead-background verdict, the single-flight
 * lease, and the loops themselves (agent bridge + relay doorbell), composed
 * from the SAME shared modules the background runs (executor.js,
 * console-engine.js). Identity parity is inherited, not reimplemented: the
 * agent heartbeat uses getConfig()'s stored-instanceId extensionId and the
 * relay uses getRelayConfig()'s stored relayDeviceId, so the fleet map and
 * /browser/status light up the same node whichever engine is alive.
 * ===================================================================== */

/*
 * DEAD-BACKGROUND DETECTION. The popup pings {type:'bridge:poll-now'} on
 * boot; a live worker answers AND freshens bridgeStatus.updatedAt within a
 * couple of seconds (every pollWindow path writes status early — connected,
 * offline, needs-setup all do). This is how long the popup waits after the
 * ping before comparing timestamps.
 */
export const BACKGROUND_CHECK_WAIT_MS = 2_500

/* How fresh bridgeStatus.updatedAt must be to count as "someone is writing
 * it". Above the worker's own 12 s heartbeat/status cadence would be wrong —
 * the WAIT is what freshens it; this only needs to absorb clock jitter and a
 * slow storage round trip. */
export const STATUS_FRESH_MS = 8_000

/**
 * Is the background dead, from what the boot ping observed?
 *
 * Three ways to prove life, any one suffices:
 *   1. The ping RESOLVED with a real reply — only an evaluated worker can
 *      answer. (Tonight's Safari resolves `undefined` without evaluating
 *      anything, which proves nothing either way.)
 *   2. bridgeStatus.updatedAt CHANGED between the ping and the check — the
 *      worker woke and wrote, even if Safari dropped the reply.
 *   3. bridgeStatus.updatedAt is FRESH — some engine is already writing
 *      status (a live worker mid-window, or a page engine in another window;
 *      either way this document must not start a second one — the lease
 *      settles who runs).
 *
 * None of the three → dead: start the page engine.
 */
export function backgroundAliveVerdict({
  pingReplied = false,
  beforeUpdatedAt = '',
  afterUpdatedAt = '',
  now = Date.now(),
  freshMs = STATUS_FRESH_MS,
} = {}) {
  if (pingReplied) return { dead: false, why: 'the worker answered the ping' }

  const after = Date.parse(afterUpdatedAt ?? '')
  if (Number.isFinite(after)) {
    if (String(afterUpdatedAt) !== String(beforeUpdatedAt ?? '')) {
      return { dead: false, why: 'bridgeStatus freshened during the wait' }
    }
    if (now - after <= freshMs) {
      return { dead: false, why: 'bridgeStatus is fresh — an engine is already writing it' }
    }
  }

  return {
    dead: true,
    why: 'the ping went unanswered and bridgeStatus stood still',
  }
}

/* ===================================================================== *
 * The single-flight lease. One engine runs the loops, ever.
 * ===================================================================== */

export const ENGINE_LEASE_KEY = 'engineLease'
export const BACKGROUND_HOLDER = 'background'
/* A page engine heartbeats its lease every few seconds… */
export const LEASE_HEARTBEAT_MS = 3_000
/* …so a page lease three beats cold is a closed window, not a slow one. */
export const PAGE_LEASE_STALE_MS = 9_000
/*
 * The background claims the lease from startPeers, which runs on its 30 s
 * alarm — so a background lease is only PROVEN abandoned after two whole
 * alarm periods plus slack have passed with no re-claim. Below that, a page
 * stealing between alarms would double-run the loops in every browser where
 * the background works.
 */
export const BACKGROUND_LEASE_STALE_MS = 75_000
/* After writing a claim, re-read to settle simultaneous claimants. */
export const LEASE_CONFIRM_MS = 250

/**
 * The lease rules, as one pure function.
 *
 *   - The background ALWAYS wins: when it is the claimant it acquires
 *     unconditionally, and while its lease is fresh no page may take it.
 *   - A page acquires only what is free, its own, or provably stale — with
 *     staleness measured against the holder's own cadence (3 s beats for a
 *     page, 30 s alarms for the background).
 *   - Everything else is blocked, and the reason says who holds it.
 */
export function leaseDecision(
  lease,
  {
    holder,
    now = Date.now(),
    pageStaleMs = PAGE_LEASE_STALE_MS,
    backgroundStaleMs = BACKGROUND_LEASE_STALE_MS,
  } = {},
) {
  if (holder === BACKGROUND_HOLDER) {
    return {
      action: lease?.holder === BACKGROUND_HOLDER ? 'retain' : 'acquire',
      reason: 'the background always wins',
    }
  }

  const at = Number(lease?.at)
  if (!lease || typeof lease !== 'object' || !lease.holder || !Number.isFinite(at)) {
    return { action: 'acquire', reason: 'no valid lease is held' }
  }
  if (lease.holder === holder) {
    return { action: 'retain', reason: 'already held by this document' }
  }

  const staleMs = lease.holder === BACKGROUND_HOLDER ? backgroundStaleMs : pageStaleMs
  if (now - at > staleMs) {
    return { action: 'acquire', reason: `the ${lease.holder} lease went stale` }
  }
  return { action: 'blocked', reason: `${lease.holder} holds a fresh lease` }
}

/* ===================================================================== *
 * The engine.
 * ===================================================================== */

/**
 * A page-hosted bridge engine: the agent poll loop AND the relay doorbell,
 * in whichever document wins the lease. The standalone console
 * (popup.html?standalone=1) is the recommended long-lived host — the popover
 * runs the same loops but takes them to the grave on every outside click,
 * which is why its banner points at the pin.
 *
 * Everything loop-shaped is guarded by the storage lease above. Everything
 * request-shaped (`handle`) is NOT: an owner's click is handled by the
 * document that received it, whichever engine holds the loops.
 */
export function createPageEngine({
  api: apiOverride,
  standalone = false,
  onStopped = null,
} = {}) {
  const api = apiOverride ?? globalThis.browser ?? globalThis.chrome
  const holder = `${standalone ? 'console' : 'popover'}-${crypto.randomUUID().slice(0, 8)}`
  /* Its own incarnation, exactly like a fresh worker: a new nonce makes this
   * takeover visible in the heartbeat so the agent retires orphaned commands,
   * and its own replay ledger guards the same double-act hazard. */
  const nonce = crypto.randomUUID()
  const ledger = createCommandLedger()
  const mesh = createMeshSocket()

  let running = false
  let leaseTimer = null
  let macLastOkAt = 0

  const relayCtx = {
    ledger,
    macFresh: () => Date.now() - macLastOkAt <= MAC_FRESH_MS,
  }

  /*
   * The relay loop's sleep, interruptible. A fresh pairing writes a new
   * relayDeviceId/deviceToken into storage mid-nap, and the owner watching
   * the brain chip must not wait out a 60 s sweep interval for the socket to
   * adopt them — configChanged() below rings this and the next pass rebuilds
   * against the new stored identity.
   */
  let relayWake = null
  const relaySleep = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(finish, ms)
      function finish() {
        clearTimeout(timer)
        if (relayWake === finish) relayWake = null
        resolve()
      }
      relayWake = finish
    })

  const readLease = async () =>
    (await api.storage.local.get(ENGINE_LEASE_KEY))[ENGINE_LEASE_KEY]

  const writeLease = () =>
    api.storage.local.set({ [ENGINE_LEASE_KEY]: { holder, at: Date.now() } })

  async function acquireLease() {
    const decision = leaseDecision(await readLease(), { holder })
    if (decision.action === 'blocked') return false
    await writeLease()
    /* Two documents can decide "free" together; the re-read after a short
     * settle makes the last writer the only winner and the loser back off. */
    await delay(LEASE_CONFIRM_MS)
    const confirmed = await readLease()
    return confirmed?.holder === holder
  }

  async function releaseLease() {
    try {
      const stored = await readLease()
      if (stored?.holder === holder) {
        await api.storage.local.remove(ENGINE_LEASE_KEY)
      }
    } catch {
      /* Staleness retires an unreleased lease within PAGE_LEASE_STALE_MS. */
    }
  }

  async function stop(reason = '') {
    if (!running) return
    running = false
    if (leaseTimer !== null) {
      clearInterval(leaseTimer)
      leaseTimer = null
    }
    mesh.close()
    await releaseLease()
    onStopped?.(reason)
  }

  /* The lease heartbeat: refresh while held, stand down the moment someone
   * with a better claim (the background, always) has taken it. */
  function startLeaseHeartbeat() {
    leaseTimer = setInterval(() => {
      void (async () => {
        if (!running) return
        const decision = leaseDecision(await readLease(), { holder })
        if (decision.action === 'blocked') {
          await stop(decision.reason)
          return
        }
        await writeLease()
      })().catch(() => {})
    }, LEASE_HEARTBEAT_MS)
  }

  /*
   * The agent bridge loop — pollWindow's body with the 25 s alarm window
   * removed, because this host's lifetime IS the window: the document. Same
   * shared heartbeat/pollOnce, same status wording plus the engine stamp.
   */
  async function agentLoop() {
    let failures = 0
    while (running) {
      const config = await getConfig()
      if (!config.agentToken) {
        await updateStatus({
          engine: holder,
          state: 'needs-setup',
          connected: false,
          message: 'Paste the pairing code in the extension popup to connect.',
        })
        await delay(3_000)
        continue
      }

      try {
        await heartbeat(config, { nonce, ledger })
        macLastOkAt = Date.now()
        await updateStatus({
          engine: holder,
          state: 'connected',
          connected: true,
          message: standalone
            ? 'Connected to the local Mac agent (engine: this console window).'
            : 'Connected to the local Mac agent (engine: this popover).',
          lastConnectedAt: new Date().toISOString(),
          error: '',
        })
        failures = 0

        const heartbeatDeadline = Date.now() + HEARTBEAT_INTERVAL_MS
        while (running && Date.now() < heartbeatDeadline) {
          const handled = await pollOnce(config, { ledger })
          if (!running) break
          if (!handled) await delay(POLL_INTERVAL_MS)
        }
      } catch (error) {
        failures += 1
        await updateStatus({
          engine: holder,
          state: error?.status === 401 ? 'unauthorized' : 'offline',
          connected: false,
          message:
            error?.status === 401
              ? 'The local agent rejected the token.'
              : 'Cannot reach the local Mac agent.',
          error: error?.message || String(error),
          lastErrorAt: new Date().toISOString(),
        })
        await delay(retryDelay(failures - 1))
      }
    }
  }

  /*
   * The relay loop — relayWindow reshaped the same way. It runs in EVERY
   * engine host, popover included: the brain chip only turns green when
   * relayStatus reads connected, and the owner who just pasted a pairing
   * code into the popover is looking at that chip RIGHT NOW (measured live,
   * 2026-08-12: "Paired… the brain is on" with the chip still amber would
   * read as a lie). The popover's socket dies cleanly with its document
   * (stop() on pagehide), and the console window remains the recommended
   * long-lived host. Sleep is capped and interruptible: the socket delivers
   * instantly, the sweep exists for dropped frames, and a config change or a
   * stop must not wait out a nap.
   */
  async function relayLoop() {
    while (running) {
      const relayConfig = await getRelayConfig()
      if (!relayConfig.ready) {
        await updateRelayStatus({
          state: 'off',
          connected: false,
          message: relayConfig.reason,
        })
        await relaySleep(15_000)
        continue
      }

      const macConfig = await getConfig()
      mesh.ensure(relayConfig, () =>
        drainRelayUntilEmpty(relayConfig, macConfig, relayCtx).catch((error) =>
          console.warn(`mesh doorbell drain failed: ${error?.message || error}`),
        ),
      )

      const choice = choosePeer({
        macConfigured: Boolean(macConfig.agentToken),
        macLastOkAt,
        relayReady: true,
        socketOpen: mesh.isOpen(),
      })

      try {
        const report = await drainRelayUntilEmpty(relayConfig, macConfig, relayCtx)
        await updateRelayStatus({
          state: 'connected',
          connected: true,
          transport: choice.relayTransport,
          message: describeRelayPeer(relayConfig, choice),
          lastConnectedAt: new Date().toISOString(),
          error: '',
          ...report,
        })
      } catch (error) {
        const failure = describeRelayFailure(error)
        await updateRelayStatus({
          ...failure,
          connected: false,
          transport: mesh.isOpen() ? 'socket' : 'poll',
          error: error?.message || String(error),
          lastErrorAt: new Date().toISOString(),
        })
      }

      if (!running) break
      await relaySleep(Math.min(choice.relayPollMs, 60_000))
    }
  }

  return {
    holder,
    standalone,
    active: () => running,

    /** Try to become THE engine. False when someone fresher holds the lease. */
    async start() {
      if (running) return true
      if (!(await acquireLease())) return false
      running = true
      startLeaseHeartbeat()
      /* A crashed loop must not leave a zombie lease: stop() releases it so
       * the next surface (or a reopened popup) can take over cleanly. */
      void agentLoop().catch((error) =>
        stop(`the agent loop crashed: ${error?.message || error}`),
      )
      void relayLoop().catch((error) =>
        console.warn(`the relay loop crashed: ${error?.message || error}`),
      )
      return true
    },

    stop,

    /**
     * The stored peer configuration changed under a running engine — a fresh
     * pairing, most importantly. The socket may be open under the OLD
     * relayDeviceId (or latched refused by a dead credential), so it is
     * closed, the refusal latch cleared, and the relay loop woken to rebuild
     * from the same storage keys the background reads (getRelayConfig). This
     * is what puts the fleet map's EXT node and EXT—RLY edge live under the
     * freshly minted deviceId within a pass instead of a sweep interval.
     */
    configChanged() {
      if (!running) return
      mesh.clearRefusal()
      mesh.close()
      relayWake?.()
    },

    /**
     * Owner-initiated requests, handled in this document with the same
     * handlers the worker's message router calls — console-engine.js is the
     * single implementation either way.
     */
    async handle(message) {
      if (message?.type === 'console:submit') return handleConsoleSubmit(message)
      if (message?.type === 'plan:decide') return decidePlan(message)
      if (message?.type === 'approval:decide') return decideApproval(message)
      if (message?.type === 'bridge:poll-now') return { ok: true, engine: holder }
      return { ok: false, error: `The page engine cannot handle "${String(message?.type ?? '')}".` }
    },
  }
}
