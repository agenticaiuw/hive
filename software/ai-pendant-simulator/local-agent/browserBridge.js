const pendingCommands = new Map()
const results = new Map()
const HEARTBEATS = new Map()
const ONLINE_WINDOW_MS = 45_000

export function registerBrowserHeartbeat({ extensionId, tabId, userAgent }) {
  const now = new Date().toISOString()
  HEARTBEATS.set(extensionId, {
    extensionId,
    tabId: tabId ?? null,
    userAgent: userAgent ?? '',
    lastSeenAt: now,
  })

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
  if (!isExtensionOnline(extensionId)) {
    registerBrowserHeartbeat({ extensionId })
  }

  for (const command of pendingCommands.values()) {
    if (command.status === 'queued') {
      command.status = 'processing'
      command.claimedAt = new Date().toISOString()
      command.claimedBy = extensionId
      return command
    }
  }

  return null
}

export function completeBrowserCommand(commandId, payload) {
  const command = pendingCommands.get(commandId)

  if (!command) {
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
  return result
}

export function getBrowserCommandResult(commandId) {
  return results.get(commandId) ?? pendingCommands.get(commandId) ?? null
}

export async function waitForBrowserResult(commandId, timeoutMs = 20_000) {
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
