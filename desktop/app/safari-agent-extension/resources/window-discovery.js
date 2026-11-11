/* Read-only capability and scoped lookup. There is deliberately no production
 * registration path: a WebExtension window ID alone is not proof of ownership.
 * `owned` and `windows` are injected only at construction, for offline tests and
 * for a future separately reviewed ownership mechanism. Never enumerate windows
 * or ask for tabs, URLs, titles, geometry or profile information. */
(function (root) {
  'use strict';
  function makeDiscovery(windows, owned) {
    const allowed = new Map(owned);
    async function handle(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return {status: 'rejected'};
      const keys = Object.keys(message).sort().join(',');
      if (keys === 'operation,version' && message.version === '1' && message.operation === 'capabilities') {
        return {status: 'ok', scoped_lookup: typeof windows?.get === 'function' ? 'api_present_unverified' : 'unavailable',
          registration: 'unsupported', session_sharing: 'unverified', noninterference: 'unverified'};
      }
      if (keys !== 'operation,slot,version' || message.version !== '1' || message.operation !== 'owned_window_status' ||
          message.slot !== 'agent-window' || !allowed.has(message.slot)) return {status: 'rejected'};
      const id = allowed.get(message.slot);
      if (!Number.isSafeInteger(id) || id <= 0 || typeof windows?.get !== 'function') return {status: 'unavailable'};
      try {
        const found = await windows.get(id, {populate: false});
        // This confirms only the ID returned by the mocked or browser API; it is
        // not evidence of window lifetime, ownership, focus, or isolation.
        return found && found.id === id ? {status: 'observed', ownership: 'unverified'} : {status: 'unavailable'};
      } catch (_) { return {status: 'unavailable'}; }
    }
    return Object.freeze({handle});
  }
  if (typeof module === 'object' && module.exports) module.exports = {makeDiscovery};
  else root.AgentWindowDiscovery = Object.freeze({makeDiscovery});
})(globalThis);
