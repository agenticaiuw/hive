/*
 * The capability-domain registry.
 *
 * WHY THIS EXISTS. The owner, 2026-08-12: "Memories are not doing anything
 * useful right now… not just generic memories that all get added to the system
 * prompt", and "tools should be combined with memories — the tools for reading
 * emails are in the same folder as the memories for email preferences." So a
 * DOMAIN is the unit: one module bundles a capability's tools, its memory
 * names, its capture rules and its clarification rules, and every brain on the
 * fleet asks the same registry the same three questions:
 *
 *   1. Which domain does this tool belong to?         domainForTool()
 *   2. What does the owner's memory say about it?     (domainMemory.js lookup)
 *   3. Is this request too ambiguous to act on?       clarifyDomainRequest()
 *
 * Memories are fetched WHEN A DOMAIN'S TOOL IS SELECTED and attached to that
 * tool's context — never spliced globally into a system prompt. That is the
 * whole reversal this registry encodes.
 *
 * Pure and workerd-safe on purpose: it is imported by the Mac planner, the
 * relay's voice loop and the browser extension's brain, and two of those have
 * no filesystem.
 */
import browser from './browser.js'
import calendar from './calendar.js'
import email from './email.js'
import files from './files.js'
import music from './music.js'
import system from './system.js'

/* Registration order is match order: first claim wins, exactly like
 * toolDiscovery's DOMAIN_RULES. Keep the modules with exact-only vocabularies
 * ahead of the prefix families so a family cannot swallow an exception. */
export const DOMAIN_MODULES = Object.freeze([
  email,
  calendar,
  files,
  music,
  system,
  browser,
])

export const MEMORY_DOMAINS = Object.freeze(DOMAIN_MODULES.map((mod) => mod.name))

const BY_NAME = new Map(DOMAIN_MODULES.map((mod) => [mod.name, mod]))

export function domainModule(name) {
  return BY_NAME.get(String(name ?? '').trim().toLowerCase()) ?? null
}

/**
 * Which domain one tool/action type belongs to.
 *
 * `fallback` exists for single-vocabulary brains: every verb the browser
 * extension's executor dispatches is browser work, including the bare `scroll`
 * this registry deliberately leaves unclaimed because the Mac executor
 * dispatches the same word as desktop input. Null for a tool no domain claims
 * — info, screen, shell and friends have no memories to fetch, and that is a
 * feature, not a gap.
 */
export function domainForTool(type, { fallback = null } = {}) {
  const name = String(type ?? '').trim()
  if (!name) return fallback
  for (const mod of DOMAIN_MODULES) {
    if (mod.tools.exact.includes(name)) return mod.name
    if (mod.tools.prefixes.some((prefix) => name.startsWith(prefix))) {
      return mod.name
    }
  }
  return fallback
}

/** Unique domains for a plan's action list, in first-use order. */
export function domainsForActions(actions = [], options = {}) {
  const seen = new Set()
  const out = []
  for (const action of Array.isArray(actions) ? actions : []) {
    const domain = domainForTool(action?.type, options)
    if (domain && !seen.has(domain)) {
      seen.add(domain)
      out.push(domain)
    }
  }
  return out
}

/* ---- memory tool schemas ------------------------------------------------- */

/*
 * The explicit memory tools, defined once so the three brains cannot drift on
 * names or argument shapes. "Add explicit memory tools per domain too … so the
 * planner can consult/write deliberately" — deliberate reads and writes are
 * these two verbs; the automatic path is the run-settle capture heuristic.
 */
export const MEMORY_TOOL_TYPES = Object.freeze(['memory_lookup', 'memory_save'])

export const MEMORY_TOOL_SPECS = Object.freeze({
  memory_lookup: Object.freeze({
    description:
      `Look up the owner's remembered facts for one capability domain (${MEMORY_DOMAINS.join(', ')}): accounts, defaults, contacts, places, sites. Use before acting when the request depends on which account/list/site the owner means.`,
    params: Object.freeze({
      domain: `one of ${MEMORY_DOMAINS.join(' | ')}`,
      query: 'optional words to match against fact names and values',
    }),
  }),
  memory_save: Object.freeze({
    description:
      "Save one durable fact about the owner into a capability domain (e.g. domain 'email', name 'account.school', value 'liu@uni.edu'). Only for identities, accounts, connections and defaults likely to be used again — never chat logs. scope 'hive' shares it with every node; 'node' keeps it on this one.",
    params: Object.freeze({
      domain: `one of ${MEMORY_DOMAINS.join(' | ')}`,
      name: "dotted fact name inside the domain, e.g. 'account.personal' or 'list.default'",
      value: 'the fact itself, one short line',
      scope: "optional 'hive' (default — every node) or 'node' (this node only)",
    }),
  }),
})

export function isMemoryToolType(type) {
  return MEMORY_TOOL_TYPES.includes(String(type ?? '').trim())
}

/* ---- clarification ------------------------------------------------------- */

/**
 * Should this request stop and ask, instead of guessing?
 *
 * The owner's rule verbatim: "only when the prompt is ambiguous, then ask the
 * users for clarifications." Ambiguity here is a computable thing, not a
 * feeling — the owner's own example is 'check my email' with three known
 * accounts and no default. A domain's clarify rule fires only when EVERY leg
 * holds:
 *
 *   1. the request matches the rule's trigger (it is that kind of request),
 *   2. the domain's memory knows ≥2 candidates under the distinguisher
 *      (account.*, list.*, site.*…),
 *   3. no <distinguisher>.default fact settles it,
 *   4. the request itself names none of the candidates.
 *
 * Fewer than two candidates is not ambiguity, it is ignorance — and a question
 * with no options to offer is worse than the brain's best guess.
 *
 * Returns { domain, ruleId, question, options } or null. The CALLER routes the
 * question through its own ask channel: the voice model speaks it, the Mac
 * planner raises requiresConfirmation, the browser brain finishes with a
 * needs-answer verdict.
 */
export function clarifyDomainRequest({ domains = [], request = '', facts = [] }) {
  const text = String(request ?? '')
  const normalizedText = normalize(text)
  if (!normalizedText) return null

  for (const domainName of domains) {
    const mod = domainModule(domainName)
    if (!mod) continue

    for (const rule of mod.clarify) {
      if (!rule.trigger.test(text)) continue

      const group = facts.filter(
        (fact) =>
          fact?.domain === mod.name &&
          String(fact?.name ?? '').startsWith(`${rule.distinguisher}.`) &&
          fact?.value != null,
      )
      const options = group
        .map((fact) => String(fact.name).slice(rule.distinguisher.length + 1))
        .filter((label) => label && label !== 'default')

      if (options.length < 2) continue
      if (group.some((fact) => fact.name === `${rule.distinguisher}.default`)) {
        continue
      }

      /* The request naming a candidate — by label ("school") or by value
       * ("liu@uni.edu") — is the owner disambiguating themselves. */
      const named = group.some(
        (fact) =>
          containsWord(normalizedText, normalize(String(fact.name).slice(rule.distinguisher.length + 1))) ||
          containsWord(normalizedText, normalize(fact.value)),
      )
      if (named) continue

      return {
        domain: mod.name,
        ruleId: rule.id,
        options,
        question: rule.ask(options),
      }
    }
  }

  return null
}

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function containsWord(haystack, needle) {
  if (!needle) return false
  return ` ${haystack} `.includes(` ${needle} `) || haystack.includes(needle)
}
