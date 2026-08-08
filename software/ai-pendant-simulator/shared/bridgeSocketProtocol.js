/*
 * The bridge doorbell wire protocol — three constant text frames.
 *
 * The socket between the Mac bridge and the relay's BridgeHub Durable Object
 * carries NO job payloads. The D1 queue stays the single durable record with
 * its claim/lease semantics untouched; the socket only makes delivery instant.
 * A doorbell frame means exactly "claim now instead of on your next safety
 * poll" — the bridge answers it with the same authenticated
 * `GET /v1/bridge/work` it has always used, so a lost frame costs latency,
 * never work.
 *
 * These are EXACT strings, not shapes. The Durable Object registers the ping
 * frame with Cloudflare's WebSocket auto-response (setWebSocketAutoResponse),
 * which answers with the pong frame while the DO stays hibernated — the whole
 * reason an idle connected Mac costs nothing. Auto-response matches byte-for-
 * byte, so both sides must import these constants rather than re-serialize
 * their own JSON and hope the key order matches.
 */

/* Mac → relay, every ~55 s, so NATs and proxies don't idle-close the socket. */
export const BRIDGE_PING_FRAME = '{"type":"ping"}'

/* Relay → Mac, auto-answered by the hibernation layer without waking the DO. */
export const BRIDGE_PONG_FRAME = '{"type":"pong"}'

/* Relay → Mac: work was enqueued in D1 — run a claim sweep now. */
export const BRIDGE_WORK_FRAME = '{"type":"work"}'

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
