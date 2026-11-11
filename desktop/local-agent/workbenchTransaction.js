import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { workspacePath } from './config.js'
import {
  contextLocation,
  contextIdFor,
  getContext,
  handoffFor,
  intentHashFor,
  listContexts,
  openContext,
  recordEvent,
  stampPlan,
} from './executionContext.js'

/*
 * THE WORKBENCH TRANSACTION: one job's outputs land completely, or not at all,
 * and a job that is handed to us twice only happens once.
 *
 * Several capabilities in this agent write real files into the owner's
 * workspace — briefings, tidy plans, meeting folders, catch-up digests — with
 * `fs.writeFileSync` straight onto the final path. Two things go wrong there,
 * and the overnight capabilities are the ones that hit both, because they run
 * when nobody is watching:
 *
 *   1. A crash mid-write leaves a truncated file at the real name. The next
 *      read treats it as authoritative, because a half-written briefing is
 *      still a readable one.
 *   2. A retry re-runs the whole job and writes everything again. Harmless for
 *      a briefing; not harmless for anything that appends, numbers, or sends.
 *
 * WHAT THIS GUARANTEES, precisely, so nobody has to guess later:
 *
 *   PER FILE, ALWAYS ATOMIC. Every destination is written to a temporary file
 *   on the SAME filesystem, fsynced, and renamed into place. A reader sees the
 *   old bytes or the new bytes. There is no third outcome. This holds even if
 *   the process is killed at any instruction.
 *
 *   PER TRANSACTION, ATOMIC ON THE HAPPY PATH AND ROLLED BACK ON A FAILURE WE
 *   SEE. Renaming N files is N atomic operations, not one. A crash between
 *   rename 2 and rename 3 leaves two new files and one old one. What makes
 *   that recoverable rather than merely partial is the commit record: it is
 *   written and fsynced only AFTER every destination directory has been
 *   fsynced, so a durable "committed" implies every rename is durable.
 *   Anything else is an uncommitted context, and an uncommitted context is
 *   re-run in full. If a rename fails while we are still running, the
 *   destinations already replaced are restored from snapshots taken before the
 *   first rename.
 *
 *   WHAT IT DOES NOT GUARANTEE. A reader that opens output 3 while we are
 *   between renames sees output 3's old bytes next to output 1's new bytes.
 *   Consumers of a multi-file output should ask `readCommitted` whether the
 *   transaction committed rather than trusting the files to be a set.
 *
 * ON `fsync` AND macOS, since this runs on a Mac: `fs.fsyncSync` is `fsync(2)`,
 * which on Darwin flushes to the drive but does NOT force the drive's own
 * write cache — that needs `F_FULLFSYNC`, which Node does not expose. So the
 * durability claim here is "survives a process crash and an OS panic", not
 * "survives having the power pulled from a disk that lies about its cache".
 * The directory fsync below is the part most implementations skip entirely,
 * and skipping it loses the rename itself, not just the contents.
 */

/* Staging lives inside the workspace so that a rename into a workspace file is
 * a same-filesystem rename by default. os.tmpdir() would be a different volume
 * on many Macs, and a cross-device rename is a copy — not atomic. */
const STAGING_DIRECTORY = '.pendant-workbench-stage'

/* Above this, an idempotency check compares size and mtime instead of reading
 * the whole file back. Re-hashing a 200 MB output on every retry costs more
 * than the certainty is worth; the result is reported as `size-only` rather
 * than quietly presented as a verified match. */
const MAX_VERIFY_BYTES = 8 * 1024 * 1024

/* A rollback snapshot is a hardlink when the filesystem allows one, which is
 * free at any size. This cap applies only to the copy fallback. */
const MAX_SNAPSHOT_COPY_BYTES = 32 * 1024 * 1024

/* Owner-only, matching atomicJsonStore.js. Workspace output can contain the
 * owner's mail, calendar and documents; it has no business being world
 * readable because `writeFileSync` defaulted to 0644. */
const DEFAULT_MODE = 0o600

export class WorkbenchTransactionError extends Error {
  constructor(message, { phase = 'unknown', contextId = null, cause = null, rollback = null } = {}) {
    super(message)
    this.name = 'WorkbenchTransactionError'
    this.phase = phase
    this.contextId = contextId
    this.rollback = rollback
    if (cause) this.cause = cause
  }
}

