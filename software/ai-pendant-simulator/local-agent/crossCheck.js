import { getBrowserStatus } from './browserBridge.js'
import {
  addressPage,
  excerptAround,
  isHttpUrl,
  normalizeText,
  runBrowserActions,
} from './browserPage.js'
import { extractByAnchor } from './pageWatch.js'
import { fingerprint, similarity } from '../scripts/novelty.mjs'

/*
 * Ask one question of a page behind the owner's login, and answer it with
 * several readings that can disagree.
 *
 * WHY THIS EXISTS. A single extraction pass over an authenticated page — an
 * order history, a benefits portal, a dashboard — misses things, and reports the
 * miss in exactly the same voice as a hit. There is no second copy of the
 * owner's order history to check against, so a wrong answer here is unfalsifiable
 * by anything downstream. Several passes that read the page differently do not
 * make the answer right, but their DISAGREEMENT is a signal that nothing else in
 * this system produces, and it belongs to the owner rather than being resolved
 * behind their back.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * It is not a vote. Majority over samples of one model is theatre: three passes
 * with the same strategy over the same bytes make the same mistake and agree
 * perfectly while doing it, and their agreement is a tautology dressed as
 * evidence. Nothing here counts voices as though they were witnesses.
 *
 * What is counted instead is where the reading came from and how it was picked
 * out. Two strategies agree "independently" only when the LINE each one read is
 * absent from the other's region — checked against the actual text, not asserted
 * from a table of region names. Everything else is agreement over shared bytes
 * and is labelled as such (`repeated`, not `corroborated`).
 *
 * ── The independence that is actually available, stated honestly ───────────
 *
 * There is exactly ONE page fetch. Every strategy reads what that fetch
 * returned, so nothing here is independent of the fetch: a page that served the
 * wrong bytes, or a stale cache, or a session that silently logged out, is wrong
 * for every strategy at once and they will agree enthusiastically about it.
 * INDEPENDENCE_NOTE says this in the output so a caller cannot mistake the
 * agreement for corroboration by a second source.
 *
 * Within that fetch, three axes of difference are real:
 *
 *   1. REGION. The extension's read modes return genuinely different text for
 *      one page (browser-extension/src/background.js, the `read_page` handler):
 *      main_text is `main, [role=main], article` innerText; text is the whole
 *      body including nav, sticky bars and footers; landmarks is headings and
 *      landmark elements only. main_text is a SUBSET of text, so those two are
 *      not two witnesses — which is why this module never compares them
 *      directly. It subtracts them: `chrome` is the lines in text that are not
 *      in main_text, computed here for free, and it is disjoint from `main` by
 *      construction. A total inside <main> and a different total in a sticky
 *      cart bar is a real contradiction on a real page, and this is the pair
 *      that can see it.
 *
 *   2. EXTRACTION. `anchor` takes what FOLLOWS a label, stopping at the page's
 *      own layout whitespace (pageWatch.extractByAnchor — reused rather than
 *      rewritten). `semantic` ignores ordering and takes the value-shaped token
 *      NEAREST the label on either side. They fail differently: anchor cannot
 *      read "$41.98 total" because the value precedes the label; semantic picks
 *      the wrong number when two are equidistant. Same bytes, so their agreement
 *      is correlated and is reported as `repeated`.
 *
 *   3. A TARGETED SECOND LOOK. Only when the first pass came back contested or
 *      single-source, and only then, one extra batch re-reads the page scoped to
 *      the CSS selectors of controls whose accessible names carry the label —
 *      taken from the snapshot already in the first batch, never from a
 *      per-site selector written into this file. Its bytes are a subtree of what
 *      was already read, so it adds LOCATION, not independence, and the output
 *      says exactly that.
 *
 * ── Traffic ────────────────────────────────────────────────────────────────
 *
 * Parallel strategies over one page read, not N times the traffic. The page is
 * addressed once (navigate + list_tabs, as addressPage does) and every region is
 * then read in a SINGLE batched /execute call, because each action costs one
 * extension poll and the extension runs one command at a time — the same serial
 * fact originFanOut.js's SAFARI_LANE_LIMIT is built around. Five strategies cost
 * three reads plus one snapshot, in one batch, against one tab.
 *
 * A second batch happens only for the targeted second look, is bounded to
 * SECOND_LOOK_LIMIT reads, and every one of them is reported with the reason it
 * was taken. `inFlight` refuses a concurrent cross-check of the same origin
 * outright rather than opening a second uncontrolled path to it.
 *
 * NOTHING HERE WRITES TO A PAGE. CROSSCHECK_READ_ONLY is handed to every browser
 * call and browserPage.runBrowserActions throws on anything outside it before
 * the request is built, so click, type, select and press_key are unreachable
 * from this module rather than merely unused by it.
 */

/* Reading a page includes fetching it: navigate is a GET of the page the owner
 * named, the same thing ⌘R does. Same set, same reason, as originFanOut's
 * FANOUT_READ_ONLY, plus snapshot because the targeted second look needs a
 * selector and the accessibility tree is where selectors come from. */
export const CROSSCHECK_READ_ONLY = new Set(['list_tabs', 'navigate', 'read_page', 'snapshot'])

export const INDEPENDENCE_NOTE =
  'All strategies read one page fetch. They differ in which region of the DOM they read and how they pick a value out of it; none of them is a second source. A page that served wrong or stale bytes is wrong for every strategy at once.'

/*
 * The regions asked of the extension, and what each one actually returns.
 *
 * `sees` is not decoration — it is printed next to every claim, so "which
 * strategy said this and from where" is answerable by the owner without reading
 * this file.
 */
export const REGIONS = Object.freeze({
  main: {
    mode: 'main_text',
    sees: 'the main content region (main, [role=main] or article), without the surrounding page furniture',
  },
  full: {
    mode: 'text',
    sees: 'everything the page renders, including nav, sticky bars and footers',
  },
  landmarks: {
    mode: 'landmarks',
    sees: 'headings and landmark elements only, with their text',
  },
})

/*
 * The derived region, and the reason this module bothers to derive one.
 *
 * `full` strictly contains `main`, so treating them as two readings would be the
 * exact error this feature exists to avoid: the same bytes counted twice. The
 * subtraction turns a nested pair into a disjoint one at no traffic cost, and
 * what is left is precisely the part of the page a main-content reader cannot
 * see — which is where sticky totals, banner warnings and footer summaries live.
 */
