/*
 * Is this proposal actually new, or is it three things that already exist?
 *
 * The corpus says the agents are not short of facts. Across 835 proposals the
 * most-restated one was asked eighteen times — "keep working after I stop
 * talking, then tell me what happened" — and every piece of it ships: the /jobs
 * queue, /jobs/:jobId/receipts, and /v1/pendant/announce, that last one on the
 * requesting agent's own surface. The commons had already put the routes in its
 * prompt. It asked twice more.
 *
 * The commons is an inventory, and an inventory does not show a path through
 * itself. A capability is a path — usually across surfaces — so this checks the
 * path an agent claims rather than the parts it can already see.
 *
 * What this deliberately does NOT do is decide whether a proposal is worth
 * making. It reports how much of it already exists and hands that back, because
 * "all of these exist" is sometimes exactly right (the connective tissue is the
 * work) and sometimes means the agent has re-requested a shipped feature. An
 * agent that can see the difference can make it; a gate that guessed would
 * suppress the first case to catch the second.
 */

/* A route or tool name, as it would appear in a directory line or a proposal. */
const PRIMITIVE = /(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9/:_.-]+)|(\/v?\d*\/?[a-z][A-Za-z0-9/:_-]{3,})|\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})\b/g

/**
 * Pull the primitives out of whatever the commons holds.
 *
 * Reads the entry payloads rather than a curated list, so a route that appears
 * tomorrow is known tomorrow without anything here being edited.
 */
export function knownPrimitives(entries, readContent) {
  const known = new Set()

  for (const entry of entries) {
    let content
    try {
      content = readContent(entry)
    } catch {
      continue
    }
    if (!content) continue

    const items = Array.isArray(content) ? content : Array.isArray(content?.items) ? content.items : []
    for (const item of items) {
      const name = typeof item === 'string' ? item : item?.name
      if (typeof name === 'string' && name.trim()) known.add(normalize(name))
    }
  }
  return known
}

export function normalize(name) {
  return String(name)
    .trim()
    .replace(/^(?:GET|POST|PUT|PATCH|DELETE)\s+/i, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Check what a proposal says it is built from against what is actually known.
 *
 * A name counts as found on a prefix match as well as an exact one, because an
 * agent writing `/jobs/:id` for a route recorded as `/jobs/:jobId` has
 * identified the right thing and pretending otherwise would teach it to be
 * vague rather than precise.
 */
export function checkReachability(builtFrom, known) {
  const claimed = (Array.isArray(builtFrom) ? builtFrom : [])
    .flatMap((entry) => String(entry).split(/[,;]/))
    .map(normalize)
    .filter((name) => name.length >= 4)

  if (!claimed.length) return { claimed: 0, found: [], unseen: [], verdict: 'unnamed' }

  const found = []
  const unseen = []
  for (const name of claimed) {
    /*
     * Exact first, then the closest. Both naive rules are wrong in opposite
     * directions and both were tried: taking the FIRST match collapsed
     * /jobs/:jobId/receipts onto the bare /jobs and reported an agent's two
     * distinct pieces as one, while taking the LONGEST resolved a bare /jobs
     * claim to /jobs/:jobId/receipts — a more specific thing the agent never
     * asked for. Resolving a claim to something narrower than it stated puts
     * words in its mouth, so among inexact hits the shortest wins.
     */
    const hits = [...known].filter(
      (candidate) => candidate === name || candidate.startsWith(name) || name.startsWith(candidate),
    )
    if (hits.includes(name)) found.push(name)
    else if (hits.length) found.push(hits.sort((a, b) => a.length - b.length)[0])
    else unseen.push(name)
  }

  return {
    claimed: claimed.length,
    found,
    /*
     * UNSEEN, not "missing". The commons is an inventory of what agents have
     * actually observed, and nobody has inventoried the relay's route table —
     * so /v1/pendant/announce reads as absent here while shipping in
     * production. Calling that "does not exist" would hand an agent a
     * confident falsehood, which is the exact failure the known-absent records
     * in commons.mjs exist to avoid. Absence from the store is not absence
     * from the world, and the wording has to carry that.
     */
    unseen,
    verdict: unseen.length === 0 ? 'assembled' : found.length ? 'partly' : 'unrecognised',
  }
}
