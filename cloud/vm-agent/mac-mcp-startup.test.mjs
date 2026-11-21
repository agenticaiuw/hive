// Exercise the actual stdio entry point and the task's generated launch arguments. The board
// and cloud storage are fixtures; no owner credentials, network, Mac or Codex account is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { codexArgs } from './hive-task.mjs';

function client(t, args, env, namespace = 'mac') {
  const config = args.filter((_, i) => args[i - 1] === '-c');
  assert.ok(config.includes(`mcp_servers.${namespace}.command="sudo"`));
  assert.ok(config.includes('mcp_servers.mac.required=true'));
  const prefix = `mcp_servers.${namespace}.args=`;
  const mac = JSON.parse(config.find(c => c.startsWith(prefix)).slice(prefix.length));
  assert.deepEqual(mac.slice(0, 4), ['-n', '-u', 'test', 'env']);
  // The VM uses sudo to change user. Emulate its cleared environment, then execute the
  // exact env command it receives. In particular, don't inherit HIVE_TASKS_CONFIG here.
  const child = spawn('env', mac.slice(4), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let serial = 0, ended = false, errors = '';
  child.stderr.on('data', b => { errors += b; });
  const stop = reason => {
    ended = true;
    for (const { reject } of waiting.values()) reject(new Error(reason));
    waiting.clear();
  };
  child.on('error', error => stop(error.message));
  child.on('close', (code, signal) => stop(`${namespace} MCP exited (${code}, ${signal}): ${errors}`));
  const closed = new Promise(resolve => child.on('close', resolve));
  t.after(async () => { child.kill('SIGTERM'); await closed; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.resolve(message);
    waiting.delete(message.id);
  });
  return {
    request(method, params = {}) {
      if (ended) return Promise.reject(new Error(`${namespace} MCP already exited: ${errors}`));
      const id = ++serial;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async close() { child.stdin.end(); await closed; },
  };
}

for (const namespace of ['mac', 'desktop']) test(`${namespace}: a task and its restart register and call Mac file tools through the configured stdio process`, { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-mac-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = join(dir, 'files');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const source = join(dir, 'clip.mov');
  const bytes = Buffer.from('A synthetic recording for the transfer test.\n');
  writeFileSync(source, bytes);
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const tasksConfig = join(dir, 'board.json');
  writeFileSync(tasksConfig, JSON.stringify({ url: 'https://board.invalid', token: 'fixture-token' }));
  const connected = join(dir, 'connected');
  const calls = join(dir, 'calls.jsonl');
  const preload = join(dir, 'board.mjs');
  writeFileSync(preload, `
import { appendFileSync, existsSync } from 'node:fs';
globalThis.fetch = async (url, options) => {
  if (options.headers.authorization !== 'Bearer fixture-token') throw new Error('Wrong board config');
  if (url === 'https://board.invalid/v1/mac/status?tools=1') {
    return Response.json({ macs: existsSync(${JSON.stringify(connected)})
      ? [{ name: 'test-mac', tools: [{ name: 'run_command', inputSchema: { type: 'object' } }] }] : [] });
  }
  if (url !== 'https://board.invalid/v1/mac/calls') throw new Error('Unexpected board route');
  const body = JSON.parse(options.body);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify(body) + '\\n');
  return Response.json({ call: { id: 1, status: 'done', result: { content: [{ type: 'text',
    text: JSON.stringify({ exit_code: 0, stdout: JSON.stringify(${JSON.stringify(expected)}) }) }] } } });
};
`);
  // files.mjs still validates the actual copied bytes. Only the external cloud CLI is replaced.
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\n[ "$1" = "-n" ] && [ "$2" = "-H" ] || exit 1\ncp "$HIVE_TEST_SOURCE" "$9"\n', { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--import=${preload}`, HIVE_TEST_SOURCE: source };
  for (const resumed of [false, true]) {
    rmSync(connected, { force: true });
    const args = codexArgs({ model: 'm', effort: 'low', workDir: dir, appDir: import.meta.dirname,
      stateDir: dir, filesDir: files, stepsFile: join(dir, 'steps.log'), label: 'R42-1', user: 'test', tasksConfig,
      improveFile: resumed ? join(dir, 'improve.json') : '' });
    // Start only this namespace: the desktop fallback must not depend on a running mac MCP.
    const mcp = client(t, args, env, namespace);
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'startup-test', version: '1' } });
    assert.equal(init.result?.serverInfo.name, namespace === 'mac' ? 'mac' : 'hive-vm-desktop', JSON.stringify(init));
    const catalog = await mcp.request('tools/list');
    if (namespace === 'mac') assert.deepEqual(catalog.result.tools.map(tool => tool.name), ['run_command', 'transfer_file']);
    const transfer = catalog.result.tools.find(tool => tool.name === 'transfer_file');
    assert.equal(transfer?.inputSchema.properties.recovery_key.type, 'string');
    const offline = await mcp.request('tools/call', { name: transfer.name, arguments: {
      direction: 'to_vm', mac_path: '/Users/test/Desktop/clip.mov', step: 'Checking the offline Mac.',
    } });
    assert.equal(offline.result.isError, true);
    assert.match(offline.result.content[0].text, /Mac isn't connected/);
    writeFileSync(connected, 'yes');
    if (namespace === 'mac') {
      const command = await mcp.request('tools/call', { name: 'run_command', arguments: {
        command: 'pwd', irreversible: false, step: 'Checking the Mac folder.',
      } });
      assert.equal(command.result.isError, undefined);
    }
    const copy = await mcp.request('tools/call', { name: transfer.name, arguments: {
      direction: 'to_vm', mac_path: '/Users/test/Desktop/clip.mov', step: 'Copying the fixture recording.',
    } });
    assert.equal(copy.result.isError, undefined, JSON.stringify(copy));
    const result = JSON.parse(copy.result.content[0].text);
    assert.ok(result.vm_path.startsWith(`${files}/transfers/`));
    assert.deepEqual(readFileSync(result.vm_path), bytes);
    assert.equal(existsSync(join(dir, 'screen-used')), false, 'copying needs no VM screen');
    await mcp.close();
  }
  const sent = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(sent.length, namespace === 'mac' ? 6 : 4, 'each transfer sends only metadata and upload commands');
  assert.ok(sent.every(call => call.name === 'run_command' && call.request === 42));
  assert.deepEqual(readFileSync(source), bytes, 'the source stays intact');
});

