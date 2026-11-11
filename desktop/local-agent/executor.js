import { recordGapSafely } from './capabilityGapInbox.js'
import { executeComputerAction } from './computerControl.js'
import { buildActionReceipt, observeBeforeAction } from './actionReceipts.js'

export async function executeActions(actions) {
  const results = []

  for (const action of actions) {
    // Observation only: this records what the action is about to touch and
    // snapshots anything it would clobber. It never inspects the verdict and
    // never skips a step — the owner asked for a record, not a gate.
    const startedAt = new Date().toISOString()
    const before = observeBeforeAction(action)
    let result

    try {
      result = await executeComputerAction(action)
    } catch (error) {
      /*
       * A plan step no dispatcher has a handler for is design demand, not just
       * a failure. computerControl.executeComputerAction throws this exact
       * prefix. recordGapSafely never throws — the failed step must still be
       * reported to the owner exactly as before.
       */
      if (String(error?.message ?? '').startsWith('Unsupported action type')) {
        recordGapSafely({
          source: 'executor-missing-action',
          want: String(action?.label || action?.type || 'unknown action'),
          detail: String(error.message),
          surface: 'executor',
        })
      }
      result = {
        action,
        ok: false,
        status: isBlockedError(error) ? 'blocked' : 'failed',
        message: isBlockedError(error)
          ? `Blocked for safety: ${error.message}`
          : `Failed: ${error.message}`,
        reason: error.message,
      }
    }

    results.push({
      ...result,
      receipt: buildActionReceipt({ action, result, before, startedAt }),
    })
  }

  return results
}

function isBlockedError(error) {
  const message = String(error?.message ?? '')
  return [
    'AGENT_TOKEN is not configured',
    'RELAY_API_KEY is not configured',
    'invalid pairing code',
    'invalid or missing agent token',
    'invalid or missing relay',
  ].some((phrase) => message.includes(phrase))
}
