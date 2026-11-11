import crypto from 'node:crypto'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import {
  addressPage,
  excerptAround,
  normalizeText,
  readPageText,
  runBrowserAction,
  snapshotPage,
} from './browserPage.js'
import { workspacePath } from './config.js'
import { usableCapsuleIds } from './evidenceCapsules.js'

/*
 * "Make browser work explicitly two-phase: 'inspect' returns a concise result
 * with citations and a proposed action; 'act' executes it."
 *
 * inspect() reads a page and comes back with three things: what it found, where
 * on the page it found it, and the one action it thinks answers the question.
 * It does not take that action. act() takes it, and only it.
 *
 * What this is not: every browser_* action still runs the instant it is asked.
 * browser_click, browser_type, browser_navigate are unchanged and unguarded.
 * Nothing here sits in front of them, nothing expires, nothing has to be
 * approved. inspect is an additional thing an agent can choose to do first,
 * which is what the owner asked for — a way to see the citation before the
 * click, not a checkpoint they have to clear.
 *
 * The reading phase does navigate. That is deliberate and it is still reading:
 * you cannot cite a page you have not loaded, and a GET is what pressing ⌘R
 * does. The allow-list below is what makes "inspect does not act" true of the
 * code rather than true of the comment — click, type, select and press_key are
 * simply not reachable from this path.
 *
 * Why act() re-finds the element instead of replaying the ref:
 * the extension stamps refs (e0, e1, …) fresh on every snapshot, in DOM order.
 * A ref from ten seconds ago may now point at a different button on a page that
 * lazy-loaded a banner. Replaying it would be the one failure that makes a
 * preview actively harmful — the owner reads "Download invoice" and the agent
 * clicks "Cancel subscription". So act() re-snapshots and locates the element
 * the inspection actually described, by selector and accessible name. If the
 * page moved it, we follow it. If it is genuinely gone, the action fails, which
 * is the truth. We never refuse it on the owner's behalf.
 */

const storePath = () =>
  process.env.PENDANT_INSPECT_STORE_PATH ||
  path.join(workspacePath, '.pendant-browser-inspections.json')

const INSPECTION_LIMIT = 40

/* The reading phase's whole vocabulary. runBrowserActions throws on anything
 * else, so "inspect never clicks" is enforced one layer below this file. */
const READ_ONLY_BROWSER_ACTIONS = new Set(['navigate', 'list_tabs', 'read_page', 'snapshot'])

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
  'was', 'were', 'my', 'me', 'i', 'it', 'this', 'that', 'what', 'whats', 'how',
  'do', 'does', 'did', 'can', 'you', 'please', 'find', 'get', 'show', 'tell',
  'page', 'site', 'website', 'from', 'with', 'at', 'by', 'be', 'as', 'any',
])

const ACT_VERBS = [
  [/\b(download|save|export|get the file)\b/i, 'download'],
  [/\b(sign in|log ?in|authenticate)\b/i, 'signin'],
  [/\b(add to (cart|basket)|buy|checkout|purchase|order)\b/i, 'buy'],
  [/\b(submit|send|post|apply|confirm|continue|next)\b/i, 'submit'],
  [/\b(open|view|read|go to|follow)\b/i, 'open'],
  [/\b(search|look up)\b/i, 'search'],
]

const isValidStore = (value) => value && Array.isArray(value.inspections)

export function inspectionsLocation() {
  return storePath()
}

function loadStore() {
  const filePath = storePath()
  ensureJsonStore(filePath, { inspections: [] }, { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: { inspections: [] },
    validate: isValidStore,
  })
}

function saveStore(store) {
  store.inspections = store.inspections.slice(-INSPECTION_LIMIT)
  writeJsonAtomic(storePath(), store, { validate: isValidStore })
}

/* ----------------------------------------------------------------- inspect */

/**
 * Read a page and report what is on it, with citations, plus the one action
 * that would follow from what was read.
 *
 * Nothing on the page is clicked, typed into, or submitted.
 */
