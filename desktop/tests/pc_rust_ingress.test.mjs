// Cross-runtime fixture; run with HIVEMIND_PERSONAL_AGENT_HELPER pointing to a
// freshly built local-requests binary. No live agent or credentials are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PcMeshBridge } from '../mesh-bridge.mjs';
import { TaskLedger } from '../../cloud/orchestrator/task-ledger.mjs';
import { reconcilePersonalAgentReceipts } from '../../cloud/orchestrator/personal-agent-reconcile.mjs';
import { reconcilePersonalAgentPages } from '../../cloud/orchestrator/personal-agent-reconcile.mjs';
import { createPersonalAgentPageReader } from '../../cloud/orchestrator/personal-agent-reader.mjs';

const helper = process.env.HIVEMIND_PERSONAL_AGENT_HELPER;
test('mesh dispatch records its Rust ingress receipt and never redispatches', { skip: !helper }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-rust-ingress-'));
  const child = spawn(helper, [dir], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)); rmSync(dir, { recursive: true, force: true }); });
  let executions = 0;
  const reader = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => { child.once('error', reject); reader.on('line', line => { const event = JSON.parse(line); if (event.type === 'ready') resolve(); else if (event.type === 'request') { executions++; child.stdin.write(JSON.stringify({ id: event.id, result: { ok: true } }) + '\n'); } }); });
  await ready;
  const message = { id: 'nmsg_12345678', from: 'phone-1', to: 'pc-1', kind: 'pc.request.submit', payload: { text: 'fixture request' }, expiresAt: '2099-01-01T00:00:00Z' };
  const calls = [];
  const fetchImpl = async (url, options) => { const body = options.body && JSON.parse(options.body); calls.push({ path: url.pathname, body }); return { ok: true, json: async () => ({ ok: true, messages: [message] }) }; };
  const ledger = new TaskLedger(join(dir, 'hivemind.jsonl'));
  const bridge = new PcMeshBridge({ relayUrl: 'http://127.0.0.1:1234', token: 'fixture', deviceId: 'pc-1', allowedSenders: ['phone-1'], socketPath: join(dir, 'request.sock'), journalPath: join(dir, 'bridge.json'), ledger, fetchImpl });
  await bridge.pollOnce(); await bridge.pollOnce();
  const task = ledger.snapshot().tasks[0];
  assert.equal(executions, 1); assert.equal(task.status, 'accepted');
  assert.match(task.observations[0].reference, /^receipt:[a-f0-9]{32}$/);
  assert.equal(task.observations.length, 1); assert.equal(calls[1].body.payload.status, 'accepted');
  const receipts = JSON.parse(execFileSync(join(dirname(helper), 'agent-request-ledger'), [dir], { encoding: 'utf8' }));
  assert.deepEqual(reconcilePersonalAgentReceipts({ ledger, receipts }), { imported: 0, matched: 1 });
  const pageReader = createPersonalAgentPageReader({ executable: join(dirname(helper), 'agent-request-ledger'), controlDirectory: dir });
  assert.deepEqual(await reconcilePersonalAgentPages({ ledger, fetchPage: pageReader }), { imported: 0, matched: 1, pages: 1 });
  assert.equal(ledger.snapshot().tasks.length, 1);
});
