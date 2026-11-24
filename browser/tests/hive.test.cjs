const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// hive.js as it is, with each way out of the extension recorded: the browser's fetch, and the tailnet's (offscreen.js).
const source = readFileSync(`${__dirname}/../hive.js`, 'utf8').replace(/^export /gm, '');
function hive({ peers = [], answers = {}, mobile = false } = {}) {
  const seen = [];
  const stored = {};
  const answer = (url) => answers[url] || { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  const lib = vm.runInNewContext(`${source}\n({ api, tailnet, findServer, joinTailnet })`, {
    URL, Response, AbortSignal, JSON, crypto,
    navigator: mobile ? { userAgent: 'iPhone Safari' } : { userAgent: 'Chrome', userAgentData: { brands: [{ brand: 'Google Chrome' }] } },
    chrome: {
      storage: { local: { get: async () => stored, set: async (o) => Object.assign(stored, o) } },
      runtime: {
        sendMessage: async ({ tailnet, op, args }) => {
          if (op === 'peers') return peers;
          const [url, init] = args;
          seen.push([tailnet, op, url, init.method, init.headers?.authorization, init.body]);
          return answer(url);
        },
      },
    },
  });
  return { lib, seen, stored };
}

test('calls go through the tailnet, with their method, headers and body', async () => {
  const { lib, seen } = hive();
  assert.deepEqual({ ...await lib.api({ server: 'http://hive.example.ts.net', token: 't' }, '/api/node/hello', {}) }, { ok: true });
  await lib.api({ server: 'http://100.101.102.103', token: 't' }, '/api/state');
  assert.deepEqual(seen, [
    ['call', 'fetch', 'http://hive.example.ts.net/api/node/hello', 'POST', 'Bearer t', '{}'],
    ['call', 'fetch', 'http://100.101.102.103/api/state', 'GET', 'Bearer t', undefined],
  ]);
});

test("the tailnet's errors and 204s come back as the browser's would", async () => {
  const { lib } = hive();
  lib.tailnet.fetch = async () => ({ status: 204, headers: {}, body: '' });
  assert.equal(await lib.api({ server: 'http://hive.example.ts.net', token: 't' }, '/api/node/next?id=x'), null);
  lib.tailnet.fetch = async () => ({ error: "this browser's Tailscale isn't connected" });
  await assert.rejects(lib.api({ server: 'http://hive.example.ts.net', token: 't' }, '/api/state'), /isn't connected/);
});

const peer = (hostName, dnsName, online = true, ips = ['100.64.0.9']) => ({ online, hostName, dnsName, ips });

test("the Hive Server is the online machine named hive that answers /health as Hive", async () => {
  const notHive = { status: 200, headers: {}, body: '{"ok":false}' };
  const { lib, seen } = hive({
    peers: [peer('hive', 'hive.example.ts.net.', false), peer('laptop', 'laptop.example.ts.net.'), peer('hive-1', 'hive-1.example.ts.net.'), peer('hive-2', 'hive-2.example.ts.net.')],
    answers: { 'http://hive-1.example.ts.net/health': notHive },
  });
  assert.equal(await lib.findServer(), 'http://hive-2.example.ts.net');
  assert.deepEqual(seen.map((s) => s[2]), ['http://hive-1.example.ts.net/health', 'http://hive-2.example.ts.net/health']);
});

test('with MagicDNS off the Hive Server is found by its tailnet address; with none, nothing is', async () => {
  assert.equal(await hive({ peers: [peer('Hive', '', true, ['100.70.1.2', 'fd7a::1'])] }).lib.findServer(), 'http://100.70.1.2');
  assert.equal(await hive({ peers: [] }).lib.findServer(), null);
});

test('discovery reports a failed transport and still accepts another healthy server', async () => {
  const name = 'hive.example.ts.net';
  const error = { error: 'Dialer not initialized correctly' };
  const peers = [peer('hive', name)];
  const answers = { [`http://${name}/health`]: error };
  const { lib } = hive({ peers, answers });
  await assert.rejects(lib.joinTailnet(), e => e.again && e.message.includes(name) && e.message.includes(error.error));
  peers.push(peer('hive-2', 'hive-2.example.ts.net'));
  assert.equal(await lib.findServer(), 'http://hive-2.example.ts.net');
});

test('signing in with Tailscale joins the Hive Server it finds and keeps its key', async () => {
  const { lib, seen, stored } = hive({
    peers: [peer('hive', 'hive.example.ts.net.')],
    answers: { 'http://hive.example.ts.net/api/pair/tailnet': { status: 200, headers: {}, body: '{"token":"k"}' } },
  });
  await lib.joinTailnet();
  assert.deepEqual(seen.at(-1), ['call', 'fetch', 'http://hive.example.ts.net/api/pair/tailnet', 'POST', undefined, '{"kind":"browser","name":"Google Chrome"}']);
  assert.equal(stored.hive.server, 'http://hive.example.ts.net');
  assert.equal(stored.hive.token, 'k');
  assert.match(stored.hive.id, /^browser-/);
});

test("joining says why when there's no Hive Server yet (and tries again) or it refuses", async () => {
  await assert.rejects(hive().lib.joinTailnet(), (e) => e.again && /Looking for your Hive Server/.test(e.message));
  const refused = hive({
    peers: [peer('hive', 'hive.example.ts.net.')],
    answers: { 'http://hive.example.ts.net/api/pair/tailnet': { status: 403, headers: {}, body: '{"error":"Only your own devices"}' } },
  });
  await assert.rejects(refused.lib.joinTailnet(), (e) => !e.again && /Only your own devices/.test(e.message));
});

test('reconnecting asks which server to use and preserves the browser registration', async () => {
  const first = 'hive-1.example.ts.net';
  const second = 'hive-2.example.ts.net';
  const server = 'http://' + second;
  const { lib, seen, stored } = hive({
    peers: [peer('hive-1', first), peer('hive-2', second)],
    answers: { [server + '/api/pair/tailnet']: { status: 200, body: '{"token":"fresh"}' } },
  });
  stored.hive = { id: 'browser-existing', server: 'https://legacy.example', token: 'old' };
  await assert.rejects(lib.joinTailnet(), e => Array.from(e.servers).join(',') === ['http://' + first, server].join(','));
  assert.equal(stored.hive.token, 'old');
  assert.equal(seen.some(call => call[3] === 'POST'), false);
  await lib.joinTailnet(server);
  assert.equal(stored.hive.id, 'browser-existing');
  assert.equal(stored.hive.server, server);
  assert.equal(stored.hive.token, 'fresh');
  assert.equal(seen.at(-1)[4], undefined);
});

// The worker's side of "Sign in with Tailscale": it keeps trying until Tailscale is signed in and a Hive Server answers.
const worker = readFileSync(`${__dirname}/../worker.js`, 'utf8');
const pendingSource = worker.slice(worker.indexOf('let busy = false;'), worker.indexOf('\npending();'));
async function pending(db, joinTailnet) {
  const local = {
    get: async (keys) => Object.fromEntries([keys].flat().map((k) => [k, db[k]])),
    set: async (o) => Object.assign(db, o),
    remove: async (keys) => [keys].flat().forEach((k) => delete db[k]),
  };
  await vm.runInNewContext(`${pendingSource}\npending()`, { chrome: { storage: { local } }, joinTailnet });
  return db;
}

test('joining waits quietly for Tailscale sign-in, says when no Hive Server is online yet, and stops when refused', async () => {
  const fail = (again) => async () => { throw Object.assign(new Error('why'), { again }); };
  assert.deepEqual(await pending({ joining: true, tailnet: { state: 'NeedsLogin' } }, fail(true)), { joining: true, tailnet: { state: 'NeedsLogin' } });
  assert.deepEqual(await pending({ joining: true, tailnet: { state: 'Running' } }, fail(true)), { joining: true, tailnet: { state: 'Running' }, pairNote: 'why' });
  assert.deepEqual(await pending({ joining: true, tailnet: { state: 'Running' } }, fail(false)), { tailnet: { state: 'Running' }, pairNote: 'why' });
  assert.deepEqual(await pending({ joining: true, pairNote: 'why', tailnet: { state: 'Running' } }, async () => {}), { tailnet: { state: 'Running' } });
});

test('iPhone Safari registers its own identifiable browser node', async () => {
  const server = 'http://hive.example.ts.net';
  const {lib, stored} = hive({mobile:true, peers:[peer('hive','hive.example.ts.net')], answers:{
    [server+'/api/pair/tailnet']:{status:200,headers:{},body:'{"token":"test"}'}
  }});
  await lib.joinTailnet();
  assert.equal(stored.hive.name, 'Safari on iPhone');
});
