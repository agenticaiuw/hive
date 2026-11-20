import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentOfTask, agents, conversation, line, reasonFor, summary, threadConversation, withTitles } from '../src/lib/agents.js';
import { normalizeBoard } from '../src/lib/tasks.js';

const NOW = 1_794_889_000;
const HIVE = 'github.com/agenticaiuw/hive';

function board() {
  return normalizeBoard({
    source: 'cloud',
    board: {
      now: NOW,
      tasks: [
        { machine: 'mac', id: 174, title: 'Eye typing knows every English word', status: 'active', harness: 'claude', session: 'eyes', project: HIVE, updated_at: NOW - 60 },
        { machine: 'mac', id: 148, title: 'A shortcut starts each swiped word', status: 'open', harness: 'claude', session: 'eyes', project: HIVE, updated_at: NOW - 600 },
        { machine: 'mac', id: 168, title: 'Pick which disk cleanup to run', status: 'waiting', outcome: 'Pick one: Rust build folders or Xcode caches', harness: 'claude', session: 'disk', project: HIVE, updated_at: NOW - 900 },
        { machine: 'mac', id: 120, title: 'Old finished work', status: 'done', harness: 'claude', session: 'gone', project: HIVE, updated_at: NOW - 9 * 86400 },
        { machine: 'cloud', id: 1301, title: 'Open example.com', status: 'open', harness: 'hive', session: 'web', updated_at: NOW - 100 },
      ],
      runs: [
        { machine: 'mac', run: 'claude:eyes', agent: 'claude', title: 'why does this say stuck', status: 'working', project: HIVE, updated_at: NOW - 30 },
        { machine: 'mac', run: 'claude:gone', agent: 'claude', title: 'old', status: 'done', project: HIVE, updated_at: NOW - 3 * 86400 },
        { machine: 'cloud', run: '1301', agent: 'cloud', title: 'Open example.com', status: 'working', request: 13, task: 1, updated_at: NOW - 20 },
      ],
      run_steps: [
        { machine: 'mac', run: 'claude:eyes', n: 1, at: NOW - 100, kind: 'asked', text: 'why does this say stuck' },
        { machine: 'mac', run: 'claude:eyes', n: 2, at: NOW - 90, kind: 'action', text: '$ cd ~/hive && git status' },
        { machine: 'mac', run: 'claude:eyes', n: 3, at: NOW - 80, kind: 'say', text: 'It was handed over without a claim.' },
        { machine: 'cloud', run: '1301', n: 1, at: NOW - 15, kind: 'action', text: 'navigate: https://example.com' },
      ],
      requests: [
        { id: 12, text: 'Summarize my inbox', status: 'done', outcome: 'Three new emails.', created_at: NOW - 400, updated_at: NOW - 300 },
        { id: 13, follows: 12, text: 'Open example.com', status: 'working', created_at: NOW - 200, updated_at: NOW - 20 },
      ],
    },
  });
}

test('every agent is one row with the tasks it holds: the one needing the owner first, never a bare "Working"', () => {
  const list = agents(board());
  assert.deepEqual(list.map((a) => [a.key, a.status]), [
    ['cloud|R12', 'working'], // the VM's agent, pinned first
    ['mac|claude:disk', 'needs-you'],
    ['mac|claude:eyes', 'working'],
  ]);
  const eyes = list.find((a) => a.key === 'mac|claude:eyes');
  assert.equal(eyes.title, 'Eye typing knows every English word', 'named for the task it is on');
  assert.deepEqual(eyes.tasks.map((t) => t.id), ['174', '148']);
  assert.deepEqual([eyes.label, eyes.place, eyes.latest], ['Claude Code', 'hive · on mac', 'It was handed over without a claim.']);

  const disk = list.find((a) => a.key === 'mac|claude:disk');
  assert.equal(disk.run, 'claude:disk', 'a session with no run can still be talked to');

  const thread = list.find((a) => a.key === 'cloud|R12');
  assert.deepEqual(thread.requests.map((r) => r.id), ['R12', 'R13'], 'a follow-up joins the thread it follows');
  assert.equal(thread.request, 13, 'talking to it follows up on the newest request');
  assert.deepEqual(thread.tasks.map((t) => t.id), ['1301']);
  assert.equal(agentOfTask(list).get('cloud:1301'), thread);
});

