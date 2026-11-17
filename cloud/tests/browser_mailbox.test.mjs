// The browser command mailbox (cloud/tasks/browser.js) against the real migration, on node:sqlite
// standing in for D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { browserRoute, MAX_AGE_MS, RUN_MS } from '../tasks/browser.js';

const migration = readFileSync(new URL('../knowledge/migrations/0012_browser_commands.sql', import.meta.url), 'utf8');

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(migration);
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    batchOne: () => (/\bRETURNING\b|^\s*SELECT/i.test(sql) ? { results: db.prepare(sql).all(...args) } : { results: [], meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => list.map((s) => s.batchOne()), db };
}

const auth = {
  machineAllowed: async (request) => request.headers.get('authorization') === 'Bearer machine',
  extensionAllowed: async (request) => /^Bearer ext\.[a-z0-9-]+\.mac$/.test(request.headers.get('authorization') || ''),
};

function setup() {
  const env = { DB: fakeD1() };
  const clock = { t: 1_000_000_000 };
  const call = async (who, method, path, body) => {
    const url = new URL(`https://board.test${path}`);
    const request = new Request(url, {
      method,
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await browserRoute(request, env, url, auth, { tickMs: 5, clock: () => clock.t });
    return { status: response.status, body: await response.json() };
  };
  return { env, clock, call };
}

const MAC = 'machine';
const SAFARI = 'ext.owner-mac-browser.mac';

test('a command goes to the browser, runs once, and its result comes back', async () => {
  const { call } = setup();
  const sent = await call(MAC, 'POST', '/v1/browser/commands', { action: { type: 'list_tabs' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.command.status, 'queued');
  assert.deepEqual(sent.body.browsers, []);

  const next = await call(SAFARI, 'GET', '/v1/browser/next?browser=safari');
  assert.deepEqual(next.body.command.action, { type: 'list_tabs', params: {} });
  assert.equal(next.body.command.commandId, String(sent.body.command.id));
  assert.ok(Number.isFinite(Date.parse(next.body.command.createdAt)));

  // Nobody gets it a second time.
  assert.equal((await call(SAFARI, 'GET', '/v1/browser/next?browser=safari')).body.command, null);

  const saved = await call(SAFARI, 'POST', '/v1/browser/result', { id: next.body.command.commandId, ok: true, result: { tabs: [{ title: 'Canvas' }] } });
  assert.equal(saved.body.saved, 1);
  // Only once, too.
  assert.equal((await call(SAFARI, 'POST', '/v1/browser/result', { id: next.body.command.commandId, ok: true, result: {} })).body.saved, 0);

  const state = await call(MAC, 'GET', `/v1/browser/commands?id=${sent.body.command.id}`);
  assert.equal(state.body.command.status, 'done');
  assert.equal(state.body.command.browser, 'owner-mac-browser/safari');
  assert.deepEqual(state.body.command.result, { tabs: [{ title: 'Canvas' }] });
});

test('a sender that waits gets the answer as soon as the browser sends it', async () => {
  const { call } = setup();
  const waiting = call(MAC, 'POST', '/v1/browser/commands', { action: { type: 'navigate', params: { url: 'https://canvas.wisc.edu' } }, wait: 5 });
  const next = await call(SAFARI, 'GET', '/v1/browser/next?browser=safari&wait=2');
  await call(SAFARI, 'POST', '/v1/browser/result', { id: next.body.command.commandId, ok: false, error: 'Page access denied' });
  const sent = await waiting;
  assert.equal(sent.body.command.status, 'failed');
  assert.equal(sent.body.command.error, 'Page access denied');
});

test('the browser waits for a command that comes while it is asking', async () => {
  const { call } = setup();
  const asking = call(SAFARI, 'GET', '/v1/browser/next?browser=safari&wait=3');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await call(MAC, 'POST', '/v1/browser/commands', { action: { type: 'capture' } });
  assert.equal((await asking).body.command.action.type, 'capture');
});

test('a command for Chrome is not taken by Safari', async () => {
  const { call } = setup();
  await call(MAC, 'POST', '/v1/browser/commands', { action: { type: 'list_tabs' }, browser: 'chrome' });
  assert.equal((await call(SAFARI, 'GET', '/v1/browser/next?browser=safari')).body.command, null);
  assert.equal((await call(SAFARI, 'GET', '/v1/browser/next?browser=chrome')).body.command.action.type, 'list_tabs');
});

test('nobody took it in time: expired, and the sender hears which browsers are listening', async () => {
  const { call, clock } = setup();
  await call(SAFARI, 'GET', '/v1/browser/next?browser=safari');
  const sent = await call(MAC, 'POST', '/v1/browser/commands', { action: { type: 'list_tabs' }, browser: 'chrome' });
  clock.t += MAX_AGE_MS + 1;
  const state = await call(MAC, 'GET', `/v1/browser/commands?id=${sent.body.command.id}`);
  assert.equal(state.body.command.status, 'expired');
  assert.match(state.body.command.error, /isn't connected/);
  assert.deepEqual(state.body.browsers, []); // Safari's last ask is now over a minute old
  // And no browser runs it later.
  assert.equal((await call(SAFARI, 'GET', '/v1/browser/next?browser=chrome')).body.command, null);
});

test('taken but never answered: lost, never handed out again', async () => {
  const { call, clock } = setup();
  const sent = await call(MAC, 'POST', '/v1/browser/commands', { action: { type: 'read_page' } });
  await call(SAFARI, 'GET', '/v1/browser/next?browser=safari');
  clock.t += RUN_MS + 1;
  const state = await call(MAC, 'GET', `/v1/browser/commands?id=${sent.body.command.id}`);
  assert.equal(state.body.command.status, 'lost');
  assert.equal((await call(SAFARI, 'GET', '/v1/browser/next?browser=safari')).body.command, null);
  assert.equal((await call(SAFARI, 'POST', '/v1/browser/result', { id: sent.body.command.id, ok: true })).body.saved, 0);
});

test('status lists the browsers that asked in the last minute', async () => {
  const { call } = setup();
  await call(SAFARI, 'GET', '/v1/browser/next?browser=safari');
  assert.deepEqual((await call(MAC, 'GET', '/v1/browser/status')).body.browsers, ['owner-mac-browser/safari']);
});

test('keys reach only their own side, and unknown commands are refused', async () => {
  const { call } = setup();
  assert.equal((await call(SAFARI, 'POST', '/v1/browser/commands', { action: { type: 'list_tabs' } })).status, 401);
  assert.equal((await call(SAFARI, 'GET', '/v1/browser/status')).status, 401);
  assert.equal((await call(MAC, 'GET', '/v1/browser/next')).status, 401);
  assert.equal((await call('nobody', 'POST', '/v1/browser/result', { id: 1, ok: true })).status, 401);
  assert.equal((await call(MAC, 'POST', '/v1/browser/commands', { action: { type: 'run_script' } })).status, 400);
});

test('a result too big for one row is kept as an error instead', async () => {
  const { call } = setup();
  const sent = await call(MAC, 'POST', '/v1/browser/commands', { action: { type: 'capture' } });
  await call(SAFARI, 'GET', '/v1/browser/next?browser=safari');
  await call(SAFARI, 'POST', '/v1/browser/result', { id: sent.body.command.id, ok: true, result: { dataUrl: 'x'.repeat(1_900_000) } });
  const state = await call(MAC, 'GET', `/v1/browser/commands?id=${sent.body.command.id}`);
  assert.equal(state.body.command.status, 'failed');
  assert.match(state.body.command.error, /too big/);
});

test('a sender that gives up cancels it, and no browser runs it late', async () => {
  const { call } = setup();
  const sent = await call(MAC, 'POST', '/v1/browser/commands', { action: { type: 'list_tabs' } });
  const id = sent.body.command.id;
  assert.equal((await call(SAFARI, 'POST', '/v1/browser/cancel', { id })).status, 401, 'only machines cancel');
  assert.deepEqual((await call(MAC, 'POST', '/v1/browser/cancel', { id })).body, { ok: true, cancelled: 1 });
  assert.equal((await call(SAFARI, 'GET', '/v1/browser/next?browser=safari')).body.command, null);
  const state = await call(MAC, 'GET', `/v1/browser/commands?id=${id}`);
  assert.equal(state.body.command.status, 'cancelled');
  assert.match(state.body.command.error, /gave up/);
  assert.deepEqual((await call(MAC, 'POST', '/v1/browser/cancel', { id })).body, { ok: true, cancelled: 0 }, 'cancelling twice changes nothing');
});