const CHROME = {
  id: 'chrome',
  sees: 'the page furniture: everything rendered outside the main content region (nav, sticky bars, banners, footer)',
}

/* Only when `main` could not be read at all does the whole body stand in for
 * it, and then it is named for what it is rather than borrowing main's name. */
const WHOLE_PAGE = {
  id: 'page',
  sees: 'the whole rendered page, because the main content region could not be read on its own',
}

const EXTRACTORS = Object.freeze({
  anchor: {
    id: 'anchor',
    how: 'takes what follows the label, stopping where the page\'s own layout puts a break',
  },
  semantic: {
    id: 'semantic',
    how: 'ignores ordering and takes the value-shaped token nearest the label, on either side of it',
  },
})

/* Bounds. Every one of these caps something a hostile or merely enormous page
 * could otherwise make unbounded. */
const MAX_ASKS = 8
const MAX_ALIASES = 6
const DEFAULT_MAX_CHARS = 12_000
const SELECTOR_MAX_CHARS = 4_000
const SEMANTIC_RADIUS = 160
const ANCHOR_TAKE = 120
const MAX_VALUE_WORDS = 8
const QUOTE_RADIUS = 110
const SECOND_LOOK_LIMIT = 4
const MAX_RUNS_KEPT = 20
const DEFAULT_TIMEOUT_MS = 45_000

/*
 * When two differently-worded readings are the same answer.
 *
 * scripts/novelty.mjs's similarity() is reused here rather than a third Jaccard
 * being written, but its SAME_IDEA_AT of 0.30 deliberately is NOT: that number
 * was tuned so an agent could not restate a feature proposal, where a false
 * merge costs one wasted round. Here a false merge silently converts a
 * disagreement into a consensus, which is the single failure this whole module
 * exists to prevent, so the bar is much higher.
 *
 * It also does very little work, and that is worth being explicit about:
 * fingerprint() keeps only words of four or more characters and similarity()
 * returns 0 when either side has fewer than four of them. Extracted values are
 * almost always shorter than that — "$41.98", "Delivered", "12 August" all
 * score 0 against everything. So Jaccard decides agreement only for prose-length
 * answers; short values are settled by shape and by containment below, neither
 * of which is a similarity metric.
 */
const SAME_ANSWER_AT = 0.5

/*
 * How a group of claims came to be one group. Carried on every merge, because
 * "these three agree" is a much weaker statement when the agreement was reached
 * by fuzzy wording than when the two strings were identical, and the owner
 * should be able to see which it was.
 */
const MERGE_REASONS = Object.freeze({
  identical: 'the readings are the same string',
  shape: 'the readings carry the same value once shape is normalized',
  contains: 'one reading is a longer form of the other',
  wording: 'the readings are the same sentence in different words',
})

/* Ranked so a group can be summarised by its strongest pair. Only `disjoint`
 * is corroboration; the rest are one observation with several names. */
const INDEPENDENCE_RANK = Object.freeze({
  disjoint: 2,
  'overlapping-bytes': 1,
  'same-line': 0,
  'same-region': 0,
})

/* ------------------------------------------------------------------- asks */

/**
 * What the caller wants answered, as a list of named things.
 *
 * Generic by construction: an ask is a name and the words the page might use for
 * it. No selector, no site, no field layout — the aliases come from the caller
 * or from their own question, never from a table in this file.
 */
export function normalizeAsks(input, question = '') {
  const list = (Array.isArray(input) ? input : input ? [input] : [])
    .map((raw) => (typeof raw === 'string' ? { name: raw } : raw))
    .filter((raw) => raw && typeof raw === 'object')

  if (list.length) {
    return {
      asks: list.slice(0, MAX_ASKS).map((raw, index) => {
        const name = String(raw.name || raw.label || raw.field || `ask_${index + 1}`).slice(0, 80)
        const aliases = [name, ...[].concat(raw.aliases ?? raw.labels ?? [])]
          .map((alias) => String(alias).trim())
          .filter(Boolean)
        return {
          name,
          /* De-duplicated case-insensitively, keeping the first spelling: the
           * same label twice would make one strategy look like two attempts at
           * the ask, and aliases are tried in order so the caller's first
           * wording should stay first. */
          aliases: aliases.filter(
            (alias, index) =>
              aliases.findIndex((other) => other.toLowerCase() === alias.toLowerCase()) === index,
          ).slice(0, MAX_ALIASES),
          take: Number(raw.take) > 0 ? Math.min(400, Number(raw.take)) : ANCHOR_TAKE,
        }
      }),
      derivedFrom: 'caller',
    }
  }

  /*
   * Nothing named, so the question itself has to supply the labels.
   *
   * fingerprint() from the novelty module is exactly the right tool — it already
   * drops the words too short to carry a topic — and using it means the words
   * this looks for are the same words the agreement check would compare. Marked
   * `derivedFrom: 'question'` all the way to the output, because a guessed label
   * that finds nothing is a different result from a caller's label that finds
   * nothing, and only one of them is evidence about the page.
   */
  const words = [...fingerprint(question)].slice(0, MAX_ASKS)
  if (!words.length) {
    throw new Error(
      'A cross-check needs something to look for: pass `ask`, or a question with words in it.',
    )
  }
  return {
    asks: words.map((word) => ({ name: word, aliases: [word], take: ANCHOR_TAKE })),
    derivedFrom: 'question',
  }
}

/* -------------------------------------------------------------- extraction */

/*
 * Shapes a value can have, in the order they are preferred.
 *
 * Generic across pages by design: money, percentages, dates, times and plain
 * counts are what a portal puts next to a label, and none of these patterns
 * knows what site it is on. Money before count so "$41.98" is not read as "41".
 */
const VALUE_SHAPES = [
  {
    name: 'money',
    re: /[$£€¥]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:usd|eur|gbp|dollars|euros)\b/i,
  },
  { name: 'percent', re: /\d+(?:\.\d+)?\s?%/ },
  {
    name: 'date',
    re: /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b(?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{1,2})?(?:,?\s+\d{4})?\b/i,
  },
  { name: 'time', re: /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/i },
  { name: 'count', re: /\b\d[\d,]*(?:\.\d+)?\b/ },
]

/** The first recognisable value inside a string, with what kind of thing it is. */
export function shapeOf(value) {
  const text = String(value ?? '')
  for (const shape of VALUE_SHAPES) {
    const match = text.match(shape.re)
    if (match) return { name: shape.name, text: match[0].trim(), at: match.index ?? 0 }
  }
  return null
}

