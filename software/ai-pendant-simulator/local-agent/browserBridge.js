import { setTimeout as sleep } from 'node:timers/promises'
import {
  clearBrowserSpool,
  readBrowserSpool,
  spoolBrowserCommand,
} from './browserSpool.js'

const pendingCommands = new Map()
const results = new Map()
const HEARTBEATS = new Map()
const ONLINE_WINDOW_MS = 70_000
const COMMAND_LEASE_MS = 45_000
const MAX_COMPLETED_RESULTS = 200

/*
 * A queued command outlives the caller that asked for it. waitForBrowserResult
 * gives up after 45s, so past that there is nobody left to return an answer to
 * — but the command stayed in the map, and the next extension to connect would
 * run it. Observed live: a fan-out against an offline extension left five
 * queued navigations that would have opened tabs in the owner's Safari
 * whenever it next came online, possibly hours later and unrelated to anything
 * they were doing.
 *
 * Twice the caller's own timeout, so a command still in flight for a caller
 * that is still waiting is never taken away from it.
 */
const COMMAND_TTL_MS = 90_000

/*
 * How long an idempotency key keeps its answer.
 *
 * Long enough that a caller which retried after giving up at 45s still gets the
 * original command back rather than starting a second one; short enough that a
 * key reused an hour later means what the caller meant by it. Bounded by
 * MAX_IDEMPOTENCY_KEYS so a caller that mints a fresh key per call — the normal
 * case — cannot grow this without limit.
 */
const IDEMPOTENCY_TTL_MS = 10 * 60_000
const MAX_IDEMPOTENCY_KEYS = 500

/* sessionId -> the extension that last completed work for it. */
const SESSION_AFFINITY = new Map()
const MAX_SESSION_AFFINITY = 200

/* Where browserSessions.js puts a session name. Read here rather than required
 * of the caller so existing browser_* callers get affinity without changing. */
const SESSION_PARAM_KEYS = ['session', 'sessionId', 'browserSession', 'sessionName']

/* Counted rather than read back: getBrowserStatus is on /health and /observe,
 * and neither should touch the disk to answer. */
const spoolCounters = { spooled: 0, lastReason: null, lastAt: null }

let spoolPath = null

/**
 * Point the offline spool somewhere else (tests, or a second agent instance).
 * Passing null restores the default in browserSpool.js.
 */
export function configureBrowserBridge({ spoolPath: nextSpoolPath } = {}) {
  spoolPath = nextSpoolPath ?? null
  return { spoolPath }
}

function spool(command, reason, detail = '') {
  spoolCounters.spooled += 1
  spoolCounters.lastReason = reason
  spoolCounters.lastAt = new Date().toISOString()

  try {
    return spoolBrowserCommand(
      {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey ?? null,
        sessionId: command.sessionId ?? null,
        affinity: command.affinity ?? null,
        action: redactAction(command.action),
        reason,
        detail,
        attempts: command.attempts ?? 0,
        browserOnline: anyExtensionOnline(),
        queuedAt: command.createdAt,
      },
      spoolPath ? { filePath: spoolPath } : {},
    )
  } catch (error) {
    /* The spool is a record, not a dependency. A bridge that refuses to retire
     * a dead command because it could not write a note about it would hold the
     * queue open for exactly the reason the queue must not stay open. */
    console.warn('browser spool write failed:', error?.message || error)
    return null
  }
}

/* ------------------------------------------------------------- redaction */

/*
 * Params whose value is a secret the moment the command is written down.
 *
 * The retained record is built by spreading the command — `{...command}` — so
 * before this existed a `type` command carrying a password kept that password
 * in the completed-results map for the life of 200 more commands, and handed it
 * straight back out of POST /browser/result/:commandId. The extension needs the
 * real text; nothing downstream of the extension does.
 */
const SECRET_SELECTOR = /pass|pwd|otp|totp|mfa|cvv|cvc|csc|card|secret|token|pin\b/i

function isSecretBearing(action) {
  if (action?.type !== 'type') return false
  const params = action.params ?? {}
  if (params.allowSensitiveInput === true) return true
  return SECRET_SELECTOR.test(String(params.selector ?? params.ref ?? ''))
}

