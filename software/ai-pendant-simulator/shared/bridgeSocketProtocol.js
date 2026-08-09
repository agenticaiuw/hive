/*
 * The node doorbell wire protocol — four constant text frames.
 *
 * The socket between a node and its BridgeHub Durable Object carries NO
 * payloads. The D1 queue stays the single durable record with its claim/lease
 * semantics untouched; the socket only makes delivery instant. A doorbell
 * frame means exactly "claim now instead of on your next safety poll" — the
 * node answers it with the same authenticated GET it has always used, so a
 * lost frame costs latency, never work.
 *
 * Originally Mac-only, hence the BRIDGE_ prefix. One BridgeHub instance now
 * serves any node (see cloudflare-worker/bridgeHub.js): the Mac opens its
 * socket at /v1/bridge/socket and the browser/phone nodes open theirs at
 * /v1/node/socket, but both land on the same per-device instance and both
 * receive whichever of these frames apply to them. A node therefore holds
 * exactly ONE socket regardless of how many things the relay wants to tell it.
 *
 * These are EXACT strings, not shapes. The Durable Object registers the ping
 * frame with Cloudflare's WebSocket auto-response (setWebSocketAutoResponse),
 * which answers with the pong frame while the DO stays hibernated — the whole
 * reason an idle connected Mac costs nothing. Auto-response matches byte-for-
 * byte, so both sides must import these constants rather than re-serialize
 * their own JSON and hope the key order matches.
 */

/* Node → relay, every ~55 s, so NATs and proxies don't idle-close the socket. */
export const BRIDGE_PING_FRAME = '{"type":"ping"}'

/* Relay → node, auto-answered by the hibernation layer without waking the DO. */
export const BRIDGE_PONG_FRAME = '{"type":"pong"}'

/* Relay → Mac: work was enqueued in D1 — run a claim sweep now. */
export const BRIDGE_WORK_FRAME = '{"type":"work"}'

/*
 * Relay → any node: node-mesh mail is waiting — drain
 * `GET /v1/node/inbox?deviceId=<you>` now.
 *
 * Carries no count and no ids, deliberately. A drain returns everything
 * pending anyway, so a count would only create a second, staler source of
 * truth about the inbox — and a constant frame stays byte-comparable in tests
 * and eligible for the same auto-response machinery as the ping.
 */
export const BRIDGE_MAIL_FRAME = '{"type":"mail"}'

/* Parse one inbound text frame; null for anything unrecognizable. */
export function parseBridgeFrame(data) {
  if (typeof data !== 'string') return null
  try {
    const parsed = JSON.parse(data)
    return parsed && typeof parsed.type === 'string' ? parsed : null
  } catch {
    return null
  }
}