/**
 * Decide what a transaction WOULD do, touching nothing. Read-only: safe for a
 * route, a dry run, or a caller that wants to know whether the expensive part
 * is worth starting.
 */
export function planTransaction({
  jobId = null,
  parentId = null,
  intent,
  outputs = null,
  references = [],
  basePath = workspacePath,
  statePath = null,
} = {}) {
  const root = path.resolve(basePath)
  const filePath = statePath ?? contextLocation(root)
  const declared = Array.isArray(outputs) ? outputs : null
  const descriptor = stampPlan({
    jobId,
    parentId,
    intent,
    destinations: declared ? declaredDestinations(root, declared) : [],
    references,
  })

  const context = getContext(descriptor.contextId, { filePath })
  if (!context) {
    const siblings = listContexts({ filePath, jobId: descriptor.jobId, limit: 5 })
    return { descriptor, decision: siblings.length ? 'rerun' : 'fresh', context: null }
  }
  if (context.status !== 'committed') return { descriptor, decision: 'retry', context }

  const verification = verifyOutputs(context, { basePath: root })
  return {
    descriptor,
    decision: verification.intact ? 'completed' : 'repair',
    context,
    verification,
  }
}

/**
 * Run a transaction, or recognise that it already ran.
 *
 * `outputs` is either a static manifest — `[{ path, contents | json, mode? }]`
 * with paths relative to `basePath` — or omitted in favour of `produce`, an
 * async function returning that manifest. The difference matters for cost, not
 * for correctness: on a recognised replay `produce` is NEVER called, which is
 * what makes "idempotent" mean something for a job whose expensive part is
 * generating the content rather than writing it.
 *
 * `onPhase(phase, detail)` is a seam for durability tests and for the crash
 * harness. Throwing from it aborts the transaction at that exact point; the
 * interrupt test kills the process from it instead, which is the only way to
 * check the guarantee without our own cleanup code tidying the evidence away.
 */
