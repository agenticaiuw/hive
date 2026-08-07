import crypto from 'node:crypto'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { classifySensitivity, maskSecretValue } from './redaction.js'

/*
 * Evidence capsules: where a browser reading came from, in a form that survives
 * the trip to a summary or a Mac action.
 *
 * A browser extraction used to become a bare string the moment it left the
 * extension. By the time it reached a spoken briefing or a write_file, nothing
 * recorded which page it was read off, when, in which tab, or whether the text
 * had been through redaction. "Why did it do that" was unanswerable, and
 * "forget what you read on that page" had nowhere to reach.
 *
 * That matters most in the exact case this product exists for: pages behind the
 * owner's own login, which nobody else can go and re-check.
 *
 * THIS OBSERVES. Minting a capsule cannot refuse, delay, or alter a browser
 * action — computerControl mints after the extension has already answered, and
 * a mint that throws is swallowed. Revocation removes DISPLAY of evidence
 * downstream; it never blocks a future read. actionReceipts.js and
 * executionJournal.js say the same thing about themselves and the three should
 * keep agreeing.
 *
 * Three properties do the work:
 *
 *   Content-addressed. The id is a digest of (source, region, observer,
 *   content hash) — deliberately NOT of the capture time. A watch that polls an
 *   unchanged page every fifteen minutes produces one capsule, not ninety-six.
 *   Same derivation as actionReceipts.actionIdFor, for the same reason.
 *
 *   Immutable. A minted capsule is never rewritten. Re-capturing identical
 *   content returns the existing capsule untouched. The only permitted mutation
 *   is REMOVING content — revocation and TTL retirement — which leaves every
 *   identifying field, including the content hash, in place as a tombstone. You
 *   can still prove what was there without still holding it.
 *
 *   Pseudonymous observers. A capsule is a cross-node object; the owner's
 *   session names ("chase-checking", "work-portal") are not. The tab and
 *   session identifiers are HMACs under a salt that never leaves this store, so
 *   a capsule can be compared and joined elsewhere without carrying what it was
 *   derived from. No cookie, header, or credential is ever recorded — and the
 *   URL query string is dropped before storage for the same reason, since some
 *   sites put a session token there.
 *
 * Safari hands every extension context its own tab-id namespace, and the same
 * tab reports a different number seconds later (browserSessions.js documents
 * the live evidence). A raw tab id is therefore meaningless on its own, so the
 * context that issued it is part of the HMAC input and is also recorded in the
 * clear. Two tab pseudonyms are only comparable within the same context.
 */

const CAPSULE_VERSION = 1

/* Browser pages change under us; memoryService.js reaches the same number for
 * the same reason, and a day-old scrape is a guess in both places. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/* Expiry means "stop showing this". Retirement — dropping the body — waits a
 * week, so a question asked the morning after a stale reading can still be
 * answered with the text rather than only with its hash. */
export const RETIRE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

/* Bodies are bounded; rows are not. A tombstone is the audit record and is
 * never removed, so the store grows by roughly 400 bytes per distinct capture
 * and stops growing entirely for a page that is not changing. */
const MAX_LIVE_CAPSULES = 500
const MAX_CONTENT_CHARS = 20_000

/* Above this a line is split further before classification. main_text reads
 * come back as one long paragraph on plenty of sites, and withholding the whole
 * page because one sentence said "password:" is a worse answer than withholding
 * the sentence. */
const MAX_SEGMENT_CHARS = 240

const isValidStore = (value) =>
  value && typeof value.salt === 'string' && Array.isArray(value.capsules)

export function capsulesLocation() {
  return (
    process.env.PENDANT_EVIDENCE_STORE_PATH ||
    path.join(workspacePath, '.pendant-evidence-capsules.json')
  )
}

function emptyStore() {
  return {
    version: CAPSULE_VERSION,
    /* Local-only. It is what makes an exported capsule's observer ids
     * unlinkable to the session names they came from. */
    salt: crypto.randomBytes(32).toString('hex'),
    capsules: [],
  }
}

