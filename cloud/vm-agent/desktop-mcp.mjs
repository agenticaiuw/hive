#!/usr/bin/env node
// Hive's hands on the VM: an MCP server (stdio) that lets Codex, running on the VM, see the VM's
// screen and use its mouse and keyboard, as a person at a remote desktop would. It opens the
// worker's browser as an ordinary one (the sign-in desktop, no remote control of the browser),
// shares the screen with its own x11vnc on a private Unix socket, and drives it through vnc.mjs.
// Nothing is disguised: the browser is the same one the owner signs in with.
//
// Every tool takes `step`: one short sentence saying what it is about to do, which goes to the
// task log, the way Hive on the Mac says each step before it does it.
//
// Env: HIVE_VM_STATE (the worker's state folder), HIVE_FILES_DIR (where fetched files land).
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { call } from './ctl.mjs';
import { encodePng, untypable, Vnc } from './vnc.mjs';
import { fetchFile, filesDir, listRemote } from './files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.HIVE_VM_STATE ?? join(homedir(), 'hive-vm-agent', 'state');
const vncSocket = join(stateDir, 'agent-vnc.sock');
const stepLog = process.env.HIVE_TASK_STEPS;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- the screen ---------------------------------------------------------------------------

/** The worker's X display and its auth file, read from the running worker's environment. */
export function workerDisplay(serverPath = join(here, 'server.mjs')) {
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let cmdline;
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    if (!cmdline.includes(serverPath)) continue;
    const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
      .filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
    if (env.DISPLAY) return { display: env.DISPLAY, auth: env.XAUTHORITY };
  }
  throw new Error('the Hive VM worker is not running with a display; start it with ~/hive-vm-agent/run.sh');
}

let vnc = null; let vncServer = null; let keepOpen = null;

/** An x11vnc an earlier run of this server left on our socket. */
function stopStrayVnc() {
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (args[0].endsWith('x11vnc') && args.includes(vncSocket)) process.kill(Number(pid), 'SIGKILL');
    } catch { /* gone, or not ours */ }
  }
}

async function controlCall(path) {
  const { status, body } = await call(join(stateDir, 'control.sock'), 'POST', path, Buffer.from('{}'));
  if (status >= 300) throw new Error(body?.message ?? body?.error ?? `the worker said ${status}`);
  return body;
}

/** Opens the browser for use and connects to the screen, once; later calls reuse it. */
async function screen() {
  if (vnc) return vnc;
  await controlCall('/desktop/open');
  keepOpen ??= setInterval(() => controlCall('/desktop/open').catch(() => {}), 5 * 60_000);
  if (!vncServer || vncServer.exitCode !== null) {
    const { display, auth } = workerDisplay();
    rmSync(vncSocket, { force: true });
    // -rfbport 0: no TCP port at all. The socket sits in the worker's private (0700) state folder, so
    // only this user can connect; -localhost would refuse socket clients, so it is left out.
    stopStrayVnc();
    vncServer = spawn('x11vnc', ['-display', display, ...(auth ? ['-auth', auth] : []), '-rfbport', '0', '-unixsock', vncSocket,
      '-forever', '-shared', '-noxdamage', '-nopw', '-quiet'], { stdio: 'ignore' });
    for (let waited = 0; !existsSync(vncSocket); waited += 100) {
      if (vncServer.exitCode !== null) throw new Error('x11vnc stopped before it started sharing the screen');
      if (waited > 10_000) throw new Error('x11vnc did not start in 10 s');
      await sleep(100);
    }
  }
  vnc = await Vnc.open({ path: vncSocket });
  // x11vnc sets up the keyboard as the first viewer joins; keys sent before that are lost.
  await sleep(1500);
  await vnc.capture();
  return vnc;
}

