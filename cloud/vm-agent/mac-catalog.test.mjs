// Use Codex's thread catalog and dispatcher, not a second client talking straight to MCP.
// Only the board and cloud CLI are fixtures. No model request or owner credentials are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { codexArgs, GUIDE } from './hive-task.mjs';

const codex = process.env.HIVE_TEST_CODEX ?? '/root/.local/bin/codex';
const options = dir => ({ model: 'fixture', effort: 'low', workDir: dir, appDir: import.meta.dirname,
  stateDir: dir, filesDir: join(dir, 'files'), stepsFile: join(dir, 'steps'), user: 'test', label: 'R42-1',
  tasksConfig: join(dir, 'board.json') });

test('new and repaired tasks require the Mac catalog and a probe in the current execution', () => {
  for (const improveFile of ['', '/tmp/repair.json']) {
    const args = codexArgs({ ...options('/tmp/task'), improveFile });
    assert.ok(args.includes('mcp_servers.mac.required=true'));
    assert.ok(args.includes('mcp_servers.mac.startup_readiness="catalog"'));
  }
  assert.match(GUIDE, /missing name in ALL_TOOLS alone does not prove the tool is absent/);
  assert.match(GUIDE, /search deferred tools with tool_search/);
  assert.match(GUIDE, /check_only=true[\s\S]*Require ready=true/);
});

function client(t, config, dir) {
  const child = spawn(codex, ['app-server', ...config.flatMap(c => ['-c', c])], {
    cwd: dir, env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, CODEX_HOME: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let serial = 0, errors = '', ended = false;
  const waiting = new Map();
  const fail = reason => {
    ended = true;
    for (const p of waiting.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    waiting.clear();
  };
  child.stderr.on('data', b => { errors = (errors + b).slice(-8000); });
  child.on('error', error => fail(error.message));
  child.on('exit', code => fail(`Codex exited (${code}): ${errors}`));
  const closed = new Promise(resolve => child.on('close', resolve));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    const p = waiting.get(message.id);
    if (!p) return;
    waiting.delete(message.id); clearTimeout(p.timer);
    if (message.error) p.reject(new Error(JSON.stringify(message.error)));
    else p.resolve(message.result);
  });
  const close = async () => {
    child.stdin.destroy(); child.kill('SIGKILL');
    lines.close(); child.stdout.destroy(); child.stderr.destroy();
    await closed;
  };
  t.after(close);
  return {
    close,
    request(method, params = {}) {
      if (ended) return Promise.reject(new Error(`Codex already exited: ${errors}`));
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id); reject(new Error(`${method} timed out: ${errors}`));
        }, 15000);
        waiting.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
  };
}