/**
 * The form of a value two readings are compared in.
 *
 * Comparison is shape-aware; REPORTING never is. "$41.98 including tax" is
 * reported verbatim and compared as "$41.98", so a strategy that grabbed the
 * whole clause and one that grabbed the number are not made to look like a
 * disagreement — while $41.98 and $39.99 still are one.
 */
export function valueKey(value) {
  const shape = shapeOf(value)
  return normalizeKey(shape ? shape.text : value)
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    /* Thousands separators are typography, not data: one region writes 1,234.00
     * and another writes 1234.00 for the same number. */
    .replace(/(\d),(\d)/g, '$1$2')
    /* And the currency mark is the page's, not the reading's: one strategy hands
     * back "$41.98" and another the "41.98" it found inside a longer clause.
     * Comparing them as different answers would manufacture a disagreement out
     * of one number. Only the key loses the symbol — every value is reported
     * exactly as it was read. */
    .replace(/^[$£€¥]\s?/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '')
    .trim()
}

/** The rendered line a match sits on — the unit a person actually reads. */
function lineAt(text, index) {
  const source = String(text ?? '')
  if (index < 0) return ''
  const start = source.lastIndexOf('\n', index) + 1
  const end = source.indexOf('\n', index)
  return normalizeText(source.slice(start, end < 0 ? source.length : end))
}

function occurrencesOf(text, needle) {
  const hay = String(text ?? '').toLowerCase()
  const target = String(needle ?? '').toLowerCase()
  const found = []
  if (!target) return found
  let at = hay.indexOf(target)
  while (at >= 0 && found.length < 20) {
    found.push(at)
    at = hay.indexOf(target, at + target.length)
  }
  return found
}

/**
 * Structural read: what follows the label.
 *
 * Deliberately delegated to pageWatch.extractByAnchor rather than reimplemented,
 * and deliberately fed the RAW region text: that function stops at a run of two
 * or more spaces or a newline, which is the page's own layout doing the work of
 * a delimiter. Normalizing first would collapse exactly the whitespace it needs.
 */
export function anchorPick(rawText, alias, { take = ANCHOR_TAKE } = {}) {
  const value = extractByAnchor(rawText, alias, { take })
  if (!value) return null
  const at = String(rawText ?? '').toLowerCase().indexOf(String(alias).toLowerCase())
  return {
    value,
    line: lineAt(rawText, at),
    locator: `the text following “${alias}”`,
  }
}

/**
 * Semantic read: the value nearest the label, whichever side it is on.
 *
 * The difference from anchorPick is not cosmetic. A page that renders
 * "$41.98 total" is invisible to an anchor read and plain to this one; a page
 * with two numbers equidistant from the label fools this one and not the anchor.
 * Two extractors with different blind spots over the same bytes is a weaker kind
 * of independence than two regions, and reconcile() grades it as such — but it
 * is not nothing, and it costs no extra traffic at all.
 */
export function semanticPick(rawText, alias, { radius = SEMANTIC_RADIUS } = {}) {
  const source = String(rawText ?? '')
  const spots = occurrencesOf(source, alias)
  if (!spots.length) return null

  /*
   * The label's own rendered line first, and only then a wider window.
   *
   * A page puts a label and its value on one line far more often than not, and
   * a plain radius scan does not know that: on "Order #A-4821 / Order total:
   * $41.98" the "4821" one line up is nearer to "Order total" than the $41.98
   * beside it, so a single-stage scan answers the total with the order number.
   * Narrowing to the line first is the page's own layout being used as evidence,
   * the same argument extractByAnchor makes for stopping at layout whitespace.
   */
  const online = (at) => lineBounds(source, at)
  const nearby = (at) => [
    Math.max(0, at - radius),
    Math.min(source.length, at + alias.length + radius),
  ]

  /*
   * The label's line is exhausted — shaped value first, then a short phrase
   * beside it — before anything off the line is considered at all.
   *
   * Order matters and was got wrong once: with the wide scan second overall, a
   * "Status" whose value is the words "parcel held at local depot" answered with
   * the $41.98 sitting one line above, because a price is shaped and a status is
   * not. A value on a different rendered line is a worse candidate than a
   * plain phrase on the label's own line, whatever shape it has.
   */
  const best =
    scanShapes(source, spots, alias, online) ??
    nearestPhrase(source, spots, alias, online) ??
    scanShapes(source, spots, alias, nearby) ??
    nearestPhrase(source, spots, alias, nearby)

  if (!best) return null

  return {
    value: best.value,
    line: lineAt(source, best.at),
    locator: best.kind
      ? `the nearest ${best.kind} to “${alias}”`
      : `the phrase beside “${alias}”`,
  }
}

function lineBounds(source, at) {
  const start = source.lastIndexOf('\n', at) + 1
  const end = source.indexOf('\n', at)
  return [start, end < 0 ? source.length : end]
}

/**
 * The value-shaped token nearest the label inside some bounds.
 *
 * Nearest wins and shape only breaks ties. The other way round is tempting and
 * wrong: preferring money over dates would answer "delivery date" with the total
 * whenever a price sits in the same paragraph, which is a page every checkout
 * produces. Distance is what carries the page's own association between a label
 * and its value.
 */
function scanShapes(source, spots, alias, boundsFor) {
  let best = null

  for (const at of spots) {
    const [from, to] = boundsFor(at)
    const window = source.slice(from, to)
    const anchorAt = at - from

    VALUE_SHAPES.forEach((shape, rank) => {
      /* Scan the whole window for this shape, not just the first hit, so the
       * nearest one wins rather than the leftmost one. */
      const scanner = new RegExp(shape.re.source, `${shape.re.flags.replace(/g/g, '')}g`)
      for (const match of window.matchAll(scanner)) {
        const start = match.index ?? 0
        /* The label's own characters are not a candidate value: "order 2" as an
         * alias must not have its own "2" read back as the answer. */
        if (start >= anchorAt && start < anchorAt + alias.length) continue
        const distance = Math.abs(start - anchorAt)
        const absolute = from + start

        /*
         * Shapes nest — "$41.98" is a money match and a count match one
         * character apart — and pure distance picks whichever end the label
         * happens to be on, so "$41.98 total" would read back as "41.98" and
         * "total $41.98" as "$41.98". Two readings of one number that then look
         * like a disagreement is the worst failure this module has, so an
         * overlapping candidate is settled by shape rank and never by the one
         * character between them.
         */
        const overlapping =
          best && absolute < best.at + best.value.length && best.at < absolute + match[0].length
        const better = !best
          ? true
          : overlapping
            ? rank < best.rank
            : distance < best.distance || (distance === best.distance && rank < best.rank)

        if (better) {
          best = { value: match[0].trim(), distance, rank, at: absolute, kind: shape.name }
        }
      }
    })
  }

  return best
}

