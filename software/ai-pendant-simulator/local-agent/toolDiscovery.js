import { SUPPORTED_ACTION_TYPES } from './computerControl.js'
import { actionSpec } from './llmPlanner.js'
import { describeAction } from './capabilityManifest.js'

/*
 * The library catalogue, not the library.
 *
 * Every planner prompt used to carry the full text of every book. llmPlanner's
 * FULL_CONTROL_ACTION_SCHEMA is 92 action types with their parameter hints —
 * ~28,000 characters, ~7,000 prompt tokens — spliced into the system prompt on
 * every turn, including the ones where the answer was one action the model
 * already knew. That is the flat shelf: hand over everything before anyone has
 * said what they want.
 *
 * This file is the three-level replacement:
 *
 *   listDomains()          level 1 — a shelf label per section, ~800 characters
 *                          total, small enough to sit in the system prompt.
 *   listTools(domain)      level 2 — the spines in one section: names and one
 *                          line each, no parameters.
 *   describeTools(names)   level 3 — the full schema, for the handful named.
 *
 * WHAT IS DERIVED AND WHAT IS WRITTEN DOWN. The membership is derived: the
 * roster is computerControl's own dispatch table (SUPPORTED_ACTION_TYPES,
 * itself parsed out of the executor's switch) and the prose is
 * capabilityManifest.describeAction, which asks llmPlanner's schema first and
 * ACTION_NOTES second. Nothing here restates what a tool does or that it
 * exists, so a capability cannot be added to the executor and be missing from
 * discovery — the failure mode that has already cost this repo three silent
 * capability losses.
 *
 * Only the GROUPING is written down, as ordered rules rather than lists of
 * members. A rule is a family prefix (`browser_`, `ios_`, `sweep_folder_`) plus
 * the odd exact name, so a new `browser_hover` lands in `browser` on the day it
 * is dispatchable with no edit here. A type no rule claims is reported under
 * `uncategorised` — visible, drillable, and loud — never dropped.
 *
 * ORDERING IS STABLE AND ALPHABETICAL everywhere, because a model reading two
 * of these in one turn should not have to wonder whether the list moved.
 */

/*
 * Level-1 shelf labels. One line each, written for someone who has not read
 * this codebase — this text is the entire basis on which the model decides
 * where to look, so it names the subject, not the module.
 *
 * It is also the only place a routing mistake can be fixed, and it has already
 * had to be. "Email and what is competing for attention" on `communication`
 * caught "what did I miss in email this morning" and stopped there, so the
 * planner never saw compose_briefing and answered with a notification score
 * instead of a brief. Measured against the live model, not guessed. Write the
 * words the OWNER would say — "brief me", "catch me up", "what did I miss" —
 * and keep the neighbouring shelf's phrasing off your own label.
 */
const DOMAIN_NOTES = {
  agent: 'Preview a plan, check input reachability, read the review queue.',
  apps: 'Open apps, URLs, project folders, YouTube.',
  briefings:
    'Brief me, catch me up, what did I miss, prepare my workday, research a topic.',
  /* "The real logged-in browser" caught "my Safari reading list", which is an
   * app feature no web-page tool can reach — it needs a script. Say WEB PAGE. */
  browser: 'Live web pages in the logged-in browser: tabs, forms, reads, watches.',
  calendar: 'Reminders, meetings, day plans, focus blocks, routines.',
  communication: 'Send or draft an email, triage the inbox, rank interruptions.',
  files: 'Read, write, search, move and tidy files and folders.',
  info: 'Weather, time, translation.',
  input: 'Click, type, menus and native Mac app windows.',
  memory: 'Save and recall things the owner said.',
  phone: "The owner's real iPhone.",
  screen: 'Capture and inspect the Mac screen.',
  shell: 'Shell commands and AppleScript.',
  system: 'Volume, brightness, battery, clipboard, keyboard language.',
  /* Never written to by hand — populated only when a rule claims nothing. */
  uncategorised: 'Dispatchable tools no domain rule has claimed yet.',
}

export const UNCATEGORISED_DOMAIN = 'uncategorised'

/*
 * The grouping, as rules.
 *
 * Order matters: the first rule that claims a type wins, so the narrow exact
 * names come before the broad family prefixes. `check_input_permissions` is
 * agent bookkeeping rather than input, and `mouse_scroll` is input rather than
 * whatever else `mouse_` might one day mean — both are settled here, once.
 */
