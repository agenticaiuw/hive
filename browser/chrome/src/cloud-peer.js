/*
 * The extension's way in from the cloud (owner, 2026-11-16: "every node should be able to reach every
 * other node: through the cloud"). Hive's agent on any node (the VM, a Mac) sends a command for the
 * owner's browser to the cloud board (cloud/tasks/browser.js); this asks the board for the next one
 * with the key Hive on this Mac put here (no pairing, nothing pasted), runs it with the same executor
 * every other path uses (executor.js executeCommand) and sends back what came of it.
 *
 * Each ask is held open by the cloud for up to ASK_WAIT_S, so an idle browser asks about three times a
 * minute and a command reaches it the moment it is sent. The cloud hands a command to one browser
 * once, marked running before it acts, so nothing here can run it twice. Safari stops this worker
 * when it likes; the background's alarm starts the loop again, and a command nobody took within 90 s
 * expires in the cloud instead of running late.
 */
import { BOARD_KEY, NO_BOARD, boardUrl } from './page-rules-core.js'
import { nodeHeaders } from './version.js'

export const ASK_WAIT_S = 20
/* Longer than the held ask, so only a dead connection times out. */
export const ASK_TIMEOUT_MS = (ASK_WAIT_S + 15) * 1000
export const CLOUD_STATUS_KEY = 'cloudPeerStatus'

const api = globalThis.browser ?? globalThis.chrome

/** 'chrome' or 'safari': which of the owner's browsers this is, as the cloud knows it. */
export const browserKind = (userAgent = globalThis.navigator?.userAgent || '') =>
  /Chrome|Chromium|Edg\//.test(userAgent) ? 'chrome' : 'safari'

/* Who answers "hive:key" on this Mac: Safari asks Hive.app's own extension handler (it ignores the
 * name); Chrome asks hive-tasks, which registers itself under this name
 * (NativeMessagingHosts/hive.board_key.json; hive-tasks chrome_host.rs). */
export const NATIVE_HOST = { safari: 'application.id', chrome: 'hive.board_key' }

/**
 * The key to the cloud board: the one kept here, or the one Hive on this Mac wrote
 * (~/.config/hive/extension.json), read through Hive's native handler: in Safari the app's
 * (SafariWebExtensionHandler.swift "hive:key"), in Chrome hive-tasks's.
 */
export async function boardKey(browserApi = api, kind = browserKind()) {
  const got = await browserApi.storage.local.get(BOARD_KEY)
  if (got[BOARD_KEY]?.key && boardUrl(got[BOARD_KEY])) return got[BOARD_KEY]
  if (typeof browserApi.runtime?.sendNativeMessage !== 'function') return null
  try {
    const answer = await browserApi.runtime.sendNativeMessage(NATIVE_HOST[kind] ?? NATIVE_HOST.safari, { type: 'hive:key' })
    if (answer?.ok && answer.key && boardUrl(answer)) {
      const board = { url: boardUrl(answer), key: answer.key }
      await browserApi.storage.local.set({ [BOARD_KEY]: board })
      return board
    }
  } catch {}
  return null
}

export class CloudError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

/** The browser a board key is for: "ext.chrome.<mac>" → "chrome". */
export const keyName = (key) => String(key || '').split('.')[1] || 'browser'

/** One call to the board with the extension's key, saying what this extension runs (version.js). */
export async function boardCall(board, path, body, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const base = boardUrl(board)
  if (!base) throw new CloudError(NO_BOARD, 0)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${board.key}`, 'content-type': 'application/json', ...nodeHeaders(keyName(board.key)) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new CloudError(value.error || `Hive's cloud said ${response.status}`, response.status)
    return value
  } finally {
    clearTimeout(timer)
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * What the toolbar badge and the popup say about reaching Hive through the cloud board: "ON" while the
 * board answers, "SET" while there is no key yet (Hive on this Mac hands one over), "!" when the board
 * can't be reached or refuses the key.
 */
export function connectionBadge(cloud = {}) {
  const c = cloud?.state
  if (c === 'connected') return { state: 'connected', text: 'ON', color: '#078B70' }
  if (c === 'off' || !c) return { state: 'needs-setup', text: c ? 'SET' : '', color: '#B54736' }
  return { state: c === 'unauthorized' ? 'unauthorized' : 'offline', text: '!', color: '#B54736' }
}

/**
 * Asks for commands and runs them until `shouldStop()` or the key is refused. Everything it touches
 * comes in `deps`, so node tests drive it with fakes.
 */
export async function runCloudPeer({
  browserApi = api,
  executeCommand,
  getConfig,
  onStatus = () => {},
  fetchImpl = fetch,
  kind = browserKind(),
  shouldStop = () => false,
  delay = pause,
  retryDelay = (failures) => Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)),
} = {}) {
  const status = (patch) =>
    browserApi.storage.local
      .set({ [CLOUD_STATUS_KEY]: { ...patch, kind, updatedAt: new Date().toISOString() } })
      .then(() => onStatus(patch))
      .catch(() => {})
  let failures = 0
  while (!shouldStop()) {
    const board = await boardKey(browserApi, kind)
    if (!board) {
      await status({ state: 'off', message: 'No key to the cloud yet: Hive on this Mac gives it one.' })
      return
    }
    try {
      const { command } = await boardCall(board, `/v1/browser/next?browser=${kind}&wait=${ASK_WAIT_S}`, undefined, {
        fetchImpl,
        timeoutMs: ASK_TIMEOUT_MS,
      })
      failures = 0
      /* Written on every ask: the status, and (in Chrome) an extension call that keeps the worker up. */
      await status({ state: 'connected', message: 'Listening for Hive in the cloud.' })
      if (!command) continue
      let outcome
      try {
        outcome = { ok: true, result: await executeCommand(command, await getConfig()) }
      } catch (error) {
        outcome = { ok: false, error: error?.message || String(error) }
      }
      for (let attempt = 0; ; attempt += 1) {
        try {
          await boardCall(board, '/v1/browser/result', { id: command.commandId, ...outcome }, { fetchImpl })
          break
        } catch (error) {
          if (attempt >= 2) throw error
          await delay(retryDelay(attempt))
        }
      }
    } catch (error) {
      if (error?.status === 401) {
        /* A key the cloud no longer takes: drop it, so the next start asks Hive for the current one. */
        await browserApi.storage.local.remove(BOARD_KEY).catch(() => {})
        await status({ state: 'unauthorized', message: 'The cloud refused this key.', error: error.message })
        return
      }
      failures += 1
      await status({ state: 'offline', message: "Can't reach Hive's cloud.", error: error?.message || String(error) })
      await delay(retryDelay(failures - 1))
    }
  }
}
