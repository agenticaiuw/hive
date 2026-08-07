/*
 * The receiving half of cross-environment context migration.
 *
 * A relay-dispatched job arrives with a handle, not a context. This module
 * spends the handle: it pulls the stored reasoning thread, reshapes it for the
 * model this body actually runs, and hands back messages the planner can put
 * in front of the new request.
 *
 * Everything here is an optimisation and behaves like one. A missing handle,
 * an expired handle, a relay that is unreachable, a malformed payload — all of
 * them return `{ resumed: false }` and the planner starts cold, which is what
 * it did before any of this existed. Nothing in this file may fail a job.
 */
import { buildResumeMessages, parseContextHandle } from '../shared/contextHandoff.js'
import { RELAY_API_KEY, RELAY_URL } from './bridgeConfig.js'

/* A resume that takes longer than planning cold is worse than no resume. The
 * pendant is waiting on a spoken answer the whole time. */
const RESUME_TIMEOUT_MS = Number(process.env.CONTEXT_RESUME_TIMEOUT_MS || 2500)

/*
 * What this body can ingest. The Mac planner is a chat-completions call with
 * no tools declared, so replaying the relay's tool items verbatim would be
 * rejected by the provider — they are transcribed to prose instead. Reasoning
 * items are dropped: they are model-specific, and the relay is on
 * gpt-realtime-2.1 while this body is on gpt-5.6-luna.
 */
const MAC_PLANNER_ACCEPTS = Object.freeze({
  toolItems: false,
  reasoning: false,
})

export async function resumeContext(
  handle,
  { fetchImpl = fetch, relayUrl = RELAY_URL, apiKey = RELAY_API_KEY } = {},
) {
  if (!parseContextHandle(handle)) {
    return coldStart('no_handle')
  }

  let payload
  try {
    const response = await fetchImpl(`${relayUrl}/v1/context/resume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ handle }),
      signal: AbortSignal.timeout(RESUME_TIMEOUT_MS),
    })

    if (!response.ok) return coldStart(`relay_status_${response.status}`)
    payload = await response.json()
  } catch (error) {
    return coldStart(`relay_unreachable: ${error.message}`)
  }

  if (!payload?.resumed || !payload.context) {
    return coldStart(payload?.reason || 'missing_or_expired')
  }

  const { messages, notes, cacheKey } = buildResumeMessages(payload.context, {
    accepts: MAC_PLANNER_ACCEPTS,
  })

  if (!messages.length) return coldStart('empty_context')

  return {
    resumed: true,
    messages,
    notes,
    cacheKey,
    origin: payload.context.origin ?? null,
    originModel: payload.context.model ?? null,
    itemCount: Array.isArray(payload.context.items)
      ? payload.context.items.length
      : 0,
    bytes: Number(payload.context.bytes || 0),
  }
}

/*
 * Named rather than bare `null` because "we started cold" is a fact worth
 * having in a trace. A handoff that quietly stopped working would otherwise
 * look identical to one that was never attempted, and the only symptom would
 * be the discovery cost creeping back.
 */
function coldStart(reason) {
  return { resumed: false, reason, messages: [], notes: [], cacheKey: null }
}

/** One line for the thinking trace and the bridge log. */
export function describeResume(result) {
  if (!result?.resumed) {
    return `cold start (${result?.reason || 'no context'})`
  }

  const dropped = result.notes.filter((note) => note.action === 'dropped').length
  const transcribed = result.notes.filter(
    (note) => note.action === 'transcribed',
  ).length

  return (
    `resumed ${result.itemCount} item(s) from ${result.origin || 'another body'}` +
    ` (${result.bytes} bytes` +
    (transcribed ? `, ${transcribed} transcribed` : '') +
    (dropped ? `, ${dropped} dropped` : '') +
    ')'
  )
}
