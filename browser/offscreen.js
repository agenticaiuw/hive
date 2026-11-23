// Chrome, Edge and Brave: this browser's Tailscale node lives here, in an offscreen document, because the worker is stopped
// whenever it's idle and the node must stay connected. Only chrome.runtime reaches here, so its state and status are
// kept by the worker.
import { start } from './tailnet.js';

const send = (m) => chrome.runtime.sendMessage(m);
const node = start({
  load: () => send({ tailnet: 'load' }),
  save: (key, value) => send({ tailnet: 'save', key, value }),
  status: (status) => send({ tailnet: 'status', status }),
});
chrome.runtime.onMessage.addListener((m, _, reply) => {
  if (m.tailnet !== 'fetch') return;
  node.then((f) => f(m.url, m.init)).then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});
