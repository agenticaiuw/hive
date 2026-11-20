/*
 * What this extension runs, for the board (cloud/tasks/nodes.js), and picking up new code by itself
 * (owner, 2026-11-18: "No version check or automatic updates between nodes").
 *
 * Every call to the board says which node this is (x-hive-node "extension:chrome"), its version (the
 * manifest's) and the board routes it was written against (x-hive-protocol), so the board can say
 * when it's too old and the dashboard shows what each browser runs.
 *
 * Chrome runs this extension unpacked from build/chrome: `node package.mjs` writes new files there,
 * but Chrome keeps running the old ones until it's reloaded. So the code it loaded is fingerprinted
 * when it loads (install, reload, browser start), and every half minute the background compares the
 * files on disk with it; once new files have stayed the same for a whole check (never a folder being
 * rewritten) and no command is running, the extension reloads itself.
 */
export const PROTOCOL = 1
export const LOADED_KEY = 'hiveLoadedCode'
// What the extension runs (build/chrome holds these and nothing else that's code); in src/ the
// modules each imports are followed too.
export const CODE_FILES = ['manifest.json', 'background.js', 'page-rules.js', 'popup.js', 'popup.html', 'sidepanel.html', 'sidepanel.js', 'ui.css']

const api = globalThis.browser ?? globalThis.chrome

/** The headers every call to the board carries; `name` is the browser ("chrome", "safari"). */
export function nodeHeaders(name, browserApi = api) {
  let version = 'unknown'
  try {
    version = browserApi?.runtime?.getManifest?.()?.version || 'unknown'
  } catch {}
  return { 'x-hive-node': `extension:${name || 'browser'}`, 'x-hive-version': version, 'x-hive-protocol': String(PROTOCOL) }
}

/** A hash of the extension's code as it is on disk now; null if a file can't be read (mid-write). */
export async function codeFingerprint({ browserApi = api, fetchImpl = fetch } = {}) {
  const seen = new Set()
  const parts = []
  let missing = false
  const visit = async (name) => {
    if (seen.has(name)) return
    seen.add(name)
    const response = await fetchImpl(browserApi.runtime.getURL(name), { cache: 'no-store' }).catch(() => null)
    if (!response?.ok) {
      missing = true
      return
    }
    const text = await response.text()
    parts.push(`${name}\0${text}\0`)
    if (name.endsWith('.js')) for (const [, dep] of text.matchAll(/from\s+['"]\.\/([\w.-]+\.js)['"]/g)) await visit(dep)
  }
  for (const name of CODE_FILES) await visit(name)
  if (missing) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('')))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Writes down the code just loaded (onInstalled, onStartup). */
export async function noteLoadedCode({ browserApi = api, fetchImpl = fetch } = {}) {
  const fingerprint = await codeFingerprint({ browserApi, fetchImpl })
  if (fingerprint) await browserApi.storage.local.set({ [LOADED_KEY]: fingerprint })
  return fingerprint
}

/**
 * One check for new code on disk, for the half-minute alarm: reloads when the files differ from what
 * was loaded, read the same at the last check too, and nothing is `busy()`. What it did, in a word.
 */
export function newCodeWatcher({ browserApi = api, fetchImpl = fetch, busy = () => false, reload = () => browserApi.runtime.reload() } = {}) {
  let candidate = null
  return async function check() {
    const loaded = (await browserApi.storage.local.get(LOADED_KEY))[LOADED_KEY]
    const now = await codeFingerprint({ browserApi, fetchImpl }).catch(() => null)
    if (!now) return 'unreadable'
    if (!loaded) {
      await browserApi.storage.local.set({ [LOADED_KEY]: now })
      return 'noted'
    }
    if (now === loaded) {
      candidate = null
      return 'same'
    }
    if (candidate !== now) {
      candidate = now
      return 'settling'
    }
    if (busy()) return 'busy'
    reload()
    return 'reloaded'
  }
}
