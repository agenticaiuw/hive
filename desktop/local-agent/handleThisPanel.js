import {
  addressPage,
  excerptAround,
  isHttpUrl,
  normalizeText,
  runBrowserActions,
  tabNeedle,
} from './browserPage.js'
import { getBrowserStatus } from './browserBridge.js'
import { AGENT_TOKEN, PORT } from './config.js'
import { listCapsules, normalizeSource } from './evidenceCapsules.js'
import { reconcileAll } from './handleThisReconcile.js'

/*
 * The panel: several inspectors read one page, and each one's reading keeps its
 * own evidence so a later disagreement can be traced to what that inspector
 * actually saw.
 *
 * "Several agents" is only worth the round trips if the agents can genuinely
 * differ. Four copies of the same reader over the same bytes will always agree,
 * and their agreement means nothing — so the inspectors here are LENSES, and
 * the lenses are the extension's own read modes, which really do return
 * different text for the same page:
 *
 *   main_text  document.querySelector('main, [role=main], article').innerText
 *   text       document.body.innerText — includes nav, sticky headers, footers
 *   landmarks  headings and landmark elements only
 *   forms      the form controls and their names
 *   snapshot   the interactive controls with their accessible names
 *
 * (browser-extension/src/background.js, the `read_page` handler.)
 *
 * That difference is the whole point and it produces real disagreements rather
 * than manufactured ones: a total inside <main> and a different total in a
 * sticky cart summary in the footer is a page where main_text and text
 * legitimately disagree, and the owner very much wants to know that rather than
 * to be handed whichever one won.
 *
 * ── Evidence ──────────────────────────────────────────────────────────────
 *
 * No capsule is minted here. computerControl.js already mints one per read at
 * the point the extension answers, with `region.kind` set to the read mode —
 * which means the capsule the platform already makes is per-lens, and the
 * inspector identity is already carried in the evidence without a second
 * capsule for the same bytes. browserPage.js says callers must not mint their
 * own and gives the reason (one reading becoming two capsules that disagree
 * about nothing); that rule and this feature's requirement happen to want the
 * same thing here, so nothing had to be bent.
 *
 * What a reading carries is therefore the capsule id, its content hash and its
 * state, straight through from `result.evidence`. The content hash is what the
 * reconciler counts, so a lens whose evidence is missing (older extension, or a
 * read nothing mints for) is honestly reported as unprovable rather than being
 * given a hash of our own invention.
 *
 * ── Tabs ──────────────────────────────────────────────────────────────────
 *
 * The inspectors do NOT get a tab each. The page is addressed once and every
 * lens then reads the tab that is already there, in one batched /execute call
 * so the reads cannot interleave with anything.
 *
 * That is the answer to inspectors fighting over tabs, and it is better than
 * giving each one its own lane: five lanes on the same URL means five tabs
 * opened in the owner's Safari for one question, and five navigations of a page
 * that may not be idempotent to fetch. One navigation, five reads.
 *
 * It also gets session affinity for free. Every read in the batch is addressed
 * by the same `urlContains` needle, and browserBridge.sessionIdFrom derives its
 * session id from exactly that needle when no explicit session survives onto
 * the wire — so all five reads share one session id, and its soft affinity
 * keeps them on the device that served the first one. Readings compared against
 * each other therefore come from one browser, which matters more than it
 * sounds: the same URL in two browsers is two different login states, and a
 * disagreement between them would be an artifact of which Safari answered
 * rather than anything about the page.
 *
 * NOTHING HERE WRITES TO A PAGE. The allowlist below is enforced by
 * browserPage.runBrowserActions, which throws before the trip on anything not
 * in it, so no click, no type and no submit is reachable from this module even
 * by a caller that asks for one.
 */

/*
 * Reading a page includes fetching it. `navigate` is a GET of the page the
 * owner named — the same thing pressing ⌘R does — and originFanOut.js's
 * FANOUT_READ_ONLY makes the same call for the same reason.
 */
export const PANEL_ACTIONS = new Set(['list_tabs', 'navigate', 'read_page', 'snapshot'])

/* Same origin browserPage.js talks to, for the same reason: the bridge moves,
 * the agent's HTTP surface does not. */
const AGENT_ORIGIN = process.env.LOCAL_AGENT_URL || `http://127.0.0.1:${PORT || 8000}`

