const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// hive.js as it is, with each way out of the extension recorded: the browser's fetch, and the tailnet's (offscreen.js).
const source = readFileSync(`${__dirname}/../hive.js`, 'utf8').replace(/^export /gm, '');
function hive() {
  const seen = [];
  const answer = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  const lib = vm.runInNewContext(`${source}\n({ api, tailnet })`, {
    URL, Response, AbortSignal, JSON,
    fetch: async (url) => { seen.push(['browser', url]); return new Response(answer.body, answer); },
    chrome: { runtime: { sendMessage: async (m) => { seen.push(['tailnet', m.tailnet, m.url, m.init.method, m.init.headers.authorization, m.init.body]); return answer; } } },
  });
  return { lib, seen };
}

test('a .ts.net server goes through the tailnet, with its method, headers and body', async () => {
  const { lib, seen } = hive();
  assert.deepEqual({ ...await lib.api({ server: 'https://hive.example.ts.net', token: 't' }, '/api/node/hello', {}) }, { ok: true });
  assert.deepEqual(seen, [['tailnet', 'fetch', 'https://hive.example.ts.net/api/node/hello', 'POST', 'Bearer t', '{}']]);
});

test('any other server is fetched directly', async () => {
  const { lib, seen } = hive();
  await lib.api({ server: 'https://hive.example.com', token: 't' }, '/api/state');
  await lib.api({ server: 'https://ts.net.example.com', token: 't' }, '/api/state');
  assert.deepEqual(seen, [['browser', 'https://hive.example.com/api/state'], ['browser', 'https://ts.net.example.com/api/state']]);
});

test("the tailnet's errors and 204s come back as the browser's would", async () => {
  const { lib } = hive();
  lib.tailnet.fetch = async () => ({ status: 204, headers: {}, body: '' });
  assert.equal(await lib.api({ server: 'https://hive.example.ts.net', token: 't' }, '/api/node/next?id=x'), null);
  lib.tailnet.fetch = async () => ({ error: "this browser's Tailscale isn't connected" });
  await assert.rejects(lib.api({ server: 'https://hive.example.ts.net', token: 't' }, '/api/state'), /isn't connected/);
});
