import path from 'node:path'
import crypto from 'node:crypto'

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
  runBrowserActions,
} from './browserPage.js'
import { workspacePath } from './config.js'
import { appendLog } from './logger.js'
import { nextRunAt } from './routines.js'

/*
 * "Tell me when it changes" — and nothing the rest of the time.
 *
 * The asks this answers were all one sentence away from each other: watch an
 * authenticated page for a status, a price, an availability; watch a logged-in
 * page and say when the status changes; and, said out loud by one agent,
 * "don't click anything or send anything". So the whole feature is a poll, a
 * diff, and a report that only exists when the diff is non-empty. A watcher
 * that speaks on every poll is a notification the owner turns off in a day.
 *
 * Authentication needs no special handling: the extension drives the owner's
 * own Safari, so a logged-in page is already logged in. That is the entire
 * reason to watch through the browser instead of fetching the URL.
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
 * a change report can say which one moved. A field is a CSS selector, a regular
 * expression over the page text, or both — selector first to narrow, pattern to
 * pick the value out of it.
 */
export function normalizeFields(input) {
  const list = Array.isArray(input) ? input : []
  const fields = list
    .map((raw, index) => {
      if (typeof raw === 'string') return { name: raw || `field_${index}`, selector: raw }
      if (!raw || typeof raw !== 'object') return null
      const name = String(raw.name || raw.field || raw.label || `field_${index}`).slice(0, 60)
      const selector = String(raw.selector ?? '').trim()
      const pattern = String(raw.pattern ?? raw.regex ?? '').trim()
      if (pattern) {
        /* Fail here, not on the first poll at 3am. */
        try {
          new RegExp(pattern, String(raw.flags ?? 'i'))
        } catch {
          throw new Error(`Field "${name}" has an invalid pattern: ${pattern}`)
        }
      }
      return {
        name,
        selector: selector || null,
        pattern: pattern || null,
        flags: String(raw.flags ?? 'i'),
        mode: String(raw.mode ?? '').trim() || null,
      }
    })
    .filter(Boolean)

  if (!fields.length) {
    /* "Tell me when this page changes" is a legitimate ask on its own. */
    return [{ name: 'page', selector: null, pattern: null, flags: 'i', mode: null }]
  }
  return fields
}

export function listWatches({ filePath = STORE_PATH } = {}) {
  return load(filePath).watches
}

export function getWatch(id, { filePath = STORE_PATH } = {}) {
  return load(filePath).watches.find((watch) => watch.id === id) ?? null
}

export function createWatch(
  { name, url, fields, everyMs, schedule, readMode, reload, enabled = true } = {},
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
    enabled: Boolean(enabled),
    createdAt: new Date().toISOString(),
    nextRunAt: due,
    lastCheckedAt: null,
    lastError: null,
    checkCount: 0,
    changeCount: 0,
    observed: null,
    previous: null,
    reports: [],
  }
  store.watches.push(watch)
  save(store, filePath)
  return watch
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
    /* A different page invalidates every baseline taken from the old one. */
    watch.observed = null
    watch.previous = null
  }
  if (patch.fields) {
    watch.fields = normalizeFields(patch.fields)
    watch.observed = null
    watch.previous = null
  }
  if (patch.readMode) watch.readMode = String(patch.readMode)
  if (typeof patch.reload === 'boolean') watch.reload = patch.reload
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

