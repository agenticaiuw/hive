#!/usr/bin/env node
// Post to Discord or X through the browser on the owner's VM, from this Mac.
//
// The Mac never opens those sites. It sends the request over SSH to the VM worker
// (cloud/vm-agent), shows the owner exactly what will be published, and sends only on "Send".
//
//   vm-post.mjs status | check <discord|x> | list | cancel <id> | screenshot [file.jpg]
//   vm-post.mjs login <discord|x>            open the VM's browser here so you can sign in yourself
//   vm-post.mjs vpn [status|down]            UW-Madison's VPN for the VM's browser (vpn.sh): you sign in
//   vm-post.mjs where discord [server-id]    list your servers, or one server's channels
//   vm-post.mjs send --to <name|channel-link|x> [--file path]... [--text "..."]   (or text on stdin)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const CONFIG_PATH = join(homedir(), '.hivemind', 'vm-agent.json');
const SAFE = /^[\w@%+=:,./~-]+$/;
const expand = path => path.replace(/^~(?=\/|$)/, homedir());

export function loadConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) throw new Error(`missing ${path}; see cloud/vm-agent/README.md`);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const { host, user, identityFile } = config.ssh ?? {};
  for (const [name, value] of Object.entries({ host, user, remoteDir: config.remoteDir, ...(config.stateDir === undefined ? {} : { stateDir: config.stateDir }), ...(config.node === undefined ? {} : { node: config.node }) })) {
    if (typeof value !== 'string' || !SAFE.test(value)) throw new Error(`vm-agent.json: ${name} is missing or has unsupported characters`);
  }
  return { ...config, ssh: { host, user, identityFile: identityFile ? expand(identityFile) : null }, destinations: config.destinations ?? {} };
}

const sshArgs = ({ ssh }) => [
  ...(ssh.identityFile ? ['-i', ssh.identityFile] : []),
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', `${ssh.user}@${ssh.host}`,
];

// Run one worker command on the VM. JSON or raw bytes travel on stdin, never on the command line.
export function sshRunner(config) {
  return (command, { input, argument } = {}) => new Promise((resolvePromise, reject) => {
    if (argument !== undefined && !SAFE.test(argument)) return reject(new Error('unsupported characters in argument'));
    const remote = `${config.stateDir ? `HIVE_VM_STATE=${config.stateDir} ` : ''}${config.node ?? 'node'} ${config.remoteDir}/ctl.mjs ${command}${argument ? ` ${argument}` : ''}`;
    const child = spawn('ssh', [...sshArgs(config), remote], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      let body = null;
      try { body = JSON.parse(out); } catch { /* handled below */ }
      if (status === 0 && body) return resolvePromise(body);
      const error = new Error(body?.message ?? (err.trim().split('\n').pop() || `ssh exited with ${status}`));
      error.code = body?.error ?? 'vm_unreachable';
      reject(error);
    });
    child.stdin.end(input === undefined ? '' : Buffer.isBuffer(input) ? input : JSON.stringify(input));
  });
}

// Native confirmation: the exact words and destination, Cancel as the default button.
export function macConfirm({ label, destination, text, attachments }) {
  const message = [`Send this as you to:\n${label ?? destination}`, attachments.length ? `With: ${attachments.join(', ')}` : null, `\n${text}`].filter(Boolean).join('\n');
  const script = ['on run argv', 'display dialog (item 1 of argv) with title "Hive — post from your VM" buttons {"Cancel", "Send"} default button "Cancel" cancel button "Cancel" with icon note giving up after 600', 'if gave up of result then error number -128', 'end run'];
  const shown = spawnSync('osascript', [...script.flatMap(line => ['-e', line]), '--', message], { encoding: 'utf8' });
  return shown.status === 0 && /button returned:Send/.test(shown.stdout);
}

