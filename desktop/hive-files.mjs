#!/usr/bin/env node
// Files between Hive's nodes, from the Mac. Hive's cloud storage (the R2 bucket `hive-files`) is
// where they meet: `send` puts a file there and, with --to vm, has the VM fetch it into ~/hive-files
// (cloud/vm-agent/files.mjs), where Hive's VM agent can attach it. Uses the Mac's `cf` login.
//   node hive-files.mjs send <path> [--to vm] [--key <key>]
//   node hive-files.mjs get <key> [destination]
//   node hive-files.mjs list [prefix]
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadConfig, sshArgs } from './vm-post.mjs';
import { checkKey, contentType } from '../cloud/vm-agent/files.mjs';

const BUCKET = process.env.HIVE_FILES_BUCKET ?? 'hive-files';

function run(command, args, { stdin, stdout } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: [stdin === undefined ? 'ignore' : 'pipe', stdout ? 'pipe' : 'pipe', 'pipe'] });
    let out = ''; let err = '';
    if (stdout) child.stdout.pipe(stdout); else child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', status => status === 0 ? resolvePromise(out)
      : reject(new Error(err.trim().split('\n').filter(Boolean).pop() ?? `${command} exited with ${status}`)));
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

/** Today's folder for a file from the Mac: from-mac/2026-11-13/<name>. */
export function macKey(path, now = new Date()) {
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  return checkKey(`from-mac/${day}/${basename(path)}`);
}

async function send(path, { to, key }) {
  const file = resolve(path);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`no file at ${file}`);
  const name = checkKey(key ?? macKey(file));
  console.log(`Uploading ${basename(file)} (${(statSync(file).size / 1e6).toFixed(1)} MB) to Hive's cloud storage as ${name}…`);
  await run('cf', ['r2', 'objects', 'put', name, '--bucket-name', BUCKET, '--file', file, '--content-type', contentType(file)]);
  if (to === 'vm') {
    const config = loadConfig();
    console.log('Fetching it onto the VM…');
    const remote = `${config.node ?? 'node'} ${config.remoteDir}/files.mjs fetch`;
    const out = JSON.parse(await run('ssh', [...sshArgs(config), remote], { stdin: JSON.stringify({ key: name }) }));
    if (out.error) throw new Error(out.message);
    console.log(`On the VM at ${out.path}`);
  } else if (to) throw new Error('--to takes "vm"');
  console.log(`Key: ${name}`);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const option = flag => { const at = rest.indexOf(flag); if (at < 0) return undefined; const [, value] = rest.splice(at, 2); return value; };
  if (command === 'send') { const to = option('--to'); const key = option('--key'); return send(rest[0], { to, key }); }
  if (command === 'get') {
    const key = checkKey(rest[0]); const dest = resolve(rest[1] ?? basename(key));
    await run('cf', ['r2', 'objects', 'get', key, '--bucket-name', BUCKET], { stdout: createWriteStream(dest) });
    return console.log(dest);
  }
  if (command === 'list') {
    const out = JSON.parse(await run('cf', ['r2', 'objects', 'list', '--bucket-name', BUCKET, ...(rest[0] ? ['--prefix', rest[0]] : [])]));
    const items = Array.isArray(out) ? out : out.objects ?? out.result ?? [];
    for (const { key, size } of items) console.log(`${key}  (${size} bytes)`);
    return;
  }
  throw new Error('usage: hive-files.mjs send <path> [--to vm] [--key k] | get <key> [dest] | list [prefix]');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(error => { console.error(`hive-files: ${error.message}`); process.exitCode = 1; });
}