export function deleteWatch(id, { filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const before = store.watches.length
  store.watches = store.watches.filter((watch) => watch.id !== id)
  if (store.watches.length === before) return false
  save(store, filePath)
  return true
}

/** Everything the owner has not been told yet, newest first. */
export function pendingReports({ filePath = STORE_PATH } = {}) {
  return load(filePath)
    .watches.flatMap((watch) =>
      (watch.reports ?? [])
        .filter((report) => !report.acknowledged)
        .map((report) => ({ ...report, watchId: watch.id, name: watch.name, url: watch.url })),
    )
    .sort((left, right) => String(right.at).localeCompare(String(left.at)))
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

function applyPattern(text, field) {
  if (!field.pattern) return normalizeText(text).slice(0, MAX_FIELD_CHARS)
  const match = normalizeText(text).match(new RegExp(field.pattern, field.flags || 'i'))
  if (!match) return null
  /* A capture group is the owner saying "this part", not the whole match. */
  return normalizeText(match[1] ?? match[0]).slice(0, MAX_FIELD_CHARS)
}

/**
 * Read every field in one browser round trip.
 *
 * Each read costs an extension poll, so the page-level read and every
 * selector-scoped read go out as a single /execute batch.
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

  const values = {}
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
        values[field.name] = null
        missing.push({ field: field.name, reason: scoped?.error || 'not found' })
        continue
      }
      source = String(scoped.data?.content ?? '')
    }
    values[field.name] = applyPattern(source, field)
    if (values[field.name] === null) {
      missing.push({ field: field.name, reason: 'pattern did not match' })
    }
  }

  return {
    values,
    missing,
    pageText,
    title: String(pageResult.data?.title ?? ''),
    url: String(pageResult.data?.url ?? ''),
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

/** One line the pendant can say out loud. */
export function describeChanges(changes, name) {
  if (!changes.length) return `${name}: nothing changed.`
  return `${name}: ${changes
    .map(
      (change) =>
        `${change.field} ${change.before ?? '(missing)'} → ${change.after ?? '(gone)'}`,
    )
    .join('; ')}`
}

/**
 * Poll one watch and say only what moved.
 *
 * The first check is a baseline and never reports: "tell me when the status
 * changes" cannot be answered by the first time anyone looked at it.
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
  } = {},
) {
  const watch = getWatch(id, { filePath })
  if (!watch) throw new Error(`No watch ${id}`)

  const startedAt = new Date().toISOString()
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
    const baseline = !watch.observed
    const changes = baseline
      ? []
      : diffValues(watch.observed.values, read.values, read.pageText)

    const observation = {
      at: startedAt,
      url: read.url || page.url,
      title: read.title || page.title,
      values: read.values,
      missing: read.missing,
      disposition: page.disposition,
    }

    let report = null
    if (changes.length) {
      report = {
        id: `rpt_${crypto.randomUUID()}`,
        at: startedAt,
        url: observation.url,
        title: observation.title,
        changes,
        summary: describeChanges(changes, watch.name),
        acknowledged: false,
      }
    }

    outcome = {
      ok: true,
      watchId: watch.id,
      name: watch.name,
      baseline,
      changed: changes.length > 0,
      changes,
      values: read.values,
      missing: read.missing,
      url: observation.url,
      title: observation.title,
      checkedAt: startedAt,
      report,
      summary: baseline
        ? `${watch.name}: baseline recorded, nothing to report yet.`
        : describeChanges(changes, watch.name),
    }

    commit(watch.id, filePath, (stored) => {
      stored.previous = stored.observed
      stored.observed = observation
      stored.lastError = null
      if (report) {
        stored.reports.unshift(report)
        stored.reports = stored.reports.slice(0, MAX_REPORTS_PER_WATCH)
        stored.changeCount += 1
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
    stored.nextRunAt = nextRunAt(stored.schedule, Date.now())
  })

  return outcome
}

/* Re-read before writing: a watch created or acknowledged during a poll that
 * took ten seconds must not be lost by writing back a stale copy. */
function commit(id, filePath, mutate) {
  const store = load(filePath)
  const watch = store.watches.find((entry) => entry.id === id)
  if (!watch) return
  mutate(watch)
  save(store, filePath)
}

let timer = null

/** Poll everything due, one page at a time — they share the owner's browser. */
export async function tickPageWatches(now = Date.now(), { filePath = STORE_PATH } = {}) {
  const due = load(filePath).watches.filter(
    (watch) => watch.enabled && watch.nextRunAt && watch.nextRunAt <= now,
  )
  const results = []
  for (const watch of due) {
    try {
      results.push(await checkWatch(watch.id, { filePath }))
    } catch (error) {
      results.push({
        ok: false,
        watchId: watch.id,
        error: String(error?.message || error),
      })
    }
  }
  return results
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
