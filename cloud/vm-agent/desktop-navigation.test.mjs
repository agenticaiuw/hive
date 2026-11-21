// A successful MCP reply is not proof that keys reached Chrome. Use the real desktop server,
// x11vnc and browser on a private X display, with local pages and an empty profile only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { findBrowserExecutable, desktopBrowserArgs } from './browser.mjs';
import { serveDevices } from './devices.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const releaseCheck = process.env.HIVE_UPDATE_CHECK === '1';
const browserConfigured = Boolean(process.env.HIVE_TEST_BROWSER || process.env.HIVE_VM_BROWSER);

// Hive's PNG encoder writes RGB rows with filter zero. Check the page's background, not
// merely any changed pixel: a blinking caret or selected address is not navigation.
function center(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const row = Math.floor(height / 2) * (width * 3 + 1);
  const pixels = inflateSync(Buffer.concat(chunks));
  assert.equal(pixels[row], 0);
  return [...pixels.subarray(row + 1 + Math.floor(width / 2) * 3, row + 4 + Math.floor(width / 2) * 3)];
}

test('desktop keys and batches navigate Chrome even with viewer-only settings and stale modifiers', { timeout: 45000 }, async t => {
  let browser;
  try {
    browser = findBrowserExecutable(process.env.HIVE_TEST_BROWSER);
    for (const command of ['Xvfb', 'x11vnc', 'openbox', 'xdotool']) {
      assert.equal(spawnSync('sh', ['-c', 'command -v "$1"', 'sh', command]).status, 0, `${command} is required`);
    }
  } catch (error) {
    // Release checks use an empty environment and may have no desktop dependencies.
    // An explicitly configured browser still requires this integration check to run.
    if (browserConfigured) throw error;
    t.skip(`Desktop integration dependencies are unavailable: ${error.message}`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'hive-desktop-navigation-'));
  const children = [];
  let control, devices;
  t.after(async () => {
    // Each fixture has its own process group, including the MCP server's x11vnc and
    // Chrome's children. Never stop a process belonging to the running worker.
    for (const { child } of children.reverse()) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
    }
    await Promise.all(children.map(p => p.closed));
    control?.closeAllConnections();
    if (control?.listening) await new Promise(resolve => control.close(resolve));
    await devices?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const start = (command, args, options = {}) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'], ...options });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-3000); });
    child.on('error', error => { errors += error.message; });
    children.push({ child, closed: new Promise(resolve => child.on('close', resolve)) });
    return { child, errors: () => errors };
  };
  const x = start('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  let display;
  try {
    display = await new Promise((resolve, reject) => {
      x.child.stdio[3].once('data', b => resolve(`:${String(b).trim()}`));
      x.child.once('exit', () => reject(new Error(`Xvfb could not start: ${x.errors()}`)));
      x.child.once('error', reject);
    });
  } catch (error) {
    if (releaseCheck || browserConfigured) throw error;
    t.skip(`The sandbox cannot start a private X display: ${error.message}`);
    return;
  }
  const env = { ...process.env, HOME: dir, DISPLAY: display, XAUTHORITY: '', HIVE_VM_STATE: dir,
    HIVE_TASK_LABEL: 'desktop-fixture', HIVE_TASK_STEPS: join(dir, 'steps.log') };
  start('openbox', [], { env });
  start(browser, [...desktopBrowserArgs({ profileDir: join(dir, 'profile') }).slice(0, -1),
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--disable-background-networking', 'about:blank'], { env });
  const titleExists = title => spawnSync('xdotool', ['search', '--onlyvisible', '--name', title], { env }).status === 0;
  const until = async (check, why) => {
    for (let n = 0; n < 100; n++) { if (check()) return; await sleep(100); }
    assert.fail(why);
  };
  await until(() => titleExists('about:blank'), 'the fixture browser did not open');

  // Copy only the entry point so workerDisplay finds this fixture's worker path,
  // never the installed worker's display. Its imported modules stay the release's own.
  for (const name of readdirSync(import.meta.dirname).filter(name => name.endsWith('.mjs'))) {
    if (['desktop-mcp.mjs', 'server.mjs'].includes(name)) continue;
    symlinkSync(join(import.meta.dirname, name), join(dir, name));
  }
  copyFileSync(join(import.meta.dirname, 'desktop-mcp.mjs'), join(dir, 'desktop-mcp.mjs'));
  writeFileSync(join(dir, 'server.mjs'), 'setInterval(() => {}, 1000);\n');
  start(process.execPath, [join(dir, 'server.mjs')], { env });
  let opened = false;
  control = createServer((req, res) => {
    if (req.url === '/desktop/open') opened = true;
    assert.ok(['/desktop/open', '/desktop/close'].includes(req.url));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  control.listen(join(dir, 'control.sock')); await once(control, 'listening');
  devices = serveDevices(join(dir, 'devices.sock')); await once(devices.server, 'listening');
  writeFileSync(join(dir, '.x11vncrc'), 'viewonly\n');
  assert.equal(spawnSync('xdotool', ['keydown', 'Control_L', 'Shift_L'], { env }).status, 0);
  const catalog = join(dir, 'runtime-catalog.json');
  writeFileSync(catalog, JSON.stringify({ ok: true, thread_id: 'desktop-fixture' }));
  const mcp = start(process.execPath, [join(import.meta.dirname, 'task-mcp.mjs'), catalog, join(dir, 'desktop-mcp.mjs')],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let serial = 0;
  createInterface({ input: mcp.child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.resolve(message.result);
    pending.delete(message.id);
  });
  mcp.child.on('close', () => {
    for (const p of pending.values()) p.reject(new Error(`desktop MCP exited: ${mcp.errors()}`));
    pending.clear();
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject });
    mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const result = await request('tools/call', { name, arguments: { step: 'Checking fixture navigation.', ...args } });
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  };
  await request('initialize');
  assert.ok((await request('tools/list')).tools.some(tool => tool.name === 'transfer_file'));
  await call('screenshot');
  assert.equal(opened, true);
  for (const [index, color] of [[1, [18, 166, 42]], [2, [38, 72, 184]]]) {
    const page = join(dir, `page-${index}.html`), title = `Hive navigation ${index}`;
    writeFileSync(page, `<title>${title}</title><body style="background:rgb(${color.join(',')})">${title}</body>`);
    const steps = [{ tool: 'press_key', keys: 'ctrl+l' }, { tool: 'type_text', text: pathToFileURL(page).href },
      { tool: 'press_key', keys: 'Return' }, { tool: 'wait', seconds: 1 }];
    let result;
    if (index === 1) result = await call('batch', { steps });
    else for (const { tool, ...args } of steps) result = await call(tool, args);
    await until(() => titleExists(title), 'keys reported success but the browser did not navigate');
    assert.deepEqual(center(Buffer.from(result.content.find(c => c.type === 'image').data, 'base64')), color,
      'the returned screenshot must show the page reached by those keys');
  }
});
