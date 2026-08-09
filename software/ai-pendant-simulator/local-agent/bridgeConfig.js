import '../../load-pendant-env.mjs'

export const RELAY_URL = process.env.RELAY_URL || 'http://localhost:8787'
export const RELAY_API_KEY = process.env.RELAY_API_KEY || ''
/*
 * The bridge's own scoped credential (role mac_bridge), minted once by
 * scripts/pendant-credentials.mjs. Either the token itself, or a path to a
 * file holding it — a file keeps the secret out of the process environment,
 * which is what childEnv.js strips from spawned tools. Empty means "not
 * commissioned yet", and bridge.js falls back to RELAY_API_KEY with a single
 * loud line. Only the STRINGS are read here; the precedence and the file read
 * live in relayCredential.js so they are testable without env mutation.
 */
export const RELAY_DEVICE_TOKEN = process.env.RELAY_DEVICE_TOKEN || ''
export const RELAY_DEVICE_TOKEN_FILE = process.env.RELAY_DEVICE_TOKEN_FILE || ''
export const PAIRING_CODE = process.env.PAIRING_CODE || ''
export const PENDANT_ACCOUNT_ID =
  process.env.PENDANT_ACCOUNT_ID || 'single-owner'
export const BRIDGE_DEVICE_ID =
  process.env.BRIDGE_DEVICE_ID || 'home-macbook-bridge'
export const LOCAL_AGENT_URL =
  process.env.LOCAL_AGENT_URL || 'http://127.0.0.1:8000'
export const AGENT_TOKEN = process.env.AGENT_TOKEN || ''
export const HEARTBEAT_INTERVAL_MS = Number(
  process.env.BRIDGE_HEARTBEAT_INTERVAL_MS || 30000,
)
export const WORK_RETRY_BASE_MS = Number(
  process.env.BRIDGE_WORK_RETRY_BASE_MS || 250,
)
/*
 * Poll-failure backoff cap. Keep this small: while the bridge sleeps here, no
 * poll is outstanding, so a freshly queued voice job waits the full remaining
 * sleep before pickup. The old 30s cap turned relay flaps into 16-30s
 * button-to-execution stalls.
 */
export const WORK_RETRY_MAX_MS = Number(
  process.env.BRIDGE_WORK_RETRY_MAX_MS || 3000,
)
/* Client-side cap on one poll request; server holds ≤5s, then margin. A
 * stale keep-alive socket after a Worker redeploy hangs without erroring —
 * this abort is the only bound on that stall, so keep it tight. */
export const WORK_POLL_ABORT_MS = Number(
  process.env.BRIDGE_WORK_POLL_ABORT_MS || 8000,
)

/*
 * Doorbell socket (push delivery). While the relay socket is HEALTHY the work
 * loop idles this long between polls — the doorbell wakes it instantly, so
 * the poll is a safety net, not the delivery path. While the socket is down
 * (or the deployed relay predates it) the idle delay is zero and the loop is
 * byte-for-byte the old continuous long-poll.
 */
export const BRIDGE_SAFETY_POLL_INTERVAL_MS = Number(
  process.env.BRIDGE_SAFETY_POLL_INTERVAL_MS || 60_000,
)
/* Ping cadence on the doorbell socket, under common 60-90s intermediary idle
 * cutoffs. The relay answers from the hibernation layer without waking the
 * Durable Object, so pinging is free on both ends. */
export const BRIDGE_SOCKET_HEARTBEAT_MS = Number(
  process.env.BRIDGE_SOCKET_HEARTBEAT_MS || 55_000,
)
/* Reconnect backoff for the doorbell socket only. Unlike the poll loop's
 * tight WORK_RETRY_MAX_MS, this may climb to 30s: while the socket is down
 * the long-poll is already delivering, so reconnect urgency buys nothing. */
export const BRIDGE_SOCKET_RECONNECT_BASE_MS = Number(
  process.env.BRIDGE_SOCKET_RECONNECT_BASE_MS || 1000,
)
export const BRIDGE_SOCKET_RECONNECT_MAX_MS = Number(
  process.env.BRIDGE_SOCKET_RECONNECT_MAX_MS || 30_000,
)