export async function commitTransaction({
  jobId = null,
  parentId = null,
  intent,
  outputs = null,
  produce = null,
  references = [],
  basePath = workspacePath,
  statePath = null,
  onPhase = null,
  clock = () => new Date(),
} = {}) {
  const root = path.resolve(basePath)
  const filePath = statePath ?? contextLocation(root)
  const declared = Array.isArray(outputs) ? outputs : null
  if (!declared && typeof produce !== 'function') {
    throw new TypeError('A transaction needs either an outputs manifest or a produce().')
  }

  fs.mkdirSync(root, { recursive: true })

  const descriptor = stampPlan({
    jobId,
    parentId,
    intent,
    destinations: declared ? declaredDestinations(root, declared) : [],
    references,
  })
  const { decision, context } = openContext(descriptor, { filePath, now: clock() })

  /*
   * THE IDEMPOTENCY GATE.
   *
   * A committed context for this exact (jobId, intentHash) means this event
   * already happened. We still look at the disk before trusting it: the record
   * says what we wrote, not what is there now, and an output the owner deleted
   * or edited is a fact the record cannot know. Intact -> nothing runs, not
   * even `produce`. Drifted -> we say so and rebuild, rather than reporting a
   * success over a file that no longer exists.
   */
  if (decision === 'completed') {
    const verification = verifyOutputs(context, { basePath: root })
    if (verification.intact) {
      return {
        ok: true,
        applied: false,
        produced: false,
        replayed: true,
        decision: 'completed',
        jobId: descriptor.jobId,
        contextId: descriptor.contextId,
        intentHash: descriptor.intentHash,
        sequence: context.lastSequence,
        outputs: context.outputs ?? [],
        verification,
      }
    }
    recordEvent(
      descriptor.contextId,
      { status: 'open', note: `repairing: ${verification.reason}` },
      { filePath, now: clock() },
    )
  }

  const manifest = declared
    ? declared
    : await produce({
        jobId: descriptor.jobId,
        contextId: descriptor.contextId,
        intentHash: descriptor.intentHash,
        attempt: context.attempts ?? 1,
        handoff: handoffFor(descriptor.jobId, { filePath }),
      })

  const entries = normalizeManifest(root, manifest)
  await callPhase(onPhase, 'resolved', { contextId: descriptor.contextId, count: entries.length })

  const token = crypto.randomUUID().slice(0, 8)
  const stagingRoot = createStagingRoot(root, descriptor.contextId, token)
  const staged = []
  const renamed = []
  const snapshots = []
  let phase = 'staging'

  try {
    const stagingDevice = deviceOf(stagingRoot)

    for (const [index, entry] of entries.entries()) {
      fs.mkdirSync(entry.directory, { recursive: true })

      /*
       * CROSS-DEVICE, HANDLED RATHER THAN HOPED AWAY.
       *
       * The shared staging directory is inside `basePath`, which is the same
       * volume as the destination in the ordinary case. It is NOT the same
       * volume when a workspace subfolder is a symlink to an external disk or
       * a network mount — and renaming across devices raises EXDEV, or worse,
       * gets "helpfully" implemented as a copy that is not atomic. So the
       * device id of the destination's own directory is compared against the
       * staging root's, and a mismatch stages the file as a hidden sibling of
       * its destination instead. Slightly untidier, same volume, still one
       * rename.
       */
      const sameDevice = stagingDevice !== null && deviceOf(entry.directory) === stagingDevice
      const stagePath = sameDevice
        ? path.join(stagingRoot, `out-${index}`)
        : siblingStagePath(entry, token, index)

      writeStagedFile(stagePath, entry.contents, entry.mode)
      staged.push({
        entry,
        stagePath,
        strategy: sameDevice ? 'shared-staging' : 'destination-sibling',
        crossDevice: !sameDevice,
        bytes: entry.contents.length,
        digest: digestOf(entry.contents),
      })
    }

    syncDirectory(stagingRoot)

    /*
     * The pending marker, fsynced BEFORE the first rename. This is what turns
     * "the process died somewhere in the middle" from an unanswerable question
     * into a recorded state: a context left in `staging` says an interrupted
     * write may have half-landed, and the resume re-runs the whole transaction
     * instead of guessing which half.
     */
    phase = 'marking'
    recordEvent(
      descriptor.contextId,
      {
        status: 'staging',
        staging: { root: stagingRoot, at: clock().toISOString() },
        outputs: staged.map((item) => ({
          path: item.entry.destination,
          bytes: item.bytes,
          digest: item.digest,
        })),
      },
      { filePath, now: clock() },
    )

    phase = 'snapshot'
    for (const item of staged) {
      snapshots.push(snapshotDestination(item.entry, token, snapshots.length))
    }

    phase = 'rename'
    await callPhase(onPhase, 'before-rename', {
      contextId: descriptor.contextId,
      staged: staged.map((item) => item.stagePath),
    })

    for (const [index, item] of staged.entries()) {
      renameIntoPlace(item)
      renamed.push(item)
      await callPhase(onPhase, `after-rename:${index}`, { destination: item.entry.destination })
    }

    phase = 'directory-sync'
    const directorySync = {}
    for (const directory of new Set(staged.map((item) => item.entry.directory))) {
      directorySync[directory] = syncDirectory(directory)
    }

    phase = 'commit'
    await callPhase(onPhase, 'before-commit', { contextId: descriptor.contextId })

    /*
     * THE COMMIT POINT. Every file is fsynced, every rename is done, every
     * destination directory is fsynced. Only now does the record say
     * `committed`, and atomicJsonStore fsyncs that record and its directory.
     * A durable "committed" therefore implies durable renames; the converse
     * failure — renames durable, record lost — costs one redundant re-run and
     * nothing else.
     */
    const committed = recordEvent(
      descriptor.contextId,
      {
        status: 'committed',
        staging: null,
        outputs: staged.map((item) => ({
          path: item.entry.destination,
          bytes: item.bytes,
          digest: item.digest,
          crossDevice: item.crossDevice,
        })),
        references: staged.map((item) => ({ kind: 'output', id: item.entry.destination })),
      },
      { filePath, now: clock() },
    )

    cleanupSnapshots(snapshots)
    removeStagingRoot(stagingRoot)

    return {
      ok: true,
      applied: true,
      produced: !declared,
      replayed: false,
      decision: decision === 'completed' ? 'repair' : decision,
      jobId: descriptor.jobId,
      contextId: descriptor.contextId,
      intentHash: descriptor.intentHash,
      sequence: committed?.lastSequence ?? context.lastSequence,
      outputs: committed?.outputs ?? [],
      durability: {
        fileFsync: true,
        directorySync,
        /* Named so nobody reads "fsync" as a power-failure guarantee on
         * Darwin. See the header. */
        fullFsync: false,
      },
      staging: {
        root: stagingRoot,
        crossDevice: staged.some((item) => item.crossDevice),
      },
    }
  } catch (error) {
    const rollback = rollbackRenames(renamed, snapshots)
    for (const item of staged) {
      if (!renamed.includes(item)) safeUnlink(item.stagePath)
    }
    cleanupSnapshots(snapshots)
    removeStagingRoot(stagingRoot)

    try {
      recordEvent(
        descriptor.contextId,
        { status: 'failed', staging: null, note: `${phase}: ${String(error?.message ?? error)}` },
        { filePath, now: clock() },
      )
    } catch {
      /* A bookkeeping failure must not replace the error that caused it. */
    }

    throw new WorkbenchTransactionError(
      `Workbench transaction failed during ${phase}: ${String(error?.message ?? error)}`,
      { phase, contextId: descriptor.contextId, cause: error, rollback },
    )
  }
}

