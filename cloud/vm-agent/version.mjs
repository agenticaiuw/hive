// What code this VM runs, for the board (cloud/tasks/nodes.js), and the release format the updater
// puts in (updater.mjs) and cloud/release.mjs makes.
//
// Every call this VM makes to the board says who it is and what it runs (nodeHeaders): the board
// writes it down for the dashboard, answers with the newest release for VMs, and refuses routes it no
// longer serves. A release is the app folder's files, gzipped JSON; its version is a hash of their
// paths and contents, so the same code is always the same version (a Mac release's is the hash of
// its sources; hive-tasks update.rs reads the same format). The updater writes the version it
// put in to VERSION in the app folder; a folder copied by hand has none ("unversioned").
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

// The board's routes this code was written against (cloud/shared/protocol.json).
export const PROTOCOL = 1;
const FORMAT = 1;

const APP = new URL('.', import.meta.url);

/** The release this app folder runs: its VERSION, or "unversioned" for code copied in by hand. */
export function appVersion(dir = APP) {
  try {
    return readFileSync(new URL('VERSION', dir), 'utf8').trim() || 'unversioned';
  } catch {
    return 'unversioned';
  }
}

/** The headers every call to the board carries. */
export const nodeHeaders = (machine = 'vm', version = appVersion()) => ({
  'x-hive-node': `vm:${machine}`,
  'x-hive-version': version,
  'x-hive-protocol': String(PROTOCOL),
});

const sha256 = data => createHash('sha256').update(data).digest('hex');
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** A release's version: the same files always give the same 12 hex. */
export function bundleVersion(files) {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map(f => `${f.path}\0${f.mode ?? 0o644}\0${sha256(f.data)}\n`);
  return sha256(lines.join('')).slice(0, 12);
}

/**
 * Files ({path, mode, data}) → the release's bytes and version. The version is the files' own hash
 * unless one is given: a Mac release's binaries are built knowing their version (the hash of their
 * sources, cloud/release.mjs), so it can't be the hash of the binaries too. Either way the files'
 * hash goes in as files_version, which unpack checks, and `arch` says which processor the files are
 * built for when they're machine code.
 */
export function pack(kind, files, { version, arch } = {}) {
  for (const f of files) if (!SAFE_PATH.test(f.path)) throw new Error(`a release can't hold ${f.path}`);
  const filesVersion = bundleVersion(files);
  version ??= filesVersion;
  const body = { format: FORMAT, kind, version, files_version: filesVersion, protocol: PROTOCOL, ...(arch ? { arch } : {}),
    files: files.map(f => ({ path: f.path, mode: f.mode === 0o755 ? 0o755 : 0o644, data: Buffer.from(f.data).toString('base64') })) };
  const bytes = gzipSync(Buffer.from(JSON.stringify(body)), { level: 9 });
  return { bytes, version, sha256: sha256(bytes) };
}

/** A release's bytes → its files, checked: the sha256, each path inside the folder, the version. */
export function unpack(bytes, { sha: expected, kind } = {}) {
  if (expected && sha256(bytes) !== expected) throw new Error("the release's bytes don't match its sha256");
  const body = JSON.parse(gunzipSync(bytes).toString('utf8'));
  if (body.format !== FORMAT) throw new Error(`release format ${body.format} is newer than this updater reads`);
  if (kind && body.kind !== kind) throw new Error(`that's a ${body.kind} release, not ${kind}`);
  const files = body.files.map(f => {
    if (!SAFE_PATH.test(f.path)) throw new Error(`the release holds a path outside the app: ${f.path}`);
    return { path: f.path, mode: f.mode === 0o755 ? 0o755 : 0o644, data: Buffer.from(f.data, 'base64') };
  });
  if (bundleVersion(files) !== (body.files_version ?? body.version)) throw new Error("the release's files don't match its version");
  return { version: body.version, protocol: body.protocol, arch: body.arch ?? null, files };
}
