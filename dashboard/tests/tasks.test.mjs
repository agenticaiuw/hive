import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, normalizeBoard, projectName, projects, sections, where } from '../src/lib/tasks.js';

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
  const hive = sections(normalizeBoard(cloud).tasks, { project: 'github.com/agenticaiuw/hive', query: 'post' });
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
