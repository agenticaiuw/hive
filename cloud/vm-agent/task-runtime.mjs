// A repaired Mac transfer task must not spend another model turn discovering a broken
// runtime. Keep one app-server thread from discovery and the live probe through the
// owner's turn. A second process or a fixture catalog cannot verify that thread.
import { spawn } from 'node:child_process';
import { chownSync, existsSync, copyFileSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { transferProbeSucceeded } from './task-catalog.mjs';

export const STARTUP_PROBE = { direction: 'to_vm', mac_path: '/.hive-transfer-probe', check_only: true,
  step: 'Checking the Mac transfer route before resuming the task.' };

function receipt(workDir, path, value) {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  // The runtime is root, but its MCP gate runs as the task's VM user.
  const { uid, gid } = statSync(workDir);
  chownSync(path, uid, gid);
}

export async function startTask(request, { model, effort, workDir, prompt, emit }) {
  await request('initialize', { clientInfo: { name: 'hive-task', version: '1' }, capabilities: { experimentalApi: true } });
  const { thread } = await request('thread/start', { model, cwd: workDir, ephemeral: true,
    approvalPolicy: 'never', sandbox: 'read-only' });
  if (!thread?.id) throw new Error('The task runtime did not return a thread ID.');
  emit({ type: 'thread.started', thread_id: thread.id });
  const { data } = await request('mcpServerStatus/list', { threadId: thread.id, serverName: 'mac' });
  const mac = data?.find(server => server.name === 'mac');
  const schema = mac?.tools?.transfer_file?.inputSchema;
  if (mac?.runtimeStatus !== 'connected' || mac.toolsError || !mac.tools?.run_command
    || schema?.properties?.check_only?.type !== 'boolean' || !schema?.properties?.direction?.enum?.includes('to_vm')) {
    throw new Error('The task runtime has no connected mac.run_command and mac.transfer_file probe route; the task was not resumed.');
  }
  const catalog = join(workDir, 'runtime-catalog.json');
  // Only this fixed, read-only probe may pass the MCP gate before a model request exists.
  // Remove the allowance before submitting the prompt, including when the call fails.
  receipt(workDir, `${catalog}.startup`, { thread_id: thread.id });
  let result;
  try {
    result = await request('mcpServer/tool/call', { threadId: thread.id, server: 'mac',
      tool: 'transfer_file', arguments: STARTUP_PROBE });
  } finally { rmSync(`${catalog}.startup`, { force: true }); }
  const probe = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'mac',
    tool: 'transfer_file', status: 'completed', arguments: STARTUP_PROBE, result } };
  if (!transferProbeSucceeded(probe)) {
    const why = result?.content?.filter(part => part.type === 'text').map(part => part.text).join(' ') || 'No successful reply.';
    throw new Error(`The task's live Mac transfer probe failed; the task was not resumed. ${why}`);
  }
  receipt(workDir, `${catalog}.probe`, { thread_id: thread.id, ready: true });
  emit(probe);
  // The ordinary catalog audit still checks the model's own functions.exec declarations.
  // It never treats this startup check as evidence of model-visible tool exposure.
  await request('turn/start', { threadId: thread.id, effort, input: [{ type: 'text', text: prompt }] });
  return thread.id;
}

// Keep the event format hive-task and the board already consume, including token totals.
export function taskEvent(method, params) {
  if (method === 'item/started' || method === 'item/completed') {
    const types = { agentMessage: 'agent_message', mcpToolCall: 'mcp_tool_call', commandExecution: 'command_execution' };
    const type = types[params.item?.type];
    if (type) return { type: method.replace('/', '.'), item: { ...params.item, type } };
  }
  if (method === 'turn/completed' && params.turn?.status !== 'completed') {
    return { type: 'turn.failed', error: { message: params.turn?.error?.message || 'The task turn stopped.' } };
  }
  return null;
}

export async function runRuntime({ command, args, env, model, effort, workDir, prompt, emit, spawnProcess = spawn }) {
  const child = spawnProcess(command, args, { env, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
  let serial = 0, threadId = '', usage, finish;
  const pending = new Map();
  const closed = new Promise(resolve => child.on('close', resolve));
  const done = new Promise(resolve => { finish = resolve; });
  const failed = error => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
    finish({ error });
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`${method} timed out; the task runtime stopped.`));
    }, method === 'mcpServer/tool/call' ? 7 * 60_000 : 90_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  child.on('error', failed);
  child.stdin.on('error', failed);
  child.on('close', () => failed(new Error('The task runtime exited before the turn completed.')));
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && !message.method) {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    // There is nobody to answer an interactive server request in an unattended task.
    if (message.id != null) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Hive tasks cannot answer interactive requests.' } })}\n`);
      return;
    }
    const params = message.params ?? {};
    if (!threadId || params.threadId !== threadId) return;
    const event = taskEvent(message.method, params);
    if (event) emit(event);
    if (message.method === 'thread/tokenUsage/updated') usage = params.tokenUsage?.total;
    if (message.method === 'turn/completed') finish({ status: params.turn?.status });
  });
  const stop = (signal = 'SIGTERM') => {
    try {
      if (child.pid) process.kill(-child.pid, signal); // include the CLI launcher and its MCP servers
      else child.kill(signal);
    } catch {}
  };
  const interrupted = () => { failed(new Error('The task runtime was stopped.')); stop(); };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, interrupted);
  try {
    await startTask(request, { model, effort, workDir, prompt, emit: event => {
      if (event.type === 'thread.started') threadId = event.thread_id;
      emit(event);
    } });
    const outcome = await done;
    if (outcome.error) throw outcome.error;
    if (outcome.status !== 'completed') return 1;
    emit({ type: 'turn.completed', usage: { input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0 } });
    return 0;
  } finally {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(signal, interrupted);
    stop();
    const timer = setTimeout(() => stop('SIGKILL'), 2000);
    await closed;
    clearTimeout(timer);
    for (const call of pending.values()) clearTimeout(call.timer);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [workDir, model, effort, ...config] = process.argv.slice(2);
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const home = join(workDir, 'runtime-home');
  const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);
  try {
    // app-server has no --ignore-user-config. Give it an empty home with the same login
    // and cached model metadata, so owner config cannot disable or replace Hive's servers.
    mkdirSync(home, { mode: 0o700 });
    const source = process.env.CODEX_HOME;
    if (existsSync(join(source, 'auth.json'))) symlinkSync(join(source, 'auth.json'), join(home, 'auth.json'));
    if (existsSync(join(source, 'models_cache.json'))) copyFileSync(join(source, 'models_cache.json'), join(home, 'models_cache.json'));
    process.exitCode = await runRuntime({ command: '/root/.local/bin/codex', args: ['app-server', ...config],
      env: { ...process.env, CODEX_HOME: home }, model, effort, workDir, prompt: Buffer.concat(chunks).toString('utf8'), emit });
  } catch (error) {
    emit({ type: 'error', message: error.message });
    process.exitCode = 1;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
