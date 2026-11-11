/*
 * The pure half of one-paste pairing: build the request, read the reply, and
 * say exactly what to store. The fetch AND the storage writes live in the
 * background worker (background.js 'pair:run'); the popup only collects the
 * code and watches storage for the outcome. Everything here is assertable in
 * plain node.
 *
 * WHY THE POPUP AND NOT A SETTINGS PAGE. The owner, 2026-08-12: "having a
 * settings page is lowkey kind of weird. i should be able to paste my token
 * directly to the extension window and then press connect. actually, delete
 * the entire settings page." So the options page is gone; the popup owns
 * setup now, and this module is its policy.
 *
 * WHAT THIS REPLACES. Setup used to be two secrets across two surfaces: copy
 * AGENT_TOKEN out of .env, run pendant-credentials.mjs, copy the printed
 * pdt_ token, retype the device id. The owner's first live attempt produced
 * a credential with `lastUsed: never` — minted, printed, never pasted. Now
 * the pairing code goes in ONE box; the agent's loopback /pair/browser route
 * returns the bearer and commissions the relay credential itself.
 *
 * THE CODE IS SPENT, NEVER STORED. It leaves this machine's memory the
 * moment the request returns. What persists is only what always persisted:
 * the two per-host credentials, in storage.local, same keys as ever — so the
 * background's storage.onChanged handlers notice and reconnect both peers
 * with no new plumbing.
 */

/*
 * HOW LONG THE CREDENTIAL LIVES. The owner, 2026-08-12: "it should stay
 * connected for 30 days at least, or let the users choose '7 days/30 days/
 * forever until revoked' ... or forget right after this browser is closed."
 * Four canonical values, nothing free-form — the agent refuses anything else
 * so a typo'd lifetime cannot silently become "forever":
 *
 *   session — cleared when the browser quits. Enforced CLIENT-side only: the
 *             worker keeps a sentinel in storage.session (which the browser
 *             wipes on quit) and treats its absence as "the browser was
 *             closed since pairing". The relay sees no expiry (null) because
 *             "this browser session" is a fact only this browser knows.
 *   7d/30d  — a hard expiresAt on the relay credential AND a local wipe, so
 *             the token dies server-side even if this machine never wakes.
 *   forever — until revoked. The default, per the owner.
 */
export const PAIR_LIFETIMES = Object.freeze(['session', '7d', '30d', 'forever'])
export const DEFAULT_PAIR_LIFETIME = 'forever'

const LIFETIME_TTL_MS = Object.freeze({
  session: null,
  '7d': 7 * 24 * 60 * 60 * 1_000,
  '30d': 30 * 24 * 60 * 60 * 1_000,
  forever: null,
})

/** Anything not canonical becomes the default — the UI only offers the four,
 * so a stray value is corruption, not intent. */
export function normalizePairLifetime(raw) {
  const value = String(raw ?? '').trim()
  return PAIR_LIFETIMES.includes(value) ? value : DEFAULT_PAIR_LIFETIME
}

/** Relay-side TTL for a lifetime; null means "mint with no expiry". */
export function lifetimeTtlMs(lifetime) {
  return LIFETIME_TTL_MS[normalizePairLifetime(lifetime)] ?? null
}

/** The request. Loopback only by construction: the URL is the agent's. */
export function pairRequest(agentUrl, { code, deviceId, deviceName, lifetime }) {
  const origin = String(agentUrl ?? '').replace(/\/$/, '')
  if (!origin) return null
  return {
    url: `${origin}/pair/browser`,
    init: {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: String(code ?? ''),
        deviceId: String(deviceId ?? ''),
        deviceName: String(deviceName ?? ''),
        lifetime: normalizePairLifetime(lifetime),
      }),
    },
  }
}

/*
 * A device id to offer BEFORE the owner has one: a stored id always wins (so
 * re-pairing rotates the same device instead of littering the relay's table
 * with strays), otherwise browser-<hex> from caller-supplied randomness.
 * Randomness is a parameter, not a crypto call, so tests are deterministic.
 */