export async function inspectPage(
  {
    url,
    goal = '',
    look = [],
    maxChars = 12_000,
    maxElements = 60,
    reload = true,
    now = Date.now(),
  } = {},
  {
    address = addressPage,
    readText = readPageText,
    snapshot = snapshotPage,
  } = {},
) {
  if (!url) throw new Error('inspect needs a url to read.')

  const options = { source: 'browser-inspect', allow: READ_ONLY_BROWSER_ACTIONS }
  const landed = await address(url, { reload, options })
  const page = await readText(landed.target, { maxChars, options })
  const snap = await snapshot(landed.target, { maxElements, options })

  const text = normalizeText(page.content)
  const elements = (snap.elements ?? []).filter((element) => !element.disabled)
  const terms = searchTerms({ look, goal })
  const retrievedAt = new Date(now).toISOString()
  const source = {
    url: page.url || landed.url || url,
    title: page.title || landed.title || snap.title || '',
    retrievedAt,
  }

  /*
   * The two readings this inspection is built out of. Minted by
   * computerControl when the extension answered, not here — a citation that
   * names a capsule the agent invented locally proves nothing.
   *
   * Text findings cite the page read; element findings and the proposal cite
   * the snapshot, because that is genuinely where each one came from.
   */
  const evidence = { text: page.capsuleId ?? null, elements: snap.capsuleId ?? null }
  const capsuleIds = [...new Set([evidence.text, evidence.elements].filter(Boolean))]

  const findings = buildFindings({ terms, text, elements, source, evidence })
  const proposal = proposeAction({ goal, elements, source, capsuleId: evidence.elements })

  const inspection = {
    inspectionId: `insp_${crypto.randomUUID()}`,
    createdAt: retrievedAt,
    goal: String(goal || '') || null,
    requestedUrl: url,
    ...source,
    disposition: landed.disposition,
    redirectedFrom: landed.redirectedFrom ?? null,
    target: landed.target,
    /* Bound to the page as read, so act() can say whether the page moved under
     * it. It reports; it does not veto. */
    contentHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
    textLength: text.length,
    elementCount: elements.length,
    capsuleIds,
    findings,
    proposal,
    acts: [],
  }

  const store = loadStore()
  store.inspections.push(inspection)
  saveStore(store)

  return inspection
}

function searchTerms({ look, goal }) {
  const explicit = []
    .concat(look ?? [])
    .map((term) => String(term).trim())
    .filter(Boolean)
  if (explicit.length) return explicit

  return String(goal || '')
    .toLowerCase()
    .split(/[^a-z0-9$£€%.@-]+/i)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .slice(0, 6)
}

/**
 * A finding is a claim plus the sentence it came from. A claim without the
 * sentence is the agent asking to be believed.
 */
function buildFindings({ terms, text, elements, source, evidence = {} }) {
  const findings = []

  for (const term of terms) {
    const quote = excerptAround(text, term, 110)
    const found = quote && quote.toLowerCase().includes(term.toLowerCase())
    if (found) {
      findings.push({
        term,
        where: 'page text',
        quote,
        citation: {
          ...source,
          locator: `text contains “${term}”`,
          capsuleId: evidence.text ?? null,
        },
      })
      continue
    }

    const element = elements.find((candidate) =>
      String(candidate.name ?? '').toLowerCase().includes(term.toLowerCase()),
    )
    if (element) {
      findings.push({
        term,
        where: 'interactive element',
        quote: String(element.name ?? ''),
        citation: {
          ...source,
          locator: `${element.role} “${element.name}” at ${element.selector}`,
          capsuleId: evidence.elements ?? null,
        },
      })
      continue
    }

    findings.push({
      term,
      where: null,
      quote: null,
      missing: true,
      citation: {
        ...source,
        locator: `no occurrence of “${term}” in the ${text.length} characters read`,
        capsuleId: evidence.text ?? null,
      },
    })
  }

  if (!findings.length) {
    findings.push({
      term: null,
      where: 'page text',
      quote: text.slice(0, 400),
      citation: {
        ...source,
        locator: 'opening of the main text',
        capsuleId: evidence.text ?? null,
      },
    })
  }

  return findings
}

/**
 * The one action the reading points at, with the evidence for choosing it.
 *
 * Returned, not run. A null proposal is a real answer: it means nothing on the
 * page matched, and inventing a click would be worse than saying so.
 */
