// Check both Codex's dispatcher and the owner exec's actual model request. The board and cloud
// CLI are fixtures; exec uses an unreachable local provider, with no live model or owner credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { codexArgs, GUIDE } from './hive-task.mjs';
import { readTaskCatalog } from './task-catalog.mjs';

const codex = process.env.HIVE_TEST_CODEX ?? '/root/.local/bin/codex';
const options = dir => ({ model: 'fixture', effort: 'low', workDir: dir, appDir: import.meta.dirname,
  stateDir: dir, filesDir: join(dir, 'files'), stepsFile: join(dir, 'steps'), user: 'test', label: 'R42-1',
  tasksConfig: join(dir, 'board.json') });

test('new and repaired tasks require the dedicated transfer catalog and a probe in the current execution', () => {
  for (const improveFile of ['', '/tmp/repair.json']) {
    const args = codexArgs({ ...options('/tmp/task'), improveFile });
    assert.ok(args.includes('features.code_mode_only_strict_3p_tools=false'));
    for (const name of ['mac', 'desktop', 'hivefiles']) {
      assert.ok(args.includes(`mcp_servers.${name}.required=true`));
      assert.ok(args.includes(`mcp_servers.${name}.startup_readiness="catalog"`));
      assert.ok(args.includes(`mcp_servers.${name}.omit_tools_from=["deferred"]`));
    }
  }
  assert.match(GUIDE, /in ALL_TOOLS and check that the matching tools property is a function/);
  assert.match(GUIDE, /When functions.exec is unavailable, use the directly exposed/);
  assert.match(GUIDE, /missing name in ALL_TOOLS alone does not prove the tool is absent/);
  assert.match(GUIDE, /Search ALL_TOOLS for transfer_file/);
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

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-mac-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  const bytes = Buffer.from('Synthetic recording for the task catalog test.\n');
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const source = join(dir, 'source.mov');
  writeFileSync(source, bytes);
  writeFileSync(join(dir, 'runtime-catalog.json'), JSON.stringify({ thread_id: 'fixture-dispatch', ok: true }));
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ url: 'https://board.invalid', token: 'fixture' }));
  // Emulate the VM's sudo user change; credentials and external programs remain fixtures.
  writeFileSync(join(dir, 'bin', 'sudo'), '#!/bin/sh\n[ "$1" = "-n" ] && [ "$2" = "-u" ] || exit 1\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const preload = join(dir, 'fixture.mjs');
  writeFileSync(preload, `
import { appendFileSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const dir = ${JSON.stringify(dir)};
// A connected process is not yet a usable catalog. Make that gap visible to thread/start.
if (process.argv[1].endsWith('/desktop-mcp.mjs')) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    if (String(chunk).includes('"tools":[')) {
      setTimeout(() => {
        writeFileSync(dir + '/desktop-listed', 'yes');
        write(chunk, ...args);
      }, 500);
      return true;
    }
    return write(chunk, ...args);
  };
}
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
  return { dir, bytes, expected, source, preload };
}

test('Codex discovers, probes and transfers in each task thread, including a repair retry', {
  skip: !existsSync(codex) && 'Set HIVE_TEST_CODEX to the installed Codex CLI to check the runtime boundary', timeout: 45000,
}, async t => {
  const { dir, bytes, expected, source, preload } = fixture(t);
  for (const [repaired, macEnabled] of [[false, true], [true, true], [true, false]]) {
    rmSync(join(dir, 'connected'), { force: true });
    rmSync(join(dir, 'desktop-listed'), { force: true });
    const args = codexArgs({ ...options(dir), improveFile: repaired ? join(dir, 'repair.json') : '' });
    // Use every generated server setting. The empty home is the equivalent of exec's
    // --ignore-user-config; thread/start carries its cwd, sandbox, model and ephemeral flag.
    const config = args.filter((_, i) => args[i - 1] === '-c');
    for (const name of ['desktop', 'phone', 'browser', 'knowledge', 'mac', 'hivefiles']) {
      config.push(`mcp_servers.${name}.env.NODE_OPTIONS=${JSON.stringify(`--import=${preload}`)}`,
        `mcp_servers.${name}.env.HIVE_TASKS_CONFIG=${JSON.stringify(join(dir, 'board.json'))}`);
    }
    config.push('model_provider="fixture"', 'model_providers.fixture.name="Offline fixture"',
      'model_providers.fixture.base_url="http://127.0.0.1:1"', 'model_providers.fixture.wire_api="responses"');
    // The fallback must remain callable when Codex has no Mac namespace at all.
    if (!macEnabled) config.push('mcp_servers.mac.enabled=false');
    const rpc = client(t, config, dir);
    await rpc.request('initialize', { clientInfo: { name: 'hive-catalog-test', version: '1' }, capabilities: { experimentalApi: true } });
    const started = await rpc.request('thread/start', { cwd: dir, model: 'fixture', ephemeral: true,
      approvalPolicy: 'never', sandbox: 'read-only' });
    assert.ok(existsSync(join(dir, 'desktop-listed')), 'thread/start must wait for the desktop catalog');
    const threadId = started.thread.id;
    for (const namespace of macEnabled ? ['mac', 'desktop', 'hivefiles'] : ['desktop', 'hivefiles']) {
      rmSync(join(dir, 'connected'), { force: true });
      const catalog = await rpc.request('mcpServerStatus/list', { threadId, serverName: namespace });
      const server = catalog.data.find(s => s.name === namespace);
      assert.equal(server?.runtimeStatus, 'connected');
      assert.equal(server.toolsError, null);
      if (namespace === 'mac') assert.deepEqual(Object.keys(server.tools).sort(), ['run_command', 'transfer_file']);
      assert.equal(server.tools.transfer_file.inputSchema.properties.check_only.type, 'boolean');
      const call = arguments_ => rpc.request('mcpServer/tool/call', { threadId, server: namespace, tool: 'transfer_file', arguments: arguments_ });
      const transfer = { direction: 'to_vm', mac_path: '/Desktop/clip.mov', step: 'Checking the fixture transfer.' };
      const offline = await call({ ...transfer, check_only: true });
      assert.equal(offline.isError, true, 'discovery is not proof the Mac is connected');
      writeFileSync(join(dir, 'connected'), 'yes');
      const before = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
      const probe = await call({ ...transfer, check_only: true });
      assert.ok(!probe.isError, JSON.stringify(probe));
      assert.deepEqual(JSON.parse(probe.content[0].text), { ready: true, copied: false, direction: 'to_vm', mac_path: '/Desktop/clip.mov' });
      const after = readFileSync(join(dir, 'calls'), 'utf8');
      const probeCall = JSON.parse(after.slice(before.length).trim());
      assert.equal(probeCall.arguments.command, '/usr/bin/true');
      const result = await call(transfer);
      assert.ok(!result.isError, JSON.stringify(result));
      const copied = JSON.parse(result.content[0].text);
      assert.ok(copied.vm_path.startsWith(join(dir, 'files', 'transfers')));
      assert.deepEqual(readFileSync(copied.vm_path), bytes);
      assert.equal(copied.sha256, expected.sha256);
      t.diagnostic(`${repaired ? 'repair retry' : 'new task'}: ${namespace}${macEnabled ? '' : ' without mac MCP'} thread catalog, live probe and verified copy passed`);
    }
    await rpc.close();
  }
  const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 24);
  assert.ok(calls.every(c => c.request === 42 && c.name === 'run_command'));
  assert.deepEqual(readFileSync(source), bytes);
});

for (const exposure of ['deferred', 'direct-only', 'code-mode']) test(`owner exec with code mode: ${exposure}`, {
  skip: !existsSync(codex) && 'Set HIVE_TEST_CODEX to check the owner exec runtime', timeout: 30000,
}, async t => {
  const { dir, preload } = fixture(t);
  // The old app-server test used an unknown model, whose fallback metadata uses direct tools.
  // Owner models use code_mode_only and Responses Lite; exercise that provisioning path too.
  const models = join(dir, 'models.json');
  writeFileSync(models, JSON.stringify({ models: [{ slug: 'fixture', display_name: 'Fixture', description: 'Offline test',
    base_instructions: 'Use the tools to carry out the task.',
    default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low', description: 'Low' }],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0,
    tool_mode: 'code_mode_only', use_responses_lite: true, supports_search_tool: true,
    default_reasoning_summary: 'none', support_verbosity: true, default_verbosity: 'low',
    truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 32000,
    effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'],
  }] }));
  const args = codexArgs({ ...options(dir), improveFile: join(dir, 'repair.json') });
  if (exposure === 'deferred') {
    // Registration alone must exclude every exposure override, including the server
    // settings that keep transfers available without deferred discovery.
    for (const setting of [
      'features.code_mode_only_strict_3p_tools=false',
      ...['desktop', 'mac', 'hivefiles'].map(name => `mcp_servers.${name}.omit_tools_from=["deferred"]`),
    ]) {
      const at = args.indexOf(setting);
      assert.ok(at > 0 && args[at - 1] === '-c', `Missing exposure setting: ${setting}`);
      args.splice(at - 1, 2);
    }
  }
  if (exposure === 'direct-only') {
    // Earlier repairs passed the direct catalog check while removing these methods
    // from ALL_TOOLS and the tools object. That must fail this task's runtime audit.
    args.splice(-1, 0, '-c', 'features.code_mode.direct_only_tool_namespaces=["mcp__desktop","mcp__mac","mcp__hivefiles"]');
    for (let i = 0; i < args.length; i++) {
      args[i] = args[i].replace('omit_tools_from=["deferred"]', 'omit_tools_from=["code_mode","deferred"]');
    }
  }
  const config = [`model_catalog_json=${JSON.stringify(models)}`, 'model_provider="fixture"',
    'model_providers.fixture.name="Offline fixture"', 'model_providers.fixture.base_url="http://127.0.0.1:1"',
    'model_providers.fixture.wire_api="responses"'];
  for (const name of ['desktop', 'phone', 'browser', 'knowledge', 'mac', 'hivefiles']) {
    config.push(`mcp_servers.${name}.env.NODE_OPTIONS=${JSON.stringify(`--import=${preload}`)}`,
      `mcp_servers.${name}.env.HIVE_TASKS_CONFIG=${JSON.stringify(join(dir, 'board.json'))}`);
  }
  args.splice(-1, 0, ...config.flatMap(c => ['-c', c]));
  const trace = join(dir, 'trace');
  const child = spawn(codex, args, { cwd: dir, detached: true,
    env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, CODEX_HOME: dir, CODEX_ROLLOUT_TRACE_ROOT: trace },
    stdio: ['pipe', 'pipe', 'pipe'] });
  let thread = '', errors = '', ended = false;
  const closed = new Promise(resolve => child.on('close', () => { ended = true; resolve(); }));
  child.stderr.on('data', b => { errors = (errors + b).slice(-4000); });
  child.on('error', error => { errors += error.message; });
  createInterface({ input: child.stdout }).on('line', line => {
    const event = JSON.parse(line);
    if (event.type === 'thread.started') thread = event.thread_id;
  });
  t.after(async () => {
    // Kill the group, including the CLI's native child and MCP servers, before removing fixtures.
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await closed;
  });
  child.stdin.end('Check which file transfer tools are callable. Do not copy or publish anything.');
  const until = Date.now() + 20000;
  let catalog;
  while (!ended && Date.now() < until && !(catalog = readTaskCatalog(trace, thread))) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(catalog, `exec did not record its model request: ${errors}`);
  const callable = exposure === 'code-mode';
  assert.equal(catalog.ok, callable, JSON.stringify(catalog));
  assert.equal(catalog.code_tools.includes('mcp__mac.transfer_file'), callable);
  assert.equal(catalog.code_tools.includes('mcp__mac.run_command'), callable);
  assert.equal(catalog.tools.includes('mcp__desktop.transfer_file'), exposure === 'direct-only');
  assert.ok(catalog.tools.includes('functions.exec'), 'the model really uses code mode');
  t.diagnostic(`Owner exec thread ${thread}: code-mode transfer catalog ${catalog.ok ? 'verified' : 'absent without the repair'}.`);
});