export function defaultPairDeviceId(storedId, randomHex) {
  const existing = String(storedId ?? '').trim()
  if (existing) return existing
  const suffix = String(randomHex ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 6) || '000000'
  return `browser-${suffix.toLowerCase()}`
}

/**
 * Reply → storage patch. Keys are the live contract: `agentToken` restarts
 * the Mac poll loop, the RELAY_STORAGE_KEYS quartet restarts the mesh socket
 * (background.js watches both). relayEnabled flips true ONLY when a token
 * actually arrived — flipping it on a failed relay leg would aim the drain
 * loop at a relay this browser cannot authenticate to, and the error state
 * that follows looks like a bug rather than an unfinished setup.
 */
export function pairStoragePatch(payload, { agentUrl, lifetime, now = Date.now() } = {}) {
  if (!payload?.ok || !payload.agentToken) {
    return {
      ok: false,
      error: String(payload?.error ?? 'Pairing failed: the agent returned no token.'),
    }
  }

  /*
   * The lifetime rides in the SAME patch as the credentials, so there is no
   * window where a token exists with no recorded lifetime. pairExpiresAt is
   * the local wall-clock twin of the relay's expiresAt (null for session and
   * forever — session is enforced by the storage.session sentinel instead).
   */
  const chosen = normalizePairLifetime(lifetime)
  const ttl = lifetimeTtlMs(chosen)
  const values = {
    ...(agentUrl ? { agentUrl } : {}),
    agentToken: String(payload.agentToken),
    pairLifetime: chosen,
    pairExpiresAt: ttl ? new Date(now + ttl).toISOString() : null,
  }

  if (payload.relay?.deviceToken) {
    values.relayEnabled = true
    values.relayUrl = String(payload.relay.url ?? '')
    values.relayDeviceId = String(payload.relay.deviceId ?? '')
    values.deviceToken = String(payload.relay.deviceToken)
    return {
      ok: true,
      values,
      note: `Paired. This browser is ${values.relayDeviceId} on the relay — the brain is on.`,
    }
  }

  return {
    ok: true,
    values,
    note: `Mac agent paired. Relay half failed: ${String(
      payload.relayError ?? 'no credential returned',
    )} — commands will use the Mac until you pair again.`,
  }
}

/*
 * THE OUTCOME TRAVELS THROUGH STORAGE, NOT THE MESSAGE CHANNEL.
 *
 * Root cause of "Pairing failed: the agent returned no token." with a healthy
 * agent (2026-08-12): the worker's fetch succeeded, but Safari DROPPED the
 * async sendResponse when the round trip ran long (the relay leg inside the
 * agent can take up to 15s). The page saw `undefined`, found no `error`
 * field, and printed the default — while a freshly minted credential
 * evaporated with the reply. So the WORKER now applies the storage patch
 * itself the moment the fetch completes, and writes this outcome record under
 * PAIR_OUTCOME_KEY; the popup listens on storage.onChanged, a channel that
 * cannot be lost with the credential. A dropped sendMessage reply now costs a
 * status line at worst, never a token.
 */
export const PAIR_OUTCOME_KEY = 'pairOutcome'

export function pairOutcomeRecord(outcome, now = Date.now()) {
  return outcome?.ok
    ? { ok: true, note: String(outcome.note ?? 'Paired.'), at: now }
    : { ok: false, error: String(outcome?.error ?? 'Pairing failed.'), at: now }
}

/*
 * WHAT AN EXPIRED CREDENTIAL TAKES WITH IT. agentToken and deviceToken are
 * the credentials; relayEnabled has to fall with them or the drain loop keeps
 * aiming at a relay this browser can no longer authenticate to. relayUrl and
 * relayDeviceId deliberately SURVIVE: they are identity, not secrets, and a
 * kept relayDeviceId is what lets re-pairing rotate the same device instead
 * of littering the relay's table (defaultPairDeviceId above).
 */