/**
 * The shortest phrase sitting beside the label, when nothing shaped is nearby.
 *
 * Still looks on both sides, which is what keeps this different from the anchor
 * read, and still capped at MAX_VALUE_WORDS so a paragraph never becomes a
 * "value" — a status, a name or a plan tier is a few words, and anything longer
 * is the page's prose rather than its answer.
 */
function nearestPhrase(source, spots, alias, boundsFor) {
  for (const at of spots) {
    const [from, to] = boundsFor(at)
    const before = source.slice(from, at)
    const after = source.slice(at + alias.length, to)

    const candidates = []
    const push = (chunk, offset) => {
      const parts = String(chunk).split(/[\n|·•]|(?<=[.!?;:])\s|\s{2,}/)
      let cursor = 0
      for (const part of parts) {
        const clean = normalizeText(part).replace(/^[\s:：\-–—>|]+/, '')
        if (clean && clean.split(/\s+/).length <= MAX_VALUE_WORDS) {
          candidates.push({ value: clean, at: offset + cursor, kind: null })
        }
        cursor += part.length + 1
      }
    }

    /* After first: a label followed by its value is the common case, and ties
     * should not be broken by which side the loop happened to visit first. */
    push(after, at + alias.length)
    push(before, from)

    if (candidates[0]) return candidates[0]
  }

  return null
}

/* ----------------------------------------------------------------- surfaces */

/** Non-empty rendered lines, normalized, as a set for subtraction. */
function linesOf(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean)
}

/**
 * Turn what the browser returned into the surfaces the strategies read.
 *
 * The subtraction that makes `chrome` is here rather than in the browser,
 * because it costs nothing and because doing it locally is what lets the result
 * say honestly that this surface carries no capsule of its own: it is derived
 * from two readings, and the evidence for it is theirs.
 */
export function buildSurfaces(reads) {
  const surfaces = []
  const add = (id, sees, text, source) => {
    const raw = String(text ?? '')
    if (!normalizeText(raw)) return
    surfaces.push({
      id,
      sees,
      raw,
      normalized: normalizeText(raw),
      chars: raw.length,
      ...source,
    })
  }

  const main = reads.main?.ok ? reads.main : null
  const full = reads.full?.ok ? reads.full : null
  const landmarks = reads.landmarks?.ok ? reads.landmarks : null

  if (main) {
    add('main', REGIONS.main.sees, main.text, {
      mode: REGIONS.main.mode,
      capsuleId: main.capsuleId ?? null,
      contentHash: main.contentHash ?? null,
    })
  }

  if (full && main) {
    const inMain = new Set(linesOf(main.text))
    const residual = linesOf(full.text).filter((line) => !inMain.has(line))
    add(CHROME.id, CHROME.sees, residual.join('\n'), {
      mode: `${REGIONS.full.mode} minus ${REGIONS.main.mode}`,
      /* No capsule: this text was never a single reading, so minting one here
       * would invent a second piece of evidence for bytes that already have
       * two. The two readings it was derived from carry the provenance. */
      capsuleId: null,
      contentHash: null,
      derivedFrom: ['main', 'full'],
    })
  } else if (full) {
    add(WHOLE_PAGE.id, WHOLE_PAGE.sees, full.text, {
      mode: REGIONS.full.mode,
      capsuleId: full.capsuleId ?? null,
      contentHash: full.contentHash ?? null,
    })
  }

  if (landmarks) {
    add('landmarks', REGIONS.landmarks.sees, landmarks.text, {
      mode: REGIONS.landmarks.mode,
      capsuleId: landmarks.capsuleId ?? null,
      contentHash: landmarks.contentHash ?? null,
    })
  }

  return surfaces
}

/**
 * Which extractors run on which surface.
 *
 * Both extractors on the prose surfaces, where the difference between "after the
 * label" and "nearest the label" is a real difference. Anchor only on
 * `landmarks`, whose text is already `tag: name` pairs — a proximity read of it
 * would return the same token from the same line and add a voice without adding
 * a way of being wrong, which is the definition of a fake second opinion.
 */
export function planStrategies(surfaces) {
  const plan = []
  for (const surface of surfaces) {
    const extractors =
      surface.id === 'landmarks' ? [EXTRACTORS.anchor] : [EXTRACTORS.anchor, EXTRACTORS.semantic]
    for (const extractor of extractors) {
      plan.push({
        id: `${surface.id}-${extractor.id}`,
        surface: surface.id,
        extractor: extractor.id,
        reads: surface.sees,
        how: extractor.how,
      })
    }
  }
  return plan
}

/** Run one plan over one page's surfaces. Pure: no browser, no clock, no store. */
export function extractClaims({ asks, surfaces, strategies }) {
  const bySurface = new Map(surfaces.map((surface) => [surface.id, surface]))
  const claims = []

  for (const strategy of strategies) {
    const surface = bySurface.get(strategy.surface)
    if (!surface) continue
    const pick = strategy.extractor === 'anchor' ? anchorPick : semanticPick

    for (const ask of asks) {
      for (const alias of ask.aliases) {
        const hit = pick(surface.raw, alias, { take: ask.take })
        if (!hit?.value) continue
        claims.push({
          ask: ask.name,
          alias,
          strategy: strategy.id,
          surface: surface.id,
          region: surface.mode ?? surface.id,
          sees: surface.sees,
          how: strategy.how,
          value: String(hit.value).slice(0, 400),
          line: hit.line,
          locator: hit.locator,
          quote: excerptAround(surface.raw, hit.value, QUOTE_RADIUS),
          capsuleId: surface.capsuleId ?? null,
          contentHash: surface.contentHash ?? null,
        })
        /* First alias that lands wins: a strategy gets one reading per ask, so a
         * label written two ways cannot pad the support count for a value. */
        break
      }
    }
  }

  return claims
}

/* ------------------------------------------------------------ independence */

