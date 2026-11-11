/*
 * Ring the Mac bridge's doorbell after enqueueing claimable work.
 *
 * Every write that leaves a `status: 'queued'` job in D1 should call
 * ringBridgeDoorbell right after it. This matters MORE, not less, now that a
 * healthy socket lets the bridge stretch its idle poll cadence to a sparse
 * safety poll: an enqueue path that forgets to ring waits out the full safety
 * interval, which would quietly regress the ops dashboard's 28 s proxy wait
 * and make cron routines land a minute late. Ring everywhere; the frame is a
 * few bytes and a no-op when nothing is connected.
 *
 * Honesty rules, in order:
 *   - The doorbell is rung ONLY after the job row exists. It says "claim
 *     now", never "here is work" — the D1 queue stays the single record.
 *   - Failure here never fails the enqueue: the job is already durable and
 *     the bridge's safety poll is the delivery guarantee. So this helper
 *     never throws, and it caps its own latency so a wedged hub cannot
 *     stall a voice turn.
 *   - No binding (local `npm run relay` in Node) means no hub: a quiet
 *     structured no-op, not an error.
 *
 * env reaches this module the same way it reaches the D1 store: worker.js
 * calls setCloudflareBindings(env) at the top of fetch()/scheduled(), and
 * getCloudflareBindings() hands back BRIDGE_HUB here.
 */
import { getCloudflareBindings } from './cloudflareBindings.js'

/* The hub instance is named after the CLAIMING bridge device, but enqueue
 * sites only know the requesting device (pendant, mobile, scheduler). The
 * registered mac_bridge rows are the honest source for who can claim, and
 * they change ~never, so cache the lookup briefly. */
const BRIDGE_LOOKUP_TTL_MS = 60_000
/* An enqueue is often awaited inside a live voice turn; a hub outage may
 * cost this much and no more. */
const RING_TIMEOUT_MS = 1_500
const WARN_INTERVAL_MS = 60_000

let bridgeCache = { deviceIds: [], fetchedAt: 0 }
let lastWarnAt = 0

function warnThrottled(message, now = Date.now()) {
  if (now - lastWarnAt < WARN_INTERVAL_MS) return
  lastWarnAt = now
  console.warn(message)
}

/* Test seam: forget the cached mac_bridge lookup. */
export function resetBridgeDoorbellCache() {
  bridgeCache = { deviceIds: [], fetchedAt: 0 }
  lastWarnAt = 0
}

async function resolveBridgeDeviceIds(store, now = Date.now()) {
  if (
    bridgeCache.deviceIds.length &&
    now - bridgeCache.fetchedAt < BRIDGE_LOOKUP_TTL_MS
  ) {
    return bridgeCache.deviceIds
  }
  const devices = await store.listDevices()
  const deviceIds = devices
    .filter((device) => device.deviceType === 'mac_bridge')
    .map((device) => device.deviceId)
  bridgeCache = { deviceIds, fetchedAt: now }
  return deviceIds
}

/**
 * Ring every registered bridge's hub. Resolves to a small report and never
 * rejects. `delivered` counts sockets that actually received the frame — a
 * ring into an empty hub reports { rung: true, delivered: 0 }, which is the
 * silent-no-op case the long-poll covers.
 */
export async function ringBridgeDoorbell({ store, reason = 'work', jobId = null } = {}) {
  const binding = getCloudflareBindings()?.BRIDGE_HUB
  if (!binding?.idFromName) {
    return { rung: false, reason: 'no_hub_binding' }
  }
  if (!store?.listDevices) {
    return { rung: false, reason: 'no_store' }
  }

  try {
    const deviceIds = await resolveBridgeDeviceIds(store)
    if (!deviceIds.length) {
      return { rung: false, reason: 'no_bridge_registered' }
    }

    let delivered = 0
    for (const deviceId of deviceIds) {
      const stub = binding.get(binding.idFromName(deviceId))
      const response = await stub.fetch('https://bridge-hub/ring', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason, jobId }),
        signal: AbortSignal.timeout(RING_TIMEOUT_MS),
      })
      const payload = await response.json().catch(() => ({}))
      delivered += Number(payload?.delivered || 0)
    }
    return { rung: true, delivered }
  } catch (error) {
    warnThrottled(
      `[relay] Bridge doorbell failed (${reason}): ${error?.message || error} — safety poll will deliver.`,
    )
    return { rung: false, reason: error?.message || 'ring_failed' }
  }
}