/** The command as it is safe to keep, log, and return. */
export function redactAction(action) {
  if (!action || typeof action !== 'object') return action
  if (!isSecretBearing(action)) return action

  const text = String(action.params?.text ?? '')
  return {
    ...action,
    params: {
      ...action.params,
      text: `[withheld ${text.length} chars]`,
    },
    secretsWithheld: ['text'],
  }
}

function redactRecord(command) {
  if (!command || !isSecretBearing(command.action)) return command
  return { ...command, action: redactAction(command.action) }
}

/* ------------------------------------------------------------- heartbeats */

export function registerBrowserHeartbeat({
  extensionId,
  tabId,
  windowId,
  tabUrl,
  tabTitle,
  tabCount,
  userAgent,
  deviceName,
  browserName,
  extensionVersion,
  nonce,
  capabilities,
}) {
  const now = new Date().toISOString()
  const previous = HEARTBEATS.get(extensionId)
  const nextNonce = String(nonce ?? '')

  HEARTBEATS.set(extensionId, {
    extensionId,
    tabId: tabId ?? null,
    windowId: windowId ?? null,
    // Origin-only from extension heartbeat (no path/query).
    tabUrl: tabUrl ?? '',
    tabTitle: String(tabTitle || '').slice(0, 80),
    tabCount: Number.isFinite(Number(tabCount)) ? Number(tabCount) : null,
    userAgent: userAgent ?? '',
    deviceName: deviceName ?? '',
    browserName: browserName ?? '',
    extensionVersion: extensionVersion ?? '',
    nonce: nextNonce,
    capabilities: Array.isArray(capabilities) ? capabilities.slice(0, 12) : [],
    lastSeenAt: now,
  })

  /*
   * A changed nonce is the extension telling us it restarted.
   *
   * The extensionId is stable across a service-worker restart, so without this
   * the agent cannot tell a suspended worker from a slow one and waits out the
   * full 45s lease before doing anything. Worse, the restarted worker has lost
   * its own idempotency ledger, so it no longer knows whether it already ran
   * what it was holding. Both facts point the same way: retire the lease now,
   * and do not hand the command to anyone.
   */
  let orphaned = []
  if (previous && previous.nonce && nextNonce && previous.nonce !== nextNonce) {
    orphaned = orphanCommandsFor(
      extensionId,
      'The browser extension restarted while holding this command, so whether it ran cannot be established.',
    )
  }

  pruneOfflineHeartbeats()

  return {
    ok: true,
    online: true,
    extensionId,
    ...(orphaned.length ? { orphaned } : {}),
  }
}

export function getBrowserStatus() {
  const devices = [...HEARTBEATS.values()].map((device) => ({
    ...device,
    online: isOnline(device.lastSeenAt),
    staleForMs: device.lastSeenAt
      ? Date.now() - new Date(device.lastSeenAt).getTime()
      : null,
  }))

  return {
    online: devices.some((device) => device.online),
    devices,
    pendingCommands: pendingCommands.size,
    /* Nothing here reads the spool file: getBrowserStatus answers /health and
     * /observe, and a status call must not depend on the disk. */
    spool: { ...spoolCounters },
    affinity: [...SESSION_AFFINITY.entries()].map(([sessionId, entry]) => ({
      sessionId,
      ...entry,
    })),
  }
}

/* ------------------------------------------------------------ idempotency */

/* idempotencyKey -> { commandId, storedAt } */
const IDEMPOTENCY = new Map()

function pruneIdempotency() {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS

  for (const [key, entry] of IDEMPOTENCY) {
    if (new Date(entry.storedAt).getTime() < cutoff) IDEMPOTENCY.delete(key)
  }

  /* Insertion-ordered, so the first key is the oldest. */
  while (IDEMPOTENCY.size > MAX_IDEMPOTENCY_KEYS) {
    IDEMPOTENCY.delete(IDEMPOTENCY.keys().next().value)
  }
}

