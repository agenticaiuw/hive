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
  /* GET /v1/pendant/converse — the pendant's full-duplex voice socket. It
   * uploads captured audio and receives the spoken reply, which is the same
   * pair of privileges as the HTTP /v1/pendant/command + speech-read paths. */
  '/v1/pendant/converse': Object.freeze([
    'pendant:audio:upload',
    'pendant:speech:read',
  ]),
})
