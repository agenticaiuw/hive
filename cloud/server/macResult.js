/*
 * Compact a Mac execution result for a Realtime function_call_output: keep
 * the fields the model needs to speak an answer, cap the per-action outputs
 * so a chatty command can't blow up the conversation context.
 */
export function trimMacResultForModel(result) {
  const actionResults = Array.isArray(result.results)
    ? result.results.slice(0, 6).map((entry) => {
        const text = JSON.stringify(entry) || ''
        return text.length > 400 ? `${text.slice(0, 400)}…` : entry
      })
    : undefined

  return {
    executed: Boolean(result.executed),
    response: String(result.response || '').slice(0, 400) || undefined,
    executionError:
      String(result.executionError || '').slice(0, 400) || undefined,
    results: actionResults,
  }
}

export async function waitForMacResult(store, jobId, { now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + 9000
  while (now() < deadline) {
    const current = await store.getJob(jobId).catch(() => null)
    const result = current?.result
    if (
      result &&
      (result.phase === 'executed' ||
        result.executed === true ||
        result.executionError ||
        current.status === 'completed')
    ) {
      return trimMacResultForModel(result)
    }
    await sleep(300)
  }
  return null
}
