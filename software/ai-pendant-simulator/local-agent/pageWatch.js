import path from 'node:path'
import crypto from 'node:crypto'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { getBrowserStatus } from './browserBridge.js'
import {
  addressPage,
  excerptAround,
  isHttpUrl,
  runBrowserActions,
} from './browserPage.js'
import { workspacePath } from './config.js'
import { usableCapsuleIds } from './evidenceCapsules.js'
import { appendLog } from './logger.js'
import { normalizeFollowUp, prepareDraft } from './pageWatchDrafts.js'
import {
  DEFAULT_THRESHOLD,
  HISTORY_DEPTH,
  SEGMENT_THRESHOLD_CHARS,
  diffSegmentSets,
  digestSegments,
  filterSegmentNoise,
  normalize,
  scoreChange,
  scoreSegmentChange,
  shortHash,
} from './pageWatchSignal.js'
import { nextRunAt } from './routines.js'

/*
 * "Tell me when it changes" — and nothing the rest of the time.
 *
 * The asks this answers were all one sentence away from each other: watch an
 * authenticated order, appointment or account page; tell me ONLY what changed;
 * tell me only when it is MEANINGFUL; prepare any follow-up but do not submit
 * it; save the evidence. So the whole feature is a poll, a diff, a judgement
 * about that diff, and a report that only exists when the judgement says so.
 *
 * The judgement is not optional decoration on the diff. A watcher that speaks
 * on every diff is a notification the owner turns off in a day — and once it is
 * off, it also fails to tell them the one thing that mattered, so it is worse
 * than not having built it. pageWatchSignal.js is where that decision lives and
 * why it is made structurally rather than from a table of site rules.
 *
 * Authentication needs no special handling: the extension drives the owner's
 * own Safari, so a logged-in page is already logged in. That is the entire
 * reason to watch through the browser instead of fetching the URL, and it is
 * also why the evidence discipline matters more here than anywhere else in this
 * stack — these are readings nobody else can go and re-check.
 *
 * The schedule shape is routines.js's, and nextRunAt is imported from it so the
 * two features cannot drift on what "every N minutes" means. The polling does
 * not run *through* a routine, because a routine is planned by the LLM on every
 * fire: a poll whose job is to notice that one character of a price changed
 * must be byte-deterministic and must cost nothing, and a model round trip per
 * poll is neither.
 */
const STORE_PATH = path.join(workspacePath, '.pendant-page-watches.json')
const TICK_MS = Number(process.env.PENDANT_WATCH_TICK_MS || 30_000)

/* The full list of things a watcher is allowed to do to a page. There is no
 * click, no type, no press_key: the owner asked for a reader, and this is the
 * line that makes it one. navigate is here because re-fetching the watched URL
 * is the only way a page ever shows new content — it is the GET behind ⌘R. */
const WATCH_READ_ONLY = new Set(['list_tabs', 'navigate', 'read_page'])

const MAX_REPORTS_PER_WATCH = 25
const MAX_FIELD_CHARS = 400
const MIN_INTERVAL_MS = 60_000

/*
 * How soon to look again when Safari is not there.
 *
 * The extension has been offline for most of this system's life — the honest
 * baseline to design against, not the exception. Two things follow.
 *
 * First, a scheduled poll checks the heartbeat BEFORE it queues anything.
 * browserBridge expires commands after 90s precisely because a queued command
 * with no extension to run it becomes a navigation that fires in the owner's
 * browser at some unrelated later moment; a watch on a 15-minute cadence would
 * feed that queue four times an hour, forever, for nothing.
 *
 * Second, a daily watch must not lose its day because Safari happened to be
 * closed at 08:00. So a deferred watch retries on this short cadence rather
 * than on its own — it is an in-process map lookup, it costs nothing, and it
 * fires the moment the browser comes back.
 */
const OFFLINE_RETRY_MS = 60_000

const isValidStore = (value) => value && Array.isArray(value.watches)

function load(filePath = STORE_PATH) {
  ensureJsonStore(filePath, { watches: [] }, { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: { watches: [] },
    validate: isValidStore,
  })
}

function save(store, filePath = STORE_PATH) {
  writeJsonAtomic(filePath, store)
}

/**
 * What to pull out of the page, in the shape the owner described it.
 *
 * "the status, price, or availability" is three named things, not one blob, so
 * a change report can say which one moved. A field is located by a CSS
 * selector, by a SEMANTIC ANCHOR, or by a regular expression over the text —
 * combinable, selector or anchor first to narrow, pattern to pick the value out
 * of what that found.
 *
 * The anchor exists because a selector is a bet on the page's markup and the
 * owner is not there when it loses. `.order-status-value` stops matching the
 * week the site ships a redesign, and the watch then reports "the value is no
 * longer on the page" every poll until someone fixes it by hand. The words next
 * to the value — "Order status", "Total", "Appointment" — survive redesigns,
 * because they are what the page is telling a human. Neither is per-site
 * knowledge in the code: both come out of the watch definition.
 */