/**
 * Is what the record claims still on disk? Used by the idempotency gate and
 * exported so a consumer of a multi-file output can ask before reading it.
 */
export function verifyOutputs(context, { basePath = workspacePath } = {}) {
  const outputs = context?.outputs ?? []
  if (!outputs.length) {
    return { intact: false, reason: 'no recorded outputs', checked: [] }
  }

  const checked = []
  for (const output of outputs) {
    const target = path.resolve(basePath, output.path)
    let stats
    try {
      stats = fs.statSync(target)
    } catch {
      checked.push({ path: output.path, state: 'missing' })
      return { intact: false, reason: `missing output ${output.path}`, checked }
    }

    if (Number.isFinite(output.bytes) && stats.size !== output.bytes) {
      checked.push({ path: output.path, state: 'size-changed' })
      return { intact: false, reason: `size changed for ${output.path}`, checked }
    }
    if (stats.size > MAX_VERIFY_BYTES || !output.digest) {
      checked.push({ path: output.path, state: 'size-only' })
      continue
    }
    if (digestOf(fs.readFileSync(target)) !== output.digest) {
      checked.push({ path: output.path, state: 'content-changed' })
      return { intact: false, reason: `content changed for ${output.path}`, checked }
    }
    checked.push({ path: output.path, state: 'verified' })
  }

  return { intact: true, reason: null, checked }
}

/**
 * Whether a committed set of outputs may be read as a set. A multi-file
 * consumer should call this instead of assuming the files arrived together.
 */
export function readCommitted(
  { jobId, intent, destinations = [], basePath = workspacePath, statePath = null } = {},
) {
  const root = path.resolve(basePath)
  const filePath = statePath ?? contextLocation(root)
  const intentHash = intentHashFor(intent, { destinations })
  const context = getContext(contextIdFor(jobId, intentHash), { filePath })
  if (!context) return { committed: false, reason: 'unknown', context: null }
  if (context.status !== 'committed') {
    return { committed: false, reason: context.status, context }
  }
  const verification = verifyOutputs(context, { basePath: root })
  return {
    committed: verification.intact,
    reason: verification.intact ? null : verification.reason,
    context,
    verification,
  }
}

/**
 * Remove staging directories a crash left behind. Deliberately not exposed as
 * a route: it deletes, and everything with an HTTP surface in this area is
 * read-only on purpose. The age floor means an in-flight transaction is never
 * swept out from under itself.
 */
export function sweepStagingDirectories({
  basePath = workspacePath,
  olderThanMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
} = {}) {
  const stagingHome = path.join(path.resolve(basePath), STAGING_DIRECTORY)
  let names
  try {
    names = fs.readdirSync(stagingHome)
  } catch {
    return { removed: [], kept: [] }
  }

  const removed = []
  const kept = []
  for (const name of names) {
    const target = path.join(stagingHome, name)
    /* Never follow anything out of the staging home, whatever the name is. */
    if (path.dirname(target) !== stagingHome) continue
    let stats
    try {
      stats = fs.lstatSync(target)
    } catch {
      continue
    }
    if (!stats.isDirectory() || now - stats.mtimeMs < olderThanMs) {
      kept.push(target)
      continue
    }
    try {
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(target)
    } catch {
      kept.push(target)
    }
  }

  return { removed, kept }
}

