import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MOST_FIXES, MOST_ROUNDS, againBrief, failuresOf, fixBrief, gateTests, improveBrief, landedLine, partsOf, readNeed, SELF_GUIDE,
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
  assert.deepEqual(partsOf(['cloud/vm-agent/mac-mcp.mjs']), { vm: true, board: false, mac: false, cloudTests: false });
  assert.deepEqual(partsOf(['cloud/tasks/mac.js', 'cloud/knowledge/migrations/0030_x.sql']), { vm: false, board: true, mac: false, cloudTests: true });
  assert.equal(partsOf(['desktop/app/crates/hive/hive-app/src/cloud_brain.rs']).mac, true);
  assert.equal(partsOf(['dashboard/src/routes/+page.svelte']).mac, true);
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
