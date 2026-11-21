// Talking to an agent (cloud/tasks/worker.js /v1/runs/message, migration 0015) against every real
// migration, on node:sqlite standing in for D1.
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

const session = { machine: 'evans-mac', run: 'claude:abc', agent: 'claude', title: 'Fix the agent view' };

test('a message to a Claude Code session waits for its Mac, is taken once, and says how it went', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/v1/runs', { ...session, steps: [{ n: 1, at: 10, kind: 'asked', text: 'Fix it' }] })).status, 200);

  const sent = await call('POST', '/v1/runs/message', { machine: 'evans-mac', run: 'claude:abc', text: 'Also check the phone layout', from: 'mac' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message.status, 'queued');

  // Another Mac gets nothing; this one gets it once.
  assert.deepEqual((await call('POST', '/v1/runs/messages/take', { machine: 'other-mac' })).body.messages, []);
  const taken = (await call('POST', '/v1/runs/messages/take', { machine: 'evans-mac' })).body.messages;
  assert.equal(taken.length, 1);
  assert.equal(taken[0].run, 'claude:abc');
  assert.equal(taken[0].agent, 'claude');
  assert.equal(taken[0].text, 'Also check the phone layout');
  assert.deepEqual((await call('POST', '/v1/runs/messages/take', { machine: 'evans-mac' })).body.messages, []);

  assert.equal((await call('POST', '/v1/runs/messages/update', { id: taken[0].id, status: 'delivered', detail: 'Given at its next step' })).status, 200);
  const conversation = (await call('GET', '/v1/runs?machine=evans-mac&run=claude:abc&tail=300')).body;
  assert.equal(conversation.steps.length, 1);
  assert.deepEqual(conversation.messages.map((m) => [m.text, m.status, m.detail]), [
    ['Also check the phone layout', 'delivered', 'Given at its next step'],
  ]);

  const board = (await call('GET', '/v1/board')).body;
  assert.equal(board.runs[0].step_count, 1);
  assert.equal(board.run_messages[0].status, 'delivered');
});

test('a message to an agent that does not exist is refused', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/v1/runs/message', { machine: 'evans-mac', run: 'claude:nope', text: 'hi' })).status, 404);
  assert.equal((await call('POST', '/v1/runs/message', { machine: 'evans-mac', run: 'claude:abc', text: ' ' })).status, 400);
});

test('a conversation opens on its newest steps and pages back', async () => {
  const { call } = setup();
  const steps = Array.from({ length: 450 }, (_, i) => ({ n: i + 1, at: i, kind: 'action', text: `step ${i + 1}` }));
  for (let i = 0; i < steps.length; i += 100) await call('POST', '/v1/runs', { ...session, steps: steps.slice(i, i + 100) });
  const tail = (await call('GET', '/v1/runs?machine=evans-mac&run=claude:abc&tail=300')).body.steps;
  assert.equal(tail.length, 300);
  assert.equal(tail[0].n, 151);
  assert.equal(tail.at(-1).n, 450);
  const older = (await call('GET', '/v1/runs?machine=evans-mac&run=claude:abc&before=151')).body.steps;
  assert.deepEqual([older.length, older[0].n, older.at(-1).n], [150, 1, 150]);
  // The board carries only each run's newest 40.
  const board = (await call('GET', '/v1/board')).body;
  assert.equal(board.run_steps.length, 40);
  assert.equal(board.run_steps[0].n, 411);
});

