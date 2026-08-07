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

/*
 * "Clean up my Downloads... show me what will be moved before doing it."
 *
 * The preview is the product. An agent that tidies 28 files and reports a
 * number has given the owner nothing to disagree with, and the one file that
 * mattered is now somewhere they will not think to look. So planning and
 * applying are two calls, and the plan is written to disk between them.
 *
 * Persisting the plan is what makes "before doing it" mean anything. If apply
 * recomputed the grouping it would be applying a *different* plan than the one
 * the owner read — the folder changes under a person who is still using it. So
 * apply replays the stored moves and re-stats every source first: anything that
 * moved, changed size, or vanished since the preview is reported as drift and
 * skipped rather than guessed at.
 *
 * Nothing here deletes. Duplicates are detected and reported, never removed,
 * because "obvious duplicate" is a guess and deletion is not reversible. Every
 * applied plan leaves an undo manifest for the same reason.
 */

const STORE_PATH = path.join(workspacePath, '.pendant-tidy-plans.json')
const PLAN_LIMIT = 20

/* Bytes hashed per file when checking for real duplicates. A head sample plus
 * the size is enough to separate "same name" from "same bytes" without reading
 * gigabytes of disk images. */
const DUPLICATE_SAMPLE_BYTES = 64 * 1024

const TYPE_GROUPS = [
  ['Images', ['.png', '.jpg', '.jpeg', '.gif', '.heic', '.heif', '.webp', '.tiff', '.bmp', '.svg']],
  ['Screenshots', []],
  ['Documents', ['.pdf', '.doc', '.docx', '.pages', '.txt', '.rtf', '.md', '.odt', '.epub']],
  ['Spreadsheets', ['.xls', '.xlsx', '.numbers', '.csv', '.tsv']],
  ['Slides', ['.ppt', '.pptx', '.key']],
  ['Installers', ['.dmg', '.pkg', '.app', '.mpkg']],
  ['Archives', ['.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar', '.xz']],
  ['Audio', ['.mp3', '.m4a', '.wav', '.aiff', '.flac', '.aac', '.ogg']],
  ['Video', ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm']],
  ['Code', ['.js', '.ts', '.py', '.json', '.sh', '.c', '.h', '.swift', '.java', '.rb', '.go']],
]

const EXTENSION_GROUP = new Map(
  TYPE_GROUPS.flatMap(([group, extensions]) =>
    extensions.map((extension) => [extension, group]),
  ),
)

/* macOS names these itself, and they are the single biggest pile in most
 * Downloads folders. Filing them as generic images buries them. */
const SCREENSHOT_NAME = /^(screenshot|screen shot|cleanshot|simulator screenshot)/i

const isValidStore = (value) => value && Array.isArray(value.plans)

export function defaultDownloadsPath() {
  return path.join(os.homedir(), 'Downloads')
}

function loadStore() {
  ensureJsonStore(STORE_PATH, { plans: [] }, { validate: isValidStore })
  return readJsonWithRecovery(STORE_PATH, {
    fallback: { plans: [] },
    validate: isValidStore,
  })
}

function saveStore(store) {
  store.plans = store.plans.slice(-PLAN_LIMIT)
  writeJsonAtomic(STORE_PATH, store, { validate: isValidStore })
}

/**
 * Work out where every loose file would go, and write the answer down.
 *
 * `groupBy` is the owner's phrasing, not a mode flag: "by type" files by what
 * the thing is, "by date" files into dated folders for the weekly sweep.
 */
export function planTidy({
  directory = defaultDownloadsPath(),
  groupBy = 'type',
  now = Date.now(),
  includeHidden = false,
} = {}) {
  const root = path.resolve(directory)
  if (!fs.existsSync(root)) throw new Error(`No such folder: ${root}`)

  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => includeHidden || !entry.name.startsWith('.'))
    /* Only loose files move. A folder in Downloads is usually already the
     * result of someone deciding where something goes. */
    .filter((entry) => entry.isFile())

  const files = entries
    .map((entry) => describeFile(path.join(root, entry.name)))
    .filter(Boolean)

  const moves = files.map((file) => {
    const group = groupFor(file, groupBy)
    const destinationDir = path.join(root, group)
    return {
      name: file.name,
      from: file.path,
      to: path.join(destinationDir, file.name),
      group,
      bytes: file.bytes,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      /* A name that already exists at the destination is the one case where
       * applying blind would destroy something. Surface it in the preview. */
      collides: fs.existsSync(path.join(destinationDir, file.name)),
      signature: file.signature,
    }
  })

  const groups = summarizeGroups(moves)
  const duplicates = findDuplicates(moves)

  const plan = {
    id: `tidy_${crypto.randomUUID()}`,
    directory: root,
    groupBy,
    createdAt: new Date(now).toISOString(),
    appliedAt: null,
    fileCount: moves.length,
    totalBytes: moves.reduce((sum, move) => sum + move.bytes, 0),
    groups,
    duplicates,
    collisions: moves.filter((move) => move.collides).map((move) => move.name),
    moves,
  }

  const store = loadStore()
  store.plans.push(plan)
  saveStore(store)

  return plan
}

