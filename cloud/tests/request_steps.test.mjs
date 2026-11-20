// A request followed as it goes (cloud/tasks/worker.js /v1/requests/state?steps=1), the way Hive on the
// Mac shows the cloud agent's work on the owner's words, against every real migration on node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../tasks/worker.js';

const MIGRATIONS = new URL('../knowledge/migrations/', import.meta.url);

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
  }
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    batchOne: () => (/\bRETURNING\b|^\s*(SELECT|WITH)/i.test(sql)
      ? { results: db.prepare(sql).all(...args) }
      : { results: [], meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => list.map((s) => s.batchOne()), db };
}

function setup() {
  const env = { DB: fakeD1(), TASKS_TOKEN: 'machine-token' };
  const call = async (method, path, body) => {
    const response = await worker.fetch(new Request(`https://board.test${path}`, {
      method,
      headers: { authorization: 'Bearer machine-token', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, body: await response.json() };
  };
  return { env, call };
}

test("a request's tasks and their runs' steps come back in order, each once, for the node that sent it", async () => {
  const { call } = setup();
  const sent = await call('POST', '/v1/requests', { text: 'open Calculator and add 2 and 2', from: 'mac' });
  const id = sent.body.id;
  const taken = await call('POST', '/v1/requests/take', { by: 'vm', agent: 'hive-cloud' });
  assert.equal(taken.body.request.from, 'mac');
  await call('POST', '/v1/requests/update', { id, status: 'working', tasks: [
    { key: 1, title: 'Open Calculator', status: 'active' }, { key: 2, title: 'Add 2 and 2', status: 'open' },
  ] });
  await call('POST', '/v1/runs', { machine: 'cloud', run: String(id * 100 + 1), agent: 'cloud', title: 'Open Calculator', request: id, task: 1,
    steps: [{ n: 1, at: 100, kind: 'action', text: '→ open_app: Open Calculator' }, { n: 2, at: 101, kind: 'say', text: '💬 Calculator is open.' }] });
  await call('POST', '/v1/runs', { machine: 'cloud', run: '999', agent: 'cloud', title: 'Another request', steps: [{ n: 1, at: 100, text: 'not this one' }] });
  const state = await call('GET', `/v1/requests/state?id=${id}&steps=1`);
  assert.equal(state.body.request.status, 'working');
  assert.deepEqual(state.body.tasks.map((t) => [t.key, t.title, t.status]), [[1, 'Open Calculator', 'active'], [2, 'Add 2 and 2', 'open']]);
  assert.deepEqual(state.body.steps.map((s) => [s.run, s.n, s.text]), [
    [String(id * 100 + 1), 1, '→ open_app: Open Calculator'], [String(id * 100 + 1), 2, '💬 Calculator is open.'],
  ]);
  const plain = await call('GET', `/v1/requests/state?id=${id}`);
  assert.equal(plain.body.steps, undefined);
});

test('the owner stops a request: one not taken ends at once; one being worked on says so to the orchestrator', async () => {
  const { call } = setup();
  const waiting = (await call('POST', '/v1/requests', { text: 'open Notes', from: 'mac' })).body.id;
  assert.deepEqual((await call('POST', '/v1/requests/stop', { id: waiting })).body, { ok: true, stopping: 1, ended: 1 });
  const ended = (await call('GET', `/v1/requests/state?id=${waiting}`)).body.request;
  assert.equal(ended.status, 'failed');
  assert.equal(ended.outcome, 'Stopped by the owner before it started.');
  assert.equal((await call('POST', '/v1/requests/take', { by: 'vm', agent: 'hive-cloud' })).body.request, null, 'nobody takes it');

  const working = (await call('POST', '/v1/requests', { text: 'open Calculator', from: 'mac' })).body.id;
  await call('POST', '/v1/requests/take', { by: 'vm', agent: 'hive-cloud' });
  await call('POST', '/v1/requests/update', { id: working, status: 'working' });
  assert.equal((await call('GET', `/v1/requests/state?id=${working}`)).body.request.stop_at, null);
  assert.deepEqual((await call('POST', '/v1/requests/stop', { id: working })).body, { ok: true, stopping: 1, ended: 0 });
  const asked = (await call('GET', `/v1/requests/state?id=${working}`)).body.request;
  assert.equal(asked.status, 'working');
  assert.ok(asked.stop_at > 0);
  await call('POST', '/v1/requests/update', { id: working, status: 'failed', outcome: 'Stopped by the owner.' });
  assert.deepEqual((await call('POST', '/v1/requests/stop', { id: working })).body, { ok: true, stopping: 0, ended: 0 }, 'a finished one stays as it ended');
});
