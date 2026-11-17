import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentsAtWork, ago, byFolder, commitUrl, cost, estimates, folderList, needsOwner, normalizeBoard, normalizeFolder, planLimits, projectName, projects, rulesByProject, ruleScope, sections, stamp, where } from '../src/lib/tasks.js';

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
      { machine: 'mac', id: 'T4', quote: 'merge', title: 'Merge the fork', status: 'blocked',
        harness: 'claude', project: 'github.com/agenticaiuw/hive', updated_at: '2026-11-14T02:00:00' },
    ],
    unsplit: [{ machine: 'mac', id: 'M9', harness: 'claude', project: '/Users/x', text: 'login', said_at: '2026-11-14T00:49:29' }],
    rules: [{ machine: 'mac', id: 'R1', text: 'One dashboard', quote: 'one dashboard', project: 'github.com/agenticaiuw/hive' }],
  },
};

test('the cloud board: every machine, the same id on two machines kept apart', () => {
  const b = normalizeBoard(cloud);
  assert.equal(b.source, 'cloud');
  assert.equal(b.tasks.length, 5);
  assert.deepEqual(b.tasks.map((t) => t.key), ['mac:T1', 'vm:T1', 'mac:T2', 'mac:T3', 'mac:T4']);
  assert.equal(b.tasks[0].projectName, 'hive');
  assert.equal(b.unsplit[0].text, 'login');
  assert.equal(b.rules[0].text, 'One dashboard');
  assert.equal(where(b.tasks[1]), 'Codex · vm · hive');
});

test('sections: what needs the owner (a question, then a stuck task) first, then work, then not started, then done', () => {
  const s = sections(normalizeBoard(cloud).tasks);
  assert.deepEqual(s.map((x) => [x.id, x.tasks.map((t) => t.key)]), [
    ['needs-you', ['mac:T1', 'mac:T4']],
    ['working', ['vm:T1']],
    ['not-started', ['mac:T2']],
    ['done', ['mac:T3']],
  ]);
  const hive = sections(normalizeBoard(cloud).tasks, { project: 'hive', query: 'post' });
  assert.deepEqual(hive.flatMap((x) => x.tasks.map((t) => t.key)), ['vm:T1']);
});