const DOMAIN_RULES = [
  // Exact names first, so a family prefix cannot swallow an exception.
  { domain: 'agent', exact: ['check_input_permissions', 'preview_plan', 'review_queue'] },
  { domain: 'apps', exact: ['open_app', 'open_url', 'play_youtube', 'run_project'] },
  {
    domain: 'briefings',
    exact: [
      'briefing_triage',
      'compose_briefing',
      'list_briefings',
      'play_briefing',
      'research_brief',
      'research_topic',
    ],
  },
  { domain: 'browser', exact: ['watch_page'] },
  {
    domain: 'calendar',
    exact: [
      'create_reminder',
      'end_focus_session',
      'meeting_followup',
      'plan_my_day',
      'prepare_for_meeting',
      'remind_me',
      'schedule_routine',
      'start_focus_session',
    ],
  },
  {
    domain: 'communication',
    exact: ['send_email', 'triage_inbox', 'triage_notifications'],
  },
  {
    domain: 'files',
    exact: [
      'copy_path',
      'create_note',
      'delete_path',
      'list_directory',
      'move_path',
      'open_folder',
      'open_path',
      'read_file',
      'search_file',
      'write_file',
    ],
  },
  { domain: 'info', exact: ['get_time', 'get_weather', 'translate_text'] },
  {
    domain: 'input',
    exact: ['computer_use_task', 'press_keys', 'scroll', 'type_text'],
  },
  { domain: 'memory', exact: ['quick_capture', 'recall_capture'] },
  {
    domain: 'screen',
    exact: [
      'cursor_position',
      'list_displays',
      'screenshot',
      'show_screen_overlay',
      'zoom',
    ],
  },
  { domain: 'shell', exact: ['run_applescript', 'run_shell'] },
  {
    domain: 'system',
    exact: [
      'copy_to_clipboard',
      'get_battery',
      'get_brightness',
      'get_clipboard',
      'get_input_source',
      'get_mac_status',
      'get_volume',
      'set_brightness',
      'set_clipboard',
      'set_input_source',
      'set_keyboard_language',
      'set_mute',
      'set_volume',
    ],
  },
  // Family prefixes. These are what make a new action type self-filing.
  { domain: 'browser', prefix: 'browser_' },
  { domain: 'phone', prefix: 'ios_' },
  { domain: 'input', prefix: 'mouse_' },
  { domain: 'input', prefix: 'ui_' },
  { domain: 'files', prefix: 'sweep_folder_' },
  { domain: 'files', prefix: 'tidy_downloads_' },
]

/** Which domain one action type belongs to. Never null — worst case is `uncategorised`. */
export function domainForAction(type) {
  const name = String(type ?? '')
  for (const rule of DOMAIN_RULES) {
    if (rule.exact?.includes(name)) return rule.domain
    if (rule.prefix && name.startsWith(rule.prefix)) return rule.domain
  }
  return UNCATEGORISED_DOMAIN
}

/*
 * One line for the shelf: the first sentence of what the tool says about
 * itself, capped. These descriptions were written for a planner that received
 * all of them at once and several run to 400 characters; at level 2 the model
 * is choosing whether to look closer, and the first sentence is what decides
 * that. The full text is still one describeTools call away.
 */
const SUMMARY_MAX = 150