export function stagingHomeFor(basePath = workspacePath) {
  return path.join(path.resolve(basePath), STAGING_DIRECTORY)
}

function declaredDestinations(root, outputs) {
  return outputs.map((entry) => relativeDestination(root, entry?.path))
}

function relativeDestination(root, candidate) {
  const raw = String(candidate ?? '').trim()
  if (!raw) throw new TypeError('Every manifest entry needs a path.')
  const resolved = path.resolve(root, raw)
  assertInside(root, resolved)
  return path.relative(root, resolved)
}

function normalizeManifest(root, manifest) {
  if (!Array.isArray(manifest) || !manifest.length) {
    throw new TypeError('A transaction manifest must be a non-empty array of outputs.')
  }

  const seen = new Set()
  return manifest.map((entry) => {
    const relative = relativeDestination(root, entry?.path)
    if (seen.has(relative)) {
      throw new TypeError(`Manifest names ${relative} twice; the last write would win silently.`)
    }
    seen.add(relative)
    const destination = path.resolve(root, relative)
    return {
      destination: relative,
      absolute: destination,
      directory: path.dirname(destination),
      contents: contentsOf(entry),
      mode: Number.isInteger(entry?.mode) ? entry.mode : DEFAULT_MODE,
    }
  })
}

function contentsOf(entry) {
  if (entry?.json !== undefined) {
    return Buffer.from(`${JSON.stringify(entry.json, null, 2)}\n`, 'utf8')
  }
  const value = entry?.contents
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, entry?.encoding ?? 'utf8')
  throw new TypeError(`Output ${String(entry?.path)} has no contents to write.`)
}

/*
 * Containment, checked through symlinks. `path.resolve` alone is fooled by a
 * workspace subdirectory that is a symlink pointing out of the workspace, so
 * the nearest EXISTING ancestor of the destination is realpath'd first — the
 * destination itself usually does not exist yet, which is the whole point.
 */
function assertInside(root, target) {
  const realRoot = realpathNearest(root)
  const realTarget = path.resolve(realpathNearest(path.dirname(target)), path.basename(target))
  const relative = path.relative(realRoot, realTarget)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError(`Refusing to write outside the workbench base: ${target}`)
  }
}