function load(filePath) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: emptyStore(),
    validate: isValidStore,
  })
}

function save(store, filePath) {
  writeJsonAtomic(filePath, store, { validate: isValidStore })
  return store
}

const sha256 = (value) =>
  crypto.createHash('sha256').update(String(value ?? '')).digest('hex')

/* ------------------------------------------------------------------ identity */

/**
 * The addressable half of a URL, with the query dropped.
 *
 * browserSessions.tabNeedle drops it because sites rewrite it; this drops it
 * because a query string is where a site puts a one-time session token, and a
 * capsule that travels between nodes must not carry one.
 */
export function normalizeSource(rawUrl) {
  const text = String(rawUrl ?? '').trim()
  try {
    const parsed = new URL(text)
    const url = `${parsed.origin}${parsed.pathname}`
    return {
      url,
      origin: parsed.origin,
      host: parsed.host,
      path: parsed.pathname,
      queryDropped: Boolean(parsed.search),
      key: url.toLowerCase(),
    }
  } catch {
    return {
      url: text,
      origin: null,
      host: null,
      path: null,
      queryDropped: false,
      key: text.toLowerCase(),
    }
  }
}

/** Which part of the page this is: a read mode, a selector, a locator. */
export function normalizeRegion(input = {}) {
  const kind = String(input.kind || input.mode || 'page').slice(0, 40)
  const selector = input.selector ? String(input.selector).slice(0, 200) : null
  const locator = input.locator ? String(input.locator).slice(0, 200) : null
  return { kind, selector, locator, key: `${kind}|${selector ?? ''}` }
}

/**
 * A stable, unlinkable name for an observer.
 *
 * The context is part of the input rather than only a label because a tab id
 * from one extension context addresses nothing in another — confirmed twice on
 * this project — so two pseudonyms must not compare equal across contexts even
 * when the raw numbers match.
 */
export function pseudonymFor(salt, context, value) {
  const digest = crypto
    .createHmac('sha256', String(salt))
    .update(`${String(context)}|${String(value)}`)
    .digest('hex')
  return `obs_${digest.slice(0, 12)}`
}

/**
 * Content-addressed, so an unchanged page read twice is one piece of evidence.
 *
 * Capture time is deliberately absent: including it would make every poll a new
 * capsule and turn "which evidence is this claim standing on" into a list that
 * grows with the schedule rather than with what was actually seen.
 */
export function capsuleIdFor({ sourceKey, regionKey, observer, contentHash }) {
  const digest = crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        sourceKey: String(sourceKey ?? ''),
        regionKey: String(regionKey ?? ''),
        observer: String(observer ?? ''),
        contentHash: String(contentHash ?? ''),
      }),
    )
    .digest('hex')
  return `evd_${digest.slice(0, 12)}`
}

/* ----------------------------------------------------------------- redaction */

function segmentsOf(text) {
  const segments = []

  for (const [index, line] of String(text).split('\n').entries()) {
    if (index) segments.push({ text: '\n', literal: true })
    if (line.length <= MAX_SEGMENT_CHARS) {
      segments.push({ text: line })
      continue
    }
    /* The capture keeps the separators, so joining the pieces back together
     * reproduces the line exactly. */
    for (const piece of line.split(/((?<=[.!?])\s+)/)) {
      if (!piece) continue
      segments.push({ text: piece, literal: /^\s+$/.test(piece) })
    }
  }

  return segments
}

/**
 * What in this capture is sensitive, where, and what was done about it.
 *
 * Built entirely out of redaction.js — classifySensitivity decides, and
 * maskSecretValue withholds. There is deliberately no second pattern list here:
 * two sets of credential patterns drift, and the one that drifts is always the
 * copy nobody remembers exists.
 *
 * Secrets are withheld from the stored body, because a capsule is what gets
 * pasted into a third-party prompt. Personal data is flagged and kept: the
 * owner reads their own pages at full fidelity, and the flag is what lets a
 * prompt builder decide, exactly as memoryService.js treats `sensitivity`.
 * Neither is an access gate.
 */