function sessionIdFrom(action, explicit) {
  const named = String(explicit ?? '').trim()
  if (named) return named.slice(0, 80)

  const params = action?.params ?? {}
  for (const key of SESSION_PARAM_KEYS) {
    const value = String(params?.[key] ?? '').trim()
    if (value) return value.slice(0, 80)
  }

  /*
   * The session name never reaches here from the caller that has one.
   *
   * browserSessions.js resolves the session, then strips its own control params
   * out of what goes on the wire (toWireParams drops session/sessionId/…), so
   * by the time a command is enqueued the only trace of which task it belongs
   * to is the urlContains needle the session targets with. That needle is a
   * perfectly good session identity — it is literally "the page this task is
   * working in" — and using it means the existing caller gets affinity without
   * having to be changed by an agent that does not own that file.
   */
  const needle = String(params?.urlContains ?? '').trim()
  return needle ? `url:${needle.slice(0, 76)}` : null
}

/* ---------------------------------------------------------------- queueing */

/**
 * Queue one command for the browser.
 *
 * @param action  {type, params, label} — unchanged, this is the whole contract
 *                for every existing caller.
 * @param options.idempotencyKey  Two enqueues sharing a key are one act. The
 *                second returns the first's command or its finished result
 *                instead of starting a second one, so a caller that retried
 *                because it stopped waiting cannot make the click happen twice.
 * @param options.extensionId  Hard affinity: only this device may run it.
 * @param options.sessionId    Soft affinity: prefer the device that last served
 *                this session, because a tabId only means anything to the
 *                extension context that issued it (Safari renumbers tabs
 *                per-context — see browserSessions.js).
 */
export function enqueueBrowserCommand(action, options = {}) {
  /*
   * Sweep here too, not only on poll.
   *
   * Expiry used to run only from pollBrowserCommand, which quietly assumed an
   * extension would eventually connect. When one never does — the state this
   * system has actually been in all day, `online: false` with a device row
   * whose last heartbeat is hours old — nothing ever ran the sweep, and the
   * queue grew without bound. Two commands were sitting in it when this was
   * found, which is exactly the condition the TTL was added to prevent.
   *
   * Enqueue is the right second place because it is the only event guaranteed
   * to happen when the queue is growing: whatever else is broken, something
   * putting work in is something that can pay for retiring the dead work.
   */
  expireStaleCommands()

  const idempotencyKey =
    String(options.idempotencyKey ?? action?.idempotencyKey ?? '').trim().slice(0, 200) ||
    null

  if (idempotencyKey) {
    pruneIdempotency()
    const seen = IDEMPOTENCY.get(idempotencyKey)
    const existing = seen
      ? (pendingCommands.get(seen.commandId) ?? results.get(seen.commandId))
      : null

    /* The same act, asked for twice. Hand back what the first one is doing or
     * what it did — never a second command against the same page. */
    if (existing) return { ...redactRecord(existing), deduplicated: true }
  }

  const sessionId = sessionIdFrom(action, options.sessionId)
  const commandId = `browser_${crypto.randomUUID()}`
  const command = {
    commandId,
    action,
    createdAt: new Date().toISOString(),
    status: 'queued',
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(affinityFor(options.extensionId, sessionId) ?? {}),
  }

  pendingCommands.set(commandId, command)
  if (idempotencyKey) {
    IDEMPOTENCY.set(idempotencyKey, { commandId, storedAt: command.createdAt })
    pruneIdempotency()
  }

  return redactRecord(command)
}

function affinityFor(explicitExtensionId, sessionId) {
  const hard = String(explicitExtensionId ?? '').trim()
  if (hard) return { affinity: { extensionId: hard, hard: true } }

  const learned = sessionId ? SESSION_AFFINITY.get(sessionId) : null
  if (!learned) return null

  /*
   * Soft, and only while that device is answering. A session's tab lives in one
   * browser; sending its next command to a different device silently retargets
   * the task at a different page. But a pin to a device that has gone away must
   * not hold the work hostage — the pin is dropped, not honoured, when the
   * device is offline.
   */
  return { affinity: { extensionId: learned.extensionId, hard: false } }
}

export function pollBrowserCommand(extensionId) {
  orphanExpiredLeases()
  expireStaleCommands()

  if (!isExtensionOnline(extensionId)) {
    registerBrowserHeartbeat({ extensionId })
  }

  for (const command of pendingCommands.values()) {
    if (command.status !== 'queued') continue
    if (!mayRun(command, extensionId)) continue

    command.status = 'processing'
    command.claimedAt = new Date().toISOString()
    command.claimedBy = extensionId
    command.claimedNonce = HEARTBEATS.get(extensionId)?.nonce ?? ''
    command.attempts = (command.attempts ?? 0) + 1
    return command
  }

  return null
}

