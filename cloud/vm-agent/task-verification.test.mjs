// The first catalog and a model's success report cannot verify a resumed transfer task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSFER_TOOL } from './mac-files.mjs';
import { readTaskCatalog, transferProbeRequired, transferProbeSucceeded } from './task-catalog.mjs';

const tools = [
  { type: 'function', name: 'mcp__desktop__transfer_file', parameters: TRANSFER_TOOL.inputSchema },
  { type: 'function', name: 'hivefiles__transfer_file', parameters: TRANSFER_TOOL.inputSchema },
  { type: 'function', name: 'mcp__mac__run_command', parameters: { type: 'object' } },
];
const brief = "Continue the unfinished draft.\n\nHive just changed itself for this task, because it couldn't make a Mac-to-VM transfer callable:\nfixture on main\nCarry on from where the last run stopped, with the change.";
const probe = {
  type: 'item.completed', item: { type: 'mcp_tool_call', server: 'desktop', tool: 'transfer_file', status: 'completed',
    arguments: { check_only: true, direction: 'to_vm', mac_path: '/Desktop/clip.mov', step: 'Checking the transfer route.' },
    result: { content: [{ type: 'text', text: JSON.stringify({ ready: true, copied: false,
      direction: 'to_vm', mac_path: '/Desktop/clip.mov' }) }] },
  },
};

test('only a Mac transfer repair requires the live probe, including a saved continuation', () => {
  assert.equal(transferProbeRequired(brief), true);
  assert.equal(transferProbeRequired(`Saved task:\n${brief}\nContinue without publishing.`), true);
  assert.equal(transferProbeRequired('Copy a recording from the Mac.'), false);
  assert.equal(transferProbeRequired(brief.replace('make a Mac-to-VM transfer callable', 'read a PDF')), false);
  assert.equal(transferProbeRequired(brief.replace('Mac-to-VM', 'VM-to-Mac')), false);
});

test('probe evidence must be a matching successful MCP call, not prose or merely a completed error', () => {
  assert.equal(transferProbeSucceeded(probe), true);
  assert.equal(transferProbeSucceeded({ ...probe, item: { ...probe.item, server: 'mac' } }), true);
  for (const change of [
    { type: 'agent_message', text: 'The transfer probe passed.' },
    { server: 'other' }, { tool: 'run_command' }, { status: 'failed' }, { error: { message: 'No tool' } },
    { arguments: { ...probe.item.arguments, check_only: false } },
    { arguments: { ...probe.item.arguments, direction: 'to_mac' } },
    { arguments: { ...probe.item.arguments, mac_path: '/Desktop/other.mov' } },
    { result: { ...probe.item.result, isError: true } },
    { result: { content: [{ type: 'text', text: 'ready=true' }] } },
    { result: { content: [{ type: 'text', text: '{"ready":true,"copied":true}' }] } },
  ]) assert.equal(transferProbeSucceeded({ ...probe, item: { ...probe.item, ...change } }), false);
});