export function normalizeFields(input) {
  const list = Array.isArray(input) ? input : []
  const fields = list
    .map((raw, index) => {
      if (typeof raw === 'string') return baseField({ name: raw || `field_${index}`, selector: raw })
      if (!raw || typeof raw !== 'object') return null
      const name = String(raw.name || raw.field || raw.label || `field_${index}`).slice(0, 60)
      const pattern = String(raw.pattern ?? raw.regex ?? '').trim()
      if (pattern) {
        /* Fail here, not on the first poll at 3am. */
        try {
          new RegExp(pattern, String(raw.flags ?? 'i'))
        } catch {
          throw new Error(`Field "${name}" has an invalid pattern: ${pattern}`)
        }
      }
      return baseField({
        name,
        selector: String(raw.selector ?? '').trim() || null,
        anchor: String(raw.anchor ?? raw.label ?? '').trim() || null,
        pattern: pattern || null,
        flags: String(raw.flags ?? 'i'),
        mode: String(raw.mode ?? '').trim() || null,
        take: Number(raw.take) > 0 ? Math.min(400, Number(raw.take)) : null,
        /* The owner's own bar for this field, in the units the field is in.
         * "tell me if the price moves more than 5%" is a threshold; "tell me if
         * anything about it changes" is its absence. */
        minDelta: Number.isFinite(Number(raw.minDelta)) ? Number(raw.minDelta) : null,
        minPercent: Number.isFinite(Number(raw.minPercent)) ? Number(raw.minPercent) : null,
      })
    })
    .filter(Boolean)

  if (!fields.length) {
    /* "Tell me when this page changes" is a legitimate ask on its own. */
    return [baseField({ name: 'page' })]
  }
  return fields
}

function baseField({
  name,
  selector = null,
  anchor = null,
  pattern = null,
  flags = 'i',
  mode = null,
  take = null,
  minDelta = null,
  minPercent = null,
}) {
  return { name, selector, anchor, pattern, flags, mode, take, minDelta, minPercent }
}

/**
 * Find a value by the words next to it rather than by its markup.
 *
 * Takes what follows the anchor, skipping the punctuation a page puts between a
 * label and its value, and stops at the first thing that reads like the start of
 * the next label — a run of two or more spaces, a newline, or a sentence end.
 * The page's own layout whitespace is doing the work of a delimiter here, which
 * is why the raw text is segmented before normalization elsewhere in this file.
 */
export function extractByAnchor(text, anchor, { take = 80 } = {}) {
  const source = String(text ?? '')
  const needle = normalize(anchor).toLowerCase()
  if (!needle) return null

  const haystack = source.toLowerCase()
  const at = haystack.indexOf(needle)
  if (at < 0) return null

  const after = source
    .slice(at + needle.length)
    .replace(/^[\s:：\-–—>|]+/, '')
  if (!after) return null

  const stop = after.search(/\n|\s{2,}|(?<=[.!?])\s/)
  const value = (stop > 0 ? after.slice(0, stop) : after).slice(0, take)
  return normalize(value) || null
}

export function listWatches({ filePath = STORE_PATH } = {}) {
  return load(filePath).watches
}

export function getWatch(id, { filePath = STORE_PATH } = {}) {
  return load(filePath).watches.find((watch) => watch.id === id) ?? null
}

export function createWatch(
  {
    name,
    url,
    fields,
    everyMs,
    schedule,
    readMode,
    reload,
    threshold,
    followUp,
    enabled = true,
  } = {},
  { filePath = STORE_PATH } = {},
) {
  const target = String(url ?? '').trim()
  if (!isHttpUrl(target)) {
    throw new Error('A watch needs an http(s) url to watch.')
  }

  const chosen =
    schedule && schedule.kind
      ? schedule
      : { kind: 'interval', everyMs: Math.max(MIN_INTERVAL_MS, Number(everyMs) || 900_000) }
  const due = nextRunAt(chosen)
  if (due === null) {
    throw new Error(
      'schedule must be {kind:"interval", everyMs:N} or {kind:"daily", at:"HH:MM"}.',
    )
  }

  const store = load(filePath)
  const watch = {
    id: `wch_${crypto.randomUUID()}`,
    name: String(name || target).slice(0, 120),
    url: target,
    fields: normalizeFields(fields),
    readMode: String(readMode || 'main_text'),
    /* Re-fetch by default: a tab left sitting there never changes. */
    reload: reload !== false,
    schedule: chosen,
    /* How sure this has to be before it interrupts. Raising it makes the watch
     * quieter, and every suppressed change is kept with its score so the owner
     * can see what a given setting is costing them. */
    threshold: clampThreshold(threshold),
    /* Validated now so a malformed follow-up fails in front of the owner. */
    followUp: normalizeFollowUp(followUp),
    enabled: Boolean(enabled),
    createdAt: new Date().toISOString(),
    nextRunAt: due,
    lastCheckedAt: null,
    lastError: null,
    checkCount: 0,
    changeCount: 0,
    suppressedCount: 0,
    missedChecks: 0,
    offlineSince: null,
    observed: null,
    previous: null,
    /* Per field: recent values oldest-first, for learning how often it moves;
     * and the value the owner was last actually told, which is what a numeric
     * threshold is measured from. */
    history: {},
    anchors: {},
    reports: [],
    suppressed: [],
  }
  store.watches.push(watch)
  save(store, filePath)
  return watch
}

