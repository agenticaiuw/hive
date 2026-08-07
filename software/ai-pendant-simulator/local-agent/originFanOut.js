import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import {
  addressPage,
  excerptAround,
  isHttpUrl,
  normalizeText,
  readPageText,
} from './browserPage.js'
import { BrowserOfflineError, classifyBrowserError } from './browserSessions.js'
import { workspacePath } from './config.js'
import {
  getCapsule,
  mintCapsule,
  normalizeSource,
  presentCapsule,
  redactionMapFor,
} from './evidenceCapsules.js'

/*
 * Read several of the owner's authenticated origins for one question, and say
 * how old each answer is.
 *
 * Everything that reads a page in this repo reads exactly one URL:
 * pageWatch.createWatch, formFill.fillForm and browserPage.addressPage all take
 * a single `url`. So "check my calendar, my task board and my reservations"
 * is three unrelated jobs with nothing that merges them, which is why a pile of
 * ledger entries all stalled on the same sentence. This is the missing fan-out.
 *
 * WHY THE AGE IS THE POINT. The thing downstream of this is a correction: the
 * owner says "it renews next month" and the account page says Tuesday. A cached
 * page from three weeks ago that says Tuesday is not evidence, and a correction
 * built on it is worse than silence — it teaches the owner to stop listening.
 * So every result carries when it was actually fetched, the batch is only as
 * fresh as its stalest member, and selectFresh() lets a caller throw away
 * evidence that has since aged out. Staleness is judged on read, never baked in
 * at write time, because a batch is usually consulted later than it was taken.
 *
 * TWO CLOCKS, DELIBERATELY. `observedAt` is when this fan-out went and looked.
 * `firstSeenAt` is when the capsule store first saw this exact content, which
 * can be much earlier: capsules are content-addressed, so an unchanged page
 * re-read now collapses onto the capsule minted three weeks ago. Both are true
 * and they answer different questions — "did we check recently" (freshness, the
 * one that gates a correction) and "how long has this been saying the same
 * thing" (corroboration, which gets *stronger* with age). Reporting only the
 * capsule's time would call a reading taken one second ago three weeks stale.
 *
 * READ-ONLY, STRUCTURALLY. FANOUT_READ_ONLY is handed to every browser call, and
 * runBrowserActions throws on anything outside it before the request is built.
 * click, type, select and press_key are unreachable from this file rather than
 * merely absent from it — the same construction browserInspect.js and
 * pageWatch.js use. Nothing here prompts, gates, or asks for confirmation.
 *
 * PROVENANCE IS NOT REBUILT HERE. Results carry evidence capsule ids and quote
 * page text; the bodies live in evidenceCapsules.js, which already does
 * redaction, TTL and revocation. This module mints for the relay path (that page
 * text does reach this process) and reuses the capsule computerControl minted
 * for the Safari path. There is deliberately no second store of page content.
 */

/* The whole vocabulary of a fan-out. navigate is a GET of the page the owner
 * named — what ⌘R does — and is the only way a re-read ever sees new content.
 * Same three verbs pageWatch.js allows itself, and no snapshot: this layer
 * reads text for evidence and never needs an element ref to act on. */
export const FANOUT_READ_ONLY = new Set(['list_tabs', 'navigate', 'read_page'])

/*
 * The Safari lane is serial because the transport is. The extension's poll loop
 * (background.js pollWindow) awaits one command, posts its result, then polls
 * again — one command in flight, ever. Running four origins "concurrently"
 * would leave three of them queued behind the first with their per-origin
 * deadlines already ticking, turning a slow page into three spurious timeouts.
 * The lanes below run concurrently with each other; within a lane the bound is
 * what the resource can actually do.
 */
const SAFARI_LANE_LIMIT = 1

/*
 * Cloudflare Browser Run, free tier: 10 browser-minutes a day and one action
 * every ten seconds. Concurrency there does not buy throughput, it buys 429s,
 * so the relay lane is serial and paced. The daily spend is tracked across
 * calls — a per-batch counter would reset on every question and the budget
 * would be fiction.
 */
