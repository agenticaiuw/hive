import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { executeActions } from './executor.js'
import { foreseeAction } from './planPreview.js'
import { undoJobResults } from './undo.js'

/*
 * "Clean up my Downloads: identify duplicate, temporary, and likely finished
 * files, show me a proposed plan, then apply it."
 *
 * Two calls, because the owner asked for two. The first one looks: it reads the
 * folder, works out which files are half-finished downloads, which are byte-for-byte
 * copies of a file that is already there, which installers have been sitting
 * unused since spring, and writes down exactly what it would do about each. The
 * second one replays that written-down plan and nothing else.
 *
 * This is not a permission system and it must not become one.
 *
 * The preview does not stand between the owner and their folder. Everything
 * else on this agent — open, write, move, delete, shell — still runs the moment
 * it is asked, exactly as before. There is no token, no expiry, no approval
 * state, and applySweep() never asks anyone anything. The reason apply takes a
 * plan id is not that it is checking for consent; it is that "apply what you
 * showed me" is only meaningful if the thing applied is the thing shown. A
 * sweep that recomputed its own grouping at apply time would be moving files
 * the owner never read about, in a folder they are still working in.
 *
 * The judgement calls, stated plainly so they can be argued with:
 *   - .crdownload/.part/.tmp and zero-byte files are proposed for deletion.
 *     They are the debris of an interrupted download, and they are snapshotted
 *     into the undo vault on the way out, so this is reversible.
 *   - A duplicate is only proposed for deletion when its bytes hash identically
 *     to a file that stays AND its name reads as a copy of that file
 *     ("report (1).pdf" beside "report.pdf"). Anything else that merely shares
 *     content is reported and left alone: "obvious duplicate" is a guess, and
 *     the owner's guess is better than ours.
 *   - Nothing is ever overwritten. A destination that is already taken is
 *     resolved to a free name at preview time, so what the owner reads is the
 *     path the file actually ends up at.
 */

const storePath = () =>
  process.env.PENDANT_SWEEP_STORE_PATH ||
  path.join(workspacePath, '.pendant-sweep-plans.json')

const PLAN_LIMIT = 20

/* Enough bytes to tell two downloads apart cheaply. Anything that collides on
 * this gets hashed in full before we would propose removing it. */
const QUICK_SAMPLE_BYTES = 64 * 1024

/*
 * Ceiling on the full-hash pass.
 *
 * This owner's Desktop holds 556 screen recordings totalling ~10 GB. Two of
 * them agreeing on size and first 64 KB is unlikely but not impossible, and the
 * cost of finding out by reading both in full is minutes of disk on a machine
 * they are using. Above this size the pair is reported as an unconfirmed match
 * and never proposed for deletion — a preview that arrives is worth more than a
 * certainty that does not, and "probably a duplicate" is the owner's call to
 * make anyway.
 */
const FULL_HASH_MAX_BYTES = 256 * 1024 * 1024

/* Debris. Every one of these is a file some other program abandoned. */
const TEMPORARY_EXTENSIONS = new Set([
  '.crdownload',
  '.part',
  '.partial',
  '.download',
  '.opdownload',
  '.tmp',
  '.temp',
  '.aria2',
  '.!ut',
])

const TEMPORARY_NAMES = /^(~\$|\._)/

const INSTALLER_EXTENSIONS = new Set(['.dmg', '.pkg', '.mpkg', '.iso', '.msi'])

/*
 * macOS names screenshots in the system language, and this owner's Desktop has
 * 30-odd files called 截圖 … alongside the English ones. Matching only the
 * English prefix filed those as "stale, archive it" — which is not wrong, but it
 * splits one pile of screenshots across two destinations for no reason the
 * owner would recognise. The other locales are here for the same reason: this
 * is the sort of thing you only find by running the preview against real files.
 */
const SCREENSHOT_NAME = new RegExp(
  '^(' +
    [
      'screenshot',
      'screen shot',
      'screen recording',
      'cleanshot',
      'simulator screenshot',
      'capto',
      'shottr',
      '截圖', // Traditional Chinese
      '截图', // Simplified Chinese
      'スクリーンショット', // Japanese
      '스크린샷', // Korean
      'captura de pantalla', // Spanish
      'capture d[’\']écran', // French
      'bildschirmfoto', // German
      'снимок экрана', // Russian
      'schermafbeelding', // Dutch
    ].join('|') +
    ')',
  'i',
)

