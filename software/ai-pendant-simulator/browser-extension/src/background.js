import {
  commandIdentity,
  createCommandLedger,
  isScriptableUrl,
  normalizeCommandParams,
  normalizeConfig,
  originPattern,
  pickTargetTab,
  provenanceFor,
  retryDelay,
  sanitizeExtraction,
  validateCommand,
  validateNavigationUrl,
} from './bridge-core.js'
import {
  CONSOLE_SOURCE,
  EXECUTE_TIMEOUT_MS,
  HISTORY_KEY,
  PLAN_TIMEOUT_MS,
  SESSION_KEY,
  appendHistory,
  buildCommandText,
  commandContext,
  interpretExecuteResponse,
  interpretPlanResponse,
  localStepPending,
  newHistoryEntry,
  outcomeToPatch,
  patchHistory,
  planDecisionPreflight,
  scrubPageContext,
} from './command-console.js'
import {
  CAPABILITY_BROWSER,
  EFFECT_OUTWARD,
  createOutwardGuard,
  honestVerdict,
  routePlan,
} from './affinity.js'
import {
  BRAIN_MAX_STEPS,
  compactToolResult,
  createBrainTranscript,
  describeInferFailure,
  inferRequest,
  parseBrainReply,
  readInferPayload,
} from './brain.js'
import {
  createExecutionJournal,
  hiveClaimRecordFor,
  hiveVerdictRecordFor,
} from './execution-status.js'
import {
  BRIDGE_PING_FRAME,
  BRIDGE_PING_INTERVAL_MS,
  MAC_FRESH_MS,
  RELAY_STORAGE_KEYS,
  acceptEnvelopes,
  ackRequest,
  choosePeer,
  createEnvelopeLedger,
  describeRelayFailure,
  describeRelayPeer,
  envelopeToCommand,
  hasMoreMail,
  inboxRequest,
  normalizeRelayConfig,
  pongMessageFor,
  pruneEnvelopeLedger,
  reactToFrame,
  relayResponseError,
  resultMessageFor,
  socketProtocolAccepted,
  socketProtocols,
  socketUrl,
} from './relay-peer.js'
import {
  APPROVALS_KEY,
  approvalBadge,
  mergeApprovalPrompts,
  prepareApprovalDecision,
} from './approvals.js'
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

const api = globalThis.browser ?? globalThis.chrome
const POLL_ALARM = 'ai-pendant-poll'
const POLL_WINDOW_MS = 25_000
const POLL_INTERVAL_MS = 750
const HEARTBEAT_INTERVAL_MS = 12_000
const FETCH_TIMEOUT_MS = 7_000
const STATUS_KEY = 'bridgeStatus'
const RELAY_STATUS_KEY = 'relayStatus'
/* Survives the worker restarts the 60 s inbox lease is measured against — see
 * createEnvelopeLedger's note on why this one cannot live in module scope. */
const RELAY_LEDGER_KEY = 'relaySeenEnvelopes'
const CONFIG_KEYS = ['agentUrl', 'agentToken', 'deviceName', 'targetMode', 'instanceId']

let activePoll = null
let activeRelayDrain = null
let configRevision = 0

/*
 * The mesh doorbell, held for as long as this worker lives.
 *
 * Not per-poll-window: a socket that is torn down and rebuilt every 25 s is a
 * poller wearing a costlier hat. It is deliberately NOT treated as proof of
 * delivery either — see relay-peer.js on why a sweep still runs under it.
 */
let meshSocket = null
let meshSocketOpen = false
let meshPingTimer = null
/* Set when the relay refuses the credential, so a doomed socket is not rebuilt
 * on every alarm. Cleared when the relay config changes. */
let meshSocketRefused = false

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

async function getConfig() {
  const values = await api.storage.local.get(CONFIG_KEYS)
  const config = normalizeConfig(values)

  if (!values.instanceId) {
    values.instanceId = crypto.randomUUID()
    await api.storage.local.set({ instanceId: values.instanceId })
  }

  return {
    ...config,
    instanceId: values.instanceId,
    extensionId: `ai-pendant-${api.runtime.id}-${values.instanceId}`,
  }
}

