// No real window can be registered here. This rejects all scoped lookups until a
// trustworthy creation/ownership mechanism is independently designed and tested.
const discovery = AgentWindowDiscovery.makeDiscovery(globalThis.browser?.windows, []);
// The native port is the documented containing-app channel. No messages, profile
// data or browser state are logged, persisted, or reflected back to senders.
try {
  const port = browser.runtime.connectNative('local.personal-agent.Agent');
  port.onMessage.addListener(message => {
    discovery.handle(message).then(reply => port.postMessage(reply)).catch(() => {});
  });
} catch (_) { /* Unavailable: no fallback or action. */ }
