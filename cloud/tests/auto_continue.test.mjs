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

test("a stuck task's session is continued by Hive, in Hive's words, again and again, waiting longer each time", async () => {
  const { env, call, tick, take, row, boardTask } = setup();
  await sync(call, [message(1, 's1')], [task(1, 1, 'blocked', NOW() - 60)]);
  const lastTry = (ago, n) => env.DB.db.prepare('UPDATE board_tasks SET auto_continued_at = ?, auto_continues = COALESCE(?, auto_continues) WHERE id = 1').run(NOW() - ago, n ?? null);

  // Stuck, but never the owner's: Hive is on it.
  assert.equal((await boardTask(1)).retrying, 1);

  await tick();
  const [first] = await take();
  assert.equal(first.run, 'claude:s1');
  assert.equal(first.wake, 1);
  assert.equal(first.sender, 'hive');
  assert.match(first.text, /^\[Hive, not the owner\] This task is stuck/);
  assert.match(first.text, /T1 \("Task 1"\), stuck on: The tests need a database/);
  assert.match(first.text, /\(try 1\)/);
  assert.match(first.text, /register no tasks for it/);
  assert.match(first.text, /"why" \(exactly why it stopped\) and "need" \(exactly what the owner must do\)/);
  assert.equal(row(1).auto_continues, 1);

  // Nothing on the next tick, nor when its agent says it's stuck again at once: 20 minutes first.
  await tick();
  assert.deepEqual(await take(), []);
  await sync(call, [], [task(1, 1, 'blocked', NOW() + 5)]);
  await tick();
  assert.deepEqual(await take(), []);
  lastTry(21 * 60);
  await tick();
  const [second] = await take();
  assert.match(second.text, /\(try 2\)/);
  assert.equal(row(1).auto_continues, 2);

  // Then 40 minutes, and so on, never more than about 10.7 hours, and never a last try.
  lastTry(39 * 60);
  await tick();
  assert.deepEqual(await take(), []);
  lastTry(41 * 60);
  await tick();
  assert.equal((await take()).length, 1);
  lastTry(10 * 3600, 9);
  await tick();
  assert.deepEqual(await take(), []);
  lastTry(11 * 3600);
  await tick();
  assert.match((await take())[0].text, /\(try 10\)/);
  assert.equal((await boardTask(1)).retrying, 1);
});

test("a stuck task with no agent to ask isn't continued, and nor is one that came from Hive's own words", async () => {
  const { call, tick, take, boardTask } = setup();
  await sync(call, [
    { ...message(2, ''), harness: '', session: '' },
    { ...message(3, 's3'), text: '[Hive, not the owner] This task is stuck, and Hive continues it' },
  ], [task(2, 2, 'blocked', NOW() - 60), task(3, 3, 'blocked', NOW() - 60)]);
  await tick();
  assert.deepEqual(await take(), []);
  assert.equal((await boardTask(2)).retrying, 0);
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