test('Codex discovers, probes and transfers in each task thread, including a repair retry', {
  skip: !existsSync(codex) && 'Set HIVE_TEST_CODEX to the installed Codex CLI to check the runtime boundary', timeout: 45000,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-mac-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  const bytes = Buffer.from('Synthetic recording for the task catalog test.\n');
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const source = join(dir, 'source.mov');
  writeFileSync(source, bytes);
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ url: 'https://board.invalid', token: 'fixture' }));
  // Emulate the VM's sudo user change; credentials and external programs remain fixtures.
  writeFileSync(join(dir, 'bin', 'sudo'), '#!/bin/sh\n[ "$1" = "-n" ] && [ "$2" = "-u" ] || exit 1\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const preload = join(dir, 'fixture.mjs');
  writeFileSync(preload, `
import { appendFileSync, existsSync, copyFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const dir = ${JSON.stringify(dir)};
globalThis.fetch = async (url, options) => {
  if (options.headers.authorization !== 'Bearer fixture') throw new Error('Wrong board config');
  if (url === 'https://board.invalid/v1/mac/status?tools=1') return Response.json({ macs: existsSync(dir + '/connected')
    ? [{ name: 'fixture-mac', tools: [{ name: 'run_command', description: 'Fixture command', inputSchema: { type: 'object' } }] }] : [] });
  if (url !== 'https://board.invalid/v1/mac/calls') throw new Error('Unexpected board route');
  appendFileSync(dir + '/calls', options.body + '\\n');
  return Response.json({ call: { id: 1, status: 'done', result: { content: [{ type: 'text',
    text: JSON.stringify({ exit_code: 0, stdout: JSON.stringify(${JSON.stringify(expected)}) }) }] } } });
};
// fetchFile still verifies the actual copied bytes against size and SHA-256.
childProcess.execFile = (command, args, options, callback) => {
  if (command !== 'sudo' || args[1] !== '-H' || !args[4].startsWith('wrangler r2 object get')) throw new Error('Unexpected cloud command');
  copyFileSync(dir + '/source.mov', args[8]);
  queueMicrotask(() => callback(null, '', ''));
};
syncBuiltinESMExports();
`);
  for (const repaired of [false, true]) {
    rmSync(join(dir, 'connected'), { force: true });
    const args = codexArgs({ ...options(dir), improveFile: repaired ? join(dir, 'repair.json') : '' });
    // Use every generated server setting. The empty home is the equivalent of exec's
    // --ignore-user-config; thread/start carries its cwd, sandbox, model and ephemeral flag.
    const config = args.filter((_, i) => args[i - 1] === '-c');
    for (const name of ['desktop', 'phone', 'browser', 'knowledge', 'mac']) {
      config.push(`mcp_servers.${name}.env.NODE_OPTIONS=${JSON.stringify(`--import=${preload}`)}`,
        `mcp_servers.${name}.env.HIVE_TASKS_CONFIG=${JSON.stringify(join(dir, 'board.json'))}`);
    }
    config.push('model_provider="fixture"', 'model_providers.fixture.name="Offline fixture"',
      'model_providers.fixture.base_url="http://127.0.0.1:1"', 'model_providers.fixture.wire_api="responses"');
    const rpc = client(t, config, dir);
    await rpc.request('initialize', { clientInfo: { name: 'hive-catalog-test', version: '1' }, capabilities: { experimentalApi: true } });
    const started = await rpc.request('thread/start', { cwd: dir, model: 'fixture', ephemeral: true,
      approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = started.thread.id;
    const catalog = await rpc.request('mcpServerStatus/list', { threadId, serverName: 'mac' });
    const mac = catalog.data.find(s => s.name === 'mac');
    assert.equal(mac?.runtimeStatus, 'connected');
    assert.equal(mac.toolsError, null);
    assert.deepEqual(Object.keys(mac.tools).sort(), ['run_command', 'transfer_file']);
    assert.equal(mac.tools.transfer_file.inputSchema.properties.check_only.type, 'boolean');
    const call = arguments_ => rpc.request('mcpServer/tool/call', { threadId, server: 'mac', tool: 'transfer_file', arguments: arguments_ });
    const transfer = { direction: 'to_vm', mac_path: '/Desktop/clip.mov', step: 'Checking the fixture transfer.' };
    const offline = await call({ ...transfer, check_only: true });
    assert.equal(offline.isError, true, 'discovery is not proof the Mac is connected');
    writeFileSync(join(dir, 'connected'), 'yes');
    const before = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
    const probe = await call({ ...transfer, check_only: true });
    assert.ok(!probe.isError, JSON.stringify(probe));
    assert.deepEqual(JSON.parse(probe.content[0].text), { ready: true, copied: false, direction: 'to_vm', mac_path: '/Desktop/clip.mov' });
    assert.equal(existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '', before);
    const result = await call(transfer);
    assert.ok(!result.isError, JSON.stringify(result));
    const copied = JSON.parse(result.content[0].text);
    assert.ok(copied.vm_path.startsWith(join(dir, 'files', 'transfers')));
    assert.deepEqual(readFileSync(copied.vm_path), bytes);
    assert.equal(copied.sha256, expected.sha256);
    t.diagnostic(`${repaired ? 'repair retry' : 'new task'}: thread catalog, live probe and verified copy passed`);
    await rpc.close();
  }
  const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.request === 42 && c.name === 'run_command'));
  assert.deepEqual(readFileSync(source), bytes);
});
