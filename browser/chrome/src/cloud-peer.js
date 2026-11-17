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
 *
 * Before each ask it also takes what was said to this browser's own agent (POST /v1/runs/messages/take):
 * a task another agent handed it (Hive on the Mac, the VM) or the owner talking to it from a dashboard.
 * Each goes to the agent (`onMessage`, console-engine.js handleConsoleSubmit), which reports its steps
 * in that message's run, and the board hears whether it was handed over.
 */
import { BOARD_KEY, BOARD_URL } from './page-rules-core.js'

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
  if (got[BOARD_KEY]?.key) return got[BOARD_KEY]
  if (typeof browserApi.runtime?.sendNativeMessage !== 'function') return null
  try {
    const answer = await browserApi.runtime.sendNativeMessage(NATIVE_HOST[kind] ?? NATIVE_HOST.safari, { type: 'hive:key' })
    if (answer?.ok && answer.key) {
      const board = { url: answer.url || BOARD_URL, key: answer.key }
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

/** One call to the board with the extension's key. */
export async function boardCall(board, path, body, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${board.url || BOARD_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${board.key}`, 'content-type': 'application/json' },
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
 * Takes the messages waiting for this browser's agent, hands each to `onMessage` and tells the board
 * how that went. The board hands each message out once; how many there were.
 */
export async function deliverMessages(board, onMessage, { fetchImpl = fetch } = {}) {
  const { messages = [] } = await boardCall(board, '/v1/runs/messages/take', {}, { fetchImpl })
  for (const message of messages) {
    let outcome
    try {
      const answer = await onMessage(message)
      outcome =
        answer?.ok === false
          ? {
              status: 'failed',
              detail:
                answer.error ||
                (answer.needsSetup
                  ? "This browser's agent has nothing to think with: no brain of its own and no Mac agent."
                  : 'The agent turned it down.'),
            }
          : { status: 'delivered', detail: 'Handed to the browser agent.' }
    } catch (error) {
      outcome = { status: 'failed', detail: error?.message || String(error) }
    }
    await boardCall(board, '/v1/runs/messages/update', { id: message.id, ...outcome }, { fetchImpl }).catch((error) =>
      console.warn(`hive board: message ${message.id} wasn't marked ${outcome.status}: ${error?.message || error}`),
    )
  }
  return messages.length
}

/**
 * Asks for commands and runs them until `shouldStop()` or the key is refused. Everything it touches
 * comes in `deps`, so node tests drive it with fakes.
 */
/**
 * What the toolbar badge and the popup say about reaching Hive. The browser has two ways: the old
 * paired relay (the bridge status, which says needs-setup when nothing was ever pasted) and the cloud
 * board, whose key Hive on this Mac hands over by itself. Either one working is "ON"; "SET" only when
 * neither has a way in; "!" when the way it has fails. Before 2026-11-17 only the relay counted, so a
 * browser Hive reached fine through the cloud still showed SET.
 */
export function connectionBadge(relay = {}, cloud = {}) {
  const r = relay?.state
  const c = cloud?.state
  if (r === 'connected' || c === 'connected') return { state: 'connected', text: 'ON', color: '#078B70' }
  if ((c === 'off' || !c) && (!r || r === 'needs-setup')) return { state: 'needs-setup', text: c ? 'SET' : '', color: '#B54736' }
  return { state: c === 'unauthorized' || r === 'unauthorized' ? 'unauthorized' : 'offline', text: '!', color: '#B54736' }
}

export async function runCloudPeer({
  browserApi = api,
  executeCommand,
  getConfig,
  onMessage = null,
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
      if (onMessage) {
        try {
          await deliverMessages(board, onMessage, { fetchImpl })
        } catch (error) {
          /* Only a refused key stops the loop; anything else waits for the next round. */
          if (error?.status === 401) throw error
        }
      }
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