export function resolveDestination(config, to) {
  if (to === 'x') return { platform: 'x', destination: 'post' };
  if (/^https:\/\/discord\.com\/channels\//.test(to)) return { platform: 'discord', destination: to };
  const named = config.destinations[to];
  if (!named) throw new Error(`unknown destination "${to}"; known: ${Object.keys(config.destinations).join(', ') || 'none'}`);
  return named;
}

export function createClient({ run, confirm = macConfirm, read = readFileSync }) {
  return {
    run,
    // draft -> the owner confirms the text the VM actually stored -> approve that digest -> send once
    async send({ platform, destination, text, files = [] }) {
      const attachments = [];
      for (const file of files) attachments.push((await run('upload', { input: read(file), argument: basename(file).replace(/[^\w.-]/g, '_') })).uploadId);
      const draft = await run('draft', { input: { platform, destination, text, attachments } });
      if (draft.loginState === 'needs_login') {
        await run('cancel', { input: { id: draft.id } });
        return { status: 'needs_login', id: draft.id };
      }
      if (draft.status !== 'drafted') return { status: draft.status, id: draft.id, detail: draft.detail };
      const approved = await confirm({ label: draft.label, destination: draft.destination, text: draft.text, attachments: files.map(file => basename(file)) });
      if (!approved) {
        await run('cancel', { input: { id: draft.id } });
        return { status: 'cancelled', id: draft.id };
      }
      await run('approve', { input: { id: draft.id, digest: draft.digest } });
      const result = await run('send', { input: { id: draft.id } });
      return { status: result.status, id: result.id, detail: result.detail };
    },
  };
}

async function openViewer(config, run, site, minutes) {
  const view = await run('view-open', { input: { site } });
  const localPort = 38917;
  const tunnel = spawn('ssh', ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${view.port}`, ...sshArgs(config)], { stdio: 'inherit' });
  const stop = async () => { tunnel.kill(); await run('view-close', { input: {} }).catch(() => {}); };
  await new Promise(done => setTimeout(done, 2500));
  if (tunnel.exitCode !== null) { await stop(); throw new Error('could not open the SSH tunnel to the VM'); }
  spawnSync('open', [`http://127.0.0.1:${localPort}/auth?t=${view.token}`]);
  console.log(`The VM's browser is open in your browser for ${minutes} minutes. Sign in there yourself; press Ctrl-C here when done.`);
  await new Promise(done => { const timer = setTimeout(done, minutes * 60_000); process.once('SIGINT', () => { clearTimeout(timer); done(); }); process.once('SIGTERM', () => { clearTimeout(timer); done(); }); tunnel.once('exit', () => { clearTimeout(timer); done(); }); });
  await stop();
}

async function main(argv) {
  const [command, ...rest] = argv;
  const config = loadConfig();
  const run = sshRunner(config);
  const print = value => console.log(JSON.stringify(value, null, 2));
  if (command === 'status' || command === 'list') return print(await run(command === 'list' ? 'posts' : 'status'));
  if (command === 'check') return print(await run('check', { input: { platform: rest[0] } }));
  if (command === 'cancel') return print(await run('cancel', { input: { id: rest[0] } }));
  if (command === 'where') return print(await run('discover', { input: { platform: rest[0], ...(rest[1] ? { server: rest[1] } : {}) } }));
  if (command === 'login') return openViewer(config, run, rest[0], Number(rest[1]) || 20);
  if (command === 'vpn') {
    const action = rest[0] ?? 'up';
    if (!['up', 'status', 'down'].includes(action)) throw new Error('usage: vm-post.mjs vpn [status|down]');
    // A terminal of its own on the VM: the NetID, password and Duo answer go from your keyboard to openconnect.
    const { status } = spawnSync('ssh', ['-t', ...sshArgs(config), `${config.remoteDir}/vpn.sh ${action}`], { stdio: 'inherit' });
    process.exitCode = status ?? 1;
    return;
  }
  if (command === 'screenshot') {
    const shot = await run('screenshot');
    const file = resolve(rest[0] ?? join(homedir(), '.hivemind', 'vm-agent', 'screenshot.jpg'));
    writeFileSync(file, Buffer.from(shot.jpegBase64, 'base64'), { mode: 0o600 });
    return print({ at: shot.at, url: shot.url, file });
  }
  if (command === 'send') {
    const files = []; let to; let text;
    for (let index = 0; index < rest.length; index++) {
      if (rest[index] === '--to') to = rest[++index];
      else if (rest[index] === '--file') files.push(resolve(expand(rest[++index])));
      else if (rest[index] === '--text') text = rest[++index];
      else if (rest[index] === '--text-file') text = readFileSync(resolve(expand(rest[++index])), 'utf8');
      else throw new Error(`unknown option ${rest[index]}`);
    }
    if (!to) throw new Error('send needs --to');
    text ??= readFileSync(0, 'utf8');
    const result = await createClient({ run }).send({ ...resolveDestination(config, to), text, files });
    print(result);
    process.exitCode = { sent: 0, cancelled: 1, needs_login: 3, unknown: 4 }[result.status] ?? 5;
    return;
  }
  throw new Error('usage: vm-post.mjs <status|check|login|where|send|list|cancel|screenshot|vpn> ...');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(error => { console.error(`vm-post: ${error.message}`); process.exitCode = process.exitCode || 2; });
}