export function redactionMapFor(rawText) {
  const source = String(rawText ?? '')
  const map = []
  const out = []
  let cursor = 0
  let secrets = 0
  let sensitive = 0

  for (const segment of segmentsOf(source)) {
    let emitted = segment.text

    if (!segment.literal) {
      const verdict = classifySensitivity(segment.text)
      if (verdict === 'secret') {
        emitted = maskSecretValue(segment.text)
        secrets += 1
        map.push({
          start: cursor,
          end: cursor + emitted.length,
          class: 'secret',
          action: 'withheld',
          originalChars: segment.text.length,
        })
      } else if (verdict === 'sensitive') {
        sensitive += 1
        map.push({
          start: cursor,
          end: cursor + emitted.length,
          class: 'sensitive',
          action: 'flagged',
          originalChars: segment.text.length,
        })
      }
    }

    out.push(emitted)
    cursor += emitted.length
  }

  return {
    content: out.join(''),
    map,
    counts: { secret: secrets, sensitive },
    classification: secrets ? 'secret' : sensitive ? 'sensitive' : 'normal',
    /* Named in the capsule so a reader of the JSON knows which module decided,
     * without having to find out by experiment. */
    classifier: 'local-agent/redaction.js classifySensitivity',
  }
}

/* ---------------------------------------------------------------- confidence */

/**
 * How much this capture deserves to be leaned on, and why.
 *
 * Every term is something the capture path already knows and would otherwise
 * throw away. A number with no reasons attached is a number nobody can argue
 * with, which is the opposite of what provenance is for.
 */
export function scoreCapture({
  requestedUrl = null,
  landedUrl = null,
  contentChars = 0,
  truncated = false,
  recovery = [],
  missing = [],
} = {}) {
  const reasons = []
  let score = 1

  const wanted = normalizeSource(requestedUrl)
  const landed = normalizeSource(landedUrl)
  if (requestedUrl && landedUrl && wanted.key !== landed.key) {
    const sameHost = wanted.host && wanted.host === landed.host
    score -= sameHost ? 0.15 : 0.35
    reasons.push(
      sameHost
        ? `the page redirected within ${landed.host} to ${landed.path}`
        : `the page redirected to a different host (${landed.host ?? 'unknown'})`,
    )
  }

  if (!contentChars) {
    score -= 0.4
    reasons.push('the read came back empty')
  }

  if (truncated) {
    score -= 0.15
    reasons.push('the page was longer than the read limit, so this is a prefix')
  }

  if (Array.isArray(recovery) && recovery.length) {
    score -= 0.1
    reasons.push(`a tab had to be opened first (${recovery.join(' → ')})`)
  }

  if (Array.isArray(missing) && missing.length) {
    score -= Math.min(0.3, 0.1 * missing.length)
    reasons.push(`${missing.length} requested field(s) did not match`)
  }

  const bounded = Math.max(0, Math.min(1, score))
  return {
    score: Math.round(bounded * 100) / 100,
    reasons: reasons.length ? reasons : ['the page was read as addressed'],
  }
}

/* --------------------------------------------------------------------- mint */

/**
 * Record a capture. Returns the capsule and whether this call created it.
 *
 * A capture whose id already exists returns the stored capsule with nothing
 * written — including when that capsule has been revoked. That is the point of
 * the revocation: re-reading the same unchanged page does not resurrect
 * evidence the owner deleted. It does not stop the read, and it does not touch
 * the live browser result the caller already holds.
 */