/**
 * How much two claims actually corroborate each other.
 *
 * Measured against the text, not looked up in a table of region names. The
 * containment check is the one that matters: `landmarks` and `main` are
 * different read modes but the same headings appear in both, so a claim taken
 * from a heading is one observation no matter how many modes returned it.
 */
export function independenceBetween(left, right, surfaceText) {
  if (left.surface === right.surface) return 'same-region'
  if (left.line && right.line && left.line === right.line) return 'same-line'

  const leftIn = left.line ? (surfaceText.get(right.surface) ?? '').includes(left.line) : false
  const rightIn = right.line ? (surfaceText.get(left.surface) ?? '').includes(right.line) : false
  if (leftIn || rightIn) return 'overlapping-bytes'

  /* Identical capsule content hashes mean two reads returned the same bytes,
   * whatever they were called. evidenceCapsules mints content-addressed, so this
   * is a real collapse rather than a coincidence. */
  if (left.contentHash && left.contentHash === right.contentHash) return 'overlapping-bytes'

  return 'disjoint'
}

function pairsOf(claims, surfaceText) {
  const pairs = []
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      pairs.push({
        strategies: [claims[i].strategy, claims[j].strategy],
        regions: [claims[i].surface, claims[j].surface],
        independence: independenceBetween(claims[i], claims[j], surfaceText),
      })
    }
  }
  return pairs
}

const bestIndependence = (pairs) =>
  pairs.reduce(
    (best, pair) =>
      INDEPENDENCE_RANK[pair.independence] > INDEPENDENCE_RANK[best] ? pair.independence : best,
    'same-region',
  )

/* ---------------------------------------------------------- reconciliation */

function mergeReason(group, claim) {
  const incoming = normalizeKey(claim.value)
  if (!incoming) return null

  for (const existing of group.claims) {
    const held = normalizeKey(existing.value)
    if (held === incoming) return 'identical'
    if (valueKey(existing.value) && valueKey(existing.value) === valueKey(claim.value)) return 'shape'
    /* One reading is the other plus context ("Delivered" and "Delivered
     * Tuesday"). Whole-string containment, not fuzzy overlap, and the shorter
     * side has to be substantial enough that "4" does not swallow "£412.40". */
    const shorter = held.length <= incoming.length ? held : incoming
    const longer = held.length <= incoming.length ? incoming : held
    if (shorter.length >= 3 && longer.includes(shorter)) return 'contains'
    /* Only reaches a verdict for prose-length answers; see SAME_ANSWER_AT. */
    if (similarity(existing.value, claim.value) >= SAME_ANSWER_AT) return 'wording'
  }
  return null
}

function groupClaims(claims) {
  const groups = []
  for (const claim of claims) {
    let placed = false
    for (const group of groups) {
      const reason = mergeReason(group, claim)
      if (!reason) continue
      group.mergedBy.add(reason)
      group.claims.push(claim)
      placed = true
      break
    }
    if (!placed) groups.push({ claims: [claim], mergedBy: new Set() })
  }
  return groups
}

/**
 * What several readings of one ask add up to — without ever collapsing a
 * disagreement into an answer.
 *
 * The five verdicts are deliberately not a scale. `corroborated` and `repeated`
 * both mean "they agreed", and the difference between them is whether the
 * agreement was over different bytes or the same ones; a caller that renders
 * them identically has thrown away the entire point of running more than one
 * strategy, so they are separate words rather than a confidence number that
 * would invite exactly that.
 */
export function reconcile({ asks, claims, surfaces, strategies }) {
  const surfaceText = new Map(surfaces.map((surface) => [surface.id, surface.normalized]))

  const verdicts = asks.map((ask) => {
    const mine = claims.filter((claim) => claim.ask === ask.name)
    /* A targeted second look was taken FOR one ask, so counting it as a
     * strategy that "looked and missed" on the others would turn a bounded
     * re-read into evidence of absence it never gathered. */
    const looked = strategies
      .filter((strategy) => !strategy.only || strategy.only === ask.name)
      .map((strategy) => strategy.id)
    const found = new Set(mine.map((claim) => claim.strategy))
    const lookedAndMissed = looked.filter((id) => !found.has(id))

    const groups = groupClaims(mine)
      .map((group) => {
        const pairs = pairsOf(group.claims, surfaceText)
        const independence = group.claims.length > 1 ? bestIndependence(pairs) : 'single'
        return {
          /* The most specific wording among the readings that agree, so the
           * owner is shown "$41.98 including tax" rather than "41.98" when both
           * were read. Every variant is kept below regardless. */
          value: [...group.claims]
            .sort((left, right) => right.value.length - left.value.length)[0].value,
          variants: [...new Set(group.claims.map((claim) => claim.value))],
          support: group.claims.map((claim) => ({
            strategy: claim.strategy,
            region: claim.surface,
            regionMode: claim.region,
            sees: claim.sees,
            how: claim.how,
            matchedLabel: claim.alias,
            locator: claim.locator,
            line: claim.line,
            quote: claim.quote,
            capsuleId: claim.capsuleId,
          })),
          voices: group.claims.length,
          regions: [...new Set(group.claims.map((claim) => claim.surface))],
          independence,
          pairs,
          mergedBy: [...group.mergedBy].map((reason) => ({ reason, means: MERGE_REASONS[reason] })),
        }
      })
      .sort(
        (left, right) =>
          right.voices - left.voices ||
          (INDEPENDENCE_RANK[right.independence] ?? -1) - (INDEPENDENCE_RANK[left.independence] ?? -1),
      )

    const verdict = verdictFor(groups, looked)

    return {
      ask: ask.name,
      labels: ask.aliases,
      verdict,
      /* A single answer is offered ONLY when the strategies agreed. Contested
       * asks answer null and hand back every reading — the caller has to look at
       * `answers` to say anything, which is the point. */
      answer: verdict === 'contested' || verdict === 'absent' ? null : (groups[0]?.value ?? null),
      answers: groups,
      independence: groups[0]?.independence ?? 'none',
      /* Absence is a finding: "the page does not say" is an answer, and which
       * strategies looked is what makes it one. */
      lookedAndMissed: lookedAndMissed.map((id) => {
        const strategy = strategies.find((candidate) => candidate.id === id)
        return { strategy: id, region: strategy?.surface ?? null, sees: strategy?.reads ?? null }
      }),
      ...(verdict === 'contested' ? { conflict: conflictKind(groups, surfaceText) } : {}),
      note: NOTE_FOR[verdict],
    }
  })

  return {
    verdicts,
    counts: {
      asks: verdicts.length,
      corroborated: verdicts.filter((entry) => entry.verdict === 'corroborated').length,
      repeated: verdicts.filter((entry) => entry.verdict === 'repeated').length,
      singleSource: verdicts.filter((entry) => entry.verdict === 'single-source').length,
      contested: verdicts.filter((entry) => entry.verdict === 'contested').length,
      absent: verdicts.filter((entry) => entry.verdict === 'absent').length,
    },
  }
}

