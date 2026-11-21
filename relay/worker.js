// Hive's relay. A Hive on a home computer has no public address, so it keeps a long poll open here and answers the requests
// that arrive for it: https://home.agenticaiuw.com/<id>/ is that Hive. The Hive app makes the id and the key that claims it.
// Requests go to the Hive as plain HTTP and its answers come back the same way (server/src/relay.rs).
const PASS = ['cookie', 'authorization', 'content-type'];

export default {
  fetch(req, env) {
    const url = new URL(req.url);
    const [, id, ...rest] = url.pathname.split('/');
    if (!/^[a-z0-9]{12,64}$/.test(id || '')) return new Response('Hive\'s relay. Open your Hive at the link the Hive app gave you.', { status: 404 });
    if (!rest.length) return Response.redirect(`${url.origin}/${id}/${url.search}`, 301);
    return env.HOME.get(env.HOME.idFromName(id)).fetch(req);
  },
};

export class Home {
  constructor(ctx) { this.ctx = ctx; this.queue = []; this.pollers = []; this.replies = new Map(); this.seen = 0; }

  async fetch(req) {
    const url = new URL(req.url);
    const [, id, ...rest] = url.pathname.split('/');
    const path = '/' + rest.join('/');
    if (path === '/.relay/poll' || path === '/.relay/reply') {
      if (!(await this.owner(req.headers.get('x-hive-key') || ''))) return new Response('That key doesn\'t own this address.', { status: 403 });
      if (path === '/.relay/reply') { this.replies.get(req.headers.get('x-rid'))?.(await req.arrayBuffer()); return new Response('ok'); }
      return this.poll();
    }
    if (Date.now() - this.seen > 40000) return new Response('This Hive is offline: its computer needs to be on, with the Hive app open.', { status: 503 });
    const body = new Uint8Array(await req.arrayBuffer());
    const head = `${req.method} ${path}${url.search} HTTP/1.1\r\n` + PASS.filter((k) => req.headers.has(k)).map((k) => `${k}: ${req.headers.get(k)}\r\n`).join('')
      + `content-length: ${body.length}\r\n\r\n`;
    const rid = crypto.randomUUID();
    const answer = new Promise((resolve) => { this.replies.set(rid, resolve); setTimeout(() => resolve(null), 180000); });
    this.give({ rid, bytes: concat(new TextEncoder().encode(head), body) });
    const raw = await answer;
    this.replies.delete(rid);
    return raw ? response(new Uint8Array(raw), id) : new Response('Your Hive didn\'t answer in time.', { status: 504 });
  }

  // The first key to poll for an id owns it.
  async owner(key) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const known = await this.ctx.storage.get('key');
    if (!known && key.length >= 32) await this.ctx.storage.put('key', hash);
    return key.length >= 32 && (known || hash) === hash;
  }

  async poll() {
    this.seen = Date.now();
    const item = this.queue.shift() || await new Promise((resolve) => {
      const p = { resolve, done: false };
      this.pollers.push(p);
      setTimeout(() => { p.done = true; resolve(null); }, 25000);
    });
    this.seen = Date.now();
    return item ? new Response(item.bytes, { headers: { 'x-rid': item.rid } }) : new Response(null, { status: 204 });
  }

  give(item) {
    for (let p; (p = this.pollers.shift());) if (!p.done) { p.done = true; return p.resolve(item); }
    this.queue.push(item);
  }
}

function concat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }

// The Hive's HTTP answer as a Response; its cookies stay under its own /<id>/.
function response(raw, id) {
  let end = 0;
  while (end + 3 < raw.length && !(raw[end] === 13 && raw[end + 1] === 10 && raw[end + 2] === 13 && raw[end + 3] === 10)) end++;
  const [first, ...lines] = new TextDecoder().decode(raw.subarray(0, end)).split('\r\n');
  const status = Number(first.split(' ')[1]) || 502;
  const headers = new Headers();
  for (const line of lines) {
    const i = line.indexOf(':'), k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'content-length' || k === 'connection') continue;
    headers.append(k, k === 'set-cookie' ? v.replace(/Path=\/(;|$)/i, `Path=/${id}/$1`) : v);
  }
  return new Response([101, 204, 205, 304].includes(status) ? null : raw.subarray(end + 4), { status, headers });
}
