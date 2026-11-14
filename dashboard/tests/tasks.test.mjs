import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentsAtWork, ago, byPart, cost, estimates, normalizeBoard, parts, projectName, projects, sections, where } from '../src/lib/tasks.js';

const cloud = {
  source: 'cloud',
  board: {
    now: 1_794_660_000,
    tasks: [
      { machine: 'mac', id: 'T1', message: 'M1', quote: 'fix the login', title: 'Fix the login', status: 'waiting',
        harness: 'claude', project: 'github.com/agenticaiuw/hive', updated_at: '2026-11-14T04:00:00' },
      { machine: 'vm', id: 'T1', message: 'M1', quote: 'post it', title: 'Post the update', status: 'active',
        harness: 'codex', project: 'github.com/agenticaiuw/hive', updated_at: '2026-11-14T04:30:00' },
      { machine: 'mac', id: 'T2', quote: 'check majors', title: 'Check every major', status: 'open',
        harness: 'claude', project: 'github.com/evan1liu/buckymatch', updated_at: '2026-11-14T03:00:00' },
      { machine: 'mac', id: 'T3', quote: 'old', title: 'Old thing', status: 'done', outcome: 'Shipped',
        harness: 'hive', project: 'github.com/agenticaiuw/hive', updated_at: '2026-11-13T03:00:00' },
    ],
    unsplit: [{ machine: 'mac', id: 'M9', harness: 'claude', project: '/Users/x', text: 'login', said_at: '2026-11-14T00:49:29' }],
    rules: [{ machine: 'mac', id: 'R1', text: 'One dashboard', quote: 'one dashboard', project: 'github.com/agenticaiuw/hive' }],
  },
};

test('the cloud board: every machine, the same id on two machines kept apart', () => {
  const b = normalizeBoard(cloud);
  assert.equal(b.source, 'cloud');
  assert.equal(b.tasks.length, 4);
  assert.deepEqual(b.tasks.map((t) => t.key), ['mac:T1', 'vm:T1', 'mac:T2', 'mac:T3']);
  assert.equal(b.tasks[0].projectName, 'hive');
  assert.equal(b.unsplit[0].text, 'login');
  assert.equal(b.rules[0].text, 'One dashboard');
  assert.equal(where(b.tasks[1]), 'Codex · vm · hive');
});

test('sections: what needs the owner first, then work, then not started, then done', () => {
  const s = sections(normalizeBoard(cloud).tasks);
  assert.deepEqual(s.map((x) => [x.id, x.tasks.map((t) => t.key)]), [
    ['needs-you', ['mac:T1']],
    ['working', ['vm:T1']],
    ['not-started', ['mac:T2']],
    ['done', ['mac:T3']],
  ]);
  const hive = sections(normalizeBoard(cloud).tasks, { project: 'hive', query: 'post' });
  assert.deepEqual(hive.flatMap((x) => x.tasks.map((t) => t.key)), ['vm:T1']);
});

test("this machine's ledger when the cloud is out of reach", () => {
  const b = normalizeBoard({
    source: 'local',
    note: "Couldn't reach the cloud",
    board: {
      generated_at: '2026-11-14T05:00:00',
      needs_you: [{ id: 'T21', title: 'Keep going', status: 'waiting', harness: 'claude', project: 'p' }],
      in_progress: [],
      not_started: [{ id: 'T20', title: 'Majors', status: 'open', harness: 'claude', project: 'p' }],
      left_open: [],
      done: [{ id: 'T25', title: 'Board', status: 'done', harness: 'claude', project: 'p', done_at: '2026-11-14T04:59:15' }],
      not_split: [{ id: 'M2', text: 'login', said_at: '2026-11-14T00:49:29' }],
      rules: [],
    },
  });
  assert.equal(b.source, 'local');
  assert.equal(b.note, "Couldn't reach the cloud");
  assert.deepEqual(b.tasks.map((t) => t.key), ['this machine:T21', 'this machine:T20', 'this machine:T25']);
  assert.equal(b.unsplit[0].key, 'this machine:M2');
});

