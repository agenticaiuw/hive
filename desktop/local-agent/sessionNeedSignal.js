import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'

/*
 * "Does this page need the owner's logged-in session?" — learned, not listed.
 *
 * THE PROBLEM. There are two browsers. The owner's Safari holds their sessions
 * and is awake only when they are at the Mac; a Cloudflare browser is always
 * awake and holds nothing of theirs. Routing between them turns on one
 * question, and the obvious way to answer it — a list of sites that need a
 * login — is banned on this project and deserves to be. A list is wrong the
 * day someone logs out, wrong for the half of a site that is public, wrong for
 * every site nobody thought of, and it is a standing claim about services the
 * owner uses that lives in a git repo.
 *
 * WHAT REPLACES IT. Observations. Each one is a thing that actually happened to
 * a real fetch of a real origin, with a timestamp:
 *
 *   login-wall     An unauthenticated fetch rendered a sign-in wall, an empty
 *                  document, or a 401/403. The edge browser hit the wall it can
 *                  never climb.
 *   divergent      BOTH browsers read the same URL and what the authenticated
 *                  one saw is materially different from what the logged-out one
 *                  saw. This is the strongest signal there is, and the only one
 *                  that catches the dangerous case: a page that renders 200 OK
 *                  and looks perfectly fine logged out while showing a stranger
 *                  something quite different from the owner's own record.
 *   converged      Both browsers read the same URL and got materially the same
 *                  content. Proof that the session does not matter here.
 *   public-read-ok An unauthenticated fetch returned substantive content with no
 *                  wall. Deliberately the WEAKEST signal, and negative-going: a
 *                  logged-out page renders fine, so "it looked fine" is evidence
 *                  of nothing much. `divergent` exists because of exactly this.
 *   owner-marked / owner-cleared
 *                  The owner said so. Strongest of all, still decays, still one
 *                  origin at a time — a correction, not a configuration file.
 *
 * WHY IT DECAYS. Every fact here has a shelf life measured in weeks. Sessions
 * expire, sites move a feature behind a login or out from behind one, the owner
 * cancels an account. An observation's weight is halved every HALF_LIFE_MS, so
 * a verdict that stops being re-observed drifts back to `unknown` and the
 * routing goes back to finding out rather than remembering. Nothing here is
 * ever true forever, which is the property a hardcoded list cannot have.
 *
 * WHAT IS DELIBERATELY NOT STORED. Page text. Comparisons are reduced to two
 * numbers (overlap, length ratio) at the moment they are made and only the
 * numbers are written down. A store that answers "which of the owner's accounts
 * exist" is bad enough; one that also holds what was on the page is worse.
 *
 * PHRASING IS NOT AN OBSERVATION. mentionsOwnerPrivateData() reads the request,
 * not the page, so it is a guess about intent and it never lands in this store.
 * It is applied per request by judgeSessionNeed(), it can only ever push a job
 * ONTO the owner's browser, and a learned `public` verdict — which stands on two
 * real fetches that agreed — beats it. Being wrong in that direction costs one
 * Mac round-trip; being wrong the other way files a stranger's logged-out page
 * as the owner's record.
 */

const STORE_VERSION = 1

/*
 * One week. Chosen against the thing that actually changes underneath this: a
 * login session. Long enough that a page checked every few days keeps a stable
 * verdict without re-probing; short enough that an origin observed once in
 * spring is not still steering routing in autumn — after a month its weight is
 * down to about a sixteenth and the verdict has fallen back to `unknown`.
 */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

/* Past six half-lives an observation is worth under 2% of its weight, which is
 * not evidence, only clutter in the store and in the explanation. */
export const MAX_OBSERVATION_AGE_MS = 45 * 24 * 60 * 60 * 1000

/*
 * How much decayed evidence it takes to state a verdict.
 *
 * 0.75 is one fresh login-wall (1.0), or one divergence at a fortnight's remove,
 * or two public reads that agreed. Below it the honest answer is `unknown`, and
 * `unknown` is a useful answer here: it is what makes the runner go and find out
 * rather than guess.
 */
export const NEED_THRESHOLD = 0.75
export const PUBLIC_THRESHOLD = -0.75

