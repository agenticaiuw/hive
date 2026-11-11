import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'

/*
 * What the browser was asked to do while nothing was listening.
 *
 * Offline is this bridge's normal state, not its failure state. The extension
 * has been unreachable for most of this system's life, and the design that grew
 * around that — a 90s TTL, an extension that refuses anything older — is
 * correct and must not be softened: a queued command that fires hours later
 * opens tabs in the owner's Safari with no relation to anything they were
 * doing. That was observed live and it is why the TTL exists.
 *
 * So this is deliberately NOT a retry queue. Nothing here is ever handed back
 * to an extension automatically. It is the record of what was dropped and why,
 * which is the thing the bridge never had: before it, the only evidence that
 * the browser tier had failed to do anything at all was a queue length that had
 * already been swept to zero. A replay is a thing the owner asks for, in the
 * moment they ask for it, from a list they can see.
 */

const STORE_PATH = path.join(workspacePath, '.pendant-browser-spool.json')

/*
 * BYTES, not entries.
 *
 * This project has already been wedged once by a store that capped a count. A
 * count is a budget written in the wrong unit: five hundred entries is either
 * fifty kilobytes or fifty megabytes depending on what happened to be in them,
 * and the counter reads the same in both cases. Every bound below is a byte
 * bound, and every entry's cost is measured after serialization — the only
 * number that matches what actually lands on disk.
 */
export const MAX_SPOOL_BYTES = 256 * 1024

/*
 * One entry may not eat more than a sixteenth of the store. Without this, a
 * single read_page of a large page could evict everything else on the way in
 * and leave the spool holding exactly one item — technically inside its byte
 * budget, and useless.
 */
export const MAX_ENTRY_BYTES = MAX_SPOOL_BYTES / 16

const isValidStore = (value) =>
  Boolean(value) &&
  Array.isArray(value.entries) &&
  typeof value.dropped === 'object' &&
  value.dropped !== null

const emptyStore = () => ({
  entries: [],
  dropped: { entries: 0, bytes: 0, firstAt: null, lastAt: null },
})

function load(filePath) {
  ensureJsonStore(filePath, emptyStore(), { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: emptyStore(),
    validate: isValidStore,
  })
}

export function browserSpoolLocation() {
  return STORE_PATH
}

/**
 * The size of a value as the writer will actually write it.
 *
 * atomicJsonStore.writeJsonAtomic serialises with an indent of two. This
 * measured without it and the difference was not academic: four hundred spool
 * entries of six hundred characters produced a 306,682-byte file against a
 * 262,144-byte budget the code believed it was inside — 17% over. A budget
 * measured with a different serializer than the writer uses is not a budget,
 * it is a hope with a number on it. browserProvenance.storeBytesOf says the
 * same thing and this is the same correction.
 */
