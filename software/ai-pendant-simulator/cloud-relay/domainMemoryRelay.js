/*
 * The relay's read/write seam onto capability-domain memory.
 *
 * The hive block lives inside the fleet-state document (shared/domainMemory.js
 * puts it under DOMAIN_MEMORY_FIELD), and this module is the only relay-side
 * code that reaches into it. Two consumers:
 *
 *   - the HTTP routes (GET/POST /v1/memory/domains in server.js), which are
 *     how the Mac planner and the browser brain fetch and contribute facts;
 *   - the voice brain's `domainMemory` session option (openaiRealtimeVoice.js),
 *     built by createDomainMemoryRelay() so pendantConverse.js stays thin.
 *
 * The design it serves, in the owner's words (2026-08-12): "tools should be
 * combined with memories" — a domain's facts are fetched when that domain's
 * tool is selected and attached to the tool's context, never spliced into a
 * system prompt.
 */
import {
  DOMAIN_MEMORY_FIELD,
  lookupDomainFacts,
  mergeDomainMemory,
  normalizeDomainMemoryBlock,
  renderDomainFactLines,
} from '../shared/domainMemory.js'
import { FLEET_STATE_KEY } from './fleetContext.js'

/**
 * Read the hive block and answer one lookup: this domain's facts (or all
 * domains when domain is null), best-matching first, bounded, with the
 * secret-masked lines ready to hand a model.
 *
 * Best-effort like every fleet read: a store that throws costs the caller an
 * empty hand, never an exception — losing memory quality is survivable,
 * failing the tool call that asked is not.
 */
export async function readDomainMemory(
  store,
  { domain = null, query = '', limit = 8, now = Date.now() } = {},
) {
  let block
  try {
    const state = await store?.getState?.(FLEET_STATE_KEY)
    block = normalizeDomainMemoryBlock(state?.data?.[DOMAIN_MEMORY_FIELD], {
      now,
    })
  } catch {
    block = { version: 1, updatedAt: null, facts: [] }
  }
  const facts = lookupDomainFacts(block.facts, { domain, query, limit, now })
  return { facts, lines: renderDomainFactLines(facts) }
}

/**
 * Merge facts into the hive block and persist, preserving every other field
 * of the fleet document — this touches domainMemory and nothing else, and it
 * CREATES the fleet state when none exists yet (first save can precede the
 * first heartbeat).
 *
 * Unlike the read, a failed store here is an error, not an empty result: a
 * save that silently wrote nothing is the worst kind of memory bug, and the
 * read-before-merge is also load-bearing — writing without it would replace
 * the block instead of unioning into it.
 */
export async function saveDomainMemory(
  store,
  facts,
  { node = 'voice', updatedBy = null, now = Date.now() } = {},
) {
  if (
    typeof store?.getState !== 'function' ||
    typeof store?.saveState !== 'function'
  ) {
    throw new Error('This store cannot persist domain memory.')
  }

  const current = await store.getState(FLEET_STATE_KEY)
  const currentData =
    current?.data && typeof current.data === 'object' ? current.data : {}

  /* Fill-in stamp, not an override: a caller that already attributed a fact
   * to a body keeps its attribution; only unstamped facts get this seam's
   * node name. */
  const stamped = (Array.isArray(facts) ? facts : []).map((fact) => ({
    node,
    ...(fact && typeof fact === 'object' ? fact : {}),
  }))

  const merged = mergeDomainMemory(
    currentData[DOMAIN_MEMORY_FIELD],
    stamped,
    { now },
  )
  await store.saveState(
    FLEET_STATE_KEY,
    { ...currentData, [DOMAIN_MEMORY_FIELD]: merged.block },
    { updatedBy: updatedBy || node },
  )
  return merged.stats
}

/**
 * The voice brain's `domainMemory` session option, as two closures over the
 * store — exactly the shape createStreamingRealtimeSession consumes:
 *
 *   { lookup: async ({domain, query}) => ({facts, lines}),
 *     save:   async (facts) => stats }
 */
export function createDomainMemoryRelay({
  store,
  node = 'voice',
  limit = 8,
  updatedBy = null,
} = {}) {
  return {
    lookup: ({ domain = null, query = '' } = {}) =>
      readDomainMemory(store, { domain, query, limit }),
    save: (facts) =>
      saveDomainMemory(store, facts, { node, updatedBy: updatedBy || node }),
  }
}