/*
 * Base weights. Asymmetric on purpose — see the note on `public-read-ok` above.
 * Evidence that the two browsers see different things outranks evidence that
 * one of them saw something.
 */
export const OBSERVATION_WEIGHTS = Object.freeze({
  'login-wall': 1,
  divergent: 1.5,
  converged: -1.5,
  'public-read-ok': -0.5,
  'owner-marked': 2.5,
  'owner-cleared': -2.5,
})

export const OBSERVATION_KINDS = Object.freeze(Object.keys(OBSERVATION_WEIGHTS))

/* No single observation may decide a verdict on its own past this. */
const MAX_WEIGHT = 3

/* Newest kept. Twelve is more than enough to swamp any one bad reading while
 * staying small enough that the explanation can be read out loud. */
const MAX_OBSERVATIONS_PER_ORIGIN = 12
const MAX_ORIGINS = 300

/*
 * How long before an origin is worth spending a Mac round-trip on again to
 * compare the two browsers. Six hours: a session that expired this morning is
 * worth re-learning today, and an origin read forty times in an afternoon is
 * not worth forty authenticated re-reads.
 */
export const CALIBRATION_COOLDOWN_MS = 6 * 60 * 60 * 1000

export const SESSION_NEED = Object.freeze({
  REQUIRED: 'session-required',
  PUBLIC: 'public',
  UNKNOWN: 'unknown',
})

/* ------------------------------------------------------------------ store */

export function sessionNeedLocation() {
  return (
    process.env.PENDANT_SESSION_NEED_PATH ||
    path.join(workspacePath, '.pendant-session-need.json')
  )
}

const emptyStore = () => ({ version: STORE_VERSION, origins: {} })

const isValidStore = (value) =>
  Boolean(value) &&
  typeof value === 'object' &&
  Boolean(value.origins) &&
  typeof value.origins === 'object'

export function readSessionNeedStore({ filePath = sessionNeedLocation() } = {}) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  const stored = readJsonWithRecovery(filePath, {
    fallback: emptyStore(),
    validate: isValidStore,
  })
  return { version: STORE_VERSION, origins: { ...stored.origins } }
}

function writeStore(store, filePath) {
  writeJsonAtomic(filePath, store, { validate: isValidStore })
  return store
}

/** The scheme-and-host half of a URL, which is what a session actually belongs
 * to. A per-path verdict would learn nothing: sessions are set per origin. */
export function originOf(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin.toLowerCase()
  } catch {
    return null
  }
}

/* ----------------------------------------------------------- comparison */

/* Two characters is punctuation and noise; three starts being a word. */
const MIN_TOKEN = 3

/** The words a page is made of, as a set. Order and layout are exactly what
 * changes between two loads of the same page, so neither is compared. */
export function tokenize(text) {
  const tokens = new Set()
  for (const raw of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= MIN_TOKEN) tokens.add(raw)
  }
  return tokens
}

/* Above this the two readings are the same page; below the lower one they are
 * different pages wearing the same URL. Between them nothing is claimed —
 * "inconclusive" records no observation at all, which is the honest outcome for
 * a page that reflows its own sidebar. */
export const SAME_JACCARD = 0.55
export const DIFFERENT_JACCARD = 0.3

/* A reading a third the size of the other is a stub — a wall, a spinner, a
 * cookie gate — whatever the word overlap says. */
const STUB_LENGTH_RATIO = 0.35

/**
 * Did the authenticated browser see something materially different from the
 * logged-out one?
 *
 * This is the whole routing signal in one function, so it is deliberately dumb
 * and inspectable: set overlap of the words, plus a length ratio to catch the
 * stub case. No model, nothing to tune per site, and both numbers travel into
 * the stored observation so a verdict can always be argued with.
 */