async function picture(screen, { region, zoom = 1 } = {}) {
  const shot = await screen.capture();
  if (!region) return shot.png;
  const [x, y, w, h] = region.map(Math.round);
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > shot.width || y + h > shot.height) throw new Error(`the region must be inside the ${shot.width}x${shot.height} screen`);
  const scale = Math.max(1, Math.min(4, Math.round(zoom)));
  const out = Buffer.alloc(w * h * 3 * scale * scale);
  for (let row = 0; row < h * scale; row++) {
    for (let col = 0; col < w * scale; col++) {
      const from = ((y + Math.floor(row / scale)) * shot.width + x + Math.floor(col / scale)) * 3;
      screen.pixels.copy(out, (row * w * scale + col) * 3, from, from + 3);
    }
  }
  return encodePng(w * scale, h * scale, out);
}

// ---- tools --------------------------------------------------------------------------------

const step = { type: 'string', description: 'One short sentence saying what you are about to do and why, e.g. "Clicking Post to open the composer."' };
const xy = { x: { type: 'number', description: 'Screen pixels from the left' }, y: { type: 'number', description: 'Screen pixels from the top' } };
const tool = (name, description, properties = {}, required = []) =>
  ({ name, description, inputSchema: { type: 'object', properties: { step, ...properties }, required: ['step', ...required], additionalProperties: false } });

export const TOOLS = [
  tool('screenshot', 'See the VM screen now (1440x900). Coordinates in the other tools are pixels of this picture.'),
  tool('zoom', 'See part of the screen enlarged, to read small text exactly.', {
    x: xy.x, y: xy.y, width: { type: 'number' }, height: { type: 'number' }, scale: { type: 'number', description: '2 to 4, default 2' },
  }, ['x', 'y', 'width', 'height']),
  tool('click', 'Move the mouse to (x, y) and click.', {
    ...xy, button: { type: 'string', enum: ['left', 'right', 'middle'] }, count: { type: 'number', description: '2 for a double click' },
  }, ['x', 'y']),
  tool('drag', 'Press the left button at (x, y), move to (to_x, to_y) and let go.', {
    ...xy, to_x: { type: 'number' }, to_y: { type: 'number' },
  }, ['x', 'y', 'to_x', 'to_y']),
  tool('scroll', 'Scroll with the mouse over (x, y): positive amount scrolls down, negative up, in wheel notches.', {
    ...xy, amount: { type: 'number' },
  }, ['x', 'y', 'amount']),
  tool('type_text', 'Type text with the keyboard into whatever has focus, exactly as given. A newline presses Return. Only plain ASCII can be typed: '
    + 'for an emoji or accented letter, type the text around it and add it with the page\'s emoji or symbol picker. Text with such a character is refused whole.', {
    text: { type: 'string' },
  }, ['text']),
  tool('press_key', 'Press a key or a combination, e.g. "Return", "Escape", "ctrl+l", "ctrl+a", "shift+Tab", "Page_Down".', {
    keys: { type: 'string' },
  }, ['keys']),
  tool('wait', 'Wait, for something to load or upload, then see the screen.', { seconds: { type: 'number', description: '1 to 60' } }, ['seconds']),
  tool('wait_until', 'Wait until a time on the owner\'s clock (up to 30 minutes ahead), then see the screen. For things that must happen at or after a time.', {
    time: { type: 'string', description: 'e.g. "8:45:00 AM" (today, the owner\'s time zone) or an ISO time' },
  }, ['time']),
  tool('authenticate', 'Sign in with the owner\'s saved login for a site, from the VM\'s credential store (its saved passwords, like the Mac\'s). '
    + 'Click the field first. field "password" types the password and presses Return; "username" types the username; "both" types the username, Tab, '
    + 'the password and Return. You never see the password. If several logins fit, it lists their usernames: call again with one.', {
    site: { type: 'string', description: 'The site as the address bar shows it, e.g. "login.wisc.edu"' },
    field: { type: 'string', enum: ['password', 'username', 'both'] },
    username: { type: 'string', description: 'Only when it listed several' },
  }, ['site', 'field']),
  tool('list_files', 'List the files the owner sent to Hive (on the VM and in Hive\'s cloud storage), with the path to give a file picker.'),
  tool('fetch_file', 'Bring a file from Hive\'s cloud storage onto the VM, so a file picker can open it. Returns its path on the VM.', {
    key: { type: 'string', description: 'The file\'s key in Hive\'s cloud storage, as list_files shows it' },
  }, ['key']),
];