test('desktop lists transfers without board configuration and reports a call error', { timeout: 5000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-desktop-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = codexArgs({ model: 'm', effort: 'low', workDir: dir, appDir: import.meta.dirname, stateDir: dir,
    filesDir: dir, stepsFile: join(dir, 'steps.log'), user: 'test', tasksConfig: join(dir, 'missing.json') });
  const mcp = client(t, args, { PATH: process.env.PATH }, 'desktop');
  assert.ok((await mcp.request('initialize')).result);
  const catalog = await mcp.request('tools/list');
  assert.ok(catalog.result.tools.some(tool => tool.name === 'transfer_file'));
  const out = await mcp.request('tools/call', { name: 'transfer_file', arguments: {
    direction: 'to_vm', mac_path: '/Users/test/Desktop/clip.mov', step: 'Copying the fixture recording.',
  } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /missing\.json/);
  assert.equal(existsSync(join(dir, 'screen-used')), false);
  await mcp.close();
});

test('the stdio handshake reports an unreadable board config instead of an empty catalog', { timeout: 5000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-mac-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = codexArgs({ model: 'm', effort: 'low', workDir: dir, appDir: import.meta.dirname, stateDir: dir,
    filesDir: dir, stepsFile: join(dir, 'steps.log'), user: 'test', tasksConfig: join(dir, 'missing.json') });
  const mcp = client(t, args, { PATH: process.env.PATH });
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.error?.code, -32603);
  assert.match(init.error.message, /board configuration/);
  await mcp.close();
});
