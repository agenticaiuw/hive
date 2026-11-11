import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskLedger } from '../../cloud/orchestrator/task-ledger.mjs';
import { registerInstructionLedgerRoutes } from '../../cloud/orchestrator/local-agent-ledger.mjs';

test('local plan and execute share a durable instruction and stop blocks later work', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-instructions-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new TaskLedger(join(dir, 'ledger')); const app = express(); app.use(express.json());
  let cancelled = 0; registerInstructionLedgerRoutes(app, { ledger, cancelAll: () => { cancelled++; return ['fixture']; } });
  app.post('/plan', (req, res) => res.json({ instructionId: req.hivemindInstructionId }));
  app.post('/execute', (req, res) => { ledger.recordAdmission(req.hivemindInstructionId, req.hivemindInstructionId, 'accepted'); res.json({ ok: true }); });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const plan = await (await post('/plan', { command: 'inspect fixture' })).json();
  assert.ok(plan.instructionId); assert.equal(ledger.snapshot().tasks.length, 1);
  assert.equal((await post('/execute', { command: 'inspect fixture', instructionId: plan.instructionId })).status, 200);
  assert.equal(ledger.reconcile().unfinished[0].next, 'await_completion_evidence');
  assert.equal((await post('/instruction-ledger/stop', { reason: 'user stop' })).status, 200); assert.equal(cancelled, 1);
  assert.equal((await post('/plan', { command: 'second request' })).status, 409);
  assert.equal(new TaskLedger(join(dir, 'ledger')).reconcile().unfinished.length, 2);
  assert.equal((await post('/instruction-ledger/resume', { reason: 'user resumed' })).status, 200);
  assert.equal(ledger.snapshot().stopped, false);
});

test('stop cancels active work even if durable recording fails', async t => {
  const app = express(); app.use(express.json()); let cancelled = false;
  registerInstructionLedgerRoutes(app, { ledger: { stop: () => { throw new Error('locked'); } }, cancelAll: () => { cancelled = true; return []; } });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); }); t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/instruction-ledger/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 503); assert.equal(cancelled, true);
});

test('persistent stop blocks planner and executor before inference or action', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-stop-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.HIVEMIND_TASK_LEDGER; process.env.HIVEMIND_TASK_LEDGER = join(dir, 'tasks');
  t.after(() => { if (previous === undefined) delete process.env.HIVEMIND_TASK_LEDGER; else process.env.HIVEMIND_TASK_LEDGER = previous; });
  new TaskLedger(process.env.HIVEMIND_TASK_LEDGER).stop('user stop');
  const { orchestratePlan, orchestrateExecute } = await import('./orchestrator.js');
  await assert.rejects(orchestratePlan({ command: 'fixture' }), /Execution stopped/);
  await assert.rejects(orchestrateExecute({ command: 'fixture', actions: [] }), /Execution stopped/);
});

test('declared irreversible requests require explicit approval before dispatch', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-approval-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new TaskLedger(join(dir, 'ledger')); const app = express(); app.use(express.json()); registerInstructionLedgerRoutes(app, { ledger });
  let calls = 0; app.post('/execute', (_req, res) => { calls++; res.json({ ok: true }); });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); }); t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const blocked = await post('/execute', { command: 'fixture', irreversible: true }); assert.equal(blocked.status, 409);
  const { instructionId } = await blocked.json(); assert.equal(calls, 0);
  assert.equal((await post(`/instruction-ledger/${instructionId}/approve`, { reason: 'approved fixture' })).status, 200);
  assert.equal((await post('/execute', { command: 'fixture', instructionId })).status, 200); assert.equal(calls, 1);
});

test('direct research and briefing are captured before dispatch and never repeated', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-direct-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new TaskLedger(join(dir, 'ledger')); const app = express(); app.use(express.json());
  registerInstructionLedgerRoutes(app, { ledger }); let calls = 0;
  for (const route of ['/research', '/briefing']) app.post(route, (req, res) => {
    assert.equal(ledger.snapshot().tasks.find(task => task.id === req.hivemindInstructionId).status, 'dispatching');
    calls++; res.json({ ok: true });
  });
  app.post('/research/briefings/:id/speech', (_req, res) => res.json({ ok: true }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/research', { topic: 'fixture', instructionId: 'research-1' })).status, 200);
  assert.equal((await post('/research', { topic: 'fixture', instructionId: 'research-1' })).status, 409);
  assert.equal((await post('/briefing', { kind: 'morning' })).status, 200);
  assert.equal((await post('/research/briefings/x/speech', {})).status, 200);
  assert.equal(calls, 2); assert.equal(new TaskLedger(join(dir, 'ledger')).snapshot().tasks.length, 2);
  ledger.stop('user stop'); assert.equal((await post('/briefing', { kind: 'evening' })).status, 409); assert.equal(calls, 2);
});
