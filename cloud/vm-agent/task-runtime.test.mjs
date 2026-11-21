import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { TRANSFER_TOOL, transferFile } from './mac-files.mjs';
import { STARTUP_PROBE, runRuntime, startTask, taskEvent } from './task-runtime.mjs';
import { forward } from './task-mcp.mjs';

const mac = { name: 'mac', runtimeStatus: 'connected', toolsError: null,
  tools: { run_command: { inputSchema: { type: 'object' } }, transfer_file: TRANSFER_TOOL } };
const ready = { content: [{ type: 'text', text: JSON.stringify({ ready: true, copied: false,
  direction: 'to_vm', mac_path: STARTUP_PROBE.mac_path }) }] };

function fixture(t) {
  const workDir = mkdtempSync(join(tmpdir(), 'hive-task-runtime-probe-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  return { workDir, catalog: join(workDir, 'runtime-catalog.json') };
}

for (const scenario of ['ready', 'missing-mac', 'disconnected', 'missing-command', 'missing-transfer', 'bad-schema',
  'offline', 'bad-reply', 'wrong-path', 'rpc-error']) {
  test(`repair checks the actual thread before submitting any task prompt: ${scenario}`, async t => {
    const { workDir, catalog } = fixture(t);
    const server = structuredClone(mac);
    if (scenario === 'disconnected') server.runtimeStatus = 'failed';
    if (scenario === 'missing-command') delete server.tools.run_command;
    if (scenario === 'missing-transfer') delete server.tools.transfer_file;
    if (scenario === 'bad-schema') server.tools.transfer_file.inputSchema.properties.check_only.type = 'string';
    const calls = [], events = [];
    const request = async (method, params) => {
      calls.push({ method, params });
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'current' } };
      assert.equal(params.threadId, 'current', 'discovery, probe and task must share one thread');
      if (method === 'mcpServerStatus/list') return { data: scenario === 'missing-mac' ? [] : [server] };
      if (method === 'mcpServer/tool/call') {
        assert.deepEqual(params.arguments, STARTUP_PROBE);
        assert.equal(params.server, 'mac');
        assert.equal(params.tool, 'transfer_file');
        assert.deepEqual(JSON.parse(readFileSync(`${catalog}.startup`, 'utf8')), { thread_id: 'current' });
        if (scenario === 'rpc-error') throw new Error('Route unavailable');
        if (scenario === 'offline') return { isError: true, content: [{ type: 'text', text: 'Mac is offline.' }] };
        if (scenario === 'bad-reply') return { content: [{ type: 'text', text: 'ready=true' }] };
        if (scenario === 'wrong-path') return { content: [{ type: 'text', text: ready.content[0].text.replace(STARTUP_PROBE.mac_path, '/elsewhere') }] };
        return ready;
      }
      assert.equal(method, 'turn/start');
      assert.equal(existsSync(`${catalog}.startup`), false, 'the model cannot use the startup allowance');
      assert.equal(params.input[0].text, 'Continue the unfinished task.');
      assert.deepEqual(JSON.parse(readFileSync(`${catalog}.probe`, 'utf8')), { thread_id: 'current', ready: true });
      return {};
    };
    // Stale evidence cannot skip this thread's discovery or probe.
    writeFileSync(`${catalog}.probe`, JSON.stringify({ thread_id: 'old', ready: true }));
    const run = startTask(request, { model: 'fixture', effort: 'low', workDir,
      prompt: 'Continue the unfinished task.', emit: event => events.push(event) });
    if (scenario === 'ready') {
      assert.equal(await run, 'current');
      assert.deepEqual(calls.map(call => call.method), ['initialize', 'thread/start', 'mcpServerStatus/list', 'mcpServer/tool/call', 'turn/start']);
      assert.equal(events.at(-1).item.result, ready);
    } else {
      await assert.rejects(run, /not resumed|Route unavailable/);
      assert.equal(calls.some(call => call.method === 'turn/start'), false);
      assert.equal(events.some(event => event.type === 'item.completed'), false);
    }
    assert.equal(existsSync(`${catalog}.startup`), false);
  });
}