/* Names a browser or the Finder gives the second copy of something. */
const COPY_SUFFIX = /^(.*?)(?:[ _-]?\((\d+)\)|[ _-]copy(?:[ _-]\d+)?|[ _-]\d+)$/i

export const DEFAULT_STALE_DAYS = 90
export const DEFAULT_INSTALLER_STALE_DAYS = 30

const isValidStore = (value) => value && Array.isArray(value.plans)

export function defaultSweepTargets() {
  return [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')]
}

export function sweepPlansLocation() {
  return storePath()
}

function loadStore() {
  const filePath = storePath()
  ensureJsonStore(filePath, { plans: [] }, { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: { plans: [] },
    validate: isValidStore,
  })
}

function saveStore(store) {
  store.plans = store.plans.slice(-PLAN_LIMIT)
  writeJsonAtomic(storePath(), store, { validate: isValidStore })
}

/* ------------------------------------------------------------------ survey */

/**
 * Read a folder and say what each loose file is. No plan, no store, no writes —
 * this is the half that answers "what have I got in here".
 */
export function surveyFolder({
  directory,
  now = Date.now(),
  staleDays = DEFAULT_STALE_DAYS,
  installerStaleDays = DEFAULT_INSTALLER_STALE_DAYS,
  includeHidden = false,
} = {}) {
  const root = path.resolve(directory ?? defaultSweepTargets()[0])
  if (!fs.existsSync(root)) throw new Error(`No such folder: ${root}`)

  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => includeHidden || !entry.name.startsWith('.'))
    /* A folder in Downloads is already somebody's decision about where a thing
     * goes. Only loose files are in scope. */
    .filter((entry) => entry.isFile())

  const files = entries
    .map((entry) => describeFile(path.join(root, entry.name)))
    .filter(Boolean)

  const duplicateSets = findDuplicateSets(files)
  const copyOf = new Map()
  for (const set of duplicateSets) {
    for (const copy of set.copies) copyOf.set(copy.path, set)
  }

  const installed = installedAppNames()

  const surveyed = files.map((file) =>
    classifyFile(file, {
      now,
      staleDays,
      installerStaleDays,
      duplicateSet: copyOf.get(file.path) ?? null,
      installed,
    }),
  )

  return { directory: root, files: surveyed, duplicateSets, scannedAt: new Date(now).toISOString() }
}

function describeFile(filePath) {
  let stats
  try {
    stats = fs.statSync(filePath)
  } catch {
    return null
  }
  if (!stats.isFile()) return null

  return {
    path: filePath,
    name: path.basename(filePath),
    extension: path.extname(filePath).toLowerCase(),
    bytes: stats.size,
    mtimeMs: stats.mtimeMs,
    /* birthtime is what separates "downloaded in March and never opened" from
     * "downloaded in March and edited last week". */
    birthtimeMs: Number.isFinite(stats.birthtimeMs) ? stats.birthtimeMs : stats.mtimeMs,
    quickSignature: quickSignature(filePath, stats.size),
  }
}

function quickSignature(filePath, size) {
  if (!size) return 'empty'
  let handle
  try {
    handle = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(Math.min(size, QUICK_SAMPLE_BYTES))
    fs.readSync(handle, buffer, 0, buffer.length, 0)
    return `${size}:${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16)}`
  } catch {
    return `${size}:unreadable`
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
  }
}

/*
 * Two passes on purpose. The cheap signature (size + first 64 KB) finds the
 * candidates without reading every disk image in the folder; the full hash then
 * settles it for the handful that collided, because a proposal to delete a file
 * has to be right about the bytes and not merely about the first page of them.
 */
function findDuplicateSets(files) {
  const byQuick = new Map()
  for (const file of files) {
    if (!file.bytes) continue
    const bucket = byQuick.get(file.quickSignature) ?? []
    bucket.push(file)
    byQuick.set(file.quickSignature, bucket)
  }

  const sets = []
  for (const bucket of byQuick.values()) {
    if (bucket.length < 2) continue

    /* Too big to read twice while the owner waits. Report the match on the
     * evidence we have and say that is what it is. */
    if (bucket[0].bytes > FULL_HASH_MAX_BYTES) {
      sets.push({ ...orderSet(bucket), hash: bucket[0].quickSignature, confirmed: false })
      continue
    }

    const byFullHash = new Map()
    for (const file of bucket) {
      const digest = fullHash(file.path)
      if (!digest) continue
      const group = byFullHash.get(digest) ?? []
      group.push(file)
      byFullHash.set(digest, group)
    }

    for (const [digest, group] of byFullHash) {
      if (group.length < 2) continue
      sets.push({ ...orderSet(group), hash: digest, confirmed: true })
    }
  }
  return sets
}

