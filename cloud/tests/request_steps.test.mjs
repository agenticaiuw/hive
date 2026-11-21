// A request followed as it goes (cloud/tasks/worker.js /v1/requests/state?steps=1), the way Hive on the
// Mac shows the cloud agent's work on the owner's words, against every real migration on node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../tasks/worker.js';
import { callTool } from '../vm-agent/knowledge-mcp.mjs';
import { boardClient, runSender } from '../vm-agent/orchestrator.mjs';

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
  const call = async (method, path, body, token = 'machine-token') => {
    const response = await worker.fetch(new Request(`https://board.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
  // Stopped while it was being planned, so it had no tasks: its one task is dropped, not stuck, and
  // Hive's continue for stuck tasks leaves it alone (requests 76 and 77, 2026-11-20).
  const lone = (await call('GET', '/v1/board')).body.tasks.find((t) => t.machine === 'cloud' && t.id === working * 100 + 1);
  assert.deepEqual([lone?.status, lone?.outcome], ['dropped', 'Stopped by the owner.']);
});

test("a request that failed on its own is still stuck, so Hive continues it; a stopped one isn't", async () => {
  const { call } = setup();
  const failed = (await call('POST', '/v1/requests', { text: 'open Notes', from: 'mac' })).body.id;
  await call('POST', '/v1/requests/take', { by: 'vm', agent: 'hive-cloud' });
  await call('POST', '/v1/requests/update', { id: failed, status: 'failed', outcome: "Couldn't plan it: no answer" });
  const lone = (await call('GET', '/v1/board')).body.tasks.find((t) => t.machine === 'cloud' && t.id === failed * 100 + 1);
  assert.equal(lone?.status, 'blocked');
});


test('request context retrieves original material and follows links without changing the request', async () => {
  const { call, env } = setup();
  const words = 'Transcribe these words:\nTHE FIRST line.\nThe second LINE.\nSource: /tmp/sample.txt';
  const page = { url: 'https://example.test/source', title: 'Source', outline: 'Exact PAGE material.\n' + 'More text. '.repeat(800).trimEnd() };
  const id = (await call('POST', '/v1/requests', { text: words, from: 'mac', page })).body.id;
  await call('POST', '/v1/requests/update', { id, status: 'done', outcome: 'A saved result', tasks: [
    { key: 1, title: 'Transcribe', quote: words, status: 'done', outcome: 'Exact transcription' },
  ] });
  const follow = (await call('POST', '/v1/runs/message', { request: id, text: 'Keep the words.', from: 'mac' })).body.request;
  const latest = await call('GET', `/v1/requests/context?id=R${follow}`);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.request.text, 'Keep the words.');
  assert.equal(latest.body.request.follows, id);
  assert.equal(latest.body.page, null);
  assert.deepEqual(latest.body.steps, []);
  assert.equal(latest.body.next_offset, null);
  const before = env.DB.db.prepare('SELECT * FROM board_requests ORDER BY id').all();
  const got = await call('GET', `/v1/requests/context?id=${latest.body.request.follows}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.request.text, words);
  assert.equal(got.body.request.from, 'mac');
  assert.equal(got.body.request.outcome, 'A saved result');
  assert.deepEqual(got.body.page, page);
  assert.equal(got.body.tasks[0].outcome, 'Exact transcription');
  assert.deepEqual(env.DB.db.prepare('SELECT * FROM board_requests ORDER BY id').all(), before);
});

test('request history pages include every saved step and message from every node, only for this request', async () => {
  const { call } = setup();
  const id = (await call('POST', '/v1/requests', { text: 'Read the source' })).body.id;
  const other = (await call('POST', '/v1/requests', { text: 'Unrelated work' })).body.id;
  for (const [machine, request, count] of [['cloud', id, 65], ['mac-test', id, 2], ['unrelated', other, 1]]) {
    await call('POST', '/v1/runs', { machine, run: 'source', agent: 'mac', request,
      steps: Array.from({ length: count }, (_, i) => ({ n: i + 1, at: 100 + i, kind: 'say', text: `${machine} source ${i + 1}` })) });
  }
  for (let i = 0; i < 52; i++) {
    await call('POST', '/v1/runs/message', { machine: 'mac-test', run: 'source', text: `Saved message ${i}` });
  }
  await call('POST', '/v1/runs/message', { machine: 'unrelated', run: 'source', text: 'Unrelated message' });
  const first = (await call('GET', `/v1/requests/context?id=${id}`)).body;
  assert.deepEqual(first.runs.map(r => r.machine), ['cloud', 'mac-test']);
  assert.equal(first.steps.length, 50);
  assert.equal(first.messages.length, 50);
  assert.equal(first.next_offset, 50);
  const second = (await call('GET', `/v1/requests/context?id=${id}&offset=${first.next_offset}`)).body;
  assert.equal(second.next_offset, null);
  assert.deepEqual([...first.steps, ...second.steps].map(s => s.text), [
    ...Array.from({ length: 65 }, (_, i) => `cloud source ${i + 1}`), 'mac-test source 1', 'mac-test source 2',
  ]);
  assert.deepEqual([...first.messages, ...second.messages].map(m => m.text),
    Array.from({ length: 52 }, (_, i) => `Saved message ${i}`));
});

