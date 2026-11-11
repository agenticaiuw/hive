import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskLedger } from '../orchestrator/task-ledger.mjs';
import { recordPlanTasks } from '../orchestrator/plan-tasks.mjs';

test('plan proposals survive restart, are idempotent and never imply completion', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-plan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tasks'); let ledger = new TaskLedger(path);
  ledger.recordInstruction({ id: 'request', sourceId: 'fixture:1', text: 'Do two things', requiresApproval: true });
  const actions = [{ type: 'inspect', label: 'Inspect fixture', params: { secret: 'private-value' } }, { type: 'report' }];
  const tasks = recordPlanTasks(ledger, 'request', actions);
  ledger = new TaskLedger(path);
  assert.deepEqual(recordPlanTasks(ledger, 'request', actions).map(t => t.id), tasks.map(t => t.id));
  assert.equal(ledger.reconcile().unfinished.length, 3);
  assert.equal(tasks[0].parentId, 'request');
  assert.equal(tasks[0].requiresApproval, true);
  assert.throws(() => ledger.startAttempt(tasks[0].id), /Approval required/);
  assert.ok(!readFileSync(path, 'utf8').includes('private-value'));
  ledger.stop('stop');
  assert.throws(() => ledger.startAttempt(tasks[1].id), /stopped/i);
});