export function compareReadings(publicText, authenticatedText) {
  const publicTokens = tokenize(publicText)
  const authTokens = tokenize(authenticatedText)
  const publicChars = String(publicText ?? '').trim().length
  const authChars = String(authenticatedText ?? '').trim().length

  const onlyInAuthenticated = [...authTokens].filter((t) => !publicTokens.has(t)).length
  const onlyInPublic = [...publicTokens].filter((t) => !authTokens.has(t)).length
  const shared = authTokens.size - onlyInAuthenticated
  const union = publicTokens.size + onlyInAuthenticated

  const jaccard = union ? shared / union : 0
  const longest = Math.max(publicChars, authChars)
  const lengthRatio = longest ? Math.min(publicChars, authChars) / longest : 1

  const direction =
    authChars > publicChars * 1.25
      ? 'authenticated-richer'
      : publicChars > authChars * 1.25
        ? 'public-richer'
        : 'even'

  const base = {
    jaccard: Number(jaccard.toFixed(3)),
    lengthRatio: Number(lengthRatio.toFixed(3)),
    publicChars,
    authChars,
    onlyInAuthenticated,
    onlyInPublic,
    direction,
  }

  /* Nothing to compare. Two empty readings agree about nothing, and one empty
   * reading against a real one is the wall case, not a similarity question. */
  if (!authTokens.size && !publicTokens.size) {
    return { ...base, verdict: 'inconclusive', why: 'neither browser returned readable text' }
  }
  if (!publicTokens.size) {
    return {
      ...base,
      verdict: 'different',
      why: 'the logged-out browser returned no readable text where the owner\'s browser did',
    }
  }
  if (!authTokens.size) {
    return {
      ...base,
      verdict: 'inconclusive',
      why: 'the owner\'s browser returned no readable text, so there is nothing to compare against',
    }
  }

  if (jaccard >= SAME_JACCARD && lengthRatio >= STUB_LENGTH_RATIO) {
    return { ...base, verdict: 'same', why: 'both browsers read materially the same page' }
  }
  if (jaccard <= DIFFERENT_JACCARD || lengthRatio < STUB_LENGTH_RATIO) {
    return {
      ...base,
      verdict: 'different',
      why: `the two browsers overlapped on ${Math.round(jaccard * 100)}% of the words`,
    }
  }
  return {
    ...base,
    verdict: 'inconclusive',
    why: `${Math.round(jaccard * 100)}% word overlap is neither the same page nor a different one`,
  }
}

/** The observation a comparison is worth, or null when it proves nothing. */
export function observationFromComparison(comparison) {
  if (comparison.verdict === 'same') {
    return { kind: 'converged', weight: OBSERVATION_WEIGHTS.converged, detail: comparison.why }
  }
  if (comparison.verdict !== 'different') return null

  /*
   * Divergence counts either way, but not equally. The authenticated browser
   * seeing MORE is the owner's own record showing up; the logged-out one seeing
   * more is usually a consent banner or an ad wall, which still means the edge
   * reading is not the owner's page — just less certainly so.
   */
  const weight =
    comparison.direction === 'public-richer'
      ? OBSERVATION_WEIGHTS.divergent * 0.6
      : OBSERVATION_WEIGHTS.divergent

  return { kind: 'divergent', weight, detail: comparison.why }
}

/* ------------------------------------------------------------- recording */

function clampWeight(value, fallback) {
  const weight = Number.isFinite(Number(value)) ? Number(value) : fallback
  return Math.max(-MAX_WEIGHT, Math.min(MAX_WEIGHT, weight))
}

function pruneOrigins(store, now) {
  for (const [origin, entry] of Object.entries(store.origins)) {
    const kept = (entry.observations ?? []).filter(
      (o) => now - Date.parse(o.at) <= MAX_OBSERVATION_AGE_MS,
    )
    if (!kept.length) {
      delete store.origins[origin]
      continue
    }
    entry.observations = kept.slice(-MAX_OBSERVATIONS_PER_ORIGIN)
  }

  const origins = Object.entries(store.origins)
  if (origins.length <= MAX_ORIGINS) return store

  /* Evict the least recently observed: an origin nobody has looked at in months
   * is the one whose verdict is least worth keeping. */
  origins
    .sort((a, b) => Date.parse(a[1].lastObservedAt ?? 0) - Date.parse(b[1].lastObservedAt ?? 0))
    .slice(0, origins.length - MAX_ORIGINS)
    .forEach(([origin]) => delete store.origins[origin])

  return store
}

