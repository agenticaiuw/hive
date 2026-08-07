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
}) {
  const now = new Date().toISOString()
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
    lastSeenAt: now,
  })
  pruneOfflineHeartbeats()

  return {
    ok: true,
    online: true,
    extensionId,
  }
}

export function getBrowserStatus() {
  const devices = [...HEARTBEATS.values()].map((device) => ({
    ...device,
    online: isOnline(device.lastSeenAt),
  }))

  return {
    online: devices.some((device) => device.online),
    devices,
    pendingCommands: pendingCommands.size,
  }
}

export function enqueueBrowserCommand(action) {
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

  const commandId = `browser_${crypto.randomUUID()}`
  const command = {
    commandId,
    action,
    createdAt: new Date().toISOString(),
    status: 'queued',
  }

  pendingCommands.set(commandId, command)
  return command
}

export function pollBrowserCommand(extensionId) {
  reclaimExpiredCommands()
  expireStaleCommands()

  if (!isExtensionOnline(extensionId)) {
    registerBrowserHeartbeat({ extensionId })
  }

  for (const command of pendingCommands.values()) {
    if (command.status === 'queued') {
      command.status = 'processing'
      command.claimedAt = new Date().toISOString()
      command.claimedBy = extensionId
      command.attempts = (command.attempts ?? 0) + 1
      return command
    }
  }

  return null
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
    ...command,
    status: payload.ok ? 'completed' : 'failed',
    completedAt: new Date().toISOString(),
    result: payload.result ?? null,
    error: payload.error ?? null,
  }

  results.set(commandId, result)
  pendingCommands.delete(commandId)
  pruneCompletedResults()
  return result
}

export function getBrowserCommandResult(commandId) {
  return results.get(commandId) ?? pendingCommands.get(commandId) ?? null
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

function isExtensionOnline(extensionId) {
  const heartbeat = HEARTBEATS.get(extensionId)
  return heartbeat ? isOnline(heartbeat.lastSeenAt) : false
}

function reclaimExpiredCommands() {
  const now = Date.now()

  for (const command of pendingCommands.values()) {
    if (
      command.status === 'processing' &&
      (!command.claimedAt ||
        now - new Date(command.claimedAt).getTime() >= COMMAND_LEASE_MS)
    ) {
      command.status = 'queued'
      command.claimedAt = null
      command.claimedBy = null
    }
  }
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

  for (const command of pendingCommands.values()) {
    if (now - new Date(command.createdAt).getTime() < COMMAND_TTL_MS) continue

    results.set(command.commandId, {
      ...command,
      status: 'failed',
      completedAt: new Date().toISOString(),
      result: null,
      error: `Expired after ${Math.round(COMMAND_TTL_MS / 1000)}s without an extension to run it.`,
      expired: true,
    })
    pendingCommands.delete(command.commandId)
  }

  pruneCompletedResults()
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
    results.set(command.commandId, {
      ...command,
      status: 'failed',
      completedAt: new Date().toISOString(),
      result: null,
      error: 'Cancelled before an extension ran it.',
      cancelled: true,
    })
    pendingCommands.delete(command.commandId)
  }

  pruneCompletedResults()
  return { cancelled: doomed.map((command) => command.commandId) }
}

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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
