// Input JSON is read from stdin so instruction text does not enter shell history.
import { readFileSync } from 'node:fs';
import { TaskLedger } from './task-ledger.mjs';
import { defaultLedgerPath } from './local-agent-ledger.mjs';
import { reconcilePersonalAgentReceipts } from './personal-agent-reconcile.mjs';
const action = process.argv[2];
try {
  const ledger = new TaskLedger(defaultLedgerPath());
  const input = ['snapshot', 'reconcile'].includes(action) ? {} : JSON.parse(readFileSync(0, 'utf8'));
  const actions = {
    snapshot: () => ledger.snapshot(), reconcile: () => ledger.reconcile(),
    record: () => ledger.recordInstruction(input), stop: () => ledger.stop(input.reason),
    resume: () => ledger.resume({ authorization: 'explicit_user', reason: input.reason }),
    approve: () => ledger.approve(input.taskId, { authorization: 'explicit_user', reason: input.reason }),
    'revoke-approval': () => ledger.revokeApproval(input.taskId, input.reason),
    relate: () => ledger.relate(input.taskId, input.relatedId),
    'set-parent': () => ledger.setParent(input.taskId, input.parentId),
    dependencies: () => ledger.setDependencies(input.taskId, input.dependencies),
    complete: () => ledger.complete(input.taskId, input.evidence),
    observe: () => ledger.addEvidence(input.taskId, input.evidence),
    'reconcile-personal-agent': () => reconcilePersonalAgentReceipts({ ledger, receipts: input.receipts, observedAt: input.observedAt }),
  };
  if (!Object.hasOwn(actions, action)) throw new Error('Unknown action');
  console.log(JSON.stringify(actions[action](), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