const RELAY_LANE_LIMIT = 1
export const RELAY_MIN_INTERVAL_MS = 10_000
export const RELAY_DAILY_BUDGET_MS = 10 * 60_000

/* One extension lease. Waiting longer cannot help: browserBridge reclaims the
 * command at 45s and the extension has already stopped working on it. */
const DEFAULT_PER_ORIGIN_TIMEOUT_MS = 45_000

/* A serial lane means the worst case is origins × timeout, so the batch needs
 * its own ceiling or one wedged origin still costs everything behind it the
 * wall clock. Past this, remaining origins are reported as skipped rather than
 * attempted — a named skip is information, a silent stall is not. */
const DEFAULT_BATCH_BUDGET_MS = 180_000

/* Evidence for an in-the-moment correction. Generous enough that a briefing
 * assembled over a couple of minutes is all one batch, short enough that
 * yesterday's reading can never be spoken as current. */
const DEFAULT_MAX_AGE_MS = 15 * 60_000

const MAX_ORIGINS = 12
const MAX_LOOK_TERMS = 8
const PREVIEW_CHARS = 400
const EXCERPT_RADIUS = 110

/* ------------------------------------------------------------ relay budget */

export function relayBudgetLocation() {
  return (
    process.env.PENDANT_RELAY_BUDGET_PATH ||
    path.join(workspacePath, '.pendant-relay-browser-budget.json')
  )
}

const isValidBudget = (value) => value && typeof value.day === 'string'

const utcDay = (now) => new Date(now).toISOString().slice(0, 10)

/**
 * What the relay browser has spent today, in the day's own terms.
 *
 * Cloudflare's quota is a calendar-day bucket, so the stored row is discarded
 * rather than migrated when the day rolls over.
 */
export function readRelayBudget({ now = Date.now(), filePath = relayBudgetLocation() } = {}) {
  const empty = { day: utcDay(now), browserMs: 0, actions: 0, lastActionAt: 0 }
  ensureJsonStore(filePath, empty, { validate: isValidBudget })
  const stored = readJsonWithRecovery(filePath, {
    fallback: empty,
    validate: isValidBudget,
  })
  if (stored.day !== empty.day) return empty
  return {
    day: stored.day,
    browserMs: Number(stored.browserMs) || 0,
    actions: Number(stored.actions) || 0,
    lastActionAt: Number(stored.lastActionAt) || 0,
  }
}

function noteRelayUse({ browserMs = 0, now = Date.now(), filePath }) {
  const current = readRelayBudget({ now, filePath })
  const next = {
    day: current.day,
    /* Cloudflare bills a page load whether or not it answered, so a failed
     * action still spends. Counting only successes would let a run of timeouts
     * blow the daily quota while the tally read zero. */
    browserMs: current.browserMs + Math.max(0, Number(browserMs) || 0),
    actions: current.actions + 1,
    lastActionAt: now,
  }
  writeJsonAtomic(filePath, next, { validate: isValidBudget })
  return next
}

export function relayBudgetRemainingMs({ now = Date.now(), filePath } = {}) {
  return Math.max(0, RELAY_DAILY_BUDGET_MS - readRelayBudget({ now, filePath }).browserMs)
}

/* ---------------------------------------------------------------- requests */

/**
 * The origins to read, in the shape the caller described them.
 *
 * `auth` is the routing input that matters and it defaults to 'owner': this is
 * the authenticated read layer, and guessing "public" for a page that turns out
 * to need a session wastes a Browser Run action to learn what the caller
 * already knew.
 */
