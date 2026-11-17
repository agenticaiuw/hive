// A stuck task gets going again without the owner (cloud/tasks/worker.js continueStuck, migration
// 0018), against every real migration, on node:sqlite standing in for D1.
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
  // One cron tick, run to the end.
  const tick = async () => {
    let done;
    await worker.scheduled({}, env, { waitUntil: (p) => { done = p; } });
    await done;
  };
  const take = async (machine = 'evans-mac') => (await call('POST', '/v1/runs/messages/take', { machine })).body.messages;
  const row = (id, machine = 'evans-mac') =>
    env.DB.db.prepare('SELECT status, auto_continues, auto_continued_at FROM board_tasks WHERE machine = ? AND id = ?').get(machine, id);
  const boardTask = async (id, machine = 'evans-mac') =>
    (await call('GET', '/v1/board')).body.tasks.find((t) => t.machine === machine && t.id === id);
  return { env, call, tick, take, row, boardTask };
}

const NOW = () => Math.floor(Date.now() / 1000);
const message = (id, session, project = 'github.com/owner/app') =>
  ({ id, harness: 'claude', session, project, text: 'Fix the login page', said_at: NOW() - 3600, times: 1, split_at: NOW() - 3500 });
const task = (id, msg, status, updated, extra = {}) => ({
  id, message: msg, quote: 'Fix the login page', title: `Task ${id}`, status, outcome: status === 'blocked' ? 'The tests need a database' : null,
  created_at: NOW() - 3500, updated_at: updated, ...extra,
});
const sync = (call, messages, tasks, machine = 'evans-mac') => call('POST', '/v1/sync', { machine, messages, tasks });

test("a stuck task's session is continued by Hive, in Hive's words, twice at most", async () => {
  const { call, tick, take, row, boardTask } = setup();
  await sync(call, [message(1, 's1')], [task(1, 1, 'blocked', NOW() - 60)]);

  // Stuck, but not the owner's yet: Hive is on it.
  assert.equal((await boardTask(1)).retrying, 1);

  await tick();
  const [first] = await take();
  assert.equal(first.run, 'claude:s1');
  assert.equal(first.wake, 1);
  assert.equal(first.sender, 'hive');
  assert.match(first.text, /^\[Hive, not the owner\] This task is stuck/);
  assert.match(first.text, /T1 \("Task 1"\), stuck on: The tests need a database/);
  assert.match(first.text, /try 1 of 2/);
  assert.equal(row(1).auto_continues, 1);

  // Nothing new from its agent: no second message on the next tick.
  await tick();
  assert.deepEqual(await take(), []);

  // Its agent took it up and got stuck again: the second try.
  await sync(call, [], [task(1, 1, 'blocked', NOW() + 5)]);
  await tick();
  const [second] = await take();
  assert.match(second.text, /try 2 of 2/);
  assert.equal(row(1).auto_continues, 2);

  // Stuck a third time: Hive stops, and once its last try is old it's the owner's.
  await sync(call, [], [task(1, 1, 'blocked', NOW() + 10)]);
  await tick();
  assert.deepEqual(await take(), []);
  assert.equal((await boardTask(1)).retrying, 1); // the last try is still fresh
});

test('after its tries are spent, or with no agent to ask, a stuck task is the owner\'s', async () => {
  const { env, call, tick, take, boardTask } = setup();
  await sync(call, [message(1, 's1'), { ...message(2, ''), harness: '', session: '' }], [
    task(1, 1, 'blocked', NOW() - 60),
    task(2, 2, 'blocked', NOW() - 60),
  ]);
  env.DB.db.prepare('UPDATE board_tasks SET auto_continues = 2, auto_continued_at = ? WHERE id = 1').run(NOW() - 3600);
  await tick();
  assert.deepEqual(await take(), []);
  assert.equal((await boardTask(1)).retrying, 0);
  assert.equal((await boardTask(2)).retrying, 0);
});

test("a session that hasn't answered in half an hour gets its next try", async () => {
  const { env, call, tick, take, row } = setup();
  await sync(call, [message(1, 's1')], [task(1, 1, 'blocked', NOW() - 7200)]);
  await tick();
  assert.equal((await take()).length, 1);
  env.DB.db.prepare('UPDATE board_tasks SET auto_continued_at = ? WHERE id = 1').run(NOW() - 31 * 60);
  await tick();
  assert.equal((await take()).length, 1);
  assert.equal(row(1).auto_continues, 2);
});

test("a session's stuck tasks go in one message, and one session per project at a time", async () => {
  const { call, tick, take } = setup();
  await sync(call, [message(1, 's1'), message(2, 's2'), message(3, 's3', 'github.com/owner/other')], [
    task(1, 1, 'blocked', NOW() - 300),
    task(2, 1, 'blocked', NOW() - 200),
    task(3, 2, 'blocked', NOW() - 100),
    task(4, 3, 'blocked', NOW() - 100),
  ]);
  await tick();
  const sent = await take();
  assert.deepEqual(sent.map((m) => m.run).sort(), ['claude:s1', 'claude:s3']);
  const s1 = sent.find((m) => m.run === 'claude:s1');
  assert.match(s1.text, /These tasks are stuck/);
  assert.match(s1.text, /T1 .*\n- T2 /);

  // s2 waits while s1, in the same project, is still at it.
  await tick();
  assert.deepEqual(await take(), []);
  // s1 finished its tasks: s2's turn.
  await sync(call, [], [task(1, 1, 'done', NOW() + 5), task(2, 1, 'done', NOW() + 5)]);
  await tick();
  assert.deepEqual((await take()).map((m) => m.run), ['claude:s2']);
});

test("the owner's own continue holds Hive's back, and a cancelled task is never continued", async () => {
  const { call, tick, take } = setup();
  await sync(call, [message(1, 's1')], [task(1, 1, 'blocked', NOW() - 60), task(2, 1, 'blocked', NOW() - 60)]);
  assert.equal((await call('POST', '/v1/tasks/act', { machine: 'evans-mac', id: 1, action: 'continue' })).status, 200);
  assert.equal((await call('POST', '/v1/tasks/act', { machine: 'evans-mac', id: 2, action: 'cancel' })).status, 200);
  await take(); // the owner's continue and cancel
  await tick();
  assert.deepEqual(await take(), []);
});

test('Hive in the cloud is continued by running the request again, with its note first', async () => {
  const { env, call, tick } = setup();
  const sent = await call('POST', '/v1/requests', { text: 'Make the Canvas page tidy' });
  assert.equal(sent.status, 200);
  const id = sent.body.request ?? sent.body.id;
  const took = await call('POST', '/v1/requests/take', { by: 'vm' });
  assert.equal(took.body.request.id, id);
  await call('POST', '/v1/requests/update', {
    id, status: 'done', tasks: [{ key: 1, title: 'Tidy Canvas', quote: 'Make the Canvas page tidy', status: 'blocked', outcome: 'The page did not load' }],
  });
  await tick();
  const again = env.DB.db.prepare('SELECT status, retry_note FROM board_requests WHERE id = ?').get(id);
  assert.equal(again.status, 'queued');
  assert.match(again.retry_note, /^\[Hive, not the owner\] This task is stuck/);
  const retaken = await call('POST', '/v1/requests/take', { by: 'vm' });
  assert.match(retaken.body.request.text, /^\[Hive, not the owner\][\s\S]*The request, as it was:\nMake the Canvas page tidy$/);
  assert.equal(env.DB.db.prepare('SELECT auto_continues FROM board_tasks WHERE machine = ? AND id = ?').get('cloud', id * 100 + 1).auto_continues, 1);
});