export const LENSES = Object.freeze({
  'main-text': {
    action: 'browser_read_page',
    params: { mode: 'main_text' },
    region: 'main_text',
    sees: 'the main article body, without the surrounding page furniture',
  },
  'full-text': {
    action: 'browser_read_page',
    params: { mode: 'text' },
    region: 'text',
    sees: 'everything the page renders, including nav, sticky bars and footers',
  },
  landmarks: {
    action: 'browser_read_page',
    params: { mode: 'landmarks' },
    region: 'landmarks',
    sees: 'headings and landmark regions only',
  },
  'form-fields': {
    action: 'browser_read_page',
    params: { mode: 'forms' },
    region: 'forms',
    sees: 'the form controls and the names they submit under',
  },
  controls: {
    action: 'browser_snapshot',
    params: { maxElements: 80 },
    region: 'snapshot',
    sees: 'the interactive controls and their accessible names',
  },
})

/*
 * The default panel.
 *
 * main_text and text are the pair most likely to genuinely differ, so they are
 * the two that carry the corroboration; landmarks is cheap and catches the case
 * where a value only exists in a heading. Adding all five by default would
 * quadruple the read cost of every question to find a fourth and fifth voice
 * that mostly restate the first.
 */
export const DEFAULT_LENSES = Object.freeze(['main-text', 'full-text', 'landmarks'])

const MAX_ANSWER_CHARS = 160
const READ_CHARS = 12_000

/* --------------------------------------------------------------- matching */

/**
 * Turn a question into something that can be run over page text.
 *
 * Two forms, because they fail differently. A `pattern` is exact and silent
 * when the page words it differently; a `label` is forgiving and picks up
 * whatever follows the words on the page. Both are reported in `via` so a
 * reading's answer can be traced to how it was found, which matters when two
 * inspectors disagree and one of them matched a label that meant something else.
 */
export function buildMatchers(question = {}) {
  const matchers = []

  for (const pattern of question.patterns ?? []) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i')
    matchers.push({ via: `pattern ${regex.source}`, regex })
  }

  for (const label of question.labels ?? []) {
    const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    /*
     * Up to the end of the line: a label's value is what follows it on the
     * page, and running past the newline swallows the next field entirely.
     *
     * The cost is that trailing text on the line comes along — "$52.10" and
     * "$52.10 (updated)" are then two answers and will be reported as a
     * conflict. That is deliberately not smoothed over: this module's whole
     * bias is toward showing a difference and letting the owner judge it, and a
     * caller who wants the number alone should pass a `pattern`, which is what
     * patterns are for.
     */
    matchers.push({
      via: `label "${label}"`,
      regex: new RegExp(`${escaped}\\s*[:=\\-]?\\s*([^\\n]{1,${MAX_ANSWER_CHARS}})`, 'i'),
    })
  }

  return matchers
}

/**
 * One question against one lens's text. Returns null when the lens did not see
 * it, which is a distinct outcome from disagreeing about it — reconcile()
 * counts it as silence, never as a vote.
 */
export function extractAnswer(text, question) {
  const haystack = String(text ?? '')
  if (!haystack) return null

  for (const matcher of buildMatchers(question)) {
    const match = matcher.regex.exec(haystack)
    if (!match) continue

    const raw = (match[1] ?? match[0] ?? '').trim()
    if (!raw) continue

    const answer = normalizeText(raw).slice(0, MAX_ANSWER_CHARS)
    return {
      answer,
      via: matcher.via,
      /* The sentence it came from, so a disagreement can be read rather than
       * only counted. A bare value with no surroundings is exactly the thing
       * the owner cannot check. */
      excerpt: excerptAround(haystack, answer),
    }
  }

  return null
}

/* ---------------------------------------------------------------- reading */

/* The extension's payload for a snapshot is elements, not text. Rendered the
 * same way computerControl renders it into the capsule content, so the text the
 * matcher runs over is the text the evidence records. */
function textOf(payload) {
  if (Array.isArray(payload?.elements)) {
    return payload.elements
      .map(
        (element) =>
          `${element?.role ?? '?'} "${element?.name ?? ''}"${
            element?.value ? ` = ${element.value}` : ''
          }`,
      )
      .join('\n')
  }
  return String(payload?.content ?? '')
}

/**
 * One lens's result, in the shape reconcile() weighs.
 *
 * `observedAt` is stamped here, from our own clock, and is deliberately NOT the
 * capsule's capturedAt. evidenceCapsules warns about exactly this: content
 * addressing means an unchanged page answers a read taken one second ago with a
 * capsule first seen three weeks ago, so capturedAt would date every reading of
 * a stable page to whenever it last changed and make the whole panel look stale.
 * capturedAt is carried alongside because it is the right clock for the other
 * question — how long this text has been standing — just never for freshness.
 */
