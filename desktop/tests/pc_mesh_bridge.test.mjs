import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PcMeshBridge, REQUEST_KIND, RESULT_KIND } from '../mesh-bridge.mjs';

function setup(t, messages) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-mesh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  let rejectSend = false;
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    calls.push({ path: url.pathname, body: options.body && JSON.parse(options.body) });
    if (url.pathname === '/v1/node/messages' && rejectSend) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ ok: true, messages }) };
  };
  const args = { relayUrl: 'http://127.0.0.1:1234', token: 'test-only', deviceId: 'node-pc', allowedSenders: ['node-phone'], socketPath: '/unused', journalPath: join(dir, 'journal.json'), fetchImpl };
  return { args, calls, failSend: value => { rejectSend = value; } };
}
const request = (overrides = {}) => ({ id: 'nmsg_12345678', from: 'node-phone', to: 'node-pc', kind: REQUEST_KIND, payload: { text: 'inspect files' }, expiresAt: '2099-01-01T00:00:00Z', ...overrides });

test('sends a correlated admission result and acknowledges only after delivery', async t => {
  const f = setup(t, [request()]); let executions = 0;
  const bridge = new PcMeshBridge({ ...f.args, submit: async ({ text }) => { executions++; assert.equal(text, 'inspect files'); return { accepted: true }; } });
  assert.deepEqual(await bridge.pollOnce(), { processed: 1 });
  assert.equal(executions, 1);
  assert.equal(f.calls[1].body.kind, RESULT_KIND);
  assert.equal(f.calls[1].body.correlationId, 'nmsg_12345678');
  assert.deepEqual(f.calls[1].body.payload, { status: 'accepted' });
  assert.equal(f.calls[2].path, '/v1/node/inbox/ack');
  assert.equal(readFileSync(f.args.journalPath, 'utf8').includes('inspect files'), false);
});

test('failed result delivery never repeats dispatch, including after restart', async t => {
  const f = setup(t, [request()]); let executions = 0;
  const args = { ...f.args, submit: async () => { executions++; return { accepted: true }; } };
  f.failSend(true);
  await assert.rejects(new PcMeshBridge(args).pollOnce(), /HTTP 503/);
  assert.equal(f.calls.some(c => c.path.endsWith('/ack')), false);
  f.failSend(false);
  await new PcMeshBridge(args).pollOnce();
  assert.equal(executions, 1);
});

test('rejects untrusted senders without executing and preserves other kinds', async t => {
  const f = setup(t, [request({ from: 'node-other' }), request({ id: 'nmsg_87654321', kind: 'other.kind' })]);
  const bridge = new PcMeshBridge({ ...f.args, submit: async () => assert.fail('must not run') });
  assert.deepEqual(await bridge.pollOnce(), { processed: 1 });
  assert.deepEqual(f.calls[1].body.payload, { status: 'rejected', reason: 'sender_not_allowed' });
});

test('dispatch errors are unknown and insecure remote relays are rejected', async t => {
  const f = setup(t, [request()]);
  assert.throws(() => new PcMeshBridge({ ...f.args, relayUrl: 'http://example.com' }), /HTTPS/);
  await new PcMeshBridge({ ...f.args, submit: async () => { throw new Error('socket died'); } }).pollOnce();
  assert.deepEqual(f.calls[1].body.payload, { status: 'unknown', reason: 'dispatch_failed' });
});

test('generic local socket refusal is unknown because it is also used for timeouts', async t => {
  const f = setup(t, [request()]);
  await new PcMeshBridge({ ...f.args, submit: async () => ({ accepted: false, error: 'Request not accepted; check agent availability.' }) }).pollOnce();
  assert.deepEqual(f.calls[1].body.payload, { status: 'unknown', reason: 'agent_response_ambiguous' });
});

test('ledger records before dispatch, respects persistent stop, and never completes on admission', async t => {
  const { TaskLedger } = await import('../../cloud/orchestrator/task-ledger.mjs');
  const f = setup(t, [request()]); const ledger = new TaskLedger(`${f.args.journalPath}.tasks`); let calls = 0;
  ledger.stop('user stopped execution');
  const args = { ...f.args, ledger, submit: async () => { calls++; return { accepted: true }; } };
  await assert.rejects(new PcMeshBridge(args).pollOnce(), /Execution stopped/);
  assert.equal(calls, 0); assert.equal(ledger.snapshot().tasks[0].status, 'pending');
  ledger.resume({ authorization: 'explicit_user', reason: 'user resumed execution' });
  await new PcMeshBridge(args).pollOnce();
  assert.equal(calls, 1); assert.equal(ledger.snapshot().tasks[0].status, 'accepted');
  assert.equal(ledger.reconcile().unfinished[0].next, 'await_completion_evidence');
});

test('an interrupted ledger attempt without a bridge journal is never replayed', async t => {
  const { TaskLedger } = await import('../../cloud/orchestrator/task-ledger.mjs');
  const f = setup(t, [request()]); const ledger = new TaskLedger(`${f.args.journalPath}.tasks`);
  ledger.recordInstruction({ id: 'nmsg_12345678', sourceId: 'mesh:node-pc:nmsg_12345678', text: 'inspect files' });
  ledger.startAttempt('nmsg_12345678', 'nmsg_12345678');
  await new PcMeshBridge({ ...f.args, ledger, submit: async () => assert.fail('must not replay') }).pollOnce();
  assert.equal(ledger.snapshot().tasks[0].status, 'unknown');
  assert.deepEqual(f.calls[1].body.payload, { status: 'unknown', reason: 'dispatch_interrupted' });
});

test('a stop observed after journaling prevents the pending local socket dispatch', async t => {
  const { TaskLedger } = await import('../../cloud/orchestrator/task-ledger.mjs');
  const f = setup(t, [request()]); const ledger = new TaskLedger(`${f.args.journalPath}.tasks`);
  const bridge = new PcMeshBridge({ ...f.args, ledger, submit: async () => assert.fail('must not dispatch') });
  const save = bridge.save.bind(bridge); let first = true;
  bridge.save = () => { save(); if (first) { first = false; ledger.stop('explicit stop'); } };
  await bridge.pollOnce();
  assert.equal(ledger.snapshot().tasks[0].status, 'rejected');
  assert.equal(f.calls[1].body.payload.reason, 'execution_stopped_before_dispatch');
});
