import {
  isScriptableUrl,
  normalizeConfig,
  originPattern,
  pickTargetTab,
  retryDelay,
  validateCommand,
  validateNavigationUrl,
} from './bridge-core.js'

const api = globalThis.browser ?? globalThis.chrome
const POLL_ALARM = 'ai-pendant-poll'
const POLL_WINDOW_MS = 25_000
const POLL_INTERVAL_MS = 750
const HEARTBEAT_INTERVAL_MS = 12_000
const FETCH_TIMEOUT_MS = 7_000
const STATUS_KEY = 'bridgeStatus'
const CONFIG_KEYS = ['agentUrl', 'agentToken', 'deviceName', 'targetMode', 'instanceId']

let activePoll = null
let configRevision = 0

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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    return await fetch(`${config.agentUrl}${path}`, {
      ...options,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.agentToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
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
  return tab
    ? {
        tabId: tab.id ?? null,
        windowId: tab.windowId ?? null,
        tabUrl: isScriptableUrl(tab.url) ? new URL(tab.url).origin : '',
      }
    : { tabId: null, windowId: null, tabUrl: '' }
}

async function heartbeat(config) {
  const tab = await currentTabSummary()
  await postJson(config, '/browser/heartbeat', {
    extensionId: config.extensionId,
    deviceName: config.deviceName || platformLabel(),
    browserName: browserLabel(),
    extensionVersion: api.runtime.getManifest().version,
    userAgent: globalThis.navigator?.userAgent ?? '',
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
  let result

  try {
    result = { ok: true, result: await executeCommand(command, config) }
  } catch (error) {
    result = { ok: false, error: error?.message || String(error) }
  }

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
      message: 'Open settings and save the local agent token.',
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

  if (api.action?.setBadgeText) {
    await api.action.setBadgeText({
      text:
        status.state === 'connected'
          ? 'ON'
          : status.state === 'needs-setup'
            ? 'SET'
            : '!',
    })
    if (api.action.setBadgeBackgroundColor) {
      await api.action.setBadgeBackgroundColor({
        color: status.state === 'connected' ? '#078B70' : '#B54736',
      })
    }
  }
}

async function executeCommand(command, config) {
  const { type, params } = validateCommand(command)

  if (type === 'navigate') {
    return navigate(params, config)
  }

  const tab = await selectTargetTab(params, config.targetMode)
  await assertPageAccess(tab)

  const injection = await api.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: runInPage,
    args: [type, params],
  })
  const firstResult = injection?.[0]

  if (!firstResult) {
    throw new Error('The browser returned no result from the active page.')
  }

  return {
    ...firstResult.result,
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? '',
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
      `Website access is not granted for ${new URL(tab.url).origin}. Open the extension settings and grant website access.`,
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

function runInPage(type, params) {
  const findElement = () => {
    let element
    try {
      element = document.querySelector(params.selector)
    } catch {
      throw new Error(`Invalid CSS selector: ${params.selector}`)
    }
    if (!element) throw new Error(`Element not found: ${params.selector}`)
    return element
  }

  if (type === 'click') {
    const element = findElement()
    element.scrollIntoView({ block: 'center', inline: 'center' })
    element.click()
    return { message: `Clicked ${params.selector}` }
  }

  if (type === 'type') {
    const element = findElement()
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

    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    }))
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

    return { message: `Typed into ${params.selector}` }
  }

  if (type === 'read_page') {
    const maximum = Math.max(1, Math.min(Number(params.maxChars) || 12_000, 50_000))
    const element = params.selector ? findElement() : document.documentElement
    const content =
      params.mode === 'html'
        ? element.outerHTML
        : params.selector
          ? element.innerText || element.textContent || ''
          : document.body?.innerText || ''

    return {
      message: params.selector ? 'Read selected content' : 'Read page content',
      content: String(content ?? '').slice(0, maximum),
      title: document.title,
    }
  }

  throw new Error(`Unsupported browser command: ${type}`)
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

api.runtime.onInstalled.addListener(async ({ reason }) => {
  await migrateSyncedCredentials()
  await api.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 })
  if (reason === 'install') await api.runtime.openOptionsPage()
  void startPolling()
})

api.runtime.onStartup.addListener(async () => {
  await migrateSyncedCredentials()
  await api.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 })
  void startPolling()
})

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void startPolling()
})

api.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'local' &&
    ['agentUrl', 'agentToken', 'deviceName', 'targetMode'].some(
      (key) => changes[key],
    )
  ) {
    configRevision += 1
    void startPolling()
  }
})

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bridge:poll-now') {
    void startPolling().then(() => sendResponse({ ok: true }))
    return true
  }

  if (message?.type === 'bridge:get-status') {
    void api.storage.local
      .get(STATUS_KEY)
      .then((values) => sendResponse(values[STATUS_KEY] ?? null))
    return true
  }

  return false
})

void migrateSyncedCredentials()
  .then(() => api.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 }))
  .then(() => startPolling())