function readingFrom({ lens, questionKey, found, payload, evidence, url, observedAt, error }) {
  const source = url ? normalizeSource(url) : null

  return {
    inspector: lens,
    questionKey,
    answer: found?.answer ?? null,
    via: found?.via ?? null,
    excerpt: found?.excerpt ?? null,
    miss: found ? null : `the ${lens} lens read the page and this value was not in ${LENSES[lens]?.sees ?? 'what it sees'}`,
    capsuleId: evidence?.capsuleId ?? null,
    contentHash: evidence?.contentHash ?? null,
    capsuleState: evidence?.state ?? null,
    collapsed: Boolean(evidence?.collapsed),
    confidence: evidence?.confidence ?? null,
    sourceKey: source?.key ?? null,
    sourceUrl: source?.url ?? null,
    regionKey: `${LENSES[lens]?.region ?? lens}|`,
    /* Which browser answered, when the bridge says. Two readings from two
     * devices are two login states, not two opinions, and a caller comparing
     * them needs to be able to see that. */
    extensionId: payload?.provenance?.extensionId ?? null,
    landedUrl: payload?.provenance?.url || payload?.url || url || null,
    observedAt,
    capturedAt: evidence?.capturedAt ?? null,
    chars: textOf(payload).length,
    error: error ?? null,
  }
}

/* -------------------------------------------------------------- preflight */

/*
 * Ask the agent process what the browser is doing.
 *
 * FOUND LIVE, and the reason this is not just `getBrowserStatus()`:
 * browserBridge keeps its heartbeat map in module memory, so that call is only
 * truthful inside the agent's own process. Run from anywhere else — a CLI, a
 * probe, a second process — it reports `online: false` forever while reads
 * issued by the very same code succeed, because reads go over loopback to the
 * agent and the status call does not. The observed symptom was a panel that
 * listed the owner's three real Safari tabs and then declared the browser
 * disconnected and answered from cache.
 *
 * So: in-process state first (when this IS the agent, it is free and exact),
 * and the agent's own endpoint when that comes back empty.
 */