export function normalizeOrigins(input) {
  const list = (Array.isArray(input) ? input : [input])
    .map((raw) => (typeof raw === 'string' ? { url: raw } : raw))
    .filter((raw) => raw && typeof raw === 'object')

  if (!list.length) throw new Error('A fan-out needs at least one origin to read.')

  return list.slice(0, MAX_ORIGINS).map((raw, index) => {
    const url = String(raw.url ?? '').trim()
    if (!isHttpUrl(url)) {
      throw new Error(`Origin ${index + 1} is not an http(s) page: ${url || '(empty)'}`)
    }
    const source = normalizeSource(url)
    const auth = raw.auth === 'public' ? 'public' : 'owner'
    const backend = ['safari', 'relay'].includes(raw.backend) ? raw.backend : 'auto'

    return {
      url,
      /* The origin, not the full URL, is what a caller groups results by, and
       * two pages of the same account belong together. `origin` and `host` are
       * the display-safe halves of normalizeSource; its `key` is lowercased and
       * query-stripped for comparison only, so it is deliberately not carried
       * here where a caller would be tempted to print it. */
      origin: source.origin ?? url,
      name: String(raw.name || source.host || url).slice(0, 120),
      auth,
      backend,
      readMode: String(raw.readMode || 'main_text'),
      selector: raw.selector ? String(raw.selector).slice(0, 200) : null,
      look: []
        .concat(raw.look ?? raw.terms ?? [])
        .map((term) => String(term).trim())
        .filter(Boolean)
        .slice(0, MAX_LOOK_TERMS),
      maxChars: Number(raw.maxChars) > 0 ? Math.min(Number(raw.maxChars), 20_000) : 12_000,
    }
  })
}

/* ----------------------------------------------------------------- routing */

/**
 * Which browser can answer for this origin, and why that one.
 *
 * Two backends have existed side by side with nothing choosing between them.
 * The choice is not a preference: only the owner's Safari holds their sessions,
 * and only the relay is awake when the Mac is not. Everything else follows from
 * those two facts, so every branch below names which one it is standing on.
 */
export function chooseBackend(
  entry,
  { safariUp = true, relayReady = false, relayBudgetMs = RELAY_DAILY_BUDGET_MS, publicUrlCheck } = {},
) {
  const reachableByRelay = publicUrlCheck ? publicUrlCheck(entry.url) : { ok: false }
  const relayUsable = relayReady && reachableByRelay.ok && relayBudgetMs > 0

  const relayBlockedBecause = !relayReady
    ? 'Browser Run is not configured for this process'
    : !reachableByRelay.ok
      ? reachableByRelay.error || 'the relay browser cannot reach that address'
      : relayBudgetMs > 0
        ? null
        : "today's Browser Run minutes are spent"

  if (entry.backend === 'safari') {
    return safariUp
      ? { backend: 'safari', reason: 'the caller asked for the owner\'s browser' }
      : { backend: null, reason: `Safari was asked for by name but is not answering` }
  }

  if (entry.backend === 'relay') {
    if (!relayUsable) {
      return { backend: null, reason: `the relay browser was asked for by name but ${relayBlockedBecause}` }
    }
    return {
      backend: 'relay',
      /* Asked for by name over an owner-private page. Honoured — nothing here
       * refuses the caller — but flagged all the way down to the result, so a
       * login wall cannot be read back later as the owner's own record. */
      degraded: entry.auth === 'owner',
      reason:
        entry.auth === 'owner'
          ? 'the caller asked for the relay browser, which has none of the owner\'s sessions'
          : 'the caller asked for the relay browser',
    }
  }

  if (entry.auth === 'owner') {
    if (safariUp) {
      return {
        backend: 'safari',
        reason: 'the owner\'s sessions exist only in their own Safari',
      }
    }
    /*
     * Safari is down and this page needs a login the relay will never have.
     *
     * The relay is deliberately NOT tried here, even when it is sitting idle.
     * It cannot answer this question by construction — a datacentre Chrome
     * holds none of the owner's cookies — so the best case is spending one of
     * ten daily browser-minutes to be shown a login wall, and doing that across
     * a morning's origins exhausts the budget before the public-fact leg, which
     * the relay genuinely can answer, ever gets a turn. A caller who wants it
     * attempted anyway can say backend:'relay' and gets it, degraded and
     * flagged. What must never happen is a relay reading being mistaken for the
     * owner's authenticated record: nothing on that path can support a
     * correction, so silence is the honest output.
     */
    return {
      backend: null,
      reason: relayUsable
        ? 'Safari is not answering, and the relay browser has none of the owner\'s sessions, so it cannot check this page'
        : `Safari is not answering and ${relayBlockedBecause}`,
    }
  }

  if (relayUsable) {
    return {
      backend: 'relay',
      reason: 'a public page, so the relay reads it without waking the Mac',
    }
  }
  if (safariUp) {
    return { backend: 'safari', reason: `a public page, but ${relayBlockedBecause}` }
  }
  return { backend: null, reason: `Safari is not answering and ${relayBlockedBecause}` }
}