/** Human-readable preview. This is what "show me" actually returns. */
export function formatPreview(plan) {
  const lines = [
    `${plan.fileCount} loose file${plan.fileCount === 1 ? '' : 's'} in ${plan.directory}`,
    `Grouping by ${plan.groupBy}. Nothing has moved yet — plan ${plan.id}.`,
    '',
  ]

  for (const group of plan.groups) {
    lines.push(`${group.name}/  (${group.count}, ${formatBytes(group.bytes)})`)
    for (const name of group.sample) lines.push(`    ${name}`)
    if (group.count > group.sample.length) {
      lines.push(`    … and ${group.count - group.sample.length} more`)
    }
  }

  if (plan.duplicates.length) {
    lines.push('', 'Same content, different names (nothing will be deleted):')
    for (const duplicate of plan.duplicates) {
      lines.push(`    ${duplicate.names.join('  ==  ')}  (${formatBytes(duplicate.bytes)} each)`)
    }
  }

  if (plan.collisions.length) {
    lines.push('', `Name already taken at the destination: ${plan.collisions.join(', ')}`)
    lines.push('    These will be suffixed rather than overwritten.')
  }

  return lines.join('\n')
}

export function getPlan(planId) {
  return loadStore().plans.find((plan) => plan.id === planId) ?? null
}

export function listPlans({ limit = 10 } = {}) {
  return loadStore()
    .plans.slice(-limit)
    .reverse()
    .map(({ moves, ...plan }) => ({ ...plan, moveCount: moves.length }))
}

/**
 * Apply exactly the plan the owner read.
 *
 * Sources are re-stat'd first: a file that changed size, or disappeared, is not
 * the file that was previewed, and moving it anyway would be the agent quietly
 * substituting its own judgement for the one that was approved.
 */
export function applyTidy(planId, { now = Date.now() } = {}) {
  const store = loadStore()
  const plan = store.plans.find((item) => item.id === planId)
  if (!plan) throw new Error(`No tidy plan ${planId}. Preview one first.`)
  if (plan.appliedAt) throw new Error(`Plan ${planId} was already applied at ${plan.appliedAt}.`)

  const moved = []
  const drifted = []
  const failed = []

  for (const move of plan.moves) {
    const current = describeFile(move.from)
    if (!current) {
      drifted.push({ name: move.name, reason: 'gone since the preview' })
      continue
    }
    if (current.bytes !== move.bytes) {
      drifted.push({ name: move.name, reason: 'changed since the preview' })
      continue
    }

    try {
      fs.mkdirSync(path.dirname(move.to), { recursive: true })
      const destination = uniqueDestination(move.to)
      fs.renameSync(move.from, destination)
      moved.push({ from: move.from, to: destination })
    } catch (error) {
      failed.push({ name: move.name, reason: String(error?.message || error) })
    }
  }

  plan.appliedAt = new Date(now).toISOString()
  /* The undo manifest is the record of what actually happened, which is not
   * the plan: collisions were renamed and drifted files were skipped. */
  plan.applied = { moved, drifted, failed }
  saveStore(store)

  return {
    ok: failed.length === 0,
    planId,
    movedCount: moved.length,
    driftedCount: drifted.length,
    failedCount: failed.length,
    moved,
    drifted,
    failed,
    spoken: `Moved ${moved.length} file${moved.length === 1 ? '' : 's'}${
      drifted.length ? `, skipped ${drifted.length} that changed` : ''
    }.`,
  }
}