/**
 * Write down one thing that happened to one origin.
 *
 * @param kind    one of OBSERVATION_KINDS.
 * @param detail  a sentence a person can read back. Kept because a verdict that
 *                cannot explain itself cannot be corrected.
 * @param stats   the two comparison numbers, when there was a comparison. Never
 *                page text.
 */
export function recordSessionObservation(
  { url, origin: explicitOrigin, kind, detail = '', weight, stats = null } = {},
  { now = Date.now(), filePath = sessionNeedLocation() } = {},
) {
  const origin = explicitOrigin ? originOf(explicitOrigin) : originOf(url)
  if (!origin) throw new Error(`Not an http(s) origin: ${String(url ?? explicitOrigin)}`)
  if (!OBSERVATION_KINDS.includes(kind)) {
    throw new Error(`Unknown session-need observation: ${String(kind)}`)
  }

  const store = readSessionNeedStore({ filePath })
  const entry = store.origins[origin] ?? { origin, observations: [], lastCalibratedAt: null }
  const at = new Date(now).toISOString()

  entry.observations = [
    ...(entry.observations ?? []),
    {
      kind,
      at,
      weight: clampWeight(weight, OBSERVATION_WEIGHTS[kind]),
      detail: String(detail).slice(0, 200),
      ...(stats
        ? { stats: { jaccard: stats.jaccard, lengthRatio: stats.lengthRatio, direction: stats.direction } }
        : {}),
    },
  ].slice(-MAX_OBSERVATIONS_PER_ORIGIN)
  entry.lastObservedAt = at

  /* A comparison is the only observation that costs a Mac round-trip, so it is
   * the only one that resets the cooldown on spending another. */
  if (kind === 'divergent' || kind === 'converged') entry.lastCalibratedAt = at

  store.origins[origin] = entry
  writeStore(pruneOrigins(store, now), filePath)

  return sessionNeedFor(origin, { now, store })
}

/** Drop everything learned about one origin. The owner's undo. */
export function forgetOrigin(url, { filePath = sessionNeedLocation() } = {}) {
  const origin = originOf(url)
  const store = readSessionNeedStore({ filePath })
  const existed = Boolean(origin && store.origins[origin])
  if (origin) delete store.origins[origin]
  writeStore(store, filePath)
  return { origin, forgotten: existed }
}

/* -------------------------------------------------------------- verdicts */

const decayFactor = (ageMs) => 0.5 ** (Math.max(0, ageMs) / HALF_LIFE_MS)

function ageWords(ms) {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

/**
 * What is known about this origin right now.
 *
 * Recomputed from the observations on every call rather than stored, because
 * the answer changes as the clock moves even when nothing new is observed —
 * that is what decay means. A cached verdict would be a hardcoded list again,
 * just one this process wrote itself.
 */
export function sessionNeedFor(
  url,
  { now = Date.now(), filePath = sessionNeedLocation(), store = null } = {},
) {
  const origin = originOf(url)
  const unknown = {
    origin,
    verdict: SESSION_NEED.UNKNOWN,
    score: 0,
    confidence: 0,
    observations: 0,
    lastObservedAt: null,
    lastCalibratedAt: null,
    basis: [],
    source: 'learned',
  }
  if (!origin) return { ...unknown, basis: ['that is not an http(s) address'] }

  const table = store ?? readSessionNeedStore({ filePath })
  const entry = table.origins?.[origin]
  if (!entry?.observations?.length) return unknown

  const scored = entry.observations
    .map((observation) => {
      const ageMs = now - Date.parse(observation.at)
      if (!Number.isFinite(ageMs) || ageMs > MAX_OBSERVATION_AGE_MS) return null
      const weight = clampWeight(observation.weight, OBSERVATION_WEIGHTS[observation.kind] ?? 0)
      return {
        kind: observation.kind,
        ageMs: Math.max(0, ageMs),
        contribution: weight * decayFactor(ageMs),
        detail: observation.detail ?? '',
      }
    })
    .filter(Boolean)

  if (!scored.length) return unknown

  const score = scored.reduce((sum, item) => sum + item.contribution, 0)
  const verdict =
    score >= NEED_THRESHOLD
      ? SESSION_NEED.REQUIRED
      : score <= PUBLIC_THRESHOLD
        ? SESSION_NEED.PUBLIC
        : SESSION_NEED.UNKNOWN

  /* The three heaviest facts, signed the way the verdict went, so an
   * explanation names the evidence rather than the arithmetic. */
  const basis = [...scored]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 3)
    .map(
      (item) =>
        `${item.kind} ${ageWords(item.ageMs)} (${item.contribution >= 0 ? '+' : ''}${item.contribution.toFixed(2)})${item.detail ? `: ${item.detail}` : ''}`,
    )

  return {
    origin,
    verdict,
    score: Number(score.toFixed(3)),
    /* Full confidence at twice the threshold — two independent facts pointing
     * the same way, or one fresh one that is meant to be decisive. */
    confidence: Number(Math.min(1, Math.abs(score) / (NEED_THRESHOLD * 2)).toFixed(3)),
    observations: scored.length,
    lastObservedAt: entry.lastObservedAt ?? null,
    lastCalibratedAt: entry.lastCalibratedAt ?? null,
    basis,
    source: 'learned',
  }
}

