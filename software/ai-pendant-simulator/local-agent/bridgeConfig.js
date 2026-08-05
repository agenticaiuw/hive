import '../../load-pendant-env.mjs'

export const RELAY_URL = process.env.RELAY_URL || 'http://localhost:8787'
export const RELAY_API_KEY = process.env.RELAY_API_KEY || ''
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