test('a reply to Hive in the cloud becomes a follow-up request that knows what it follows', async () => {
  const { call } = setup();
  const first = (await call('POST', '/v1/requests', { text: 'Summarize my inbox', from: 'web' })).body.id;
  await call('POST', '/v1/requests/take', { by: 'vm' });
  await call('POST', '/v1/requests/update', { id: first, status: 'done', outcome: 'Three new emails, none urgent.' });

  const reply = await call('POST', '/v1/runs/message', { request: first, text: 'Draft a reply to the second one', from: 'mac' });
  assert.equal(reply.status, 200);
  const taken = (await call('POST', '/v1/requests/take', { by: 'vm' })).body.request;
  assert.equal(taken.id, reply.body.request);
  assert.equal(taken.follows, first);
  assert.match(taken.text, /follows the owner's earlier request R1 \("Summarize my inbox"\), which ended: Three new emails/);
  assert.match(taken.text, /The owner now says: Draft a reply to the second one$/);
  const board = (await call('GET', '/v1/board')).body;
  assert.equal(board.requests.find((r) => r.id === reply.body.request).follows, first);

  // Hive on the Mac handing over more of the same work: its words aren't introduced as the owner's.
  await call('POST', '/v1/requests/update', { id: taken.id, status: 'done', outcome: 'Drafted' });
  const more = await call('POST', '/v1/runs/message', { request: taken.id, text: 'For hive › mail: [Hive on the Mac, not the owner] Send the draft', from: 'mac' });
  const next = (await call('POST', '/v1/requests/take', { by: 'vm' })).body.request;
  assert.equal(next.id, more.body.request);
  assert.match(next.text, /which ended: Drafted\.\nNow: For hive › mail: \[Hive on the Mac, not the owner\] Send the draft$/);
  // Two back and more: the whole conversation, oldest first, so "the same, but fix the caps" has its subject.
  assert.match(next.text, /^Earlier in this conversation, oldest first:\n- R1 \("Summarize my inbox"\), which ended: Three new emails, none urgent\.\nThis follows the owner's earlier request R2 \("Draft a reply to the second one"\)/);
});

test('a follow-up hears at most the six requests before it', async () => {
  const { call } = setup();
  let last = (await call('POST', '/v1/requests', { text: 'step 1', from: 'web' })).body.id;
  for (let n = 2; n <= 9; n++) {
    await call('POST', '/v1/requests/take', { by: 'vm' });
    await call('POST', '/v1/requests/update', { id: last, status: 'done', outcome: `did ${n - 1}` });
    last = (await call('POST', '/v1/runs/message', { request: last, text: `step ${n}`, from: 'web' })).body.request;
  }
  const taken = (await call('POST', '/v1/requests/take', { by: 'vm' })).body.request;
  assert.match(taken.text, /The owner now says: step 9$/);
  assert.match(taken.text, /- R3 \("step 3"\), which ended: did 3\n/);
  assert.doesNotMatch(taken.text, /step 2"/);
  assert.equal(taken.text.match(/^- R/gm).length, 5);
});

const NOW = Math.floor(Date.now() / 1000);

async function withTask(call, { harness = 'claude', session = 'abc', status = 'waiting', outcome = 'Pick which cleanup to run' } = {}) {
  await call('POST', '/v1/sync', {
    machine: 'evans-mac',
    messages: [{ id: 1, harness, session, project: 'hive', text: 'clean my disk', said_at: 5, times: 1 }],
    tasks: [{ id: 7, message: 1, quote: 'clean my disk', title: 'Clean the disk', status, outcome, created_at: 5, updated_at: 5 }],
  });
}

test('answering a task that waits on the owner reaches the session that has it, with the question', async () => {
  const { call } = setup();
  await withTask(call);
  const answered = await call('POST', '/v1/tasks/act', { machine: 'evans-mac', id: 7, action: 'answer', text: 'Rust build folders only', from: 'mac' });
  assert.equal(answered.status, 200);
  const [taken] = (await call('POST', '/v1/runs/messages/take', { machine: 'evans-mac' })).body.messages;
  assert.equal(taken.run, 'claude:abc');
  assert.equal(taken.wake, 1);
  assert.match(taken.text, /answered you on T7 \("Clean the disk"\), which was waiting on them for: Pick which cleanup to run/);
  assert.match(taken.text, /in their own words: Rust build folders only$/);
  assert.equal((await call('POST', '/v1/tasks/act', { machine: 'evans-mac', id: 7, action: 'answer', text: ' ' })).status, 400);
  assert.equal((await call('POST', '/v1/tasks/act', { machine: 'evans-mac', id: 8, action: 'continue' })).status, 404);
  const board = (await call('GET', '/v1/board')).body;
  assert.equal(board.run_messages[0].task, 7);
});

test('a cancelled task stays dropped whatever its agent sends later, and its machine hears of it', async () => {
  const { call } = setup();
  await withTask(call, { status: 'active', outcome: null });
  const cancelled = await call('POST', '/v1/tasks/act', { machine: 'evans-mac', id: 7, action: 'cancel' });
  assert.equal(cancelled.body.task.status, 'dropped');
  const [stop] = (await call('POST', '/v1/runs/messages/take', { machine: 'evans-mac' })).body.messages;
  assert.equal(stop.wake, 0, 'a cancel never starts a session just to say stop');

  const answer = (await call('POST', '/v1/sync', {
    machine: 'evans-mac', since: 0,
    tasks: [{ id: 7, message: 1, quote: 'clean my disk', title: 'Clean the disk', status: 'active', created_at: 5, updated_at: NOW }],
  })).body;
  assert.deepEqual(answer.cancelled, [7]);
  let task = (await call('GET', '/v1/board')).body.tasks.find((t) => t.id === 7);
  assert.equal(task.status, 'dropped');
  assert.equal(task.outcome, 'Cancelled by the owner from the dashboard.');

  await call('POST', '/v1/sync', {
    machine: 'evans-mac', since: answer.now + 1,
    tasks: [{ id: 7, message: 1, quote: 'clean my disk', title: 'Clean the disk', status: 'done', outcome: 'Finished anyway', created_at: 5, updated_at: NOW }],
  });
  task = (await call('GET', '/v1/board')).body.tasks.find((t) => t.id === 7);
  assert.equal(task.status, 'done', 'done still goes through');
});

test('a task another session took over is that session\'s on the board, and continue goes there', async () => {
  const { call } = setup();
  await call('POST', '/v1/sync', {
    machine: 'evans-mac',
    messages: [{ id: 1, harness: 'claude', session: 'giver', project: 'hive', text: 'eye typing', said_at: 5, times: 1 }],
    tasks: [{ id: 7, message: 1, quote: 'eye typing', title: 'Eye typing', status: 'active', created_at: 5, updated_at: 5, claimed_harness: 'claude', claimed_session: 'taker' }],
  });
  const task = (await call('GET', '/v1/board')).body.tasks.find((t) => t.id === 7);
  assert.deepEqual([task.harness, task.session], ['claude', 'taker']);
  await call('POST', '/v1/tasks/act', { machine: 'evans-mac', id: 7, action: 'continue' });
  const [taken] = (await call('POST', '/v1/runs/messages/take', { machine: 'evans-mac' })).body.messages;
  assert.equal(taken.run, 'claude:taker');
  assert.equal(taken.text, 'The owner asks you to continue T7 ("Eye typing").');
});

test('continuing a task of Hive\'s cloud agent asks it again as a follow-up', async () => {
  const { call } = setup();
  const first = (await call('POST', '/v1/requests', { text: 'Summarize my inbox', from: 'web' })).body.id;
  await call('POST', '/v1/requests/take', { by: 'vm' });
  await call('POST', '/v1/requests/update', { id: first, status: 'working', tasks: [{ key: 1, title: 'Read the inbox', status: 'blocked', outcome: 'Gmail sign-in expired' }] });
  const went = await call('POST', '/v1/tasks/act', { machine: 'cloud', id: first * 100 + 1, action: 'continue' });
  assert.equal(went.status, 200);
  const taken = (await call('POST', '/v1/requests/take', { by: 'vm' })).body.request;
  assert.equal(taken.follows, first);
  assert.match(taken.text, /continue T101 \("Read the inbox"\)/);
});

test('a session the board knows only from what the owner said in it can still be talked to', async () => {
  const { call } = setup();
  await withTask(call, { session: 'quiet', status: 'active', outcome: null });
  const sent = await call('POST', '/v1/runs/message', { machine: 'evans-mac', run: 'claude:quiet', text: 'How is it going?' });
  assert.equal(sent.status, 200);
  const [taken] = (await call('POST', '/v1/runs/messages/take', { machine: 'evans-mac' })).body.messages;
  assert.deepEqual([taken.run, taken.agent], ['claude:quiet', 'claude']);
  const conversation = (await call('GET', '/v1/runs?machine=evans-mac&run=claude:quiet&tail=300')).body;
  assert.deepEqual([conversation.run.agent, conversation.steps.length, conversation.messages[0].text], ['claude', 0, 'How is it going?']);
  assert.equal((await call('POST', '/v1/runs/message', { machine: 'evans-mac', run: 'claude:stranger', text: 'hi' })).status, 404);
  assert.equal((await call('POST', '/v1/runs/message', { machine: 'evans-mac', run: 'mac:quiet', text: 'hi' })).status, 404);
});

// A job Hive's agent on the VM ran by itself (hive-task.mjs, run "vm-<id>") reads no messages once it
// has ended: what the owner says to it reaches Hive on the VM as a new request about that job.
test('a message to a VM job becomes a new request to Hive on the VM, and reads as delivered', async () => {
  const { call } = setup();
  await call('POST', '/v1/runs', { machine: 'cloud', run: 'vm-2026-11-18T03-53-18-172Z', agent: 'hive', title: 'Post the thread on X', status: 'done', steps: [] });
  const sent = await call('POST', '/v1/runs/message', { machine: 'cloud', run: 'vm-2026-11-18T03-53-18-172Z', text: 'Use this shorter wording: hi', from: 'web' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message.status, 'delivered');
  assert.match(sent.body.message.detail, /new request \(\d+\)/);
  const board = (await call('GET', '/v1/board')).body;
  const request = board.requests.find((r) => r.id === sent.body.request);
  assert.equal(request.status, 'queued');
  assert.equal(request.agent, 'hive-cloud');
  assert.match(request.text, /^Use this shorter wording: hi\n\n\(Said about the VM job “Post the thread on X”\.\)$/);
  assert.equal(board.run_messages[0].status, 'delivered');
  // Nothing waits for a VM that would never take it.
  assert.deepEqual((await call('POST', '/v1/runs/messages/take', { machine: 'cloud' })).body.messages, []);
});

test('a request Hive on the VM was on when it restarted runs again, twice at most, with a note of what happened', async () => {
  const { call } = setup();
  const id = (await call('POST', '/v1/requests', { text: 'Post the video', from: 'web' })).body.id;
  assert.equal((await call('POST', '/v1/requests/take', { by: 'vm', fresh: true })).body.request.id, id);
  await call('POST', '/v1/requests/update', { id, status: 'working' });
  const other = (await call('POST', '/v1/requests', { text: 'Something later', from: 'web' })).body.id;

  for (let restart = 1; restart <= 2; restart++) {
    const again = (await call('POST', '/v1/requests/take', { by: 'vm', fresh: true })).body.request;
    assert.equal(again.id, id, `restart ${restart}: the same request, ahead of later ones`);
    assert.equal(again.retry, true);
    assert.match(again.text, /^Hive on the VM restarted while it was working on this request[\s\S]*The request, as it was:\nPost the video$/);
    await call('POST', '/v1/requests/update', { id, status: 'working' });
  }
  const third = (await call('POST', '/v1/requests/take', { by: 'vm', fresh: true })).body.request;
  assert.equal(third.id, other, 'the third restart ends it');
  const ended = (await call('GET', '/v1/board')).body.requests.find((r) => r.id === id);
  assert.equal(ended.status, 'failed');
  assert.match(ended.outcome, /restarted while it worked on this, 2 times/);
  // A take that isn't a fresh start leaves what's in progress alone.
  await call('POST', '/v1/requests/update', { id: other, status: 'working' });
  assert.equal((await call('POST', '/v1/requests/take', { by: 'vm' })).body.request, null);
  assert.equal((await call('GET', '/v1/board')).body.requests.find((r) => r.id === other).status, 'working');
});

test("a request the orchestrator finds is about an earlier one joins that one's conversation, once", async () => {
  const { call, env } = setup();
  const first = (await call('POST', '/v1/requests', { text: 'post the recording to X', from: 'mac' })).body.id;
  const second = (await call('POST', '/v1/requests', { text: 'have you posted it yet', from: 'mac' })).body.id;
  const follows = (id) => env.DB.db.prepare('SELECT follows FROM board_requests WHERE id = ?').get(id).follows;
  assert.equal((await call('POST', '/v1/requests/update', { id: second, follows: first })).status, 200);
  assert.equal(follows(second), first);
  // Never a later request, one that doesn't exist, or a change to what it already follows.
  const third = (await call('POST', '/v1/requests', { text: 'open Canvas', from: 'web' })).body.id;
  await call('POST', '/v1/requests/update', { id: second, follows: third });
  await call('POST', '/v1/requests/update', { id: third, follows: 999 });
  assert.equal(follows(second), first);
  assert.equal(follows(third), null);
});
