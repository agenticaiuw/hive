import { createHmac } from 'node:crypto';

// Planner output is a proposal, not evidence of execution. Stable identities
// make a partially persisted plan safe to project again after a crash.
export function recordPlanTasks(ledger, parentId, actions) {
  if (!parentId || !Array.isArray(actions)) throw new Error('Invalid plan');
  const parent = ledger.snapshot().tasks.find(task => task.id === parentId);
  if (!parent) throw new Error('Unknown plan instruction');
  return actions.map((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Invalid plan action');
    const label = typeof action.label === 'string' && action.label.trim() ? action.label.trim() :
      typeof action.type === 'string' && action.type.trim() ? action.type.trim() : `Action ${index + 1}`;
    // Include the full action in the identity but never store its parameters,
    // which can contain secrets. The task text remains subject to screening.
    const digest = createHmac('sha256', ledger.key(true)).update(JSON.stringify([parentId, index, action])).digest('hex');
    return ledger.recordInstruction({ id: `plan-${digest}`, sourceId: `plan:${digest}`, parentId,
      text: label, requiresApproval: parent.requiresApproval, irreversible: parent.irreversible,
      constraints: parent.constraints ?? [] });
  });
}
