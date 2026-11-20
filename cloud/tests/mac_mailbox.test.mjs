// The Mac call mailbox (cloud/tasks/mac.js) against every migration, on node:sqlite standing in for
// D1: Hive's agent in the cloud calls a tool on the owner's Mac, Hive on the Mac runs it once and the
// result comes back, with the owner's own words for the one-way step check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MAX_AGE_MS, RUN_MS, macRoute } from '../tasks/mac.js';

const dir = new URL('../knowledge/migrations/', import.meta.url);
const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, dir), 'utf8'));

// D1 binds ?1, ?2 by number (one can appear twice); node:sqlite binds those only by name.
const numbered = (sql, args) => (/\?\d/.test(sql)
  ? [sql.replace(/\?(\d+)/g, '$$p$1'), [Object.fromEntries(args.map((v, i) => [`p${i + 1}`, v]))]]
  : [sql, args]);

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const sql of migrations) db.exec(sql);
  const statement = (given, values = []) => {
    const [sql, args] = numbered(given, values);
    return {
      bind: (...more) => statement(given, more),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      batchOne: () => (/\bRETURNING\b|^\s*SELECT/i.test(sql) ? { results: db.prepare(sql).all(...args) } : { results: [], meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    };
  };
  return { prepare: (sql) => statement(sql), batch: async (list) => list.map((s) => s.batchOne()), db };
}

const auth = { machineAllowed: async (request) => request.headers.get('authorization') === 'Bearer machine' };

function setup() {
  const env = { DB: fakeD1() };
  const clock = { t: 1_000_000_000 };
  const call = async (method, path, body, who = 'machine') => {
    const url = new URL(`https://board.test${path}`);
    const request = new Request(url, {
      method,
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await macRoute(request, env, url, auth, { tickMs: 5, clock: () => clock.t });
    return { status: response.status, body: await response.json() };
  };
  return { env, clock, call };
}

const TOOLS = [{ name: 'screenshot', description: 'See the screen.', inputSchema: { type: 'object', properties: { step: { type: 'string' } } } }];

test("a call goes to the Mac with the owner's words, runs once, and its result comes back", async () => {
  const { env, call } = setup();
  env.DB.db.exec(`INSERT INTO board_requests (id, agent, status, created_at, updated_at, follows) VALUES (6, 'hive-cloud', 'done', 1, 1, NULL), (7, 'hive-cloud', 'working', 1, 1, 6);
    INSERT INTO board_messages (machine, id, harness, session, project, text, said_at, times, synced_at) VALUES
      ('cloud', 6, 'hive', 'mac', '', 'open my notes', 1, 1, 1), ('cloud', 7, 'hive', 'mac', '', 'now delete the "groceries" note', 1, 1, 1);`);
  assert.equal((await call('POST', '/v1/mac/hello', { mac: 'Owner-MBP', tools: TOOLS, about: "The user's Mac" })).body.tools, 1);
  const status = await call('GET', '/v1/mac/status?tools=1');
  assert.deepEqual(status.body.macs.map((m) => [m.name, m.tools.length]), [['owner-mbp', 1]]);

  const sent = await call('POST', '/v1/mac/calls', { name: 'screenshot', arguments: { step: 'Look' }, request: 7 });
  assert.equal(sent.body.call.status, 'queued');
  assert.deepEqual(sent.body.macs.map((m) => m.name), ['owner-mbp']);

  const next = await call('GET', '/v1/mac/next?mac=owner-mbp');
  assert.deepEqual(next.body.call, {
    id: sent.body.call.id, name: 'screenshot', arguments: { step: 'Look' }, request: 7,
    words: 'open my notes\nnow delete the "groceries" note',
  });
  assert.equal((await call('GET', '/v1/mac/next?mac=owner-mbp')).body.call, null, 'nobody gets it twice');
  assert.equal((await call('GET', '/v1/mac/next?mac=other-mac')).body.call, null);

  const result = { content: [{ type: 'text', text: 'Notes is in front.' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] };
  assert.equal((await call('POST', '/v1/mac/result', { id: sent.body.call.id, result })).body.saved, 1);
  assert.equal((await call('POST', '/v1/mac/result', { id: sent.body.call.id, result })).body.saved, 0, 'answered once');
  const got = await call('GET', `/v1/mac/calls?id=${sent.body.call.id}`);
  assert.deepEqual(got.body.call, { id: sent.body.call.id, status: 'done', mac: 'owner-mbp', result });
});

test('a call for one Mac waits for that Mac; a tool error comes back as an MCP error result', async () => {
  const { call } = setup();
  const sent = await call('POST', '/v1/mac/calls', { name: 'click', arguments: { x: 1, y: 2 }, mac: 'work-mac' });
  assert.equal((await call('GET', '/v1/mac/next?mac=owner-mbp')).body.call, null);
  const next = await call('GET', '/v1/mac/next?mac=work-mac');
  assert.equal(next.body.call.words, '', 'sent for no request: no words, so a one-way step is refused');
  const refused = { content: [{ type: 'text', text: 'The user has kept using the mouse.' }], isError: true };
  await call('POST', '/v1/mac/result', { id: next.body.call.id, result: refused });
  assert.deepEqual((await call('GET', `/v1/mac/calls?id=${sent.body.call.id}`)).body.call.result, refused);
  const failed = await call('POST', '/v1/mac/calls', { name: 'click', arguments: {} });
  await call('GET', '/v1/mac/next?mac=owner-mbp');
  await call('POST', '/v1/mac/result', { id: failed.body.call.id, error: 'MacTools panicked' });
  assert.deepEqual((await call('GET', `/v1/mac/calls?id=${failed.body.call.id}`)).body.call,
    { id: failed.body.call.id, status: 'failed', mac: 'owner-mbp', error: 'MacTools panicked' });
});

test('a call no Mac takes expires and says why; one taken and never answered is lost; a cancelled one never runs', async () => {
  const { clock, call } = setup();
  const lonely = await call('POST', '/v1/mac/calls', { name: 'screenshot', arguments: {} });
  clock.t += MAX_AGE_MS + 1;
  const expired = await call('GET', `/v1/mac/calls?id=${lonely.body.call.id}`);
  assert.equal(expired.body.call.status, 'expired');
  assert.match(expired.body.call.error, /Hive isn't running on the owner's Mac/);
  assert.equal((await call('GET', '/v1/mac/next?mac=owner-mbp')).body.call, null);

  const taken = await call('POST', '/v1/mac/calls', { name: 'screenshot', arguments: {} });
  await call('GET', '/v1/mac/next?mac=owner-mbp');
  clock.t += RUN_MS + 1;
  assert.equal((await call('GET', `/v1/mac/calls?id=${taken.body.call.id}`)).body.call.status, 'lost');

  const dropped = await call('POST', '/v1/mac/calls', { name: 'screenshot', arguments: {} });
  assert.equal((await call('POST', '/v1/mac/cancel', { id: dropped.body.call.id })).body.cancelled, 1);
  assert.equal((await call('GET', '/v1/mac/next?mac=owner-mbp')).body.call, null);
});

test('a sender waiting gets the answer the moment it comes; only the machines reach the mailbox', async () => {
  const { call } = setup();
  const waiting = call('POST', '/v1/mac/calls', { name: 'screenshot', arguments: {}, wait: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = await call('GET', '/v1/mac/next?mac=owner-mbp&wait=1');
  await call('POST', '/v1/mac/result', { id: next.body.call.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  assert.equal((await waiting).body.call.status, 'done');
  assert.equal((await call('GET', '/v1/mac/status', undefined, 'ext.chrome.mac')).status, 401);
  assert.equal((await call('POST', '/v1/mac/calls', { name: 'Not A Tool' })).status, 400);
  assert.equal((await call('POST', '/v1/mac/hello', { tools: [] })).status, 400);
});
