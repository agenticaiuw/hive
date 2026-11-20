// The VM keeping itself on the newest release (updater.mjs), against a fake board and a real app
// folder in a temp dir: it puts a checked release in when nothing runs, keeps the app's own files,
// refuses a release whose bytes or tests are wrong (once), waits while a task runs, and goes back to
// the old app when the orchestrator doesn't stay up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, inFlight, needsRestart, orchestratorHealthy, releaseSource, update, workerFiles } from './updater.mjs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { appVersion, bundleVersion, nodeHeaders, pack, unpack, PROTOCOL } from './version.mjs';
import { pathToFileURL } from 'node:url';

const file = (path, text, mode = 0o644) => ({ path, mode, data: Buffer.from(text) });
const RELEASE = [
  file('orchestrator.mjs', "import './devices.mjs';\n// new orchestrator\n"),
  file('devices.mjs', '// devices\n'),
  file('server.mjs', "import { x } from './agent.mjs';\n"),
  file('agent.mjs', 'export const x = 2;\n'),
  file('hive-update.timer', '[Timer]\n'),
  file('screen/vm-shot', '#!/bin/sh\n', 0o755),
];

function setup({ release = RELEASE, notes = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hive-updater-'));
  const appDir = join(root, 'app');
  const stateDir = join(root, 'state');
  mkdirSync(appDir);
  writeFileSync(join(appDir, 'orchestrator.mjs'), '// old orchestrator\n');
  writeFileSync(join(appDir, 'server.mjs'), "import { x } from './agent.mjs';\n");
  writeFileSync(join(appDir, 'agent.mjs'), 'export const x = 1;\n');
  writeFileSync(join(appDir, 'hive-cred.mjs'), '// only on this VM\n');
  writeFileSync(join(appDir, 'orchestrator.mjs.prev'), '// a hand deploy backup\n');
  writeFileSync(join(appDir, 'agent.mjs.before-tabs'), '// another\n');
  const packed = pack('vm', release);
  const calls = [];
  const reports = [];
  let bytes = packed.bytes;
  const board = async (path, body, { raw } = {}) => {
    calls.push(path);
    if (path === '/v1/releases/latest?kind=vm') return { release: { kind: 'vm', version: packed.version, sha256: packed.sha256, protocol: 1, notes } };
    if (path.startsWith('/v1/releases/get?kind=vm&version=')) { assert.equal(raw, true); return bytes; }
    if (path === '/v1/nodes/report') { reports.push(body); return { ok: true }; }
    throw new Error(`unexpected ${path}`);
  };
  const did = { restarts: [], units: 0, checks: 0 };
  const deps = {
    appDir, stateDir, board, machine: 'badger-vm',
    busy: () => [],
    check: async () => { did.checks += 1; return { ok: true }; },
    units: () => { did.units += 1; return []; },
    restart: r => did.restarts.push(r),
    healthy: async () => true,
  };
  return { root, appDir, stateDir, deps, packed, calls, reports, did, tamper: b => { bytes = b; } };
}

const read = (dir, name) => readFileSync(join(dir, name), 'utf8');

test("a release's version is its files: the same code is the same version, and a changed byte isn't", () => {
  assert.equal(bundleVersion(RELEASE), bundleVersion([...RELEASE].reverse()));
  assert.notEqual(bundleVersion(RELEASE), bundleVersion([...RELEASE.slice(1), file('orchestrator.mjs', '// other\n')]));
  const { bytes, version, sha256 } = pack('vm', RELEASE);
  const back = unpack(bytes, { sha: sha256, kind: 'vm' });
  assert.equal(back.version, version);
  assert.deepEqual(back.files.map(f => [f.path, f.mode, f.data.toString()]), RELEASE.map(f => [f.path, f.mode, f.data.toString()]));
  assert.throws(() => unpack(bytes, { sha: '0'.repeat(64) }), /don't match its sha256/);
  assert.throws(() => unpack(bytes, { kind: 'mac' }), /that's a vm release, not mac/);
  assert.throws(() => pack('vm', [file('../etc/passwd', 'x')]), /can't hold/);
  // A Mac release carries its sources' version and its processor; its files are still checked.
  const mac = pack('mac', RELEASE, { version: 'abcdef123456', arch: 'arm64' });
  const macBack = unpack(mac.bytes, { sha: mac.sha256, kind: 'mac' });
  assert.equal(macBack.version, 'abcdef123456');
  assert.equal(macBack.arch, 'arm64');
  assert.equal(mac.version, 'abcdef123456');
  const body = JSON.parse(gunzipSync(mac.bytes));
  body.files[0].data = Buffer.from('tampered').toString('base64');
  assert.throws(() => unpack(gzipSync(Buffer.from(JSON.stringify(body)))), /don't match its version/);
  assert.throws(() => pack('vm', [file('a/./b', 'x')]), /can't hold/);
  const headers = nodeHeaders('badger-vm', version);
  assert.deepEqual(headers, { 'x-hive-node': 'vm:badger-vm', 'x-hive-version': version, 'x-hive-protocol': String(PROTOCOL) });
});

test("the newest release goes in when nothing runs: checked, the app's own files kept, its leftovers not, the worker restarted only for its code", async () => {
  const { root, appDir, deps, packed, reports, did } = setup({ notes: 'Knowledge route' });
  assert.equal(appVersion(pathToFileURL(`${appDir}/`)), 'unversioned');
  const result = await update(deps);
  assert.equal(result.outcome, 'updated');
  assert.equal(read(appDir, 'VERSION').trim(), packed.version);
  assert.equal(appVersion(pathToFileURL(`${appDir}/`)), packed.version);
  assert.match(read(appDir, 'orchestrator.mjs'), /new orchestrator/);
  assert.equal(read(appDir, 'hive-cred.mjs'), '// only on this VM\n', "the VM's own files come along");
  assert.equal(existsSync(join(appDir, 'orchestrator.mjs.prev')), false, 'hand-deploy leftovers stay behind');
  assert.equal(existsSync(join(appDir, 'agent.mjs.before-tabs')), false);
  assert.match(read(join(root, 'app.prev'), 'orchestrator.mjs'), /old orchestrator/, 'the old app is kept beside it');
  assert.equal(did.checks, 1);
  assert.deepEqual(did.restarts, [{ worker: true }], 'agent.mjs changed, and the worker imports it');
  assert.deepEqual(result.changed, ['agent.mjs', 'devices.mjs', 'hive-update.timer', 'orchestrator.mjs', 'screen/vm-shot']);
  assert.deepEqual(reports, [{ kind: 'vm', name: 'badger-vm', version: packed.version,
    note: `Updated from unversioned to ${packed.version}; release notes: Knowledge route.` }]);
  assert.equal((await update(deps)).outcome, 'current');
});

test('a release whose bytes or tests are wrong is refused once, with why; a newer one is tried', async () => {
  const s = setup();
  s.tamper(Buffer.from('not the release'));
  const first = await update(s.deps);
  assert.equal(first.outcome, 'refused');
  assert.match(s.reports[0].note, /^Didn't update to [0-9a-f]{12}: the release's bytes don't match its sha256$/);
  assert.match(read(s.appDir, 'orchestrator.mjs'), /old orchestrator/, 'the app is untouched');
  assert.equal((await update(s.deps)).outcome, 'skipped', 'not tried again every two minutes');
  assert.equal(s.reports.length, 1);

  const newer = setup();
  mkdirSync(newer.stateDir, { recursive: true });
  writeFileSync(join(newer.stateDir, 'update.json'), JSON.stringify({ failed: { version: '0123456789ab', why: 'an older one failed' } }));
  assert.equal((await update(newer.deps)).outcome, 'updated', 'a release other than the one that failed goes in');

  const t = setup();
  t.deps.check = async () => ({ ok: false, why: 'a test failed (✖ the orchestrator plans)' });
  assert.equal((await update(t.deps)).outcome, 'refused');
  assert.match(t.reports[0].note, /a test failed \(✖ the orchestrator plans\)/);
  assert.equal(existsSync(join(t.appDir + '.next')), false);
  assert.deepEqual(t.did.restarts, []);
});

test('while a task runs it waits, says so once, and puts the checked copy in later without checking again', async () => {
  const { appDir, deps, reports, did, packed } = setup();
  let running = ['node /home/ubuntu/hive-vm-agent/app/hive-task.mjs R31-1'];
  deps.busy = () => running;
  assert.equal((await update(deps)).outcome, 'waiting');
  assert.equal((await update(deps)).outcome, 'waiting');
  assert.equal(reports.length, 1);
  assert.match(reports[0].note, /^Waiting to update to [0-9a-f]{12} until nothing runs \(now: node .*hive-task\.mjs R31-1\)\.$/);
  assert.match(read(appDir, 'orchestrator.mjs'), /old orchestrator/);
  running = [];
  assert.equal((await update(deps)).outcome, 'updated');
  assert.equal(did.checks, 1, 'checked once');
  assert.equal(read(appDir, 'VERSION').trim(), packed.version);
  assert.equal(existsSync(join(appDir, '.release')), false);
});

test("when the orchestrator doesn't stay up on it, the old app goes back and that release isn't tried again", async () => {
  const { root, appDir, deps, reports, did } = setup();
  deps.healthy = async () => false;
  const result = await update(deps);
  assert.equal(result.outcome, 'rolled-back');
  assert.match(read(appDir, 'orchestrator.mjs'), /old orchestrator/);
  assert.match(read(join(root, 'app.failed'), 'orchestrator.mjs'), /new orchestrator/);
  assert.deepEqual(did.restarts, [{ worker: true }, { worker: false }]);
  assert.match(reports[0].note, /but the orchestrator didn't stay up on it, so the VM is back on unversioned\./);
  assert.equal((await update(deps)).outcome, 'skipped');
});

test("the worker's code is server.mjs and what it imports; changed files are compared byte for byte", () => {
  const { root, appDir } = setup();
  assert.deepEqual([...workerFiles(appDir)].sort(), ['agent.mjs', 'server.mjs', 'viewer.html']);
  const next = join(root, 'next');
  mkdirSync(next);
  writeFileSync(join(next, 'server.mjs'), read(appDir, 'server.mjs'));
  writeFileSync(join(next, 'agent.mjs'), 'export const x = 3;\n');
  writeFileSync(join(next, 'VERSION'), 'abc\n');
  assert.deepEqual(changedFiles(appDir, next), ['agent.mjs']);
});

test("the orchestrator is healthy when it stays active with no restarts, read the way systemctl prints it", async () => {
  const healthy = answers => { let n = 0; return orchestratorHealthy({ wait: async () => {}, show: () => answers[n++] }); };
  assert.equal(await healthy(['NRestarts=0\nActiveState=active\n', 'NRestarts=0\nActiveState=active\n']), true);
  assert.equal(await healthy(['NRestarts=0\nActiveState=active\n', 'NRestarts=1\nActiveState=active\n']), false, 'it restarted in between');
  assert.equal(await healthy(['NRestarts=2\nActiveState=activating\n', 'NRestarts=2\nActiveState=activating\n']), false);
  assert.equal(await healthy(['', '']), false);
});

test('a release that changes only what each task starts goes in at once, mid-task, with no restart', async () => {
  const release = [file('orchestrator.mjs', '// old orchestrator\n'), file('server.mjs', "import { x } from './agent.mjs';\n"),
    file('agent.mjs', 'export const x = 1;\n'), file('hive-task.mjs', '// a new tool for the task\n'), file('mac-mcp.mjs', '// new\n')];
  const { appDir, stateDir, deps, reports, did, packed } = setup({ release });
  deps.busy = () => ['node /home/ubuntu/hive-vm-agent/app/hive-task.mjs R31-1'];
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'requests.json'), JSON.stringify({ ids: [31], at: Date.now() }));
  const result = await update(deps);
  assert.equal(result.outcome, 'updated');
  assert.equal(result.restarted, false);
  assert.deepEqual(result.changed, ['hive-task.mjs', 'mac-mcp.mjs']);
  assert.deepEqual(did.restarts, [], 'nothing restarted');
  assert.equal(did.units, 0);
  assert.equal(read(appDir, 'hive-task.mjs'), '// a new tool for the task\n');
  assert.equal(read(appDir, 'VERSION').trim(), packed.version);
  assert.match(reports[0].note, /with no restart/);
});

test("a request in flight holds back a release that restarts the orchestrator, even between tasks; a stale note doesn't", async () => {
  const { appDir, stateDir, deps } = setup();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'requests.json'), JSON.stringify({ ids: [40, 41], at: Date.now() }));
  const waiting = await update(deps);
  assert.equal(waiting.outcome, 'waiting');
  assert.deepEqual(waiting.running, ['request R40', 'request R41']);
  assert.match(read(appDir, 'orchestrator.mjs'), /old orchestrator/);
  assert.deepEqual(inFlight(stateDir, Date.now() + 7 * 3600_000), [], 'six hours on, the note is from an orchestrator that is gone');
  writeFileSync(join(stateDir, 'requests.json'), JSON.stringify({ ids: [], at: Date.now() }));
  assert.equal((await update(deps)).outcome, 'updated');
});

test('what needs a restart: the orchestrator and what it imports, old or new; the worker; units', () => {
  const { root, appDir } = setup();
  const next = join(root, 'n');
  mkdirSync(next);
  writeFileSync(join(next, 'orchestrator.mjs'), "import { a } from './plan.mjs';\nimport './devices.mjs';\n");
  writeFileSync(join(next, 'plan.mjs'), '');
  writeFileSync(join(next, 'devices.mjs'), '');
  assert.equal(needsRestart(appDir, next, ['plan.mjs']), true, 'a script the new orchestrator imports');
  assert.equal(needsRestart(appDir, next, ['devices.mjs']), true);
  assert.equal(needsRestart(appDir, next, ['agent.mjs']), true, "the worker's");
  assert.equal(needsRestart(appDir, next, ['hive-update.timer']), true);
  assert.equal(needsRestart(appDir, next, ['hive-task.mjs', 'desktop-mcp.mjs', 'updater.mjs']), false);
});

test("a club member's VM takes the club's releases with the member's key; anyone else's, its own board's", () => {
  const key = `club.alice.${'a'.repeat(64)}`;
  assert.deepEqual(releaseSource({ url: 'https://own.example/', token: 'own', machine: 'alice-vm', releases: { url: 'https://club.example//', token: key } }),
    { url: 'https://club.example', token: key, machine: 'alice-vm' });
  assert.deepEqual(releaseSource({ url: 'https://own.example/', token: 'own' }), { url: 'https://own.example', token: 'own', machine: 'vm' });
  // Half a club source is no source: the VM stays on its own board.
  assert.deepEqual(releaseSource({ url: 'https://own.example', token: 'own', releases: { url: 'https://club.example' } }),
    { url: 'https://own.example', token: 'own', machine: 'vm' });
  assert.throws(() => releaseSource({ token: 'own' }), /no url or token/);
});
