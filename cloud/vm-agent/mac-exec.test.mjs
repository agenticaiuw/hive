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
import { requestCatalog } from './task-catalog.mjs';

const codex = process.env.HIVE_TEST_CODEX ?? '/root/.local/bin/codex';
const releaseCheck = process.env.HIVE_UPDATE_CHECK === '1';
// The desktop MCP alone may take 60 seconds to start. The release gate starts
// many test processes together; allow startup plus both fixture model turns.
const execTimeout = 90000;

test('exec exposes and invokes transfer before continuing a repaired task', {
  skip: !releaseCheck && !existsSync(codex) && 'Set HIVE_TEST_CODEX to check the agent-facing catalog', timeout: 3 * execTimeout + 15000,
}, async t => {
  // This release test covers exposure and invocation in a fixture. The actual task
  // must independently pass its catalog and live-probe gates before continuing.
  // A sandbox skip is never release evidence.
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
  // Tool mode comes from model metadata, not the legacy feature flags. Provision
  // the repaired task explicitly so an empty fixture home still exercises exec.
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
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ url: 'https://board.invalid', token: 'fixture' }));
  writeFileSync(join(dir, 'bin', 'sudo'), '#!/bin/sh\n[ "$1" = "-n" ] && [ "$2" = "-u" ] || exit 1\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const preload = join(dir, 'fixture.mjs');
  writeFileSync(preload, `
globalThis.fetch = async (url, options) => {
  if (options.headers.authorization !== 'Bearer fixture') throw new Error('Wrong board config');
  if (url === 'https://board.invalid/v1/mac/calls') {
    const call = JSON.parse(options.body);
    if (call.name !== 'run_command' || call.arguments.command !== '/usr/bin/true') throw new Error('Only the harmless probe may run');
    return Response.json({ call: { status: 'done', result: { content: [{ type: 'text', text: JSON.stringify({ exit_code: 0 }) }] } } });
  }
  if (url !== 'https://board.invalid/v1/mac/status?tools=1') throw new Error('Unexpected route');
  return Response.json({ macs: [{ name: 'fixture-mac', tools: [
    { name: 'run_command', description: 'Fixture command', inputSchema: { type: 'object' } },
  ] }] });
};
`);
  for (const [repaired, macEnabled] of [[false, true], [true, true], [true, false]]) {
    rmSync(join(dir, 'runtime-catalog.json'), { force: true });
    const namespace = 'hivefiles';
    let requests = 0, failure, probed = false, codeMode = false;
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
          const functions = [...(body.tools ?? []),
            ...(body.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])]
            .flatMap(tool => tool.type === 'namespace'
            ? tool.tools.map(fn => ({ ...fn, namespace: tool.name })) : [tool]);
          const catalog = requestCatalog(body, 'fixture-model-request');
          assert.equal(catalog.ok, true, JSON.stringify(catalog));
          writeFileSync(join(dir, 'runtime-catalog.json'), JSON.stringify({ ...catalog, probe_required: repaired }));
          const probe = { direction: 'to_vm', mac_path: '/Desktop/clip.mov', check_only: true,
            step: 'Checking transfer before continuing the fixture task.' };
          const exec = functions.find(tool => tool.namespace === 'functions' && tool.name === 'exec');
          if (repaired) assert.ok(exec, 'the repaired task must exercise code mode');
          if (exec) {
            codeMode = true;
            assert.ok(catalog.code_tools.includes(`mcp__${namespace}.transfer_file`));
            const name = `mcp__${namespace}__transfer_file`;
            assert.ok(exec.description.includes(`declare const tools: { ${name}(`));
            respond(res, { id: 'call-fixture', type: 'custom_tool_call', call_id: 'transfer-probe',
              name: exec.name, namespace: exec.namespace,
              input: `const name = ${JSON.stringify(name)};
                if (!ALL_TOOLS.some(t => t.name === name) || typeof tools[name] !== 'function')
                  throw new Error('Transfer is missing from this execution');
                text(await tools[name]({ direction: 'to_vm', mac_path: '/Desktop/clip.mov',
                  check_only: true, step: 'Checking transfer before continuing the fixture task.' }));` });
            return;
          }
          const transfer = functions.find(tool => tool.name === `mcp__${namespace}__transfer_file`
            || (['mcp__' + namespace, namespace].includes(tool.namespace) && tool.name === 'transfer_file'));
          assert.ok(transfer, `${namespace}.transfer_file must be in the agent's initial catalog`);
          assert.ok(!transfer.defer_loading, 'the transfer must be callable without tool search');
          assert.equal(transfer.parameters.properties.check_only.type, 'boolean');
          respond(res, { id: 'call-fixture', type: 'function_call', call_id: 'transfer-probe', name: transfer.name,
            ...(transfer.namespace ? { namespace: transfer.namespace } : {}),
            arguments: JSON.stringify(probe) });
          return;
        }
        assert.equal(requests, 2);
        const output = body.input.find(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type) && item.call_id === 'transfer-probe');
        assert.ok(output, 'the same agent turn must receive the probe result');
        assert.match(JSON.stringify(output.output), /ready[^a-z]+true/);
        assert.match(JSON.stringify(output.output), /copied[^a-z]+false/);
        probed = true;
      } catch (error) { failure = error; }
      respond(res, done);
    };
    server.on('request', handle);
    const args = codexArgs({ model: 'fixture', effort: 'low', workDir: dir, appDir: import.meta.dirname,
      stateDir: dir, filesDir: join(dir, 'files'), stepsFile: join(dir, 'steps'), user: 'test', label: 'R42-1',
      tasksConfig: join(dir, 'board.json'), improveFile: repaired ? join(dir, 'repair.json') : '' });
    args.pop();
    for (const name of ['desktop', 'phone', 'browser', 'knowledge', 'mac', 'hivefiles']) {
      args.push('-c', `mcp_servers.${name}.env.NODE_OPTIONS=${JSON.stringify(`--import=${preload}`)}`,
        '-c', `mcp_servers.${name}.env.HIVE_TASKS_CONFIG=${JSON.stringify(join(dir, 'board.json'))}`);
    }
    args.push('-c', 'model_provider="fixture"', '-c', 'model_providers.fixture.name="Offline fixture"',
      '-c', `model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}"`,
      '-c', 'model_providers.fixture.wire_api="responses"', '-c', 'model_providers.fixture.request_max_retries=0',
      '-c', 'model_providers.fixture.stream_max_retries=0');
    if (repaired) args.push('-c', `model_catalog_json=${JSON.stringify(models)}`);
    if (!macEnabled) args.push('-c', 'mcp_servers.mac.enabled=false');
    args.push('-');
    const child = spawn(codex, args, { cwd: dir, detached: true,
      env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, CODEX_HOME: dir },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let errors = '', events = '';
    child.stderr.on('data', b => { errors = (errors + b).slice(-8000); });
    child.stdout.on('data', b => { events += b; });
    let ended = false, timedOut = false;
    const closed = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => { ended = true; resolve({ code, signal }); });
    });
    const stop = () => {
      if (ended || !child.pid) return;
      // codex is a launcher: terminate its native child and MCP processes too,
      // and let close drain their output before removing the fixture directory.
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    t.after(async () => { stop(); await closed; });
    const timer = setTimeout(() => { timedOut = true; stop(); }, execTimeout);
    child.stdin.end(`${GUIDE}\n\n${repaired ? 'Continue after the repair.' : 'New task.'} Probe the fixture transfer before proceeding.`);
    let status;
    try { status = await closed; }
    finally { clearTimeout(timer); server.off('request', handle); }
    if (failure) throw failure;
    assert.equal(status.code, 0, `${repaired ? 'repair retry' : 'new task'} (${namespace}): `
      + `${timedOut ? `timed out after ${execTimeout}ms` : `exited with ${status.code}`}; `
      + `signal=${status.signal}; model requests=${requests}; probe received=${probed}\n`
      + `stderr:\n${errors}\nstdout:\n${events.slice(-8000)}`);
    assert.ok(probed, 'exec must discover and invoke the transfer before continuing');
    const calls = events.trim().split('\n').map(JSON.parse).filter(e => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call');
    if (!codeMode) assert.ok(calls.some(e => e.item.tool === 'transfer_file' && e.item.status === 'completed'), events);
    t.diagnostic(`${repaired ? 'repair retry' : 'new task'}: ${namespace} ${codeMode ? 'found in ALL_TOOLS and invoked through functions.exec' : 'visible directly and probe invoked'}`);
  }
});