/* --------------------------------------------------------------- machinery */

/** Bounded worker pool that preserves input order and never rejects. */
async function runPool(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))

  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        out[index] = await worker(items[index], index)
      }
    }),
  )

  return out
}

/**
 * Give up on one origin without giving up on the batch.
 *
 * The abandoned work is not cancellable — an extension command already sent is
 * already sent — so it is left to finish into nothing, with its rejection
 * swallowed rather than surfacing as an unhandled crash minutes later.
 */
async function withDeadline(run, ms, onTimeout) {
  let timer = null
  const work = run().catch((error) => ({ __error: error }))
  work.catch(() => {})

  /* Deliberately not unref'd. A hung origin leaves nothing else pending, so an
   * unref'd deadline lets the process fall out from under its own timeout — the
   * batch never finishes and never fails. It is cleared the moment the race
   * settles, so it holds the loop open for no longer than the timeout itself. */
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), Math.max(1, ms))
  })

  const winner = await Promise.race([work, expiry])
  clearTimeout(timer)

  if (winner?.__timedOut) return onTimeout()
  if (winner?.__error) throw winner.__error
  return winner
}

/* Our own per-origin deadline should be the one that fires, because its message
 * names the origin and the limit. The fetch abort inside runBrowserActions stays
 * a couple of seconds behind it as a backstop, so the socket still closes rather
 * than leaking while a wedged /execute waits out its 45s extension lease. */
const FETCH_GRACE_MS = 2_000

const TIMED_OUT =
  /aborted due to timeout|did not respond in time|did not answer within|The operation was aborted/i

/** Every way "this took too long" reaches us, under one name. */
function isTimeout(error) {
  if (error?.reason === 'timeout') return true
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true
  return TIMED_OUT.test(String(error?.message ?? error ?? ''))
}

/*
 * A failure that means the lane itself is gone, not that this page is bad.
 *
 * classifyBrowserError re-derives the extension's condition from the message,
 * because the class is lost crossing /execute as JSON. The extra pattern is for
 * the case it cannot see: the local agent process not being there at all, which
 * arrives as a bare fetch failure and is just as fatal to every origin behind it.
 *
 * A timeout is deliberately NOT in here. It is genuinely ambiguous — one slow
 * page looks exactly like a dead extension from this side — so it is handled as
 * a soft signal by the caller instead of condemning the lane on first sight.
 */
function isLaneDown(error) {
  if (isTimeout(error)) return false
  if (classifyBrowserError(error) instanceof BrowserOfflineError) return true
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|refused the browser batch/i.test(
    String(error?.message ?? error ?? ''),
  )
}

/*
 * How many timeouts in a row before a lane is written off.
 *
 * Measured, not guessed: with the extension offline, a three-origin batch spent
 * 24s discovering the same thing three times, because each origin waited out its
 * own deadline. One timeout is a page — pages do hang. Two in a row on a
 * transport that only ever runs one command at a time is the transport, and
 * every origin behind it will pay the same wait to learn nothing. Skipping them
 * says so out loud, which is information; making the caller wait is not.
 */
const LANE_TIMEOUT_TOLERANCE = 2

/* ------------------------------------------------------------------ reading */

/** Quotes for what the caller came to check, plus a bounded, redacted preview. */
function evidenceFrom(text, look) {
  const clean = normalizeText(text)
  const matches = look.map((term) => {
    const quote = excerptAround(clean, term, EXCERPT_RADIUS)
    const found = Boolean(quote) && quote.toLowerCase().includes(term.toLowerCase())
    return {
      term,
      found,
      /* A term that is not on the page is a finding, not an omission: "the
       * account page does not mention a renewal" is an answer. */
      quote: found ? redactionMapFor(quote).content : null,
      locator: found ? `page text contains “${term}”` : `no occurrence of “${term}”`,
    }
  })

  const preview = redactionMapFor(clean.slice(0, PREVIEW_CHARS))

  return {
    matches,
    preview: preview.content,
    /* Counted, not just applied, so a caller can see that something was held
     * back rather than wondering why a quote reads oddly. */
    redaction: { counts: preview.counts, classification: preview.classification },
    chars: clean.length,
  }
}

