// Exercise hive-task's real entry point and completion gate without a model or owner credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSFER_TOOL } from './mac-files.mjs';

for (const evidence of ['current', 'missing-tool', 'other-thread', 'no-trace', 'code']) {
  test(`owner task completion checks its own runtime catalog: ${evidence}`, { timeout: 10000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-task-runtime-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // Emulate only the two sudo commands used by the task: its Codex launch and trace cleanup.
    // The model's success message is deliberately untrustworthy unless its catalog agrees.
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ model: 'fixture', tools: evidence === 'missing-tool' ? [] : [
      { type: 'namespace', name: 'mcp__desktop', tools: [
        { type: 'function', name: 'transfer_file', parameters: TRANSFER_TOOL.inputSchema },
      ] },
    ] }));
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ thread_id: evidence === 'other-thread' ? 'old' : 'current',
      payload: { type: 'inference_started', request_payload: { path: 'payloads/1.json' } } }));
    writeFileSync(join(bin, 'sudo'), `#!/bin/sh
if [ "$2" = rm ]; then shift; exec "$@"; fi
[ "$2" = env ] || exit 2
for arg do
  case "$arg" in CODEX_ROLLOUT_TRACE_ROOT=*) trace="\${arg#*=}" ;; esac
done
[ -n "$trace" ] || [ '${evidence}' = code ] || exit 2
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"current"}'
if [ '${evidence}' != no-trace ] && [ '${evidence}' != code ]; then
  mkdir -p "$trace/trace-one/payloads"
  cp '${dir}/request.json' "$trace/trace-one/payloads/1.json"
  cp '${dir}/event.json' "$trace/trace-one/trace.jsonl"
fi
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Finished."}}'
`, { mode: 0o755 });
    const state = join(dir, 'state');
    // File-backed stdio also runs in the repair sandbox, which denies Node's pipe setup.
    writeFileSync(join(dir, 'input'), 'Check the fixture task.');
    const fds = [openSync(join(dir, 'input'), 'r'), openSync(join(dir, 'output'), 'w'), openSync(join(dir, 'errors'), 'w')];
    const child = spawn(process.execPath, [join(import.meta.dirname, 'hive-task.mjs'), ...(evidence === 'code' ? ['--code', dir] : [])], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, USER: 'test', HIVE_RUN_SENT: '1',
        HIVE_VM_STATE: state, HIVE_FILES_DIR: join(dir, 'files') }, stdio: fds,
    });
    const code = await new Promise(resolve => child.on('close', resolve));
    for (const fd of fds) closeSync(fd);
    const output = readFileSync(join(dir, 'output'), 'utf8');
    const errors = readFileSync(join(dir, 'errors'), 'utf8');
    assert.equal(code, ['current', 'code'].includes(evidence) ? 0 : 1, `${output}\n${errors}`);
    const work = join(state, 'tasks', readdirSync(join(state, 'tasks'))[0]);
    if (evidence === 'code') {
      assert.equal(existsSync(join(work, 'runtime-catalog.json')), false);
      assert.equal(existsSync(join(work, 'runtime-trace')), false);
      assert.match(output, /✅ Done/);
      return;
    }
    const catalog = JSON.parse(readFileSync(join(work, 'runtime-catalog.json'), 'utf8'));
    assert.equal(catalog.ok, evidence === 'current');
    assert.equal(catalog.thread_id, 'current');
    assert.match(catalog.sources['hive-task.mjs'], /^[a-f0-9]{64}$/);
    assert.equal(existsSync(join(work, 'runtime-trace')), false);
    if (evidence === 'current') assert.match(output, /Callable transfer catalog verified[\s\S]*✅ Done/);
    else {
      assert.doesNotMatch(output, /✅ Done/);
      const events = readFileSync(join(work, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.match(events.at(-1).item.text, /catalog|transfer_file/);
      assert.notEqual(events.at(-1).item.text, 'Finished.');
    }
  });
}
