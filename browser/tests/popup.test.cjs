const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const code = file => readFileSync(`${__dirname}/../${file}`, 'utf8');
const server = 'http://hive.example.ts.net';
const c = { id: 'browser-test', token: 'test-only', server };
const desktop = 'http://127.0.0.1:8791/';

test('a saved session hides sign-in after authentication and offers it again on disconnect', async () => {
  const nodes = {};
  let response = { status: 200, body: '{"ok":true}' };
  const db = { hive: c, pairNote: 'Old pairing notice' };
  const document = { getElementById: id => nodes[id] ||= { replaceChildren() {} } };
  const popup = code('popup.js').replace(/^import .*$/gm, '').split('chrome.storage.onChanged')[0];
  const check = vm.runInNewContext(`${popup}\ncheckSession`, { URL, document, setTimeout, clearTimeout,
    chrome: { storage: { local: { get: async () => db } } }, conf: async () => db.hive,
    tailnet: { fetch: async (url, init) => {
      assert.equal(url, server + '/api/me'); assert.equal(init.headers.authorization, 'Bearer test-only'); return response;
    } },
  });
  await check(); assert.equal(nodes.join.hidden, true); assert.match(nodes.server.textContent, /Connected to/);
  assert.equal(nodes.dashboard.href, server + '/'); assert.equal(nodes.pairNote.textContent, '');
  response = { status: 401, body: '{}' }; await check(); assert.equal(nodes.join.hidden, false);
  db.hive = null; await check(); assert.equal(nodes.footer.hidden, true); assert.equal(nodes.join.hidden, false);
  assert.match(code('popup.html'), /<\/form>[\s\S]*<footer[^>]*>[\s\S]*Open dashboard<\/a>/);
});

function dashboard({ direct = false, same = true, existing = false } = {}) {
  const actions = [];
  const tabs = {
    query: async options => {
      assert.deepEqual({ ...options }, { currentWindow: true });
      const others = [{ id: 1 }, { id: 2, url: 'http://127.0.0.1:8790/' }, { id: 3, url: desktop + 'api/state' }];
      return existing ? [...others, { id: 4, url: desktop + '#Devices' }] : others;
    },
    get: async () => ({ status: 'complete' }),
    create: async o => { actions.push(['create', o.url, o.active]); return { id: 5 }; },
    update: async (id, o) => actions.push(['update', id, o.active]), remove: async id => actions.push(['remove', id]),
  };
  const fetch = async (url, opts) => {
    if (url === '/api/state?view=dashboard') return { ok: true, json: async () => ({ now: 1000000, nodes: [{ id: c.id, kind: 'browser', seen: same ? 1000000 : 1 }] }) };
    assert.equal(opts.credentials, 'omit'); assert.equal(opts.headers, undefined);
    return { ok: direct || url.origin + '/' === desktop, json: async () => ({ ok: true }) };
  };
  const scripting = { executeScript: async ({func, args}) => [{ result: await func(...args) }] };
  const open = vm.runInNewContext(code('dashboard.js').replace('export async', 'async') + '\nopenDashboard', {
    URL, AbortSignal, fetch, location: new URL(desktop), chrome: { tabs, scripting },
  });
  return { run: () => open(c), actions };
}

test('dashboard opens the reachable saved origin without a credential in the URL', async () => {
  const d = dashboard({ direct: true }); await d.run(); assert.deepEqual(d.actions, [['create', server + '/', undefined]]);
});
test('dashboard reuses the verified desktop tab when only the embedded tailnet can reach Hive', async () => {
  const d = dashboard({ existing: true }); await d.run(); assert.deepEqual(d.actions, [['update', 4, true]]);
});
test('dashboard dismisses its own background tab if that server has only a stale registration', async () => {
  const d = dashboard({ same: false }); await assert.rejects(d.run(), /same Tailscale network/);
  assert.deepEqual(d.actions, [['create', desktop, false], ['remove', 5]]);
});

test('retry immediately asks the worker to reconnect to the saved Tailscale server', async () => {
  const form = {}, writes = [], messages = [];
  const source = code('popup.js').split('async function join(server) {')[1].split("$('join').onclick")[0];
  const join = vm.runInNewContext('let signIn = false; async function join(server) {' + source + '\njoin', {
    $: () => form, conf: async () => c, tailscale: async () => {},
    chrome: { storage: { local: { set: async change => writes.push(change) } },
      runtime: { sendMessage: async msg => messages.push(msg.hiveJoin) } },
  });
  await join();
  assert.equal(writes[0].joining, c.server);
  assert.match(form.textContent, /Connecting/);
  assert.deepEqual(messages, [true]);
  await join(true);
  assert.equal(writes[1].joining, true);
});