export function mintCapsule(
  {
    url,
    title = '',
    region = {},
    content = '',
    context = 'unknown',
    session = null,
    tabId = null,
    requestedUrl = null,
    recovery = [],
    missing = [],
    truncated = false,
    ttlMs = DEFAULT_TTL_MS,
    confidence = null,
    capturedAt = Date.now(),
  } = {},
  { filePath = capsulesLocation() } = {},
) {
  const store = load(filePath)

  const source = normalizeSource(url)
  const normalizedRegion = normalizeRegion(region)
  const full = String(content ?? '')
  const clipped = full.slice(0, MAX_CONTENT_CHARS)
  const redaction = redactionMapFor(clipped)
  const contentHash = `sha256:${sha256(redaction.content)}`

  const contextLabel = String(context || 'unknown').slice(0, 60)
  const observer = {
    context: contextLabel,
    session: session
      ? pseudonymFor(store.salt, contextLabel, String(session))
      : null,
    tab: Number.isInteger(tabId)
      ? pseudonymFor(store.salt, `${contextLabel}#tab`, String(tabId))
      : null,
  }

  const capsuleId = capsuleIdFor({
    sourceKey: source.key,
    regionKey: normalizedRegion.key,
    observer: observer.session ?? contextLabel,
    contentHash,
  })

  const existing = store.capsules.find((item) => item.capsuleId === capsuleId)
  if (existing) {
    return {
      capsule: existing,
      capsuleId,
      minted: false,
      collapsed: true,
      state: capsuleState(existing, capturedAt),
    }
  }

  const at = new Date(capturedAt).toISOString()
  const capsule = {
    capsuleId,
    version: CAPSULE_VERSION,
    source: {
      url: source.url,
      origin: source.origin,
      host: source.host,
      path: source.path,
      title: String(title ?? '').slice(0, 160),
      queryDropped: source.queryDropped,
    },
    region: {
      kind: normalizedRegion.kind,
      selector: normalizedRegion.selector,
      locator: normalizedRegion.locator,
    },
    observer,
    capturedAt: at,
    expiresAt:
      Number.isFinite(ttlMs) && ttlMs > 0
        ? new Date(capturedAt + ttlMs).toISOString()
        : null,
    contentHash,
    chars: redaction.content.length,
    truncated: Boolean(truncated) || full.length > MAX_CONTENT_CHARS,
    content: redaction.content,
    redaction: {
      map: redaction.map,
      counts: redaction.counts,
      classification: redaction.classification,
      classifier: redaction.classifier,
    },
    confidence:
      confidence ??
      scoreCapture({
        requestedUrl: requestedUrl ?? url,
        landedUrl: url,
        contentChars: redaction.content.length,
        truncated: Boolean(truncated) || full.length > MAX_CONTENT_CHARS,
        recovery,
        missing,
      }),
    revocation: null,
    retiredAt: null,
  }

  store.capsules.push(capsule)
  retireOverflow(store)
  save(store, filePath)

  return { capsule, capsuleId, minted: true, collapsed: false, state: 'live' }
}

/* The body is the expensive part, so only the body is bounded. The row stays:
 * "there was evidence here and it said X" must outlive the text itself. */
function retireOverflow(store) {
  const bodied = store.capsules.filter((item) => item.content !== null)
  if (bodied.length <= MAX_LIVE_CAPSULES) return
  bodied
    .sort((left, right) => String(left.capturedAt).localeCompare(String(right.capturedAt)))
    .slice(0, bodied.length - MAX_LIVE_CAPSULES)
    .forEach((item) => {
      item.content = null
      item.retiredAt = new Date().toISOString()
      item.retiredReason = 'store bound reached'
    })
}

/* -------------------------------------------------------------------- read */

export function getCapsule(capsuleId, { filePath = capsulesLocation() } = {}) {
  return (
    load(filePath).capsules.find((item) => item.capsuleId === capsuleId) ?? null
  )
}