export const PAIR_WIPE_KEYS = Object.freeze([
  'agentToken',
  'deviceToken',
  'relayEnabled',
  'pairLifetime',
  'pairExpiresAt',
])

/*
 * Should the stored credentials be wiped right now? Pure, so the worker's
 * startup/alarm check is one call and the whole policy is testable:
 *
 * - 7d/30d past their pairExpiresAt → wipe. The relay already refuses the
 *   token (its expiresAt matches); this makes the popup say "needs setup"
 *   instead of "bad token", which is the honest description.
 * - session mode with the storage.session sentinel MISSING → the browser has
 *   quit since pairing (storage.session is wiped on quit; that wipe IS the
 *   "forget right after this browser is closed" the owner asked for) → wipe.
 * - everything else → keep. No lifetime recorded (paired before lifetimes
 *   existed) means forever, the owner's default.
 */
export function credentialExpiryCheck({
  agentToken,
  pairLifetime,
  pairExpiresAt,
  sessionAlive,
  now = Date.now(),
} = {}) {
  if (!agentToken) return { wipe: false }

  const lifetime = normalizePairLifetime(pairLifetime)

  if (lifetime === 'session' && !sessionAlive) {
    return {
      wipe: true,
      reason: 'This pairing was for the browser session only, and the browser has been closed since.',
    }
  }

  const expiresAt = Date.parse(pairExpiresAt ?? '')
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return {
      wipe: true,
      reason: `The ${lifetime === '7d' ? '7-day' : lifetime === '30d' ? '30-day' : 'timed'} pairing has expired.`,
    }
  }

  return { wipe: false }
}

/*
 * CREDENTIAL ESCROW — the pure policy half. The owner, 2026-08-12: "we likely
 * gonna keep updating the extension, make sure this issue doesn't happen
 * again." Twice (2026-08-10 and 2026-08-12) a Safari extension update reset
 * the extension's storage identity and wiped the pairing. The Safari wrapper
 * app's native-messaging handler (SafariWebExtensionHandler.swift) now keeps
 * an escrow copy in the appex's own UserDefaults — a store Safari cannot
 * reset — and the worker restores from it when it wakes up unpaired. The
 * native round trips live in background.js; every DECISION lives here so it
 * runs under plain node tests.
 */

/*
 * Session-only pairings are NEVER escrowed. The whole point of escrow is to
 * survive things that wipe browser storage — and quitting the browser is one
 * of those things, but for a session pairing that wipe IS the feature ("forget
 * right after this browser is closed"). An escrowed session credential would
 * outlive the browser quit and be restored on relaunch, silently promoting
 * the owner's most cautious choice into "forever". Cheaper and safer to keep
 * it out of escrow entirely than to try to tell an update-reset apart from a
 * browser restart after the fact.
 */
export function shouldEscrow(lifetime) {
  return normalizePairLifetime(lifetime) !== 'session'
}

/*
 * Given what the escrow returned, decide whether to restore it into
 * browser.storage.local. Reuses credentialExpiryCheck so escrow cannot become
 * a back door around the 7d/30d expiry: a credential the worker would wipe on
 * sight is one the escrow must not hand back. sessionAlive is pinned false —
 * if a session-lifetime blob is ever found in escrow (a bug upstream, see
 * shouldEscrow), the strictest reading wins and it is refused.
 */
export function escrowRestorePlan(values, now = Date.now()) {
  if (!values || typeof values !== 'object' || !values.agentToken) {
    return { restore: false, reason: 'nothing escrowed' }
  }
  if (normalizePairLifetime(values.pairLifetime) === 'session') {
    return { restore: false, reason: 'session-only pairings are never restored' }
  }
  const verdict = credentialExpiryCheck({
    agentToken: values.agentToken,
    pairLifetime: values.pairLifetime,
    pairExpiresAt: values.pairExpiresAt,
    sessionAlive: false,
    now,
  })
  if (verdict.wipe) {
    return { restore: false, reason: verdict.reason }
  }
  return { restore: true, values }
}