/**
 * The capsule this reading collapsed onto, if the store kept one.
 *
 * Looked up rather than assumed: a capsule whose TTL has passed or whose source
 * the owner revoked must not be quoted as current, and presentCapsule is the one
 * place that decides.
 */
function capsuleFacts(capsuleId, observedAtMs, { capsule = getCapsule, now }) {
  if (!capsuleId) return { capsuleId: null, firstSeenAt: null, unchangedForMs: null }
  const stored = capsule(capsuleId)
  const shown = presentCapsule(stored, { now })
  if (!shown) return { capsuleId, firstSeenAt: null, unchangedForMs: null }

  const firstSeen = Date.parse(shown.capturedAt)
  return {
    capsuleId,
    firstSeenAt: shown.capturedAt,
    /* Content-addressed capsules collapse, so this is how long the page has
     * been saying the same thing. Corroboration, not freshness — see the note
     * about two clocks at the top of the file. */
    unchangedForMs: Number.isFinite(firstSeen) ? Math.max(0, observedAtMs - firstSeen) : null,
    evidenceState: shown.state,
    evidenceUsable: shown.usable,
    confidence: shown.confidence ?? null,
  }
}

async function readViaSafari(entry, { deadlineAt, clock, address, readText, capsule }) {
  const remaining = () => Math.max(1_000, deadlineAt - clock()) + FETCH_GRACE_MS
  const options = {
    command: `read ${entry.name}`,
    source: 'origin-fanout',
    allow: FANOUT_READ_ONLY,
    timeoutMs: remaining(),
  }

  /* Always a re-fetch. A tab left open since yesterday answers instantly with
   * yesterday's page, and stamping that "read just now" is exactly the lie this
   * layer exists to prevent. */
  const landed = await address(entry.url, { reload: true, options })
  const page = await readText(landed.target, {
    mode: entry.readMode,
    selector: entry.selector,
    maxChars: entry.maxChars,
    options: { ...options, timeoutMs: remaining() },
  })

  const observedAtMs = clock()
  const text = String(page.content ?? '')

  return {
    observedAtMs,
    url: page.url || landed.url || entry.url,
    title: page.title || landed.title || '',
    disposition: landed.disposition,
    redirectedFrom: landed.redirectedFrom ?? null,
    authenticated: true,
    evidence: evidenceFrom(text, entry.look),
    ...capsuleFacts(page.capsuleId, observedAtMs, { capsule, now: observedAtMs }),
  }
}

