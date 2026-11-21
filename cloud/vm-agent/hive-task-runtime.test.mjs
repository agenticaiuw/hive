// Exercise hive-task's real entry point and completion gate without a model or owner credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSFER_TOOL } from './mac-files.mjs';

for (const evidence of ['current', 'code-mode', 'code-mode-lite', 'direct-only', 'missing-tool', 'other-thread', 'no-trace', 'probe', 'no-probe', 'stale-probe', 'missing-mac', 'startup-failed', 'code']) {
  test(`owner task completion checks its own runtime catalog: ${evidence}`, { timeout: 10000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-task-runtime-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // Emulate the task's sudo commands: Codex, the privileged catalog reader and cleanup.
    // The model's success message is deliberately untrustworthy unless its catalog agrees.
    const tools = evidence === 'missing-tool' ? [] : [
      { type: 'namespace', name: 'mcp__hivefiles', tools: [
        { type: 'function', name: 'transfer_file', parameters: TRANSFER_TOOL.inputSchema },
      ] },
    ];
    if (['code-mode', 'code-mode-lite', 'direct-only'].includes(evidence)) {
      if (evidence !== 'direct-only') tools.length = 0;
      tools.push({ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec',
        description: evidence === 'direct-only' ? '' : `declare const tools: { mcp__hivefiles__transfer_file(args: {
          check_only?: boolean;
          direction: "to_vm" | "to_mac";
          mac_path: string;
          step: string;
        }): Promise<CallToolResult>; };`,
      }] });
    }
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ model: 'fixture',
      ...(evidence === 'code-mode-lite' ? { input: [{ type: 'additional_tools', tools }] } : { tools }),
    }));
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ thread_id: evidence === 'other-thread' ? 'old' : 'current',
      payload: { type: 'inference_started', request_payload: { path: 'payloads/1.json' } } }));
    const repaired = ['probe', 'no-probe', 'stale-probe', 'missing-mac', 'startup-failed'].includes(evidence);
    if (repaired && evidence !== 'missing-mac') {
      const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
      request.tools.push({ type: 'namespace', name: 'mcp__mac', tools: [
        { type: 'function', name: 'transfer_file', parameters: TRANSFER_TOOL.inputSchema },
        { type: 'function', name: 'run_command', parameters: { type: 'object' } },
      ] });
      writeFileSync(join(dir, 'request.json'), JSON.stringify(request));
    }
    writeFileSync(join(bin, 'sudo'), `#!/bin/sh
if [ "$2" = rm ]; then shift; exec "$@"; fi
case "$3" in */task-catalog.mjs) shift; exec "$@" ;; esac
[ "$2" = env ] || exit 2
printf '%s\\n' "$@" > '${dir}/args'
for arg do
  case "$arg" in CODEX_ROLLOUT_TRACE_ROOT=*) trace="\${arg#*=}" ;; esac
done
[ -n "$trace" ] || [ '${evidence}' = code ] || exit 2
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"current"}'
if [ '${evidence}' = startup-failed ]; then
  printf '%s\\n' '{"type":"error","message":"The live transfer_file probe failed: fixture Mac offline."}'
  exit 1
fi
if [ '${evidence}' != no-trace ] && [ '${evidence}' != code ]; then
  mkdir -p "$trace/trace-one/payloads"
  cp '${dir}/request.json' "$trace/trace-one/payloads/1.json"
  cp '${dir}/event.json' "$trace/trace-one/trace.jsonl"
fi
if [ '${evidence}' = probe ] || [ '${evidence}' = stale-probe ]; then
  printf '%s\\n' '{"ready":true,"thread_id":"${evidence === 'probe' ? 'current' : 'old'}"}' > "$trace/../runtime-catalog.json.probe"
fi
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Finished."}}'
`, { mode: 0o755 });
    const state = join(dir, 'state');
    // File-backed stdio also runs in the repair sandbox, which denies Node's pipe setup.
    writeFileSync(join(dir, 'input'), repaired
      ? "Hive just changed itself for this task, because it couldn't expose a Mac-to-VM transfer tool:\nfixture\nCarry on."
      : 'Check the fixture task.');
    const fds = [openSync(join(dir, 'input'), 'r'), openSync(join(dir, 'output'), 'w'), openSync(join(dir, 'errors'), 'w')];
    const child = spawn(process.execPath, [join(import.meta.dirname, 'hive-task.mjs'), ...(evidence === 'code' ? ['--code', dir] : [])], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, USER: 'test', HIVE_RUN_SENT: '1',
        HIVE_VM_STATE: state, HIVE_FILES_DIR: join(dir, 'files') }, stdio: fds,
    });
    const code = await new Promise(resolve => child.on('close', resolve));
    for (const fd of fds) closeSync(fd);
    const output = readFileSync(join(dir, 'output'), 'utf8');
    const errors = readFileSync(join(dir, 'errors'), 'utf8');
    const verified = ['current', 'code-mode', 'code-mode-lite', 'probe'].includes(evidence);
    assert.equal(code, verified || evidence === 'code' ? 0 : 1, `${output}\n${errors}`);
    const work = join(state, 'tasks', readdirSync(join(state, 'tasks'))[0]);
    if (evidence === 'code') {
      assert.equal(existsSync(join(work, 'runtime-catalog.json')), false);
      assert.equal(existsSync(join(work, 'runtime-trace')), false);
      assert.match(output, /✅ Done/);
      return;
    }
    const catalog = JSON.parse(readFileSync(join(work, 'runtime-catalog.json'), 'utf8'));
    assert.equal(catalog.ok, verified);
    assert.equal(catalog.thread_id, 'current');
    assert.match(catalog.sources['hive-task.mjs'], /^[a-f0-9]{64}$/);
    assert.match(catalog.sources['task-mcp.mjs'], /^[a-f0-9]{64}$/);
    assert.match(catalog.sources['transfer-mcp.mjs'], /^[a-f0-9]{64}$/);
    assert.equal(catalog.probe_required, repaired);
    if (evidence === 'startup-failed') assert.equal(catalog.why, 'The live transfer_file probe failed: fixture Mac offline.');
    assert.equal(readFileSync(join(dir, 'args'), 'utf8').includes('/task-runtime.mjs'), repaired,
      'repair retries must use the runtime preflight launcher');
    assert.equal(existsSync(join(work, 'catalog-read.json')), false);
    assert.equal(existsSync(join(work, 'runtime-trace')), false);
    if (verified) assert.match(output, /Callable transfer catalog verified[\s\S]*✅ Done/);
    else {
      assert.doesNotMatch(output, /✅ Done/);
      const events = readFileSync(join(work, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.match(events.at(-1).item.text, /catalog|transfer_file/);
      assert.notEqual(events.at(-1).item.text, 'Finished.');
    }
    if (evidence === 'probe') assert.match(output, /Live transfer probe verified/);
    else assert.doesNotMatch(output, /Live transfer probe verified/);
  });
}