async function request(config, path, options = {}) {
  return fetch(`${config.agentUrl}${path}`, {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${config.agentToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

async function postJson(config, path, payload) {
  const response = await request(config, path, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw await responseError(response)
  }

  return response.status === 204 ? null : response.json()
}

async function responseError(response) {
  let detail = ''

  try {
    const payload = await response.json()
    detail = payload.error || payload.message || ''
  } catch {
    detail = await response.text().catch(() => '')
  }

  const error = new Error(
    detail || `Local agent returned HTTP ${response.status}.`,
  )
  error.status = response.status
  return error
}

async function currentTabSummary() {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true })
  const all = await api.tabs.query({}).catch(() => [])
  const scriptable = all.filter((t) => isScriptableUrl(t?.url))
  return tab
    ? {
        tabId: tab.id ?? null,
        windowId: tab.windowId ?? null,
        // Origin only — no path/query (fleet metadata, not page content).
        tabUrl: isScriptableUrl(tab.url) ? new URL(tab.url).origin : '',
        tabTitle: String(tab.title || '').slice(0, 80),
        tabCount: scriptable.length,
      }
    : {
        tabId: null,
        windowId: null,
        tabUrl: '',
        tabTitle: '',
        tabCount: scriptable.length,
      }
}

async function heartbeat(config) {
  const tab = await currentTabSummary()
  await postJson(config, '/browser/heartbeat', {
    extensionId: config.extensionId,
    deviceName: config.deviceName || platformLabel(),
    browserName: browserLabel(),
    extensionVersion: api.runtime.getManifest().version,
    userAgent: globalThis.navigator?.userAgent ?? '',
    /* The lease protocol: nonce says which incarnation of this worker is
     * holding the lease, capabilities say what it is safe to hand it. */
    nonce: INCARNATION_NONCE,
    capabilities: ['idempotency-ledger', 'privacy-boundary', 'provenance'],
    ledger: commandLedger.stats(),
    ...tab,
  })
}

async function pollOnce(config) {
  const response = await request(
    config,
    `/browser/poll?extensionId=${encodeURIComponent(config.extensionId)}`,
  )

  if (response.status === 204) return false
  if (!response.ok) throw await responseError(response)

  const payload = await response.json()
  const command = payload?.command
  const identity = commandIdentity(command)
  let result

  /*
   * The replay check, before anything touches a tab.
   *
   * The sequence this exists for leaves no trace on the agent side: the command
   * runs, the POST of its result fails all three attempts, and the command is
   * still queued. Whoever polls next gets it again — and "again" for a click or
   * a navigate means it happens twice on a real page. The agent cannot rule
   * that out, because from where it stands a command it never got an answer for
   * and a command that was never run look identical.
   */
  const replayed = commandLedger.recall(identity)
  if (replayed) {
    await postResultWithRetry(config, command?.commandId, {
      ...replayed.result,
      extensionId: config.extensionId,
      replayed: true,
    })
    return true
  }

  try {
    result = { ok: true, result: await executeCommand(command, config) }
  } catch (error) {
    result = { ok: false, error: error?.message || String(error) }
  }

  /* Recorded before the POST, not after: the POST is the step that fails. */
  commandLedger.remember(identity, result)

  await postResultWithRetry(config, command?.commandId, {
    ...result,
    extensionId: config.extensionId,
  })
  return true
}

async function postResultWithRetry(config, commandId, result) {
  if (!commandId) throw new Error('The browser command is missing its commandId.')

  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await postJson(
        config,
        `/browser/result/${encodeURIComponent(commandId)}`,
        result,
      )
      return
    } catch (error) {
      lastError = error
      if (attempt < 2) await delay(retryDelay(attempt, 300, 1_200))
    }
  }
  throw lastError
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
        await heartbeat(config)
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

      const handledCommand = await pollOnce(config)
      failures = 0
      if (!handledCommand) await delay(POLL_INTERVAL_MS)
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

async function updateStatus(patch) {
  const current = (await api.storage.local.get(STATUS_KEY))[STATUS_KEY] ?? {}
  const status = {
    ...current,
    ...patch,
    extensionId: api.runtime.id,
    updatedAt: new Date().toISOString(),
  }
  await api.storage.local.set({ [STATUS_KEY]: status })
  await refreshBadge(status)
}

/**
 * One writer for the toolbar badge, so its two claimants cannot fight.
 *
 * Approvals waiting on the owner outrank connection state: 'ON' is
 * reassurance, a count is a request, and the poll loop repaints the badge
 * often enough that the count falls away on its own once the last card is
 * answered or expires. Everything that changes either input — a status
 * update, a drained approval, a decision — lands here.
 */
async function refreshBadge(status = null) {
  if (!api.action?.setBadgeText) return

  const stored = await api.storage.local.get([STATUS_KEY, APPROVALS_KEY])
  const current = status ?? stored[STATUS_KEY] ?? {}
  const badge = approvalBadge(stored[APPROVALS_KEY] ?? []) ?? {
    text:
      current.state === 'connected'
        ? 'ON'
        : current.state === 'needs-setup'
          ? 'SET'
          : '!',
    color: current.state === 'connected' ? '#078B70' : '#B54736',
  }

  await api.action.setBadgeText({ text: badge.text })
  if (api.action.setBadgeBackgroundColor) {
    await api.action.setBadgeBackgroundColor({ color: badge.color })
  }
}

/*
 * storage.local has no transactions, so every read-modify-write of the
 * approval list rides one chain, exactly like the console history below: a
 * doorbell drain and a popup decision finishing together must not eat each
 * other's cards. Unlike withHistory this returns the caller's own result and
 * rethrows its error — a decision needs to know whether it went through —
 * while the chain itself swallows the failure so the next write still runs.
 */
let approvalWrites = Promise.resolve()

function withApprovals(mutate) {
  const run = approvalWrites.then(async () => {
    const values = await api.storage.local.get(APPROVALS_KEY)
    const next = await mutate(values[APPROVALS_KEY] ?? [])
    /* null means "nothing changed" — skip the write, and with it a popup
     * re-render and a storage.onChanged fan-out that would say nothing. */
    if (next) await api.storage.local.set({ [APPROVALS_KEY]: next })
    return next
  })
  approvalWrites = run.then(
    () => {},
    (error) => {
      console.warn('approval store write failed:', error?.message || error)
    },
  )
  return run
}

/* ===================================================================== *
 * The second peer: the relay, reached directly.
 *
 * Runs BESIDE the Mac loop above, never instead of it. The two share the
 * executor, the idempotency ledger and the privacy boundary; what differs is
 * only where work arrives from and where its answer goes. See relay-peer.js
 * for the policy and for why this is a poller rather than a socket.
 * ===================================================================== */

async function getRelayConfig() {
  return normalizeRelayConfig(await api.storage.local.get(RELAY_STORAGE_KEYS))
}

async function relayFetch(relayConfig, descriptor, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetch(`${relayConfig.relayUrl}${descriptor.path}`, {
    method: descriptor.method,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      /* The device token, on the wire, in a header — never in the path or a
       * query string, which is why inboxRequest carries only the deviceId. */
      Authorization: `Bearer ${relayConfig.deviceToken}`,
      ...(descriptor.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(descriptor.body ? { body: JSON.stringify(descriptor.body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    // Tested in relay-peer: carries message, status and the relay's `code`
    // (e.g. not_your_inbox) so describeRelayFailure can sharpen the fix.
    throw await relayResponseError(response)
  }

  return response.status === 204 ? null : await response.json()
}

/*
 * Open the doorbell, if it is not already open.
 *
 * The credential rides as a subprotocol offer because the WebSocket
 * constructor cannot set a header — see relay-peer.js socketProtocols() for
 * why there are two offers and why the token never comes back.
 */
function ensureMeshSocket(relayConfig, onMail) {
  if (meshSocket || meshSocketRefused) return
  const url = socketUrl(relayConfig)
  const protocols = socketProtocols(relayConfig)
  if (!url || !protocols.length) return

  let socket
  try {
    socket = new WebSocket(url, protocols)
  } catch (error) {
    console.warn(`mesh socket could not be created: ${error?.message || error}`)
    return
  }
  meshSocket = socket

  socket.addEventListener('open', () => {
    /* A server that echoed anything but the plain mesh name would mean the
     * token came back in a response header. Refuse rather than proceed. */
    if (!socketProtocolAccepted(socket.protocol)) {
      console.warn('mesh socket selected an unexpected subprotocol; closing.')
      try {
        socket.close()
      } catch {
        /* already closing */
      }
      return
    }
    meshSocketOpen = true
    void updateRelayStatus({
      state: 'connected',
      connected: true,
      transport: 'socket',
      message: 'The relay is pushing over its own socket.',
      lastConnectedAt: new Date().toISOString(),
      error: '',
    })
    /* Cloudflare answers this from the hibernation layer, so an idle socket
     * costs a frame rather than a woken Durable Object. */
    meshPingTimer = setInterval(() => {
      try {
        socket.send(BRIDGE_PING_FRAME)
      } catch {
        /* the close handler will clean up */
      }
    }, BRIDGE_PING_INTERVAL_MS)
  })

  socket.addEventListener('message', (event) => {
    if (reactToFrame(event?.data).drain) void onMail()
  })

  socket.addEventListener('close', (event) => {
    meshSocketOpen = false
    meshSocket = null
    if (meshPingTimer) {
      clearInterval(meshPingTimer)
      meshPingTimer = null
    }
    /*
     * 1008 is how the hub reports a refused handshake once the socket exists.
     * A credential the relay will not accept must not be retried on every
     * alarm. Observed live: a token that had just handshaked started being
     * refused because the device it belonged to was retired mid-session with
     * DELETE /v1/devices/:deviceId, which takes the credentials with it. A hot
     * reconnect loop would have hammered the relay for as long as nobody
     * noticed. The poll path stays up and reports the real reason.
     */
    if (event?.code === 1008 || event?.code === 4001 || event?.code === 4003) {
      meshSocketRefused = true
      void updateRelayStatus({
        state: 'unauthorized',
        connected: false,
        transport: 'poll',
        message: 'The relay refused this browser\'s socket credential.',
        lastErrorAt: new Date().toISOString(),
      })
    }
  })

  socket.addEventListener('error', () => {
    /* `close` always follows; the browser gives no detail here on purpose. */
    meshSocketOpen = false
  })
}

function closeMeshSocket() {
  if (meshPingTimer) {
    clearInterval(meshPingTimer)
    meshPingTimer = null
  }
  if (meshSocket) {
    try {
      meshSocket.close()
    } catch {
      /* already closed */
    }
  }
  meshSocket = null
  meshSocketOpen = false
}

async function runMeshEnvelope(envelope, handling, relayConfig, macConfig) {
  /*
   * An approval_request is RENDERED, never executed: fold it into the stored
   * card list (dedupe by approvalId — at-least-once re-sends the same
   * question under new envelope ids) and put the count on the badge. No
   * answer goes back from here; the answer is the owner's button in the
   * popup, which arrives later as 'approval:decide'. The request envelope was
   * already acked by drainRelayOnce — an ack means "I have this" — and the
   * decision path acks once more after its send, per the contract.
   */
  if (handling === 'approval') {
    const changed = await withApprovals((stored) => {
      const merged = mergeApprovalPrompts(stored, [envelope])
      return merged.changed ? merged.prompts : null
    })
    if (changed) await refreshBadge()
    return
  }

  if (handling === 'ping') {
    await relayFetch(
      relayConfig,
      pongMessageFor(
        envelope,
        {
          browser: browserLabel(),
          extensionVersion: api.runtime.getManifest().version,
          macFresh: Date.now() - macLastOkAt <= MAC_FRESH_MS,
          observedAt: new Date().toISOString(),
        },
        relayConfig,
      ),
    )
    return
  }

  let outcome
  try {
    const command = envelopeToCommand(envelope)
    /* The same replay check the Mac path runs, over the same ledger: a mesh
     * redelivery and an agent re-poll are the same hazard wearing two hats. */
    const identity = commandIdentity(command)
    const replayed = commandLedger.recall(identity)
    if (replayed) {
      outcome = { ...replayed.result, replayed: true }
    } else {
      try {
        outcome = { ok: true, result: await executeCommand(command, macConfig) }
      } catch (error) {
        outcome = { ok: false, error: error?.message || String(error) }
      }
      commandLedger.remember(identity, outcome)
    }
  } catch (error) {
    outcome = { ok: false, error: error?.message || String(error) }
  }

  await relayFetch(relayConfig, resultMessageFor(envelope, outcome, relayConfig))
}

async function drainRelayOnce(relayConfig, macConfig) {
  const page = await relayFetch(relayConfig, inboxRequest(relayConfig))
  const stored = (await api.storage.local.get(RELAY_LEDGER_KEY))[RELAY_LEDGER_KEY] ?? {}
  const accepted = acceptEnvelopes(page?.messages, {
    ledger: createEnvelopeLedger(stored),
    config: relayConfig,
  })

  /*
   * Written BEFORE anything runs, for the reason commandLedger.remember is
   * called before the result POST: the step that fails is the one after this,
   * and forgetting that a click happened costs the owner a second click on a
   * real page, while forgetting a result costs one repeated read.
   */
  await api.storage.local.set({
    [RELAY_LEDGER_KEY]: pruneEnvelopeLedger(accepted.ledger),
  })

  /*
   * Everything drained is acked, including what this node refused to run. An
   * ack means "I have this", not "I did this" — leaving a refusal unacked
   * would redeliver it every 60 s until the inbox hit MAX_INBOX_DEPTH and
   * started rejecting the sends that mattered.
   */
  if (accepted.ackIds.length) {
    await relayFetch(relayConfig, ackRequest(relayConfig, accepted.ackIds))
  }

  for (const { envelope, handling } of accepted.run) {
    try {
      await runMeshEnvelope(envelope, handling, relayConfig, macConfig)
    } catch (error) {
      console.warn(
        `mesh ${envelope.kind} from ${envelope.from} failed: ${error?.message || error}`,
      )
    }
  }

  return {
    drained: accepted.ackIds.length,
    ran: accepted.run.length,
    ignored: accepted.ignored.length,
    /*
     * NOT `pending > 0`. The relay's `pending` counts the page it just leased
     * you — a one-message drain reports pending:1 and only reads 0 after the
     * ack — so a caller looping on it never terminates. hasMoreMail does the
     * comparison that actually means "come back". Measured, not assumed.
     */
    more: hasMoreMail(page),
    pending: Number(page?.pending || 0),
  }
}

/* Drain until the inbox is genuinely empty, bounded so a relay that keeps
 * reporting more can never hold this worker forever. */
async function drainRelayUntilEmpty(relayConfig, macConfig, maxPages = 5) {
  let report = await drainRelayOnce(relayConfig, macConfig)
  let totals = { ...report, pages: 1 }
  for (let page = 1; page < maxPages && report.more; page += 1) {
    report = await drainRelayOnce(relayConfig, macConfig)
    totals = {
      drained: totals.drained + report.drained,
      ran: totals.ran + report.ran,
      ignored: totals.ignored + report.ignored,
      more: report.more,
      pending: report.pending,
      pages: page + 1,
    }
  }
  return totals
}

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
  ensureMeshSocket(relayConfig, () =>
    drainRelayUntilEmpty(relayConfig, macConfig).catch((error) =>
      console.warn(`mesh doorbell drain failed: ${error?.message || error}`),
    ),
  )

  while (Date.now() < deadline && revision === configRevision) {
    const choice = choosePeer({
      macConfigured: Boolean(macConfig.agentToken),
      macLastOkAt,
      relayReady: true,
      socketOpen: meshSocketOpen,
    })

    try {
      const report = await drainRelayUntilEmpty(relayConfig, macConfig)
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
       * sends `not_your_inbox`, which relayFetch forwards. A code-less
       * refusal (older relay, future route) still lands on the precise
       * generic fix rather than "unknown". */
      const failure = describeRelayFailure(error)
      await updateRelayStatus({
        ...failure,
        connected: false,
        transport: meshSocketOpen ? 'socket' : 'poll',
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

async function updateRelayStatus(patch) {
  const current = (await api.storage.local.get(RELAY_STATUS_KEY))[RELAY_STATUS_KEY] ?? {}
  await api.storage.local.set({
    [RELAY_STATUS_KEY]: { ...current, ...patch, updatedAt: new Date().toISOString() },
  })
}

/**
 * The owner's answer to one approval card, from the popup.
 *
 * Order is the contract: SEND the decision, THEN persist the settle, THEN ack
 * the request envelope. A decision recorded but never sent would read as
 * answered while the requester waits forever; a decision sent but not
 * recorded merely invites a duplicate answer, which the relay's approvalId
 * makes idempotent — so the settle waits for the send. The whole
 * check-send-settle runs inside the approval write chain, which is what makes
 * two frantic clicks land as one answer and one "answered once" refusal.
 */
async function decideApproval({ approvalId, decision }) {
  const relayConfig = await getRelayConfig()
  if (!relayConfig.ready) {
    return { ok: false, error: relayConfig.reason || 'The relay peer is switched off.' }
  }

  let outcome = { ok: false, error: 'The decision was not sent.' }
  try {
    await withApprovals(async (stored) => {
      const prepared = prepareApprovalDecision(stored, String(approvalId ?? ''), decision, {
        config: relayConfig,
      })
      if (!prepared.ok) {
        outcome = { ok: false, error: prepared.error }
        return null
      }

      await relayFetch(relayConfig, prepared.request)

      /* Ack AFTER the send. Usually a no-op — the drain acked on receipt —
       * but it covers a re-sent copy the store adopted after that ack, and a
       * failed ack costs one redelivery the approvalId dedupe absorbs. */
      try {
        await relayFetch(relayConfig, ackRequest(relayConfig, [prepared.envelopeId]))
      } catch {
        /* The lease will lapse; the settled card swallows the redelivery. */
      }

      outcome = { ok: true, decision }
      return prepared.prompts
    })
  } catch (error) {
    outcome = { ok: false, error: error?.message || String(error) }
  }

  await refreshBadge()
  return outcome
}

/**
 * Run one command, then take everything it produced through the privacy
 * boundary and stamp it with where it came from.
 *
 * The order is the whole point. sanitizeExtraction runs after execution and
 * before the result is handed back to pollOnce, which is the last moment it is
 * still inside Safari: past here it is in a different process with a log, a
 * store and a cloud relay attached, and a credential that reaches the agent has
 * effectively left the machine.
 */
async function executeCommand(command, config) {
  /*
   * Normalized before the gate, for every source at once: the Mac's poll loop,
   * mesh mail, an affinity-claimed plan step and the brain's own tool calls all
   * arrive here. A command that came via the Mac was already filtered by
   * browserSessions.toWireParams, so this is a no-op for it; the paths that
   * skip the Mac entirely are the ones that need it, and putting it at the one
   * seam they share is what stops the next path from forgetting.
   *
   * It only removes what cannot be honoured. validateCommand is still the gate
   * and still refuses everything it refused before.
   */
  const { type, params } = validateCommand({
    ...command,
    action: {
      ...command?.action,
      params: normalizeCommandParams(command?.action?.params),
    },
  })
  const { result, tab } = await runCommand(type, params, config)
  const clean = sanitizeExtraction(result)

  return {
    ...clean.result,
    provenance: provenanceFor({
      command,
      tab,
      result: clean.result,
      locator: params.ref || params.selector,
    }),
  }
}

async function runCommand(type, params, config) {
  if (type === 'navigate') {
    return { result: await navigate(params, config), tab: null }
  }

  if (type === 'activate_tab') {
    return { result: await activateTab(params, config), tab: null }
  }

  if (type === 'list_tabs') {
    return { result: await listTabs(params), tab: null }
  }

  const tab = await selectTargetTab(params, config.targetMode)
  await assertPageAccess(tab)

  if (type === 'capture') {
    return { result: await captureTab(tab), tab }
  }

  if (type === 'wait_for') {
    return { result: await waitForInTab(tab, params), tab }
  }

  const injection = await api.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: runInPage,
    args: [type, params],
  })
  const firstResult = injection?.[0]

  if (!firstResult) {
    throw new Error('The browser returned no result from the active page.')
  }

  if (firstResult.error) {
    throw new Error(firstResult.error.message || String(firstResult.error))
  }

  return {
    result: {
      ...firstResult.result,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? '',
      title: tab.title ?? firstResult.result?.title ?? '',
    },
    tab,
  }
}

async function waitForInTab(tab, params) {
  const timeoutMs = Math.max(
    100,
    Math.min(Number(params.timeoutMs) || 10_000, 30_000),
  )
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const injection = await api.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: checkWaitCondition,
      args: [params],
    })
    const ok = injection?.[0]?.result === true
    if (ok) {
      return {
        message: 'wait_for satisfied',
        waitedMs: Date.now() - started,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url ?? '',
      }
    }
    await delay(150)
  }
  throw new Error(`wait_for timed out after ${timeoutMs}ms`)
}

/** Injected: returns true if wait condition holds. */
function checkWaitCondition(params) {
  const selector = String(params.selector || '').trim()
  const textNeedle = String(params.textContains || params.text || '')
    .trim()
    .toLowerCase()
  if (selector) {
    try {
      const el = document.querySelector(selector)
      if (el) {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        if (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          return true
        }
      }
    } catch {
      throw new Error(`Invalid CSS selector: ${selector}`)
    }
  }
  if (textNeedle) {
    const bodyText = (document.body?.innerText || '').toLowerCase()
    if (bodyText.includes(textNeedle)) return true
  }
  return false
}

async function listTabs(params = {}) {
  const max = Math.max(1, Math.min(Number(params.limit) || 30, 80))
  const tabs = await api.tabs.query({})
  const rows = tabs
    .filter((tab) => isScriptableUrl(tab?.url))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .slice(0, max)
    .map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      active: Boolean(tab.active),
      title: String(tab.title || '').slice(0, 120),
      // Full URL for agent targeting; fleet heartbeat still uses origin only.
      url: tab.url || '',
      origin: isScriptableUrl(tab.url) ? new URL(tab.url).origin : '',
    }))

  return {
    message: `${rows.length} open web tab(s)`,
    tabs: rows,
    tabCount: rows.length,
  }
}

async function captureTab(tab) {
  const windowId = tab.windowId
  // Capture the tab's window; may capture active tab in that window.
  if (tab.active === false) {
    await api.tabs.update(tab.id, { active: true })
    await delay(150)
  }
  const dataUrl = await api.tabs.captureVisibleTab(windowId, {
    format: 'png',
  })
  return {
    message: 'Captured visible tab',
    tabId: tab.id,
    windowId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    mimeType: 'image/png',
    // Data URL can be large; Mac agent should not forward to cloud by default.
    imageDataUrl: dataUrl,
  }
}

async function navigate(params, config) {
  const url = validateNavigationUrl(params.url)
  const openNewTab = params.newTab === true || config.targetMode === 'new-tab'
  let tab

  if (openNewTab) {
    tab = await api.tabs.create({
      url,
      active: params.active !== false,
      ...(Number.isInteger(params.windowId) ? { windowId: params.windowId } : {}),
    })
  } else {
    tab = await selectTargetTab(params, config.targetMode)
    tab = await api.tabs.update(tab.id, {
      url,
      active: params.active !== false,
    })
  }

  if (params.waitForLoad !== false) {
    tab = await waitForTabLoad(tab.id, 15_000)
  }

  return {
    message: `Navigated to ${url}`,
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || url,
  }
}

/**
 * Find-or-open. Focuses the freshest existing tab matching `urlContains`
 * (bringing its window forward), and only when nothing matches — and a `url`
 * was given — opens a new tab. "Open ibkr" means the signed-in tab the owner
 * already has, not a duplicate and not whatever the active tab was showing.
 * Needs only the `tabs` permission (already in the manifest); windows.update
 * requires none.
 */
async function activateTab(params, _config) {
  const needle = String(params.urlContains ?? '').trim().toLowerCase()
  const fallbackUrl = String(params.url ?? '').trim()

  if (needle) {
    const tabs = await api.tabs.query({})
    const match = tabs
      .filter(
        (tab) =>
          Number.isInteger(tab?.id) &&
          isScriptableUrl(tab.url) &&
          String(tab.url).toLowerCase().includes(needle),
      )
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]

    if (match) {
      const tab = await api.tabs.update(match.id, { active: true })
      if (api.windows?.update && Number.isInteger(tab?.windowId)) {
        await api.windows.update(tab.windowId, { focused: true }).catch(() => {})
      }
      return {
        message: `Activated the existing tab matching "${needle}"`,
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url ?? match.url ?? '',
        title: tab.title ?? match.title ?? '',
        activatedExisting: true,
      }
    }
  }

  if (!fallbackUrl) {
    throw new Error(
      `No open tab matches "${needle}" and no url was given to open instead.`,
    )
  }

  const url = validateNavigationUrl(fallbackUrl)
  let tab = await api.tabs.create({ url, active: true })
  if (params.waitForLoad !== false) {
    tab = await waitForTabLoad(tab.id, 15_000)
  }
  return {
    message: `No matching tab was open; opened ${url}`,
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url || url,
    activatedExisting: false,
  }
}

async function selectTargetTab(params, targetMode) {
  if (Number.isInteger(params.tabId)) {
    return api.tabs.get(params.tabId)
  }

  let tabs
  if (Number.isInteger(params.windowId)) {
    tabs = await api.tabs.query({ windowId: params.windowId })
  } else if (params.urlContains) {
    tabs = await api.tabs.query({})
  } else if (targetMode === 'current-active') {
    tabs = await api.tabs.query({ active: true, currentWindow: true })
  } else {
    tabs = await api.tabs.query({ active: true })
  }

  const tab = pickTargetTab(tabs, params, targetMode)
  if (tab) return tab

  throw new Error(
    'No matching browser tab is available. Open a web page or specify a valid tabId.',
  )
}

async function assertPageAccess(tab) {
  if (!tab?.id || !isScriptableUrl(tab.url)) {
    throw new Error(
      'This page cannot be controlled. Browser settings, extension pages, and local files are protected.',
    )
  }

  const pattern = originPattern(tab.url)
  const granted = await api.permissions.contains({ origins: [pattern] })
  if (!granted) {
    throw new Error(
      `Website access is not granted for ${new URL(tab.url).origin}. Click “Allow this browser’s pages” in the extension popup.`,
    )
  }
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(async () => {
      cleanup()
      try {
        resolve(await api.tabs.get(tabId))
      } catch {
        reject(new Error('The destination tab closed before it finished loading.'))
      }
    }, timeoutMs)

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup()
        resolve(tab)
      }
    }

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        cleanup()
        reject(new Error('The destination tab closed before it finished loading.'))
      }
    }

    const cleanup = () => {
      clearTimeout(timeout)
      api.tabs.onUpdated.removeListener(onUpdated)
      api.tabs.onRemoved.removeListener(onRemoved)
    }

    api.tabs.onUpdated.addListener(onUpdated)
    api.tabs.onRemoved.addListener(onRemoved)
  })
}

