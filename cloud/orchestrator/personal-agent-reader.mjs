// Read one bounded local receipt page; this helper never starts agent work.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
export function createPersonalAgentPageReader({ executable, controlDirectory, timeoutMs = 15000 }) {
  if (!executable || !controlDirectory) throw new Error('Receipt reader paths are required');
  return cursor => new Promise((resolve, reject) => {
    if (!existsSync(join(controlDirectory, 'request-ledger.sqlite3'))) return reject(new Error('Personal-agent receipt store unavailable'));
    const child = spawn(executable, [controlDirectory, 'list-page'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('Receipt reader timed out')); }, timeoutMs);
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); }
    child.on('error', () => finish(new Error('Receipt reader unavailable')));
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 2_000_000) { child.kill(); finish(new Error('Receipt page too large')); } });
    child.on('close', code => { if (code !== 0) return finish(new Error('Receipt reader failed')); try { finish(null, JSON.parse(output)); } catch { finish(new Error('Invalid receipt page')); } });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ cursor, limit: 100 }));
  });
}