export function capsuleState(capsule, now = Date.now()) {
  if (!capsule) return 'unknown'
  if (capsule.revocation) return 'revoked'
  if (capsule.retiredAt) return 'retired'
  const expiry = Date.parse(capsule.expiresAt ?? '')
  if (Number.isFinite(expiry) && expiry <= now) return 'expired'
  return 'live'
}

const WITHHELD = {
  revoked: 'The owner revoked this source; the reading is gone and only its tombstone remains.',
  retired: 'The body aged out of the store; the tombstone records what it was.',
  expired: 'Past its TTL, so it is no longer shown as current evidence.',
  unknown: 'No capsule with this id was ever minted here.',
}

/**
 * A capsule as anything downstream is allowed to display it.
 *
 * This is the single place the TTL and the revocation take effect, and it is a
 * read: nothing has to remember to call a purge for a revoked page to stop
 * appearing. executionJournal.js derives on read for the same reason — a path
 * you have to remember to write to is wrong the first time someone forgets.
 */
export function presentCapsule(capsule, { now = Date.now() } = {}) {
  if (!capsule) return null
  const state = capsuleState(capsule, now)
  const usable = state === 'live'

  return {
    capsuleId: capsule.capsuleId,
    source: capsule.source,
    region: capsule.region,
    observer: capsule.observer,
    capturedAt: capsule.capturedAt,
    expiresAt: capsule.expiresAt,
    contentHash: capsule.contentHash,
    chars: capsule.chars,
    truncated: Boolean(capsule.truncated),
    confidence: capsule.confidence,
    redaction: capsule.redaction,
    state,
    usable,
    content: usable ? capsule.content : null,
    withheld: usable ? null : WITHHELD[state],
    tombstone: usable ? null : capsuleTombstone(capsule),
  }
}

/**
 * What survives deletion: enough to prove a claim once stood on something, and
 * nothing that would let the reading be reconstructed.
 */
export function capsuleTombstone(capsule) {
  return {
    capsuleId: capsule.capsuleId,
    host: capsule.source?.host ?? null,
    url: capsule.source?.url ?? null,
    region: capsule.region?.kind ?? null,
    capturedAt: capsule.capturedAt,
    contentHash: capsule.contentHash,
    chars: capsule.chars,
    revokedAt: capsule.revocation?.revokedAt ?? null,
    revokedReason: capsule.revocation?.reason ?? null,
    revokedBy: capsule.revocation?.matchedBy ?? null,
    retiredAt: capsule.retiredAt ?? null,
  }
}

export function listCapsules(
  { host = null, state = null, now = Date.now(), limit = 50 } = {},
  { filePath = capsulesLocation() } = {},
) {
  return load(filePath)
    .capsules.filter((item) => (host ? item.source?.host === host : true))
    .filter((item) => (state ? capsuleState(item, now) === state : true))
    .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))
    .slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined)
    .map((item) => presentCapsule(item, { now }))
}

/**
 * The capsule ids a derived record stands on.
 *
 * Walks an arbitrary result rather than demanding a fixed field, because the
 * shapes that carry evidence are written in four different modules and a schema
 * they all had to agree on is a schema one of them would quietly stop meeting.
 */
export function linkedCapsuleIds(value, depth = 0, found = new Set()) {
  if (depth > 6 || !value || typeof value !== 'object') return [...found]

  if (Array.isArray(value)) {
    for (const item of value) linkedCapsuleIds(item, depth + 1, found)
    return [...found]
  }

  for (const [key, entry] of Object.entries(value)) {
    if (key === 'capsuleId' && typeof entry === 'string' && entry) {
      found.add(entry)
      continue
    }
    if (key === 'capsuleIds' && Array.isArray(entry)) {
      for (const id of entry) if (typeof id === 'string' && id) found.add(id)
      continue
    }
    linkedCapsuleIds(entry, depth + 1, found)
  }

  return [...found]
}

