/*
 * One-paste pairing: everything between "the owner typed the pairing code
 * into the extension" and "the extension holds both credentials it needs".
 *
 * WHY THIS EXISTS. Setting up the extension used to mean handling two secrets
 * by hand: copy AGENT_TOKEN out of .env into one field, run
 * pendant-credentials.mjs in a terminal, copy the printed pdt_ token into
 * another field, and type the --device-id again without typo. The owner's
 * first live attempt stalled exactly there — a paired relay credential sat
 * unused (`lastUsed: never`) because the paste never happened, and the
 * "brain" shipped that week ran zero commands. The owner: "combine them into
 * one please."
 *
 * THE COMBINATION. The pairing code was ALREADY the secret that proves "the
 * human at the keyboard owns this rig" — the relay's own /v1/devices/pair is
 * pre-auth plus code by design. So the code becomes the only secret a human
 * ever handles: the extension posts it to this route once, and this route
 * hands back the agent bearer AND commissions the browser_node relay
 * credential server-side (the same request pendant-credentials.mjs sends,
 * built by relayPairRequest below). The two wire credentials stay separate —
 * agent token to loopback, device token to the relay, never crossed — the
 * HUMAN just no longer carries either.
 *
 * EVERYTHING HERE IS PURE. The route in server.js owns the fetch and the
 * response; these functions own every decision, so the gate is assertable
 * without a socket.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/*
 * Loopback only, checked against the SOCKET's remote address, not any header.
 * The agent listens on 0.0.0.0 (the pendant bridge and the phone need it), so
 * without this line the one pre-auth route on the server would be reachable
 * from the LAN. Every other route is bearer-gated; this one exists precisely
 * for the client that has no bearer yet, so the socket is all there is.
 *
 * '::ffff:127.' covers IPv4-mapped IPv6, which is how Node reports loopback
 * on a dual-stack listener more often than not.
 */
export function isLoopbackAddress(remoteAddress) {
  const address = String(remoteAddress ?? '').trim()
  if (!address) return false
  return (
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  )
}

/*
 * Timing-safe, and refuses to match when no code is configured — an empty
 * PAIRING_CODE must mean "pairing is off", never "pairing is open".
 * Hash-then-compare sidesteps timingSafeEqual's length requirement without
 * leaking length through an early return.
 */
export function pairingCodeMatches(supplied, configured) {
  const expected = String(configured ?? '')
  if (!expected) return false
  const left = createHash('sha256').update(String(supplied ?? '')).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

/*
 * The extension names itself; this bounds it. Same alphabet the credential
 * script's device ids use. A browser that sends garbage gets a refusal, not
 * a sanitized guess — the id ends up in the relay's device table and in
 * every record the node writes, so it should be exactly what was asked for.
 */
export function normalizeDeviceId(raw) {
  const id = String(raw ?? '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(id)) return ''
  return id
}

/*
 * The relay pair call, in the exact shape pendant-credentials.mjs sends —
 * that script is the contract's reference client. role is pinned to
 * browser_node: this route pairs BROWSERS, and a compromised page that
 * somehow reached it must not be able to ask for mac_bridge and walk away
 * with state:write.
 */
/*
 * HOW LONG THE MINTED CREDENTIAL LIVES. The owner (2026-08-12) wanted the
 * choice "7 days/30 days/forever until revoked ... or forget right after this
 * browser is closed", so exactly four values are legal and anything else is a
 * REFUSAL, not a guess — a typo'd lifetime that silently minted forever would
 * defeat the entire feature. Missing/empty means forever (the owner's
 * default), because pre-lifetime extensions send no field at all.
 *
 * 'session' maps to ttlMs null ON PURPOSE: "until this browser closes" is a
 * fact only the browser can observe, so the extension enforces it client-side
 * (a storage.session sentinel) and the relay credential carries no expiry.
 */
export const PAIR_LIFETIMES = Object.freeze(['session', '7d', '30d', 'forever'])

export function pairLifetimeTtl(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return { ok: true, lifetime: 'forever', ttlMs: null }
  if (!PAIR_LIFETIMES.includes(value)) {
    return {
      ok: false,
      error: `lifetime must be one of: ${PAIR_LIFETIMES.join(', ')}.`,
    }
  }
  const ttlMs =
    value === '7d'
      ? 7 * 24 * 60 * 60 * 1_000
      : value === '30d'
        ? 30 * 24 * 60 * 60 * 1_000
        : null
  return { ok: true, lifetime: value, ttlMs }
}

export function relayPairRequest({ relayUrl, pairingCode, deviceId, deviceName, ttlMs }) {
  const origin = String(relayUrl ?? '').replace(/\/$/, '')
  if (!origin) return null
  return {
    url: `${origin}/v1/devices/pair`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        deviceType: 'browser_node',
        name: String(deviceName ?? '').trim() || deviceId,
        pairingCode,
        /* Omitted entirely when null: the relay treats absence as "no expiry",
         * and an explicit null in the body would be a new wire shape for the
         * same meaning. */
        ...(Number.isFinite(ttlMs) && ttlMs > 0 ? { ttlMs } : {}),
      }),
    },
  }
}

/*
 * What the extension receives. agentToken rides even when the relay leg
 * failed: a browser that can reach the Mac but not the relay (captive wifi,
 * worker down) should leave setup with the half that works and an honest
 * note about the half that did not — not with nothing.
 */
export function pairResponseBody({ agentToken, relayUrl, deviceId, relayPayload, relayError }) {
  const credential = relayPayload?.credential ?? null
  const relay =
    credential?.token && deviceId
      ? {
          url: relayUrl,
          deviceId,
          deviceToken: credential.token,
          tokenId: credential.tokenId ?? null,
          scopes: Array.isArray(credential.scopes) ? credential.scopes : [],
        }
      : null
  return {
    ok: true,
    agentToken,
    relay,
    ...(relay
      ? {}
      : {
          relayError:
            String(relayError ?? relayPayload?.error ?? 'The relay did not return a credential.'),
        }),
  }
}
