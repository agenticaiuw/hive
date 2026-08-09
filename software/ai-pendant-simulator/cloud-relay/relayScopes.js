/*
 * The route → required-scope table.
 *
 * Lifted verbatim out of server.js so it can be exercised without importing
 * the relay (server.js calls app.listen() at module scope, so a test that
 * imported it would bind a port). The table was written before several of the
 * routes it now covers existed and had never been exercised by a scoped
 * client — every client authenticated with the admin key, whose '*' scope
 * short-circuits principalHasScopes and made the whole table dead code. Tests
 * live in relayScopes.test.js and assert the matrix per role.
 *
 * Contract, unchanged: returns an array of scope strings a principal must hold
 * for this request, or null for "no rule" — and the auth middleware treats
 * null as DENY, so an unlisted route is closed to everyone, admin included.
 */
import { fleetMemoryScopesFor } from './fleetContext.js'

export function requiredScopesForRequest(request) {
  return requiredScopesForRoute(request.method, request.path)
}

export function requiredScopesForRoute(rawMethod, rawPath) {
  const method = String(rawMethod || '').toUpperCase()
  const path = String(rawPath || '')

  /* Declared next to their handlers in fleetContext.js, so adding a memory
   * route cannot quietly ship an unscoped write path for the owner's facts. */
  const memoryScopes = fleetMemoryScopesFor(method, path)
  if (memoryScopes) return memoryScopes

  if (method === 'POST' && path === '/v1/devices/register') return ['admin']
  /*
   * Retiring a device deletes its credentials and its undrained mail. Owner
   * work, not device work: no node should be able to unregister another.
   *
   * The fixed sub-routes are excluded from the id pattern rather than left to
   * collide. `/v1/devices/:deviceId` otherwise matches /v1/devices/heartbeat,
   * which would make "DELETE the heartbeat route" a listed path meaning
   * "retire the device named heartbeat" — a 404 rather than a 403, and a
   * route table where a reader cannot tell those two apart is one that will
   * eventually hide a real hole.
   */
  if (
    method === 'DELETE' &&
    /^\/v1\/devices\/[^/]+$/.test(path) &&
    !['register', 'heartbeat', 'status', 'pair'].includes(
      path.slice('/v1/devices/'.length),
    )
  ) {
    return ['admin']
  }
  if (method === 'POST' && path === '/v1/devices/heartbeat') {
    return ['device:heartbeat:self']
  }
  if (method === 'GET' && path === '/v1/devices/status') {
    return ['device:status:read']
  }
  if (
    method === 'GET' &&
    /^\/v1\/product\/state\/[^/]+$/.test(path)
  ) {
    return ['product:read']
  }
  if (method === 'PUT' && path === '/v1/product/state') {
    return ['product:write']
  }
  /*
   * The pendant's alert inbox, ahead of the generic state rule on purpose.
   *
   * `state:read` is one scope over a shared key space that also holds
   * agent-snapshot and fleet — the Mac's whole world model. The pendant needs
   * exactly one key out of it, so it gets exactly one key. The path is fixed
   * here rather than read from firmware Kconfig: changing
   * CONFIG_PENDANT_ALERT_STATE_PATH away from this default means changing this
   * line too, which is the correct amount of friction for widening what a
   * lost device can read. Writers (Mac, routine, dashboard) use PUT, which is
   * unchanged and still `state:write`.
   */
  if (method === 'GET' && path === '/v1/state/pendant-alerts') {
    return ['pendant:alerts:read']
  }
  if (method === 'GET' && path.startsWith('/v1/state/')) {
    return ['state:read']
  }
  if (method === 'POST' && path === '/v1/context') return ['context:write']
  if (method === 'POST' && path === '/v1/context/resume') {
    return ['context:read']
  }
  if (method === 'PUT' && path.startsWith('/v1/state/')) {
    return ['state:write']
  }
  if (method === 'POST' && path === '/v1/pendant/announce') {
    return ['pendant:announce']
  }
  if (method === 'POST' && path === '/v1/transcribe') {
    return ['speech:transcribe']
  }
  if (method === 'POST' && path === '/v1/pendant/command') {
    return ['pendant:audio:upload']
  }
  if (method === 'POST' && path === '/v1/speak') {
    return ['speech:synthesize']
  }
  if (
    (method === 'POST' && path === '/v1/pendant/speak') ||
    (method === 'GET' &&
      /^\/v1\/pendant\/jobs\/[^/]+\/speech$/.test(path))
  ) {
    return ['pendant:speech:read']
  }
  if (method === 'POST' && path === '/v1/mac/plan') return ['mac:plan']
  if (method === 'POST' && path === '/v1/mac/execute') return ['mac:execute']
  if (method === 'GET' && /^\/v1\/mac\/jobs\/[^/]+$/.test(path)) {
    return ['mac:jobs:read']
  }
  if (path.startsWith('/v1/ops/')) return ['admin']
  /*
   * Scheduling is owner-level configuration: a routine can ask the Mac to do
   * anything a spoken command can, so declaring one is not something a paired
   * pendant should be able to do on its own. The owner's RELAY_API_KEY is an
   * admin principal and holds every scope, so this gates nothing the owner
   * does — it only keeps a stolen device token out of the schedule.
   */
  if (path.startsWith('/v1/routines') || path.startsWith('/v1/announcements')) {
    return ['admin']
  }
  if (
    method === 'POST' &&
    /^\/v1\/pendant\/jobs\/[^/]+\/events$/.test(path)
  ) {
    return ['pendant:event:write']
  }
  if (method === 'GET' && path === '/v1/bridge/work') {
    return ['bridge:work:claim']
  }
  /* Same audience as /v1/devices/status: anything allowed to ask "is the Mac
   * reachable" may ask it precisely instead of guessing from lastSeenAt. */
  if (method === 'GET' && path === '/v1/bridge/presence') {
    return ['device:status:read']
  }
  if (
    method === 'POST' &&
    /^\/v1\/bridge\/work\/[^/]+\/result$/.test(path)
  ) {
    return ['bridge:work:complete']
  }

  /*
   * The approval store and its delivery routes (cloud-relay/approvalStore.js,
   * cloud-relay/approvalDelivery.js). These were registered unreachable for
   * months — an unlisted path denies universally, admin included — which is
   * why the whole prepare/approve loop could be built, tested and never once
   * exercised over HTTP.
   *
   * Three scopes because they are three privileges:
   *   approval:read   — see what is waiting. Every owner surface lists.
   *   approval:write  — create records and attest delivery/settlement. Only
   *                     the Mac prepares plans and only relay-side machinery
   *                     attests, so this is the bridge's scope.
   *   approval:decide — answer. Every owner surface may decide any approval;
   *                     origin controls only where the prompt is pushed.
   */
  if (
    method === 'GET' &&
    (path === '/v1/approvals' || /^\/v1\/approvals\/[^/]+$/.test(path))
  ) {
    return ['approval:read']
  }
  if (method === 'POST' && path === '/v1/approvals') {
    return ['approval:write']
  }
  if (
    method === 'POST' &&
    /^\/v1\/approvals\/[^/]+\/(spoken|answer|settle)$/.test(path)
  ) {
    return ['approval:write']
  }
  if (method === 'POST' && /^\/v1\/approvals\/[^/]+\/decision$/.test(path)) {
    return ['approval:decide']
  }

  /*
   * The node mesh (cloud-relay/nodeMailbox.js). Send is separated from
   * receive because they are different privileges: a node that may be told
   * things is not automatically a node that may tell every other node things.
   * Ownership of the addressed inbox is enforced separately by
   * principalOwnsDevice in the handlers — a scope says "you may drain an
   * inbox", not "you may drain that one".
   */
  if (method === 'POST' && path === '/v1/node/messages') {
    return ['node:message:send']
  }
  if (
    (method === 'GET' && path === '/v1/node/inbox') ||
    (method === 'POST' && path === '/v1/node/inbox/ack')
  ) {
    return ['node:message:receive']
  }
  /* Who is holding a live mesh socket right now. Same audience as
   * /v1/devices/status and /v1/bridge/presence: observing reachability is not
   * the same privilege as using it. */
  if (method === 'GET' && path === '/v1/node/presence') {
    return ['device:status:read']
  }

  /*
   * local-agent/visionLoopRelay.js has named this route since it was written
   * and it was never added here, which means it was not merely unimplemented
   * — it was unreachable, 403 for every principal including the admin key,
   * because an unlisted path denies universally. The module's own
   * ENDPOINT_IMPLEMENTED=false is still the honest flag for the missing
   * handler; this entry only removes the second, invisible reason it could
   * never have worked. It classifies a structured digest of window controls
   * (never pixels — see that file's header), so it rides the same privilege
   * as the Mac's other planning calls.
   */
  if (method === 'POST' && path === '/v1/vision/classify-ui-state') {
    return ['mac:plan']
  }

  /*
   * The relay's own brain (cloud-relay/nodeInference.js). Its own scope, held
   * only by the nodes that have a brain to feed, because this is the one route
   * where a leaked token costs MONEY rather than access — every other scope
   * here bounds what a thief can read or do, and this one bounds what they can
   * spend. The per-device budget in nodeInference.js is the other half; a
   * scope alone would have been a door with no meter behind it.
   */
  if (method === 'POST' && path === '/v1/infer') {
    return ['llm:infer']
  }

  return null
}