function mayRun(command, extensionId) {
  const affinity = command.affinity
  if (!affinity?.extensionId) return true
  if (affinity.extensionId === extensionId) return true
  /* A soft pin yields once the device it names stops answering; a hard pin
   * never does, and simply expires with the TTL like anything else. */
  return !affinity.hard && !isExtensionOnline(affinity.extensionId)
}

/* ----------------------------------------------------------------- results */

const RESULT_TYPES = {
  navigate: 'navigation',
  read_page: 'page_text',
  snapshot: 'element_snapshot',
  list_tabs: 'tab_list',
  capture: 'screenshot',
  wait_for: 'condition',
  click: 'interaction',
  type: 'interaction',
  select: 'interaction',
  scroll: 'interaction',
  press_key: 'interaction',
}

/**
 * Give a result a name and a place it came from.
 *
 * A browser reading used to arrive as an untyped bag whose shape the caller had
 * to guess from the command it sent — and, once stored, from nothing at all. A
 * stored extraction with no tab, no URL and no timestamp cannot be re-taken,
 * cannot be dated, and cannot be argued with.
 *
 * The extension stamps its own provenance (it is the only side that knows where
 * the tab actually ended up); this adds what only the agent knows — which
 * command, which session, which device, and when it was asked for. Both are
 * kept: a requested URL that differs from the landed one is a fact worth
 * seeing, not a discrepancy to resolve.
 */
function typedResult(command, payload, extensionId) {
  const raw = payload.result
  const action = command.action ?? {}
  const page = raw && typeof raw === 'object' ? (raw.provenance ?? null) : null

  const provenance = {
    commandId: command.commandId,
    action: action.type ?? null,
    label: action.label ?? null,
    sessionId: command.sessionId ?? null,
    extensionId: extensionId ?? command.claimedBy ?? null,
    requestedAt: command.createdAt,
    completedAt: new Date().toISOString(),
    tabId: page?.tabId ?? (Number.isInteger(raw?.tabId) ? raw.tabId : null),
    windowId: page?.windowId ?? (Number.isInteger(raw?.windowId) ? raw.windowId : null),
    url: String(page?.url ?? raw?.url ?? ''),
    title: String(page?.title ?? raw?.title ?? '').slice(0, 200),
    locator: page?.locator ?? locatorOf(action.params),
    /* Whether the privacy boundary in the extension actually ran on this. An
     * older extension reports nothing here, and "unknown" is the honest answer
     * — not "clean". */
    privacy: raw?.privacy ?? null,
    observedAt: page?.observedAt ?? null,
  }

  const resultType = RESULT_TYPES[action.type] ?? 'unknown'

  if (raw === null || raw === undefined) {
    return { resultType, provenance }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { resultType, provenance, value: raw }
  }

  /* Additive: every existing reader of `result.tabs`, `result.content`,
   * `result.tabId` keeps working, and gets provenance alongside. */
  return { ...raw, resultType, provenance }
}

function locatorOf(params) {
  const ref = String(params?.ref ?? '').trim()
  if (ref) return ref
  const selector = String(params?.selector ?? '').trim()
  if (selector) return selector
  return 'document'
}

export function completeBrowserCommand(commandId, payload, extensionId = null) {
  const command = pendingCommands.get(commandId)

  if (!command) {
    return null
  }

  if (
    extensionId &&
    command.claimedBy &&
    command.claimedBy !== extensionId
  ) {
    return null
  }

  const result = {
    ...redactRecord(command),
    status: payload.ok ? 'completed' : 'failed',
    completedAt: new Date().toISOString(),
    result: payload.ok ? typedResult(command, payload, extensionId) : (payload.result ?? null),
    error: payload.error ?? null,
    ...(payload.replayed ? { replayed: true } : {}),
  }

  /* Learn where this session lives, so its next command goes to the same
   * browser rather than to whichever device happens to poll first. */
  const servedBy = extensionId ?? command.claimedBy
  if (command.sessionId && servedBy) {
    SESSION_AFFINITY.set(command.sessionId, {
      extensionId: servedBy,
      lastSeenAt: result.completedAt,
    })
    while (SESSION_AFFINITY.size > MAX_SESSION_AFFINITY) {
      SESSION_AFFINITY.delete(SESSION_AFFINITY.keys().next().value)
    }
  }

  results.set(commandId, result)
  pendingCommands.delete(commandId)
  pruneCompletedResults()
  return result
}

