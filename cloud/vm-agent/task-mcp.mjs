// Let Codex discover the servers before its first model request, but do not let that
// request act until Hive has checked its transfer schema. This is the owner task's
// verdict, not a release test or another thread's catalog.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

export async function waitForCatalog(path, { timeoutMs = 15000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const until = now() + timeoutMs;
  do {
    let catalog;
    try { catalog = JSON.parse(readFileSync(path, 'utf8')); } catch {} // the verdict may still be being written
    if (catalog?.ok === true && catalog.thread_id) return;
    if (catalog?.ok === false) throw new Error(catalog.why || 'The task transfer catalog failed verification.');
    if (now() >= until) throw new Error('No verified transfer catalog for this task; no tool call was forwarded.');
    await sleep(50);
  } while (true);
}

export async function forward(message, catalog, send, reply) {
  if (message.method === 'tools/call') {
    try { await waitForCatalog(catalog); }
    catch (error) {
      reply({ jsonrpc: '2.0', id: message.id, result: {
        isError: true, content: [{ type: 'text', text: error.message }],
      } });
      return;
    }
  }
  send(message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [catalog, script] = process.argv.slice(2);
  const server = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
  server.stdout.pipe(process.stdout);
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
      value => server.stdin.write(`${JSON.stringify(value)}\n`),
      value => process.stdout.write(`${JSON.stringify(value)}\n`));
    // Calls retain arrival order while the verdict is pending. Discovery and protocol
    // notifications still pass immediately, so startup cannot wait on its own audit.
    const call = message.method === 'tools/call' ? (calls = calls.then(dispatch)) : dispatch();
    pending.add(call);
    call.finally(() => pending.delete(call));
  });
  lines.on('close', async () => { await Promise.allSettled(pending); server.stdin.end(); });
}
