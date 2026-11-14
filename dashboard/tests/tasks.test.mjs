import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentsAtWork, ago, byFolder, commitUrl, cost, estimates, folderList, normalizeBoard, normalizeFolder, projectName, projects, sections, where } from '../src/lib/tasks.js';

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

test('one project by name however it is written; folders group similar tasks', () => {
  const b = normalizeBoard({ source: 'cloud', board: { now: 100, tasks: [
    { machine: 'mac', id: 'T1', title: 'a', status: 'open', project: 'github.com/agenticaiuw/hive', folder: 'memory retrieval', updated_at: 50 },
    { machine: 'mac', id: 'T2', title: 'b', status: 'open', project: '/Users/x/hive', updated_at: 40 },
    // An older ledger's "part"; a scratch session's task filed in hive's folder by name.
    { machine: 'mac', id: 'T3', title: 'c', status: 'done', project: 'Hive', part: 'Memory retrieval', updated_at: 30 },
    { machine: 'mac', id: 'T5', title: 'e', status: 'open', project: '/U/scratch-workspaces/x', folder: 'hive › memory retrieval', updated_at: 25 },
    { machine: 'mac', id: 'T4', title: 'd', status: 'open', project: 'github.com/evan1liu/buckymatch', folder: 'major requirements validation', updated_at: 20 },
  ], folders: [
    { project: 'hive', key: 'memory retrieval', name: 'Memory retrieval', about: 'Finding facts', memories: 3, updated_at: 10 },
    { project: 'hive', key: 'voice', name: 'Voice', about: '', memories: 1, updated_at: 10 },
    { project: 'hivemind', key: 'dreams', name: 'Dreams', about: '', memories: 0, updated_at: 10 },
  ] } });
  assert.deepEqual(projects(b.tasks, b.folders).map((p) => [p.key, p.name, p.open, p.all]),
    [['hive', 'hive', 3, 4], ['buckymatch', 'buckymatch', 1, 1], ['hivemind', 'hivemind', 0, 0]]);
  assert.deepEqual(folderList(b.tasks, b.folders, 'hive').map((f) => [f.key, f.name, f.open, f.all, f.memories]),
    [['memory retrieval', 'Memory retrieval', 2, 3, 3], ['voice', 'Voice', 0, 0, 1]]);
  assert.deepEqual(sections(b.tasks, { project: 'hive', folder: 'memory retrieval' }).flatMap((s) => s.tasks.map((t) => t.id)), ['T1', 'T5', 'T3']);
  assert.deepEqual(byFolder(b.tasks).map((r) => [r.folder, r.tasks.map((t) => t.id)]), [
    ['memory retrieval', ['T1', 'T3', 'T5']], ['major requirements validation', ['T4']], ['', ['T2']],
  ]);
});

test('a folder and its memories in one shape from the cloud or a ledger', () => {
  const cloud = normalizeFolder({ folder: { project: 'hive', key: 'voice', name: 'Voice', about: 'Speech' },
    memories: [{ machine: 'web', id: 2, kind: 'spec', title: 'Wake word', body: 'Hey Hive', task: null, created_at: 5 }] });
  assert.deepEqual([cloud.name, cloud.about, cloud.memories[0].key, cloud.memories[0].kind, cloud.memories[0].task], ['Voice', 'Speech', 'web:2', 'spec', '']);
  const local = normalizeFolder({ project: 'hive', name: 'Voice', memories: [{ id: 1, kind: 'note', title: 'a', body: 'b', from: null, created_at: '2026-11-14T05:00:00' }] });
  assert.deepEqual([local.key, local.memories[0].key, local.memories[0].created > 0], ['voice', 'here:1', true]);
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

test('a task shows the files its agent changed and its commits, each linking to its diff', () => {
  const board = normalizeBoard({ source: 'cloud', board: { now: 1, tasks: [
    { machine: 'mac', id: 'T9', title: 'Fix login', status: 'done', project: 'github.com/agenticaiuw/hive',
      files: '["src/login.ts","~/notes.md"]', commits: '[{"hash":"e9256e3","branch":"main","title":"Fix the login"}]' },
    { machine: 'mac', id: 'T10', title: 'Local', status: 'done', project: '/Users/me/scratch',
      files: 'not json', commits: [{ hash: 'abcdef1', title: 'Local work' }, { title: 'no hash' }] },
  ] } });
  const [github, local] = [board.tasks.find((t) => t.id === 'T9'), board.tasks.find((t) => t.id === 'T10')];
  assert.deepEqual(github.files, ['src/login.ts', '~/notes.md']);
  assert.equal(commitUrl(github, github.commits[0]), 'https://github.com/agenticaiuw/hive/commit/e9256e3');
  assert.deepEqual(local.files, []);
  assert.equal(local.commits.length, 1);
  assert.equal(commitUrl(local, local.commits[0]), '');
});
