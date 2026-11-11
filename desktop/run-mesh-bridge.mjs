// Explicit opt-in runner. Configuration contains no credential; the token is
// supplied through the process environment by the operator's supervisor.
import { openSync, closeSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PcMeshBridge } from './mesh-bridge.mjs';
import { TaskLedger } from '../cloud/orchestrator/task-ledger.mjs';
import { defaultLedgerPath } from '../cloud/orchestrator/local-agent-ledger.mjs';

export async function runBridge({ config, token, signal, Bridge = PcMeshBridge, onError = () => {} }) {
  if (!config || typeof config !== 'object' || !token) throw new Error('Bridge configuration and token are required');
  const intervalMs = config.intervalMs ?? 5000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 300000) throw new Error('intervalMs must be between 1000 and 300000');
  if (typeof config.journalPath !== 'string' || !config.journalPath) throw new Error('journalPath is required');
  const lockPath = `${resolve(config.journalPath)}.lock`;
  // Never auto-break a lock: another process may still be dispatching work.
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    const ledger = new TaskLedger(config.ledgerPath ?? defaultLedgerPath());
    const bridge = new Bridge({ ...config, token, ledger });
    while (!signal?.aborted) {
      try { await bridge.pollOnce(); } catch { onError('Bridge poll failed; will retry'); }
      if (signal?.aborted) break;
      await new Promise(resolveWait => {
        const timer = setTimeout(done, intervalMs);
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolveWait(); }
        signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    }
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: node pc-agent/run-mesh-bridge.mjs /path/to/config.json');
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  await runBridge({ config, token: process.env.HIVEMIND_MESH_TOKEN, signal: controller.signal, onError: message => console.error(message) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Bridge could not start; check configuration, token, journal directory and lock'); process.exitCode = 1; });
}