/**
 * Injected into the page (isolated world). Keep pure-page; no chrome.* APIs.
 */
function runInPage(type, params) {
  const ATTR = 'data-pendant-ref'
  const MAX_ELEMENTS = 80

  const cssPath = (el) => {
    if (!(el instanceof Element)) return ''
    if (el.id) {
      const id = CSS.escape(el.id)
      if (document.querySelectorAll(`#${id}`).length === 1) return `#${id}`
    }
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.nodeName.toLowerCase()
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        break
      }
      const parent = node.parentElement
      if (parent) {
        const siblings = [...parent.children].filter(
          (c) => c.nodeName === node.nodeName,
        )
        if (siblings.length > 1) {
          const index = siblings.indexOf(node) + 1
          part += `:nth-of-type(${index})`
        }
      }
      parts.unshift(part)
      node = parent
    }
    return parts.join(' > ')
  }

  const resolveElement = () => {
    if (params.ref) {
      const ref = String(params.ref).trim()
      const byAttr = document.querySelector(`[${ATTR}="${ref.replace(/"/g, '')}"]`)
      if (byAttr) return byAttr
      throw new Error(
        `Snapshot ref not found: ${ref}. Call snapshot again and use a fresh ref.`,
      )
    }
    const selector = String(params.selector ?? '')
    let element
    try {
      element = document.querySelector(selector)
    } catch {
      throw new Error(`Invalid CSS selector: ${selector}`)
    }
    if (!element) throw new Error(`Element not found: ${selector}`)
    return element
  }

  const isVisible = (el) => {
    if (!(el instanceof Element)) return false
    if (
      !el.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
      })
    ) {
      return false
    }
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria.trim().slice(0, 120)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .filter(Boolean)
        .join(' ')
        .trim()
      if (text) return text.slice(0, 120)
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const lab = el.labels?.[0]?.innerText
      if (lab) return lab.trim().slice(0, 120)
      if (el.placeholder) return el.placeholder.trim().slice(0, 120)
      if (el.name) return el.name.slice(0, 120)
    }
    if (el instanceof HTMLSelectElement && el.name) return el.name.slice(0, 120)
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    return text.slice(0, 120)
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'submit' || t === 'button') return 'button'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return tag
  }

  if (type === 'snapshot') {
    const max = Math.max(
      1,
      Math.min(Number(params.maxElements) || MAX_ELEMENTS, MAX_ELEMENTS),
    )
    document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR))

    const selector =
      'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="menuitem"], [contenteditable="true"]'
    const candidates = [...document.querySelectorAll(selector)].filter(
      (el) => isVisible(el) && !el.closest('[aria-hidden="true"]'),
    )

    const elements = []
    for (const el of candidates) {
      if (elements.length >= max) break
      if (
        el instanceof HTMLInputElement &&
        (el.type === 'hidden' || el.type === 'password') &&
        params.includeSensitive !== true
      ) {
        if (el.type === 'hidden') continue
        // password: include as role only, no value
      }
      const ref = `e${elements.length}`
      el.setAttribute(ATTR, ref)
      const rect = el.getBoundingClientRect()
      elements.push({
        ref,
        role: roleOf(el),
        name: accessibleName(el),
        tag: el.tagName.toLowerCase(),
        selector: cssPath(el),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        checked:
          el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
            ? Boolean(el.checked)
            : el.getAttribute('aria-checked') === 'true'
              ? true
              : undefined,
        href: el instanceof HTMLAnchorElement ? el.href?.slice(0, 300) : undefined,
        inputType:
          el instanceof HTMLInputElement ? (el.type || 'text').toLowerCase() : undefined,
        /* Not for the agent to act on — these are what the privacy boundary
         * classifies with. A field's own name and autocomplete token are the
         * only reliable way to tell a card number from a quantity box, and
         * without them every snapshot ships credential fields as plain
         * textboxes. sanitizeExtraction strips fieldName back out for anything
         * it classifies as sensitive. */
        fieldName: el.getAttribute?.('name') || undefined,
        autocomplete: el.getAttribute?.('autocomplete') || undefined,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      })
    }

    return {
      message: `Snapshot: ${elements.length} interactive element(s)`,
      title: document.title,
      url: location.href,
      elementCount: elements.length,
      elements,
    }
  }

  if (type === 'click') {
    const element = resolveElement()
    element.scrollIntoView({ block: 'center', inline: 'center' })
    element.click()
    const label = params.ref || params.selector
    return { message: `Clicked ${label}` }
  }

  if (type === 'type') {
    const element = resolveElement()
    if (
      element instanceof HTMLInputElement &&
      element.type === 'password' &&
      params.allowSensitiveInput !== true
    ) {
      throw new Error(
        'Typing into password fields requires allowSensitiveInput=true.',
      )
    }

    const text = String(params.text ?? '')
    element.focus()

    if (element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set
      setter?.call(element, text)
    } else if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set
      setter?.call(element, text)
    } else if (element.isContentEditable) {
      element.textContent = text
    } else {
      throw new Error('The selected element is not editable.')
    }

    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: text,
      }),
    )
    element.dispatchEvent(new Event('change', { bubbles: true }))

    if (params.submit) {
      if (element.form?.requestSubmit) {
        element.form.requestSubmit()
      } else {
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
          }),
        )
      }
    }

    return { message: `Typed into ${params.ref || params.selector}` }
  }

  if (type === 'select') {
    const element = resolveElement()
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error('select requires a <select> element.')
    }
    const value = String(params.value ?? '')
    const label = String(params.label ?? '')
    let matched = false
    for (const opt of element.options) {
      if (
        (value && opt.value === value) ||
        (label && opt.textContent.trim() === label) ||
        (label && opt.textContent.trim().includes(label))
      ) {
        element.value = opt.value
        matched = true
        break
      }
    }
    if (!matched) throw new Error('No matching option for select.')
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { message: `Selected option on ${params.ref || params.selector}` }
  }

  if (type === 'scroll') {
    if (params.selector || params.ref) {
      const element = resolveElement()
      element.scrollIntoView({
        block: params.block || 'center',
        inline: 'nearest',
        behavior: 'instant',
      })
      return { message: `Scrolled to ${params.ref || params.selector}` }
    }
    const dy = Number(params.dy) || 0
    const dx = Number(params.dx) || 0
    window.scrollBy(dx, dy)
    return { message: `Scrolled by (${dx}, ${dy})` }
  }

  if (type === 'press_key') {
    const key = String(params.key || '')
    const target =
      params.selector || params.ref ? resolveElement() : document.activeElement || document.body
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, code: key, bubbles: true }),
    )
    target.dispatchEvent(
      new KeyboardEvent('keyup', { key, code: key, bubbles: true }),
    )
    return { message: `Pressed ${key}` }
  }

  if (type === 'read_page') {
    const maximum = Math.max(
      1,
      Math.min(Number(params.maxChars) || 12_000, 50_000),
    )
    const mode = String(params.mode || 'text')

    if (params.selector || params.ref) {
      const element = resolveElement()
      const content =
        mode === 'html'
          ? element.outerHTML
          : element.innerText || element.textContent || ''
      return {
        message: 'Read selected content',
        content: String(content ?? '').slice(0, maximum),
        title: document.title,
        mode,
      }
    }

    let content = ''
    if (mode === 'html') {
      content = document.documentElement?.outerHTML || ''
    } else if (mode === 'forms') {
      content = [...document.querySelectorAll('form')]
        .map((form, i) => {
          const fields = [...form.querySelectorAll('input,select,textarea')]
            .map((el) => {
              const name = el.name || el.id || el.getAttribute('aria-label') || el.type
              const kind = el.tagName.toLowerCase()
              return `  - ${kind}${el.type ? `[${el.type}]` : ''} name=${name}`
            })
            .join('\n')
          return `form#${i}\n${fields}`
        })
        .join('\n\n')
    } else if (mode === 'landmarks') {
      content = [
        ...document.querySelectorAll(
          'main, nav, header, footer, [role="main"], [role="navigation"], h1, h2',
        ),
      ]
        .map((el) => {
          const tag = el.tagName.toLowerCase()
          const name = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160)
          return `${tag}: ${name}`
        })
        .join('\n')
    } else if (mode === 'main_text') {
      const main =
        document.querySelector('main, [role="main"], article') || document.body
      content = main?.innerText || ''
    } else {
      content = document.body?.innerText || ''
    }

    return {
      message: `Read page (${mode})`,
      content: String(content ?? '').slice(0, maximum),
      title: document.title,
      mode,
    }
  }

  throw new Error(`Unsupported browser command: ${type}`)
}