test("a stuck task Hive is still continuing by itself is being worked on, not the owner's", () => {
  const board = structuredClone(cloud);
  board.board.tasks[4].retrying = 1;
  const tasks = normalizeBoard(board).tasks;
  assert.equal(tasks[4].retrying, true);
  assert.equal(tasks[0].retrying, false);
  assert.deepEqual(sections(tasks).map((x) => [x.id, x.tasks.map((t) => t.key)]), [
    ['needs-you', ['mac:T1']],
    ['working', ['vm:T1', 'mac:T4']],
    ['not-started', ['mac:T2']],
    ['done', ['mac:T3']],
  ]);
  assert.deepEqual(tasks.filter(needsOwner).map((t) => t.key), ['mac:T1']);
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
  assert.deepEqual(projects(normalizeBoard(cloud).tasks).map((p) => [p.name, p.open]), [['hive', 3], ['buckymatch', 1]]);
  assert.equal(projectName('/Users/x/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026'), 'a scratch folder');
  assert.equal(projectName('/Users/you/'), 'you');
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

test('plan limits come from either board and show each window, reset once its time passes', () => {
  const now = 1_795_000_000;
  const cloud = normalizeBoard({
    source: 'cloud',
    board: {
      now,
      tasks: [],
      limits: [
        {
          machine: 'studio-mac', harness: 'codex', home: '~/.codex', plan: 'prolite', at: now - 60,
          windows: JSON.stringify([
            { minutes: 300, used: 92.4, resets_at: now + 2 * 3600 },
            { minutes: 10080, used: 15, resets_at: now + 4 * 86400 },
          ]),
        },
        { machine: 'vm', harness: 'codex', home: '~/.codex-hive', plan: 'pro', windows: '[{"minutes": 300, "used": 40, "resets_at": 1}]' },
        { machine: 'vm', harness: 'claude', home: '~/.claude', plan: '', windows: '[]' },
      ],
    },
  });
  assert.equal(cloud.limits.length, 3);
  const shown = planLimits(cloud.limits, now);
  assert.equal(shown.length, 2); // nothing to show for a harness with no windows
  assert.equal(shown[0].who, 'Codex · Pro 10x · studio-mac');
  assert.deepEqual(shown[0].windows, [
    { label: '5 h', used: 92.4, fresh: false, resets: 'resets in 2 h' },
    { label: 'Week', used: 15, fresh: false, resets: 'resets in 4 days' },
  ]);
  assert.deepEqual(shown[1].windows, [{ label: '5 h', used: 0, fresh: true, resets: '' }]);

  const local = normalizeBoard({
    source: 'local',
    board: { done: [], limits: [{ harness: 'codex', home: '~/.codex', plan: 'plus', windows: [{ minutes: 10080, used: 150, resets_at: now + 600 }] }] },
  });
  assert.equal(local.limits[0].machine, 'this machine');
  assert.deepEqual(planLimits(local.limits, now)[0].windows, [{ label: 'Week', used: 100, fresh: false, resets: 'resets in 10 min' }]);
  assert.deepEqual(normalizeBoard({ board: { tasks: [] } }).limits, []);
  const month = planLimits([{ machine: 'vm', harness: 'codex', home: '~/.codex', plan: 'free', windows: [{ minutes: 43200, used: 94, resets_at: now + 3600 }, { minutes: 4320, used: 1 }] }], now);
  assert.deepEqual(month[0].windows.map(w => w.label), ['Month', '3 days']);
  // The same plan read on the Mac days ago and by Hive's agent on the VM just now: only the VM's.
  const same = planLimits([
    { key: 'mac:codex:~/.codex', machine: 'mac', harness: 'codex', home: '~/.codex', plan: 'prolite', at: now - 3 * 86400, windows: [{ minutes: 10080, used: 15, resetsAt: now + 86400 }] },
    { key: 'vm:codex:~/.codex-hive', machine: 'vm', harness: 'codex', home: '~/.codex-hive', plan: 'prolite', at: now - 60, windows: [{ minutes: 10080, used: 17, resetsAt: now + 86400 }] },
  ], now);
  assert.equal(same.length, 1);
  assert.equal(same[0].who, 'Codex · Pro 10x · vm');
  assert.equal(same[0].windows[0].used, 17);

  // Claude Code reports its own plan's windows (hive-tasks claude-limits), already named.
  const claude = planLimits([{ machine: 'mac', harness: 'claude', home: '~/.claude', plan: 'Max 5x', windows: [{ minutes: 300, used: 41, resetsAt: now + 7200 }] }], now);
  assert.equal(claude[0].who, 'Claude Code · Max 5x · mac');
  assert.deepEqual(claude[0].windows, [{ label: '5 h', used: 41, fresh: false, resets: 'resets in 2 h' }]);
});

test("each request sent to Hive in the cloud carries its tasks' steps, in order", () => {
  const board = normalizeBoard({
    source: 'cloud',
    board: {
      now: 1000,
      tasks: [],
      requests: [
        { id: 12, text: 'open example.com', status: 'working', created_at: 900, updated_at: 990 },
        { id: 11, text: 'earlier', status: 'done', created_at: 800, updated_at: 850 },
      ],
      runs: [
        { machine: 'cloud', run: '1202', agent: 'cloud', title: 'Read it', status: 'working', request: 12, task: 2, started_at: 996, updated_at: 997 },
        { machine: 'cloud', run: '1201', agent: 'cloud', title: 'Open it', status: 'done', request: 12, task: 1, started_at: 990, updated_at: 995 },
      ],
      run_steps: [
        { machine: 'cloud', run: '1201', n: 2, at: 995, kind: 'say', text: '💬 The heading says Example Domain.' },
        { machine: 'cloud', run: '1202', n: 1, at: 997, kind: 'action', text: '→ read_page' },
        { machine: 'cloud', run: '1201', n: 1, at: 991, kind: 'action', text: '→ open_url: Open example.com' },
      ],
    },
  });
  const [working, earlier] = board.requests;
  assert.deepEqual(working.steps.map((s) => [s.n, s.task, s.kind, s.text]), [
    [1, 1, 'action', '→ open_url: Open example.com'],
    [2, 1, 'say', '💬 The heading says Example Domain.'],
    [3, 2, 'action', '→ read_page'],
  ]);
  assert.deepEqual(earlier.steps, []);
});

test("every node's agents are on the board live: working first, each with where it runs and its steps", () => {
  const board = normalizeBoard({
    source: 'cloud',
    board: {
      now: 1000,
      tasks: [],
      runs: [
        { machine: 'studio-mac', run: 's1-2', agent: 'mac', title: 'Open Notes', status: 'done', started_at: 900, updated_at: 990 },
        { machine: 'ext:chrome', run: 'b-7', agent: 'browser', title: 'Summarize this page', status: 'working', started_at: 950, updated_at: 960 },
        { machine: 'cloud', run: '1301', agent: 'cloud', title: 'Text Sam', status: 'working', request: 13, task: 1, started_at: 970, updated_at: 980 },
      ],
      run_steps: [
        { machine: 'studio-mac', run: 's1-2', n: 2, at: 989, kind: 'done', text: 'Opened Notes.' },
        { machine: 'studio-mac', run: 's1-2', n: 1, at: 980, kind: 'action', text: 'click(x=10, y=20)' },
        { machine: 'ext:chrome', run: 'b-7', n: 1, at: 955, kind: 'action', text: 'read_page: ok' },
      ],
    },
  });
  assert.deepEqual(board.runs.map((r) => [r.node, r.title, r.status, r.request]), [
    ['Hive in the cloud', 'Text Sam', 'working', 'R13'],
    ['Chrome extension', 'Summarize this page', 'working', ''],
    ['Hive on studio-mac', 'Open Notes', 'done', ''],
  ]);
  assert.deepEqual(board.runs[2].steps.map((s) => [s.n, s.kind, s.text]), [
    [1, 'action', 'click(x=10, y=20)'],
    [2, 'done', 'Opened Notes.'],
  ]);
  assert.deepEqual(normalizeBoard({ source: 'local', board: { done: [] } }).runs, []);
});

test('a Claude Code or Codex session in a turn is an agent at work, with or without a task of its own', () => {
  const board = normalizeBoard({
    source: 'cloud',
    board: {
      now: 10_000,
      tasks: [
        { machine: 'studio-mac', id: 'T1', title: 'Fix the count', status: 'active', harness: 'claude', session: 's1', project: 'github.com/agenticaiuw/hive', updated_at: 9_000 },
      ],
      runs: [
        // s1 has its task; s2 is a side session working on its parent's task, so has none of its own.
        { machine: 'studio-mac', run: 'claude:s1', agent: 'claude', title: 'fix the count', project: 'github.com/agenticaiuw/hive', status: 'working', started_at: 9_000, updated_at: 9_990 },
        { machine: 'studio-mac', run: 'claude:s2', agent: 'claude', title: 'stream the agents', project: 'github.com/agenticaiuw/hive', status: 'working', started_at: 9_000, updated_at: 9_995 },
        { machine: 'studio-mac', run: 'codex:s3', agent: 'codex', title: '', project: 'buckymatch', status: 'done', started_at: 100, updated_at: 9_900 },
        { machine: 'studio-mac', run: 'claude:s4', agent: 'claude', title: 'went quiet', project: 'x', status: 'working', started_at: 100, updated_at: 200 },
      ],
      run_steps: [
        { machine: 'studio-mac', run: 'claude:s2', n: 1, at: 9_995, kind: 'action', text: '$ cargo test' },
        { machine: 'studio-mac', run: 'codex:s3', n: 1, at: 9_800, kind: 'asked', text: 'tidy the tests' },
      ],
    },
  });
  const s2 = board.runs.find((r) => r.run === 'claude:s2');
  assert.deepEqual([s2?.label, s2?.harness, s2?.session, s2?.projectName], ['Claude Code · hive', 'claude', 's2', 'hive']);
  const s3 = board.runs.find((r) => r.run === 'codex:s3');
  assert.deepEqual([s3?.label, s3?.title], ['Codex · buckymatch', 'tidy the tests']);
  const agents = agentsAtWork(board.tasks, board.now, undefined, board.runs);
  assert.deepEqual(agents.map((a) => [a.session, a.on.map((t) => t.id), a.run?.key, a.projectName]), [
    ['s2', [], 'studio-mac:claude:s2', 'hive'],
    ['s1', ['T1'], 'studio-mac:claude:s1', 'hive'],
  ]);
  assert.deepEqual(agents[0].run?.steps.map((s) => s.text), ['$ cargo test']);
});

test('each standing rule says where it applies and when an agent is given it', () => {
  const board = normalizeBoard({ board: { rules: [
    { machine: 'mac', id: 2, project: 'github.com/agenticaiuw/hive', paths: '[]', text: 'Keep it clean', shown: 0 },
    { machine: 'vm', id: 9, project: 'github.com/agenticaiuw/hive', paths: '["web/**/*.svelte"]', text: 'Use the Button', shown: 3 },
  ] } });
  const [wide, files] = board.rules;
  assert.deepEqual([wide.machine, wide.id, wide.paths], ['mac', '2', []]);
  assert.equal(ruleScope(wide), 'hive · whole project · every agent session here, at its start and after it compacts, and every cloud task');
  assert.deepEqual(files.paths, ['web/**/*.svelte']);
  assert.equal(ruleScope(files), 'hive · web/**/*.svelte · when an agent first edits one of these files in a session, and in every cloud task · shown 3 times');
});

test('the standing rules sit under their projects, by name, with no project last', () => {
  const board = normalizeBoard({ board: { rules: [
    { machine: 'mac', id: 1, project: '', text: 'Anywhere' },
    { machine: 'mac', id: 2, project: 'github.com/agenticaiuw/hive', paths: '[]', text: 'Keep it clean' },
    { machine: 'mac', id: 3, project: '/Users/me/buckymatch', text: 'Match fairly' },
    { machine: 'vm', id: 4, project: 'github.com/agenticaiuw/hive', text: 'Cloud first' },
  ] } });
  const groups = rulesByProject(board.rules);
  assert.deepEqual(groups.map((g) => [g.name, g.rules.map((r) => r.text)]), [
    ['buckymatch', ['Match fairly']],
    ['hive', ['Keep it clean', 'Cloud first']],
    ['No project', ['Anywhere']],
  ]);
  // Under its project's heading a rule doesn't name the project again.
  assert.equal(ruleScope(groups[1].rules[0], { project: false }), 'whole project · every agent session here, at its start and after it compacts, and every cloud task');
});

test('a task is called by when the owner asked for it, yymmdd hh:mm, and nothing else', () => {
  const at = (h, m, s = 0) => new Date(2026, 10, 17, h, m, s).getTime() / 1000;
  const b = normalizeBoard({ board: { tasks: [
    { machine: 'mac', id: 309, title: 'Group the rules', said_at: at(1, 41, 10), created_at: at(1, 42) },
    { machine: 'mac', id: 306, title: 'Tasks in view', said_at: at(1, 41, 10), created_at: at(1, 41, 40) },
    { machine: 'mac', id: 7, title: 'No time' },
  ] } });
  assert.deepEqual(b.tasks.map((t) => t.asked), ['261117 01:41', '261117 01:41', '']);
  assert.equal(stamp(at(23, 7)), '261117 23:07');
});
