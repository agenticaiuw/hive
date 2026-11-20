#!/usr/bin/env node
// Keeps this VM on the newest release of its code (owner, 2026-11-18: "No version check or automatic
// updates between nodes. A node on old code finds out only when a route answers differently.").
// hive-update.timer runs it every two minutes:
//
//  1. Asks the board for the newest VM release (cloud/tasks/nodes.js). Nothing to do when this app
//     runs it, or when it's the one that already failed here (a newer release is tried at once).
//  2. Downloads it, checks its sha256 and version, and unpacks it beside the app (app.next), with the
//     app's own files the release doesn't have carried over.
//  3. Checks it: node --check on every script, then its tests, within a time limit.
//  4. Waits until no task, plan or Codex runs on this VM, then swaps it in (app → app.prev,
//     app.next → app), installs any of its systemd units that changed, and restarts the orchestrator,
//     and the posting worker when the worker's code changed and it runs under hive-vm-worker.service.
//  5. If the orchestrator doesn't stay up, puts the old app back and restarts it.
//
// Every outcome that matters goes to the board (/v1/nodes/report) for the dashboard. It imports only
// version.mjs, so a release that breaks the orchestrator can't stop the next one from coming in.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appVersion, nodeHeaders, unpack } from './version.mjs';

const ROOT = process.env.HIVE_VM_HOME ?? '/home/ubuntu/hive-vm-agent';
// The units a release may change; the screen's (screen/) are put in by hand, since restarting the
// screen share would cut off the owner if they're watching.
export const UNITS = ['hive-orchestrator.service', 'hive-update.service', 'hive-update.timer', 'hive-vm-worker.service'];
// Left behind in the app by hand deploys; never carried into a new app.
const LEFTOVER = /(\.prev|\.failed|\.tmp)$|\.before-|^\._|^VERSION$/;
const TEST_MS = 4 * 60_000;

/** One look: brings this VM up to the newest release if it can now. What came of it, in words. */
export async function update({
  appDir = join(ROOT, 'app'),
  stateDir = process.env.HIVE_VM_STATE ?? join(ROOT, 'state'),
  board,
  machine = 'vm',
  busy = whatRuns,
  check = checkRelease,
  units = installUnits,
  restart = restartServices,
  healthy = orchestratorHealthy,
  log = () => {},
} = {}) {
  const current = appVersion(pathToFileURL(`${appDir}/`));
  const { release } = await board('/v1/releases/latest?kind=vm');
  if (!release) return { outcome: 'none', current };
  if (release.version === current) return { outcome: 'current', current };
  const statePath = join(stateDir, 'update.json');
  const state = readJson(statePath);
  if (state.failed?.version === release.version) return { outcome: 'skipped', current, why: state.failed.why };
  const report = async (note, version) => {
    log(note);
    await board('/v1/nodes/report', { kind: 'vm', name: machine, note, ...(version ? { version } : {}) }).catch(error => log(`couldn't tell the board: ${error.message}`));
  };
  const refuse = async why => {
    writeJson(statePath, { ...state, failed: { version: release.version, why, at: Date.now() } });
    rmSync(nextDir(appDir), { recursive: true, force: true });
    await report(`Didn't update to ${release.version}: ${why}`);
    return { outcome: 'refused', current, why };
  };

  // 2-3. Downloaded, unpacked and checked once; a VM that's busy keeps the checked copy for later.
  const next = nextDir(appDir);
  if (readText(join(next, '.release')) !== release.version) {
    let unpacked;
    try {
      unpacked = unpack(await board(`/v1/releases/get?kind=vm&version=${encodeURIComponent(release.version)}`, undefined, { raw: true }),
        { sha: release.sha256, kind: 'vm' });
    } catch (error) {
      return refuse(error.message);
    }
    if (unpacked.version !== release.version) return refuse(`the board's ${release.version} holds ${unpacked.version}`);
    lay(next, unpacked.files, appDir);
    const checked = await check(next);
    if (!checked.ok) return refuse(checked.why);
    writeFileSync(join(next, '.release'), release.version);
  }

  // 4. A restart of the orchestrator ends what it started, so a release that changes its code (or the
  // posting worker's, or a unit) goes in only when nothing runs and no request is in flight. One that
  // changes only what each task starts afresh (hive-task.mjs, the tool servers) goes in now, with no
  // restart: the next task runs it, which is how a change Hive makes to itself reaches the task that asked.
  const changed = changedFiles(appDir, next);
  const restarting = needsRestart(appDir, next, changed);
  const running = restarting ? [...busy(), ...inFlight(stateDir)] : [];
  if (running.length) {
    if (state.waiting !== release.version) {
      writeJson(statePath, { ...state, waiting: release.version });
      await report(`Waiting to update to ${release.version} until nothing runs (now: ${running.slice(0, 2).join('; ')}).`);
    }
    return { outcome: 'waiting', current, running };
  }
  rmSync(join(next, '.release'), { force: true });
  writeFileSync(join(next, 'VERSION'), `${release.version}\n`);
  const previous = prevDir(appDir);
  rmSync(previous, { recursive: true, force: true });
  renameSync(appDir, previous);
  renameSync(next, appDir);
  if (!restarting) {
    writeJson(statePath, {});
    const notes = release.notes ? `; release notes: ${release.notes}` : '';
    await report(`Updated from ${current} to ${release.version} with no restart (only what each task starts changed)${notes}.`, release.version);
    return { outcome: 'updated', current: release.version, from: current, changed, restarted: false };
  }
  const installed = units(appDir, changed);
  restart({ worker: changed.some(f => workerFiles(appDir).has(f)) });

  // 5. The orchestrator has to stay up on the new code, or the old app goes back.
  if (!(await healthy())) {
    rmSync(failedDir(appDir), { recursive: true, force: true });
    renameSync(appDir, failedDir(appDir));
    renameSync(previous, appDir);
    units(appDir, changed);
    restart({ worker: false });
    writeJson(statePath, { failed: { version: release.version, why: "the orchestrator didn't stay up", at: Date.now() } });
    await report(`Put in ${release.version}, but the orchestrator didn't stay up on it, so the VM is back on ${current}.`, current);
    return { outcome: 'rolled-back', current };
  }
  writeJson(statePath, {});
  const notes = [installed.length ? `its units changed (${installed.join(', ')})` : '', release.notes ? `release notes: ${release.notes}` : ''].filter(Boolean);
  await report(`Updated from ${current} to ${release.version}${notes.length ? `; ${notes.join('; ')}` : ''}.`, release.version);
  return { outcome: 'updated', current: release.version, from: current, changed };
}