/** Of these ids, the ones a caller may still show. Used by display paths. */
export function usableCapsuleIds(
  capsuleIds = [],
  { now = Date.now(), filePath = capsulesLocation() } = {},
) {
  const wanted = new Set(capsuleIds.filter(Boolean))
  if (!wanted.size) return { usable: [], withheld: [] }

  const store = load(filePath)
  const usable = []
  const withheld = []

  for (const id of wanted) {
    const capsule = store.capsules.find((item) => item.capsuleId === id)
    const state = capsuleState(capsule, now)
    if (state === 'live') usable.push(id)
    else withheld.push({ capsuleId: id, state, reason: WITHHELD[state] })
  }

  return { usable, withheld }
}

/* ---------------------------------------------------------------- revoke */

/**
 * Delete a source. The reading goes; the record that there was one stays.
 *
 * Matching is by capsule id, by exact page, or by host — "forget everything you
 * read on that site" is the ask this exists for. Nothing about a future read is
 * changed: the same page can be read again a second later and the reading is
 * live evidence again, unless it is byte-identical to what was revoked, in
 * which case the content address makes it the same capsule and the revocation
 * still holds. That is deletion propagating, not a page being blocked.
 */
export function revokeCapsules(
  { capsuleId = null, url = null, host = null, reason = '', now = Date.now() } = {},
  { filePath = capsulesLocation() } = {},
) {
  const pageKey = url ? normalizeSource(url).key : null
  if (!capsuleId && !pageKey && !host) {
    throw new Error('Revoking needs a capsuleId, a url, or a host.')
  }

  const store = load(filePath)
  const revokedAt = new Date(now).toISOString()
  const revoked = []
  const alreadyRevoked = []

  for (const capsule of store.capsules) {
    const matchedBy = capsuleId
      ? capsule.capsuleId === capsuleId
        ? 'capsuleId'
        : null
      : pageKey
        ? capsule.source?.url?.toLowerCase() === pageKey
          ? 'url'
          : null
        : capsule.source?.host === host
          ? 'host'
          : null
    if (!matchedBy) continue

    if (capsule.revocation) {
      alreadyRevoked.push(capsuleTombstone(capsule))
      continue
    }

    /* The only mutation a capsule ever undergoes: the body is removed. Every
     * identifying field, including the content hash, is left exactly as it was
     * minted, which is what makes the tombstone an audit record rather than a
     * gap. */
    capsule.content = null
    capsule.revocation = {
      revokedAt,
      reason: String(reason || '').slice(0, 200) || null,
      matchedBy,
    }
    revoked.push(capsuleTombstone(capsule))
  }

  if (revoked.length) save(store, filePath)

  return {
    revoked,
    alreadyRevoked,
    matched: revoked.length + alreadyRevoked.length,
    note: 'Tombstones are permanent. Nothing here removes a row from the store.',
  }
}

/**
 * Drop the bodies of readings that expired long enough ago to be useless.
 *
 * Not required for correctness — presentCapsule already withholds an expired
 * body on every read — so this is housekeeping, and it is explicit rather than
 * on a timer so that "the text is gone" is always something someone asked for.
 */
export function sweepCapsules(
  { now = Date.now(), graceMs = RETIRE_GRACE_MS } = {},
  { filePath = capsulesLocation() } = {},
) {
  const store = load(filePath)
  const retired = []

  for (const capsule of store.capsules) {
    if (capsule.content === null) continue
    const expiry = Date.parse(capsule.expiresAt ?? '')
    if (!Number.isFinite(expiry) || expiry + graceMs > now) continue
    capsule.content = null
    capsule.retiredAt = new Date(now).toISOString()
    capsule.retiredReason = `expired more than ${Math.round(graceMs / 3_600_000)}h ago`
    retired.push(capsuleTombstone(capsule))
  }

  if (retired.length) save(store, filePath)
  return { retired, kept: store.capsules.length }
}

/* --------------------------------------------------------------- the ledger */