async function readViaRelay(
  entry,
  { deadlineAt, clock, sleep, relay, budgetPath, degraded },
) {
  const budget = readRelayBudget({ now: clock(), filePath: budgetPath })

  /* One action per ten seconds, so wait out the gap rather than spending an
   * action to be told 429. If the wait does not fit inside what is left, that
   * is a skip with a reason, not a stall. */
  const waitMs = Math.max(0, RELAY_MIN_INTERVAL_MS - (clock() - budget.lastActionAt))
  if (waitMs > 0) {
    if (clock() + waitMs >= deadlineAt) {
      const error = new Error(
        `the relay browser allows one page every ${RELAY_MIN_INTERVAL_MS / 1000}s and the wait did not fit in this batch`,
      )
      error.reason = 'rate-limit-wait'
      throw error
    }
    await sleep(waitMs)
  }

  const result = await relay.readPublicPage(entry.url, {
    maxChars: entry.maxChars,
    /* Absorb one retry-after when there is room. A background fan-out has the
     * time; the caller's batch budget is what decides whether it does. */
    maxRateLimitWaitMs: Math.max(0, Math.min(RELAY_MIN_INTERVAL_MS + 1_000, deadlineAt - clock())),
  })

  noteRelayUse({ browserMs: result?.browserMs ?? 0, now: clock(), filePath: budgetPath })

  if (!result?.ok) {
    const error = new Error(result?.error || 'the relay browser could not read that page')
    error.reason = result?.reason ?? 'relay-failed'
    error.hint = result?.hint ?? null
    throw error
  }

  const observedAtMs = clock()
  const text = String(result.text ?? '')

  /*
   * Mint here rather than in serverBrowser.js. That module runs on the relay,
   * where this store does not exist, and evidenceCapsules.js says so; but this
   * call was made from the Mac, so the page text is in this process and there is
   * no reason for it to be the one browser reading with no provenance.
   */
  let capsuleId = null
  try {
    capsuleId = mintCapsule({
      url: result.url || entry.url,
      title: result.title ?? '',
      region: { kind: result.action || 'markdown' },
      content: text,
      context: 'cloudflare-browser-run',
      requestedUrl: entry.url,
      truncated: Boolean(result.truncated),
    }).capsuleId
  } catch {
    /* Provenance is a camera, never a gate: a store that will not write must
     * not turn a page the owner asked for into an error. */
  }

  return {
    observedAtMs,
    url: result.url || entry.url,
    title: result.title ?? '',
    disposition: 'fetched',
    /* Never true on this path, and stated rather than omitted: the relay's
     * Chrome holds none of the owner's cookies, so nothing it returns is the
     * owner's private record even when the page looks right. */
    authenticated: false,
    degraded: Boolean(degraded),
    likelyLoginWall: Boolean(result.likelyLoginWall),
    untrusted: true,
    browserMs: result.browserMs ?? 0,
    evidence: evidenceFrom(text, entry.look),
    ...capsuleFacts(capsuleId, observedAtMs, { now: observedAtMs }),
  }
}

/* --------------------------------------------------------------- the batch */

/**
 * Read every origin for one question and report each one separately.
 *
 * Partial success is the normal outcome, not an error path: one origin behind a
 * dead load balancer must not cost the caller the four that answered. Every
 * origin ends up in exactly one of ok / failed / skipped, and a failure says
 * which backend it was on and what went wrong in words the pendant can speak.
 */
