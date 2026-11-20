// How Hive's agents work together (cloud/tasks/team.js) against every migration, on node:sqlite standing
// in for D1: messages between agents, and leases on files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { globRegex, nameOf, overlaps, pathOf, teamRoute } from '../tasks/team.js';

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
  const clock = { t: 1_000_000_000_000 };
  const call = async (method, path, body, who = 'machine') => {
    const url = new URL(`https://board.test${path}`);
    const request = new Request(url, {
      method,
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await teamRoute(request, env, url, auth, { clock: () => clock.t });
    return { status: response.status, body: await response.json() };
  };
  return { env, clock, call };
}

test('names and paths are checked; globs match within names, ** across folders, a trailing / everything under', () => {
  assert.equal(nameOf('R12-1'), 'R12-1');
  assert.equal(nameOf('alice@club'), 'alice@club');
  assert.equal(nameOf('two words'), '');
  assert.equal(pathOf('./cloud/tasks/team.js'), 'cloud/tasks/team.js');
  assert.equal(pathOf('/etc/passwd'), '');
  assert.equal(pathOf('cloud/../../x'), '');
  assert.ok(globRegex('cloud/tasks/*.js').test('cloud/tasks/team.js'));
  assert.ok(!globRegex('cloud/tasks/*.js').test('cloud/tasks/sub/team.js'));
  assert.ok(globRegex('cloud/**/*.js').test('cloud/tasks/sub/team.js'));
  assert.ok(globRegex('cloud/**').test('cloud/x'));
  assert.ok(globRegex('dashboard/').test('dashboard/src/a.svelte'));
  assert.ok(globRegex('a.b?').test('a.bc') && !globRegex('a.b?').test('axbc'), 'a dot is a dot');
});

test('two leases overlap when they can touch the same file', () => {
  assert.ok(overlaps('cloud/tasks/team.js', 'cloud/tasks/team.js'));
  assert.ok(!overlaps('cloud/tasks/team.js', 'cloud/tasks/mac.js'));
  assert.ok(overlaps('cloud/tasks/team.js', 'cloud/tasks/*.js'));
  assert.ok(overlaps('cloud/**', 'cloud/tasks/*.js'));
  assert.ok(!overlaps('cloud/**', 'dashboard/**'));
  assert.ok(overlaps('dashboard/', 'dashboard/src/a.svelte'));
});

test('a message reaches the agent it is for, or every agent; each reads it once', async () => {
  const { call } = setup();
  assert.equal((await call('POST', '/v1/team/send', { from: 'R1-1', to: 'R2-1', text: 'I am changing worker.js' }, 'nobody')).status, 401);
  assert.equal((await call('POST', '/v1/team/send', { from: 'R1-1', to: 'R2-1' })).status, 400);
  const sent = await call('POST', '/v1/team/send', { from: 'R1-1', to: 'R2-1', text: 'I am changing worker.js; leave takeRequest to me', request: 1 });
  assert.equal(sent.status, 200);
  await call('POST', '/v1/team/send', { from: 'R3-1', to: 'all', text: 'main moved: rebase before you land' });
  await call('POST', '/v1/team/send', { from: 'R2-1', to: 'all', text: 'my own news' });

  const peek = await call('GET', '/v1/team/inbox?agent=R2-1&peek=1');
  assert.deepEqual(peek.body.messages.map((m) => [m.from, m.text]), [
    ['R1-1', 'I am changing worker.js; leave takeRequest to me'], ['R3-1', 'main moved: rebase before you land']]);
  assert.equal(peek.body.messages[0].request, 1);
  assert.equal((await call('GET', '/v1/team/inbox?agent=R2-1')).body.messages.length, 2, 'peeking left them unread');
  assert.equal((await call('GET', '/v1/team/inbox?agent=R2-1')).body.messages.length, 0, 'read once');
  assert.deepEqual((await call('GET', '/v1/team/inbox?agent=R1-1')).body.messages.map((m) => m.from), ['R3-1', 'R2-1'], 'a message to all reaches each');
  assert.equal((await call('GET', '/v1/team/inbox')).status, 400);
});

test('a lease keeps other agents off its files until it is let go or lapses; shared leases share', async () => {
  const { call, clock } = setup();
  const first = await call('POST', '/v1/team/claim', { agent: 'R1-1', paths: ['cloud/tasks/worker.js', 'dashboard/'], note: 'stuck requests' });
  assert.deepEqual(first.body.claimed, ['cloud/tasks/worker.js', 'dashboard/']);
  assert.deepEqual(first.body.conflicts, []);

  const second = await call('POST', '/v1/team/claim', { agent: 'R2-1', paths: ['cloud/tasks/*.js', 'cloud/vm-agent/mac-mcp.mjs'], minutes: 30 });
  assert.deepEqual(second.body.claimed, ['cloud/vm-agent/mac-mcp.mjs']);
  assert.deepEqual(second.body.conflicts.map((c) => [c.path, c.holder, c.held, c.note]), [['cloud/tasks/*.js', 'R1-1', 'cloud/tasks/worker.js', 'stuck requests']]);
  assert.equal(second.body.conflicts[0].expires_in, 3600);

  // Shared leases sit together; an exclusive one can't join them.
  assert.deepEqual((await call('POST', '/v1/team/claim', { agent: 'R3-1', paths: ['README.md'], exclusive: false })).body.claimed, ['README.md']);
  assert.deepEqual((await call('POST', '/v1/team/claim', { agent: 'R4-1', paths: ['README.md'], exclusive: false })).body.claimed, ['README.md']);
  assert.equal((await call('POST', '/v1/team/claim', { agent: 'R5-1', paths: ['README.md'] })).body.conflicts.length, 2);

  const over = await call('GET', '/v1/team/claims?paths=cloud/tasks/worker.js');
  assert.deepEqual(over.body.leases.map((l) => [l.agent, l.path, l.exclusive, l.held_for]), [['R1-1', 'cloud/tasks/worker.js', true, 0]]);

  // Let go, the files are free; a lease nobody renews lapses.
  assert.equal((await call('POST', '/v1/team/release', { agent: 'R1-1', paths: ['cloud/tasks/worker.js'] })).body.released, 1);
  assert.deepEqual((await call('POST', '/v1/team/claim', { agent: 'R2-1', paths: ['cloud/tasks/*.js'] })).body.claimed, ['cloud/tasks/*.js']);
  clock.t += 31 * 60_000;
  assert.deepEqual((await call('GET', '/v1/team/claims')).body.leases.map((l) => [l.agent, l.path]),
    [['R1-1', 'dashboard/'], ['R3-1', 'README.md'], ['R4-1', 'README.md'], ['R2-1', 'cloud/tasks/*.js']], 'R2-1’s 30-minute lease on mac-mcp.mjs lapsed');
  assert.equal((await call('POST', '/v1/team/release', { agent: 'R1-1' })).body.released, 1, 'all of its leases');
  assert.equal((await call('POST', '/v1/team/claim', { agent: 'R1-1', paths: ['/etc/passwd'] })).status, 400);
});

test("who's working: the running tasks and the agents holding files", async () => {
  const { env, call, clock } = setup();
  const t = Math.floor(clock.t / 1000);
  env.DB.db.exec(`INSERT INTO board_runs (machine, run, agent, title, status, request, task, started_at, updated_at) VALUES
    ('cloud', '1201', 'code', 'Show stuck requests', 'working', 12, 1, ${t - 100}, ${t - 10}),
    ('cloud', '1301', 'cloud', 'Old run', 'working', 13, 1, ${t - 9000}, ${t - 5000}),
    ('cloud', '1401', 'cloud', 'Done run', 'done', 14, 1, ${t - 100}, ${t - 10});`);
  await call('POST', '/v1/team/claim', { agent: 'R12-1', paths: ['dashboard/'] });
  await call('POST', '/v1/team/claim', { agent: 'alice-codex', paths: ['cloud/tasks/team.js'], note: 'messages' });
  const { agents } = (await call('GET', '/v1/team/agents')).body;
  assert.deepEqual(agents.map((a) => [a.name, a.title, a.files.map((f) => f.path)]), [
    ['R12-1', 'Show stuck requests', ['dashboard/']], ['alice-codex', '', ['cloud/tasks/team.js']]]);
});