test('a task that has not started or is stuck says why', () => {
  const b = board();
  const list = agents(b);
  const of = agentOfTask(list);
  const task = (id) => b.tasks.find((t) => t.id === id);
  assert.equal(reasonFor(task('148'), of.get('mac:148')), 'Its agent is on “Eye typing knows every English word” first.');
  assert.equal(reasonFor(task('168'), of.get('mac:168')), 'Pick one: Rust build folders or Xcode caches');
  assert.equal(reasonFor({ ...task('168'), status: 'blocked', retrying: true }, of.get('mac:168')), 'Hive is continuing it for you. It was stuck on: Pick one: Rust build folders or Xcode caches');
  assert.equal(reasonFor(task('1301'), of.get('cloud:1301')), 'Hive on the VM is on an earlier step first.');

  const stopped = { ...list.find((a) => a.key === 'mac|claude:eyes'), status: 'idle' };
  assert.match(reasonFor(task('148'), stopped), /^Its session stopped while on “Eye typing knows every English word”, before getting here/);
  assert.match(reasonFor({ ...task('148'), session: '' }, undefined), /^No agent has it yet/);
});

function requestBoard({ status = 'working', age = 1200, tasks = [], runs = [], steps = [], requests = [] } = {}) {
  return normalizeBoard({ source: 'cloud', board: {
    now: NOW,
    requests: [{ id: 21, text: 'Move the recording', status, created_at: NOW - 3600, updated_at: NOW - age }, ...requests],
    tasks: tasks.map((t) => ({ machine: 'cloud', id: 2101, updated_at: NOW - age, ...t })),
    runs: runs.map((r) => ({ machine: 'cloud', run: '2101', request: 21, task: 1, started_at: NOW - 3600, updated_at: NOW, ...r })),
    run_steps: steps.map((s, i) => ({ machine: 'cloud', run: '2101', n: i + 1, kind: 'action', text: 'Read the file', ...s })),
  } });
}

test('unfinished requests become stuck at twenty minutes without progress, and recover on refresh', () => {
  for (const status of ['queued', 'planning', 'working']) {
    const b = requestBoard({ status, age: 1199 });
    assert.equal(agents(b)[0].status, 'working', status);
    b.now += 1;
    assert.equal(agents(b)[0].status, 'stuck', status);
    b.requests[0].updated = b.now;
    assert.equal(agents(b)[0].status, 'working', `${status} resumes`);
  }
});

test('blocked requests and blocked tasks stay visible as stuck while Hive retries', () => {
  for (const b of [
    requestBoard({ status: 'blocked', age: 0 }),
    requestBoard({ age: 0, tasks: [{ status: 'blocked', retrying: 1 }] }),
    requestBoard({ status: 'failed', tasks: [{ status: 'blocked' }] }),
  ]) {
    const a = agents(b)[0];
    assert.equal(a.status, 'stuck');
    assert.equal(a.pinned, true);
  }
  const b = requestBoard({ age: 0, tasks: [{ status: 'blocked' }] });
  b.tasks[0].status = 'active';
  assert.equal(agents(b)[0].status, 'working', 'a resolved blocker clears the warning');
});

test('recent steps and completed tasks count as progress, but a run heartbeat does not', () => {
  const quiet = requestBoard({ runs: [{ status: 'working' }], steps: [{ at: NOW - 1800 }] });
  assert.equal(agents(quiet)[0].status, 'stuck', 'updated_at alone cannot hide a stalled run');
  for (const b of [
    requestBoard({ runs: [{ status: 'working' }], steps: [{ at: NOW - 10 }] }),
    requestBoard({ tasks: [{ status: 'done', updated_at: NOW - 10 }] }),
    requestBoard({ runs: [{ status: 'working', started_at: NOW - 10 }] }),
  ]) assert.equal(agents(b)[0].status, 'working');
});

test('finished and owner-stopped requests do not become stuck with age', () => {
  for (const status of ['done', 'failed', 'dropped', 'cancelled']) {
    assert.equal(agents(requestBoard({ status, age: 86400, tasks: [{ status: 'dropped' }] }))[0].status, 'idle', status);
  }
  assert.equal(agents(requestBoard({ age: 0, tasks: [{ status: 'waiting' }] }))[0].status, 'needs-you');
});

