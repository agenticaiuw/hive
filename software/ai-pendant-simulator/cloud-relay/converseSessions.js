/*
 * Live converse sessions, findable by deviceId.
 *
 * The owner's complaint that forced this module into existence: they asked by
 * voice, the plan parked for approval on the Mac — and the conversation that
 * was STILL OPEN said nothing. The record had been routed to 'pendant-speech'
 * correctly, but that channel meant only "the store holds it until the next
 * button press". While the socket that could have spoken it sat in a fetch
 * handler's closure, unreachable from the HTTP route that had just saved the
 * record. This map is the missing hallway between those two rooms.
 *
 * WHAT LIVES HERE. One entry per device with an open /v1/pendant/converse
 * conversation: `{ speakApprovals }`, registered by pendantConverse.js the
 * moment the conversation can play audio and removed when it ends.
 * speakApprovals() re-runs the same store-driven readback the button press
 * runs (speakNextApproval and everything under it) — this module never holds
 * a socket, a record, or any speech of its own. The STORE stays the source of
 * truth; the nudge only says "read it now instead of at the next press".
 *
 * HONEST SCOPE: SAME-ISOLATE ONLY. This is a module-scope Map, so it reaches
 * exactly the sockets held by the isolate the saving request landed in. The
 * pendant socket is not owned by a Durable Object (see the announcement notes
 * in pendantConverse.js — that upgrade is what a cron-triggered 7am briefing
 * would need), so a POST /v1/approvals served by a DIFFERENT isolate finds
 * nothing here and the record simply waits for the next press, which was the
 * only behaviour at all before this module. Under `node cloud-relay/server.js`
 * there is one process and the map always sees the socket. Best-effort by the
 * same contract as every prompt push: a missed nudge costs the immediacy,
 * never the approval.
 */

const sessions = new Map()

/**
 * Register a live conversation. Returns the unregister function.
 *
 * Unregistering compares identity before deleting: a conversation restarted on
 * the same socket (sequential reuse in pendantConverse) means the OLD session's
 * teardown can run after the NEW session registered, and a blind delete there
 * would leave a live conversation invisible to nudges for its whole life.
 */
export function registerConverseSession(deviceId, handle) {
  const id = String(deviceId ?? '').trim()
  if (!id || typeof handle?.speakApprovals !== 'function') return () => {}
  sessions.set(id, handle)
  return () => {
    if (sessions.get(id) === handle) sessions.delete(id)
  }
}

/**
 * Ask the live conversation for `deviceId`, if there is one, to read its
 * queued approvals now.
 *
 * Deliberately does NOT await the speech. The caller is an HTTP save handler,
 * and a readback is many seconds of paced audio — the 201 for "your approval
 * is stored" must not wait on it. speakApprovals() serialises and error-guards
 * itself inside the session (see queueApprovalReadback in pendantConverse.js),
 * so firing it and returning is safe. A throw from the call itself is reported
 * rather than raised: the record is already durable, and no nudge failure may
 * become a save failure.
 */
export function nudgeConverseSession(deviceId) {
  const id = String(deviceId ?? '').trim()
  const handle = id ? sessions.get(id) : null
  if (!handle) return { nudged: false, reason: 'no-live-session' }
  try {
    void handle.speakApprovals()
    return { nudged: true, reason: null }
  } catch (error) {
    return { nudged: false, reason: 'nudge-failed', error: String(error?.message ?? error) }
  }
}

/** True when a conversation for this device is registered. Introspection for
 * tests and logs; routing decisions go through nudgeConverseSession. */
export function hasConverseSession(deviceId) {
  return sessions.has(String(deviceId ?? '').trim())
}
