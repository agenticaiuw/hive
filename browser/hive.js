// What the worker and the popup share: this browser's connection to Hive's server (protocol/README.md).

export const conf = async () => (await chrome.storage.local.get('hive')).hive || (joining ||= fromApp().catch(() => null).finally(() => { joining = null; }));

/** Hive for Safari comes inside the Mac app: it asks the app's extension handler for the Mac's pairing and connects as a
 * device of its own, with no link and even with the app closed, under one id per Mac however often it joins again (Safari
 * forgets the extension's storage when the app is replaced). Elsewhere there is no handler, so it waits for a link. */
let joining;
async function fromApp() {
  const mac = await chrome.runtime.sendNativeMessage?.('app.hive.mac', {});
  if (!mac?.server || !mac?.token) return null;
  const { code } = await api(mac, '/api/pair/code', {});
  return pair(`${mac.server}/#pair=${code}`, mac.id && `browser-${mac.id}`);
}

/** Call Hive's server. JSON in and out; null for 204. */
export async function api(c, path, body, method) {
  const r = await request(c.server + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(40_000), // a dropped connection never answers, and the wait for a call is 25s
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Hive answered ${r.status}`);
  return j;
}

/** A Hive at home that only its owner's tailnet reaches is served at https://hive.<tailnet>.ts.net, and reached through
 * Tailscale built into the extension (tailnet.js); any other server, directly. */
export const onTailnet = (url) => { try { return new URL(url).hostname.endsWith('.ts.net'); } catch { return false; } };
export const tailnet = {
  // Chrome, Edge and Brave run the node in an offscreen document, opened here when it isn't already. Safari has none: its
  // background page runs the node and replaces this (worker.js). Calls at once share one opening, so none asks before it
  // has loaded; a later one finds it open.
  fetch: async (url, init) => {
    await (opening ||= chrome.offscreen?.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: "Runs Tailscale's client, which reaches the owner's Hive on their tailnet." })
      .catch(() => {}).finally(() => { opening = null; }));
    return chrome.runtime.sendMessage({ tailnet: 'fetch', url, init });
  },
};
let opening;
async function request(url, { signal, ...init }) {
  if (!onTailnet(url)) return fetch(url, { ...init, signal });
  const r = await tailnet.fetch(url, init);
  if (r?.error) throw new Error(r.error);
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
}

/** Connect this browser with the link the dashboard's "Pair a device" copies: https://<server>/#pair=<code>. */
export async function pair(link, id) {
  const [server, code] = link.trim().split('/#pair=');
  if (!code) throw new Error("That isn't a pairing link. On your Hive dashboard, choose Pair a device and paste the link it copies.");
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand);
  const safari = !brands.length && /Safari/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent);
  const name = safari ? 'Safari' : brands.find((b) => !/Not.A.Brand|Chromium/i.test(b)) || 'Chrome';
  const r = await request(`${server}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, kind: 'browser', name }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Hive answered ${r.status}`);
  const c = { server, token: j.token, id: id || `browser-${crypto.randomUUID().slice(0, 8)}`, name };
  await chrome.storage.local.set({ hive: c });
  return c;
}