export const nextDir = app => `${app}.next`;
export const prevDir = app => `${app}.prev`;
export const failedDir = app => `${app}.failed`;

/** Writes the release into `dir`, with the old app's own top-level files the release doesn't have. */
export function lay(dir, files, appDir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const named = new Set(files.map(f => f.path.split('/')[0]));
  for (const f of files) {
    const at = join(dir, f.path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, f.data, { mode: f.mode });
  }
  if (!existsSync(appDir)) return;
  for (const name of readdirSync(appDir)) {
    if (named.has(name) || LEFTOVER.test(name)) continue;
    const from = join(appDir, name);
    if (statSync(from).isFile()) writeFileSync(join(dir, name), readFileSync(from), { mode: statSync(from).mode & 0o777 });
  }
}

/** The release's files whose bytes differ from the running app's (new files included). */
export function changedFiles(appDir, next) {
  const out = [];
  const walk = rel => {
    for (const name of readdirSync(join(next, rel))) {
      if (!rel && (name === '.release' || name === 'VERSION')) continue;
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(join(next, path)).isDirectory()) { walk(path); continue; }
      const old = join(appDir, path);
      if (!existsSync(old) || !readFileSync(old).equals(readFileSync(join(next, path)))) out.push(path);
    }
  };
  walk('');
  return out.sort();
}

/** `start` and every script it imports (./name.mjs), in `appDir`. */
function importsOf(appDir, start) {
  const seen = new Set();
  const visit = name => {
    if (seen.has(name) || !existsSync(join(appDir, name))) return;
    seen.add(name);
    for (const [, dep] of readFileSync(join(appDir, name), 'utf8').matchAll(/(?:from|import)\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) visit(dep);
  };
  visit(start);
  return seen;
}

/** server.mjs and every script it imports: the posting worker's code. */
export function workerFiles(appDir) {
  const seen = importsOf(appDir, 'server.mjs');
  if (seen.size) seen.add('viewer.html');
  return seen;
}

/** orchestrator.mjs and every script it imports: what a running orchestrator holds. */
export const orchestratorFiles = appDir => importsOf(appDir, 'orchestrator.mjs');

/** Whether putting `changed` in needs a restart: the orchestrator's or the worker's code, old or new, or a unit. */
export function needsRestart(appDir, next, changed) {
  const held = new Set([...orchestratorFiles(appDir), ...orchestratorFiles(next), ...workerFiles(appDir), ...workerFiles(next), ...UNITS]);
  return changed.some(f => held.has(f));
}

/** The requests the orchestrator is working on (state/requests.json, which it keeps), in words; a file
 *  older than six hours is from an orchestrator that's gone. */
export function inFlight(stateDir, now = Date.now()) {
  const state = readJson(join(stateDir, 'requests.json'));
  if (!Array.isArray(state.ids) || !(now - Number(state.at) < 6 * 3600_000)) return [];
  return state.ids.map(id => `request R${id}`);
}

/** Tasks, plans and Codex runs on this VM right now, in words; empty when it's idle. */
export function whatRuns() {
  const r = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
  return (r.stdout || '').split('\n')
    .filter(l => /hive-task\.mjs|bin\/codex exec/.test(l) && !/^tmux/.test(l))
    .map(l => l.slice(0, 80));
}

/** Every script parses and the release's own tests pass. */
export async function checkRelease(dir) {
  const scripts = readdirSync(dir).filter(f => f.endsWith('.mjs'));
  for (const f of scripts) {
    const r = spawnSync(process.execPath, ['--check', f], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, why: `${f} doesn't parse: ${(r.stderr || '').trim().split('\n').slice(0, 3).join(' ')}` };
  }
  const tests = scripts.filter(f => f.endsWith('.test.mjs'));
  if (!tests.length) return { ok: true };
  // Away from this VM's own state and keys: a test never reaches the running orchestrator's sockets.
  const home = mkdtempSync(join(tmpdir(), 'hive-update-check-'));
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...tests], {
    cwd: dir, encoding: 'utf8', timeout: TEST_MS, env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', HIVE_UPDATE_CHECK: '1' },
  });
  rmSync(home, { recursive: true, force: true });
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, why: `its tests took longer than ${TEST_MS / 60_000} minutes` };
  if (r.status !== 0) {
    const failing = `${r.stdout}\n${r.stderr}`.split('\n').filter(l => /^✖|not ok|Error/.test(l.trim())).slice(0, 3).map(l => l.trim());
    return { ok: false, why: `a test failed (${failing.join('; ') || `exit ${r.status}`})` };
  }
  return { ok: true };
}

