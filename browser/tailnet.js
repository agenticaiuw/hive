// Tailscale built into the extension (tailnet/), for a Hive at home that only its owner's tailnet reaches. Chrome, Edge and
// Brave run it in offscreen.html; Safari, which has no offscreen documents, in its background page (worker.js).

/** Starts this browser's node and returns it: {fetch, peers}. store keeps its state (so it stays signed in); status gets {state, url}. */
export async function start(store) {
  await import('./tailnet/wasm_exec.js');
  const go = new Go();
  const wasm = await (await fetch(new URL('tailnet/tailnet.wasm', import.meta.url))).arrayBuffer();
  go.run((await WebAssembly.instantiate(wasm, go.importObject)).instance);
  const state = await store.load();
  // One name per browser on the owner's tailnet, kept with the node's state.
  if (!state.hostname) store.save('hostname', (state.hostname = `hive-browser-${crypto.randomUUID().slice(0, 8)}`));
  const err = hiveTailnet.start({ getState: (k) => state[k] || '', setState: (k, v) => { state[k] = v; store.save(k, v); } }, state.hostname, store.status);
  if (err) throw new Error(err);
  return { fetch: (url, init) => hiveTailnet.fetch(url, init), peers: async () => hiveTailnet.peers() };
}

/** The node's state and status in this extension's storage, for wherever chrome.storage is (not an offscreen document). */
export const storage = {
  load: async () => Object.fromEntries(Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith('ts:')).map(([k, v]) => [k.slice(3), v])),
  save: (k, v) => chrome.storage.local.set({ [`ts:${k}`]: v }),
  status: (s) => chrome.storage.local.set({ tailnet: s }),
};
