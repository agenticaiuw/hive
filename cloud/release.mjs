#!/usr/bin/env node
// Publishes a release of one of Hive's nodes to the board (cloud/tasks/nodes.js), from which every
// node of that kind updates itself when it's idle (the VM: cloud/vm-agent/updater.mjs).
//
//   node cloud/release.mjs vm [--from DIR] [--notes TEXT] [--dry-run]
//   node cloud/release.mjs mac [--from DIR] [--notes TEXT] [--dry-run] [--out FILE]
//   node cloud/release.mjs board [--from DIR] [--dry-run]
//   node cloud/release.mjs phone [--from DIR] [--notes TEXT] [--dry-run] [--out FILE]
//
// The code is the repository's last commit (git archive HEAD), so uncommitted work never goes out;
// --from DIR takes a tree laid out like the repository instead (a checked export). `board` applies
// the board's migrations and deploys it with its version, so the dashboard shows what it runs.
// `mac` builds what Hive on a Mac runs from a build (the agent and its tools, the dashboard, the
// browser extension; never source) with its version built in, checks it holds none of this machine's
// owner's details, and publishes it; each Mac's agent puts it in when it's idle (hive-tasks
// update.rs). --out FILE also writes the release's bytes there.
// `phone` builds Hive Phone (mobile/relay/build.mjs), an unsigned IPA the board offers as a SideStore
// source (/v1/phone/source.json); SideStore on each member's iPhone signs it and offers each newer one.
// Its sources unchanged since the newest phone release, nothing is built or published.
// The board's address and key are this machine's hive-tasks config (~/.config/hive/tasks.json),
// never printed.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleVersion, pack, PROTOCOL } from './vm-agent/version.mjs';
import { ownerDetails } from './shared/ownerDetails.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Every file under `dir`, as {path, mode, data}, paths relative to it. */
export function filesUnder(dir) {
  const out = [];
  const walk = at => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (info.isFile() && name !== '.DS_Store') out.push({ path: relative(dir, path), mode: info.mode & 0o111 ? 0o755 : 0o644, data: readFileSync(path) });
    }
  };
  walk(dir);
  return out;
}

