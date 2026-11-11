// Import explicitly supplied private task records. This file contains no user
// task data and never schedules or executes imported work.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TaskLedger } from './task-ledger.mjs';
import { defaultLedgerPath } from './local-agent-ledger.mjs';
export function seedTasks({ sourceFile, ledgerPath, apply = false }) {
  const input = JSON.parse(readFileSync(sourceFile, 'utf8'));
  if (!Array.isArray(input.tasks)) throw new Error('Expected an array of tasks');
  if (apply) { const ledger = new TaskLedger(ledgerPath); for (const task of input.tasks) ledger.recordInstruction(task); }
  return { applied: apply, count: input.tasks.length };
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) { console.error('Usage: node orchestrator/seed-tasks.mjs /private/tasks.json [--apply]'); process.exitCode = 1; }
  else { try { console.log(JSON.stringify(seedTasks({ sourceFile: args[0], ledgerPath: defaultLedgerPath(), apply: args[1] === '--apply' }))); } catch { console.error('Could not import tasks'); process.exitCode = 1; } }
}