/** Put every applied move back where it came from. */
export function undoTidy(planId) {
  const store = loadStore()
  const plan = store.plans.find((item) => item.id === planId)
  if (!plan?.applied) throw new Error(`Plan ${planId} has nothing to undo.`)

  const restored = []
  const failed = []
  for (const move of plan.applied.moved) {
    try {
      fs.mkdirSync(path.dirname(move.from), { recursive: true })
      fs.renameSync(move.to, uniqueDestination(move.from))
      restored.push(move)
    } catch (error) {
      failed.push({ ...move, reason: String(error?.message || error) })
    }
  }

  plan.applied.undoneAt = new Date().toISOString()
  saveStore(store)
  return { ok: failed.length === 0, restored: restored.length, failed }
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
    bytes: stats.size,
    mtimeMs: stats.mtimeMs,
    signature: contentSignature(filePath, stats.size),
  }
}

/*
 * Size plus a hash of the first 64 KB. Two files that agree on both are the
 * same download twice over; two that disagree are not, whatever their names
 * say. Full hashing would read every disk image in the folder to answer a
 * question the owner asked in passing.
 */
function contentSignature(filePath, size) {
  if (!size) return `empty`
  let handle
  try {
    handle = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(Math.min(size, DUPLICATE_SAMPLE_BYTES))
    fs.readSync(handle, buffer, 0, buffer.length, 0)
    return `${size}:${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16)}`
  } catch {
    return `${size}:unreadable`
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
  }
}

export function groupFor(file, groupBy) {
  if (groupBy === 'date') {
    const at = new Date(file.mtimeMs)
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`
  }

  if (SCREENSHOT_NAME.test(file.name)) return 'Screenshots'

  const extension = path.extname(file.name).toLowerCase()
  return EXTENSION_GROUP.get(extension) ?? 'Other'
}

function summarizeGroups(moves) {
  const byGroup = new Map()
  for (const move of moves) {
    const bucket = byGroup.get(move.group) ?? { name: move.group, count: 0, bytes: 0, sample: [] }
    bucket.count += 1
    bucket.bytes += move.bytes
    if (bucket.sample.length < 5) bucket.sample.push(move.name)
    byGroup.set(move.group, bucket)
  }
  return [...byGroup.values()].sort((left, right) => right.count - left.count)
}

function findDuplicates(moves) {
  const bySignature = new Map()
  for (const move of moves) {
    const bucket = bySignature.get(move.signature) ?? []
    bucket.push(move)
    bySignature.set(move.signature, bucket)
  }

  return [...bySignature.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([signature, bucket]) => ({
      signature,
      bytes: bucket[0].bytes,
      names: bucket.map((move) => move.name),
    }))
}

/** Never overwrite. A name that is taken gets a numeric suffix. */
function uniqueDestination(destination) {
  if (!fs.existsSync(destination)) return destination

  const extension = path.extname(destination)
  const base = destination.slice(0, destination.length - extension.length)
  for (let index = 2; index < 500; index += 1) {
    const candidate = `${base}-${index}${extension}`
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error(`Could not find a free name for ${destination}`)
}

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

export function tidyPlansLocation() {
  return STORE_PATH
}