export function getBrowserCommandResult(commandId) {
  const record = results.get(commandId) ?? pendingCommands.get(commandId) ?? null
  return record ? redactRecord(record) : null
}

export async function waitForBrowserResult(commandId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const current = getBrowserCommandResult(commandId)

    if (current?.status === 'completed' || current?.status === 'failed') {
      return current
    }

    await sleep(400)
  }

  throw new Error('Browser extension did not respond in time.')
}

/* ------------------------------------------------------------- supervision */

function isExtensionOnline(extensionId) {
  const heartbeat = HEARTBEATS.get(extensionId)
  return heartbeat ? isOnline(heartbeat.lastSeenAt) : false
}

function anyExtensionOnline() {
  return [...HEARTBEATS.values()].some((device) => isOnline(device.lastSeenAt))
}

function finish(command, { error, ...flags }) {
  const record = {
    ...redactRecord(command),
    status: 'failed',
    completedAt: new Date().toISOString(),
    result: null,
    error,
    ...flags,
  }
  results.set(command.commandId, record)
  pendingCommands.delete(command.commandId)
  return record
}

/**
 * Retire a lease whose holder stopped answering. Do not re-queue it.
 *
 * This used to put the command back on the queue, which reads as generous and
 * is the one thing that must not happen: the lease is 45s and the caller's own
 * wait is 45s, so by the time a lease expires there is nobody left to receive
 * an answer — and the extension may well have run the command already and only
 * failed to post the result. Re-queueing turns "we never heard back" into a
 * second click on a real page.
 *
 * The extension's own ledger (bridge-core.js createCommandLedger) defends the
 * replay that this cannot see. This side's job is simply to stop asking.
 */
function orphanExpiredLeases() {
  const now = Date.now()
  const orphaned = []

  for (const command of [...pendingCommands.values()]) {
    if (command.status !== 'processing') continue

    const heldFor = command.claimedAt
      ? now - new Date(command.claimedAt).getTime()
      : Infinity
    if (heldFor < COMMAND_LEASE_MS) continue

    finish(command, {
      error:
        `The browser held this command for ${Math.round(heldFor / 1000)}s without answering. ` +
        'It is not retried: it may already have run, and running it twice would act on the page twice.',
      orphaned: true,
    })
    spool(command, 'lease-expired', `held ${Math.round(heldFor / 1000)}s`)
    orphaned.push(command.commandId)
  }

  return orphaned
}

function orphanCommandsFor(extensionId, reason) {
  const orphaned = []

  for (const command of [...pendingCommands.values()]) {
    if (command.status !== 'processing' || command.claimedBy !== extensionId) continue
    finish(command, { error: reason, orphaned: true })
    spool(command, 'extension-restarted', reason)
    orphaned.push(command.commandId)
  }

  return orphaned
}

/**
 * Retire commands nobody is waiting for any more.
 *
 * Expiry is a terminal result rather than a silent delete: a caller that comes
 * back for the id gets "expired" instead of null, which reads as an answer
 * rather than as the bridge having lost the command.
 */
function expireStaleCommands() {
  const now = Date.now()

  for (const command of [...pendingCommands.values()]) {
    if (now - new Date(command.createdAt).getTime() < COMMAND_TTL_MS) continue

    finish(command, {
      error: `Expired after ${Math.round(COMMAND_TTL_MS / 1000)}s without an extension to run it.`,
      expired: true,
    })
    /* Offline is the normal case here, so this is the spool's main feeder: it
     * is the only surviving evidence that the browser tier was asked for
     * something and never did it. */
    spool(command, 'expired', 'no extension ran it before the TTL')
  }

  pruneCompletedResults()
}

