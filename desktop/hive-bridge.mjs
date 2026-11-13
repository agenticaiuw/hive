#!/usr/bin/env node
// The Mac's devices for Hive's agent on the cloud VM. Today that is the phone: the VM agent signs
// in like the Mac's does, and Duo's approval and the phone's passcode are on the phone, which only
// the Mac can reach (its relay and the passcode in the Mac's Keychain). So the Mac serves the
// phone's tools (build/hive-phone-mcp, one per connection) on a local socket and forwards that
// socket to the VM over SSH, where cloud/vm-agent/phone-mcp.mjs connects Codex to it. The socket
// on the VM belongs to the VM's user; nothing listens on a network port. Keeps the Mac awake while
// it runs, and reconnects if SSH drops.
//
//   node hive-bridge.mjs [--until 9:30]      (a local time today, or tomorrow if it has passed)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, sshArgs } from './vm-post.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, 'app');
const PHONE_MCP = join(APP, 'build', 'hive-phone-mcp');
const LOCAL = join(homedir(), '.hivemind', 'bridge', 'phone.sock');
export const REMOTE_NAME = 'mac-phone.sock';

/** "9:30", "9:30 AM", "21:15" → the next such time, as a Date. */
export function nextTime(text, now = new Date()) {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(String(text).trim());
  if (!match) throw new Error(`--until takes a time like 9:30 or 9:30 AM, not "${text}"`);
  let hour = Number(match[1]); const minute = Number(match[2]);
  if (match[3]) hour = (hour % 12) + (/pm/i.test(match[3]) ? 12 : 0);
  if (hour > 23 || minute > 59) throw new Error(`no such time "${text}"`);
  const when = new Date(now); when.setHours(hour, minute, 0, 0);
  if (when <= now) when.setDate(when.getDate() + 1);
  return when;
}

const stamp = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const log = line => console.log(`${stamp()}  ${line}`);

/** One phone server per connection, so each VM task gets its own phone session. */
function servePhone() {
  if (!existsSync(PHONE_MCP)) throw new Error(`no ${PHONE_MCP}; build it with make in desktop/app`);
  mkdirSync(dirname(LOCAL), { recursive: true, mode: 0o700 });
  rmSync(LOCAL, { force: true });
  const server = createServer(socket => {
    log('The VM agent connected to the phone.');
    const child = spawn(PHONE_MCP, [], { cwd: APP, stdio: ['pipe', 'pipe', 'inherit'] });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    const end = () => { socket.destroy(); if (child.exitCode === null) child.kill(); };
    socket.on('close', () => { end(); log('The VM agent let go of the phone.'); });
    socket.on('error', end);
    child.on('exit', end);
    child.stdin.on('error', () => {});
  });
  server.listen(LOCAL);
  return server;
}

/** ssh -R <VM state>/mac-phone.sock:<local socket>, kept up until told to stop. */
function forward(config) {
  const remote = `${config.stateDir ?? '/home/ubuntu/hive-vm-agent/state'}/${REMOTE_NAME}`;
  let child = null; let stopping = false; let delay = 2000;
  const start = () => {
    if (stopping) return;
    // The VM's sshd won't replace a socket left from an earlier bridge, so remove it first.
    const clear = spawn('ssh', [...sshArgs(config), `rm -f ${remote}`], { stdio: 'ignore' });
    clear.on('exit', () => {
      if (stopping) return;
      const opened = Date.now();
      child = spawn('ssh', ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
        '-R', `${remote}:${LOCAL}`, ...sshArgs(config)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', chunk => { err += chunk; });
      log('Forwarding the phone to the VM.');
      child.on('exit', status => {
        child = null;
        if (stopping) return;
        if (Date.now() - opened > 60_000) delay = 2000;
        log(`The SSH link closed (${status}${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}); reconnecting in ${delay / 1000}s.`);
        setTimeout(start, delay); delay = Math.min(delay * 2, 60_000);
      });
    });
  };
  start();
  return () => { stopping = true; child?.kill(); spawn('ssh', [...sshArgs(config), `rm -f ${remote}`], { stdio: 'ignore' }); };
}

async function main(argv) {
  let until = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--until') until = nextTime(argv[++i]);
    else throw new Error(`unknown option ${argv[i]}`);
  }
  const config = loadConfig();
  const server = servePhone();
  const stopForward = forward(config);
  // Asleep, the Mac can't answer the phone's tools; keep it awake (not the display) while this runs.
  const awake = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  log(`Hive's bridge is up: the VM agent can use the phone${until ? ` until ${until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}. Ctrl-C ends it.`);
  const stop = () => { log('Closing the bridge.'); stopForward(); server.close(); rmSync(LOCAL, { force: true }); awake.kill(); setTimeout(() => process.exit(0), 1500); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (until) setTimeout(stop, until - Date.now());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(error => { console.error(`hive-bridge: ${error.message}`); process.exit(1); });
}
