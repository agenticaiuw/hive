/*
 * The executor side of the explicit memory tools.
 *
 * "Add explicit memory tools per domain too … so the planner can consult/write
 * deliberately" — memory_lookup and memory_save are those two verbs on the
 * Mac. The automatic path (run-settle capture in orchestrator.js) needs
 * neither; these exist for the plan that should CHECK which account the owner
 * means before acting, or SAVE a connection the owner just spelled out.
 *
 * Thin on purpose: shared/domainMemory.js owns validation and rendering,
 * memoryService.js owns the disk. This module only turns the two into action
 * results the executor and the /memory/domains route can hand back.
 */
import {
  lookupDomainFacts,
  normalizeDomainFact,
  renderDomainFactLines,
} from '../shared/domainMemory.js'
import { MEMORY_DOMAINS } from '../shared/domains/index.js'
import { listDomainFacts, rememberDomainFact } from './memoryService.js'

/**
 * Read one domain's remembered facts, best match first.
 *
 * → { ok:true, domain, facts, lines, message }
 * → { ok:false, message } naming the real domains, so a model that guessed
 *   wrong can be right on its next call instead of concluding memory is empty.
 */
export function executeMemoryLookup(
  { domain, query = '', limit = 8 } = {},
  { filePath = undefined } = {},
) {
  const name = String(domain ?? '').trim().toLowerCase()
  if (!MEMORY_DOMAINS.includes(name)) {
    return {
      ok: false,
      message: `No memory domain ${JSON.stringify(domain ?? '')}. Real domains: ${MEMORY_DOMAINS.join(', ')}.`,
    }
  }

  const pool = listDomainFacts({ domain: name }, filePath ? { filePath } : {})
  const facts = lookupDomainFacts(pool, { domain: name, query, limit })
  /* Secrets stay masked — renderDomainFactLines' default. The one reader who
   * should ever see a secret in full is the owner, and no plan is the owner. */
  const lines = renderDomainFactLines(facts)

  return {
    ok: true,
    domain: name,
    facts,
    lines,
    message: facts.length
      ? `${facts.length} remembered ${name} fact${facts.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
      : `Nothing remembered under ${name} yet.`,
  }
}

/**
 * Save one durable fact into a capability domain.
 *
 * Validation is shared/domainMemory.js's normalizeDomainFact, which throws on
 * anything structurally wrong — an unknown domain, a missing name or value, a
 * scope that is neither 'hive' nor 'node'. A throw here becomes ok:false with
 * the reason, because the model wrote these params and deserves to hear why.
 *
 * → { ok:true, key, scope, message } | { ok:false, message }
 */
export function executeMemorySave(
  { domain, name, value, scope } = {},
  { filePath = undefined } = {},
) {
  let fact
  try {
    fact = normalizeDomainFact({
      domain,
      name,
      value,
      /* The spec's default: a deliberately saved fact is for every node
       * unless the plan says otherwise. */
      ...(scope !== undefined && scope !== null && scope !== '' ? { scope } : {}),
      node: 'mac',
    })
  } catch (error) {
    return { ok: false, message: error?.message || 'Invalid domain fact.' }
  }

  rememberDomainFact(fact, {
    origin: 'domain-tool',
    ...(filePath ? { filePath } : {}),
  })

  return {
    ok: true,
    key: fact.key,
    scope: fact.scope,
    message:
      fact.scope === 'hive'
        ? `Saved ${fact.key}. It is shared with every node — it reaches the fleet on the next bridge heartbeat.`
        : `Saved ${fact.key} on this Mac only.`,
  }
}