/* The keeper is the original: oldest first, shortest name to break ties,
 * because "report.pdf" predates "report (1).pdf" in both. */
function orderSet(group) {
  const [keeper, ...copies] = [...group].sort(
    (left, right) =>
      left.birthtimeMs - right.birthtimeMs || left.name.length - right.name.length,
  )
  return { bytes: keeper.bytes, keeper, copies }
}

function fullHash(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

/** Best effort. A machine that will not list /Applications just loses a hint. */
function installedAppNames() {
  try {
    return new Set(
      fs
        .readdirSync('/Applications')
        .filter((name) => name.endsWith('.app'))
        .map((name) => name.slice(0, -4).toLowerCase()),
    )
  } catch {
    return new Set()
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

function classifyFile(file, { now, staleDays, installerStaleDays, duplicateSet, installed }) {
  const ageDays = Math.floor((now - file.mtimeMs) / DAY_MS)
  const classes = []
  const reasons = []

  if (TEMPORARY_EXTENSIONS.has(file.extension) || TEMPORARY_NAMES.test(file.name)) {
    classes.push('temporary')
    reasons.push(`${file.extension || 'lock file'} is what an interrupted download leaves behind`)
  } else if (file.bytes === 0 && ageDays >= 1) {
    /* A zero-byte file that is a day old is debris. One that is a minute old
     * may be a file some other program is in the middle of writing, and the
     * owner is using this machine right now. */
    classes.push('temporary')
    reasons.push('empty file — nothing ever finished writing to it')
  }

  if (SCREENSHOT_NAME.test(file.name)) {
    classes.push('screenshot')
  }

  const isInstaller = INSTALLER_EXTENSIONS.has(file.extension)
  if (isInstaller) {
    classes.push('installer')
    const stem = installerAppName(file.name)
    if (stem && installed.has(stem)) {
      classes.push('already-installed')
      reasons.push(`${stem} is already in /Applications`)
    }
    if (ageDays >= installerStaleDays) {
      classes.push('stale-installer')
      reasons.push(`installer last touched ${ageDays} days ago`)
    }
  }

  if (duplicateSet) {
    classes.push('duplicate')
    const named = looksLikeCopyOf(file.name, duplicateSet.keeper.name)
    /* Both halves have to hold: the bytes have to be proven identical, and the
     * name has to read as a copy. An unconfirmed match — a file too large to
     * hash twice — is reported and left alone however its name reads. */
    if (named && duplicateSet.confirmed) classes.push('named-copy')
    else if (!duplicateSet.confirmed) classes.push('unconfirmed-duplicate')
    reasons.push(
      duplicateSet.confirmed
        ? `identical bytes to ${duplicateSet.keeper.name}${named ? ' and named as its copy' : ''}`
        : `same size and opening bytes as ${duplicateSet.keeper.name}, too large to verify in full`,
    )
  }

  if (!classes.includes('temporary') && ageDays >= staleDays) {
    classes.push('stale')
    reasons.push(`untouched for ${ageDays} days`)
  }

  if (!classes.length) {
    classes.push('active')
    reasons.push(`last touched ${ageDays} day${ageDays === 1 ? '' : 's'} ago`)
  }

  return { ...file, ageDays, classes, reason: reasons.join('; '), duplicateOf: duplicateSet?.keeper.path ?? null }
}

function installerAppName(name) {
  const stem = name.replace(/\.[^.]+$/, '')
  /* "Cursor-darwin-universal" / "Zoom_1.2.3" / "Figma 124" → "cursor" / "zoom" / "figma" */
  return stem
    .split(/[-_ ]/)[0]
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
}

/** "report (1).pdf" is a copy of "report.pdf"; "notes.pdf" is not. */
export function looksLikeCopyOf(name, keeperName) {
  const strip = (value) => value.replace(/\.[^.]+$/, '')
  const stem = strip(name)
  const keeperStem = strip(keeperName)
  if (stem === keeperStem) return false
  const match = COPY_SUFFIX.exec(stem)
  if (!match) return false
  return match[1].trim().toLowerCase() === keeperStem.trim().toLowerCase()
}

/* -------------------------------------------------------------- the preview */

/**
 * What a sweep of this folder would do, written down so applying it means
 * something.
 *
 * Every item that proposes work carries the literal action that will be
 * dispatched, plus the same "what would this touch / could this be undone"
 * description the receipt will carry afterwards.
 */
export function planSweep({
  directory,
  now = Date.now(),
  staleDays = DEFAULT_STALE_DAYS,
  installerStaleDays = DEFAULT_INSTALLER_STALE_DAYS,
  archiveName = 'Archive',
  screenshotsName = 'Screenshots',
  includeHidden = false,
} = {}) {
  const survey = surveyFolder({ directory, now, staleDays, installerStaleDays, includeHidden })
  const root = survey.directory

  /* Claimed as we go, so two files headed for the same name in the same sweep
   * get different ones in the preview rather than colliding at apply time. */
  const claimed = new Set()
  const items = []

  for (const file of survey.files) {
    const disposition = decide(file)

    if (disposition.kind === 'keep' || disposition.kind === 'flag') {
      items.push({
        itemId: null,
        name: file.name,
        from: file.path,
        bytes: file.bytes,
        ageDays: file.ageDays,
        classes: file.classes,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
        disposition: disposition.kind,
        reason: disposition.reason ?? file.reason,
        to: null,
        action: null,
        foresight: null,
      })
      continue
    }

    const to =
      disposition.kind === 'delete'
        ? null
        : claimFreeName(
            path.join(
              root,
              disposition.folder,
              monthFolder(file.mtimeMs),
              ...(disposition.subfolder ? [disposition.subfolder] : []),
              file.name,
            ),
            claimed,
          )

    const action =
      disposition.kind === 'delete'
        ? { type: 'delete_path', label: `delete ${file.name}`, params: { path: file.path } }
        : { type: 'move_path', label: `move ${file.name}`, params: { from: file.path, to } }

    items.push({
      itemId: null,
      name: file.name,
      from: file.path,
      bytes: file.bytes,
      ageDays: file.ageDays,
      classes: file.classes,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      disposition: disposition.kind,
      reason: disposition.reason ?? file.reason,
      to,
      action,
      /* Same call the executor's receipt will make. If this says "cannot be
       * undone", the receipt afterwards will say it too. */
      foresight: foreseeAction(action),
      /* Recorded so apply can tell "the same file" from "a file with the same
       * name that appeared since". */
      expect: { bytes: file.bytes, mtimeMs: file.mtimeMs },
    })
  }

  for (const item of items) {
    if (item.action) item.itemId = item.foresight.actionId
  }

  const plan = {
    id: `sweep_${crypto.randomUUID()}`,
    directory: root,
    createdAt: new Date(now).toISOString(),
    appliedAt: null,
    options: { staleDays, installerStaleDays, archiveName, screenshotsName },
    counts: countBy(items),
    totalBytes: items.reduce((sum, item) => sum + (item.action ? item.bytes : 0), 0),
    duplicates: survey.duplicateSets.map((set) => ({
      bytes: set.bytes,
      confirmed: set.confirmed,
      keeper: set.keeper.name,
      copies: set.copies.map((copy) => copy.name),
    })),
    irreversible: items
      .filter((item) => item.foresight && item.foresight.reversible === false)
      .map((item) => ({ name: item.name, reason: item.foresight.irreversibleReason })),
    items,
  }

  const store = loadStore()
  store.plans.push(plan)
  saveStore(store)
  return plan

  function decide(file) {
    if (file.classes.includes('temporary')) {
      return { kind: 'delete', reason: file.reason }
    }
    if (file.classes.includes('duplicate')) {
      /* Only the ones that are a copy by content *and* by name. Everything else
       * that happens to share bytes is reported, not touched. */
      return file.classes.includes('named-copy')
        ? { kind: 'delete', reason: file.reason }
        : { kind: 'flag', reason: `${file.reason} — left alone; the name does not read as a copy` }
    }
    if (file.classes.includes('screenshot')) {
      return { kind: 'file', folder: screenshotsName, reason: 'screenshot' }
    }
    if (file.classes.includes('stale-installer')) {
      return { kind: 'archive', folder: archiveName, subfolder: 'Installers', reason: file.reason }
    }
    if (file.classes.includes('stale')) {
      return { kind: 'archive', folder: archiveName, reason: file.reason }
    }
    return { kind: 'keep', reason: file.reason }
  }
}

function countBy(items) {
  const counts = { keep: 0, flag: 0, file: 0, archive: 0, delete: 0 }
  for (const item of items) counts[item.disposition] = (counts[item.disposition] ?? 0) + 1
  return counts
}

function monthFolder(mtimeMs) {
  const at = new Date(mtimeMs)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
}

/** Never overwrite, and never let two files in one plan claim one name. */
function claimFreeName(destination, claimed) {
  const taken = (candidate) => claimed.has(candidate) || fs.existsSync(candidate)
  if (!taken(destination)) {
    claimed.add(destination)
    return destination
  }
  const extension = path.extname(destination)
  const base = destination.slice(0, destination.length - extension.length)
  for (let index = 2; index < 500; index += 1) {
    const candidate = `${base}-${index}${extension}`
    if (!taken(candidate)) {
      claimed.add(candidate)
      return candidate
    }
  }
  throw new Error(`Could not find a free name for ${destination}`)
}

/** The preview as the owner reads it. This is the deliverable, not a preamble. */
export function formatSweep(plan) {
  const acting = plan.items.filter((item) => item.action)
  const lines = [
    `${plan.directory}`,
    `${plan.items.length} loose file${plan.items.length === 1 ? '' : 's'}. ` +
      `${acting.length} would change, ${plan.counts.flag} reported without touching, ` +
      `${plan.counts.keep} left alone. Nothing has moved — plan ${plan.id}.`,
  ]

  for (const kind of ['delete', 'archive', 'file']) {
    const group = acting.filter((item) => item.disposition === kind)
    if (!group.length) continue
    lines.push(
      '',
      kind === 'delete'
        ? `Delete (${group.length}, ${formatBytes(sumBytes(group))}) — recoverable from the undo vault:`
        : kind === 'archive'
          ? `Archive (${group.length}, ${formatBytes(sumBytes(group))}):`
          : `File into dated folders (${group.length}, ${formatBytes(sumBytes(group))}):`,
    )
    for (const item of group.slice(0, 12)) {
      lines.push(
        kind === 'delete'
          ? `    ${item.name}  — ${item.reason}`
          : `    ${item.name}  →  ${path.relative(plan.directory, item.to)}  — ${item.reason}`,
      )
    }
    if (group.length > 12) lines.push(`    … and ${group.length - 12} more`)
  }

  const flagged = plan.items.filter((item) => item.disposition === 'flag')
  if (flagged.length) {
    lines.push('', `Reported, not touched (${flagged.length}):`)
    for (const item of flagged.slice(0, 8)) lines.push(`    ${item.name}  — ${item.reason}`)
  }

  if (plan.irreversible.length) {
    lines.push('', `Could not be undone afterwards (${plan.irreversible.length}):`)
    for (const entry of plan.irreversible.slice(0, 8)) {
      lines.push(`    ${entry.name}  — ${entry.reason}`)
    }
  }

  lines.push(
    '',
    `Apply with plan id ${plan.id}. Name specific items to do only those.`,
  )
  return lines.join('\n')
}

const sumBytes = (items) => items.reduce((sum, item) => sum + item.bytes, 0)

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = Number(bytes) || 0
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function getSweep(planId) {
  return loadStore().plans.find((plan) => plan.id === planId) ?? null
}

export function listSweeps({ limit = 10 } = {}) {
  return loadStore()
    .plans.slice(-limit)
    .reverse()
    .map(({ items, ...plan }) => ({ ...plan, itemCount: items.length }))
}

/* ---------------------------------------------------------------- the apply */

/**
 * Do exactly what the preview said, and only that.
 *
 * `only` is a list of item ids: the owner reading a preview and saying "those
 * two, not the rest" is the point of having read it. Omitting it applies the
 * whole plan.
 *
 * Every source is re-checked against what the preview recorded. A file that
 * changed size, changed timestamp, or vanished is not the file that was
 * described, and a destination that filled up in the meantime is not the empty
 * slot that was described. Those are reported as drift and skipped, because
 * substituting a fresh guess for the plan the owner read is the one behaviour
 * that would make the preview worthless.
 */
export async function applySweep(planId, { only = null, now = Date.now(), run = executeActions } = {}) {
  const store = loadStore()
  const plan = store.plans.find((item) => item.id === planId)
  if (!plan) throw new Error(`No sweep plan ${planId}. Preview one first.`)

  const wanted = only ? new Set([].concat(only).map(String)) : null
  const candidates = plan.items.filter(
    (item) => item.action && (!wanted || wanted.has(item.itemId)),
  )

  if (wanted) {
    const known = new Set(plan.items.map((item) => item.itemId))
    const unknown = [...wanted].filter((id) => !known.has(id))
    if (unknown.length) {
      throw new Error(`Plan ${planId} has no item ${unknown.join(', ')}.`)
    }
  }

  const drifted = []
  const runnable = []
  for (const item of candidates) {
    const drift = driftFor(item)
    if (drift) drifted.push({ itemId: item.itemId, name: item.name, reason: drift })
    else runnable.push(item)
  }

  /* Through the normal executor, so the sweep leaves the same receipts and the
   * same undo-vault snapshots as anything else the agent does. */
  const results = runnable.length ? await run(runnable.map((item) => item.action)) : []

  const applied = runnable.map((item, index) => ({
    itemId: item.itemId,
    name: item.name,
    disposition: item.disposition,
    from: item.from,
    to: item.to,
    ok: results[index]?.ok !== false,
    message: results[index]?.message ?? '',
  }))

  const failed = applied.filter((entry) => !entry.ok)
  const run_ = {
    runId: `sweeprun_${crypto.randomUUID().slice(0, 8)}`,
    at: new Date(now).toISOString(),
    requested: candidates.length,
    applied,
    drifted,
    /* Kept whole: undo reads the snapshot paths out of these receipts. */
    results,
  }

  plan.runs = [...(plan.runs ?? []), run_]
  plan.appliedAt = run_.at
  saveStore(store)

  const moved = applied.filter((entry) => entry.ok && entry.disposition !== 'delete').length
  const removed = applied.filter((entry) => entry.ok && entry.disposition === 'delete').length

  return {
    ok: failed.length === 0,
    planId,
    runId: run_.runId,
    movedCount: moved,
    deletedCount: removed,
    driftedCount: drifted.length,
    failedCount: failed.length,
    applied,
    drifted,
    failed,
    spoken:
      `${moved ? `Moved ${moved} file${moved === 1 ? '' : 's'}` : 'Moved nothing'}` +
      `${removed ? `, deleted ${removed}` : ''}` +
      `${drifted.length ? `, skipped ${drifted.length} that changed since the preview` : ''}` +
      `${failed.length ? `, ${failed.length} failed` : ''}.`,
  }
}

function driftFor(item) {
  let stats
  try {
    stats = fs.statSync(item.from)
  } catch {
    return 'gone since the preview'
  }
  if (!stats.isFile()) return 'no longer a file'
  if (item.expect && stats.size !== item.expect.bytes) return 'changed size since the preview'
  if (item.expect && Math.abs(stats.mtimeMs - item.expect.mtimeMs) > 1000) {
    return 'edited since the preview'
  }
  if (item.to && fs.existsSync(item.to)) return 'something else took the destination name'
  return null
}

/**
 * Put a sweep back.
 *
 * Delegates to the ordinary job undo so a swept file and a hand-moved file come
 * back the same way — including deletes, which come back out of the snapshot
 * the executor took on the way past.
 */
export async function undoSweep(planId, { runId = null } = {}) {
  const store = loadStore()
  const plan = store.plans.find((item) => item.id === planId)
  const runs = plan?.runs ?? []
  const target = runId ? runs.find((entry) => entry.runId === runId) : runs[runs.length - 1]
  if (!target) throw new Error(`Sweep plan ${planId} has nothing to undo.`)
  if (target.undoneAt) throw new Error(`Sweep run ${target.runId} was already undone.`)

  const outcome = await undoJobResults({
    status: 'completed',
    result: { results: target.results ?? [] },
  })

  target.undoneAt = new Date().toISOString()
  saveStore(store)
  return { ...outcome, planId, runId: target.runId }
}
