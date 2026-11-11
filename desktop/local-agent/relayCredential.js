/*
 * Which credential the Mac bridge presents to the relay, and why.
 *
 * The bridge shipped with `Authorization: Bearer ${RELAY_API_KEY}` — the
 * shared ADMIN key, scopes ['*']. That key also opens /v1/ops/*, the routine
 * scheduler and every other device's data, and it is the same string burned
 * into the pendant's flash. One credential, every node, no revocation short of
 * rotating it everywhere at once.
 *
 * A paired mac_bridge token does exactly what the bridge does and nothing
 * more: claim work, post results, heartbeat itself, write fleet/agent-snapshot
 * state, sync product state, open its own doorbell socket. Losing it costs one
 * `pendant-credentials.mjs revoke` and one re-pair.
 *
 * The fallback exists so a mid-migration fleet keeps working, and it is LOUD
 * exactly once. A silent fallback is how a migration finishes on paper and
 * never in fact — the whole reason the scoped scheme sat unused for so long is
 * that nothing ever said "you are still on the admin key".
 *
 * Resolution order:
 *   1. RELAY_DEVICE_TOKEN            — env, for launchd/CI
 *   2. RELAY_DEVICE_TOKEN_FILE       — a file holding just the token
 *   3. ~/.config/ai-pendant/mac-bridge-token   (default file, if present)
 *   4. RELAY_API_KEY                 — admin fallback, logged once
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_DEVICE_TOKEN_FILE = path.join(
  os.homedir?.() || '.',
  '.config',
  'ai-pendant',
  'mac-bridge-token',
)

/** A device token is `pdt_<id>.<secret>`; anything else is not one. */
export function looksLikeDeviceToken(value) {
  return /^pdt_[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{40,128}$/.test(
    String(value || '').trim(),
  )
}

function readTokenFile(filePath, readFile) {
  if (!filePath) return ''
  try {
    /* First non-comment line, so the file may carry a note about which device
     * it belongs to without the note becoming part of the bearer token. */
    for (const rawLine of String(readFile(filePath, 'utf8')).split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line && !line.startsWith('#')) return line
    }
  } catch {
    /* absent is the normal state before the bridge has been commissioned */
  }
  return ''
}

/**
 * Resolve the bearer the bridge should send.
 *
 * Returns { token, kind, source }. `kind` is 'device' | 'admin' | 'none'.
 * Never returns the token in any log-shaped field — callers log `kind` and
 * `source`, never `token`.
 */
export function resolveRelayCredential({
  deviceToken = process.env.RELAY_DEVICE_TOKEN || '',
  deviceTokenFile = process.env.RELAY_DEVICE_TOKEN_FILE || '',
  defaultTokenFile = DEFAULT_DEVICE_TOKEN_FILE,
  adminKey = '',
  readFile = fs.readFileSync,
} = {}) {
  const fromEnv = String(deviceToken || '').trim()
  if (fromEnv) {
    return {
      token: fromEnv,
      kind: 'device',
      source: 'RELAY_DEVICE_TOKEN',
      malformed: !looksLikeDeviceToken(fromEnv),
    }
  }

  for (const [candidate, source] of [
    [String(deviceTokenFile || '').trim(), 'RELAY_DEVICE_TOKEN_FILE'],
    [defaultTokenFile, 'default token file'],
  ]) {
    const fromFile = readTokenFile(candidate, readFile)
    if (fromFile) {
      return {
        token: fromFile,
        kind: 'device',
        source: `${source} (${candidate})`,
        malformed: !looksLikeDeviceToken(fromFile),
      }
    }
  }

  const admin = String(adminKey || '').trim()
  if (admin) {
    return { token: admin, kind: 'admin', source: 'RELAY_API_KEY', malformed: false }
  }

  return { token: '', kind: 'none', source: null, malformed: false }
}

/**
 * The one-time migration notice. Returns the line to log, or null when the
 * bridge is already on a scoped token (nothing to say) or has no credential at
 * all (the caller throws instead).
 *
 * Split out from the logging so a test can assert the wording without
 * capturing console, and so it is impossible for a future edit to interpolate
 * the token into it: this function is not given the token.
 */
export function migrationNotice({ kind, source, malformed } = {}) {
  if (kind === 'admin') {
    return (
      '[bridge] Using the shared admin RELAY_API_KEY. This credential holds every ' +
      'scope including /v1/ops/*. Commission a scoped token: node ' +
      'scripts/pendant-credentials.mjs pair --device-id <id> --role mac_bridge, ' +
      'then set RELAY_DEVICE_TOKEN or write it to ' +
      `${DEFAULT_DEVICE_TOKEN_FILE}.`
    )
  }
  if (kind === 'device' && malformed) {
    return (
      `[bridge] The value from ${source} is not a pdt_<id>.<secret> device token. ` +
      'Sending it anyway; the relay will refuse it if it is wrong.'
    )
  }
  return null
}