export function proposeAction({ goal, elements, source, capsuleId = null }) {
  const intent = ACT_VERBS.find(([pattern]) => pattern.test(String(goal || '')))?.[1] ?? null
  const words = searchTerms({ look: [], goal })

  let best = null
  for (const element of elements) {
    const score = scoreElement(element, { words, intent })
    if (score > 0 && (!best || score > best.score)) best = { element, score }
  }

  if (!best) {
    return null
  }

  const element = best.element
  const type = element.role === 'textbox' ? 'browser_type' : 'browser_click'

  return {
    /* The literal action act() will run. The ref is recorded for the trace; the
     * selector and name are what act() actually re-locates with. */
    action: {
      type,
      label: `${type === 'browser_type' ? 'type into' : 'click'} “${element.name || element.selector}”`,
      params: { ref: element.ref, ...(type === 'browser_type' ? { text: '' } : {}) },
    },
    element: {
      ref: element.ref,
      role: element.role,
      name: String(element.name ?? ''),
      selector: element.selector,
      href: element.href ?? null,
    },
    intent,
    score: best.score,
    /* What the owner is agreeing with when they say "go ahead". */
    effect:
      type === 'browser_type'
        ? `Types into the “${element.name || element.selector}” field on ${source.url}. Nothing is submitted.`
        : element.href
          ? `Follows “${element.name}” to ${element.href}.`
          : `Clicks the “${element.name || element.selector}” ${element.role} on ${source.url}.`,
    reversible: type === 'browser_click' && Boolean(element.href),
    citation: {
      ...source,
      locator: `${element.role} “${element.name}” at ${element.selector}`,
      capsuleId,
    },
  }
}

function scoreElement(element, { words, intent }) {
  const name = String(element.name ?? '').toLowerCase()
  const href = String(element.href ?? '').toLowerCase()
  if (!name && !href) return 0

  let score = 0
  for (const word of words) {
    if (name.includes(word)) score += 3
    else if (href.includes(word)) score += 1
  }

  if (intent === 'download' && /download|\.pdf|\.csv|\.zip|export/.test(`${name} ${href}`)) score += 4
  if (intent === 'signin' && /sign in|log ?in/.test(name)) score += 4
  if (intent === 'buy' && /add to (cart|basket)|buy now|checkout/.test(name)) score += 4
  if (intent === 'submit' && /submit|send|continue|next|apply|confirm/.test(name)) score += 4
  if (intent === 'search' && element.role === 'textbox' && /search/.test(name)) score += 4
  /* Tie-breakers only. A link with a real destination is the least surprising
   * thing to propose *among candidates that already matched* — never a reason
   * to propose something the goal said nothing about. Proposing the nav bar
   * because it was the only link on the page is how a preview becomes noise. */
  if (score <= 0) return 0
  if (intent === 'open' && element.role === 'link') score += 1
  if (element.role === 'link' && href.startsWith('http')) score += 1
  return score
}

/**
 * The inspection as the owner reads or hears it.
 *
 * The capsule check happens here, on the display path, rather than at write
 * time: an inspection recorded last week is still on disk, and if its source
 * has since been revoked the quote must stop being spoken without anyone
 * having had to remember to go back and rewrite the record. Derived on read,
 * the same shape executionJournal.js uses.
 */
export function formatInspection(inspection) {
  const { withheld } = usableCapsuleIds(inspection.capsuleIds ?? [])
  const gone = new Map(withheld.map((entry) => [entry.capsuleId, entry]))

  const lines = [
    `${inspection.title || inspection.url}`,
    `${inspection.url} — read ${inspection.retrievedAt}. Nothing on the page was touched.`,
    '',
  ]

  for (const finding of inspection.findings) {
    const revoked = gone.get(finding.citation?.capsuleId)
    if (revoked) {
      lines.push(
        `· ${finding.term ? `${finding.term}: ` : ''}[evidence ${revoked.capsuleId} ${revoked.state}] ${revoked.reason}`,
      )
      continue
    }
    if (finding.missing) {
      lines.push(`· ${finding.term}: not on the page (${finding.citation.locator})`)
      continue
    }
    lines.push(`· ${finding.term ? `${finding.term}: ` : ''}“${finding.quote}”`)
    lines.push(`      ${finding.citation.locator}`)
  }

  if (inspection.capsuleIds?.length) {
    lines.push('', `Evidence: ${inspection.capsuleIds.join(', ')}`)
  }

  if (inspection.proposal) {
    lines.push(
      '',
      'Proposed next step:',
      `    ${inspection.proposal.action.label}`,
      `    ${inspection.proposal.effect}`,
      `    evidence: ${inspection.proposal.citation.locator}`,
      '',
      `Run it with inspection id ${inspection.inspectionId}.`,
    )
  } else {
    lines.push('', 'No next step proposed: nothing on the page matched what you asked for.')
  }

  return lines.join('\n')
}

