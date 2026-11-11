/*
 * THE BACKGROUND ENGINE: alarms, poll windows, the mesh sweep, escrow and the
 * message router.
 *
 * Since 2026-08-12 this file is the thin conductor over two shared modules:
 * executor.js (config identity, agent HTTP client, the command executor, the
 * status/badge writers) and console-engine.js (the owner's console, the brain
 * loop, plan/approval decisions, the relay drain and the mesh socket). The
 * extraction is NOT a refactor for taste — the owner's Safari was measured
 * refusing to evaluate this file AT ALL (service_worker AND background.scripts
 * forms, across relaunches and a re-registration) while extension pages kept
 * running. page-engine.js runs the same shared modules from the popup and the
 * standalone console when that happens; this file keeps running them in every
 * browser where the background works. One executor, one console, two hosts.
 */
import { createCommandLedger, retryDelay } from './bridge-core.js'
import {
  MAC_FRESH_MS,
  RELAY_STORAGE_KEYS,
  choosePeer,
  describeRelayFailure,
  describeRelayPeer,
} from './relay-peer.js'
import {
  PAIR_OUTCOME_KEY,
  PAIR_WIPE_KEYS,
  credentialExpiryCheck,
  escrowRestorePlan,
  normalizePairLifetime,
  pairOutcomeRecord,
  pairStoragePatch,
  shouldEscrow,
} from './pairing.js'
import {
  CONFIG_KEYS,
  HEARTBEAT_INTERVAL_MS,
  BACKGROUND_POLL_INTERVAL_MS,
  RELAY_STATUS_KEY,
  STATUS_KEY,
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
import { BACKGROUND_HOLDER, ENGINE_LEASE_KEY } from './page-engine.js'

const api = globalThis.browser ?? globalThis.chrome
const POLL_ALARM = 'ai-pendant-poll'
const POLL_WINDOW_MS = 25_000

let activePoll = null
let activeRelayDrain = null
let configRevision = 0

/*
 * The mesh doorbell, held for as long as this worker lives. See
 * console-engine.js createMeshSocket for the policy (subprotocol handshake,
 * the 1008 refusal latch) — this worker holds one controller, a page engine
 * holds its own.
 */
const mesh = createMeshSocket()

/*
 * When the Mac last answered, as observed by this worker rather than asserted
 * by config. choosePeer() turns it into the routing decision; it is reset to 0
 * on every worker start, so a fresh incarnation treats the Mac as unproven
 * until a heartbeat succeeds instead of inheriting an optimistic default.
 */
let macLastOkAt = 0

/*
 * One nonce per service-worker incarnation.
 *
 * Safari suspends this worker freely, and every restart loses the ledger below
 * with it. The agent cannot see that happen — the extensionId is stable across
 * restarts — so it has no way to know that a command it handed out is now
 * orphaned rather than slow, and it waits out the full lease before deciding.
 * A nonce that changes on restart makes the restart visible in the heartbeat,
 * which is what lets the agent retire the orphan immediately instead of leaving
 * it to be run later by whoever polls next.
 */
const INCARNATION_NONCE = crypto.randomUUID()

/*
 * Survives only as long as this worker does, which is exactly the window that
 * matters: the agent refuses to hand out anything older than 90s, so a replay
 * that could double-act has to arrive within seconds of the first attempt.
 */
const commandLedger = createCommandLedger()

/* The incarnation context the shared drain threads through runMeshEnvelope:
 * the same replay ledger the Mac path uses, and this worker's observation of
 * the Mac's freshness for the pong. */
const relayCtx = {
  ledger: commandLedger,
  macFresh: () => Date.now() - macLastOkAt <= MAC_FRESH_MS,
}

async function migrateSyncedCredentials() {
  if (!api.storage.sync) return

  const local = await api.storage.local.get(CONFIG_KEYS)
  const synced = await api.storage.sync.get(['agentUrl', 'agentToken'])
  const updates = {}

  if (!local.agentUrl && synced.agentUrl) updates.agentUrl = synced.agentUrl
  if (!local.agentToken && synced.agentToken) updates.agentToken = synced.agentToken

  if (Object.keys(updates).length) {
    await api.storage.local.set(updates)
  }

  if (synced.agentToken) {
    await api.storage.sync.remove('agentToken')
  }
}

async function pollWindow(revision) {
  const config = await getConfig()

  if (!config.agentToken) {
    await updateStatus({
      state: 'needs-setup',
      connected: false,
      message: 'Paste the pairing code in the extension popup to connect.',
    })
    return
  }

  const deadline = Date.now() + POLL_WINDOW_MS
  let nextHeartbeatAt = 0
  let failures = 0

  while (Date.now() < deadline && revision === configRevision) {
    try {
      if (Date.now() >= nextHeartbeatAt) {
        await heartbeat(config, { nonce: INCARNATION_NONCE, ledger: commandLedger })
        macLastOkAt = Date.now()
        nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS
        await updateStatus({
          state: 'connected',
          connected: true,
          message: 'Connected to the local Mac agent.',
          lastConnectedAt: new Date().toISOString(),
          error: '',
        })
      }

      const handledCommand = await pollOnce(config, { ledger: commandLedger })
      failures = 0
      /* Background-hosted loops idle at the Safari-safe cadence — see the
       * BACKGROUND_POLL_INTERVAL_MS comment in executor.js. A handled
       * command loops immediately; only idle waits are slow. */
      if (!handledCommand) await delay(BACKGROUND_POLL_INTERVAL_MS)
    } catch (error) {
      failures += 1
      await updateStatus({
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

function startPolling() {
  if (activePoll) return activePoll

  const revision = configRevision
  activePoll = pollWindow(revision)
    .catch(async (error) => {
      await updateStatus({
        state: 'error',
        connected: false,
        message: 'Browser bridge stopped unexpectedly.',
        error: error?.message || String(error),
        lastErrorAt: new Date().toISOString(),
      })
    })
    .finally(() => {
      activePoll = null
      if (revision !== configRevision) void startPolling()
    })

  return activePoll
}

/* ===================================================================== *
 * The second peer: the relay, reached directly. Runs BESIDE the Mac loop
 * above, never instead of it — see relay-peer.js for the policy, and
 * console-engine.js for the drain the two hosts share.
 * ===================================================================== */

async function relayWindow(revision) {
  const relayConfig = await getRelayConfig()

  if (!relayConfig.ready) {
    await updateRelayStatus({
      state: 'off',
      connected: false,
      message: relayConfig.reason,
    })
    return
  }

  const macConfig = await getConfig()
  const deadline = Date.now() + POLL_WINDOW_MS

  /*
   * Open the doorbell first, and drain once regardless of whether it opened.
   *
   * The unconditional first drain is the fallback-on-wake path and it is the
   * important one: Safari suspends this worker freely, and mail that arrived
   * while it was dead rang a doorbell with nobody listening. A socket cannot
   * replay that; only a sweep can.
   */
  mesh.ensure(relayConfig, () =>
    drainRelayUntilEmpty(relayConfig, macConfig, relayCtx).catch((error) =>
      console.warn(`mesh doorbell drain failed: ${error?.message || error}`),
    ),
  )

  while (Date.now() < deadline && revision === configRevision) {
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
      /* status first, code second: describeRelayFailure keys on status and
       * lets a `code` sharpen it — since relay 41dbc4b the ownership 403
       * sends `not_your_inbox`, which relayFetch forwards. */
      const failure = describeRelayFailure(error)
      await updateRelayStatus({
        ...failure,
        connected: false,
        transport: mesh.isOpen() ? 'socket' : 'poll',
        error: error?.message || String(error),
        lastErrorAt: new Date().toISOString(),
      })
    }

    /*
     * Never sleep past the end of the window. RELAY_POLL_IDLE_MS (30 s) is
     * longer than POLL_WINDOW_MS (25 s), so on a healthy Mac this exits after
     * one drain and the 30 s alarm is what schedules the next — rather than
     * holding the service worker awake for a sleep whose wake-up is already
     * outside its own deadline.
     */
    if (Date.now() + choice.relayPollMs >= deadline) break
    await delay(choice.relayPollMs)
  }
}

function startRelayDrain() {
  if (activeRelayDrain) return activeRelayDrain

  const revision = configRevision
  activeRelayDrain = relayWindow(revision)
    .catch(async (error) => {
      await updateRelayStatus({
        state: 'error',
        connected: false,
        message: 'The relay peer stopped unexpectedly.',
        error: error?.message || String(error),
        lastErrorAt: new Date().toISOString(),
      })
    })
    .finally(() => {
      activeRelayDrain = null
      if (revision !== configRevision) void startRelayDrain()
    })

  return activeRelayDrain
}

/*
 * Both peers wake on the same alarm and neither can stop the other: a relay
 * that is unreachable must not keep the Mac loop from starting, and a Mac that
 * is asleep is the case the relay peer exists for.
 */
function startPeers() {
  /* The lifetime check runs FIRST so an expired credential is wiped before a
   * poll window starts using it; the wipe's storage.onChanged then restarts
   * the loops against the emptied config. The escrow restore runs SECOND so
   * it only ever fills a hole the lifetime check agreed should stay empty of
   * expired credentials — never the other way around. Failure of either must
   * never stop the peers — a broken clock is not an excuse to go silent. */
  void enforceCredentialLifetime()
    .then(() => maybeRestorePairingFromEscrow())
    .catch(() => {})
    .finally(() => {
      void startPolling()
      void startRelayDrain()
    })
  /*
   * THE BACKGROUND ALWAYS WINS THE ENGINE LEASE. Claimed on every evaluation
   * and every alarm: a page engine that sees this fresh claim stands down
   * within one lease heartbeat, which is what makes "never double-run" true
   * in the browsers where this worker DOES evaluate. See page-engine.js
   * leaseDecision for the rules (a page may only steal this claim after two
   * whole missed alarm periods).
   */
  void api.storage.local
    .set({ [ENGINE_LEASE_KEY]: { holder: BACKGROUND_HOLDER, at: Date.now() } })
    .catch(() => {})
}

/*
 * CREDENTIAL ESCROW — the native round trips. Policy lives in pairing.js
 * (shouldEscrow / escrowRestorePlan); this is only the plumbing to the Safari
 * wrapper app's SafariWebExtensionHandler, which keeps a copy of the pairing
 * in ITS UserDefaults — a store that survives the Safari extension-storage
 * resets that wiped the owner's pairing on 2026-08-10 and 2026-08-12. The
 * owner's instruction, 2026-08-12: "we likely gonna keep updating the
 * extension, make sure this issue doesn't happen again."
 */

/*
 * Chromium has no native host registered for this extension, so
 * sendNativeMessage there rejects (or the API is missing entirely). One
 * failed probe latches this flag for the worker's lifetime — escrow becomes
 * a no-op instead of a rejection logged on every alarm tick. Safari resets
 * the flag naturally on the next worker start.
 */
let escrowUnavailable = false

async function escrowSend(message) {
  if (escrowUnavailable) return null
  if (typeof api?.runtime?.sendNativeMessage !== 'function') {
    escrowUnavailable = true
    return null
  }
  try {
    /* Safari ignores the application-id argument and routes to the bundled
     * app's handler; Chromium looks the id up, finds no host, and rejects —
     * which the catch below converts into the latched no-op. */
    return await api.runtime.sendNativeMessage('application.id', message)
  } catch {
    escrowUnavailable = true
    return null
  }
}

async function escrowStorePairing(values) {
  await escrowSend({ type: 'escrow:store', values })
}

async function escrowClearPairing() {
  await escrowSend({ type: 'escrow:clear' })
}

/*
 * The restore: only when storage has NO agentToken (the needs-setup state an
 * update-reset leaves behind), and only when the escrowed blob would survive
 * the same expiry check the live credential faces. Session-only pairings are
 * never escrowed in the first place (shouldEscrow) — restoring one across a
 * browser restart would undo "forget right after this browser is closed".
 */
async function maybeRestorePairingFromEscrow() {
  const { agentToken } = await api.storage.local.get('agentToken')
  if (agentToken) return

  const reply = await escrowSend({ type: 'escrow:fetch' })
  const plan = escrowRestorePlan(reply?.values)
  if (!plan.restore) return

  await api.storage.local.set(plan.values)
  /* Deliberately loud: this line in the worker console is the proof that an
   * update reset storage and the escrow put the pairing back. */
  console.log('[ai-pendant] Pairing restored from the app escrow after a storage reset.')
}

/*
 * THE LIFETIME, ENFORCED. The owner chose how long a pairing lives (session /
 * 7d / 30d / forever — see pairing.js); this is where the choice has teeth on
 * this end. Runs on every worker start and every poll alarm, so an expiry is
 * noticed within 30s even on a browser that never restarts. The relay
 * enforces the 7d/30d expiresAt server-side regardless; this wipe is what
 * turns the popup honest ("needs setup", not "bad token") and is the ONLY
 * enforcement for session-only, which the relay cannot see.
 */
async function enforceCredentialLifetime() {
  const values = await api.storage.local.get([
    'agentToken',
    'pairLifetime',
    'pairExpiresAt',
  ])
  /* The sentinel lives in storage.session precisely BECAUSE the browser wipes
   * that area on quit: sentinel gone = browser closed since pairing. A build
   * without storage.session (very old engines) treats the session as alive
   * rather than wiping on every worker restart. */
  const sessionValues = api.storage.session
    ? await api.storage.session.get('pairSessionAlive').catch(() => ({}))
    : { pairSessionAlive: true }

  const verdict = credentialExpiryCheck({
    agentToken: values.agentToken,
    pairLifetime: values.pairLifetime,
    pairExpiresAt: values.pairExpiresAt,
    sessionAlive: Boolean(sessionValues?.pairSessionAlive),
  })
  if (!verdict.wipe) return

  await api.storage.local.remove([...PAIR_WIPE_KEYS])
  await updateStatus({
    state: 'needs-setup',
    connected: false,
    message: `${verdict.reason} Paste the pairing code in the popup to connect again.`,
  })
}

api.runtime.onInstalled.addListener(async ({ reason: _reason }) => {
  await migrateSyncedCredentials()
  await api.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 })
  /* No options page to open any more (owner deleted it, 2026-08-12): the
   * popup shows its setup card whenever no agentToken is stored, so a fresh
   * install needs no hand-off — the first toolbar click IS setup. */
  startPeers()
})

api.runtime.onStartup.addListener(async () => {
  await migrateSyncedCredentials()
  await api.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 })
  startPeers()
})

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) startPeers()
})

