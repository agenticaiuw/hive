import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, readFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskLedger } from '../orchestrator/task-ledger.mjs';

function setup(t) { const dir = mkdtempSync(join(tmpdir(), 'hive-ledger-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'tasks.jsonl'); }
const instruction = { id: 'one', sourceId: 'conversation:message-1', text: 'Prepare report' };
const evidence = { source: 'local test', reference: 'artifact:report', summary: 'Report contents checked', observedAt: '2026-11-10T00:00:00Z' };

test('instructions persist across restart, dedupe by source and never complete on admission', t => {
  const path = setup(t); const ledger = new TaskLedger(path);
  ledger.recordInstruction(instruction); ledger.startAttempt('one', 'attempt-1'); ledger.recordAdmission('one', 'attempt-1', 'accepted');
  const resumed = new TaskLedger(path); assert.equal(resumed.recordInstruction(instruction).status, 'accepted');
  assert.equal(resumed.reconcile().unfinished[0].next, 'await_completion_evidence');
  assert.throws(() => resumed.recordInstruction({ ...instruction, text: 'Different work' }), /Conflicting/);
  assert.throws(() => resumed.startAttempt('one'), /not eligible/);
  assert.throws(() => resumed.complete('one', { source: 'admission' }), /evidence/);
  resumed.complete('one', evidence); assert.equal(new TaskLedger(path).reconcile().unfinished.length, 0);
});

test('stops and approval survive restart and require explicit resume', t => {
  const path = setup(t); const first = new TaskLedger(path);
  first.recordInstruction({ ...instruction, irreversible: true }); first.stop('user requested stop');
  let second = new TaskLedger(path); assert.throws(() => second.startAttempt('one'), /stopped/);
  assert.throws(() => second.resume({ authorization: 'timer', reason: 'elapsed' }), /Explicit/);
  second.resume({ authorization: 'explicit_user', reason: 'resume requested' });
  assert.throws(() => second.startAttempt('one'), /Approval/);
  assert.throws(() => second.approve('one', { authorization: 'automatic', reason: 'inferred' }), /Explicit/);
  second.approve('one', { authorization: 'explicit_user', reason: 'reviewed' }); second.startAttempt('one', 'a1');
  second = new TaskLedger(path); assert.equal(second.reconcile().unfinished[0].next, 'inspect_interrupted_attempt');
  assert.throws(() => second.startAttempt('one'), /not eligible/);
});

test('parent completion requires its children and independently attributable evidence', t => {
  const ledger = new TaskLedger(setup(t)); ledger.recordInstruction(instruction);
  ledger.recordInstruction({ id: 'child', sourceId: 'child-source', text: 'Collect data', parentId: 'one' });
  ledger.startAttempt('one', 'a1'); ledger.recordAdmission('one', 'a1', 'accepted');
  ledger.startAttempt('child', 'a2'); ledger.recordAdmission('child', 'a2', 'unknown');
  assert.throws(() => ledger.complete('one', evidence), /Child/);
  ledger.complete('child', evidence); ledger.complete('one', evidence);
  assert.equal(ledger.snapshot().tasks.find(t => t.id === 'one').status, 'completed');
});

test('unknown work is not replayed; corrupt or locked journals fail closed', t => {
  const path = setup(t); const ledger = new TaskLedger(path); ledger.recordInstruction(instruction);
  ledger.startAttempt('one', 'a'); ledger.recordAdmission('one', 'a', 'unknown', 'lost_response');
  assert.equal(ledger.reconcile().unfinished[0].next, 'investigate_unknown');
  assert.throws(() => ledger.startAttempt('one'), /not eligible/);
  writeFileSync(`${path}.lock`, 'locked'); assert.throws(() => ledger.stop('stop'), /EEXIST/);
  rmSync(`${path}.lock`); appendFileSync(path, '{truncated');
  assert.throws(() => ledger.snapshot(), /Incomplete ledger tail/);
  assert.throws(() => ledger.stop('stop'), /Incomplete ledger tail/);
});

test('a newly linked child reopens a completed parent without losing the historical record', t => {
  const ledger = new TaskLedger(setup(t)); ledger.recordInstruction(instruction); ledger.startAttempt('one', 'a'); ledger.recordAdmission('one', 'a', 'accepted'); ledger.complete('one', evidence);
  ledger.recordInstruction({ id: 'new-child', sourceId: 'source-child', text: 'Follow up', parentId: 'one' });
  const parent = ledger.snapshot().tasks.find(t => t.id === 'one');
  assert.equal(parent.status, 'accepted'); assert.equal(parent.evidence, undefined);
  assert.throws(() => ledger.complete('one', evidence), /Child/);
  assert.equal(ledger.read().events.some(e => e.type === 'completed' && e.taskId === 'one'), true);
});

test('private task imports are idempotent and never claim completion', async t => {
  const { seedTasks } = await import('../orchestrator/seed-tasks.mjs');
  const path = setup(t); const sourceFile = join(path, '..', 'tasks.json');
  writeFileSync(sourceFile, JSON.stringify({ tasks: [{ id: 'fixture', sourceId: 'fixture-source', text: 'Prepare a fixture', constraints: ['No external effects'] }] }));
  seedTasks({ sourceFile, ledgerPath: path, apply: true }); seedTasks({ sourceFile, ledgerPath: path, apply: true });
  const tasks = new TaskLedger(path).snapshot().tasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'pending');
  assert.equal(tasks[0].constraints[0], 'No external effects');
});

test('reconciliation monitor checks immediately and reports stale or failed observations', async t => {
  const { startReconciliationMonitor } = await import('../orchestrator/local-agent-ledger.mjs');
  const ledger = new TaskLedger(setup(t)); ledger.recordInstruction(instruction);
  let clock = 0; const monitor = startReconciliationMonitor(ledger, { intervalMs: 1000, now: () => clock }); t.after(() => monitor.close());
  assert.equal(monitor.status().stale, false); assert.equal(monitor.status().lastCheckedAt, '1970-01-01T00:00:00.000Z');
  clock = 2001; assert.equal(monitor.status().stale, true); monitor.check(); assert.equal(monitor.status().stale, false);
  writeFileSync(`${ledger.path}.lock`, 'lock'); appendFileSync(ledger.path, '{'); monitor.check();
  assert.equal(monitor.status().error, 'Ledger reconciliation failed');
});

test('refuses symlink and non-private ledger files without touching their contents', t => {
  const path = setup(t); const target = `${path}.target`; writeFileSync(target, 'untouched', { mode: 0o600 }); symlinkSync(target, path);
  const ledger = new TaskLedger(path); assert.throws(() => ledger.recordInstruction(instruction));
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  rmSync(path); writeFileSync(path, '', { mode: 0o600 }); chmodSync(path, 0o644);
  assert.throws(() => ledger.recordInstruction(instruction), /private regular file/);
});

test('encrypts new instruction text and withholds obvious credentials', t => {
  const path = setup(t), ledger = new TaskLedger(path);
  ledger.recordInstruction(instruction);
  ledger.recordInstruction({ id: 'secret', sourceId: 'secret-source', text: 'password: private-test-secret' });
  const disk = readFileSync(path, 'utf8');
  assert.equal(disk.includes(instruction.text), false); assert.equal(disk.includes('private-test-secret'), false);
  const tasks = new TaskLedger(path).snapshot().tasks;
  assert.equal(tasks[0].text, instruction.text); assert.match(tasks[1].text, /withheld/);
  assert.equal(ledger.matchesInstruction(tasks[1], 'password: private-test-secret'), true);
});

test('migration retains original backup, state and identity; failed replacement leaves original valid', async t => {
  const { createHash } = await import('node:crypto');
  const { migrateEncryption } = await import('../orchestrator/migrate-encryption.mjs');
  const path = setup(t); const ledger = new TaskLedger(path); ledger.recordInstruction(instruction);
  const originalEvent = JSON.parse(readFileSync(path, 'utf8').trim());
  const { hash: _, ...content } = originalEvent; content.text = instruction.text;
  const legacy = JSON.stringify({ ...content, hash: createHash('sha256').update(JSON.stringify(content)).digest('hex') }) + '\n';
  writeFileSync(path, legacy, { mode: 0o600 });
  assert.throws(() => migrateEncryption({ ledgerPath: path, apply: true, beforeReplace: () => { throw new Error('fixture crash'); } }), /fixture crash/);
  assert.equal(readFileSync(path, 'utf8'), legacy); assert.equal(ledger.snapshot().tasks[0].text, instruction.text);
  const result = migrateEncryption({ ledgerPath: path, apply: true });
  assert.equal(result.migrated, 1); assert.equal(readFileSync(result.backup, 'utf8'), legacy);
  assert.equal(readFileSync(path, 'utf8').includes(instruction.text), false);
  assert.equal(ledger.snapshot().tasks[0].sourceId, instruction.sourceId);
});

test('personal-agent receipt reconciliation is idempotent and never makes uncertain work dispatchable', async t => {
  const { reconcilePersonalAgentReceipts } = await import('../orchestrator/personal-agent-reconcile.mjs');
  const ledger = new TaskLedger(setup(t)); ledger.stop('user stopped');
  const receipts = [{ receiptId: '1234567890abcdef1234567890abcdef', status: 'dispatching', text: 'fixture work', textOmitted: false }];
  assert.deepEqual(reconcilePersonalAgentReceipts({ ledger, receipts, observedAt: '2026-11-10T00:00:00Z' }), { imported: 1, matched: 0 });
  const task = ledger.snapshot().tasks[0]; assert.equal(task.status, 'unknown');
  assert.deepEqual(reconcilePersonalAgentReceipts({ ledger, receipts, observedAt: '2026-11-10T00:00:01Z' }), { imported: 0, matched: 1 });
  assert.equal(ledger.snapshot().tasks.length, 1);
  ledger.resume({ authorization: 'explicit_user', reason: 'resume requested' });
  assert.throws(() => ledger.startAttempt(task.id), /not eligible/);
  receipts[0].status = 'accepted'; reconcilePersonalAgentReceipts({ ledger, receipts, observedAt: '2026-11-10T00:00:02Z' });
  assert.equal(ledger.reconcile().unfinished[0].next, 'await_completion_evidence');
  receipts[0].status = 'unknown'; assert.throws(() => reconcilePersonalAgentReceipts({ ledger, receipts, observedAt: '2026-11-10T00:00:03Z' }), /Conflicting terminal/);
});

test('a receipt already linked to a mesh task does not create a duplicate', async t => {
  const { reconcilePersonalAgentReceipts } = await import('../orchestrator/personal-agent-reconcile.mjs');
  const ledger = new TaskLedger(setup(t)); ledger.recordInstruction(instruction); ledger.startAttempt('one', 'a'); ledger.recordAdmission('one', 'a', 'accepted');
  ledger.addEvidence('one', { ...evidence, reference: 'receipt:1234567890abcdef1234567890abcdef' });
  assert.deepEqual(reconcilePersonalAgentReceipts({ ledger, receipts: [{ receiptId: '1234567890abcdef1234567890abcdef', status: 'accepted', text: 'fixture' }], observedAt: '2026-11-10T00:00:01Z' }), { imported: 0, matched: 1 });
  assert.equal(ledger.snapshot().tasks.length, 1); assert.equal(ledger.snapshot().tasks[0].status, 'accepted');
});

test('authorized publication and retirement still wait for completion prerequisites', t => {
  const ledger = new TaskLedger(setup(t));
  ledger.recordInstruction({ id: 'integration', sourceId: 'fixture:integration', text: 'Integrate' });
  ledger.recordInstruction({ id: 'publish', sourceId: 'fixture:publish', text: 'Publish', requiresApproval: true });
  ledger.recordInstruction({ id: 'retire', sourceId: 'fixture:retire', text: 'Retire', requiresApproval: true, irreversible: true });
  ledger.setDependencies('publish', ['integration']); ledger.setDependencies('retire', ['integration', 'publish']);
  ledger.approve('publish', { authorization: 'explicit_user', reason: 'Requested after verification' });
  ledger.approve('retire', { authorization: 'explicit_user', reason: 'Requested after integration' });
  assert.throws(() => ledger.startAttempt('publish'), /Prerequisite/);
  assert.throws(() => ledger.startAttempt('retire'), /Prerequisite/);
  assert.equal(ledger.reconcile().unfinished.find(task => task.id === 'retire').next, 'await_prerequisites');
});

test('receipt page scans restart at the beginning and incomplete scans write nothing', async t => {
  const { reconcilePersonalAgentPages } = await import('../orchestrator/personal-agent-reconcile.mjs');
  const ledger = new TaskLedger(setup(t)); const calls = [];
  const one = { receiptId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'unknown', text: 'fixture one' };
  const two = { receiptId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'accepted', text: 'fixture two' };
  const fetchPage = async cursor => { calls.push(cursor); return cursor === null ? { receipts: [one], nextCursor: 'next' } : { receipts: [two], nextCursor: null }; };
  assert.deepEqual(await reconcilePersonalAgentPages({ ledger, fetchPage }), { imported: 2, matched: 0, pages: 2 });
  await reconcilePersonalAgentPages({ ledger, fetchPage }); assert.deepEqual(calls, [null, 'next', null, 'next']);
  const another = new TaskLedger(`${ledger.path}-other`);
  await assert.rejects(reconcilePersonalAgentPages({ ledger: another, fetchPage: async cursor => cursor === null ? { receipts: [one], nextCursor: 'next' } : Promise.reject(new Error('fixture failure')) }), /fixture failure/);
  assert.equal(another.snapshot().tasks.length, 0);
});

test('missing personal-agent receipt store is unavailable, not an empty result', async t => {
  const { createPersonalAgentPageReader } = await import('../orchestrator/personal-agent-reader.mjs');
  const path = setup(t); const reader = createPersonalAgentPageReader({ executable: '/unused', controlDirectory: join(path, '..', 'absent') });
  await assert.rejects(reader(null), /unavailable/);
});

test('a later explicit approval requirement revokes prior authorization', t => {
  const ledger = new TaskLedger(setup(t));
  ledger.recordInstruction({ ...instruction, requiresApproval: true });
  ledger.approve('one', { authorization: 'explicit_user', reason: 'initial approval' });
  ledger.revokeApproval('one', 'user requested review before proceeding');
  assert.equal(new TaskLedger(ledger.path).reconcile().unfinished[0].next, 'await_approval');
  assert.throws(() => ledger.startAttempt('one'), /Approval/);
});