/**
 * One supervisor tick: notice devices that stopped heartbeating, retire the
 * leases they were holding, and expire what nobody is waiting for.
 *
 * Every other sweep in this module is a side effect of traffic — enqueue or
 * poll. When the extension is offline there is no poll, and when nothing is
 * being asked of the browser there is no enqueue, so on a quiet offline system
 * nothing runs at all. That is precisely the state this bridge spends most of
 * its life in.
 */
export function sweepBrowserBridge() {
  const before = pendingCommands.size
  const orphaned = orphanExpiredLeases()
  expireStaleCommands()
  pruneOfflineHeartbeats()

  const offline = [...HEARTBEATS.values()]
    .filter((device) => !isOnline(device.lastSeenAt))
    .map((device) => device.extensionId)

  return {
    sweptAt: new Date().toISOString(),
    pendingBefore: before,
    pendingAfter: pendingCommands.size,
    orphaned,
    offlineDevices: offline,
    online: anyExtensionOnline(),
  }
}

/**
 * Run the sweep on a timer. Returns a stop function.
 *
 * unref'd on purpose: a supervisor must never be the reason a process refuses
 * to exit, least of all one whose whole job is tidying up after absence.
 */
export function startBrowserBridgeSupervisor({ intervalMs = 30_000 } = {}) {
  const timer = setInterval(() => {
    try {
      sweepBrowserBridge()
    } catch (error) {
      console.warn('browser bridge sweep failed:', error?.message || error)
    }
  }, intervalMs)

  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Drop queued commands without impersonating an extension.
 *
 * Until this existed the only way to clear the queue was to register a fake
 * extension and poll each command through the real poll/result contract, which
 * is a trick rather than an interface — and one that leaves a phantom device
 * behind in the heartbeat registry.
 */
export function cancelBrowserCommands(commandId = null) {
  const doomed = commandId
    ? [pendingCommands.get(commandId)].filter(Boolean)
    : [...pendingCommands.values()]

  for (const command of doomed) {
    /* Not spooled: the spool is for work that was lost, and a cancellation is
     * a decision. Recording decisions as losses makes the list unreadable. */
    finish(command, {
      error: 'Cancelled before an extension ran it.',
      cancelled: true,
    })
  }

  pruneCompletedResults()
  return { cancelled: doomed.map((command) => command.commandId) }
}

/* ------------------------------------------------------------------ routes */

/**
 * Wire the durability surfaces onto an app.
 *
 * A registration function rather than route definitions in server.js: this
 * module owns what the routes mean, and server.js owns where they hang.
 */
export function registerBrowserBridgeRoutes(app, { basePath = '/browser' } = {}) {
  const routes = []

  const add = (method, routePath, handler) => {
    app[method](routePath, handler)
    routes.push(`${method.toUpperCase()} ${routePath}`)
  }

  add('get', `${basePath}/spool`, (_request, response) => {
    response.json({
      ok: true,
      ...readBrowserSpool(spoolPath ? { filePath: spoolPath } : {}),
    })
  })

  /* `{/:commandId}` and not `/:commandId?`: Express 5 uses path-to-regexp v8,
   * which removed the trailing-? optional syntax and THROWS on it at
   * registration. That throw is why the agent could not restart at all. */
  add('delete', `${basePath}/spool{/:commandId}`, (request, response) => {
    response.json({
      ok: true,
      ...clearBrowserSpool(
        request.params?.commandId ?? null,
        spoolPath ? { filePath: spoolPath } : {},
      ),
    })
  })

  add('post', `${basePath}/sweep`, (_request, response) => {
    response.json({ ok: true, ...sweepBrowserBridge() })
  })

  return routes
}

/* ----------------------------------------------------------------- pruning */

function pruneCompletedResults() {
  while (results.size > MAX_COMPLETED_RESULTS) {
    const oldestCommandId = results.keys().next().value
    results.delete(oldestCommandId)
  }
}

function pruneOfflineHeartbeats() {
  const staleBefore = Date.now() - ONLINE_WINDOW_MS * 4

  for (const [extensionId, heartbeat] of HEARTBEATS) {
    if (new Date(heartbeat.lastSeenAt).getTime() < staleBefore) {
      HEARTBEATS.delete(extensionId)
    }
  }
}

function isOnline(lastSeenAt) {
  if (!lastSeenAt) {
    return false
  }

  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS
}