const NOTE_FOR = Object.freeze({
  corroborated:
    'Two or more strategies read this from parts of the page that do not contain each other.',
  repeated:
    'The strategies agreed, but over the same bytes — this is one observation with several names on it, not corroboration.',
  'single-source':
    'One strategy found this and the others looked and did not. It may be right; nothing here checks it.',
  contested: 'The strategies disagreed. No answer is being chosen — both readings are below.',
  absent: 'Every strategy that could look did look, and none of them found this on the page.',
  unchecked: 'No strategy was able to read a region that could contain this.',
})

function verdictFor(groups, looked) {
  if (!looked.length) return 'unchecked'
  if (!groups.length) return 'absent'
  if (groups.length > 1) return 'contested'
  if (groups[0].voices < 2) return 'single-source'
  return groups[0].independence === 'disjoint' ? 'corroborated' : 'repeated'
}

/**
 * Whether a disagreement is the page's or ours.
 *
 * This is the distinction the owner actually wants. Two disjoint regions
 * carrying different totals means the PAGE shows two totals — worth knowing,
 * and nothing to do with us. Two extractors disagreeing over one line means our
 * reading is unreliable and the page may be perfectly clear. Reporting both as
 * "conflicting results" would bury the first inside the second.
 */
function conflictKind(groups, surfaceText) {
  const levels = []
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      for (const left of groups[i].support) {
        for (const right of groups[j].support) {
          levels.push(
            independenceBetween(
              { surface: left.region, line: left.line },
              { surface: right.region, line: right.line },
              surfaceText,
            ),
          )
        }
      }
    }
  }

  const disjoint = levels.filter((level) => level === 'disjoint').length
  if (disjoint && disjoint === levels.length) {
    return {
      kind: 'page',
      means: 'different parts of the page carry different values for this — the page itself is inconsistent, or one of them is out of date.',
    }
  }
  if (!disjoint) {
    return {
      kind: 'extraction',
      means: 'the strategies read the same text and pulled different values out of it — the disagreement is in the reading, not the page.',
    }
  }
  return {
    kind: 'mixed',
    means: 'some of the disagreement is between different parts of the page and some is between readers of the same text.',
  }
}

/* ------------------------------------------------------------- the read */

function readingFrom(result) {
  if (!result?.ok) {
    return { ok: false, error: result?.error || 'the browser returned no result for this region' }
  }
  const data = result.data ?? {}
  return {
    ok: true,
    text: String(data.content ?? ''),
    title: String(data.title ?? ''),
    url: String(data.url ?? ''),
    capsuleId: data.evidence?.capsuleId ?? null,
    contentHash: data.evidence?.contentHash ?? null,
  }
}

/* Origins already being cross-checked. Not a lock on the browser — the bridge
 * owns that — but a refusal to be the thing that queues a second run of the
 * same page behind the first, which is the one form of extra traffic this
 * module could generate all by itself. */
const inFlight = new Set()

/**
 * Read one page with every strategy and reconcile what they say.
 *
 * Partial success is normal and is not an error: a region that failed to read is
 * a strategy that did not run, and the answer says so rather than pretending the
 * remaining strategies were the plan all along.
 */
