// A server's tools/list can pass while the agent still cannot see its tools. Exercise the task's
// model-facing catalog and dispatch, with a local model fixture and a synthetic board only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexArgs, GUIDE } from './hive-task.mjs';
import { requestCatalog } from './task-catalog.mjs';
import { CATALOG_PROBE, STARTUP_PROBE, runRuntime } from './task-runtime.mjs';

const codex = process.env.HIVE_TEST_CODEX ?? '/root/.local/bin/codex';
const releaseCheck = process.env.HIVE_UPDATE_CHECK === '1';
// The desktop MCP alone may take 60 seconds to start. The release gate starts
// many test processes together; allow startup plus both fixture model turns.
const execTimeout = 90000;

test('owner threads expose and invoke transfer with and without a repair paragraph', {
  // Hive's change gate (orchestrator.mjs gateOnVm) runs this as root, where root's Codex is, so every
  // change to Hive passes it there. The VM's updater checks a release as its own user, which can't
  // reach root's Codex: requiring it there refused every VM release, so none of Hive's fixes went live.
  skip: !existsSync(codex) && 'Set HIVE_TEST_CODEX to check the agent-facing catalog (Hive\'s change gate runs it as root)', timeout: 3 * execTimeout + 15000,
}, async t => {
  // This release test covers exposure and invocation in a fixture. The actual task
  // must independently pass its catalog and live-probe gates before continuing.
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
  // every task explicitly so an empty fixture home still exercises exec.
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
    rmSync(join(dir, 'runtime-catalog.json.probe'), { force: true });
    rmSync(join(dir, 'transfer-probe.json'), { force: true });
    let requests = 0, failure, probed = false, activeThread = 'fixture-model-request';
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
        if (requests === 1 || (repaired && requests === 3)) {
          if (repaired && requests === 1) {
            assert.ok(JSON.stringify(body).includes(CATALOG_PROBE.split('\n')[0]));
            assert.ok(!JSON.stringify(body).includes('Continue after the repair.'));
          }
          if (repaired && requests === 3) {
            assert.ok(probed, 'the model probe must finish before the owner prompt');
            assert.ok(JSON.stringify(body).includes('Continue after the repair.'));
          }
          // Support both flat function names and namespaced tool definitions. Only accept
          // tools actually present without discovery; the MCP status endpoint isn't evidence.
          const functions = [...(body.tools ?? []),
            ...(body.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])]
            .flatMap(tool => tool.type === 'namespace'
            ? tool.tools.map(fn => ({ ...fn, namespace: tool.name })) : [tool]);
          const catalog = requestCatalog(body, activeThread);
          assert.equal(catalog.ok, true, JSON.stringify(catalog));
          assert.ok(![...catalog.tools, ...catalog.code_tools]
            .some(name => /^mcp__(mac|hivefiles|desktop)\./.test(name)), 'exercise the missing MCP catalog');
          writeFileSync(join(dir, 'runtime-catalog.json'), JSON.stringify({ ...catalog, probe_required: repaired }));
          const probe = repaired && requests === 1 ? STARTUP_PROBE : { direction: 'to_vm', mac_path: '/Desktop/clip.mov', check_only: true,
            step: 'Checking transfer before continuing the fixture task.' };
          const exec = functions.find(tool => tool.namespace === 'functions' && tool.name === 'exec');
          assert.ok(exec, 'the owner task must exercise code mode');
          const name = 'hivefiles__transfer_file';
          assert.ok(catalog.code_tools.includes('hivefiles.transfer_file'));
          assert.ok(exec.description.includes(`declare const tools: { ${name}(`));
          respond(res, { id: `call-fixture-${requests}`, type: 'custom_tool_call', call_id: `transfer-${requests}`,
            name: exec.name, namespace: exec.namespace,
            input: `const name = ${JSON.stringify(name)};
              if (!ALL_TOOLS.some(t => t.name === name) || typeof tools[name] !== 'function')
                throw new Error('Transfer is missing from this execution');
              text(await tools[name](${JSON.stringify(probe)}));` });
          return;
        }
        assert.ok(requests === 2 || (repaired && requests === 4));
        const output = body.input.find(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type)
          && item.call_id === `transfer-${requests - 1}`);
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
    args.push('-c', `model_catalog_json=${JSON.stringify(models)}`);
    // Reproduce the reported runtime: MCP registration works but none of its Mac
    // or transfer namespaces reach ALL_TOOLS. Even without a repair paragraph the
    // thread-bound tool must still work.
    for (const name of ['mac', 'hivefiles', 'desktop']) {
      args.push('-c', `mcp_servers.${name}.omit_tools_from=["code_mode","deferred","direct"]`);
    }
    if (!macEnabled) args.push('-c', 'mcp_servers.mac.enabled=false');
    args.push('-');
    let errors = '', events = '';
    const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, CODEX_HOME: dir };
    const prompt = `${GUIDE}\n\n${repaired ? 'Continue after the repair.' : 'Continue the blocked task.'} Probe the fixture transfer before proceeding.`;
    let child;
    // Exercise the production owner-task path in both cases. Only the repair retry
    // needs a Mac preflight; both get the transfer bound to the same task thread.
    const runtime = runRuntime({ command: codex,
      args: ['app-server', ...args.flatMap((arg, i) => args[i - 1] === '-c' ? ['-c', arg] : [])],
      env, model: 'fixture', effort: 'low', workDir: dir, prompt, probeRequired: repaired,
      emit: event => {
        if (event.type === 'thread.started') activeThread = event.thread_id;
        events += `${JSON.stringify(event)}\n`;
      },
      spawnProcess: (command, argv, options) => (child = spawn(command, argv, { ...options, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })),
    });
    child.stderr.on('data', b => { errors = (errors + b).slice(-8000); });
    let ended = false, timedOut = false;
    const closed = runtime.then(code => { ended = true; return { code, signal: null }; },
      error => { ended = true; return { code: 1, signal: null, error }; });
    const stop = () => {
      if (ended || !child.pid) return;
      // codex is a launcher: terminate its native child and MCP processes too,
      // and let close drain their output before removing the fixture directory.
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    t.after(async () => { stop(); await closed; });
    const timer = setTimeout(() => { timedOut = true; stop(); }, execTimeout);
    let status;
    try { status = await closed; }
    finally { clearTimeout(timer); server.off('request', handle); }
    if (!macEnabled) {
      assert.equal(status.code, 1);
      assert.match(status.error?.message ?? '', /no connected mac\.run_command/);
      assert.equal(requests, 0, 'a repair without Mac tools must not start a model turn');
      continue;
    }
    if (failure) throw failure;
    if (status.error) throw status.error;
    assert.equal(status.code, 0, `${repaired ? 'repair retry' : 'continuation'}: `
      + `${timedOut ? `timed out after ${execTimeout}ms` : `exited with ${status.code}`}; `
      + `signal=${status.signal}; model requests=${requests}; probe received=${probed}\n`
      + `stderr:\n${errors}\nstdout:\n${events.slice(-8000)}`);
    assert.ok(probed, 'exec must discover and invoke the transfer before continuing');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'runtime-catalog.json.probe'), 'utf8')),
      { thread_id: activeThread, ready: true }, 'code mode must leave server evidence for task completion');
    t.diagnostic(`${repaired ? 'repair retry' : 'continuation'}: bound transfer found in ALL_TOOLS and invoked through functions.exec`);
  }
});