function realpathNearest(target) {
  let current = path.resolve(target)
  for (;;) {
    try {
      return fs.realpathSync(current)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

function createStagingRoot(root, contextId, token) {
  const home = path.join(root, STAGING_DIRECTORY)
  fs.mkdirSync(home, { recursive: true })
  const prefix = `${String(contextId).replace(/[^\w.-]/g, '-').slice(0, 60)}-${token}-`
  return fs.mkdtempSync(path.join(home, prefix))
}

function siblingStagePath(entry, token, index) {
  return path.join(entry.directory, `.wbx-${token}-${index}.tmp`)
}

function writeStagedFile(stagePath, contents, mode) {
  let descriptor = null
  try {
    /* 'wx' so a colliding temp name is an error rather than a silent overwrite
     * of somebody else's in-flight transaction. */
    descriptor = fs.openSync(stagePath, 'wx', mode)
    fs.writeFileSync(descriptor, contents)
    fs.fsyncSync(descriptor)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

/*
 * The pre-rename snapshot, which is what makes a FAILED transaction leave the
 * workspace as it found it rather than half-applied. A hardlink costs nothing
 * and does not care how large the file is; when the filesystem refuses one, a
 * bounded copy stands in, and above the cap we record honestly that this
 * destination cannot be rolled back instead of pretending it can.
 *
 * The snapshot is a sibling of the destination on purpose: restoring it is
 * itself a rename, and a rename is only atomic within one filesystem.
 */
function snapshotDestination(entry, token, index) {
  const snapshotPath = path.join(entry.directory, `.wbx-${token}-prev-${index}`)
  let stats
  try {
    stats = fs.statSync(entry.absolute)
  } catch {
    return { entry, snapshotPath: null, existed: false, rollback: 'unlink' }
  }

  try {
    fs.linkSync(entry.absolute, snapshotPath)
    return { entry, snapshotPath, existed: true, rollback: 'link' }
  } catch {
    if (stats.size > MAX_SNAPSHOT_COPY_BYTES) {
      return { entry, snapshotPath: null, existed: true, rollback: 'unavailable' }
    }
    try {
      fs.copyFileSync(entry.absolute, snapshotPath)
      return { entry, snapshotPath, existed: true, rollback: 'copy' }
    } catch {
      return { entry, snapshotPath: null, existed: true, rollback: 'unavailable' }
    }
  }
}

function renameIntoPlace(item) {
  try {
    fs.renameSync(item.stagePath, item.entry.absolute)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }

  /*
   * EXDEV after the device check passed: a bind mount, a race, or a
   * filesystem that reports one device id and enforces another. Re-stage as a
   * sibling of the destination — which cannot be on a different device than
   * the destination — and try once more. If that fails too, the error
   * propagates and the transaction rolls back. What we never do is fall back
   * to a copy and call it a rename.
   */
  const retryPath = `${item.entry.absolute}.wbx-exdev-${crypto.randomUUID().slice(0, 8)}.tmp`
  writeStagedFile(retryPath, fs.readFileSync(item.stagePath), item.entry.mode)
  safeUnlink(item.stagePath)
  item.stagePath = retryPath
  item.strategy = 'destination-sibling'
  item.crossDevice = true
  fs.renameSync(retryPath, item.entry.absolute)
}

function rollbackRenames(renamed, snapshots) {
  const restored = []
  const unrecoverable = []

  for (let index = renamed.length - 1; index >= 0; index -= 1) {
    const item = renamed[index]
    const snapshot = snapshots.find((candidate) => candidate.entry === item.entry)
    try {
      if (!snapshot || snapshot.rollback === 'unlink') {
        fs.unlinkSync(item.entry.absolute)
        restored.push({ path: item.entry.destination, to: 'absent' })
      } else if (snapshot.snapshotPath) {
        fs.renameSync(snapshot.snapshotPath, item.entry.absolute)
        snapshot.snapshotPath = null
        restored.push({ path: item.entry.destination, to: 'previous' })
      } else {
        unrecoverable.push({ path: item.entry.destination, reason: snapshot.rollback })
      }
    } catch (error) {
      unrecoverable.push({ path: item.entry.destination, reason: String(error?.message ?? error) })
    }
  }

  for (const directory of new Set(renamed.map((item) => item.entry.directory))) {
    syncDirectory(directory)
  }

  return { restored, unrecoverable, complete: unrecoverable.length === 0 }
}

function cleanupSnapshots(snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot?.snapshotPath) safeUnlink(snapshot.snapshotPath)
  }
}

function removeStagingRoot(stagingRoot) {
  try {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
  } catch {
    /* A surviving staging directory is litter, not corruption.
     * sweepStagingDirectories collects it later. */
  }
}

function safeUnlink(target) {
  try {
    fs.unlinkSync(target)
  } catch {
    /* Already gone, or never created. */
  }
}

function deviceOf(directory) {
  try {
    return fs.statSync(directory).dev
  } catch {
    return null
  }
}

/*
 * fsync the DIRECTORY, not just the file. Without this the rename can be lost
 * on a crash even though the file's contents were flushed, and the destination
 * reverts to its old name — which is still not a mix, but is a silently
 * dropped commit if the record claimed otherwise. The returned string goes
 * into the result so a filesystem that cannot do this is visible rather than
 * assumed.
 */
function syncDirectory(directory) {
  let descriptor = null
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
    return 'ok'
  } catch (error) {
    return `unsupported: ${error?.code ?? 'unknown'}`
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        /* Nothing left to do with a descriptor we cannot close. */
      }
    }
  }
}

/*
 * Truncated to 32 hex characters. This detects a file that changed under us,
 * which is all it is for; it is not a signature and nothing should treat it as
 * one.
 */
function digestOf(buffer) {
  return `sha256-${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)}`
}

async function callPhase(onPhase, phase, detail) {
  if (typeof onPhase !== 'function') return
  await onPhase(phase, detail)
}
