const pendingCommands = new Map()
const results = new Map()
const HEARTBEATS = new Map()
const ONLINE_WINDOW_MS = 70_000
const COMMAND_LEASE_MS = 45_000
const MAX_COMPLETED_RESULTS = 200

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