export function getInspection(inspectionId) {
  return loadStore().inspections.find((item) => item.inspectionId === inspectionId) ?? null
}

export function listInspections({ limit = 10 } = {}) {
  return loadStore()
    .inspections.slice(-limit)
    .reverse()
    .map(({ findings, ...inspection }) => ({ ...inspection, findingCount: findings.length }))
}

/* --------------------------------------------------------------------- act */

/**
 * Run the action the inspection proposed. Exactly that action, on exactly the
 * element it described.
 *
 * `text` is accepted for a browser_type proposal because the inspection can
 * find the field but cannot know what goes in it. Nothing else about the
 * proposal can be changed here — a caller who wants a different action can
 * call browser_click directly, which has never needed anything from this file.
 */
export async function actOnInspection(
  inspectionId,
  { text = null, now = Date.now() } = {},
  { snapshot = snapshotPage, run = runBrowserAction } = {},
) {
  const store = loadStore()
  const inspection = store.inspections.find((item) => item.inspectionId === inspectionId)
  if (!inspection) throw new Error(`No inspection ${inspectionId}. Inspect a page first.`)
  if (!inspection.proposal) {
    throw new Error(`Inspection ${inspectionId} proposed no action, so there is nothing to run.`)
  }

  const { proposal } = inspection
  /* Re-locate before acting: refs are per-snapshot, so the stored one is a
   * label, not an address. See the note at the top of the file. */
  const fresh = await snapshot(inspection.target, {
    maxElements: 120,
    options: { source: 'browser-inspect-act' },
  })
  const located = relocate(fresh.elements ?? [], proposal.element)

  if (!located.element) {
    throw new Error(
      `“${proposal.element.name || proposal.element.selector}” is no longer on ${inspection.url}, so the proposed step cannot be run as previewed.`,
    )
  }

  const params = { ...proposal.action.params, ref: located.element.ref }
  if (proposal.action.type === 'browser_type') {
    if (text === null) throw new Error('This proposal types into a field; pass the text to type.')
    params.text = String(text)
  }

  const wire = proposal.action.type.replace(/^browser_/, '')
  const result = await run(wire, params, { source: 'browser-inspect-act', label: proposal.action.label })

  const record = {
    at: new Date(now).toISOString(),
    action: { ...proposal.action, params },
    matchedBy: located.matchedBy,
    relocated: located.element.ref !== proposal.element.ref,
    pageChanged: fresh.url !== inspection.url,
    ok: true,
    message: String(result?.message ?? 'Done.'),
    /* What this click stood on: the reading that proposed it, plus the
     * re-snapshot that located the element it actually hit. The second one
     * matters — the element may have moved, and the evidence for where it
     * ended up is a different capsule from the evidence for choosing it. */
    capsuleIds: [
      ...new Set([...(inspection.capsuleIds ?? []), fresh.capsuleId].filter(Boolean)),
    ],
  }
  inspection.acts = [...(inspection.acts ?? []), record]
  saveStore(store)

  return {
    ok: true,
    inspectionId,
    ...record,
    spoken: `${proposal.action.label}. ${record.relocated ? 'The element had moved on the page; followed it.' : ''}`.trim(),
  }
}

/**
 * Find the element this proposal described in a fresh snapshot.
 *
 * Selector first (it is derived from the DOM path), then accessible name plus
 * role, then name alone. The ref is deliberately last-resort-free: it is never
 * trusted, because a stale ref matching a different element is exactly the
 * mistake this whole file exists to avoid.
 */
export function relocate(elements, described) {
  const bySelector = elements.find((element) => element.selector === described.selector)
  if (bySelector) return { element: bySelector, matchedBy: 'selector' }

  const name = String(described.name ?? '').trim().toLowerCase()
  if (name) {
    const byNameAndRole = elements.find(
      (element) =>
        element.role === described.role &&
        String(element.name ?? '').trim().toLowerCase() === name,
    )
    if (byNameAndRole) return { element: byNameAndRole, matchedBy: 'name+role' }

    const byName = elements.find(
      (element) => String(element.name ?? '').trim().toLowerCase() === name,
    )
    if (byName) return { element: byName, matchedBy: 'name' }
  }

  if (described.href) {
    const byHref = elements.find((element) => element.href === described.href)
    if (byHref) return { element: byHref, matchedBy: 'href' }
  }

  return { element: null, matchedBy: null }
}
