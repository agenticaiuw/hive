// What the worker and the popup share: this browser's connection to Hive's server (protocol/README.md).

export const conf = async () => (await chrome.storage.local.get('hive')).hive;

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

/** The Hive Server is on its owner's tailnet, at http://hive.<tailnet>.ts.net, and reached through Tailscale built into the
 * extension (tailnet.js). */
export const tailnet = {
  // Chrome, Edge and Brave run the node in an offscreen document, opened here when it isn't already. Safari has none: its
  // background page runs the node and replaces this (worker.js). Calls at once share one opening, so none asks before it
  // has loaded; a later one finds it open.
  call: async (op, ...args) => {
    await (opening ||= chrome.offscreen?.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: "Runs Tailscale's client, which reaches the owner's Hive on their tailnet." })
      .catch(() => {}).finally(() => { opening = null; }));
    return chrome.runtime.sendMessage({ tailnet: 'call', op, args });
  },
  fetch: (url, init) => tailnet.call('fetch', url, init),
  peers: () => tailnet.call('peers'),
};
let opening;
async function request(url, { signal, ...init }) {
  const r = await tailnet.fetch(url, init);
  if (r?.error) throw new Error(r.error);
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
}

/** The owner's Hive Server on their tailnet, as hive-tailnet's find does: an online machine named hive (hive-1, … when
 * there's more than one) that answers /health as Hive. Null when there's none, or this browser's Tailscale isn't signed in. */
export async function findServer(selected) {
  const peers = await tailnet.peers();
  if (peers?.error) throw new Error(peers.error);
  const matches = await Promise.all(peers.map(async (p) => {
    const host = p.dnsName.replace(/\.$/, '') || p.ips[0];
    if (!p.online || !/^hive/i.test(p.hostName) || !host) return;
    const server = `http://${host}`;
    if (selected && server !== selected) return;
    try {
      const r = await request(`${server}/health`, { timeout: 5000 });
      if (r.ok && (await r.json()).ok === true) return server;
    } catch {}
  }));
  const servers = [...new Set(matches.filter(Boolean))].sort();
  if (servers.length > 1) throw Object.assign(new Error('Choose your Hive Server.'), { servers });
  return servers[0] || null;
}

/** "Sign in with Tailscale": join the Hive Server on the owner's tailnet, which knows this browser is theirs by its
 * Tailscale account. */
export async function joinTailnet(selected) {
  const server = await findServer(selected);
  if (!server) throw Object.assign(new Error('Looking for your Hive Server… Make sure it is on and signed in to the same Tailscale account.'), { again: true });
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand);
  const safari = !brands.length && /Safari/.test(navigator.userAgent) && !/Chrom/.test(navigator.userAgent);
  const name = safari ? 'Safari' : brands.find((b) => !/Not.A.Brand|Chromium/i.test(b)) || 'Chrome';
  const r = await request(`${server}/api/pair/tailnet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'browser', name }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Hive answered ${r.status}`);
  if (!j.token) throw new Error('Hive did not return a browser pairing.');
  const previous = await conf();
  const c = { server, token: j.token, id: previous?.id || `browser-${crypto.randomUUID().slice(0, 8)}`, name };
  await chrome.storage.local.set(previous?.server === server ? { hive: c } : { hive: c, last: [] });
  return c;
}