function record(name, args) {
  const line = `→ ${name}: ${String(args.step ?? '').trim() || '(no step given)'}`;
  if (stepLog) appendFileSync(stepLog, `${new Date().toISOString()} ${line}\n`);
  process.stderr.write(`${line}\n`);
}

// The owner's clock, on every answer, so a task can be timed ("enroll at 8:45").
const ownerZone = process.env.HIVE_OWNER_TZ ?? 'America/Chicago';
export const ownerTime = (at = new Date()) => at.toLocaleString('en-US', { timeZone: ownerZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const look = async (s, note) => [{ type: 'text', text: `${note} Time now: ${ownerTime()}.` }, { type: 'image', data: (await picture(s)).toString('base64'), mimeType: 'image/png' }];

/** When "8:45" or "8:45:00 AM" (the owner's time zone, today) or an ISO time is; null if unreadable. */
export function parseOwnerTime(text, now = new Date(), zone = ownerZone) {
  const iso = /\d{4}-\d{2}-\d{2}T/.test(text) ? new Date(text) : null;
  if (iso) return Number.isNaN(iso.getTime()) ? null : iso;
  const match = String(text).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!match) return null;
  let hour = Number(match[1]); const minute = Number(match[2]); const second = Number(match[3] ?? 0);
  const half = match[4]?.[0]?.toLowerCase();
  if (half === 'p' && hour < 12) hour += 12;
  if (half === 'a' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // Today's date in the owner's zone, then the offset that zone has at that moment.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).map(({ type, value }) => [type, value]));
  const guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute, second);
  const shown = new Date(new Date(guess).toLocaleString('en-US', { timeZone: zone }) + ' UTC').getTime();
  return new Date(guess + (guess - shown));
}

export async function runTool(name, args) {
  record(name, args);
  switch (name) {
    case 'screenshot': { const s = await screen(); return look(s, `The screen, ${s.width}x${s.height}.`); }
    case 'zoom': {
      const s = await screen(); const scale = args.scale ?? 2;
      const png = await picture(s, { region: [args.x, args.y, args.width, args.height], zoom: scale });
      return [{ type: 'text', text: `(${args.x}, ${args.y}) ${args.width}x${args.height}, enlarged ${Math.max(1, Math.min(4, Math.round(scale)))}x.` },
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }];
    }
    case 'click': { const s = await screen(); await s.click(args.x, args.y, { button: args.button ?? 'left', count: args.count ?? 1 }); await sleep(600); return look(s, `Clicked at (${s.x}, ${s.y}).`); }
    case 'drag': { const s = await screen(); await s.drag(args.x, args.y, args.to_x, args.to_y); await sleep(500); return look(s, 'Dragged.'); }
    case 'scroll': { const s = await screen(); await s.scroll(args.x, args.y, args.amount); await sleep(500); return look(s, 'Scrolled.'); }
    case 'type_text': { const s = await screen(); await s.type(String(args.text)); await sleep(500); return look(s, `Typed ${[...String(args.text)].length} characters.`); }
    case 'press_key': { const s = await screen(); await s.press(args.keys); await sleep(600); return look(s, `Pressed ${args.keys}.`); }
    case 'wait': { const s = await screen(); await sleep(Math.max(1, Math.min(60, Number(args.seconds) || 1)) * 1000); return look(s, 'Waited.'); }
    case 'wait_until': {
      const at = parseOwnerTime(String(args.time));
      if (!at) throw new Error(`couldn't read the time "${args.time}"; give it like "8:45:00 AM"`);
      const ms = at.getTime() - Date.now();
      if (ms > 30 * 60_000) throw new Error(`${ownerTime(at)} is more than 30 minutes away; wait in steps`);
      const s = await screen();
      if (ms > 0) await sleep(ms);
      return look(s, ms > 0 ? `It is now ${ownerTime(at)} or just after.` : `${ownerTime(at)} had already passed.`);
    }
    case 'authenticate': {
      const found = await savedLogin(String(args.site), args.username);
      if (found.choices) {
        return [{ type: 'text', text: found.choices.length ? `Several saved logins fit; call again with one username: ${found.choices.map(c => `${c.username || '(none)'} at ${c.site}`).join('; ')}.`
          : `No saved login for ${args.site} on the VM. Its saved sites are kept by the hive-cred command; tell the owner it is missing.` }];
      }
      const { username, password } = found.login;
      const typing = { username, password: `${password}\n`, both: `${username}\t${password}\n` }[args.field];
      if (typing === undefined) throw new Error('field is "password", "username" or "both"');
      if (untypable(typing).length) throw new Error('that login has characters the VM keyboard can\'t type; nothing was typed');
      const s = await screen(); await s.type(typing); await sleep(800);
      return look(s, `Typed the saved ${args.field === 'both' ? 'username and password' : args.field} for ${found.login.site}${args.field === 'username' ? '' : ' and pressed Return'}.`);
    }
    case 'list_files': {
      const local = existsSync(filesDir()) ? walk(filesDir()) : [];
      let remote = [];
      try { remote = await listRemote(); } catch (error) { remote = [`(cloud storage could not be listed: ${error.message})`]; }
      return [{ type: 'text', text: `On the VM (open these in a file picker by path):\n${local.join('\n') || '(none)'}\n\nIn Hive's cloud storage (fetch_file brings one here):\n${remote.join('\n') || '(none)'}` }];
    }
    case 'fetch_file': { const path = await fetchFile(String(args.key)); return [{ type: 'text', text: `It is on the VM at ${path}` }]; }
    default: throw new Error(`no tool called ${name}`);
  }
}

