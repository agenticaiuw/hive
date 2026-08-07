/*
 * Stop an agent recording something the system already has.
 *
 * The capability prompt has always said "do not restate anything already in the
 * backlog", and the backlog is in the agent's context. It did not work: across
 * 204 ledger entries there are 11 near-duplicate pairs and one exact one. An
 * instruction not to repeat yourself is advice; agents took the advice about as
 * well as people do.
 *
 * So make it structural, the same way the commons deposit is a side effect
 * rather than a tool an agent must remember to call. A proposal that restates an
 * existing one does not get recorded — the agent is handed the entry it
 * collided with and told to build past it. It can still propose; it cannot
 * propose the same thing twice.
 *
 * Deliberately similarity over an exact hash. Duplicates here are not textually
 * identical: they are the same idea in different words ("Fill out this web form
 * from the information I give you, stop before submitting" three separate
 * times, from different agents, in different rounds). An exact-match check
 * would have caught one of the eleven.
 */

/*
 * Jaccard over content words, measured across all 20,706 pairs in the ledger.
 *
 * There is NO natural break to put a threshold in. The scores decay smoothly:
 * 1.000, 0.688, 0.571, 0.545, 0.526, 0.525, 0.500, 0.500, 0.455, 0.455, 0.455,
 * 0.440, 0.438, 0.429, 0.409… Any single cut is a judgement call sitting
 * between two neighbours a hundredth apart, and pretending otherwise would be
 * inventing a cliff to justify a number.
 *
 * The costs are asymmetric and argue for cutting HIGH: blocking a real proposal
 * loses an idea, where letting a duplicate through costs one restated round and
 * is visible in the backlog afterwards. That argument produced 0.5 — and the
 * data then refused it. The known duplicate pair, the same request written
 * twice by different agents, scores **0.462**:
 *
 *   "Fill out this web form from the information I give you, stop before submitting"
 *   "Fill out this online form using the details we discussed, stop before submitting"
 *
 * A threshold that misses that is a threshold that does nothing, so 0.45 it is.
 * What answers the asymmetry instead is that a block is not a loss: the agent
 * is handed the entry it collided with inside the same round and can say what
 * its idea is that the existing one is not. A re-proposal forced to name its
 * own difference is worth more than the duplicate it replaced.
 *
 * Two lines rather than one. At or above BLOCK_AT (11 pairs in the ledger,
 * 0.05% of all pairs) the entry is refused. In the band between, it is recorded
 * WITH the neighbour attached, so a genuine refinement survives and the agent
 * can see what it is near. Below, nothing happens.
 */
export const BLOCK_AT = 0.45
export const WARN_AT = 0.35

/* Words shorter than this carry no topic — "the", "and", "for", "with". */
const MIN_WORD = 4

export function fingerprint(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((word) => word.length >= MIN_WORD),
  )
}

export function similarity(left, right) {
  const a = left instanceof Set ? left : fingerprint(left)
  const b = right instanceof Set ? right : fingerprint(right)
  /* Too little to compare is not the same as identical. Two three-word entries
   * sharing every word say nothing about whether they are the same idea. */
  if (a.size < MIN_WORD || b.size < MIN_WORD) return 0

  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * Find what an incoming entry restates, if anything.
 *
 * `existing` is anything with text to compare; `describe` pulls the comparable
 * text out of one. Kept as a parameter rather than reaching into a known shape,
 * because proposals and changes carry their content under different fields and
 * a function that knows both is a function that breaks when a third appears.
 */
export function findDuplicate(incoming, existing, describe, threshold = WARN_AT) {
  const mine = fingerprint(describe(incoming))
  if (!mine.size) return null

  let best = null
  for (const candidate of existing) {
    const score = similarity(mine, fingerprint(describe(candidate)))
    if (score >= threshold && (!best || score > best.score)) best = { entry: candidate, score }
  }
  if (!best) return null
  return { ...best, verdict: best.score >= BLOCK_AT ? 'block' : 'warn' }
}