async function fetchAgentStatus() {
  try {
    const response = await fetch(`${AGENT_ORIGIN}/browser/status`, {
      headers: AGENT_TOKEN ? { Authorization: `Bearer ${AGENT_TOKEN}` } : {},
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return null
    const payload = await response.json()
    return payload?.ok === false ? null : payload
  } catch {
    /* No agent reachable. That is itself an answer — offline — and the caller
     * handles it the same way it handles a disconnected extension. */
    return null
  }
}

export async function resolveBrowserStatus() {
  const local = getBrowserStatus()
  if (local?.online) return local
  return (await fetchAgentStatus()) ?? local
}

/**
 * What the browser can do for us right now, decided before anything is queued.
 *
 * This check is load-bearing rather than cosmetic. browserBridge documents what
 * happens when work is queued for an extension that never connects: the command
 * outlives the caller that wanted it, and the next extension to come online
 * runs it — opening tabs in the owner's Safari hours later, unrelated to
 * anything they are doing. A five-lens panel queued against an offline browser
 * is five such tabs. So when nothing is online this module queues nothing at
 * all and answers from what it already has.
 */
export async function panelPreflight({ status = null } = {}) {
  const resolved = status ?? (await resolveBrowserStatus())
  const devices = (resolved?.devices ?? []).filter((device) => device.online)

  return {
    online: Boolean(resolved?.online),
    devices: devices.map((device) => ({
      extensionId: device.extensionId,
      browserName: device.browserName ?? null,
      tabCount: device.tabCount ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
    })),
    /*
     * More than one browser online is not an error, but it does mean two
     * readings addressed by URL can land in two different browsers with two
     * different login states. Nothing here can pin the device — /execute takes
     * no extension id — so the honest move is to say so rather than to compare
     * across them silently.
     */
    caveats: devices.length > 1
      ? [
          `${devices.length} browsers are connected (${devices.map((device) => device.browserName ?? device.extensionId).join(', ')}). Readings are addressed by URL and may not all come from the same one, so a disagreement here could be two login states rather than two views of one page.`,
        ]
      : [],
  }
}

/* -------------------------------------------------------- offline fallback */

/**
 * Answer from capsules already in the store, when the browser cannot be asked.
 *
 * This is not a cache pretending to be a reading. Every reading it produces is
 * dated by the capsule's own capturedAt — the FIRST time that text was seen,
 * which is the only clock available offline — and marked `live: false`, so it
 * flows through the same reconciler and comes out the far side with its age
 * attached instead of being quietly presented as current.
 */
export function recallFromEvidence(
  { questions = [], hosts = [], now = Date.now(), limit = 40 } = {},
  { list = listCapsules } = {},
) {
  const wanted = new Set(hosts.filter(Boolean))
  const capsules = (wanted.size ? [...wanted] : [null])
    .flatMap((host) => list({ host, state: 'live', now, limit }))
    .filter((capsule) => capsule?.content)

  const readings = []

  for (const capsule of capsules) {
    for (const question of questions) {
      const found = extractAnswer(capsule.content, question)
      if (!found) continue

      readings.push({
        /* Named for the region so two remembered readings of different lenses
         * stay two voices, exactly as they were when they were taken live. */
        inspector: `recalled:${capsule.region?.kind ?? 'page'}`,
        questionKey: question.key,
        answer: found.answer,
        via: found.via,
        excerpt: found.excerpt,
        capsuleId: capsule.capsuleId,
        contentHash: capsule.contentHash,
        capsuleState: capsule.state,
        confidence: capsule.confidence ?? null,
        sourceKey: normalizeSource(capsule.source?.url ?? '').key,
        sourceUrl: capsule.source?.url ?? null,
        regionKey: `${capsule.region?.kind ?? 'page'}|${capsule.region?.selector ?? ''}`,
        /* The only clock there is offline, and it is the wrong one for
         * freshness by design — so it is labelled rather than laundered. */
        observedAt: capsule.capturedAt,
        capturedAt: capsule.capturedAt,
        chars: capsule.chars ?? String(capsule.content ?? '').length,
        live: false,
        error: null,
      })
    }
  }

  return readings
}

/* ------------------------------------------------------------ the inspection */

/**
 * Read one page through several lenses and reconcile what they say.
 *
 * @param url        the page to inspect. Must already be a page the owner has a
 *                   session on — nothing here logs in, and nothing here follows
 *                   a link off the page it was given.
 * @param questions  [{key, prompt, patterns, labels}]
 * @param lenses     inspector names from LENSES.
 * @param reload     whether to re-fetch the page before reading it. False reads
 *                   the tab as the owner left it, which is the right default
 *                   for a page whose fetch is not free of side effects.
 */
export async function inspectInParallel(
  { url, questions = [], lenses = DEFAULT_LENSES, reload = true, label = 'inspect' } = {},
  {
    address = addressPage,
    run = runBrowserActions,
    status = null,
    now = () => Date.now(),
  } = {},
) {
  if (!isHttpUrl(url)) throw new Error('A parallel inspection needs an http(s) url.')
  if (!questions.length) throw new Error('A parallel inspection needs at least one question.')

  const chosen = lenses.filter((name) => LENSES[name])
  if (!chosen.length) throw new Error('None of the requested lenses exist.')

  const preflight = await panelPreflight(status ? { status } : {})

  if (!preflight.online) {
    const recalled = recallFromEvidence({
      questions,
      hosts: [normalizeSource(url).host].filter(Boolean),
      now: now(),
    })

    return {
      status: 'recalled',
      url,
      lenses: chosen,
      preflight,
      readings: recalled,
      ...reconcileAll({ questions, readings: recalled }),
      caveats: [
        'No browser is connected, so nothing was read just now. Everything above is remembered evidence, dated by when that text was FIRST seen — it may have been true for weeks or may have changed a minute ago, and this cannot tell which.',
        'Nothing was queued for the browser either: a queued read would have opened tabs whenever Safari next connected, which could be hours from now and nowhere near this question.',
      ],
    }
  }

  const options = {
    command: `inspect ${url}`,
    source: 'handle-this-panel',
    /* Enforced in browserPage before the trip. No click, type, select or press
     * is in this set, so the panel structurally cannot act on the page. */
    allow: PANEL_ACTIONS,
  }

  /*
   * Address once. Every lens then reads the tab that is already there, so the
   * five readings are five views of one fetch rather than five fetches that
   * would each be entitled to differ for reasons having nothing to do with the
   * page.
   */
  const page = await address(url, { reload, options })

  const batch = chosen.map((name) => {
    const lens = LENSES[name]
    return {
      type: lens.action,
      label: `${label}: ${name}`,
      params: {
        ...page.target,
        ...lens.params,
        ...(lens.action === 'browser_read_page' ? { maxChars: READ_CHARS } : {}),
      },
    }
  })

  /*
   * One /execute call for the whole panel.
   *
   * Sequential inside the agent, which is the point: the extension claims one
   * command per poll anyway, so issuing these as separate concurrent requests
   * would buy no parallelism and would let another caller's navigation land
   * between two of our reads. Batched, the lenses see one page state.
   */
  const observedAt = new Date(now()).toISOString()
  const results = await run(batch, options)

  const readings = []
  for (const [index, name] of chosen.entries()) {
    const outcome = results[index]
    const payload = outcome?.data ?? null
    const text = textOf(payload)

    for (const question of questions) {
      readings.push(
        readingFrom({
          lens: name,
          questionKey: question.key,
          found: outcome?.ok ? extractAnswer(text, question) : null,
          payload,
          evidence: payload?.evidence ?? null,
          url: payload?.url || page.url || url,
          observedAt,
          error: outcome?.ok ? null : (outcome?.error ?? 'the lens did not return'),
        }),
      )
    }
  }

  const reconciled = reconcileAll({ questions, readings })
  const caveats = [...preflight.caveats]

  if (page.redirectedFrom) {
    caveats.push(
      `The page redirected from ${page.redirectedFrom} to ${page.url}. Every reading below is of where it landed, which may be a login wall rather than the page you meant.`,
    )
  }
  if (page.ambiguous) {
    caveats.push(
      'More than one open tab matches this address, so the lenses read whichever one the browser resolved first.',
    )
  }
  const unprovable = readings.filter((reading) => reading.answer && !reading.contentHash)
  if (unprovable.length) {
    caveats.push(
      `${unprovable.length} reading(s) came back without an evidence capsule, so there is no way to prove they read different text from each other. Their agreement is reported as unverified rather than as confirmation.`,
    )
  }

  return {
    status: 'inspected',
    url: page.url,
    requestedUrl: url,
    disposition: page.disposition,
    lenses: chosen,
    preflight,
    readings,
    ...reconciled,
    caveats,
  }
}

/* ------------------------------------------------------------ across tabs */

/*
 * Origins that are open tabs but are never a source for an answer.
 *
 * Not a security boundary — it is about not treating the owner's search results
 * for the thing as evidence about the thing, which produces confident readings
 * of a snippet someone else wrote.
 */
const NOT_EVIDENCE = /^(www\.)?(google|bing|duckduckgo|search\.brave)\.[a-z.]+$/i

/**
 * The owner's open tabs, as candidate sources.
 *
 * Only tabs that are ALREADY OPEN. This is the line that keeps "gather the
 * details across my logged-in tabs" from becoming "go and log into things": a
 * tab the owner has open is a session they already established and a page they
 * already chose to have in front of them. Nothing here opens an origin that was
 * not already there.
 */
export async function scanOpenTabs(
  { origins = [], exclude = [] } = {},
  { run = runBrowserActions } = {},
) {
  const options = {
    command: 'list the tabs already open',
    source: 'handle-this-panel',
    allow: PANEL_ACTIONS,
  }

  const [listed] = await run(
    [{ type: 'browser_list_tabs', label: 'open tabs', params: { limit: 60 } }],
    options,
  )

  if (!listed?.ok) throw new Error(listed?.error || 'Could not list the open tabs.')

  const wanted = new Set(origins.filter(Boolean))
  const skipped = []
  const tabs = []

  for (const tab of listed.data?.tabs ?? []) {
    const url = String(tab?.url ?? '')
    if (!isHttpUrl(url)) {
      skipped.push({ url, why: 'not an http(s) page' })
      continue
    }

    const source = normalizeSource(url)
    if (NOT_EVIDENCE.test(source.host ?? '')) {
      skipped.push({ url: source.url, why: 'a search page is not evidence about what it lists' })
      continue
    }
    if (exclude.includes(source.host)) {
      skipped.push({ url: source.url, why: 'excluded by the caller' })
      continue
    }
    if (wanted.size && !wanted.has(source.origin) && !wanted.has(source.host)) {
      skipped.push({ url: source.url, why: 'outside the origins this task was scoped to' })
      continue
    }

    tabs.push({
      url,
      /* Addressed by needle, never by tabId. Safari hands out a different tab id
       * on every wake — browserPage.js records the live evidence — so a tab id
       * captured here is a dead reference by the next command. */
      needle: tabNeedle(url),
      host: source.host,
      origin: source.origin,
      title: String(tab?.title ?? '').slice(0, 200),
      active: Boolean(tab?.active),
    })
  }

  return { tabs, skipped }
}