/** One login from the VM's credential store (hive-cred.mjs, as root): {login} or {choices}. */
function savedLogin(site, username) {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['-n', process.execPath, join(here, 'hive-cred.mjs'), 'secret', site, ...(username ? [String(username)] : [])],
      { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr).trim().split('\n').pop() || 'the credential store did not answer'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('the credential store gave no answer')); }
      });
  });
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [`${path}  (${statSync(path).size} bytes)`];
  });
}

async function shutdown() {
  clearInterval(keepOpen);
  await vnc?.close();
  if (vncServer && vncServer.exitCode === null) {
    // x11vnc can ignore a polite stop; it holds nothing worth saving.
    const exited = new Promise(resolve => vncServer.once('exit', resolve));
    vncServer.kill('SIGTERM');
    await Promise.race([exited, sleep(2000)]);
    if (vncServer.exitCode === null) vncServer.kill('SIGKILL');
  }
  rmSync(vncSocket, { force: true });
  process.exit(0);
}

// ---- MCP over stdio -----------------------------------------------------------------------

export async function answer(message) {
  const { id, method, params } = message;
  if (id === undefined) return null; // a notification
  const reply = result => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'hive-vm-desktop', version: '1.0.0' },
        instructions: 'The VM\'s own screen, mouse and keyboard. Say each step in `step` before doing it. Look at the screenshot after every action before the next one.' });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call':
      try { return reply({ content: await runTool(params?.name, params?.arguments ?? {}) }); } catch (error) {
        return reply({ content: [{ type: 'text', text: `Failed: ${error.message}` }], isError: true });
      }
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lines = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    // One at a time: the screen has one mouse.
    queue = queue.then(async () => { const out = await answer(message); if (out) process.stdout.write(`${JSON.stringify(out)}\n`); });
  });
  lines.on('close', () => queue.then(shutdown));
  process.on('SIGTERM', shutdown);
}