test('startup allowance passes only the fixed Mac probe and does not unlock ordinary calls', async t => {
  const { catalog } = fixture(t);
  writeFileSync(`${catalog}.startup`, JSON.stringify({ thread_id: 'current' }));
  writeFileSync(catalog, JSON.stringify({ ok: false, why: 'Model catalog not verified.' }));
  const call = { id: 1, method: 'tools/call', params: { name: 'transfer_file', arguments: STARTUP_PROBE } };
  const sent = [], replies = [];
  const dispatch = (message, server = 'mac') => forward(message, catalog, value => sent.push(value), value => replies.push(value), server);
  await dispatch(call);
  for (const args of [{ ...STARTUP_PROBE, check_only: false }, { ...STARTUP_PROBE, mac_path: '/Desktop/clip.mov' },
    { ...STARTUP_PROBE, direction: 'to_mac' }, { ...STARTUP_PROBE, vm_path: '/tmp/clip.mov' }]) {
    await dispatch({ ...call, params: { ...call.params, arguments: args } });
  }
  await dispatch(call, 'desktop');
  await dispatch({ ...call, params: { name: 'run_command', arguments: { command: '/usr/bin/true' } } });
  rmSync(`${catalog}.startup`);
  await dispatch(call);
  assert.deepEqual(sent, [call]);
  assert.equal(replies.length, 7);
  assert.ok(replies.every(reply => reply.result.isError));
  assert.equal(existsSync(`${catalog}.probe`), false);
});

test('runtime transport preserves task reports, usage and one thread across startup and the turn', async t => {
  const { workDir } = fixture(t);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => { child.stdout.end(); child.emit('close', 0); };
  const methods = [];
  const send = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const { id, method, params } = JSON.parse(chunk);
    methods.push(method);
    let result = {};
    if (method === 'thread/start') result = { thread: { id: 'current' } };
    if (method === 'mcpServerStatus/list') result = { data: [mac] };
    if (method === 'mcpServer/tool/call') result = ready;
    queueMicrotask(() => {
      send({ id, result });
      if (method === 'turn/start') {
        assert.equal(params.threadId, 'current');
        send({ method: 'item/completed', params: { threadId: 'other', item: { type: 'agentMessage', text: 'Wrong task.' } } });
        send({ method: 'item/completed', params: { threadId: 'current', item: { type: 'agentMessage', text: 'Finished.' } } });
        send({ method: 'thread/tokenUsage/updated', params: { threadId: 'current', tokenUsage: { total: { inputTokens: 12, outputTokens: 3 } } } });
        send({ method: 'turn/completed', params: { threadId: 'current', turn: { status: 'completed' } } });
      }
    });
    callback();
  } });
  const events = [];
  assert.equal(await runRuntime({ spawnProcess: () => child,
    model: 'fixture', effort: 'low', workDir, prompt: 'Continue.', emit: event => events.push(event) }), 0);
  assert.deepEqual(methods, ['initialize', 'thread/start', 'mcpServerStatus/list', 'mcpServer/tool/call', 'turn/start']);
  assert.deepEqual(events.filter(event => event.item?.type === 'agent_message').map(event => event.item.text), ['Finished.']);
  assert.deepEqual(events.at(-1), { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } });
});

test('failed turns remain failures and completed MCP calls retain their probe result', () => {
  assert.deepEqual(taskEvent('turn/completed', { turn: { status: 'failed', error: { message: 'Missing tools.' } } }),
    { type: 'turn.failed', error: { message: 'Missing tools.' } });
  assert.equal(taskEvent('item/completed', { item: { type: 'mcpToolCall', result: ready } }).item.result, ready);
});

test('the startup arguments pass the real transfer handler and run only a harmless Mac command', async () => {
  const commands = [];
  const result = await transferFile(STARTUP_PROBE, async args => {
    commands.push(args);
    return { content: [{ type: 'text', text: JSON.stringify({ exit_code: 0 }) }] };
  }, { fetch: () => assert.fail('A startup probe cannot fetch a file'), put: () => assert.fail('A startup probe cannot upload a file') });
  assert.deepEqual(result, ready);
  assert.deepEqual(commands, [{ command: '/usr/bin/true', irreversible: false, timeout_seconds: 15, step: STARTUP_PROBE.step }]);
});