function clampThreshold(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_THRESHOLD
  return Math.max(0, Math.min(1, number))
}

export function updateWatch(id, patch = {}, { filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const watch = store.watches.find((entry) => entry.id === id)
  if (!watch) return null

  if (typeof patch.enabled === 'boolean') watch.enabled = patch.enabled
  if (patch.name) watch.name = String(patch.name).slice(0, 120)
  if (patch.url) {
    if (!isHttpUrl(patch.url)) throw new Error('A watch needs an http(s) url to watch.')
    watch.url = String(patch.url)
    /* A different page invalidates every baseline taken from the old one —
     * including the learned churn, which described a different page's fields. */
    forgetBaseline(watch)
  }
  if (patch.fields) {
    watch.fields = normalizeFields(patch.fields)
    forgetBaseline(watch)
  }
  if (patch.readMode) watch.readMode = String(patch.readMode)
  if (typeof patch.reload === 'boolean') watch.reload = patch.reload
  if (patch.threshold !== undefined) watch.threshold = clampThreshold(patch.threshold)
  if (patch.followUp !== undefined) {
    watch.followUp = patch.followUp === null ? null : normalizeFollowUp(patch.followUp)
  }
  if (patch.schedule || patch.everyMs) {
    const chosen = patch.schedule?.kind
      ? patch.schedule
      : { kind: 'interval', everyMs: Math.max(MIN_INTERVAL_MS, Number(patch.everyMs) || 0) }
    const due = nextRunAt(chosen)
    if (due === null) throw new Error('Invalid schedule.')
    watch.schedule = chosen
    watch.nextRunAt = due
  }

  save(store, filePath)
  return watch
}

function forgetBaseline(watch) {
  watch.observed = null
  watch.previous = null
  watch.history = {}
  watch.anchors = {}
}

export function deleteWatch(id, { filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const before = store.watches.length
  store.watches = store.watches.filter((watch) => watch.id !== id)
  if (store.watches.length === before) return false
  save(store, filePath)
  return true
}

/**
 * Everything the owner has not been told yet, newest first.
 *
 * A report whose evidence has been revoked keeps its row and loses its
 * contents. Dropping it entirely would make a revocation look like a change
 * that never happened; showing the before/after would make "delete that page"
 * mean nothing. The middle answer is the honest one, and it is derived here on
 * read so no purge has to be remembered.
 */
export function pendingReports({ filePath = STORE_PATH, now = Date.now() } = {}) {
  return load(filePath)
    .watches.flatMap((watch) =>
      (watch.reports ?? [])
        .filter((report) => !report.acknowledged)
        .map((report) => ({ ...report, watchId: watch.id, name: watch.name, url: watch.url })),
    )
    .map((report) => withheldIfRevoked(report, now))
    .sort((left, right) => String(right.at).localeCompare(String(left.at)))
}

/*
 * Evidence is checked on two sides, because a change is a claim about two
 * readings and they can be withheld independently.
 *
 * The 'after' capsules are what the report stands on: revoke those and there is
 * nothing left to show. The 'before' capsules are what makes it a CHANGE rather
 * than an observation, and they expire first — the capsule TTL is 24 hours and a
 * once-a-day watch is the cadence the owner asked for by name, so the baseline
 * evidence for a daily watch is always at the edge of expiry when the next poll
 * cites it. Withholding the whole report for that would delete the feature on
 * its most-requested schedule; saying "the before-value can no longer be
 * verified" keeps the news and is true.
 */
function withheldIfRevoked(report, now) {
  const after = usableCapsuleIds(report.capsuleIds ?? [], { now })
  const before = usableCapsuleIds(report.priorCapsuleIds ?? [], { now })

  if (after.withheld.length) {
    return {
      ...report,
      changes: [],
      summary: `${report.name}: a change was recorded, but the evidence for it is no longer available.`,
      evidenceWithheld: after.withheld,
    }
  }

  if (before.withheld.length) {
    return {
      ...report,
      priorEvidenceWithheld: before.withheld,
      evidenceNote:
        'The reading this was compared against is no longer available, so the before-value cannot be re-verified.',
    }
  }

  return report
}

/** Said out loud once; not said again. */
export function acknowledgeReports(id, { filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const watch = store.watches.find((entry) => entry.id === id)
  if (!watch) return 0
  let count = 0
  for (const report of watch.reports ?? []) {
    if (!report.acknowledged) {
      report.acknowledged = true
      count += 1
    }
  }
  save(store, filePath)
  return count
}

/**
 * What a watch has been suppressing, and why it scored the way it did.
 *
 * A quiet watcher and a broken watcher look identical from outside, and the
 * difference matters enormously: one is working and one has been silently
 * dropping the thing the owner set it up for. Every suppressed change is kept
 * with its score and its reasons so "what have you not been telling me" has an
 * answer, and so a threshold that is set too high is discoverable rather than
 * invisible.
 */
export function suppressedChanges(id, { filePath = STORE_PATH, limit = 25 } = {}) {
  const watch = getWatch(id, { filePath })
  if (!watch) return []
  return (watch.suppressed ?? []).slice(0, limit)
}

function applyPattern(text, field) {
  if (!field.pattern) return String(text ?? '')
  const match = normalize(text).match(new RegExp(field.pattern, field.flags || 'i'))
  if (!match) return null
  /* A capture group is the owner saying "this part", not the whole match. */
  return normalize(match[1] ?? match[0])
}

/**
 * Read every field in one browser round trip.
 *
 * Each read costs an extension poll, so the page-level read and every
 * selector-scoped read go out as a single /execute batch. Anchor-located fields
 * cost nothing extra: they are found in the page text that was fetched anyway,
 * which is a second reason to prefer them.
 */
export async function readWatchValues(watch, target, { options = {} } = {}) {
  const selectorFields = watch.fields.filter((field) => field.selector)
  const actions = [
    {
      type: 'browser_read_page',
      label: `read ${watch.name}`,
      params: { ...target, mode: watch.readMode || 'main_text', maxChars: 20_000 },
    },
    ...selectorFields.map((field) => ({
      type: 'browser_read_page',
      label: `read ${field.name}`,
      params: {
        ...target,
        mode: field.mode || 'text',
        selector: field.selector,
        maxChars: 4_000,
      },
    })),
  ]

  const results = await runBrowserActions(actions, {
    ...options,
    allow: WATCH_READ_ONLY,
  })

  const pageResult = results[0]
  if (!pageResult?.ok) {
    throw new Error(pageResult?.error || 'The page could not be read.')
  }
  const pageText = String(pageResult.data?.content ?? '')

  const raw = {}
  const missing = []
  let cursor = 1
  for (const field of watch.fields) {
    let source = pageText
    if (field.selector) {
      const scoped = results[cursor]
      cursor += 1
      if (!scoped?.ok) {
        /* A selector that stopped matching is itself news — the page changed
         * shape — so it is recorded as a value, not swallowed as an error. */
        raw[field.name] = null
        missing.push({ field: field.name, reason: scoped?.error || 'not found' })
        continue
      }
      source = String(scoped.data?.content ?? '')
    }

    if (field.anchor) {
      const located = extractByAnchor(source, field.anchor, {
        take: field.take ?? 80,
      })
      if (located === null) {
        raw[field.name] = null
        missing.push({ field: field.name, reason: `anchor "${field.anchor}" not found` })
        continue
      }
      source = located
    }

    /*
     * Newlines survive when there is no pattern.
     *
     * A whole-page field is diffed line by line, and collapsing the page to one
     * line first destroys the only structure that makes that possible. An
     * earlier cut normalized here and then truncated to 400 characters, which
     * meant a page-level watch compared the first 400 characters of the page
     * and was blind to everything after them — a change three screens down was
     * silently invisible rather than merely noisy.
     */
    raw[field.name] = applyPattern(source, field)
    if (raw[field.name] === null) {
      missing.push({ field: field.name, reason: 'pattern did not match' })
    }
  }

  const values = {}
  for (const [name, value] of Object.entries(raw)) {
    values[name] = value === null ? null : normalize(value).slice(0, MAX_FIELD_CHARS)
  }

  return {
    values,
    raw,
    missing,
    pageText,
    title: String(pageResult.data?.title ?? ''),
    url: String(pageResult.data?.url ?? ''),
    /* One per read in the batch — the whole-page read plus every scoped one.
     * A per-field selector read is separate evidence from the page it was
     * scoped out of, and a report that cites one field should not have to
     * claim the whole page as its source. */
    capsuleIds: results
      .filter((entry) => entry?.ok)
      .map((entry) => entry.data?.evidence?.capsuleId)
      .filter(Boolean),
  }
}

/** Field-by-field, with the words around the new value as evidence. */
export function diffValues(before, after, pageText = '') {
  const names = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  return names
    .filter((name) => (before?.[name] ?? null) !== (after?.[name] ?? null))
    .map((name) => ({
      field: name,
      before: before?.[name] ?? null,
      after: after?.[name] ?? null,
      excerpt: after?.[name] ? excerptAround(pageText, after[name]) : '',
    }))
}

/**
 * Build the observation a watch stores: display values, full-fidelity digests,
 * and line digests for anything too long to diff as a blob.
 *
 * Change detection runs on the digest, never on the display value. Those are
 * different jobs — one has to be exact and the other has to be readable — and
 * the version that used one string for both is what made a page-level watch
 * blind past its 400th character.
 */
export function buildObservation(watch, read, { at, page = {} } = {}) {
  const raw = read.raw ?? read.values ?? {}
  const digests = {}
  const segments = {}

  for (const field of watch.fields) {
    const value = raw[field.name] ?? null
    digests[field.name] = value === null ? null : shortHash(normalize(value))
    segments[field.name] =
      value !== null && String(value).length > SEGMENT_THRESHOLD_CHARS
        ? digestSegments(value)
        : null
  }

  return {
    at,
    url: read.url || page.url || watch.url,
    title: read.title || page.title || '',
    values: read.values ?? {},
    digests,
    segments,
    missing: read.missing ?? [],
    disposition: page.disposition ?? null,
    capsuleIds: [...new Set((read.capsuleIds ?? []).filter(Boolean))],
  }
}

/**
 * Every field that moved, scored, with the noise separated from the news.
 *
 * Returns both lists. The suppressed one is not thrown away: see
 * suppressedChanges — a watcher nobody can audit is a watcher nobody should
 * trust to stay quiet.
 */
export function judgeChanges(watch, before, after, { pageText = '' } = {}) {
  const meaningful = []
  const suppressed = []
  const threshold = clampThreshold(watch.threshold)

  for (const field of watch.fields ?? []) {
    const name = field.name
    const beforeDigest = before?.digests?.[name] ?? null
    const afterDigest = after?.digests?.[name] ?? null

    /* Older stores predate digests; fall back to the display values so an
     * upgrade in place does not report every field as changed once. */
    const changed =
      before?.digests && after?.digests
        ? beforeDigest !== afterDigest
        : (before?.values?.[name] ?? null) !== (after?.values?.[name] ?? null)
    if (!changed) continue

    const beforeValue = before?.values?.[name] ?? null
    const afterValue = after?.values?.[name] ?? null
    const history = (watch.history?.[name] ?? []).slice(-HISTORY_DEPTH)
    const anchor = watch.anchors?.[name]

    const beforeSegments = before?.segments?.[name] ?? null
    const afterSegments = after?.segments?.[name] ?? null

    let verdict
    let entry

    if (beforeSegments || afterSegments) {
      /*
       * A long field is diffed by line, because the alternative is comparing
       * two four-thousand-character strings, which always differ and never
       * says why. This is also the only case where the noise filter is load
       * bearing rather than nice: nearly every page renders a clock somewhere,
       * so without it a whole-page watch fires on every single poll.
       */
      const raw = diffSegmentSets(beforeSegments ?? [], segmentTextOf(after, name, pageText))
      const filtered = filterSegmentNoise(raw)
      verdict = scoreSegmentChange(filtered, { threshold, history })
      entry = {
        field: name,
        kind: 'segments',
        before: null,
        after: null,
        segments: {
          edits: filtered.edits.slice(0, 10),
          added: filtered.added.slice(0, 10),
          removed: filtered.removed.slice(0, 10),
          ignored: filtered.noisy.length,
        },
        excerpt: filtered.edits[0]?.after ?? filtered.added[0] ?? '',
      }
    } else {
      verdict = scoreChange({
        before: beforeValue,
        after: afterValue,
        anchor,
        history,
        minDelta: field.minDelta,
        minPercent: field.minPercent,
        threshold,
      })
      entry = {
        field: name,
        kind: 'value',
        before: beforeValue,
        after: afterValue,
        excerpt: afterValue ? excerptAround(pageText, afterValue) : '',
      }
    }

    const scored = {
      ...entry,
      score: verdict.score,
      reasons: verdict.reasons,
      threshold,
    }

    if (verdict.meaningful) meaningful.push(scored)
    else suppressed.push(scored)
  }

  return { meaningful, suppressed }
}

/* The current text of a long field. Kept as a helper because the page-level
 * field's text is the page read itself, while a scoped field's is its own. */
function segmentTextOf(observation, name, pageText) {
  const value = observation?.raw?.[name]
  if (typeof value === 'string') return value
  return name === 'page' ? pageText : String(observation?.values?.[name] ?? '')
}

/** One line the pendant can say out loud. */
export function describeChanges(changes, name) {
  if (!changes.length) return `${name}: nothing changed.`
  return `${name}: ${changes
    .map((change) => {
      if (change.kind === 'segments') {
        const parts = change.segments ?? {}
        const edited = parts.edits?.[0]
        if (edited) return `${edited.before} → ${edited.after}`
        if (parts.added?.length) return `new: ${parts.added[0]}`
        if (parts.removed?.length) return `gone: ${parts.removed[0]}`
        return 'the page changed'
      }
      return `${change.field} ${change.before ?? '(missing)'} → ${change.after ?? '(gone)'}`
    })
    .join('; ')}`
}

/**
 * Poll one watch and say only what moved, and only if it mattered.
 *
 * The first check is a baseline and never reports: "tell me when the status
 * changes" cannot be answered by the first time anyone looked at it.
 *
 * This path always attempts the browser, even when the extension is known to be
 * offline, because the only callers are the owner asking directly and a tick
 * that has already checked. An owner who says "check it now" is entitled to the
 * attempt and to the real error if it fails.
 */
export async function checkWatch(
  id,
  {
    filePath = STORE_PATH,
    options = {},
    /* Seams, so the baseline-then-diff promise can be tested without a live
     * browser on the other end. Production never passes them. */
    address = addressPage,
    read: readValues = readWatchValues,
    now = Date.now(),
    /* The draft store, separately addressable so a test can watch a page
     * without leaving follow-ups in the owner's real workspace. */
    draftStore = {},
  } = {},
) {
  const watch = getWatch(id, { filePath })
  if (!watch) throw new Error(`No watch ${id}`)

  const startedAt = new Date(now).toISOString()
  /*
   * Claim the slot before doing the work, not after.
   *
   * A poll holds the browser for several seconds, and the tick that fired
   * while it was still running found the same watch still due and started a
   * second one. Both finished against the same page and the owner was told
   * about one change twice.
   */
  commit(id, filePath, (stored) => {
    stored.nextRunAt = nextRunAt(stored.schedule, now)
  })
  const callOptions = {
    command: `watch ${watch.name}`,
    source: 'page-watch',
    allow: WATCH_READ_ONLY,
    ...options,
  }

  let outcome
  try {
    const page = await address(watch.url, {
      reload: watch.reload !== false,
      options: callOptions,
    })
    const read = await readValues(watch, page.target, { options: callOptions })
    const observation = buildObservation(watch, read, { at: startedAt, page })
    const baseline = !watch.observed
    const judged = baseline
      ? { meaningful: [], suppressed: [] }
      : judgeChanges(
          watch,
          watch.observed,
          { ...observation, raw: read.raw ?? read.values },
          { pageText: read.pageText ?? '' },
        )

    const capsuleIds = observation.capsuleIds
    const priorCapsuleIds = watch.observed?.capsuleIds ?? []

    let report = null
    if (judged.meaningful.length) {
      report = {
        id: `rpt_${crypto.randomUUID()}`,
        at: startedAt,
        url: observation.url,
        title: observation.title,
        changes: judged.meaningful,
        summary: describeChanges(judged.meaningful, watch.name),
        acknowledged: false,
        /* Both sides of the comparison. A change is a claim about two
         * readings, and citing only the current one makes the "since the last
         * time I looked" half of the promise unverifiable. */
        capsuleIds,
        priorCapsuleIds,
        /* What was NOT said, so a report is also a record of the judgement. */
        alsoChanged: judged.suppressed.map((change) => ({
          field: change.field,
          score: change.score,
          reasons: change.reasons,
        })),
      }
    }

    /*
     * A follow-up is prepared, never performed.
     *
     * prepareDraft cannot reach the browser — pageWatchDrafts.js imports
     * nothing that can — so this line is incapable of submitting anything no
     * matter what the follow-up definition says.
     */
    let draft = null
    if (report && watch.followUp) {
      draft = prepareDraft(
        {
          watchId: watch.id,
          watchName: watch.name,
          followUp: watch.followUp,
          change: { changes: judged.meaningful, summary: report.summary },
          values: observation.values,
          capsuleIds,
          url: observation.url,
          now,
        },
        draftStore,
      )
      if (draft) report.draftId = draft.id
    }

    outcome = {
      ok: true,
      watchId: watch.id,
      name: watch.name,
      baseline,
      changed: judged.meaningful.length > 0,
      changes: judged.meaningful,
      suppressed: judged.suppressed,
      values: observation.values,
      missing: observation.missing,
      url: observation.url,
      title: observation.title,
      checkedAt: startedAt,
      capsuleIds,
      priorCapsuleIds,
      report,
      draft,
      summary: baseline
        ? `${watch.name}: baseline recorded, nothing to report yet.`
        : judged.meaningful.length
          ? describeChanges(judged.meaningful, watch.name)
          : judged.suppressed.length
            ? `${watch.name}: ${judged.suppressed.length} change(s), none of them meaningful.`
            : `${watch.name}: nothing changed.`,
    }

    commit(watch.id, filePath, (stored) => {
      stored.previous = stored.observed
      stored.observed = observation
      stored.lastError = null
      stored.offlineSince = null
      rememberValues(stored, observation)

      /*
       * The anchor starts at the baseline, not at the first report.
       *
       * Without this a brand-new watch has no anchor at all, every step is
       * therefore measured against the previous reading, and a value drifting
       * 0.4% per poll never trips a 1% bar — the exact creep the anchor exists
       * to stop, reintroduced by the field simply never having been reported
       * yet. The baseline is what the owner would have seen if they had looked,
       * which is what "the last value you were told" means before there is a
       * report.
       */
      for (const [name, value] of Object.entries(observation.values ?? {})) {
        if (stored.anchors[name] === undefined) stored.anchors[name] = value
      }

      if (report) {
        /*
         * The anchor then only moves when the owner is told.
         *
         * This is what stops a threshold from being defeated by creep: a price
         * drifting 0.4% per poll never trips a 1% bar on any single step, and
         * measuring each step against the last REPORTED value instead of the
         * last observed one makes the bar mean what the owner said it meant.
         */
        for (const change of report.changes) {
          if (change.kind === 'value') stored.anchors[change.field] = change.after
        }
        stored.reports.unshift(report)
        stored.reports = stored.reports.slice(0, MAX_REPORTS_PER_WATCH)
        stored.changeCount += 1
      }
      if (judged.suppressed.length) {
        stored.suppressed = [
          ...judged.suppressed.map((change) => ({ ...change, at: startedAt })),
          ...(stored.suppressed ?? []),
        ].slice(0, MAX_REPORTS_PER_WATCH)
        stored.suppressedCount = (stored.suppressedCount ?? 0) + judged.suppressed.length
      }
    })

    if (report) {
      /* The activity log is where the owner already looks for "what did it do
       * while I was away", so a change belongs there and a quiet poll does not. */
      appendLog({
        command: `page watch: ${watch.name}`,
        actions: [{ type: 'page_watch_change', params: { url: watch.url } }],
        status: 'completed',
        result: report,
      })
    }
  } catch (error) {
    const message = String(error?.message || error)
    outcome = {
      ok: false,
      watchId: watch.id,
      name: watch.name,
      changed: false,
      changes: [],
      error: message,
      checkedAt: startedAt,
      summary: `${watch.name}: could not be checked — ${message}`,
    }
    commit(watch.id, filePath, (stored) => {
      stored.lastError = message
    })
  }

  commit(watch.id, filePath, (stored) => {
    stored.lastCheckedAt = startedAt
    stored.checkCount += 1
  })

  return outcome
}

/*
 * What a field has recently held, oldest first, for learning how often it moves.
 *
 * A long field remembers its DIGEST rather than its display value, because the
 * display value is the first 400 characters and a page that only ever changes
 * below the fold would look permanently stable — the churn test would then
 * never fire on the one field where it matters most. Bounded either way: this
 * is a durable file, and the only question asked of it is a rate, which a short
 * window answers as well as a long one.
 */
function rememberValues(watch, observation) {
  watch.history = watch.history ?? {}
  for (const [name, value] of Object.entries(observation?.values ?? {})) {
    const list = watch.history[name] ?? []
    list.push(observation?.segments?.[name] ? (observation.digests?.[name] ?? null) : (value ?? null))
    watch.history[name] = list.slice(-HISTORY_DEPTH)
  }
}

/* Re-read before writing: a watch created or acknowledged during a poll that
 * took ten seconds must not be lost by writing back a stale copy. */
function commit(id, filePath, mutate) {
  const store = load(filePath)
  const watch = store.watches.find((entry) => entry.id === id)
  if (!watch) return
  watch.history = watch.history ?? {}
  watch.anchors = watch.anchors ?? {}
  watch.suppressed = watch.suppressed ?? []
  mutate(watch)
  save(store, filePath)
}

let timer = null
const inFlight = new Set()

/**
 * Poll everything due, one page at a time — they share the owner's browser.
 *
 * Nothing is queued when Safari is not answering. browserBridge will expire an
 * unclaimed command after 90 seconds, which bounds the damage but does not
 * prevent it: a watch on a fifteen-minute cadence against an extension that has
 * been offline for weeks would enqueue, and expire, thousands of navigations
 * that only ever existed to be thrown away — and any that were claimed late
 * would open tabs in the owner's browser hours after anyone wanted them.
 */
export async function tickPageWatches(
  now = Date.now(),
  { filePath = STORE_PATH, status = getBrowserStatus } = {},
) {
  const due = load(filePath).watches.filter(
    (watch) =>
      watch.enabled &&
      watch.nextRunAt &&
      watch.nextRunAt <= now &&
      !inFlight.has(watch.id),
  )
  if (!due.length) return []

  const online = Boolean(safeStatus(status)?.online)
  if (!online) {
    return due.map((watch) => {
      commit(watch.id, filePath, (stored) => {
        stored.nextRunAt = now + OFFLINE_RETRY_MS
        stored.missedChecks = (stored.missedChecks ?? 0) + 1
        stored.offlineSince = stored.offlineSince ?? new Date(now).toISOString()
      })
      return {
        ok: false,
        watchId: watch.id,
        name: watch.name,
        skipped: 'browser-offline',
        summary: `${watch.name}: not checked — the browser extension is not connected.`,
      }
    })
  }

  const results = []
  for (const watch of due) {
    inFlight.add(watch.id)
    try {
      results.push(await checkWatch(watch.id, { filePath }))
    } catch (error) {
      results.push({
        ok: false,
        watchId: watch.id,
        error: String(error?.message || error),
      })
    } finally {
      inFlight.delete(watch.id)
    }
  }
  return results
}

/* The heartbeat registry lives in this process, so reading it is a map lookup
 * — but a status probe that throws must not be what stops every watch. */
function safeStatus(status) {
  try {
    return status()
  } catch {
    return { online: false }
  }
}

/**
 * Whether these watches are actually working, as opposed to merely quiet.
 *
 * The two are indistinguishable from the outside and this system has spent most
 * of its life in the second state — the extension offline, every watch enabled,
 * nothing reported, nothing wrong-looking. So a watch that has never once
 * managed to read its page says so, loudly, rather than sitting in the list
 * looking healthy.
 */
export function watchHealth({ filePath = STORE_PATH, now = Date.now() } = {}) {
  const watches = load(filePath).watches
  const rows = watches.map((watch) => {
    const lastChecked = Date.parse(watch.lastCheckedAt ?? '')
    const staleForMs = Number.isFinite(lastChecked) ? now - lastChecked : null
    return {
      watchId: watch.id,
      name: watch.name,
      url: watch.url,
      enabled: Boolean(watch.enabled),
      neverChecked: !watch.observed,
      lastCheckedAt: watch.lastCheckedAt,
      staleForMs,
      missedChecks: watch.missedChecks ?? 0,
      offlineSince: watch.offlineSince ?? null,
      lastError: watch.lastError ?? null,
      checkCount: watch.checkCount ?? 0,
      changeCount: watch.changeCount ?? 0,
      suppressedCount: watch.suppressedCount ?? 0,
      threshold: watch.threshold ?? DEFAULT_THRESHOLD,
      pendingReports: (watch.reports ?? []).filter((report) => !report.acknowledged).length,
    }
  })

  const blocked = rows.filter((row) => row.enabled && row.neverChecked)
  return {
    online: Boolean(safeStatus(getBrowserStatus)?.online),
    watches: rows,
    /* Said in words because this is the sentence the owner needs and would
     * otherwise have to infer from a table of counters. */
    summary: !rows.length
      ? 'Nothing is being watched.'
      : blocked.length
        ? `${blocked.length} of ${rows.length} watch(es) have never managed to read their page — most likely the browser extension has not been connected.`
        : `${rows.length} watch(es), ${rows.reduce((total, row) => total + row.pendingReports, 0)} unread report(s).`,
  }
}

export function startPageWatchScheduler() {
  if (timer) return
  timer = setInterval(() => {
    tickPageWatches().catch(() => {
      /* A failing watch is recorded on the watch itself; the loop lives. */
    })
  }, TICK_MS)
  timer.unref?.()
}

export function stopPageWatchScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

export const pageWatchLocation = () => STORE_PATH