export async function readOrigins(request = {}, deps = {}) {
  const {
    question = '',
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    perOriginTimeoutMs = DEFAULT_PER_ORIGIN_TIMEOUT_MS,
    budgetMs = DEFAULT_BATCH_BUDGET_MS,
    /* An optional hint from a caller that already holds it (the agent process
     * does). Unknown is the safe default: the lane's health is then learned
     * from the first origin rather than assumed either way. */
    browserOnline = null,
  } = request

  const {
    address = addressPage,
    readText = readPageText,
    capsule = getCapsule,
    relay = null,
    loadRelay = defaultRelayModule,
    clock = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    budgetPath = relayBudgetLocation(),
  } = deps

  const origins = normalizeOrigins(request.origins ?? request.urls ?? [])
  const startedAtMs = clock()
  const batchDeadline = startedAtMs + Math.max(1_000, budgetMs)
  const relayModule = relay ?? (await loadRelay())

  const routed = origins.map((entry) => ({
    entry,
    route: chooseBackend(entry, {
      safariUp: browserOnline !== false,
      relayReady: Boolean(relayModule?.readPublicPage),
      relayBudgetMs: relayModule ? relayBudgetRemainingMs({ now: startedAtMs, filePath: budgetPath }) : 0,
      publicUrlCheck: relayModule?.normalizePublicUrl,
    }),
  }))

  /*
   * Learned once, shared by the rest of the lane. When the extension is not
   * there, the first origin finds out in one timeout and the others are told
   * immediately instead of each paying the same wait — which is what keeps a
   * dead transport from costing origins × timeout.
   */
  const lanes = {
    safari: { down: false, why: null, timeouts: 0 },
    relay: { down: false, why: null, timeouts: 0 },
  }

  const runOne = async ({ entry, route }) => {
    const base = {
      name: entry.name,
      origin: entry.origin,
      url: entry.url,
      requestedUrl: entry.url,
      backend: route.backend,
      backendReason: route.reason,
    }

    if (!route.backend) {
      return { ...base, ok: false, skipped: true, reason: 'no-backend', error: route.reason }
    }
    const lane = lanes[route.backend]
    if (lane.down) {
      return { ...base, ok: false, skipped: true, reason: 'backend-down', error: lane.why }
    }
    if (clock() >= batchDeadline) {
      return {
        ...base,
        ok: false,
        skipped: true,
        reason: 'batch-budget-spent',
        error: `the batch ran out of its ${Math.round(budgetMs / 1000)}s budget before this origin was reached`,
      }
    }

    const deadlineAt = Math.min(clock() + perOriginTimeoutMs, batchDeadline)

    try {
      const read = await withDeadline(
        () =>
          route.backend === 'safari'
            ? readViaSafari(entry, { deadlineAt, clock, address, readText, capsule })
            : readViaRelay(entry, {
                deadlineAt,
                clock,
                sleep,
                relay: relayModule,
                budgetPath,
                degraded: route.degraded,
              }),
        Math.max(1, deadlineAt - clock()),
        () => {
          const error = new Error(
            `${entry.name} did not answer within ${Math.round(perOriginTimeoutMs / 1000)}s`,
          )
          error.reason = 'timeout'
          throw error
        },
      )

      /* A page that answered proves the lane is alive, so earlier slowness
       * stops counting toward writing it off. */
      lane.timeouts = 0
      const { observedAtMs, evidence, ...rest } = read
      return {
        ...base,
        ok: true,
        ...rest,
        ...evidence,
        observedAt: new Date(observedAtMs).toISOString(),
        observedAtMs,
      }
    } catch (error) {
      const timedOut = isTimeout(error)
      /* Whatever layer noticed first — our deadline, the fetch abort, the
       * extension lease — the caller is told one thing. */
      const reason = timedOut ? 'timeout' : (error?.reason ?? 'read-failed')

      if (isLaneDown(error)) {
        lane.down = true
        lane.why = String(error?.message ?? error)
      } else if (timedOut) {
        lane.timeouts += 1
        if (lane.timeouts >= LANE_TIMEOUT_TOLERANCE) {
          lane.down = true
          lane.why = `${lane.timeouts} origins in a row timed out on this browser, so the rest were not attempted`
        }
      }

      return {
        ...base,
        ok: false,
        reason,
        error: String(error?.message ?? error),
        hint: error?.hint ?? null,
      }
    }
  }

  const safariWork = routed.filter((item) => item.route.backend !== 'relay')
  const relayWork = routed.filter((item) => item.route.backend === 'relay')

  /* The two lanes are genuinely independent hardware — the owner's Safari and a
   * datacentre Chrome — so they overlap even though neither is parallel inside
   * itself. */
  const [safariResults, relayResults] = await Promise.all([
    runPool(safariWork, SAFARI_LANE_LIMIT, runOne),
    runPool(relayWork, RELAY_LANE_LIMIT, runOne),
  ])

  const byUrl = new Map()
  for (const result of [...safariResults, ...relayResults]) byUrl.set(result.url, result)
  const results = origins.map((entry) => byUrl.get(entry.url)).filter(Boolean)

  const finishedAtMs = clock()
  return summarize({
    question: String(question || '').slice(0, 400),
    results,
    maxAgeMs,
    startedAtMs,
    finishedAtMs,
    budgetMs,
    perOriginTimeoutMs,
    relayBudget: readRelayBudget({ now: finishedAtMs, filePath: budgetPath }),
  })
}

