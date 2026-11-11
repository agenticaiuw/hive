#!/usr/bin/env node
// Start the VM worker. State (browser profile, post ledger, uploads, evidence) lives under
// HIVE_VM_STATE (default ~/.hive/vm-agent), readable by this user only.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from './agent.mjs';

const stateDir = process.env.HIVE_VM_STATE ?? join(homedir(), '.hive', 'vm-agent');
const agent = createAgent({
  stateDir,
  executable: process.env.HIVE_VM_BROWSER,
  headless: process.env.HIVE_VM_HEADLESS === '1',
  viewerPort: Number(process.env.HIVE_VM_VIEW_PORT ?? 38917),
  log: line => console.log(`${new Date().toISOString()} ${line}`),
});
await agent.listen(join(stateDir, 'control.sock'));

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await agent.close().catch(() => {});
    process.exit(0);
  });
}