function summarise(description) {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const stop = text.search(/[.!?](?:\s|$)/)
  const first = stop > 0 ? text.slice(0, stop + 1) : text
  if (first.length <= SUMMARY_MAX) return first
  return `${first.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
}

/*
 * The catalogue, built once. SUPPORTED_ACTION_TYPES is parsed out of the
 * executor's source at import time and cannot change afterwards, so rebuilding
 * per call would buy nothing and cost a describeAction sweep on every turn.
 * Tests that need a fresh roster call buildCatalogue directly.
 */
let cached = null

export function buildCatalogue(types = SUPPORTED_ACTION_TYPES) {
  const tools = new Map()
  const byDomain = new Map()

  for (const type of [...types].sort()) {
    const domain = domainForAction(type)
    const spec = actionSpec(type)
    const description = String(describeAction(type) ?? '').trim()
    const entry = {
      name: type,
      domain,
      summary: summarise(description),
      description,
      // The planner's own schema object, by reference: describeTools must hand
      // back exactly what the flat schema handed over, not a copy of it.
      spec,
    }
    tools.set(type, entry)
    if (!byDomain.has(domain)) byDomain.set(domain, [])
    byDomain.get(domain).push(entry)
  }

  const domains = [...byDomain.keys()].sort()
  return { tools, byDomain, domains }
}

function catalogue() {
  if (!cached) cached = buildCatalogue()
  return cached
}

/**
 * LEVEL 1. Every domain, with a one-line description and how many tools are in
 * it. The whole return renders to well under 1,000 characters, which is what
 * makes it affordable in the first-level system prompt.
 *
 * → { total, domains: [ { domain, what, count } ] }
 */
export function listDomains({ catalogue: given = null } = {}) {
  const cat = given ?? catalogue()
  return {
    total: cat.tools.size,
    domains: cat.domains.map((domain) => ({
      domain,
      what: DOMAIN_NOTES[domain] ?? '',
      count: cat.byDomain.get(domain).length,
    })),
  }
}

/**
 * LEVEL 2. The tools in one domain: name and one line each, no parameters.
 * An unknown domain is not an error the model can do nothing with — it comes
 * back with the list of real domain names so the next call can be right.
 *
 * → { domain, what, count, tools: [ { name, summary } ] }
 * → { domain, error, domains: [ ...names ] } when the domain does not exist
 */
export function listTools(domain, { catalogue: given = null } = {}) {
  const cat = given ?? catalogue()
  const name = String(domain ?? '').trim().toLowerCase()
  const entries = cat.byDomain.get(name)

  if (!entries) {
    return {
      domain: name,
      error: 'no such domain',
      domains: cat.domains,
    }
  }

  return {
    domain: name,
    what: DOMAIN_NOTES[name] ?? '',
    count: entries.length,
    tools: entries.map((entry) => ({ name: entry.name, summary: entry.summary })),
  }
}

/**
 * LEVEL 3. The full parameter schema for the named tools and nothing else.
 *
 * `params` for a type llmPlanner never described is `{}` — the executor
 * dispatches it, so hiding it would lose a capability, but this file will not
 * invent a signature it cannot derive.
 *
 * → { tools: [ { name, description, params } ], unknown: [ ...names ] }
 */
export function describeTools(names = [], { catalogue: given = null } = {}) {
  const cat = given ?? catalogue()
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
    tools.push({
      name: entry.name,
      description: entry.spec?.description ?? entry.description,
      params: entry.spec?.params ?? {},
    })
  }

  return { tools, unknown }
}

/** Every tool in the named domains, de-duplicated, in catalogue order. */
export function toolsForDomains(domains = [], { catalogue: given = null } = {}) {
  const cat = given ?? catalogue()
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

/** Domain names the model was not given, so the prompt can say what is left. */
export function domainsExcept(domains = [], { catalogue: given = null } = {}) {
  const cat = given ?? catalogue()
  const taken = new Set(
    (Array.isArray(domains) ? domains : [domains]).map((domain) =>
      String(domain ?? '').trim().toLowerCase(),
    ),
  )
  return cat.domains.filter((domain) => !taken.has(domain))
}

/** Only the names that are real domains, in catalogue order, capped. */
export function normalizeDomains(domains = [], { limit = 4, catalogue: given = null } = {}) {
  const cat = given ?? catalogue()
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

/**
 * The reachability report. A live action type that no domain rule claims is
 * still findable — it is in `uncategorised` — but it is named here so the
 * test, and the owner, can see the taxonomy fall behind the executor.
 *
 * → { total, domains, reachable, uncategorised: [ ...types ], undescribed: [ ...types ] }
 */
export function discoveryReachability({ catalogue: given = null } = {}) {
  const cat = given ?? catalogue()
  const uncategorised = (cat.byDomain.get(UNCATEGORISED_DOMAIN) ?? []).map(
    (entry) => entry.name,
  )
  const undescribed = [...cat.tools.values()]
    .filter((entry) => !entry.summary)
    .map((entry) => entry.name)

  /* Reachable means: level 2 lists it under some domain AND level 3 answers
   * for it. Anything short of both is a book on no shelf. */
  const reachable = [...cat.tools.keys()].filter((name) => {
    const listed = listTools(domainForAction(name), { catalogue: cat })
    if (!listed.tools?.some((tool) => tool.name === name)) return false
    return describeTools([name], { catalogue: cat }).tools.length === 1
  })

  return {
    total: cat.tools.size,
    domains: cat.domains.length,
    reachable: reachable.length,
    uncategorised,
    undescribed,
  }
}

/*
 * PROMPT RENDERINGS.
 *
 * Kept here rather than in llmPlanner so that what the model reads and what
 * the discovery functions return cannot drift apart, and so a test can measure
 * the prompt without a network call.
 */

/** Level 1, as prompt text. This is the only capability text the first-level prompt carries. */
export function renderDomainCatalog({ catalogue: given = null } = {}) {
  const { domains } = listDomains({ catalogue: given })
  return domains
    .map(({ domain, what, count }) => `${domain} (${count}) — ${what}`)
    .join('\n')
}

/** Level 2, as prompt text — used only when a whole domain is being offered. */
export function renderToolIndex(domains, { catalogue: given = null } = {}) {
  const cat = given ?? catalogue()
  return normalizeDomains(domains, { limit: cat.domains.length, catalogue: cat })
    .map((domain) => {
      const listed = listTools(domain, { catalogue: cat })
      const lines = listed.tools.map((tool) => `  ${tool.name} — ${tool.summary}`)
      return [`${domain}:`, ...lines].join('\n')
    })
    .join('\n')
}

/*
 * Level 3, as prompt text: one JSON object per line.
 *
 * The flat schema was `JSON.stringify(schema, null, 2)`, and the indentation
 * alone was thousands of characters of nothing. One line per tool keeps the
 * shape unambiguous — params values contain commas, pipes and prose — while
 * spending no tokens on layout.
 */
export function renderToolSchemas(names, { catalogue: given = null } = {}) {
  const { tools } = describeTools(names, { catalogue: given })
  return tools
    .map((tool) =>
      JSON.stringify({
        type: tool.name,
        description: tool.description,
        params: tool.params,
      }),
    )
    .join('\n')
}