export function spoolBytesOf(entry) {
  try {
    const serialized = JSON.stringify(entry ?? null, null, 2)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8')
  } catch {
    /* Unserialisable is unstorable: price it as maximally expensive so it is
     * evicted first rather than wedging the store. */
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * What one entry costs INSIDE the store, which is not what it costs alone.
 *
 * An entry sits two levels down — store object, then `entries` array — so every
 * line of it gains the four spaces of that nesting, plus the comma and newline
 * that separate it from the next one. Summing entries at indent zero, or even
 * at the store's own indent, understates the array by well over ten percent
 * once there are a few hundred of them.
 */
function nestedBytesOf(entry) {
  const serialized = JSON.stringify(entry ?? null, null, 2)
  if (serialized === undefined) return Number.MAX_SAFE_INTEGER
  const lines = serialized.split('\n').length
  return Buffer.byteLength(serialized, 'utf8') + 4 * lines + 2
}

/* The store as it will be written, with the drop counters at their widest so a
 * budget checked while they are small does not overrun once they grow. */
const envelope = (entries) => ({
  entries,
  dropped: {
    entries: Number.MAX_SAFE_INTEGER,
    bytes: Number.MAX_SAFE_INTEGER,
    firstAt: '0000-00-00T00:00:00.000Z',
    lastAt: '0000-00-00T00:00:00.000Z',
  },
})

/**
 * Shrink one entry until it fits, keeping the parts that identify it.
 *
 * The action's params are what vary in size — a `type` command's text, a
 * navigate's URL — and they are also the least useful part of the record after
 * the fact. What a reader needs is which command, what kind, when, and why it
 * never ran; the params become a bounded preview.
 */
export function fitEntry(entry, maxBytes = MAX_ENTRY_BYTES) {
  if (spoolBytesOf(entry) <= maxBytes) return entry

  const preview = JSON.stringify(entry.action?.params ?? {})
  const trimmed = {
    ...entry,
    action: {
      type: entry.action?.type ?? null,
      label: entry.action?.label ?? null,
      paramsPreview: preview.slice(0, 400),
      paramsBytes: Buffer.byteLength(preview, 'utf8'),
      paramsTruncated: true,
    },
  }

  if (spoolBytesOf(trimmed) <= maxBytes) return trimmed

  /* Nothing recognisable left to trim: keep the identity and say so, rather
   * than dropping the entry and pretending the command never existed. */
  return {
    commandId: trimmed.commandId,
    reason: trimmed.reason,
    queuedAt: trimmed.queuedAt,
    spooledAt: trimmed.spooledAt,
    action: { type: trimmed.action?.type ?? null, paramsTruncated: true },
    oversized: true,
  }
}

/**
 * Record a command that will never run, and keep the store inside its budget.
 *
 * Eviction is oldest-first and always terminates: each pass removes exactly one
 * entry and every entry has been through fitEntry, so a store of one entry is
 * already under the ceiling.
 */
export function spoolBrowserCommand(entry, { filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const stored = fitEntry({
    commandId: entry?.commandId ?? null,
    idempotencyKey: entry?.idempotencyKey ?? null,
    sessionId: entry?.sessionId ?? null,
    affinity: entry?.affinity ?? null,
    action: entry?.action ?? null,
    reason: String(entry?.reason ?? 'unknown'),
    detail: String(entry?.detail ?? '').slice(0, 400),
    attempts: Number(entry?.attempts) || 0,
    browserOnline: Boolean(entry?.browserOnline),
    queuedAt: entry?.queuedAt ?? null,
    spooledAt: new Date().toISOString(),
  })

  store.entries.push(stored)

  const evict = () => {
    const evicted = store.entries.shift()
    store.dropped.entries += 1
    store.dropped.bytes += nestedBytesOf(evicted)
    store.dropped.firstAt = store.dropped.firstAt ?? evicted.spooledAt ?? null
    store.dropped.lastAt = evicted.spooledAt ?? null
    return evicted
  }

  /*
   * Estimate first, because it is cheap: the envelope is priced before anything
   * is admitted — the store is more than its entries and charging only for
   * entries is how a byte budget quietly overruns its file — and each entry is
   * charged at what it costs nested inside the array.
   */
  let used =
    spoolBytesOf(envelope([])) +
    store.entries.reduce((sum, entry) => sum + nestedBytesOf(entry), 0)

  while (store.entries.length > 1 && used > MAX_SPOOL_BYTES) {
    used -= nestedBytesOf(evict())
  }

  /*
   * Then verify, because the estimate above is an estimate. This measures the
   * store as it will actually be written and drops from the oldest end until it
   * genuinely fits, which is what turns the budget into a guarantee rather than
   * an intention. It runs a handful of times at most because the estimate is
   * close. browserProvenance.pruneRecords ends the same way for the same
   * reason.
   */
  while (store.entries.length > 1 && spoolBytesOf(envelope(store.entries)) > MAX_SPOOL_BYTES) {
    evict()
  }

  writeJsonAtomic(filePath, store, { validate: isValidStore })
  return stored
}

/**
 * Everything the browser tier was asked for and did not do.
 *
 * `dropped` is reported alongside the entries on purpose: a spool that silently
 * overflowed looks exactly like a spool that was never written to, and the
 * difference is the whole reason to keep one.
 */
export function readBrowserSpool({ filePath = STORE_PATH, limit = 0 } = {}) {
  const store = load(filePath)
  const entries =
    limit > 0 ? store.entries.slice(-limit) : store.entries

  return {
    entries,
    count: store.entries.length,
    bytes: spoolBytesOf(store),
    maxBytes: MAX_SPOOL_BYTES,
    maxEntryBytes: MAX_ENTRY_BYTES,
    dropped: store.dropped,
    storePath: filePath,
  }
}

/** Forget one spooled command, or all of them. */
export function clearBrowserSpool(commandId = null, { filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const before = store.entries.length
  store.entries = commandId
    ? store.entries.filter((entry) => entry.commandId !== commandId)
    : []

  if (!commandId) store.dropped = emptyStore().dropped

  writeJsonAtomic(filePath, store, { validate: isValidStore })
  return { cleared: before - store.entries.length, remaining: store.entries.length }
}
