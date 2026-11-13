#!/usr/bin/env node
// Files between Hive's nodes. Hive's cloud storage (the R2 bucket `hive-files`) is the meeting
// point: the Mac puts a file there (desktop/hive-files.mjs) and the VM fetches it into
// ~/hive-files, where the VM agent's file pickers can open it; the VM can put files back.
//
// The VM's Cloudflare login belongs to root's login shell (it is Devhub's), so every cloud call
// runs there through `sudo -n`. Keys and paths travel as arguments, never inside the script, and
// the login itself is never read or printed here.
//   node files.mjs fetch <key>          (or {"key"} as JSON on stdin)  → {"path"}
//   node files.mjs put <path> <key>     → {"key"}
//   node files.mjs list [prefix]        → {"files":[{key,size}]}
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';

export const BUCKET = process.env.HIVE_FILES_BUCKET ?? 'hive-files';
export const filesDir = () => process.env.HIVE_FILES_DIR ?? join(homedir(), 'hive-files');

/** A key is a relative path of ordinary names: no "..", no leading "/", no control characters. */
export function checkKey(key) {
  if (typeof key !== 'string' || !key || key.length > 512) throw new Error('a file key is 1 to 512 characters');
  if (key.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(key)) throw new Error(`unsupported file key "${key}"`);
  if (key.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error(`unsupported file key "${key}"`);
  return key;
}

/** Where a key lands on this machine; always inside filesDir(). */
export function localPath(key, root = filesDir()) {
  const path = resolve(root, checkKey(key));
  if (!path.startsWith(resolve(root) + sep)) throw new Error(`unsupported file key "${key}"`);
  return path;
}

const TYPES = { '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.zip': 'application/zip' };
export const contentType = path => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

function asCloud(script, args) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(BUCKET)) return Promise.reject(new Error('unsupported bucket name'));
  return new Promise((resolvePromise, reject) => {
    execFile('sudo', ['-n', '-H', 'bash', '-lc', script, 'hive-files', ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr).trim().split('\n').filter(Boolean).pop() ?? error.message));
      resolvePromise(String(stdout));
    });
  });
}

/** Cloud → this machine. Returns the local path. */
export async function fetchFile(key, root = filesDir()) {
  const path = localPath(key, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.part`;
  rmSync(part, { force: true });
  try {
    await asCloud('wrangler r2 object get "$1/$2" --remote --file "$3" >/dev/null && chown "$4" "$3"',
      [BUCKET, key, part, `${process.getuid()}:${process.getgid()}`]);
    renameSync(part, path);
  } finally { rmSync(part, { force: true }); }
  return path;
}

/** This machine → cloud. */
export async function putFile(path, key) {
  checkKey(key);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no file at ${path}`);
  await asCloud('wrangler r2 object put "$1/$2" --remote --file "$3" --content-type "$4" >/dev/null', [BUCKET, key, resolve(path), contentType(path)]);
  return key;
}

/** What is in the cloud (up to 1000 files), newest names first. */
export async function listFiles(prefix = '') {
  const out = await asCloud('curl -sS --fail-with-body -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" '
    + '"https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$1/objects?per_page=1000&prefix=$2"',
  [BUCKET, encodeURIComponent(prefix)]);
  const body = JSON.parse(out);
  if (!body.success) throw new Error(body.errors?.map(e => e.message).join('; ') || 'the cloud storage did not answer');
  return (body.result ?? []).map(({ key, size }) => ({ key, size })).sort((a, b) => b.key.localeCompare(a.key));
}

export const listRemote = async prefix => (await listFiles(prefix)).map(({ key, size }) => `${key}  (${size} bytes)`);

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);
  const stdinJson = async () => {
    if (process.stdin.isTTY) return {};
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text ? JSON.parse(text) : {};
  };
  try {
    let result;
    if (command === 'fetch') result = { path: await fetchFile(rest[0] ?? (await stdinJson()).key) };
    else if (command === 'put') { const input = rest.length ? { path: rest[0], key: rest[1] } : await stdinJson(); result = { key: await putFile(input.path, input.key) }; }
    else if (command === 'list') result = { files: await listFiles(rest[0] ?? '') };
    else { console.error('usage: files.mjs fetch <key> | put <path> <key> | list [prefix]'); process.exit(2); }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ error: 'files_failed', message: error.message }));
    process.exit(1);
  }
}
