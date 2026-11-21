// Let Codex discover the servers before its first model request, but do not let that
// request act until Hive has checked its transfer schema. A transfer repair also
// needs a live probe in this thread, not a release test or another task's evidence.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { transferProbed, transferProbeSucceeded } from './task-catalog.mjs';

export async function waitForCatalog(path, { timeoutMs = 15000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const until = now() + timeoutMs;
  do {
    let catalog;
    try { catalog = JSON.parse(readFileSync(path, 'utf8')); } catch {} // the verdict may still be being written
    if (catalog?.ok === true && catalog.thread_id) return catalog;
    if (catalog?.ok === false) throw new Error(catalog.why || 'The task transfer catalog failed verification.');
    if (now() >= until) throw new Error('No verified transfer catalog for this task; no tool call was forwarded.');
    await sleep(50);
  } while (true);
}

export async function forward(message, catalog, send, reply) {
  let verdict;
  if (message.method === 'tools/call') {
    try {
      verdict = await waitForCatalog(catalog);
      if (verdict.probe_required && !transferProbed(catalog, verdict.thread_id)
        && !(message.params?.name === 'transfer_file' && message.params?.arguments?.check_only === true)) {
        throw new Error('Before continuing this repaired task, discover hivefiles.transfer_file in ALL_TOOLS, check that tools[name] is a function, and call it with check_only=true and the intended paths. Require ready=true.');
      }
    }
    catch (error) {
      reply({ jsonrpc: '2.0', id: message.id, result: {
        isError: true, content: [{ type: 'text', text: error.message }],
      } });
      return;
    }
  }
  send(message, verdict);
}

// Code-mode calls need not appear as individual MCP events in Codex's JSON stream.
// Observe the real server reply instead; keep only a receipt for this task's thread,
// never file paths or tool output. A model's text cannot create this evidence.
export function transferProbeObserver(catalog, server) {
  const probes = new Map();
  return {
    sent(message, verdict) {
      if (!['desktop', 'mac'].includes(server) || message.method !== 'tools/call'
        || message.params?.name !== 'transfer_file' || message.params?.arguments?.check_only !== true) return;
      if (verdict?.ok && verdict.thread_id) probes.set(message.id, { thread: verdict.thread_id, args: message.params.arguments });
    },
    received(message) {
      const probe = probes.get(message.id);
      if (!probe) return;
      probes.delete(message.id);
      if (!transferProbeSucceeded({ type: 'item.completed', item: {
        type: 'mcp_tool_call', status: 'completed', server, tool: 'transfer_file',
        arguments: probe.args, result: message.result, error: message.error,
      } })) return;
      writeFileSync(join(dirname(catalog), 'transfer-probe.json'),
        `${JSON.stringify({ thread_id: probe.thread, probed: true })}\n`, { mode: 0o600 });
      // Fallback probes must also unlock the shared call gate before work resumes.
      writeFileSync(`${catalog}.probe`, JSON.stringify({ thread_id: probe.thread, ready: true }), { mode: 0o600 });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [catalog, script] = process.argv.slice(2);
  const server = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const probe = transferProbeObserver(catalog, basename(script).replace(/-mcp\.mjs$/, ''));
  createInterface({ input: server.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch {} // preserve the server's protocol output
    if (message) probe.received(message);
    process.stdout.write(`${line}\n`);
  });
  const pending = new Set();
  let calls = Promise.resolve();
  const lines = createInterface({ input: process.stdin });
  const stop = () => { lines.close(); server.kill('SIGTERM'); };
  server.on('error', error => { console.error(error.message); process.exit(1); });
  server.stdin.on('error', stop);
  server.on('close', code => process.exit(code ?? 1));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const dispatch = () => forward(message, catalog,
      (value, verdict) => { probe.sent(value, verdict); server.stdin.write(`${JSON.stringify(value)}\n`); },
      value => process.stdout.write(`${JSON.stringify(value)}\n`));
    // Calls retain arrival order while the verdict is pending. Discovery and protocol
    // notifications still pass immediately, so startup cannot wait on its own audit.
    const call = message.method === 'tools/call' ? (calls = calls.then(dispatch)) : dispatch();
    pending.add(call);
    call.finally(() => pending.delete(call));
  });
  lines.on('close', async () => { await Promise.allSettled(pending); server.stdin.end(); });
}