test('request context requires machine authentication and valid IDs and offsets', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/v1/requests/context?id=1', undefined, '')).status, 401);
  assert.equal((await call('GET', '/v1/requests/context?id=1', undefined, 'wrong')).status, 401);
  for (const id of ['', '0', '-1', 'R0', '1.5', '9007199254740992', 'wat']) {
    assert.equal((await call('GET', `/v1/requests/context?id=${id}`)).status, 400, id);
  }
  for (const offset of ['-1', '0.5', 'wat']) {
    assert.equal((await call('GET', `/v1/requests/context?id=1&offset=${offset}`)).status, 400, offset);
  }
  const missing = await call('GET', '/v1/requests/context?id=R999');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'No such request.');
});

test('a continuation keeps both attempts in task history, including exact comment text and completed work', async t => {
  const { call, env } = setup();
  const words = 'Copy the recording and use the saved thread comment.';
  const comment = 'Example comment.\n  Keep this line EXACTLY.';
  const id = (await call('POST', '/v1/requests', { text: words })).body.id;
  await call('POST', '/v1/requests/update', { id, status: 'done', tasks: [
    { key: 1, title: 'Copy recording', quote: words, status: 'blocked', outcome: 'Earlier work completed; copy still needed.' },
  ] });
  t.mock.method(globalThis, 'fetch', (input, options) => worker.fetch(new Request(input, options), env));
  const board = boardClient({ url: 'https://board.test', token: 'machine-token' });
  const first = runSender(board, { request: id, task: 1 });
  first.step(comment);
  for (let i = 0; i < 54; i++) first.step(`Completed step ${i + 1}`);
  await first.done('failed');
  const continued = runSender(board, { request: id, task: 1 });
  continued.step('Recovered the recording');
  continued.step('Checked completed work before continuing');
  await continued.done('done');
  const before = env.DB.db.prepare('SELECT * FROM board_run_steps ORDER BY n').all();
  const retrieve = async offset => {
    const text = await callTool(board, 'get_request', { id: `T${id * 100 + 1}`, offset });
    return JSON.parse(text.slice(text.indexOf('\n') + 1));
  };
  const page = await retrieve(0);
  assert.equal(page.request.id, id);
  assert.equal(page.request.text, words);
  assert.equal(page.tasks[0].outcome, 'Earlier work completed; copy still needed.');
  assert.equal(page.runs[0].status, 'done');
  assert.equal(page.steps[0].text, comment);
  assert.equal(page.next_offset, 50);
  const last = await retrieve(page.next_offset);
  assert.equal(last.next_offset, null);
  assert.deepEqual([...page.steps, ...last.steps].map(s => s.n), Array.from({ length: 57 }, (_, i) => i + 1));
  assert.deepEqual(last.steps.slice(-2).map(s => s.text), ['Recovered the recording', 'Checked completed work before continuing']);
  assert.deepEqual(env.DB.db.prepare('SELECT * FROM board_run_steps ORDER BY n').all(), before, 'reading history changes nothing');
});

test('the history tool reads through the board client before and after the history route is deployed', async t => {
  const { call, env } = setup();
  const words = 'First LINE.\n  Second line, exactly.';
  const page = { url: 'https://example.test/source', title: 'Source', outline: 'Saved PAGE text.' };
  const id = (await call('POST', '/v1/requests', { text: words, from: 'mac', page })).body.id;
  await call('POST', '/v1/requests/update', { id, status: 'done', outcome: 'Saved result', tasks: [
    { key: 1, title: 'Read', quote: words, status: 'done', outcome: 'Task result' },
  ] });
  for (let start = 1; start <= 501; start += 100) {
    await call('POST', '/v1/runs', { machine: 'cloud', run: 'source', agent: 'cloud', request: id,
      steps: Array.from({ length: Math.min(100, 502 - start) }, (_, i) => ({ n: start + i, text: `Saved line ${start + i}` })) });
  }
  let deployed = false;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://board.test');
    if (!deployed && url.pathname === '/v1/requests/context') url.pathname = '/missing-route';
    return worker.fetch(new Request(url, options), env);
  });
  const board = boardClient({ url: 'https://board.test', token: 'machine-token' });
  const retrieve = async offset => {
    const text = await callTool(board, 'get_request', { id: `T${id * 100 + 1}`, offset });
    return JSON.parse(text.slice(text.indexOf('\n') + 1));
  };
  const older = await retrieve(0);
  assert.equal(older.request.text, words);
  assert.equal(older.tasks[0].outcome, 'Task result');
  assert.equal(older.steps[0].text, 'Saved line 1', 'the oldest material, not the dashboard tail');
  assert.ok(older.limitations.length > 0);
  const last = await retrieve(500);
  assert.deepEqual(last.steps.map(s => s.text), ['Saved line 501']);
  assert.equal(last.next_offset, null);
  deployed = true;
  const current = await retrieve(0);
  assert.equal(current.request.text, words);
  assert.deepEqual(current.page, page);
  assert.equal(current.limitations, undefined);
  assert.equal(current.next_offset, 50);
});