test('a follow-up cannot hide or refresh an earlier stuck request in its thread', () => {
  const b = requestBoard({ requests: [
    { id: 22, follows: 21, text: 'Check the folder too', status: 'working', created_at: NOW - 20, updated_at: NOW },
  ], runs: [{ request: 22, run: '2201', started_at: NOW - 10 }] });
  assert.equal(agents(b)[0].status, 'stuck');
  b.requests[0].status = 'done';
  assert.equal(agents(b)[0].status, 'working', 'the follow-up is still running');
  b.requests[1].status = 'done';
  assert.equal(agents(b)[0].status, 'idle');
});

test('old stuck requests stay on the main list ahead of newer working and finished requests', () => {
  const b = requestBoard({ age: 3 * 86400, status: 'blocked', requests: [
    { id: 22, text: 'New work', status: 'working', created_at: NOW - 20, updated_at: NOW },
    { id: 23, text: 'Finished work', status: 'done', created_at: NOW - 10, updated_at: NOW },
  ] });
  assert.deepEqual(agents(b).map((a) => [a.key, a.status, !!a.pinned]), [
    ['cloud|R21', 'stuck', true], ['cloud|R22', 'working', false], ['cloud|R23', 'idle', false],
  ]);
});

test('a conversation is what the owner said, what the agent said, and its work folded into a line', () => {
  const steps = [
    { n: 1, at: 10, kind: 'asked', text: 'fix the stuck label' },
    { n: 2, at: 11, kind: 'action', text: '$ cd ~/hive && npm test' },
    { n: 3, at: 12, kind: 'action', text: 'Read /Users/x/hive/dashboard/src/lib/tasks.js' },
    { n: 4, at: 13, kind: 'action', text: 'ToolSearch: select:SendMessage' },
    { n: 5, at: 14, kind: 'action', text: 'Edit /Users/x/hive/dashboard/src/lib/agents.js' },
    { n: 6, at: 15, kind: 'say', text: 'Fixed: claimed tasks now show as working.' },
    { n: 7, at: 30, kind: 'asked', text: 'The owner just sent you this message from the Hive dashboard, in their own words. Read it and act on it now:\nalso the phone' },
    { n: 8, at: 31, kind: 'done', text: 'Done.' },
  ];
  const messages = [
    { id: 4, text: 'also the phone', status: 'delivered', detail: 'Continued its session with it.', created_at: 20 },
    { id: 5, text: 'The owner answered you on T7 ("Clean the disk"), which was waiting on them for: Pick one. Their answer, in their own words: Rust only', status: 'queued', created_at: 40 },
    { id: 6, text: 'The owner asks you to continue T9 ("Eye typing").', status: 'delivered', created_at: 50 },
  ];
  const items = conversation(steps, messages);
  assert.deepEqual(items.map((i) => i.type), ['owner', 'work', 'agent', 'owner', 'owner', 'note']);
  const work = items[1];
  assert.equal(work.summary, 'Ran 1 command, read 1 file and edited 1 file');
  assert.deepEqual(work.lines.map((l) => `${l.verb} ${l.target}`), ['Ran npm test', 'Read tasks.js', 'Edited agents.js']);
  assert.deepEqual([items[3].text, items[3].state, items[3].detail], ['also the phone', 'delivered', 'Continued its session with it.'],
    'a message that woke the session shows once, with how it got there');
  assert.deepEqual([items[4].text, items[4].about, items[4].state], ['Rust only', 'Answer to T7', 'queued']);
  assert.equal(items[5].text, 'You asked it to continue T9');
});

test('Hive in the cloud reads as one thread: each request, its steps, and how it ended', () => {
  const thread = agents(board()).find((a) => a.kind === 'cloud');
  const items = threadConversation(thread);
  assert.deepEqual(items.map((i) => [i.type, i.text ?? i.summary]), [
    ['owner', 'Summarize my inbox'],
    ['agent', 'Three new emails.'],
    ['owner', 'Open example.com'],
    ['work', 'Took 1 other step'],
  ]);
  assert.equal(items[3].lines[0].verb, 'Navigate:');
});

