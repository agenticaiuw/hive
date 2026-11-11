/*
 * Selective capture at run-settle time.
 *
 * The owner's rule, verbatim: "when there's a likely chance that i'm gonna use
 * this connection or the same tasks again, then it should save it." So this
 * module reads a SETTLED run — the command, the actions that executed, whether
 * they succeeded — and lifts out only the durable, reusable shapes:
 *
 *   identities   — "my school email is liu@uni.edu" said in the command
 *   connections  — a named reminders list actually filed onto, a site actually
 *                  acted in (not merely read), the folder a note landed in,
 *                  the person an email actually went to
 *   task shapes  — a multi-step run in one domain that succeeded, keyed by its
 *                  action shape so doing it again overwrites instead of piling
 *
 * NOT chat logs, NOT page contents, NOT one-off observations — the generic
 * capture this replaces wrote those, and the owner's verdict on the result was
 * "delete all of these bullshits."
 *
 * Pure: reads the run, returns fact inputs. The caller owns the store and the
 * node stamp. Dedupe is the store's same-key overwrite; this module's job is
 * only to derive stable keys so a repeat lands on the same row.
 */
import { DOMAIN_MODULES, domainForTool, domainsForActions } from './domains/index.js'
import { normalizeDomainFact } from './domainMemory.js'

/* Outward browser verbs: acting in a site (typing, clicking through a flow) is
 * what makes it a connection worth remembering; reading it is not. */
const BROWSER_ACTING_TYPES = new Set([
  'browser_type',
  'browser_click',
  'browser_select',
  'type',
  'click',
  'select',
])

/**
 * Extract the facts a settled run earned.
 *
 * @param {object} run
 *   command  — the owner's sentence
 *   actions  — the executed action list [{type, params}]
 *   results  — per-action results (only .ok is consulted)
 *   ok       — whether the run as a whole succeeded
 *   node     — which body ran it ('mac', 'browser', 'voice', 'ios')
 * @returns normalized domain facts, deduped by key.
 */
export function extractDomainFacts({
  command = '',
  actions = [],
  results = [],
  ok = true,
  node = 'unknown',
  now = Date.now(),
} = {}) {
  const facts = new Map()
  const put = (input) => {
    try {
      const fact = normalizeDomainFact({ ...input, node }, { now })
      facts.set(fact.key, fact)
    } catch {
      /* A capture rule producing an invalid fact is a rule to fix, not a run
       * to fail — capture must never cost a run anything. */
    }
  }

  const text = String(command ?? '')
  const list = Array.isArray(actions) ? actions : []

  /* 1. Identities stated in the command, per the domain modules' patterns. */
  for (const mod of DOMAIN_MODULES) {
    for (const rule of mod.capture) {
      if (!rule.pattern) continue
      const match = text.match(rule.pattern)
      if (!match?.groups) continue
      put({
        domain: mod.name,
        name: rule.name(match.groups),
        value: rule.value ? rule.value(match.groups) : match.groups.value,
        scope: rule.scope ?? 'hive',
        confidence: 0.95, // the owner's own words
      })
    }
  }

  /* Failed runs teach nothing worth reusing beyond stated identities. */
  if (!ok) return [...facts.values()]

  /* 2. Connections used by executed actions, per the modules' action rules. */
  for (const [index, action] of list.entries()) {
    const succeeded = results?.[index]?.ok !== false
    if (!succeeded) continue

    for (const mod of DOMAIN_MODULES) {
      for (const rule of mod.capture) {
        if (!rule.action || rule.action !== action?.type) continue
        const raw = rule.param ? action?.params?.[rule.param] : true
        if (raw == null || raw === '') continue
        /* Rules receive the RAW param value; normalizeDomainFact slugs the
         * name they derive, so "Family Errands" files as list.family-errands. */
        put({
          domain: mod.name,
          name: rule.name(raw),
          value: rule.value ? rule.value(raw) : String(raw),
          scope: rule.scope ?? 'hive',
          confidence: 0.85,
        })
      }
    }

    /* Email recipients: a person mail actually went to is a connection. */
    if (action?.type === 'send_email' && action?.params?.to) {
      const to = String(action.params.to).trim()
      const local = to.split('@')[0]
      if (local) {
        put({
          domain: 'email',
          name: `contact.${slugLabel(local)}`,
          value: to,
          scope: 'hive',
          confidence: 0.85,
        })
      }
    }

    /* Sites the owner ACTED in through the browser. The host is enough; the
     * page contents never ride — that was the old generic tier's mistake. */
    if (BROWSER_ACTING_TYPES.has(String(action?.type ?? ''))) {
      const host = hostOf(
        action?.params?.url ??
          results?.[index]?.url ??
          results?.[index]?.result?.url ??
          null,
      )
      if (host) {
        put({
          domain: 'browser',
          name: `site.${slugLabel(host)}`,
          value: host,
          scope: 'hive',
          confidence: 0.8,
        })
      }
    }
  }

  /* 3. Repeated task shapes: a successful multi-step run inside one domain is
   * a shape the owner will ask for again. Keyed by domain + the sorted action
   * types, so "do it again" next week overwrites this row instead of piling. */
  const domains = domainsForActions(list)
  if (domains.length === 1 && list.length >= 2) {
    const domain = domains[0]
    const shape = [...new Set(list.map((action) => String(action?.type ?? '')))]
      .sort()
      .join('+')
    if (shape) {
      put({
        domain,
        name: `task.${slugLabel(shape)}`,
        value: text.replace(/\s+/g, ' ').trim().slice(0, 160) || shape,
        scope: 'node',
        confidence: 0.7,
      })
    }
  }

  return [...facts.values()]
}

/** Which domains a settled run touched — the fetch key for attach-on-selection. */
export { domainsForActions, domainForTool }

function slugLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function hostOf(url) {
  if (!url) return null
  try {
    return new URL(String(url)).host.replace(/^www\./, '') || null
  } catch {
    return null
  }
}