api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return

  /*
   * Any path that REMOVES the agent token — the lifetime wipe above, or any
   * future explicit unpair UI — must also empty the escrow, or the next
   * worker start would quietly restore what the owner (or the expiry) just
   * revoked. Hooking the storage transition instead of each caller means a
   * disconnect button added later is covered on the day it ships. A restore
   * or re-pair SETS the token, so newValue is present and this stays quiet.
   */
  if (changes.agentToken && changes.agentToken.newValue === undefined) {
    void escrowClearPairing()
  }

  if (
    ['agentUrl', 'agentToken', 'deviceName', 'targetMode'].some(
      (key) => changes[key],
    )
  ) {
    configRevision += 1
    void startPolling()
  }

  if (RELAY_STORAGE_KEYS.some((key) => changes[key])) {
    configRevision += 1
    /* A new credential deserves a fresh socket, and clears the refusal latch —
     * pasting a re-paired token is exactly how the owner fixes a 1008. */
    mesh.clearRefusal()
    mesh.close()
    void startRelayDrain()
  }
})

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bridge:poll-now') {
    void startPolling().then(() => sendResponse({ ok: true }))
    void startRelayDrain()
    return true
  }

  if (message?.type === 'bridge:get-status') {
    void api.storage.local
      .get(STATUS_KEY)
      .then((values) => sendResponse(values[STATUS_KEY] ?? null))
    return true
  }

  /* Both peers in one answer, so a reader never has to infer the mesh's state
   * from the Mac's. */
  if (message?.type === 'peers:get-status') {
    void Promise.all([
      api.storage.local.get([STATUS_KEY, RELAY_STATUS_KEY]),
      getRelayConfig(),
      getConfig(),
    ])
      .then(([values, relayConfig, macConfig]) =>
        sendResponse({
          mac: values[STATUS_KEY] ?? null,
          relay: values[RELAY_STATUS_KEY] ?? null,
          choice: choosePeer({
            macConfigured: Boolean(macConfig.agentToken),
            macLastOkAt,
            relayReady: relayConfig.ready,
            socketOpen: mesh.isOpen(),
          }),
        }),
      )
      .catch((error) => sendResponse({ error: error?.message || String(error) }))
    return true
  }

  if (message?.type === 'relay:drain-now') {
    void startRelayDrain().then(() => sendResponse({ ok: true }))
    return true
  }

  if (message?.type === 'approval:decide') {
    void decideApproval(message)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }),
      )
    return true
  }

  if (message?.type === 'console:submit') {
    void handleConsoleSubmit(message)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }),
      )
    return true
  }

  /*
   * One-paste pairing: fetched here AND stored here — both lessons were paid
   * for live.
   *
   * FETCH HERE: the first build fetched from the settings page ("it stays
   * alive for the whole round trip"), and in live Safari the request was
   * DISPATCHED — the agent ran the route, the relay minted the credential —
   * but the response never reached the page: "Pairing…" forever, credential
   * orphaned. This worker is the one context PROVEN to fetch loopback in the
   * owner's Safari (the bridge polls it all day).
   *
   * STORE HERE TOO: the second build fetched here but stored on the page, so
   * the credential rode back over sendResponse — and Safari DROPS an async
   * sendResponse when the round trip runs long (the agent's relay leg can
   * take 15s). The page saw `undefined`, printed "the agent returned no
   * token", and the minted credential evaporated. So the patch is applied
   * HERE the instant the fetch completes, and the popup reads the OUTCOME
   * from storage (PAIR_OUTCOME_KEY, via storage.onChanged) — a channel that
   * cannot be lost with the token. sendResponse is best-effort narration.
   *
   * AND SINCE 1.7.5: on the Safari where this worker never evaluates at all,
   * the popup performs this same exchange itself — runDirectPairing in
   * page-engine.js, same storage contract — after its 2.5 s reply window
   * lapses. This handler stays for every browser where the worker lives.
   */
  if (message?.type === 'pair:run') {
    void (async () => {
      let outcome
      try {
        const origin = String(message.agentUrl ?? '').replace(/\/$/, '')
        const lifetime = normalizePairLifetime(message.lifetime)
        const response = await fetch(`${origin}/pair/browser`, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: String(message.code ?? ''),
            deviceId: String(message.deviceId ?? ''),
            deviceName: String(message.deviceName ?? ''),
            lifetime,
          }),
          signal: AbortSignal.timeout(20_000),
        })
        const payload = await response.json().catch(() => null)
        outcome = pairStoragePatch(
          payload ?? {
            ok: false,
            error: `The agent returned HTTP ${response.status} with no body.`,
          },
          { agentUrl: origin, lifetime },
        )

        if (outcome.ok) {
          /*
           * Session-only pairing plants a sentinel in storage.session, which
           * the browser wipes when it quits — its absence at the next worker
           * start is how "forget right after this browser is closed" is
           * detected (credentialExpiryCheck). Planted BEFORE the credentials
           * land so there is no instant where a session credential exists
           * that a worker crash would promote to forever.
           */
          if (lifetime === 'session' && api.storage.session) {
            await api.storage.session.set({ pairSessionAlive: true })
          }
          await api.storage.local.set(outcome.values)
          /* A synced copy of an old token must not outlive a re-pair. */
          if (api.storage.sync) await api.storage.sync.remove('agentToken')
          /*
           * Escrow the fresh pairing (lifetime and expiry included) with the
           * wrapper app, so the NEXT extension update cannot cost the owner
           * this credential. Session-only pairings are deliberately excluded
           * — see shouldEscrow in pairing.js. Best-effort by design: a
           * failed escrow must never fail a successful pair.
           */
          if (shouldEscrow(lifetime)) {
            await escrowStorePairing(outcome.values).catch(() => {})
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

      /* The outcome record is written even on failure, so the popup's one
       * listener covers every ending. */
      await api.storage.local
        .set({ [PAIR_OUTCOME_KEY]: pairOutcomeRecord(outcome) })
        .catch(() => {})
      try {
        sendResponse(outcome)
      } catch {
        /* Safari dropped the channel — the storage write above already told
         * the popup everything. */
      }
    })()
    return true
  }

  /* A parked plan, decided in the popup instead of on the dashboard. */
  if (message?.type === 'plan:decide') {
    void decidePlan(message)
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }),
      )
    return true
  }

  return false
})

void migrateSyncedCredentials()
  .then(() => api.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 }))
  .then(() => startPeers())