export async function crossCheckPage(request = {}, deps = {}) {
  const {
    url = '',
    question = '',
    maxChars = DEFAULT_MAX_CHARS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    secondLook = true,
    browserOnline = null,
  } = request

  const {
    address = addressPage,
    runActions = runBrowserActions,
    browserStatus = getBrowserStatus,
    clock = () => Date.now(),
    remember = rememberRun,
  } = deps

  if (!isHttpUrl(url)) {
    throw new Error(`A cross-check needs an http(s) page to read: ${String(url) || '(empty)'}`)
  }

  const { asks, derivedFrom } = normalizeAsks(request.ask ?? request.asks, question)
  const origin = new URL(url).origin
  const startedAtMs = clock()

  const online = browserOnline ?? safeOnline(browserStatus)
  if (online === false) {
    return offline({ url, origin, question, asks, derivedFrom, startedAtMs, clock })
  }

  if (inFlight.has(origin)) {
    return {
      ok: false,
      reason: 'origin-busy',
      url,
      origin,
      error:
        'Another cross-check of this origin is still running. A second one would queue behind it on the same serial browser lane and read the same page twice.',
    }
  }
  inFlight.add(origin)

  const options = {
    command: `cross-check ${new URL(url).host}`,
    source: 'cross-check',
    allow: CROSSCHECK_READ_ONLY,
    timeoutMs,
  }

  try {
    /* One navigation for every strategy. addressPage reloads by default, which
     * is what stops a tab left open since yesterday from answering instantly
     * with yesterday's page. */
    const landed = await address(url, { reload: true, options })

    const plan = [
      { key: 'main', mode: REGIONS.main.mode },
      { key: 'full', mode: REGIONS.full.mode },
      { key: 'landmarks', mode: REGIONS.landmarks.mode },
    ]

    const actions = plan.map((region) => ({
      type: 'browser_read_page',
      label: `read ${region.mode}`,
      params: { ...landed.target, mode: region.mode, maxChars },
    }))

    /* The snapshot rides in the same batch as the reads rather than being
     * fetched later, because the second look must not cost a round trip to find
     * out whether it can happen. It is asked for only when a second look is
     * allowed at all. */
    if (secondLook) {
      actions.push({
        type: 'browser_snapshot',
        label: 'controls, for a targeted second look',
        params: { ...landed.target, maxElements: 80 },
      })
    }

    const results = await runActions(actions, options)
    const reads = {}
    plan.forEach((region, index) => {
      reads[region.key] = readingFrom(results[index])
    })
    const controls = secondLook ? elementsFrom(results[plan.length]) : []

    const surfaces = buildSurfaces(reads)
    const strategies = planStrategies(surfaces)
    let claims = extractClaims({ asks, surfaces, strategies })
    let reconciled = reconcile({ asks, claims, surfaces, strategies })

    /* -------------------------------------------------- the targeted second look */
    const reReads = []
    if (secondLook && controls.length) {
      const targets = secondLookTargets(reconciled.verdicts, asks, controls)
      if (targets.length) {
        const lookActions = targets.map((target) => ({
          type: 'browser_read_page',
          label: `second look at ${target.selector}`,
          params: {
            ...landed.target,
            selector: target.selector,
            mode: 'text',
            maxChars: SELECTOR_MAX_CHARS,
          },
        }))

        const lookResults = await runActions(lookActions, options)

        targets.forEach((target, index) => {
          const read = readingFrom(lookResults[index])
          reReads.push({ ...target, ok: read.ok, error: read.ok ? null : read.error })
          if (!read.ok || !normalizeText(read.text)) return

          const id = `second-look:${target.selector}`
          surfaces.push({
            id,
            sees: `the control “${target.control}” and the text inside it`,
            raw: read.text,
            normalized: normalizeText(read.text),
            chars: read.text.length,
            mode: `selector ${target.selector}`,
            capsuleId: read.capsuleId,
            contentHash: read.contentHash,
            /* Said plainly wherever this surface appears: a subtree of what was
             * already read is not a second witness. */
            adds: 'location',
          })
          for (const extractor of [EXTRACTORS.anchor, EXTRACTORS.semantic]) {
            strategies.push({
              id: `${id}-${extractor.id}`,
              surface: id,
              extractor: extractor.id,
              reads: `the control “${target.control}”`,
              how: extractor.how,
              secondLook: true,
              why: target.why,
              /* Only ever for the ask that triggered it. A second look that
               * answered every ask would be a third full pass wearing the name
               * of a targeted one. */
              only: target.ask,
            })
          }
        })

        const extraStrategies = strategies.filter((strategy) => strategy.secondLook)
        const extraClaims = extractClaims({
          asks: asks.filter((ask) => extraStrategies.some((strategy) => strategy.only === ask.name)),
          surfaces,
          strategies: extraStrategies,
        }).filter((claim) =>
          extraStrategies.some(
            (strategy) => strategy.id === claim.strategy && strategy.only === claim.ask,
          ),
        )

        claims = [...claims, ...extraClaims]
        reconciled = reconcile({ asks, claims, surfaces, strategies })
      }
    }

    const finishedAtMs = clock()
    const run = {
      ok: true,
      runId: `crosscheck_${crypto.randomUUID()}`,
      url: landed.url || url,
      requestedUrl: url,
      origin,
      title: landed.title ?? '',
      disposition: landed.disposition,
      redirectedFrom: landed.redirectedFrom ?? null,
      question: String(question || '').slice(0, 400),
      asks: asks.map((ask) => ask.name),
      asksDerivedFrom: derivedFrom,
      observedAt: new Date(finishedAtMs).toISOString(),
      elapsedMs: finishedAtMs - startedAtMs,
      strategies: strategies.map(({ id, surface, extractor, reads, secondLook: late, why }) => ({
        id,
        region: surface,
        extractor,
        reads,
        ...(late ? { secondLook: true, why } : {}),
      })),
      regions: surfaces.map(({ id, sees, mode, chars, capsuleId, contentHash, derivedFrom: from, adds }) => ({
        id,
        sees,
        mode,
        chars,
        capsuleId,
        contentHash,
        ...(from ? { derivedFrom: from } : {}),
        ...(adds ? { adds } : {}),
      })),
      unreadable: Object.entries(reads)
        .filter(([, read]) => !read.ok)
        .map(([key, read]) => ({ region: key, mode: REGIONS[key]?.mode ?? key, error: read.error })),
      ...reconciled,
      independence: independenceReport(surfaces, strategies, reconciled.verdicts),
      traffic: trafficReport({ actions: actions.length, reReads }),
      reReads,
      capsuleIds: [...new Set(surfaces.map((surface) => surface.capsuleId).filter(Boolean))],
      degraded: degradationOf(surfaces, strategies),
      summary: describeCrossCheck({ verdicts: reconciled.verdicts, strategies }),
    }

    remember(run)
    return run
  } finally {
    inFlight.delete(origin)
  }
}

function safeOnline(browserStatus) {
  try {
    return Boolean(browserStatus()?.online)
  } catch {
    /* Unknown, not offline. A status call that throws must not turn into a
     * refusal to read a page the owner asked about. */
    return null
  }
}

function offline({ url, origin, question, asks, derivedFrom, startedAtMs, clock }) {
  return {
    ok: false,
    reason: 'browser-offline',
    url,
    origin,
    question,
    asks: asks.map((ask) => ask.name),
    asksDerivedFrom: derivedFrom,
    observedAt: new Date(clock()).toISOString(),
    elapsedMs: clock() - startedAtMs,
    error:
      'The browser extension is not connected, so this page — which needs the owner\'s session — was not read at all. Nothing here is a reading of it.',
  }
}

function elementsFrom(result) {
  const elements = result?.ok ? result.data?.elements : null
  return Array.isArray(elements) ? elements : []
}

/**
 * Which controls are worth a second, scoped read.
 *
 * Only for asks the first pass could not settle, only from the accessibility
 * snapshot that was already taken, and bounded. There is deliberately no
 * per-site selector anywhere in this function: the selector comes from a control
 * whose own accessible name carries the label the caller asked about, which is
 * the page describing itself.
 */
export function secondLookTargets(verdicts, asks, controls) {
  const targets = []
  const seen = new Set()

  for (const verdict of verdicts) {
    if (verdict.verdict !== 'contested' && verdict.verdict !== 'single-source') continue
    const ask = asks.find((candidate) => candidate.name === verdict.ask)
    if (!ask) continue

    const needles = [
      ...ask.aliases.map((alias) => alias.toLowerCase()),
      ...verdict.answers.flatMap((group) => group.variants.map((value) => value.toLowerCase())),
    ].filter((needle) => needle.length >= 3)

    for (const control of controls) {
      if (targets.length >= SECOND_LOOK_LIMIT) return targets
      const name = String(control?.name ?? '').toLowerCase()
      const selector = String(control?.selector ?? '').trim()
      if (!selector || !name) continue
      if (seen.has(selector)) continue
      if (!needles.some((needle) => name.includes(needle))) continue

      seen.add(selector)
      targets.push({
        ask: verdict.ask,
        selector: selector.slice(0, 200),
        control: String(control.name).slice(0, 120),
        why:
          verdict.verdict === 'contested'
            ? 'the first pass came back with two different values, so this re-reads the one control that carries the label'
            : 'only one strategy found this, so this re-reads the control that carries the label to see whether anything else does',
      })
    }
  }

  return targets
}

