export const DEFAULT_AGENT_URL = 'http://127.0.0.1:8000'
export const DEFAULT_TARGET_MODE = 'last-focused'
export const MAX_SELECTOR_LENGTH = 2_000
export const MAX_TEXT_LENGTH = 50_000

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])
const TARGET_MODES = new Set(['last-focused', 'current-active', 'new-tab'])
const COMMAND_TYPES = new Set(['navigate', 'click', 'type', 'read_page'])

export function normalizeAgentUrl(value) {
  const candidate = String(value ?? '').trim() || DEFAULT_AGENT_URL
  let url

  try {
    url = new URL(candidate)
  } catch {
    throw new Error('Agent URL must be a valid URL.')
  }

  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      'Agent URL must use http://127.0.0.1 or http://localhost.',
    )
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Agent URL cannot contain credentials, a query, or a hash.')
  }

  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Agent URL must not contain a path.')
  }

  return url.origin
}

export function normalizeConfig(values = {}) {
  const targetMode = TARGET_MODES.has(values.targetMode)
    ? values.targetMode
    : DEFAULT_TARGET_MODE

  return {
    agentUrl: normalizeAgentUrl(values.agentUrl),
    agentToken: String(values.agentToken ?? '').trim(),
    deviceName: String(values.deviceName ?? '').trim().slice(0, 80),
    targetMode,
  }
}

export function validateNavigationUrl(value) {
  let url

  try {
    url = new URL(String(value ?? ''))
  } catch {
    throw new Error('The navigation command did not contain a valid URL.')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// navigation is allowed.')
  }

  return url.href
}

export function originPattern(value) {
  const url = new URL(value)
  return `${url.protocol}//${url.host}/*`
}

export function validateCommand(command) {
  if (!command || typeof command !== 'object') {
    throw new Error('The local agent sent an invalid browser command.')
  }

  const action = command.action
  const type = action?.type
  const params = action?.params ?? {}

  if (!COMMAND_TYPES.has(type)) {
    throw new Error(`Unsupported browser command: ${String(type ?? '')}`)
  }

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Browser command parameters must be an object.')
  }

  if (type === 'navigate') {
    validateNavigationUrl(params.url)
  }

  if (type === 'click' || type === 'type') {
    const selector = String(params.selector ?? '')
    if (!selector || selector.length > MAX_SELECTOR_LENGTH) {
      throw new Error('A valid, reasonably sized CSS selector is required.')
    }
  }

  if (type === 'type' && String(params.text ?? '').length > MAX_TEXT_LENGTH) {
    throw new Error(`Typed text is limited to ${MAX_TEXT_LENGTH} characters.`)
  }

  if (
    params.tabId !== undefined &&
    (!Number.isInteger(params.tabId) || params.tabId < 0)
  ) {
    throw new Error('tabId must be a non-negative integer.')
  }

  if (
    params.windowId !== undefined &&
    (!Number.isInteger(params.windowId) || params.windowId < 0)
  ) {
    throw new Error('windowId must be a non-negative integer.')
  }

  return { type, params }
}

export function pickTargetTab(tabs, params = {}, targetMode = DEFAULT_TARGET_MODE) {
  const candidates = tabs.filter((tab) => Number.isInteger(tab?.id))

  if (Number.isInteger(params.tabId)) {
    return candidates.find((tab) => tab.id === params.tabId) ?? null
  }

  const urlNeedle = String(params.urlContains ?? '').trim().toLowerCase()
  if (urlNeedle) {
    return (
      candidates
        .filter((tab) => String(tab.url ?? '').toLowerCase().includes(urlNeedle))
        .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ??
      null
    )
  }

  if (Number.isInteger(params.windowId)) {
    return (
      candidates.find(
        (tab) => tab.windowId === params.windowId && tab.active === true,
      ) ?? null
    )
  }

  if (targetMode === 'current-active') {
    return candidates.find((tab) => tab.active === true) ?? null
  }

  return (
    candidates
      .filter((tab) => tab.active === true)
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ??
    null
  )
}

export function isScriptableUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export function retryDelay(attempt, baseMs = 750, maximumMs = 15_000) {
  const boundedAttempt = Math.max(0, Math.min(Number(attempt) || 0, 8))
  return Math.min(maximumMs, baseMs * 2 ** boundedAttempt)
}
