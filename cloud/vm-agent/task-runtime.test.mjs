import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { TRANSFER_TOOL, transferFile } from './mac-files.mjs';
import { CATALOG_PROBE, STARTUP_PROBE, TRANSFER_TOOLS, runRuntime, startTask, taskEvent } from './task-runtime.mjs';
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

test('ordinary tasks bind the transfer without contacting the Mac before the owner turn', async t => {
  const { workDir } = fixture(t);
  const methods = [];
  const thread = await startTask(async (method, params) => {
    methods.push(method);
    if (method === 'initialize') return {};
    assert.equal(method, 'thread/start');
    assert.deepEqual(params.dynamicTools, TRANSFER_TOOLS);
    return { thread: { id: 'current' } };
  }, { workDir, emit: () => {} });
  assert.equal(thread, 'current');
  assert.deepEqual(methods, ['initialize', 'thread/start']);
});

test('a continuation without a repair note probes and copies through its bound transfer', async t => {
  const { workDir } = fixture(t);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => { child.stdout.end(); child.emit('close', 0); };
  const bytes = Buffer.from('Synthetic recording.');
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const destination = join(workDir, 'clip.mov');
  const copy = { direction: 'to_vm', mac_path: '/Desktop/clip.mov', step: 'Copy the recording for the continued task.' };
  const prompt = 'Continue the blocked task using the video on the Mac. Check for duplicates before posting once.';
  const commands = [], replies = [], prompts = [];
  const send = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  const invoke = args => send({ id: `transfer-${replies.length}`, method: 'item/tool/call', params: {
    threadId: 'current', tool: 'hivefiles__transfer_file', arguments: args,
  } });
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const { id, method, params, result } = JSON.parse(chunk);
    const handle = async () => {
      if (!method) {
        assert.equal(result.success, true);
        replies.push(JSON.parse(result.contentItems[0].text));
        if (replies.length === 1) invoke(copy);
        else send({ method: 'turn/completed', params: { threadId: 'current', turn: { status: 'completed' } } });
        return;
      }
      let out = {};
      if (method === 'thread/start') {
        assert.deepEqual(params.dynamicTools, TRANSFER_TOOLS);
        out = { thread: { id: 'current' } };
      } else if (method === 'mcpServer/tool/call') {
        assert.equal(params.threadId, 'current');
        assert.equal(params.server, 'mac');
        assert.equal(params.tool, 'transfer_file');
        out = await transferFile(params.arguments, async args => {
          commands.push(args.command);
          return { content: [{ type: 'text', text: JSON.stringify({ exit_code: 0, stdout: JSON.stringify(expected) }) }] };
        }, { fetch: async (key, metadata) => {
          assert.deepEqual(metadata, expected);
          writeFileSync(destination, bytes);
          return destination;
        } });
      } else assert.ok(['initialize', 'turn/start'].includes(method), `Unexpected preflight: ${method}`);
      send({ id, result: out });
      if (method === 'turn/start') {
        prompts.push(params.input[0].text);
        invoke({ ...copy, check_only: true });
      }
    };
    handle().then(() => callback(), callback);
  } });
  assert.equal(await runRuntime({ spawnProcess: () => child, workDir, prompt, emit: () => {} }), 0);
  assert.deepEqual(prompts, [prompt], 'preserve the continuation and its duplicate check without adding another task');
  assert.equal(replies[0].ready, true);
  assert.equal(replies[0].copied, false);
  assert.equal(replies[1].vm_path, destination);
  assert.equal(replies[1].sha256, expected.sha256);
  assert.deepEqual(readFileSync(destination), bytes);
  assert.equal(commands.length, 3, 'probe, source metadata, then one upload');
  assert.equal(commands[0], '/usr/bin/true');
});

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
      if (method === 'thread/start') {
        assert.deepEqual(params.dynamicTools, TRANSFER_TOOLS);
        assert.equal(params.dynamicTools[0].type, 'function');
        assert.equal(params.dynamicTools[0].name, 'hivefiles__transfer_file');
        assert.equal(params.dynamicTools[0].deferLoading, false);
        return { thread: { id: 'current' } };
      }
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
      assert.equal(params.input[0].text, CATALOG_PROBE);
      assert.notEqual(JSON.parse(readFileSync(`${catalog}.probe`, 'utf8')).thread_id, 'current',
        'dispatcher success cannot unlock the owner task');
      return {};
    };
    // Stale evidence cannot skip this thread's discovery or probe.
    writeFileSync(`${catalog}.probe`, JSON.stringify({ thread_id: 'old', ready: true }));
    const run = startTask(request, { model: 'fixture', effort: 'low', workDir, probeRequired: true,
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

for (const scenario of ['ready', 'no-call', 'wrong-thread', 'wrong-tool', 'wrong-namespace', 'unsafe-probe', 'failed-probe', 'rpc-error', 'failed-turn']) {
  test(`only a model-invoked transfer unlocks the owner prompt: ${scenario}`, async t => {
    const { workDir, catalog } = fixture(t);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { child.stdout.end(); child.emit('close', 0); };
    const methods = [], prompts = [], toolReplies = [];
    const copy = { direction: 'to_vm', mac_path: '/Desktop/clip.mov', step: 'Copying the fixture recording.' };
    const copied = { content: [{ type: 'text', text: JSON.stringify({ vm_path: '/tmp/fixture.mov', copied: true }) }] };
    let probes = 0;
    const send = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    const complete = () => send({ method: 'turn/completed', params: { threadId: 'current',
      turn: { status: scenario === 'failed-turn' ? 'failed' : 'completed' } } });
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const { id, method, params, result: reply } = JSON.parse(chunk);
      if (!method) {
        toolReplies.push(reply);
        queueMicrotask(() => {
          if (prompts.length === 2) {
            send({ method: 'item/completed', params: { threadId: 'other', item: { type: 'agentMessage', text: 'Wrong task.' } } });
            send({ method: 'item/completed', params: { threadId: 'current', item: { type: 'agentMessage', text: 'Finished.' } } });
            send({ method: 'thread/tokenUsage/updated', params: { threadId: 'current', tokenUsage: { total: { inputTokens: 12, outputTokens: 3 } } } });
          }
          complete();
        });
        callback();
        return;
      }
      methods.push(method);
      let result = {}, error;
      if (method === 'thread/start') {
        assert.deepEqual(params.dynamicTools[0].inputSchema, TRANSFER_TOOL.inputSchema);
        result = { thread: { id: 'current' } };
      }
      if (method === 'mcpServerStatus/list') result = { data: [mac] };
      if (method === 'mcpServer/tool/call') {
        probes++;
        assert.equal(params.threadId, 'current');
        assert.equal(params.server, 'mac');
        assert.deepEqual(params.arguments, probes <= 2 ? STARTUP_PROBE : copy);
        assert.equal(existsSync(`${catalog}.startup`), probes === 1);
        result = probes === 3 ? copied : probes === 2 && scenario === 'failed-probe' ? { isError: true, content: [] } : ready;
        if (probes === 2 && scenario === 'rpc-error') error = { message: 'Transfer unavailable.' };
      }
      queueMicrotask(() => {
        send({ id, result, ...(error ? { error } : {}) });
        if (method !== 'turn/start') return;
        prompts.push(params.input[0].text);
        assert.equal(params.threadId, 'current');
        if (prompts.length === 1) {
          assert.equal(prompts[0], CATALOG_PROBE);
          assert.equal(existsSync(`${catalog}.probe`), false);
          if (scenario === 'no-call') { complete(); return; }
          send({ id: 'model-transfer', method: 'item/tool/call', params: {
            threadId: scenario === 'wrong-thread' ? 'other' : 'current', turnId: 'probe', callId: 'transfer',
            namespace: scenario === 'wrong-namespace' ? 'hivefiles' : null,
            tool: scenario === 'wrong-tool' ? 'run_command' : 'hivefiles__transfer_file',
            arguments: { ...STARTUP_PROBE, ...(scenario === 'unsafe-probe' ? { check_only: false } : {}) },
          } });
        } else {
          assert.equal(prompts[1], 'Continue the unfinished task.');
          assert.deepEqual(JSON.parse(readFileSync(`${catalog}.probe`, 'utf8')), { thread_id: 'current', ready: true });
          send({ id: 'model-copy', method: 'item/tool/call', params: {
            threadId: 'current', turnId: 'owner', callId: 'copy',
            tool: 'hivefiles__transfer_file', arguments: copy,
          } });
        }
      });
      callback();
    } });
    const events = [];
    const run = runRuntime({ spawnProcess: () => child, model: 'fixture', effort: 'low', workDir, probeRequired: true,
      prompt: 'Continue the unfinished task.', emit: event => events.push(event) });
    if (scenario === 'ready') {
      assert.equal(await run, 0);
      assert.equal(prompts.length, 2);
      assert.equal(probes, 3, 'both probes and the owner transfer must traverse the same Mac route');
      assert.deepEqual(toolReplies, [ready, copied].map(result => ({ success: true,
        contentItems: [{ type: 'inputText', text: result.content[0].text }] })));
      assert.deepEqual(events.filter(event => event.item?.type === 'agent_message').map(event => event.item.text), ['Finished.']);
      assert.deepEqual(events.at(-1), { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } });
    } else {
      await assert.rejects(run, /active task catalog.*not resumed/);
      assert.equal(prompts.length, 1, 'never submit the owner task on a failed catalog check');
      assert.equal(existsSync(`${catalog}.probe`), false);
    }
    assert.equal(existsSync(`${catalog}.startup`), false);
  });
}

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