const sudo = (...args) => spawnSync('sudo', ['-n', ...args], { encoding: 'utf8' });

/** Installs the release's units that differ from what systemd has; their names. */
export function installUnits(appDir) {
  const installed = [];
  for (const unit of UNITS) {
    const from = join(appDir, unit);
    if (!existsSync(from)) continue;
    const to = `/etc/systemd/system/${unit}`;
    if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
    if (sudo('install', '-m', '644', from, to).status === 0) installed.push(unit);
  }
  if (installed.length) sudo('systemctl', 'daemon-reload');
  return installed;
}

export function restartServices({ worker }) {
  sudo('systemctl', 'restart', 'hive-orchestrator');
  if (worker && sudo('systemctl', 'is-active', '--quiet', 'hive-vm-worker').status === 0) sudo('systemctl', 'restart', 'hive-vm-worker');
}

/** The orchestrator is up and stays up (no restarts) for a quarter of a minute. */
// systemctl prints the properties in its own order (NRestarts before ActiveState), so they're read by name.
export async function orchestratorHealthy({
  wait = ms => new Promise(r => setTimeout(r, ms)),
  show = () => spawnSync('systemctl', ['show', 'hive-orchestrator', '-p', 'ActiveState', '-p', 'NRestarts'], { encoding: 'utf8' }).stdout || '',
} = {}) {
  const state = () => Object.fromEntries(show().trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  await wait(8000);
  const first = state();
  await wait(7000);
  const then = state();
  return first.ActiveState === 'active' && then.ActiveState === 'active' && first.NRestarts === then.NRestarts;
}

function readText(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

/** The board, as root's hive-tasks config reaches it (never printed); raw answers come back as bytes. */
export function boardFor({ url, token, machine }, version) {
  return async (path, body, { raw = false } = {}) => {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'hive-vm-updater', ...nodeHeaders(machine, version) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (raw && response.ok) return Buffer.from(await response.arrayBuffer());
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `the board said ${response.status}`);
    return value;
  };
}

/** Where this VM takes releases from and says what it runs: the board in its tasks.json, or the club's
 *  board when it names one (`releases: {url, token}`, a club member's VM signed in with the member's club
 *  key, cloud/tasks/club.js), so every member's VM runs the same Hive as the owner's. */
export function releaseSource(c) {
  if (!c?.url || !c?.token) throw new Error('the board config has no url or token');
  const from = c.releases?.url && c.releases?.token ? c.releases : c;
  return { url: String(from.url).replace(/\/+$/, ''), token: from.token, machine: c.machine || 'vm' };
}

function config() {
  const text = process.env.HIVE_TASKS_CONFIG
    ? readFileSync(process.env.HIVE_TASKS_CONFIG, 'utf8')
    : execFileSync('sudo', ['-n', 'cat', '/root/.config/hive/tasks.json'], { encoding: 'utf8' });
  return releaseSource(JSON.parse(text));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const c = config();
  const appDir = join(ROOT, 'app');
  const result = await update({ board: boardFor(c, appVersion(pathToFileURL(`${appDir}/`))), machine: c.machine, appDir, log: line => console.log(line) })
    .catch(error => ({ outcome: 'failed', why: error.message }));
  console.log(JSON.stringify(result));
  process.exit(result.outcome === 'failed' ? 1 : 0);
}