test('projects, names and times in the owner\'s words', () => {
  assert.deepEqual(projects(normalizeBoard(cloud).tasks).map((p) => [p.name, p.open]), [['hive', 2], ['buckymatch', 1]]);
  assert.equal(projectName('/Users/x/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026'), 'a scratch folder');
  assert.equal(projectName('/Users/evanliu/'), 'evanliu');
  assert.equal(ago(1000 - 30, 1000), 'just now');
  assert.equal(ago(1000 - 600, 1000), '10 min ago');
  assert.equal(ago(100_000 - 7200, 100_000), '2 h ago');
  assert.equal(ago(1_000_000 - 86400 * 3, 1_000_000), '3 days ago');
});

test('one project by name however it is written; parts group similar tasks', () => {
  const b = normalizeBoard({ source: 'cloud', board: { now: 100, tasks: [
    { machine: 'mac', id: 'T1', title: 'a', status: 'open', project: 'github.com/agenticaiuw/hive', part: 'memory retrieval', updated_at: 50 },
    { machine: 'mac', id: 'T2', title: 'b', status: 'open', project: '/Users/x/hive', updated_at: 40 },
    { machine: 'mac', id: 'T3', title: 'c', status: 'done', project: 'Hive', part: 'Memory retrieval', updated_at: 30 },
    { machine: 'mac', id: 'T4', title: 'd', status: 'open', project: 'github.com/evan1liu/buckymatch', part: 'major requirements validation', updated_at: 20 },
  ] } });
  assert.deepEqual(projects(b.tasks).map((p) => [p.key, p.name, p.open, p.all]), [['hive', 'hive', 2, 3], ['buckymatch', 'buckymatch', 1, 1]]);
  assert.deepEqual(parts(b.tasks, 'hive').map((p) => [p.key, p.all]), [['memory retrieval', 2]]);
  assert.deepEqual(sections(b.tasks, { part: 'memory retrieval' }).flatMap((s) => s.tasks.map((t) => t.id)), ['T1', 'T3']);
  assert.deepEqual(byPart(b.tasks).map((r) => [r.part, r.tasks.map((t) => t.id)]), [
    ['memory retrieval', ['T1', 'T3']], ['major requirements validation', ['T4']], ['', ['T2']],
  ]);
});

test('the agents at work and the task each is on; what a task cost', () => {
  const b = normalizeBoard({ source: 'cloud', board: { now: 10_000, tasks: [
    { machine: 'mac', id: 'T1', title: 'On it', status: 'active', harness: 'claude', session: 's1', project: 'hive', updated_at: 1_000 },
    { machine: 'vm', id: 'T1', title: 'Just asked', status: 'open', harness: 'codex', session: 's2', project: 'hive', created_at: 9_500 },
    { machine: 'mac', id: 'T2', title: 'Stale', status: 'open', harness: 'claude', session: 's3', project: 'hive', created_at: 100 },
    { machine: 'mac', id: 'T3', title: 'Done', status: 'done', harness: 'claude', session: 's1', project: 'hive', minutes: 10,
      work_seconds: 840, tokens_in: 1_200_000, tokens_out: 18_000, updated_at: 900 },
  ] } });
  assert.deepEqual(agentsAtWork(b.tasks, 10_000).map((a) => [a.machine, a.session, a.on.map((t) => t.id), a.open.map((t) => t.id)]), [
    ['vm', 's2', [], ['T1']], ['mac', 's1', ['T1'], []],
  ]);
  assert.equal(cost(b.tasks[3]), 'took 14 min (est. 10 min) · 1.2M tokens, 18k written');
  assert.equal(cost(b.tasks[0]), '');
  assert.equal(estimates(b.tasks), null);
});