/**
 * What independence this run actually achieved — the honest version.
 *
 * Written as a claim about pairs of regions rather than a number, because the
 * number would be read as confidence and there is nothing here that measures
 * confidence. `achieved` answers one question: was there any pair of strategies
 * whose readings did not come from each other's bytes?
 */
function independenceReport(surfaces, strategies, verdicts) {
  const regionIds = surfaces.map((surface) => surface.id)
  const disjointPairs = verdicts.flatMap((verdict) =>
    verdict.answers.flatMap((group) =>
      (group.pairs ?? []).filter((pair) => pair.independence === 'disjoint'),
    ),
  )

  const achieved = !strategies.length
    ? 'none'
    : disjointPairs.length
      ? 'region-disjoint'
      : regionIds.length > 1
        ? 'regions-read-but-nothing-corroborated'
        : 'method-only'

  return {
    achieved,
    fetches: 1,
    regionsRead: regionIds,
    strategies: strategies.length,
    note: INDEPENDENCE_NOTE,
    detail: {
      'region-disjoint':
        'At least one answer was read from two parts of the page that do not contain each other. That is the strongest thing this design can offer, and it is still one fetch.',
      'regions-read-but-nothing-corroborated':
        'Several regions were read, but no answer was found in two of them that do not overlap. Agreement in this run is agreement over shared text.',
      'method-only':
        'Only one region could be read, so the strategies differ in extraction method alone. They share every byte and can be wrong together.',
      none: 'No strategy ran.',
    }[achieved],
  }
}

function trafficReport({ actions, reReads }) {
  return {
    navigations: 1,
    batches: reReads.length ? 2 : 1,
    browserActions: actions + reReads.length,
    reReads: reReads.length,
    note: reReads.length
      ? `One navigation and one batched read per region; ${reReads.length} extra scoped read(s) were taken because the first pass could not settle an ask, and each one says why.`
      : 'One navigation and one batched read per region. The strategies are parallel over that one read, not parallel fetches.',
  }
}

function degradationOf(surfaces, strategies) {
  if (!strategies.length) {
    return {
      degraded: true,
      because: 'no region of the page could be read, so nothing was cross-checked.',
    }
  }
  if (surfaces.length === 1) {
    return {
      degraded: true,
      because: `only ${surfaces[0].id} could be read, so every answer here rests on one region and the strategies differ only in how they picked the value out of it.`,
    }
  }
  return { degraded: false, because: null }
}

/** One line the pendant can say, with the disagreements still in it. */
export function describeCrossCheck({ verdicts = [], strategies = [] } = {}) {
  if (!verdicts.length) return 'Nothing was asked of the page.'
  if (!strategies.length) return 'The page could not be read, so nothing was checked.'

  const parts = verdicts.map((verdict) => {
    if (verdict.verdict === 'unchecked') {
      return `${verdict.ask}: nothing could read a region that might contain it.`
    }
    if (verdict.verdict === 'contested') {
      const readings = verdict.answers
        .map((group) => `${group.regions.join(' and ')} reads ${group.value}`)
        .join(', but ')
      return `${verdict.ask}: ${readings} — I am not picking one${
        verdict.conflict?.kind === 'page' ? ', and those are different parts of the page' : ''
      }.`
    }
    if (verdict.verdict === 'absent') {
      return `${verdict.ask}: not on the page — ${verdict.lookedAndMissed.length} strateg${
        verdict.lookedAndMissed.length === 1 ? 'y' : 'ies'
      } looked and none found it.`
    }
    if (verdict.verdict === 'single-source') {
      return `${verdict.ask}: ${verdict.answer}, from ${verdict.answers[0].support[0].region} only — nothing else confirmed it.`
    }
    if (verdict.verdict === 'repeated') {
      return `${verdict.ask}: ${verdict.answer}, agreed by ${verdict.answers[0].voices} readings of the same text.`
    }
    return `${verdict.ask}: ${verdict.answer}, read separately from ${verdict.answers[0].regions.join(' and ')}.`
  })

  return parts.join(' ')
}

/* -------------------------------------------------------------- recent runs */

const RUNS = new Map()

function rememberRun(run) {
  RUNS.set(run.runId, run)
  while (RUNS.size > MAX_RUNS_KEPT) RUNS.delete(RUNS.keys().next().value)
  return run
}

export function getCrossCheck(runId) {
  return RUNS.get(runId) ?? null
}

export function listCrossChecks({ limit = 10 } = {}) {
  return [...RUNS.values()].slice(-Math.max(1, limit)).reverse()
}

/* Tests own their own history rather than inheriting whatever ran before. */
export function clearCrossChecks() {
  RUNS.clear()
}

/* ------------------------------------------------------------------ routes */

/**
 * Wire this feature onto an app.
 *
 * A register function rather than routes in server.js, for the reason
 * pageWatchRoutes.js gives: server.js is edited by several people at once, and a
 * feature that owns its routes is one line there.
 *
 * There is no route here that acts on a page. POST reads and reconciles; the two
 * GETs return what an earlier read said.
 */
export function registerCrossCheckRoutes(app, { basePath = '/crosscheck', deps = {} } = {}) {
  const routes = []
  const add = (method, routePath, handler) => {
    app[method](routePath, handler)
    routes.push(`${method.toUpperCase()} ${routePath}`)
  }

  add('post', basePath, async (request, response) => {
    try {
      const run = await crossCheckPage(request.body || {}, deps)
      response.status(run.ok ? 200 : 409).json(run)
    } catch (error) {
      response.status(400).json({ ok: false, error: String(error?.message || error) })
    }
  })

  add('get', basePath, (request, response) => {
    response.json({
      ok: true,
      runs: listCrossChecks({ limit: Number(request.query?.limit) || 10 }),
      note: INDEPENDENCE_NOTE,
    })
  })

  add('get', `${basePath}/:runId`, (request, response) => {
    const run = getCrossCheck(request.params.runId)
    if (!run) {
      response.status(404).json({ ok: false, error: 'No such cross-check.' })
      return
    }
    response.json({ ok: true, run })
  })

  return routes
}