/** Every origin with a live verdict, heaviest first. For the owner to read. */
export function listSessionNeeds({ now = Date.now(), filePath = sessionNeedLocation() } = {}) {
  const store = readSessionNeedStore({ filePath })
  return Object.keys(store.origins)
    .map((origin) => sessionNeedFor(origin, { now, store }))
    .filter((need) => need.observations > 0)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
}

/** Drop what has decayed past usefulness. Safe to run on a timer. */
export function sweepSessionNeeds({ now = Date.now(), filePath = sessionNeedLocation() } = {}) {
  const store = readSessionNeedStore({ filePath })
  const before = Object.keys(store.origins).length
  writeStore(pruneOrigins(store, now), filePath)
  const after = Object.keys(store.origins).length
  return { sweptAt: new Date(now).toISOString(), originsBefore: before, originsAfter: after }
}

/* ------------------------------------------------------- request phrasing */

/*
 * A possessive plus a noun that denotes a record kept about a person. Both
 * halves are required: "my question" is not private and "orders" alone is a
 * shop's public page as often as it is the owner's. Generic English, with no
 * service, brand or domain anywhere in it — this is the one place a site list
 * would be tempting and the one place it would be least justified, because the
 * phrasing works for a service nobody has heard of yet.
 */
const OWNER_POSSESSIVE = /\b(my|our|mine|ours)\b/i
const PRIVATE_RECORD =
  /\b(account|accounts|inbox|mailbox|order|orders|invoice|invoices|bill|bills|billing|statement|statements|subscription|subscriptions|balance|balances|profile|settings|dashboard|cart|basket|booking|bookings|reservation|reservations|message|messages|notification|notifications|history|library|watchlist|portfolio|payslip|payslips|prescription|prescriptions|claim|claims|ticket|tickets|calendar|deliveries|delivery|shipment|shipments)\b/i

/* Words that describe the boundary itself rather than what is behind it. These
 * stand alone — "am I still signed in" needs no possessive to be about a
 * session. */
const SESSION_WORD =
  /\b(sign(?:ed)?[ -]?in|log(?:ged)?[ -]?in|signin|login|logout|log(?:ged)?[ -]?out|signed[ -]?out|session|password|credentials|authenticated|two[ -]factor)\b/i

/**
 * Does the request itself say it is about the owner's own record?
 *
 * A guess, labelled as one, and never written to the store. judgeSessionNeed()
 * applies it in one direction only.
 */
export function mentionsOwnerPrivateData(text) {
  const value = String(text ?? '')
  if (!value.trim()) return { private: false, terms: [] }

  const possessive = OWNER_POSSESSIVE.exec(value)
  const record = PRIVATE_RECORD.exec(value)
  const session = SESSION_WORD.exec(value)

  const terms = []
  if (possessive && record) terms.push(`“${possessive[0]} … ${record[0]}”`)
  if (session) terms.push(`“${session[0]}”`)

  return { private: terms.length > 0, terms }
}

