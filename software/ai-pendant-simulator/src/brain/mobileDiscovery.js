/*
 * The phone's library catalogue — same three-level design as the Mac's
 * local-agent/toolDiscovery.js, pointed at the phone's own dispatch table.
 *
 *   listDomains()          level 1 — a shelf label per section, small enough to
 *                          sit in the system prompt on every turn.
 *   listTools(domain)      level 2 — the spines in one section: names and one
 *                          line each, no parameters.
 *   describeTools(names)   level 3 — the full schema, for the handful named.
 *
 * WHY A CATALOGUE FOR THIRTEEN TOOLS. It is not, today, about prompt size: the
 * phone's whole schema is a few thousand characters and mobileBrain.js measures
 * it and ships it whole when it fits (see PROMPT_SCHEMA_BUDGET there). It is
 * about the two things the Mac learned the hard way. First, the model must be
 * able to ask for a shelf it was not given — `need_tools` — instead of
 * answering "I can't", which is what a fixed prompt teaches it to do. Second,
 * membership is DERIVED: this file never names a tool, so the day someone adds
 * one to mobileTools.js the prompt already has it. Both properties have to be
 * in place before the roster grows, not after.
 *
 * SCOPES ARE PART OF THE DERIVATION. A tool whose relay scopes the phone's
 * credential does not hold is not in the catalogue at all — it is in `blocked`,
 * with the missing scope named. Pair the phone as a narrower role, or revoke
 * and re-pair, and the prompt narrows with it. There is no second list to edit
 * and no prompt line advertising something the token would be refused for.
 *
 * ORDERING IS STABLE AND ALPHABETICAL everywhere, for the same reason as on the
 * Mac: a model reading two of these in one turn should not wonder if the list
 * moved.
 */
import {
  MOBILE_DOMAIN_NOTES,
  MOBILE_TOOLS,
} from './mobileTools.js'

export const UNCATEGORISED_DOMAIN = 'uncategorised'

/* One line for the shelf: the first sentence of what the tool says about
 * itself, capped. At level 2 the model is only deciding whether to look
 * closer; the full text is one describeTools call away. */
const SUMMARY_MAX = 150