test('step lines are short and plain, and keep the whole step to open', () => {
  assert.deepEqual(line({ kind: 'action', text: 'Search for "fetchTaskBoard" in src' }),
    { verb: 'Searched for', target: '"fetchTaskBoard"', group: 'search', full: 'Search for "fetchTaskBoard" in src' });
  assert.equal(line({ kind: 'action', text: `$ ${'x'.repeat(200)}` }).full, `$ ${'x'.repeat(200)}`, 'nothing is cut off for good');
  assert.equal(line({ kind: 'say', text: 'Done' }).full, undefined, 'a line that is already whole has nothing more to show');
  assert.deepEqual(line({ kind: 'action', text: 'Open https://developer.apple.com/documentation/xctest' }).target, 'developer.apple.com/documentation/xctest');
  assert.equal(line({ kind: 'action', text: 'update_plan: advance=true' }), null);
  assert.equal(line({ kind: 'action', text: 'mcp__Claude_Browser__browser_batch: actions=[…]' }).verb, 'Browser batch:');
  assert.equal(line({ kind: 'action', text: `$ ${'x'.repeat(200)}` }).target.length, 90);
  assert.equal(summary([{ group: 'search' }, { group: 'search' }, { group: 'failed' }]), 'Searched 2 times (1 failed)');
});

test('tasks group under the agent that holds them, in the order they come', async () => {
  const { byAgent } = await import('../src/lib/agents.js');
  const b = board();
  const of = agentOfTask(agents(b));
  const groups = byAgent(b.tasks.filter((t) => t.status !== 'done'), of);
  assert.deepEqual(groups.map((g) => [g.key, g.tasks.map((t) => t.id)]), [
    ['mac|claude:eyes', ['174', '148']],
    ['mac|claude:disk', ['168']],
    ['cloud|R12', ['1301']],
  ]);
});

test("task numbers an agent wrote read as those tasks' titles, on the machine it wrote them", () => {
  const titles = new Map([['mac:246', 'Name tasks by time'], ['cloud:246', 'Post the update']]);
  assert.equal(withTitles('Done with T246; T999 is next.', 'mac', titles), 'Done with “Name tasks by time”; T999 is next.');
  assert.equal(withTitles('on T246', 'cloud', titles), 'on “Post the update”');
});

// The owner (2026-11-17): "i still can't see the agent that's on vm FIX THIS NOW!"
test("the VM's agent is always in the list, first and pinned, even when a job it ran by itself ended a day ago", () => {
  const b = board();
  b.requests = [];
  b.tasks = b.tasks.filter((t) => t.machine !== 'cloud');
  b.runs = [
    ...b.runs.filter((r) => r.machine !== 'cloud'),
    { machine: 'cloud', run: 'vm-2026-11-18T03-53-18-172Z', agent: 'hive', harness: 'hive', session: '', title: 'Post the thread on X', status: 'done', updated: NOW - 30 * 3600, steps: [
      { n: 1, at: NOW - 31 * 3600, kind: 'asked', text: 'Post the thread on X' },
      { n: 2, at: NOW - 30 * 3600, kind: 'say', text: '💬 X refused it: the post is 56 characters over.' },
    ] },
  ];
  const list = agents(b);
  const vm = list[0];
  assert.equal(vm.key, 'cloud|vm-2026-11-18T03-53-18-172Z');
  assert.deepEqual([vm.label, vm.place, vm.status, vm.pinned, vm.vm], ['Hive', 'on the VM', 'idle', true, true]);
  assert.equal(vm.title, 'Post the thread on X');
  assert.equal(list.filter((a) => a.pinned).length, 1, 'one pinned row');
});

test("a VM job that is working is the pinned one, over a newer one that ended", () => {
  const b = board();
  b.requests = [];
  b.tasks = b.tasks.filter((t) => t.machine !== 'cloud');
  b.runs = [
    ...b.runs.filter((r) => r.machine !== 'cloud'),
    { machine: 'cloud', run: 'vm-new', agent: 'hive', harness: 'hive', session: '', title: 'Ended', status: 'done', updated: NOW - 10, steps: [] },
    { machine: 'cloud', run: 'vm-old', agent: 'hive', harness: 'hive', session: '', title: 'Still going', status: 'working', updated: NOW - 60, steps: [] },
  ];
  const list = agents(b);
  assert.equal(list[0].key, 'cloud|vm-old');
  assert.equal(list.find((a) => a.key === 'cloud|vm-new').pinned, undefined);
});