/* --------------------------------------------------------- the judgement */

/**
 * Everything known about one job's target, folded into one verdict.
 *
 * Three inputs, in strict precedence:
 *
 *   probe    Live evidence from THIS run — the unauthenticated browser just hit
 *            a wall on this URL. Outranks everything: it is not a memory, it is
 *            what happened a second ago.
 *   learned  The decayed verdict from real fetches. Outranks phrasing in both
 *            directions, including when it says `public`, because it stands on
 *            two browsers having actually agreed.
 *   phrasing A guess from the request text. One-directional: it can only raise
 *            `unknown` to `session-required`, never lower anything.
 */
export function judgeSessionNeed({
  url,
  requestText = '',
  learned = null,
  probe = null,
  now = Date.now(),
  filePath = sessionNeedLocation(),
  store = null,
} = {}) {
  const known = learned ?? sessionNeedFor(url, { now, filePath, store })

  if (probe?.likelyLoginWall || probe?.reason === 'login-wall') {
    return {
      ...known,
      verdict: SESSION_NEED.REQUIRED,
      confidence: 1,
      source: 'probe',
      why: 'the logged-out browser just hit a sign-in wall on this page',
      basis: ['unauthenticated probe hit a sign-in wall in this run', ...known.basis],
    }
  }

  if (known.verdict !== SESSION_NEED.UNKNOWN) {
    return {
      ...known,
      why:
        known.verdict === SESSION_NEED.REQUIRED
          ? 'past fetches of this origin showed the owner\'s session changes what the page says'
          : 'past fetches of this origin were the same with and without the owner\'s session',
    }
  }

  const phrasing = mentionsOwnerPrivateData(requestText)
  if (phrasing.private) {
    return {
      ...known,
      verdict: SESSION_NEED.REQUIRED,
      /* A guess, priced as one: enough to route onto the Mac, never enough to
       * be quoted as a fact about the origin. */
      confidence: 0.4,
      guessed: true,
      source: 'request-phrasing',
      why: `the request asks about the owner's own record (${phrasing.terms.join(', ')})`,
      basis: [`request phrasing: ${phrasing.terms.join(', ')}`, ...known.basis],
    }
  }

  return {
    ...known,
    why: 'nothing has been observed about whether this origin needs the owner\'s session',
  }
}

/**
 * Is it worth spending a Mac round-trip to settle this origin?
 *
 * Only while the answer is unknown, only when the Mac is actually there, and
 * only once per cooldown. Without this, `unknown` would only ever resolve by
 * walking into a wall — which never happens for the case that matters, the page
 * that renders fine logged out and shows the owner something else.
 */
export function shouldCalibrate(need, { bridgeUp = null, now = Date.now(), enabled = true } = {}) {
  if (!enabled) return { calibrate: false, why: 'calibration was turned off for this job' }
  if (bridgeUp === false) {
    return { calibrate: false, why: 'the owner\'s browser is not answering' }
  }
  if (need?.verdict !== SESSION_NEED.UNKNOWN) {
    return { calibrate: false, why: `this origin is already judged ${need?.verdict}` }
  }
  const last = Date.parse(need?.lastCalibratedAt ?? '')
  if (Number.isFinite(last) && now - last < CALIBRATION_COOLDOWN_MS) {
    return {
      calibrate: false,
      why: `the two browsers were already compared ${ageWords(now - last)} on this origin`,
    }
  }
  return {
    calibrate: true,
    why: 'nothing is known about this origin yet, so both browsers read it once and the readings are compared',
  }
}

/** One line the pendant can say about why a page went where it went. */
export function describeSessionNeed(need) {
  if (!need?.origin) return 'That is not a web address I can route.'
  if (need.verdict === SESSION_NEED.REQUIRED) {
    return `${need.origin} needs your own browser — ${need.why ?? need.basis[0] ?? 'observed'}.`
  }
  if (need.verdict === SESSION_NEED.PUBLIC) {
    return `${need.origin} reads the same without your session, so the cloud browser can do it.`
  }
  return `Nothing is known yet about whether ${need.origin} needs your session.`
}