/* ===================================================================== *
 * Popup command console: the owner's own commands, sent from the popup to
 * the Mac agent's plan/execute machinery. Distinct from the poll loop above,
 * which carries the AGENT's commands into this browser.
 * ===================================================================== */

/*
 * storage.local has no transactions, so every read-modify-write of the
 * history list goes through this one chain; two commands finishing at the
 * same moment must not eat each other's entries.
 */
let historyWrites = Promise.resolve()

function withHistory(mutate) {
  historyWrites = historyWrites
    .then(async () => {
      const values = await api.storage.local.get(HISTORY_KEY)
      const next = mutate(values[HISTORY_KEY] ?? [])
      await api.storage.local.set({ [HISTORY_KEY]: next })
    })
    .catch((error) => {
      console.warn('console history write failed:', error?.message || error)
    })
  return historyWrites
}

const patchEntry = (id, patch) =>
  withHistory((history) => patchHistory(history, id, patch))

/**
 * POST one console leg to the agent and interpret the response. Unlike the
 * poll-loop `request()` this gets a long timeout: a /plan can sit in a model
 * stream for most of a minute and that is normal, not an outage.
 */
async function consolePost(config, path, payload, timeoutMs, interpret) {
  try {
    const response = await fetch(`${config.agentUrl}${path}`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json().catch(() => null)
    return interpret({ status: response.status, payload: body })
  } catch (error) {
    return {
      kind: 'error',
      message:
        error?.name === 'TimeoutError'
          ? `The local agent did not answer within ${Math.round(timeoutMs / 1000)}s. Check the dashboard — the job may still be running.`
          : error?.message || String(error),
    }
  }
}

/* ===================================================================== *
 * Local execution: the journal, the hive record, and approved-step runs.
 * ===================================================================== */

/*
 * One journal per worker incarnation, lazily built over storage.local so a
 * run's trace survives the worker being suspended mid-run (Safari does this
 * freely). See execution-status.js for the storage-key contract.
 */
let journalInstance = null

function executionJournal() {
  if (!journalInstance) {
    journalInstance = createExecutionJournal({ storage: api.storage.local })
  }
  return journalInstance
}

/**
 * Tell the hive about a locally executed run — the owner's rule: "it should
 * stay in the browser extension but of course it can record the task to the
 * hive." Sent as node-mesh mail addressed to '@relay', which the Mac agent
 * can NEVER claim: cloud-relay/nodeMailbox.js lets only an inbox's owner
 * drain it and only an admin principal owns '@relay'. A record, not a job.
 *
 * Best effort by design: an unconfigured or unreachable relay must not stop
 * local execution, but the run's own status says whether the hive heard.
 */
async function recordRunToHive(runId, phase) {
  const journal = executionJournal()
  const relayConfig = await getRelayConfig()
  if (!relayConfig.ready) {
    await journal.markHiveRecord(runId, 'unconfigured')
    return
  }

  const run = (await journal.getStatus()).runs.find((entry) => entry.runId === runId)
  if (!run) return

  try {
    const descriptor =
      phase === 'claim'
        ? hiveClaimRecordFor(run, relayConfig)
        : hiveVerdictRecordFor(run, relayConfig)
    await relayFetch(relayConfig, descriptor)
    await journal.markHiveRecord(
      runId,
      phase === 'claim' ? 'claimed-recorded' : 'recorded',
    )
  } catch (error) {
    await journal.markHiveRecord(runId, `failed: ${error?.message || error}`)
  }
}

async function handleConsoleSubmit({ command, page }) {
  const text = String(command ?? '').trim()
  if (!text) return { ok: false, error: 'Type a command first.' }

  const config = await getConfig()
  /*
   * A brain of its own is enough to accept a command. The Mac token used to be
   * the only way in, so a browser with a relay credential and no agent token
   * was told to go to settings for a peer it no longer needs.
   */
  const brain = await brainAvailability()
  if (!config.agentToken && !brain.ok) return { ok: false, needsSetup: true }

  const id = crypto.randomUUID()
  const scrubbedPage = scrubPageContext(page)
  await withHistory((history) =>
    appendHistory(history, newHistoryEntry({ id, command: text, page: scrubbedPage })),
  )

  /* The submit reply only says "accepted". The outcome lands in storage,
   * which the popup renders live — and still renders after being closed
   * and reopened, which a sendMessage reply would not survive. */
  void runConsoleCommand({ id, command: text, page: scrubbedPage, config }).catch(
    (error) =>
      patchEntry(id, {
        state: 'failed',
        headline: error?.message || String(error),
        finishedAt: new Date().toISOString(),
      }),
  )

  return { ok: true, id }
}

async function runConsoleCommand({ id, command, page, config }) {
  /*
   * THIS NODE THINKS FIRST.
   *
   * The affinity argument, one storey up from where affinity.js makes it: a
   * command typed into a browser, about a page in that browser, has no reason
   * to cross a room to be understood. The brain runs here, and the Mac is
   * asked only when this node says it cannot do it — no relay credential, a
   * relay that told this device to back off, or the model itself calling
   * handoff because the task needs files, shell or another machine.
   *
   * A handoff is only clean while nothing has run. runBrainLocally enforces
   * that: once it has touched a page it finishes and reports rather than
   * letting the Mac replay the same steps.
   */
  const brain = await brainAvailability()
  if (brain.ok) {
    await patchEntry(id, { headline: 'Thinking in this browser…' })
    const outcome = await runBrainLocally({
      id,
      command,
      page,
      config,
      relayConfig: brain.relayConfig,
    })
    if (!outcome.handoff) return

    if (!config.agentToken) {
      await patchEntry(id, {
        state: 'failed',
        headline: `This browser could not do it and there is no Mac agent configured: ${outcome.reason}`,
        finishedAt: new Date().toISOString(),
      })
      return
    }
    await patchEntry(id, { headline: `Handing this to the Mac — ${outcome.reason}` })
  } else if (!config.agentToken) {
    await patchEntry(id, {
      state: 'failed',
      headline: brain.reason,
      finishedAt: new Date().toISOString(),
    })
    return
  }

  const commandText = buildCommandText(command, page)
  /* Both channels, deliberately: `context` for an agent that has the field,
   * the trailer inside commandText for one that does not. An agent with both
   * drops the trailer — see command-console.js buildCommandText. */
  const context = commandContext(page)
  const stored = await api.storage.local.get(SESSION_KEY)
  const sessionId = String(stored[SESSION_KEY] ?? '').trim()

  const planOutcome = await consolePost(
    config,
    '/plan',
    {
      command: commandText,
      ...(context ? { context } : {}),
      ...(sessionId ? { sessionId } : {}),
      source: CONSOLE_SOURCE,
    },
    PLAN_TIMEOUT_MS,
    interpretPlanResponse,
  )

  /* The agent minted (or confirmed) the conversation; keep following it. */
  if (planOutcome.sessionId) {
    await api.storage.local.set({ [SESSION_KEY]: planOutcome.sessionId })
  }

  if (planOutcome.kind !== 'execute') {
    await patchEntry(id, outcomeToPatch(planOutcome))
    return
  }

  /*
   * AFFINITY ROUTING (the fix for "open ibkr" opening on the Mac). The
   * planner said requiresConfirmation:false and handed back actions. Before
   * those actions are POSTed to /execute — which runs them ON THE MAC, in the
   * Mac's own browser session for open_url — every step is capability-tagged.
   * A plan that is entirely browser work executes HERE, through the same
   * validated executor agent-issued commands use. One non-browser step
   * anywhere and the whole plan forwards to the hive exactly as before.
   *
   * Plans the planner itself parked (kind 'parked') are NOT intercepted: the
   * Mac has already recorded that plan_ready job, its dashboard is the one
   * approval surface for it, and a second local approval surface for the same
   * plan would be two buttons that can each fire the same actions once.
   */
  const affinity = routePlan(planOutcome.actions)
  if (affinity.route === CAPABILITY_BROWSER) {
    await patchEntry(id, {
      headline: 'Plan is all browser work — running it in this browser…',
    })
    await executePlanLocally({ id, command, steps: affinity.steps, config })
    return
  }

  /* The planner said requiresConfirmation:false — the one case the popup
   * executes on its own. Everything else parked above. */
  await patchEntry(id, { headline: 'Plan ready — executing…' })

  const executeOutcome = await consolePost(
    config,
    '/execute',
    {
      command: commandText,
      ...(context ? { context } : {}),
      actions: planOutcome.actions,
      ...(planOutcome.sessionId ? { sessionId: planOutcome.sessionId } : {}),
      planMeta: { planner: planOutcome.planner ?? null, source: CONSOLE_SOURCE },
      source: CONSOLE_SOURCE,
    },
    EXECUTE_TIMEOUT_MS,
    interpretExecuteResponse,
  )

  await patchEntry(id, outcomeToPatch(executeOutcome))
}

/**
 * Execute a fully browser-capable plan on this node.
 *
 * Steps run in order through the SAME validateCommand → runCommand →
 * sanitizeExtraction path every agent-issued command takes — a locally
 * claimed plan gets no shortcut past the privacy boundary. An outward step
 * stops the run and parks in the approval queue; a failed step stops the run
 * honestly rather than pressing on into a page in an unknown state.
 */
async function executePlanLocally({ id, command, steps, config }) {
  const journal = executionJournal()
  await journal.beginRun({ runId: id, command, route: 'local-plan' })
  await recordRunToHive(id, 'claim')

  const parked = []
  for (const step of steps) {
    if (step.effect === EFFECT_OUTWARD) {
      /* The park point is the stop point. Steps after the outward one do NOT
       * run on approval — approving runs exactly the parked step — and that
       * is said out loud rather than discovered. */
      const remaining = steps.length - step.index - 1
      parked.push(
        await journal.parkStep(id, {
          call: step.localCall,
          effect: step.effect,
          reason:
            step.effectReason +
            (remaining
              ? ` (${remaining} later plan step(s) will not run either way — re-run the command after deciding.)`
              : ''),
          targetName: step.label,
        }),
      )
      break
    }

    try {
      const result = await executeCommand(
        {
          commandId: `local-${id}-${step.index}`,
          createdAt: new Date().toISOString(),
          action: step.localCall,
        },
        config,
      )
      await journal.recordStep(id, {
        tool: step.localCall.type,
        effect: step.effect,
        ok: true,
        summary: String(result?.message ?? step.label).slice(0, 300),
      })
    } catch (error) {
      const message = error?.message || String(error)
      await journal.recordStep(id, {
        tool: step.localCall.type,
        effect: step.effect,
        ok: false,
        summary: message.slice(0, 300),
      })
      const runState = (await journal.getStatus()).runs.find((run) => run.runId === id)
      const verdict = honestVerdict({ command, steps: runState?.steps ?? [], parked: [] })
      await journal.finishRun(id, {
        state: 'failed',
        verdict: 'failed',
        headline: `Stopped at step ${step.index + 1} (${step.label}): ${message}`,
        detail: verdict.detail,
      })
      await recordRunToHive(id, 'verdict')
      await patchEntry(id, {
        state: 'failed',
        headline: `Stopped at step ${step.index + 1} (${step.label}): ${message}`,
        detail: verdict.detail,
        finishedAt: new Date().toISOString(),
      })
      return
    }
  }

  const runState = (await journal.getStatus()).runs.find((run) => run.runId === id)
  const verdict = honestVerdict({ command, steps: runState?.steps ?? [], parked })
  await journal.finishRun(id, {
    state: parked.length ? 'parked' : 'finished',
    ...verdict,
  })
  await recordRunToHive(id, 'verdict')

  await patchEntry(id, {
    state: parked.length
      ? 'parked'
      : verdict.verdict === 'incomplete'
        ? 'failed'
        : 'executed',
    headline: verdict.headline,
    detail: [
      `Ran in this browser (affinity: all steps browser-capable).`,
      verdict.detail,
      ...(parked.length
        ? [
            `The parked step (${parked[0].id}) has not run. Approve below to run ` +
              'exactly that step — nothing after it runs either way.',
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n'),
    /* The parked step travels with the entry so Approve can run THAT call,
     * not a re-plan of it. Only the first one: the run stopped there. */
    pending: parked.length
      ? localStepPending({
          call: parked[0].call,
          effect: parked[0].effect,
          reason: parked[0].reason,
          runId: id,
          approvalId: parked[0].id,
        })
      : null,
    finishedAt: new Date().toISOString(),
  })
}

/* ===================================================================== *
 * THE BRAIN LOOP.
 *
 * The owner: "it needs one." Until now every command in this popup went to the
 * Mac's POST /plan to be thought about, so a browser that was awake, signed in
 * and looking at the page still could not act unless a laptop was awake too.
 * This is the loop that removes that: think on the relay (POST /v1/infer,
 * whose `llm:infer` scope the browser_node credential already holds), act
 * here, and never let the model be the one who says what happened.
 *
 * The pure half — tools, prompt, parsing, transcript bounds, how a relay
 * refusal is read — is brain.js. This function is the effects: the fetch, the
 * executor, the guard, the journal.
 *
 * FOUR THINGS THIS LOOP WILL NOT DO, in the order they would otherwise bite:
 *
 *   1. RUN A VERB THE EXECUTOR HAS NOT VETTED. Every call goes through the
 *      same executeCommand → validateCommand → sanitizeExtraction path an
 *      agent-issued command takes. A locally-thought step gets no shortcut
 *      past the privacy boundary.
 *   2. WALK PAST AN OUTWARD STEP. createOutwardGuard (affinity.js) watches
 *      every snapshot go by so it knows what the PAGE calls each ref, then
 *      assesses each call against the words the owner would have read. Outward
 *      parks the run. This is that guard's first caller; it was written for
 *      this loop.
 *   3. LET THE MODEL GRADE ITSELF. honestVerdict computes the headline from
 *      the ledger of executed steps. The model's `answer` survives as colour
 *      inside it, never as the claim.
 *   4. KEEP ASKING A RELAY THAT SAID STOP. A `retryAfter` on any refusal parks
 *      the brain for that long — device-scoped, per the relay's own contract —
 *      and the command hands off to the Mac instead of failing.
 * ===================================================================== */

/*
 * When the brain may next be asked, as an epoch ms. Set from a relay refusal
 * that carried `retryAfter`. In memory on purpose: a suspended worker forgets
 * it and asks once more, which costs one refusal and cannot get stuck holding
 * a cooldown that the relay has long since lifted.
 */
let brainParkedUntil = 0

/** Can this node think for itself right now, and if not, why not? */
async function brainAvailability(now = Date.now()) {
  const relayConfig = await getRelayConfig()
  if (!relayConfig.ready) {
    return { ok: false, reason: 'No relay credential is configured, so this browser has no brain of its own.' }
  }
  if (brainParkedUntil > now) {
    return {
      ok: false,
      reason: `The relay asked this device to stop calling its brain for another ${Math.ceil((brainParkedUntil - now) / 1000)}s.`,
    }
  }
  return { ok: true, relayConfig }
}

/** One turn: ask the relay, and read the answer strictly. */
async function brainTurn(relayConfig, transcript) {
  let payload
  try {
    payload = await relayFetch(
      relayConfig,
      inferRequest(relayConfig, transcript.messages()),
      /* A model turn is not a 7s poll. Under the relay's own 60s upstream
       * timeout, so the relay's error arrives rather than this one. */
      70_000,
    )
  } catch (error) {
    const failure = describeInferFailure(error)
    if (failure.parkBrain) brainParkedUntil = Date.now() + failure.retryAfter * 1_000
    return { kind: 'unavailable', ...failure }
  }

  const read = readInferPayload(payload)
  /* A truncated or filtered answer is the model's problem, not the relay's:
   * tell the model and let it try again inside the step budget. */
  if (!read.ok) return { kind: 'retry', error: read.error, raw: '' }

  const reply = parseBrainReply(read.content)
  if (reply.kind === 'error') return { kind: 'retry', error: reply.error, raw: read.content }
  return { ...reply, raw: read.content }
}

/**
 * Think and act in this browser until the task is done, parked, or out of
 * steps. Writes the same journal and history a Mac-planned run writes, so
 * nothing downstream has to know which brain produced it.
 */
async function runBrainLocally({ id, command, page, config, relayConfig }) {
  const journal = executionJournal()
  const guard = createOutwardGuard()
  const transcript = createBrainTranscript({ command, page })

  await journal.beginRun({ runId: id, command, route: 'local-brain', executor: 'browser-brain' })
  await recordRunToHive(id, 'claim')

  const parked = []
  let answer = ''
  let steps = 0

  /*
   * A handed-off run still has to be CLOSED here. beginRun above opened it as
   * 'executing', and a run left in that state is a run the status pane shows
   * spinning forever over work that has moved to another machine.
   */
  const handOff = async (reason) => {
    await journal.finishRun(id, {
      state: 'finished',
      verdict: 'handed-off',
      headline: `Handed to the Mac: ${reason}`,
      detail: `This node ran ${steps} step(s) of thinking and executed nothing.`,
    })
    await recordRunToHive(id, 'verdict')
    return { handoff: true, reason, steps }
  }

  while (steps < BRAIN_MAX_STEPS) {
    const turn = await brainTurn(relayConfig, transcript)

    /* The relay is unreachable or has told this device to back off. Nothing
     * has been claimed that the Mac cannot also do, so hand the command back
     * rather than failing it. */
    if (turn.kind === 'unavailable') {
      return await handOff(turn.message)
    }

    if (turn.kind === 'retry') {
      /* Feed the complaint back as the "result" of the turn: the model is the
       * one that can fix a malformed reply, and this costs one step. */
      transcript.pushAssistant(turn.raw || '')
      transcript.pushResult(`That reply could not be used: ${turn.error}`)
      steps += 1
      continue
    }

    transcript.pushAssistant(turn.raw)

    if (turn.kind === 'handoff') {
      /* Only a handoff BEFORE anything ran is a clean handoff. Once this
       * browser has touched a page, sending the same command to the Mac would
       * run those steps a second time. */
      const ran = (await journal.getStatus()).runs.find((run) => run.runId === id)
      if (!(ran?.steps ?? []).length) return await handOff(turn.reason)
      answer = `Stopped: ${turn.reason}`
      break
    }

    if (turn.kind === 'answer') {
      answer = turn.answer
      break
    }

    /* A tool call. The guard decides whether it may run unattended. */
    const assessment = guard.assess(turn.call)
    if (!assessment.allow) {
      parked.push(
        await journal.parkStep(id, {
          call: turn.call,
          effect: assessment.effect,
          reason: assessment.reason,
          targetName: assessment.targetName,
        }),
      )
      break
    }

    try {
      const result = await executeCommand(
        {
          commandId: `brain-${id}-${steps}`,
          createdAt: new Date().toISOString(),
          action: turn.call,
        },
        config,
      )
      /* The guard learns each ref's accessible name from snapshots going past,
       * so a later {click, ref:"e4"} is judged on the words the OWNER would
       * have read rather than on an opaque token. */
      guard.observe(turn.call, result)
      await journal.recordStep(id, {
        tool: turn.call.type,
        effect: assessment.effect,
        ok: true,
        summary: String(result?.message ?? turn.call.type).slice(0, 300),
      })
      transcript.pushResult(compactToolResult(turn.call.type, result))
    } catch (error) {
      const message = error?.message || String(error)
      await journal.recordStep(id, {
        tool: turn.call.type,
        effect: assessment.effect,
        ok: false,
        summary: message.slice(0, 300),
      })
      /* A failed step is information, not the end: the model is told and gets
       * to try something else inside the same budget. */
      transcript.pushResult(`That step failed: ${message}`)
    }

    steps += 1
  }

  const runState = (await journal.getStatus()).runs.find((run) => run.runId === id)
  const executed = runState?.steps ?? []

  if (!executed.length && !parked.length && !answer) {
    /* Nothing thought, nothing ran — the Mac can still have a go. */
    return await handOff('this browser produced no usable step')
  }

  const exhausted = steps >= BRAIN_MAX_STEPS && !answer && !parked.length
  const verdict = honestVerdict({
    command,
    steps: executed,
    parked,
    response: answer,
  })

  await journal.finishRun(id, {
    state: parked.length ? 'parked' : 'finished',
    ...verdict,
  })
  await recordRunToHive(id, 'verdict')

  await patchEntry(id, {
    state: parked.length
      ? 'parked'
      : verdict.verdict === 'incomplete' || exhausted
        ? 'failed'
        : 'executed',
    headline: exhausted
      ? `Stopped after ${BRAIN_MAX_STEPS} steps without finishing. ${verdict.headline}`
      : verdict.headline,
    detail: [
      'Thought and run in this browser (brain: relay inference, execution: this node).',
      verdict.detail,
      ...(parked.length
        ? [
            'The parked step has not run. Approve below to run exactly that step — ' +
              'nothing after it runs either way.',
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n'),
    pending: parked.length
      ? localStepPending({
          call: parked[0].call,
          effect: parked[0].effect,
          reason: parked[0].reason,
          runId: id,
          approvalId: parked[0].id,
        })
      : null,
    finishedAt: new Date().toISOString(),
  })

  return { handoff: false, steps }
}

/* ===================================================================== *
 * Deciding a parked plan FROM THE POPUP.
 *
 * The owner: "i shouldn't have to open up the dashboard to approve." So the
 * popup's Approve/Deny lands here, and this is where the two things a button
 * cannot know are checked:
 *
 *   1. IS IT STILL WAITING? For a Mac-planned park the agent holds the truth
 *      as a `plan_ready` job, and both this popup and the dashboard can reach
 *      it. Re-reading the job before executing is what stops the same plan
 *      running twice — the first surface to approve moves the job off
 *      `plan_ready`, and the second is told so in the agent's own words. This
 *      is the same guard the dashboard's own approve path uses.
 *   2. IS IT STILL FRESH? planDecisionPreflight, shared with the popup so a
 *      pressable button is always a working button.
 * ===================================================================== */

async function decidePlan({ id, decision }) {
  const entryId = String(id ?? '')
  const history = (await api.storage.local.get(HISTORY_KEY))[HISTORY_KEY] ?? []
  const entry = (Array.isArray(history) ? history : []).find(
    (candidate) => candidate?.id === entryId,
  )

  const preflight = planDecisionPreflight(entry)
  if (!preflight.ok) return { ok: false, error: preflight.error }
  const { pending } = preflight

  if (decision === 'deny') return denyPlan(entry, pending)
  if (decision !== 'approve') {
    return { ok: false, error: `Unknown decision "${decision}".` }
  }

  const config = await getConfig()
  if (!config.agentToken) return { ok: false, needsSetup: true }

  if (pending.kind === 'mac-plan') {
    /* The agent is the arbiter. A plan the dashboard already approved is no
     * longer plan_ready, and saying so is better than running it again. */
    const stillWaiting = await confirmPlanStillWaiting(config, pending.jobId)
    if (!stillWaiting.ok) return stillWaiting
  }

  /* Claimed: the entry goes back to 'working' before anything runs, so a
   * second click (or a second popup) finds no parked plan to press. */
  await patchEntry(entryId, {
    state: 'working',
    headline: 'Approved — running it…',
    pending: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  })

  void runApprovedPlan({ entry, pending, config }).catch((error) =>
    patchEntry(entryId, {
      state: 'failed',
      headline: error?.message || String(error),
      finishedAt: new Date().toISOString(),
    }),
  )

  return { ok: true }
}

/**
 * Deny: the plan does not run, and the Mac's parked job is dismissed so the
 * dashboard does not keep offering the same decision the owner just made.
 * A dismissal that fails is reported on the entry rather than swallowed —
 * "denied here, still parked there" is a state worth seeing.
 */
async function denyPlan(entry, pending) {
  let note = ''
  if (pending.kind === 'mac-plan' && pending.jobId) {
    const config = await getConfig()
    try {
      const response = await fetch(
        `${config.agentUrl}/jobs/${encodeURIComponent(pending.jobId)}/dismiss`,
        {
          method: 'POST',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${config.agentToken}`,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        note = `The Mac still lists this plan as parked (HTTP ${response.status}).`
      }
    } catch (error) {
      note = `The Mac was not told (${error?.message || error}), so its dashboard may still offer this plan.`
    }
  }

  await patchEntry(entry.id, {
    state: 'denied',
    headline: 'Denied — nothing ran.',
    detail: [entry.detail, note].filter(Boolean).join('\n'),
    pending: null,
    finishedAt: new Date().toISOString(),
  })
  return { ok: true, note }
}

/** Is the Mac's parked job still waiting for a decision? */
async function confirmPlanStillWaiting(config, jobId) {
  /* A plan with no job id was never recorded on the Mac (an older agent, or a
   * /plan that answered without one). There is nothing to race with. */
  if (!jobId) return { ok: true }

  try {
    const response = await fetch(
      `${config.agentUrl}/jobs/${encodeURIComponent(jobId)}`,
      {
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.agentToken}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    )
    if (response.status === 404) return { ok: true }
    if (!response.ok) {
      return {
        ok: false,
        error: `The Mac would not confirm this plan is still waiting (HTTP ${response.status}).`,
      }
    }
    const body = await response.json().catch(() => null)
    const job = body?.job ?? body
    const status = String(job?.status ?? '')
    if (status && status !== 'plan_ready') {
      return {
        ok: false,
        error: `This plan is no longer waiting: the Mac now reports "${status}". It may already have been approved on the dashboard.`,
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the Mac to check this plan is still waiting (${error?.message || error}).`,
    }
  }
}

/** Run what was approved — the whole plan, or the single parked step. */
async function runApprovedPlan({ entry, pending, config }) {
  if (pending.kind === 'local-step') {
    await runApprovedStep({ entry, pending, config })
    return
  }

  /* Same affinity rule the first pass used: browser-only work runs here, in
   * front of the owner's signed-in tabs, and anything else goes to the Mac. */
  const affinity = routePlan(pending.actions)
  if (affinity.route === CAPABILITY_BROWSER) {
    await executePlanLocally({
      id: entry.id,
      command: entry.command,
      steps: affinity.steps,
      config,
    })
    return
  }

  /* Both channels here too — see buildCommandText on why the trailer stays. */
  const approvedContext = commandContext(entry.page)
  const outcome = await consolePost(
    config,
    '/execute',
    {
      command: buildCommandText(entry.command, entry.page),
      ...(approvedContext ? { context: approvedContext } : {}),
      actions: pending.actions,
      ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
      planMeta: { planner: pending.planner ?? null, source: CONSOLE_SOURCE },
      source: CONSOLE_SOURCE,
    },
    EXECUTE_TIMEOUT_MS,
    interpretExecuteResponse,
  )
  await patchEntry(entry.id, outcomeToPatch(outcome))
}

/**
 * The approved outward step, run alone.
 *
 * Only this call runs. The steps that would have followed it did not run and
 * are not resumed — the run that parked has already reported what it did, and
 * quietly continuing past the approval point would make that report a lie.
 * The verdict says so out loud.
 */
async function runApprovedStep({ entry, pending, config }) {
  const journal = executionJournal()
  const runId = pending.runId || entry.id

  try {
    const result = await executeCommand(
      {
        commandId: `approved-${runId}`,
        createdAt: new Date().toISOString(),
        action: pending.call,
      },
      config,
    )
    await journal.recordStep(runId, {
      tool: pending.call.type,
      effect: pending.effect,
      ok: true,
      summary: String(result?.message ?? 'Approved step ran.').slice(0, 300),
    })
    await journal.finishRun(runId, {
      state: 'finished',
      verdict: 'achieved',
      headline: `Approved and ran: ${pending.call.type}.`,
    })
    await recordRunToHive(runId, 'verdict')
    await patchEntry(entry.id, {
      state: 'executed',
      headline: `You approved it and it ran: ${result?.message || pending.call.type}.`,
      detail:
        'Only the approved step ran. Any later steps from the original plan did not — send the command again if more is left to do.',
      finishedAt: new Date().toISOString(),
    })
  } catch (error) {
    const message = error?.message || String(error)
    await journal.recordStep(runId, {
      tool: pending.call.type,
      effect: pending.effect,
      ok: false,
      summary: message.slice(0, 300),
    })
    await journal.finishRun(runId, {
      state: 'failed',
      verdict: 'failed',
      headline: `The approved step failed: ${message}`,
    })
    await recordRunToHive(runId, 'verdict')
    await patchEntry(entry.id, {
      state: 'failed',
      headline: `The approved step failed: ${message}`,
      finishedAt: new Date().toISOString(),
    })
  }
}

function browserLabel() {
  const userAgent = globalThis.navigator?.userAgent ?? ''
  if (/Edg\//.test(userAgent)) return 'Microsoft Edge'
  if (/Firefox\//.test(userAgent)) return 'Firefox'
  if (/Chrome\//.test(userAgent)) return 'Google Chrome'
  if (/Safari\//.test(userAgent)) return 'Safari'
  return 'Web Extension'
}

function platformLabel() {
  const platform = globalThis.navigator?.platform || 'Mac'
  return `${browserLabel()} on ${platform}`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    meshSocketRefused = false
    closeMeshSocket()
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
            socketOpen: meshSocketOpen,
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