test('every model request is audited and a later good catalog cannot erase a missing tool', t => {
  const root = mkdtempSync(join(tmpdir(), 'hive-live-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'trace');
  mkdirSync(join(dir, 'payloads'), { recursive: true });
  const events = [];
  const add = (id, request, thread = 'current') => {
    if (request) writeFileSync(join(dir, `payloads/${id}.json`), JSON.stringify(request));
    events.push(JSON.stringify({ thread_id: thread, payload: { type: 'inference_started',
      request_payload: { path: `payloads/${id}.json` } } }));
    writeFileSync(join(dir, 'trace.jsonl'), `${events.join('\n')}\n`);
  };
  const seen = new Map();
  add('1', { tools });
  assert.equal(readTaskCatalog(root, 'current', seen).ok, true);
  add('other', { tools: [] }, 'other');
  assert.equal(readTaskCatalog(root, 'current', seen).requests, 1);
  add('2');
  assert.equal(readTaskCatalog(root, 'current', seen), null, 'unfinished payload cannot reuse the first success');
  writeFileSync(join(dir, 'payloads/2.json'), JSON.stringify({ tools: [] }));
  assert.equal(readTaskCatalog(root, 'current', seen).ok, false);
  add('3', { tools });
  assert.equal(readTaskCatalog(root, 'current', seen).ok, false);
});

for (const scenario of ['no-probe', 'good-probe', 'server-probe', 'stale-server-probe', 'failed-probe', 'lost-catalog', 'unfinished-catalog']) {
  test(`resumed task completion verifies this execution: ${scenario}`, { timeout: 10000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-live-task-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'bin'));
    // Only the sudo boundary is replaced. The task entry point, timers, event reader and
    // final verdict run unchanged. A late bad request follows an already-passing audit.
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ tools }));
    const event = structuredClone(probe);
    if (scenario === 'failed-probe') event.item.result.isError = true;
    writeFileSync(join(dir, 'probe.json'), `${JSON.stringify(event)}\n`);
    for (const id of [1, 2]) writeFileSync(join(dir, `trace-${id}.json`), `${JSON.stringify({ thread_id: 'current',
      payload: { type: 'inference_started', request_payload: { path: `payloads/${id}.json` } } })}\n`);
    writeFileSync(join(dir, 'bin/sudo'), `#!/bin/sh
if [ "$2" = rm ]; then shift; exec "$@"; fi
case "$3" in */task-catalog.mjs) shift; exec "$@" ;; esac
[ "$2" = env ] || exit 2
printf '%s\\n' "$@" > '${dir}/args'
for arg do
  case "$arg" in CODEX_ROLLOUT_TRACE_ROOT=*) trace="\${arg#*=}" ;; esac
done
[ -n "$trace" ] || exit 2
cat >/dev/null
mkdir -p "$trace/trace/payloads"
cp '${dir}/request.json' "$trace/trace/payloads/1.json"
cp '${dir}/trace-1.json' "$trace/trace/trace.jsonl"
printf '%s\\n' '{"type":"thread.started","thread_id":"current"}'
fixture_tries=0
until [ -s "\${trace%/*}/runtime-catalog.json" ]; do
  fixture_tries=$((fixture_tries + 1))
  [ "$fixture_tries" -lt 200 ] || exit 2
  sleep 0.02
done
case '${scenario}' in
server-probe|stale-server-probe)
  printf '%s\\n' '{"thread_id":"${scenario === 'server-probe' ? 'current' : 'earlier'}","probed":true}' > "\${trace%/*}/transfer-probe.json" ;;
no-probe) ;;
*) cat '${dir}/probe.json' ;;
esac
if [ '${scenario}' = lost-catalog ]; then
  printf '%s\\n' '{"tools":[]}' > "$trace/trace/payloads/2.json"
  cat '${dir}/trace-2.json' >> "$trace/trace/trace.jsonl"
  sleep 0.6
fi
if [ '${scenario}' = unfinished-catalog ]; then cat '${dir}/trace-2.json' >> "$trace/trace/trace.jsonl"; fi
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Finished."}}'
`, { mode: 0o755 });
    writeFileSync(join(dir, 'input'), brief);
    const fds = ['input', 'output', 'errors'].map((name, i) => openSync(join(dir, name), i ? 'w' : 'r'));
    const state = join(dir, 'state');
    const child = spawn(process.execPath, [join(import.meta.dirname, 'hive-task.mjs')], {
      env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, USER: 'test', HIVE_RUN_SENT: '1',
        HIVE_VM_STATE: state, HIVE_FILES_DIR: join(dir, 'files') }, stdio: fds,
    });
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    for (const fd of fds) closeSync(fd);
    const output = readFileSync(join(dir, 'output'), 'utf8');
    const errors = readFileSync(join(dir, 'errors'), 'utf8');
    const good = ['good-probe', 'server-probe'].includes(scenario);
    assert.equal(status, good ? 0 : 1, `${output}\n${errors}`);
    assert.match(output, /Callable transfer catalog verified/, 'exercise a passing first audit');
    const work = join(state, 'tasks', readdirSync(join(state, 'tasks'))[0]);
    const catalog = JSON.parse(readFileSync(join(work, 'runtime-catalog.json'), 'utf8'));
    assert.equal(catalog.ok, good);
    assert.equal(catalog.probe_required, true);
    assert.match(readFileSync(join(dir, 'args'), 'utf8'), /HIVE_KEEP_OPEN=1/,
      'server teardown must preserve the unfinished draft');
    if (!good) {
      assert.doesNotMatch(output, /✅ Done/);
      const events = readFileSync(join(work, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.notEqual(events.at(-1).item.text, 'Finished.');
    }
  });
}
