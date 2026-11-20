// Puts inside Hive.app what a teammate's Mac needs to set up the same Hive the owner runs, so the
// download alone is enough (owner, 2026-11-18: "it should download the same thing i've setup on my
// own hive system"). tools/release.sh runs it on its copy of the app before signing.
//
//   Contents/Resources/hive/   a Hive folder's files, in the repository's layout:
//     desktop/app/build/...       a Mac release (cloud/release.mjs mac --dry-run --out): the agent,
//                                 its tools and the dashboard Hive's window shows
//     browser/chrome/build/...    the browser extension, from the same release
//     desktop/app/python/         the voice sidecars, and desktop/app/requirements.lock, the owner's
//                                 exact Python and packages for them (tools/lock-voice.py)
//     cloud/knowledge/migrations  the knowledge base's schema
//     first-open.sh               fills the Hive folder in Hive's data folder from all this
//     VERSION                     the release's version and the voice files' hash
//   Contents/Helpers/uv        gets Python and the voice packages on first open
//   Contents/Resources/codex/  the owner's Codex (its native build: bin/codex and what it brings; in
//                              Resources, since Helpers may hold only signed programs and it brings a
//                              codex-package.json it reads next to them)
//
//   node tools/carry.mjs <Hive.app> --release <mac release file> --source <export of the commit>
//                        [--uv <uv>] [--codex <folder of codex's native build>]
//
// --uv defaults to the uv on PATH and --codex to the native build of the codex on PATH. The uv must
// be able to download the Python in requirements.lock.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { bundleVersion, unpack } from '../../../cloud/vm-agent/version.mjs';
import { sourceFiles } from '../../../cloud/release.mjs';

/** The files of the export that go in besides the release, as {path, mode, data}. */
export const VOICE_PARTS = ['desktop/app/python', 'desktop/app/requirements.lock', 'cloud/knowledge/migrations'];

/** The Python version requirements.lock names ("# python: 3.14.7"). */
export function lockedPython(lock) {
  const m = /^# python: (\d+\.\d+\.\d+)$/m.exec(lock);
  if (!m) throw new Error('requirements.lock names no Python version (tools/lock-voice.py writes it)');
  return m[1];
}

/** Whether `uv python list --only-downloads` output offers that CPython for Apple silicon Macs
 * (named "macos" by older uv, "darwin" by newer). */
export function uvOffers(listing, version) {
  return listing.split('\n').some(line => /^cpython-(\S+)-(macos|darwin)-aarch64-none\s/.exec(line)?.[1] === version);
}

/** The folder of the native build behind the `codex` command (npm's @openai/codex-darwin-arm64). */
export function codexNativeFolder(command) {
  const launcher = realpathSync(command);
  const candidates = [
    join(dirname(launcher), '..', 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin'),
    join(dirname(launcher), '..', 'vendor', 'aarch64-apple-darwin'),
    join(dirname(launcher), '..'),
  ];
  const found = candidates.find(dir => existsSync(join(dir, 'bin', 'codex')));
  if (!found) throw new Error(`no native Codex build next to ${launcher}; pass --codex`);
  return resolve(found);
}

function which(name) {
  return execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
}

export function carry({ app, release, source, uv, codex }) {
  const contents = join(app, 'Contents');
  if (!existsSync(join(contents, 'Info.plist'))) throw new Error(`${app} isn't an app`);
  const out = join(contents, 'Resources', 'hive');
  rmSync(out, { recursive: true, force: true });

  const { version, files } = unpack(readFileSync(release), { kind: 'mac' });
  const voice = sourceFiles(source, VOICE_PARTS).filter(f => !f.path.includes('/__pycache__/'));
  const lock = voice.find(f => f.path === 'desktop/app/requirements.lock');
  if (!lock) throw new Error(`${source} has no desktop/app/requirements.lock`);
  const python = lockedPython(lock.data.toString('utf8'));
  for (const f of [...files, ...voice]) {
    const at = join(out, f.path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, f.data);
    chmodSync(at, f.mode);
  }
  cpSync(join(source, 'desktop/app/tools/first-open.sh'), join(out, 'first-open.sh'));
  chmodSync(join(out, 'first-open.sh'), 0o755);
  writeFileSync(join(out, 'VERSION'), `${version} ${bundleVersion(voice)}\n`);

  const listing = execFileSync(uv, ['python', 'list', '--all-versions', '--only-downloads'], { encoding: 'utf8' });
  if (!uvOffers(listing, python)) {
    throw new Error(`${uv} can't download Python ${python} (requirements.lock's); use a newer uv (--uv)`);
  }
  const helpers = join(contents, 'Helpers');
  mkdirSync(helpers, { recursive: true });
  cpSync(realpathSync(uv), join(helpers, 'uv'));
  chmodSync(join(helpers, 'uv'), 0o755);
  const codexAt = join(contents, 'Resources', 'codex');
  rmSync(codexAt, { recursive: true, force: true });
  cpSync(codex, codexAt, { recursive: true, dereference: true });
  return { version, files: files.length + voice.length, python };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { release: { type: 'string' }, source: { type: 'string' }, uv: { type: 'string' }, codex: { type: 'string' } },
  });
  const [app] = positionals;
  if (!app || !values.release || !values.source) {
    console.error('usage: node tools/carry.mjs <Hive.app> --release <mac release file> --source <export> [--uv <uv>] [--codex <folder>]');
    process.exit(2);
  }
  const uv = values.uv ?? which('uv');
  const codex = values.codex ? resolve(values.codex) : codexNativeFolder(which('codex'));
  const done = carry({ app: resolve(app), release: resolve(values.release), source: resolve(values.source), uv, codex });
  console.log(`carried mac ${done.version}: ${done.files} files, Python ${done.python} by uv, and Codex`);
}