function summarise(description) {
  const body = String(description ?? '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const stop = body.search(/[.!?](?:\s|$)/)
  const first = stop > 0 ? body.slice(0, stop + 1) : body
  if (first.length <= SUMMARY_MAX) return first
  return `${first.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
}

/** Does a credential holding `scopes` satisfy everything `needs` asks for? */
export function scopesSatisfy(scopes, needs = []) {
  const held = new Set(scopes || [])
  if (held.has('*')) return true
  return (needs || []).every((scope) => held.has(scope))
}

/**
 * Build the catalogue for one credential.
 *
 * @param scopes  what the phone's credential reports it holds. `null` means
 *                "unknown" and is treated as unrestricted, so a caller that has
 *                not loaded the credential yet gets the full catalogue rather
 *                than a silently empty one — an empty catalogue would read to
 *                the model as "this phone can do nothing", which is a far worse
 *                failure than offering a tool that then 403s once.
 */
export function buildMobileCatalogue({ tools = MOBILE_TOOLS, scopes = null } = {}) {
  const catalogueTools = new Map()
  const byDomain = new Map()
  const blocked = []

  for (const name of Object.keys(tools).sort()) {
    const tool = tools[name]
    const needs = tool.needs || []

    if (scopes && !scopesSatisfy(scopes, needs)) {
      const held = new Set(scopes)
      blocked.push({
        name,
        domain: tool.domain || UNCATEGORISED_DOMAIN,
        missing: needs.filter((scope) => !held.has(scope)),
      })
      continue
    }

    const domain = String(tool.domain || UNCATEGORISED_DOMAIN)
    const entry = {
      name,
      domain,
      summary: summarise(tool.description),
      description: String(tool.description ?? '').trim(),
      params: tool.params ?? {},
      needs,
    }
    catalogueTools.set(name, entry)
    if (!byDomain.has(domain)) byDomain.set(domain, [])
    byDomain.get(domain).push(entry)
  }

  return {
    tools: catalogueTools,
    byDomain,
    domains: [...byDomain.keys()].sort(),
    blocked,
  }
}

/* The catalogue for the common case — every tool, no scope filter — built once.
 * Callers with a credential pass their own; nothing here caches per-scope,
 * because a credential changing is exactly when a stale catalogue would lie. */
let unrestricted = null
function defaultCatalogue() {
  if (!unrestricted) unrestricted = buildMobileCatalogue()
  return unrestricted
}

function resolve(given) {
  return given ?? defaultCatalogue()
}

/**
 * LEVEL 1. Every domain, with a one-line description and how many tools are in
 * it. → { total, domains: [ { domain, what, count } ] }
 */
export function listDomains({ catalogue = null } = {}) {
  const cat = resolve(catalogue)
  return {
    total: cat.tools.size,
    domains: cat.domains.map((domain) => ({
      domain,
      what: MOBILE_DOMAIN_NOTES[domain] ?? '',
      count: cat.byDomain.get(domain).length,
    })),
  }
}

/**
 * LEVEL 2. The tools in one domain: name and one line each, no parameters.
 * An unknown domain comes back with the list of real ones, so the next call can
 * be right rather than merely failing.
 */
export function listTools(domain, { catalogue = null } = {}) {
  const cat = resolve(catalogue)
  const name = String(domain ?? '').trim().toLowerCase()
  const entries = cat.byDomain.get(name)

  if (!entries) {
    return { domain: name, error: 'no such domain', domains: cat.domains }
  }

  return {
    domain: name,
    what: MOBILE_DOMAIN_NOTES[name] ?? '',
    count: entries.length,
    tools: entries.map((entry) => ({ name: entry.name, summary: entry.summary })),
  }
}

/** LEVEL 3. Full description and parameters for the named tools, nothing else. */
export function describeTools(names = [], { catalogue = null } = {}) {
  const cat = resolve(catalogue)
  const wanted = (Array.isArray(names) ? names : [names])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean)

  const seen = new Set()
  const tools = []
  const unknown = []

  for (const name of wanted) {
    if (seen.has(name)) continue
    seen.add(name)
    const entry = cat.tools.get(name)
    if (!entry) {
      unknown.push(name)
      continue
    }
    tools.push({ name: entry.name, description: entry.description, params: entry.params })
  }

  return { tools, unknown }
}

/** Every tool in the named domains, de-duplicated, in catalogue order. */
export function toolsForDomains(domains = [], { catalogue = null } = {}) {
  const cat = resolve(catalogue)
  const wanted = (Array.isArray(domains) ? domains : [domains])
    .map((domain) => String(domain ?? '').trim().toLowerCase())
    .filter(Boolean)

  const names = []
  const seen = new Set()
  for (const domain of wanted) {
    for (const entry of cat.byDomain.get(domain) ?? []) {
      if (seen.has(entry.name)) continue
      seen.add(entry.name)
      names.push(entry.name)
    }
  }
  return names
}

/** Domain names the model was NOT given — naming them is what turns a missing
 *  tool into a request instead of a refusal. */
export function domainsExcept(domains = [], { catalogue = null } = {}) {
  const cat = resolve(catalogue)
  const taken = new Set(
    (Array.isArray(domains) ? domains : [domains]).map((domain) =>
      String(domain ?? '').trim().toLowerCase(),
    ),
  )
  return cat.domains.filter((domain) => !taken.has(domain))
}

/** Only the names that are real domains, in catalogue order, capped. */
export function normalizeDomains(domains = [], { limit = 4, catalogue = null } = {}) {
  const cat = resolve(catalogue)
  const seen = new Set()
  const out = []
  for (const domain of Array.isArray(domains) ? domains : [domains]) {
    const name = String(domain ?? '').trim().toLowerCase()
    if (!name || seen.has(name) || !cat.byDomain.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= limit) break
  }
  return out
}

/* ------------------------------------------------------- prompt renderings */

/** Level 1, as prompt text. */
export function renderDomainCatalog({ catalogue = null } = {}) {
  return listDomains({ catalogue })
    .domains.map(({ domain, what, count }) => `${domain} (${count}) — ${what}`)
    .join('\n')
}

/** Level 2, as prompt text — used when a whole domain is being offered. */
export function renderToolIndex(domains, { catalogue = null } = {}) {
  const cat = resolve(catalogue)
  return normalizeDomains(domains, { limit: cat.domains.length, catalogue: cat })
    .map((domain) => {
      const listed = listTools(domain, { catalogue: cat })
      return [`${domain}:`, ...listed.tools.map((tool) => `  ${tool.name} — ${tool.summary}`)].join('\n')
    })
    .join('\n')
}

/* Level 3, as prompt text: one JSON object per line. Indentation in a schema
 * block is thousands of characters of nothing; one line per tool keeps the
 * shape unambiguous while spending no tokens on layout. */
export function renderToolSchemas(names, { catalogue = null } = {}) {
  return describeTools(names, { catalogue })
    .tools.map((tool) =>
      JSON.stringify({ type: tool.name, description: tool.description, params: tool.params }),
    )
    .join('\n')
}

/** Every tool's schema, as prompt text. What ships when the whole thing fits. */
export function renderFullSchema({ catalogue = null } = {}) {
  const cat = resolve(catalogue)
  return renderToolSchemas([...cat.tools.keys()], { catalogue: cat })
}

/**
 * The reachability report. A tool the catalogue holds but which level 2 or
 * level 3 cannot answer for is a book on no shelf — named here so a test, and
 * the owner, can see the taxonomy fall behind the executor.
 */
export function discoveryReachability({ catalogue = null } = {}) {
  const cat = resolve(catalogue)
  const uncategorised = (cat.byDomain.get(UNCATEGORISED_DOMAIN) ?? []).map((entry) => entry.name)
  const undescribed = [...cat.tools.values()]
    .filter((entry) => !entry.summary)
    .map((entry) => entry.name)
  const unlabelled = cat.domains.filter((domain) => !MOBILE_DOMAIN_NOTES[domain])

  const reachable = [...cat.tools.keys()].filter((name) => {
    const entry = cat.tools.get(name)
    const listed = listTools(entry.domain, { catalogue: cat })
    if (!listed.tools?.some((tool) => tool.name === name)) return false
    return describeTools([name], { catalogue: cat }).tools.length === 1
  })

  return {
    total: cat.tools.size,
    domains: cat.domains.length,
    reachable: reachable.length,
    uncategorised,
    undescribed,
    unlabelled,
    blocked: cat.blocked.map((entry) => entry.name),
    schemaChars: renderFullSchema({ catalogue: cat }).length,
  }
}
