import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MOST_FIXES, MOST_ROUNDS, againBrief, askedBrief, failuresOf, fixBrief, gateTests, improveBrief, landedLine, macFailures, macRunning, onTheMac,
  partsOf, readNeed, SELF_GUIDE, blockers, othersHold,
} from './improve.mjs';

test('a need is read once, and only with both what and why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-improve-'));
  try {
    const file = join(dir, 'r1-1-0.json');
    assert.equal(readNeed(''), null);
    assert.equal(readNeed(file), null, 'no file: nothing asked');
    writeFileSync(file, JSON.stringify({ what: '  run commands on the Mac ', why: 'Finder had no way to copy a file to the VM', at: 1 }));
    assert.deepEqual(readNeed(file), { what: 'run commands on the Mac', why: 'Finder had no way to copy a file to the VM' });
    assert.equal(existsSync(file), false, 'removed as it is read');
    writeFileSync(file, JSON.stringify({ what: 'x' }));
    assert.equal(readNeed(file), null, 'no why');
    writeFileSync(file, 'not json');
    assert.equal(readNeed(file), null);
    writeFileSync(file, JSON.stringify({ what: 'w'.repeat(900), why: 'y'.repeat(9000) }));
    const long = readNeed(file);
    assert.equal(long.what.length, 500);
    assert.equal(long.why.length, 4000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('where a change lives decides where it is tested and put live', () => {
  assert.deepEqual(partsOf(['cloud/vm-agent/mac-mcp.mjs']), { vm: true, board: false, mac: false, site: false, cloudTests: false });
  assert.deepEqual(partsOf(['cloud/tasks/mac.js', 'cloud/knowledge/migrations/0030_x.sql']), { vm: false, board: true, mac: false, site: false, cloudTests: true });
  assert.equal(partsOf(['desktop/app/crates/hive/hive-app/src/cloud_brain.rs']).mac, true);
  assert.equal(partsOf(['dashboard/src/routes/+page.svelte']).mac, true, "the Mac window's dashboard");
  assert.equal(partsOf(['dashboard/src/routes/+page.svelte']).site, true, 'the dashboard website');
  assert.equal(partsOf(['desktop/vm-post.mjs']).site, false);
  assert.equal(partsOf(['cloud/tests/board.test.mjs']).board, false, 'a board test alone deploys nothing');
  assert.equal(partsOf(['cloud/tests/board.test.mjs']).cloudTests, true);
});

test('the gate runs the privacy test always, and the tests of each part a change touched', () => {
  const have = [
    'cloud/shared/privacy.test.mjs', 'cloud/shared/ownerDetails.test.mjs', 'cloud/tests/board.test.mjs',
    'cloud/vm-agent/mac-mcp.test.mjs', 'cloud/vm-agent/updater.test.mjs', 'dashboard/src/tasks.test.mjs',
  ];
  assert.deepEqual(gateTests(['cloud/vm-agent/mac-mcp.mjs'], have),
    ['cloud/shared/privacy.test.mjs', 'cloud/vm-agent/mac-mcp.test.mjs', 'cloud/vm-agent/updater.test.mjs']);
  assert.deepEqual(gateTests(['cloud/tasks/worker.js'], have),
    ['cloud/shared/ownerDetails.test.mjs', 'cloud/shared/privacy.test.mjs', 'cloud/tests/board.test.mjs']);
  assert.deepEqual(gateTests(['README.md'], have), ['cloud/shared/privacy.test.mjs']);
  assert.ok(!gateTests(['dashboard/src/tasks.mjs', 'dashboard/src/tasks.test.mjs'], have).includes('dashboard/src/tasks.test.mjs'),
    "the dashboard's tests need its installs, which the VM doesn't have");
});

test("the code agent's briefs carry what the task needed, and the task's run again carries what changed", () => {
  const need = { what: 'Run shell commands on the Mac.', why: 'Copying a file to the VM needs a command; Finder has no way.' };
  const brief = improveBrief(need, { title: 'Send the video to the VM', brief: 'Send ~/Desktop/x.mp4 to the VM.', report: 'Opened Finder; no way.' });
  assert.match(brief, /Run shell commands on the Mac/);
  assert.match(brief, /Finder has no way/);
  assert.match(brief, /The task: Send the video to the VM/);
  assert.match(brief, /don't do the task; change Hive/);
  assert.doesNotMatch(improveBrief(need), /The task:/);
  const asked = askedBrief({ what: 'Show stuck requests', why: 'make it show stuck ones' }, { brief: 'Find where the board lists requests.' });
  assert.match(asked, /^Change Hive as asked: Show stuck requests\n\nIn the asker's words: make it show stuck ones\n\nThe task's brief:\nFind where/);
  assert.match(SELF_GUIDE, /Never commit, push/);
  assert.match(SELF_GUIDE, /repository is public/);
  assert.match(fixBrief('✖ mac-mcp shell\nexpected 1'), /didn't pass Hive's tests[\s\S]*expected 1/);
  const again = againBrief('Send the video.', need, 'abc on main');
  assert.match(again, /^Send the video\./);
  assert.match(again, /couldn't run shell commands on the Mac:\nabc on main/);
  assert.match(again, /Carry on from where the last run stopped/);
  assert.ok(MOST_ROUNDS >= 1 && MOST_FIXES >= 1);
});

test("a failed test run's output comes down to what failed", () => {
  const output = ['▶ mac', '  ✔ lists tools (1ms)', '  ✖ runs a command (3ms)', '    AssertionError: expected 0', '    actual: 1', 'ℹ pass 1'].join('\n');
  assert.equal(failuresOf(output), ['  ✖ runs a command (3ms)', '    AssertionError: expected 0', '    actual: 1'].join('\n'));
  assert.equal(failuresOf('just text'), 'just text', 'nothing recognisable: all of it');
});

test('what landed, in one line', () => {
  assert.equal(landedLine({ commit: '0123456789abcdef', files: ['a.mjs'], live: ['the VM'] }), '0123456789 on main (1 file: a.mjs); live on the VM');
  assert.equal(landedLine({ commit: 'ffffffffffff', files: ['1', '2', '3', '4', '5', '6', '7'], live: [] }),
    'ffffffffff on main (7 files: 1, 2, 3, 4, 5, 6, …)');
});

/** A Mac whose hive_self job answers `states` in turn, one per status asked; `drop` statuses go unanswered first. */
function fakeMac(states, { drop = 0 } = {}) {
  const calls = [];
  const said = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const call = async (name, args) => {
    calls.push({ name, args });
    if (args.action !== 'status') return said({ job: 'check-1-2', state: 'running' });
    if (drop-- > 0) return { content: [{ type: 'text', text: "Failed: the Mac didn't answer." }], isError: true };
    return said({ id: 'check-1-2', ...states.shift() });
  };
  return { call, calls };
}

test("a job on the Mac is followed to its end, through a restart that leaves a status unanswered", async () => {
  const { call, calls } = fakeMac([{ state: 'running' }, { state: 'failed', failures: 'cargo check: error[E0425]' }], { drop: 1 });
  const seen = [];
  const job = await onTheMac(call, { action: 'check', branch: 'hive/improve-r1-1-1' }, { sleep: async () => {}, onState: j => seen.push(j.state) });
  assert.equal(job.state, 'failed');
  assert.deepEqual(calls[0], { name: 'hive_self', args: { action: 'check', branch: 'hive/improve-r1-1-1' } });
  assert.deepEqual(calls.slice(1).map(c => c.args), Array(3).fill({ action: 'status', job: 'check-1-2' }));
  assert.deepEqual(seen, ['running', 'failed']);
  assert.match(macFailures(job), /^On the owner's Mac \(macOS\).*error\[E0425\]/);
});

test("a job on the Mac that runs past its time comes back as timed out; one the Mac is too busy for waits its turn, then throws", async () => {
  let t = 0;
  const { call } = fakeMac(Array(50).fill({ state: 'waiting' }));
  const job = await onTheMac(call, { action: 'install', commit: 'a'.repeat(40) }, { wait: 10, every: 1, sleep: async () => { t += 4; }, now: () => t });
  assert.equal(job.timedOut, true);
  assert.equal(job.state, 'waiting');
  const busy = async () => ({ content: [{ type: 'text', text: 'Failed: this Mac is still on job check-9-9' }], isError: true });
  let u = 0;
  await assert.rejects(onTheMac(busy, { action: 'check', branch: 'hive/improve-x' }, { wait: 10, every: 1, sleep: async () => { u += 4; }, now: () => u }), /still on job check-9-9/);
  const refused = async () => ({ content: [{ type: 'text', text: 'Failed: check takes the branch' }], isError: true });
  await assert.rejects(onTheMac(refused, { action: 'check', branch: 'x' }, { sleep: async () => assert.fail('a refusal is not waited on') }), /check takes the branch/);
  // Busy twice, then the Mac takes it and it runs to its end.
  const { call: free, calls } = fakeMac([{ state: 'passed' }]);
  let tries = 0;
  const queued = async (name, args) => (args.action !== 'status' && tries++ < 2 ? busy() : free(name, args));
  const job2 = await onTheMac(queued, { action: 'check', branch: 'hive/improve-y' }, { sleep: async () => {} });
  assert.equal(job2.state, 'passed');
  assert.equal(tries, 3);
  assert.equal(calls.length, 2, 'started once, then one status');
});

test("after an install, the Mac counts as running the change only once Hive there answers as that version", async () => {
  assert.equal(await macRunning(async () => { throw new Error('not asked'); }, { id: 'i', version: '1.2', running: '1.2' }), true);
  assert.equal(await macRunning(async () => { throw new Error('not asked'); }, { id: 'i' }), false, 'no version: nothing went in');
  const answers = [{ isError: true, content: [{ type: 'text', text: 'Failed: restarting' }] },
    { content: [{ type: 'text', text: JSON.stringify({ running: '1.1' }) }] },
    { content: [{ type: 'text', text: JSON.stringify({ running: '1.2' }) }] }];
  assert.equal(await macRunning(async () => answers.shift(), { id: 'i', version: '1.2', running: '1.1' }, { sleep: async () => {} }), true);
  let t = 0;
  const never = async () => ({ content: [{ type: 'text', text: JSON.stringify({ running: '1.1' }) }] });
  assert.equal(await macRunning(never, { id: 'i', version: '1.2', running: '1.1' }, { wait: 10, every: 1, sleep: async () => { t += 3; }, now: () => t }), false);
});

test('a change waits to land only for agents that leased its files before it did, so two never wait on each other', () => {
  const leases = [
    { agent: 'R1-1', path: 'cloud/tasks/worker.js', exclusive: true, held_for: 600, note: 'stuck requests' },
    { agent: 'R2-1', path: 'cloud/tasks/worker.js', exclusive: true, held_for: 300 },
    { agent: 'R2-1', path: 'dashboard/', exclusive: true, held_for: 100 },
    { agent: 'R3-1', path: 'README.md', exclusive: false, held_for: 900 },
  ];
  assert.deepEqual(blockers(leases, 'R2-1').map(l => l.agent), ['R1-1'], 'R1-1 was first; a shared lease blocks nobody');
  assert.deepEqual(blockers(leases, 'R1-1'), [], 'the first goes first');
  assert.deepEqual(blockers(leases, 'R9-1').map(l => l.agent), ['R1-1', 'R2-1', 'R2-1'], 'one with no lease of its own waits for every holder');
  const tie = [{ agent: 'R5-1', exclusive: true, held_for: 10 }, { agent: 'R4-1', exclusive: true, held_for: 10 }];
  assert.deepEqual(blockers(tie, 'R5-1').map(l => l.agent), ['R4-1']);
  assert.deepEqual(blockers(tie, 'R4-1'), []);
  assert.equal(othersHold(leases, 'R2-1'), "Other agents are changing these files of Hive's now; leave them alone unless your change needs them (if it does, say so in your report):\n"
    + '- cloud/tasks/worker.js: R1-1 (stuck requests)\n- README.md: R3-1');
  assert.equal(othersHold([], 'R2-1'), '');
});