function summarize({
  question,
  results,
  maxAgeMs,
  startedAtMs,
  finishedAtMs,
  budgetMs,
  perOriginTimeoutMs,
  relayBudget,
}) {
  const { fresh, stale } = selectFresh({ results }, { maxAgeMs, now: finishedAtMs })
  const failed = results.filter((result) => !result.ok && !result.skipped)
  const skipped = results.filter((result) => result.skipped)

  /* The batch is exactly as fresh as its oldest usable reading. Reporting the
   * newest would let one just-fetched page vouch for four that were not. */
  const oldest = fresh.reduce(
    (worst, result) => (worst === null ? result.observedAtMs : Math.min(worst, result.observedAtMs)),
    null,
  )

  return {
    ok: true,
    question,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    elapsedMs: finishedAtMs - startedAtMs,
    /* Judged again on every read, never frozen here: a batch consulted an hour
     * from now is an hour older, and nothing should have to remember to re-run
     * a sweep for that to be true. */
    freshness: {
      maxAgeMs,
      freshAsOf: oldest === null ? null : new Date(oldest).toISOString(),
      oldestUsableAgeMs: oldest === null ? null : finishedAtMs - oldest,
      note: 'Ages are measured from observedAt — when this batch fetched the page — not from the capsule, which records when the same content was first seen.',
    },
    limits: { perOriginTimeoutMs, budgetMs },
    relayBudget: {
      ...relayBudget,
      dailyLimitMs: RELAY_DAILY_BUDGET_MS,
      remainingMs: Math.max(0, RELAY_DAILY_BUDGET_MS - relayBudget.browserMs),
      minIntervalMs: RELAY_MIN_INTERVAL_MS,
    },
    counts: {
      requested: results.length,
      ok: results.filter((result) => result.ok).length,
      fresh: fresh.length,
      stale: stale.length,
      failed: failed.length,
      skipped: skipped.length,
      authenticated: results.filter((result) => result.ok && result.authenticated).length,
    },
    results,
    fresh,
    stale,
    failed,
    skipped,
    capsuleIds: [...new Set(results.map((result) => result.capsuleId).filter(Boolean))],
    summary: describeBatch({ results, fresh, stale, failed, skipped }),
  }
}

/**
 * Split readings into what may still be leaned on and what has aged out.
 *
 * Exported and re-derived rather than read off a stored flag, because the whole
 * point is that a result gets less usable as it sits. A caller holding a batch
 * from earlier calls this again with the current clock and gets the truth now.
 */
export function selectFresh(batch, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const results = Array.isArray(batch) ? batch : (batch?.results ?? [])
  const fresh = []
  const stale = []

  for (const result of results) {
    if (!result?.ok) continue
    const observed = Number.isFinite(result.observedAtMs)
      ? result.observedAtMs
      : Date.parse(result.observedAt ?? '')
    const ageMs = Number.isFinite(observed) ? now - observed : null

    const aged = { ...result, ageMs }
    /* Evidence the capsule store has since expired or the owner revoked is
     * stale regardless of the clock — it can no longer be quoted at all. */
    const withdrawn = aged.evidenceUsable === false
    if (ageMs === null || ageMs > maxAgeMs || withdrawn) {
      stale.push({
        ...aged,
        staleBecause: withdrawn
          ? `the evidence for this reading is ${aged.evidenceState}`
          : ageMs === null
            ? 'the reading carries no observation time'
            : `read ${Math.round(ageMs / 1000)}s ago, older than the ${Math.round(maxAgeMs / 1000)}s this caller accepts`,
      })
      continue
    }
    fresh.push(aged)
  }

  return { fresh, stale }
}

/** One line the pendant can say, including what it could not see. */
export function describeBatch({ results = [], fresh = [], stale = [], failed = [], skipped = [] }) {
  if (!results.length) return 'Nothing was asked for.'

  const parts = []
  for (const result of fresh) {
    const hits = (result.matches ?? []).filter((match) => match.found)
    parts.push(
      hits.length
        ? `${result.name}: ${hits.map((match) => `${match.term} — “${match.quote}”`).join('; ')}`
        : `${result.name}: read, nothing matched what you asked about`,
    )
  }
  for (const result of stale) parts.push(`${result.name}: ${result.staleBecause}, so it is not being used`)
  for (const result of failed) parts.push(`${result.name}: could not be read — ${result.error}`)
  for (const result of skipped) parts.push(`${result.name}: not checked — ${result.error}`)

  return parts.join(' ')
}

/*
 * The relay browser, loaded only if something actually routes to it.
 *
 * A static import would drag the relay's Cloudflare bindings into every process
 * that touches the fan-out, including ones with no relay configured at all.
 * research.js reaches for the relay the same way and for the same reason.
 */
async function defaultRelayModule() {
  try {
    const { normalizePublicUrl, readPublicPage } = await import('../cloud-relay/serverBrowser.js')
    return { normalizePublicUrl, readPublicPage }
  } catch {
    return null
  }
}
