// A server's tools/list can pass while the agent still cannot see its tools. Exercise exec's
// model-facing catalog and dispatch, with a local model fixture and a synthetic board only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexArgs, GUIDE } from './hive-task.mjs';

const codex = process.env.HIVE_TEST_CODEX ?? '/root/.local/bin/codex';
const releaseCheck = process.env.HIVE_UPDATE_CHECK === '1';

test('exec exposes and invokes transfer before continuing a repaired task', {
  skip: !releaseCheck && !existsSync(codex) && 'Set HIVE_TEST_CODEX to check the agent-facing catalog', timeout: 45000,
}, async t => {
  // The release gate must prove exposure and invocation before retrying. A developer's
  // restricted sandbox may skip this integration test, but that is never release evidence.
  assert.ok(existsSync(codex), 'The release check requires the installed Codex runtime');
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (releaseCheck || error.code !== 'EPERM') throw error;
    t.skip('This sandbox forbids the loopback model fixture; run on the VM before retrying');
    return;
  }
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dir = mkdtempSync(join(tmpdir(), 'hive-mac-exec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ url: 'https://board.invalid', token: 'fixture' }));
  writeFileSync(join(dir, 'bin', 'sudo'), '#!/bin/sh\n[ "$1" = "-n" ] && [ "$2" = "-u" ] || exit 1\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const preload = join(dir, 'fixture.mjs');
  writeFileSync(preload, `
globalThis.fetch = async (url, options) => {
  if (url !== 'https://board.invalid/v1/mac/status?tools=1' || options.headers.authorization !== 'Bearer fixture') {
    throw new Error('A probe must only read the fixture Mac status');
  }
  return Response.json({ macs: [{ name: 'fixture-mac', tools: [
    { name: 'run_command', description: 'Fixture command', inputSchema: { type: 'object' } },
  ] }] });
};
`);
  for (const [repaired, macEnabled] of [[false, true], [true, true], [true, false]]) {
    const namespace = macEnabled ? 'mac' : 'desktop';
    let requests = 0, failure, probed = false;
    const respond = (res, item) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'response-fixture', status: 'completed', output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    };
    const done = { id: 'message-fixture', type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'The transfer probe passed; the task can continue.' }] };
    const handle = async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        requests++;
        if (requests === 1) {
          // Support both flat function names and namespaced tool definitions. Only accept
          // tools actually present without discovery; the MCP status endpoint isn't evidence.
          const functions = body.tools.flatMap(tool => tool.type === 'namespace'
            ? tool.tools.map(fn => ({ ...fn, namespace: tool.name })) : [tool]);
          const transfer = functions.find(tool => tool.name === `mcp__${namespace}__transfer_file`
            || (['mcp__' + namespace, namespace].includes(tool.namespace) && tool.name === 'transfer_file'));
          assert.ok(transfer, `${namespace}.transfer_file must be in the agent's initial catalog`);
          assert.ok(!transfer.defer_loading, 'the transfer must be callable without tool search');
          assert.equal(transfer.parameters.properties.check_only.type, 'boolean');
          respond(res, { id: 'call-fixture', type: 'function_call', call_id: 'transfer-probe', name: transfer.name,
            ...(transfer.namespace ? { namespace: transfer.namespace } : {}),
            arguments: JSON.stringify({ direction: 'to_vm', mac_path: '/Desktop/clip.mov', check_only: true,
              step: 'Checking transfer before continuing the fixture task.' }) });
          return;
        }
        assert.equal(requests, 2);
        const output = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'transfer-probe');
        assert.ok(output, 'the same agent turn must receive the probe result');
        assert.match(JSON.stringify(output.output), /ready[^a-z]+true/);
        assert.match(JSON.stringify(output.output), /copied[^a-z]+false/);
        probed = true;
      } catch (error) { failure = error; }
      respond(res, done);
    };
    server.on('request', handle);
    const args = codexArgs({ model: 'gpt-6.1-terra', effort: 'low', workDir: dir, appDir: import.meta.dirname,
      stateDir: dir, filesDir: join(dir, 'files'), stepsFile: join(dir, 'steps'), user: 'test', label: 'R42-1',
      tasksConfig: join(dir, 'board.json'), improveFile: repaired ? join(dir, 'repair.json') : '' });
    args.pop();
    for (const name of ['desktop', 'phone', 'browser', 'knowledge', 'mac']) {
      args.push('-c', `mcp_servers.${name}.env.NODE_OPTIONS=${JSON.stringify(`--import=${preload}`)}`,
        '-c', `mcp_servers.${name}.env.HIVE_TASKS_CONFIG=${JSON.stringify(join(dir, 'board.json'))}`);
    }
    args.push('-c', 'model_provider="fixture"', '-c', 'model_providers.fixture.name="Offline fixture"',
      '-c', `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}"`,
      '-c', 'model_providers.fixture.wire_api="responses"', '-c', 'model_providers.fixture.request_max_retries=0',
      '-c', 'model_providers.fixture.stream_max_retries=0');
    // The reported continuations used ALL_TOOLS. Exercise that mode explicitly instead
    // of depending on the fixture home's model cache to select it.
    if (repaired) args.push('-c', 'features.code_mode=true', '-c', 'features.code_mode_only=true');
    if (!macEnabled) args.push('-c', 'mcp_servers.mac.enabled=false');
    args.push('-');
    const child = spawn(codex, args, { cwd: dir,
      env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, CODEX_HOME: dir },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let errors = '', events = '';
    child.stderr.on('data', b => { errors = (errors + b).slice(-8000); });
    child.stdout.on('data', b => { events += b; });
    const stop = () => { child.kill('SIGKILL'); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); };
    t.after(stop);
    const timer = setTimeout(stop, 12000);
    child.stdin.end(`${GUIDE}\n\n${repaired ? 'Continue after the repair.' : 'New task.'} Probe the fixture transfer before proceeding.`);
    let status;
    try { status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
    finally { clearTimeout(timer); server.off('request', handle); }
    if (failure) throw failure;
    assert.equal(status, 0, errors);
    assert.ok(probed, 'exec must discover and invoke the transfer before continuing');
    const calls = events.trim().split('\n').map(JSON.parse).filter(e => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call');
    assert.ok(calls.some(e => e.item.tool === 'transfer_file' && e.item.status === 'completed'), events);
    t.diagnostic(`${repaired ? 'repair retry' : 'new task'}: ${namespace} visible to the agent and probe invoked`);
  }
});