/*
 * The two upgrade paths Express never sees. worker.js claims both before the
 * httpServerHandler because an Upgrade cannot be completed through it, so
 * their scope requirements cannot live in the table above — they are asserted
 * by the handlers themselves (bridgeHub.js, pendantConverse.js). Named here so
 * the socket requirements are reviewable in the same place as the HTTP ones,
 * and so a test can hold the handlers to them.
 */
export const SOCKET_SCOPES = Object.freeze({
  /* GET /v1/bridge/socket — the Mac's doorbell. Claiming is what the socket
   * exists to trigger, so it demands exactly the claim scope. */
  '/v1/bridge/socket': Object.freeze(['bridge:work:claim']),
  /*
   * GET /v1/node/socket — any node's mesh doorbell. Demands only the RECEIVE
   * scope: the socket's entire capability is being told that mail is waiting,
   * and sending is a separate HTTP route with its own scope. A node that may
   * be reached is not thereby a node that may reach everyone.
   *
   * Ownership is the other half and is not expressible here: the handler also
   * requires principalOwnsDevice(principal, deviceId), so a stolen extension
   * token opens the extension's socket and nothing else. Both halves are
   * asserted in bridgeHub.js's handleNodeSocketUpgrade.
   */
  '/v1/node/socket': Object.freeze(['node:message:receive']),
  /* GET /v1/pendant/converse — the pendant's full-duplex voice socket. It
   * uploads captured audio and receives the spoken reply, which is the same
   * pair of privileges as the HTTP /v1/pendant/command + speech-read paths. */
  '/v1/pendant/converse': Object.freeze([
    'pendant:audio:upload',
    'pendant:speech:read',
  ]),
})
