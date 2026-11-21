// What the worker and the popup share: this browser's connection to Hive's server (protocol/README.md).

export const conf = async () => (await chrome.storage.local.get('hive')).hive || null;

/** Call Hive's server. JSON in and out; null for 204. */
export async function api(c, path, body, method) {
  const r = await fetch(c.server + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Hive answered ${r.status}`);
  return j;
}

/** Connect this browser with a code from the dashboard's "Pair a device". */
export async function pair(server, code) {
  server = server.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(server)) server = `https://${server}`;
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand);
  const name = brands.find((b) => !/Not.A.Brand|Chromium/i.test(b)) || 'Chrome';
  const r = await fetch(`${server}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), kind: 'browser', name }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Hive answered ${r.status}`);
  const c = { server, token: j.token, id: `browser-${crypto.randomUUID().slice(0, 8)}`, name };
  await chrome.storage.local.set({ hive: c });
  return c;
}