/** The repository's last commit, laid out in a temp folder: `paths` only. */
function committed(paths) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-release-'));
  const tar = execFileSync('git', ['-C', REPO, 'archive', 'HEAD', ...paths], { maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return dir;
}

function board() {
  const c = JSON.parse(readFileSync(join(homedir(), '.config', 'hive', 'tasks.json'), 'utf8'));
  if (!c.url || !c.token) throw new Error("this machine's hive-tasks config has no board url or token");
  return { url: String(c.url).replace(/\/+$/, ''), token: c.token, machine: c.machine || 'mac' };
}

async function publish(kind, { bytes, version, sha256 }, notes) {
  const { url, token, machine } = board();
  const query = new URLSearchParams({ kind, version, protocol: String(PROTOCOL), sha256, notes });
  const response = await fetch(`${url}/v1/releases?${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
      'x-hive-node': `cli:${machine}`, 'x-hive-version': 'release', 'x-hive-protocol': String(PROTOCOL) },
    body: bytes,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `the board said ${response.status}`);
  return value.release;
}

async function releaseVm({ from, notes, dryRun }) {
  const root = from ?? committed(['cloud/vm-agent']);
  try {
    const files = filesUnder(join(root, 'cloud', 'vm-agent'));
    const packed = pack('vm', files);
    console.log(`vm ${packed.version}: ${files.length} files, ${(packed.bytes.length / 1024).toFixed(0)} KB${from ? ` from ${from}` : ' from HEAD'}`);
    if (dryRun) return;
    const release = await publish('vm', packed, notes);
    console.log(`published vm ${release.version}; every VM puts it in within a few minutes of being idle`);
  } finally {
    if (!from) rmSync(root, { recursive: true, force: true });
  }
}

// What a Mac release is built from: its version is their hash, so the same sources are always the
// same release, and the agent built from them reports it (hive-tasks node.rs VERSION). hive-cloud
// builds in the cloud setup's worker (deploy.rs).
export const MAC_SOURCES = ['desktop/app/crates/hive', 'desktop/app/tools', 'desktop/app/Makefile', 'dashboard/src', 'dashboard/static',
  'dashboard/package.json', 'dashboard/package-lock.json', 'dashboard/svelte.config.js', 'dashboard/vite.config.ts',
  'browser/chrome/src', 'browser/chrome/package.mjs', 'browser/chrome/package.json', 'cloud/shared', 'cloud/hive-cloud/worker.js'];
// The tools a build makes besides the Rust ones (the Makefile's HIVE_BINS); agent-vhid-helper isn't
// one, since it runs from /Library/PrivilegedHelperTools, put there with the owner's password.
export const MAC_TOOLS = ['agent-vhid-ocr', 'agent-vhid-tap', 'agent-vhid-captions', 'agent-vhid-paste', 'agent-vhid-selection', 'hive-monitor'];
const NOT_SOURCE = new Set(['target', 'node_modules', '.wrangler', 'build', 'build-desktop', '.svelte-kit', '.DS_Store', '__pycache__']);

/** The files under `paths` (folders or files, relative to `root`) a build reads, as {path, mode, data}. */
export function sourceFiles(root, paths) {
  const out = [];
  const visit = rel => {
    const at = join(root, rel);
    let info;
    try { info = lstatSync(at); } catch { return; }
    if (info.isDirectory()) {
      for (const name of readdirSync(at).sort()) if (!NOT_SOURCE.has(name)) visit(`${rel}/${name}`);
    } else if (info.isFile()) {
      out.push({ path: rel, mode: info.mode & 0o111 ? 0o755 : 0o644, data: readFileSync(at) });
    }
  };
  for (const p of paths) visit(p);
  return out;
}

/** The Rust tools the Makefile builds (HIVE_BINS), from the tree's own Makefile. */
export function hiveBins(makefile) {
  const m = /^HIVE_BINS :=((?:[^\n]*\\\n)*[^\n]*)/m.exec(makefile);
  if (!m) throw new Error("the Makefile has no HIVE_BINS");
  return m[1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
}

async function releaseMac({ from, notes, dryRun, out }) {
  if (platform() !== 'darwin') throw new Error('a Mac release is built on a Mac');
  const root = from ? resolve(from) : committed(['desktop/app', 'dashboard', 'browser/chrome', 'cloud/shared', 'cloud/hive-cloud/worker.js', 'branding']);
  if (from && resolve(from) === resolve(REPO)) throw new Error('--from takes an export, not the repository itself (its build folder is the running Hive)');
  try {
    const version = bundleVersion(sourceFiles(root, MAC_SOURCES));
    const app = join(root, 'desktop', 'app');
    // The bundlers come from this repository's installs, never fetched for a release.
    for (const dir of ['dashboard', 'browser/chrome']) {
      const have = join(REPO, dir, 'node_modules'), need = join(root, dir, 'node_modules');
      if (!existsSync(need)) {
        if (!existsSync(have)) throw new Error(`${dir} has no node_modules here to build with`);
        symlinkSync(have, need);
      }
    }
    const bins = hiveBins(readFileSync(join(app, 'Makefile'), 'utf8'));
    // Built knowing its version, in its own target folder; the paths built into the binaries name
    // no one's home or this export (--remap-path-prefix). The flags go to cargo one by one
    // (CARGO_ENCODED_RUSTFLAGS), since a path may have a space ("Application Support").
    const flags = [...(process.env.RUSTFLAGS ?? '').split(' ').filter(Boolean), `--remap-path-prefix=${homedir()}=/home`, `--remap-path-prefix=${root}=/hive`];
    const env = { ...process.env, HIVE_VERSION: version, CARGO_TARGET_DIR: join(REPO, 'desktop/app/crates/hive/target/mac-release'),
      CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') };
    delete env.RUSTFLAGS;
    console.log(`mac ${version}: building ${bins.length} Rust tools, ${MAC_TOOLS.length} others, the dashboard and the extension${from ? ` from ${from}` : ' from HEAD'}`);
    const make = spawnSync('make', ['-B', '-s', '-C', app, 'build/.hive-built', ...MAC_TOOLS.map(t => `build/${t}`), 'build/dashboard'], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (make.status !== 0) throw new Error(`the build failed:\n${`${make.stdout}\n${make.stderr}`.trim().split('\n').slice(-15).join('\n')}`);
    const extension = spawnSync('node', ['package.mjs'], { cwd: join(root, 'browser', 'chrome'), encoding: 'utf8' });
    if (extension.status !== 0) throw new Error(`the extension didn't package:\n${`${extension.stdout}\n${extension.stderr}`.trim().split('\n').slice(-10).join('\n')}`);
    const said = spawnSync(join(app, 'build', 'hive-agent'), ['--version'], { encoding: 'utf8' }).stdout?.trim();
    if (said !== version) throw new Error(`the agent built says it's ${JSON.stringify(said)}, not ${version}`);

    const tool = name => ({ path: `desktop/app/build/${name}`, mode: 0o755, data: readFileSync(join(app, 'build', name)) });
    const under = (dir, prefix) => filesUnder(join(root, dir)).map(f => ({ ...f, path: `${prefix}/${f.path}` }));
    const files = [...bins.map(tool), ...MAC_TOOLS.map(tool),
      ...under('desktop/app/build/dashboard', 'desktop/app/build/dashboard'), ...under('browser/chrome/build/chrome', 'browser/chrome/build/chrome')];
    const found = ownerDetails([...bins, ...MAC_TOOLS].map(b => join(app, 'build', b)).concat([join(app, 'build', 'dashboard'), join(root, 'browser/chrome/build/chrome')]));
    if (found.length) {
      for (const { file, what } of found) console.error(`  ${relative(root, file)} holds ${what}`);
      throw new Error("the release holds this machine's owner's details; nothing was published");
    }
    const packed = pack('mac', files, { version, arch: arch() });
    console.log(`mac ${version} (${arch()}): ${files.length} files, ${(packed.bytes.length / 1024 / 1024).toFixed(1)} MB, none of the owner's details`);
    if (out) writeFileSync(out, packed.bytes);
    if (dryRun) return packed;
    const release = await publish('mac', packed, notes);
    console.log(`published mac ${release.version}; every Mac on a release puts it in once Hive is idle`);
    return packed;
  } finally {
    if (!from) rmSync(root, { recursive: true, force: true });
  }
}

// What Hive Phone is built from. Its release is "<UTC year>.<monthday>.<hourminute>-<their hash>": the
// first part is what SideStore shows and compares, so each one is newer than the last, and the hash
// says whether the sources changed.
export const PHONE_SOURCES = ['mobile/relay/WebDriverAgent', 'mobile/relay/build.mjs', 'mobile/relay/icon', 'cloud/shared/ownerDetails.mjs', 'cloud/shared/hiveCloud.mjs'];

export function phoneVersion(hash, at = new Date()) {
  const two = n => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}.${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}.${two(at.getUTCHours())}${two(at.getUTCMinutes())}-${hash}`;
}

async function newestRelease(kind) {
  const { url, token, machine } = board();
  const response = await fetch(`${url}/v1/releases/latest?kind=${kind}`, {
    headers: { authorization: `Bearer ${token}`, 'x-hive-node': `cli:${machine}`, 'x-hive-version': 'release', 'x-hive-protocol': String(PROTOCOL) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `the board said ${response.status}`);
  return value.release;
}

async function releasePhone({ from, notes, dryRun, out }) {
  if (platform() !== 'darwin') throw new Error('Hive Phone is built on a Mac');
  const root = from ? resolve(from) : committed(['mobile/relay', 'cloud/shared']);
  const work = mkdtempSync(join(tmpdir(), 'hive-phone-'));
  try {
    const hash = bundleVersion(sourceFiles(root, PHONE_SOURCES));
    const newest = await newestRelease('phone').catch(error => { if (dryRun) return null; throw error; });
    if (newest?.version?.endsWith(`-${hash}`)) {
      console.log(`phone: ${newest.version} is already these sources; nothing to publish`);
      return null;
    }
    const version = phoneVersion(hash);
    const built = spawnSync(process.execPath, [join(root, 'mobile', 'relay', 'build.mjs'), '--version', version, '--out', work], { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (built.status !== 0) throw new Error(`Hive Phone didn't build:\n${`${built.stdout}\n${built.stderr}`.trim().split('\n').slice(-12).join('\n')}`);
    const bytes = readFileSync(join(work, 'HivePhone.ipa'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    console.log(`phone ${version}: ${(bytes.length / 1024 / 1024).toFixed(1)} MB IPA${from ? ` from ${from}` : ' from HEAD'}, none of the owner's details`);
    if (out) writeFileSync(out, bytes);
    if (dryRun) return { bytes, version, sha256 };
    const release = await publish('phone', { bytes, version, sha256 }, notes);
    console.log(`published phone ${release.version}; SideStore offers it on every member's iPhone`);
    return { bytes, version, sha256 };
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (!from) rmSync(root, { recursive: true, force: true });
  }
}

function releaseBoard({ from, dryRun }) {
  const root = from ?? committed(['cloud/tasks', 'cloud/knowledge/migrations', 'cloud/shared', 'cloud/vm-agent/version.mjs']);
  try {
    const files = ['tasks', 'knowledge/migrations', 'shared'].flatMap(p => filesUnder(join(root, 'cloud', p)).map(f => ({ ...f, path: `${p}/${f.path}` })));
    const version = bundleVersion(files);
    console.log(`board ${version}: ${files.length} files${from ? ` from ${from}` : ' from HEAD'}`);
    if (dryRun) return;
    const config = readFileSync(join(root, 'cloud', 'tasks', 'wrangler.jsonc'), 'utf8');
    const db = /"database_name":\s*"([^"]+)"/.exec(config)?.[1];
    const wrangler = (process.env.WRANGLER ?? 'npx wrangler').split(' ');
    const run = args => {
      const r = spawnSync(wrangler[0], [...wrangler.slice(1), ...args], { cwd: join(root, 'cloud', 'tasks'), encoding: 'utf8' });
      // Wrangler prints the board's address; only its last lines, without it, are shown.
      const said = `${r.stdout}\n${r.stderr}`.replace(/https:\/\/\S+/g, '<board>').split('\n').filter(l => l.trim() && !/WARNING|^\s*[└┌├│]/.test(l)).slice(-3).join('\n');
      if (r.status !== 0) throw new Error(`wrangler ${args[0]} failed:\n${said}`);
      return said;
    };
    if (db) console.log(run(['d1', 'migrations', 'apply', db, '--remote']));
    console.log(run(['deploy', '--var', `HIVE_VERSION:${version}`]));
    console.log(`deployed board ${version}`);
  } finally {
    if (!from) rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, ...rest] = process.argv.slice(2);
  const option = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };
  const opts = { from: option('--from'), notes: option('--notes') ?? '', dryRun: rest.includes('--dry-run'), out: option('--out') };
  const known = { vm: releaseVm, mac: releaseMac, board: releaseBoard, phone: releasePhone };
  if (!known[kind]) {
    console.error('usage: node cloud/release.mjs vm|mac|board|phone [--from DIR] [--notes TEXT] [--dry-run] [--out FILE]');
    process.exit(64);
  }
  try {
    await known[kind](opts);
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exit(1);
  }
}