export const EVIDENCE_SOURCES = [
  'local-agent/evidenceCapsules.js — the capsule store itself',
  'local-agent/computerControl.js — mints one capsule per browser read on /execute',
  'local-agent/redaction.js — classifySensitivity + maskSecretValue build the redaction map',
  'local-agent/actionReceipts.js — receipts carry the capsule ids an action stood on',
]

/*
 * Paths that reach synthesis or a Mac action WITHOUT a capsule today. Stated in
 * the payload rather than in a comment, because a coverage claim nobody can
 * check is the failure mode this whole feature exists to fix.
 */
export const UNCAPSULED_PATHS = [
  'cloud-relay/serverBrowser.js read_web_page — runs on the relay, never reaches this process, so it mints nothing.',
  'browser_click / browser_type / browser_select / browser_press_key — writes, not readings. Their results carry no page content to capsule.',
  'browser_capture — the screenshot bytes are never stored; the capsule records that a capture of this page happened, with an empty body.',
  'Mac actions link evidence only when the caller tags them (action.params.capsuleIds). An untagged write_file whose content came from a page shows as unlinked in the journal rather than being silently attributed.',
  'screenCapture.js and computerUse vision — screen pixels are a separate provenance problem and are not capsuled here.',
]

/**
 * Everything the store knows, derived on read.
 *
 * `jobs` is passed in rather than read here so a caller that already holds the
 * job store does not make it load twice, and so this is testable without one —
 * the same contract buildExecutionJournal and buildCapabilityManifest use.
 */
export function buildEvidenceLedger(
  { now = Date.now(), limit = 50, host = null, jobs = [] } = {},
  { filePath = capsulesLocation() } = {},
) {
  const store = load(filePath)
  const all = store.capsules.filter((item) => (host ? item.source?.host === host : true))
  const byState = { live: 0, expired: 0, revoked: 0, retired: 0 }
  for (const capsule of all) byState[capsuleState(capsule, now)] += 1

  const citedBy = new Map()
  for (const job of jobs) {
    for (const item of resultsOf(job)) {
      for (const id of item?.receipt?.evidence?.capsuleIds ?? []) {
        const rows = citedBy.get(id) ?? []
        rows.push({ jobId: job?.jobId ?? null, type: item?.receipt?.type ?? null })
        citedBy.set(id, rows)
      }
    }
  }

  const hosts = [...new Set(all.map((item) => item.source?.host).filter(Boolean))].sort()

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    readOnly: true,
    note: 'Observation and revocation only. Nothing on this path can block, refuse, or delay a browser action.',
    derivedFrom: EVIDENCE_SOURCES,
    notCovered: UNCAPSULED_PATHS,
    storePath: filePath,
    ttl: {
      defaultMs: DEFAULT_TTL_MS,
      retireGraceMs: RETIRE_GRACE_MS,
      note: 'Expiry withholds the body on read. Retirement removes it from the store. Neither removes the tombstone.',
    },
    observers: {
      note: 'Tab and session ids are HMACs under a store-local salt. A tab id is only meaningful alongside the context that issued it, so the context is part of the input and two pseudonyms never compare equal across contexts.',
      contexts: [...new Set(all.map((item) => item.observer?.context).filter(Boolean))].sort(),
    },
    counts: {
      capsules: all.length,
      ...byState,
      withheldSecrets: all.filter((item) => item.redaction?.counts?.secret).length,
      cited: [...citedBy.keys()].filter((id) => all.some((item) => item.capsuleId === id))
        .length,
      hosts: hosts.length,
    },
    hosts,
    capsules: all
      .sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)))
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined)
      .map((capsule) => ({
        ...presentCapsule(capsule, { now }),
        citedBy: citedBy.get(capsule.capsuleId) ?? [],
      })),
  }
}

/* Matches executionJournal.resultsOf: instant plans record under sideResults. */
function resultsOf(job) {
  if (Array.isArray(job?.result?.results)) return job.result.results
  if (Array.isArray(job?.result?.sideResults)) return job.result.sideResults
  return []
}
