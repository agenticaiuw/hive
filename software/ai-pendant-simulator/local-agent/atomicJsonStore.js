import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const OWNER_READ_WRITE = 0o600
const BACKUP_SUFFIX = '.bak'

/**
 * Read a JSON document, repairing a missing or malformed primary from the
 * newest valid backup or interrupted-write temp file when one exists.
 */
export function readJsonWithRecovery(
  filePath,
  { fallback = null, validate = () => true } = {},
) {
  const result = readOrRecover(filePath, validate)
  return result.found ? result.value : fallback
}

/**
 * Ensure a JSON store exists without replacing an unrecoverable malformed
 * primary merely because it could not be parsed.
 */
export function ensureJsonStore(
  filePath,
  initialValue,
  { validate = () => true } = {},
) {
  ensureParentDirectory(filePath)
  const result = readOrRecover(filePath, validate)
  if (result.found) return result.value

  if (!fs.existsSync(filePath)) {
    writeJsonAtomic(filePath, initialValue, { validate })
  }
  return initialValue
}

/**
 * Durably replace a JSON document. The old valid value is backed up before
 * replacement, and the backup is advanced to the new value only after the
 * primary rename succeeds.
 */
export function writeJsonAtomic(
  filePath,
  value,
  { validate = () => true } = {},
) {
  if (!validate(value)) {
    throw new TypeError(`Refusing to write invalid JSON store: ${filePath}`)
  }

  const serialized = serializeJson(value)
  ensureParentDirectory(filePath)

  // Repair recoverable state before rotating it into the backup. This keeps a
  // malformed primary from erasing a valid backup or interrupted-write temp.
  const current = readOrRecover(filePath, validate)
  const backupPath = backupPathFor(filePath)
  writeRawAtomic(
    backupPath,
    current.found ? serializeJson(current.value) : serialized,
  )
  writeRawAtomic(filePath, serialized)

  // Once the primary rename is durable, the backup can safely represent the
  // latest committed value as well.
  if (current.found) {
    writeRawAtomic(backupPath, serialized)
  }

  return value
}

export function backupPathFor(filePath) {
  return `${filePath}${BACKUP_SUFFIX}`
}

function readOrRecover(filePath, validate) {
  const primary = readCandidate(filePath, validate)
  if (primary) {
    setOwnerOnly(filePath)
    return { found: true, value: primary.value }
  }

  const recovery = findRecoveryCandidate(filePath, validate)
  if (!recovery) return { found: false, value: null }

  const serialized = serializeJson(recovery.value)
  // Put the recovery value in the stable backup first. If restoring the
  // primary is interrupted, the next process still has a valid source.
  writeRawAtomic(backupPathFor(filePath), serialized)
  writeRawAtomic(filePath, serialized)
  setOwnerOnly(recovery.filePath)
  return { found: true, value: recovery.value }
}

function findRecoveryCandidate(filePath, validate) {
  const candidates = [
    { filePath: backupPathFor(filePath), priority: 0 },
    ...listTempCandidates(filePath).map((candidatePath) => ({
      filePath: candidatePath,
      priority: 1,
    })),
  ]
    .map(({ filePath: candidatePath, priority }) => {
      const candidate = readCandidate(candidatePath, validate)
      return candidate ? { ...candidate, priority } : null
    })
    .filter(Boolean)

  candidates.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || right.priority - left.priority,
  )
  return candidates[0] ?? null
}

function listTempCandidates(filePath) {
  const directory = path.dirname(filePath)
  const baseName = path.basename(filePath)
  let names
  try {
    names = fs.readdirSync(directory)
  } catch {
    return []
  }

  return names
    .filter((name) => {
      if (name.startsWith(`${baseName}${BACKUP_SUFFIX}`)) return false
      return (
        name === `${baseName}.tmp` ||
        name.startsWith(`${baseName}.tmp.`) ||
        (name.startsWith(`${baseName}.`) && name.endsWith('.tmp'))
      )
    })
    .map((name) => path.join(directory, name))
}

function readCandidate(candidatePath, validate) {
  try {
    const value = JSON.parse(fs.readFileSync(candidatePath, 'utf8'))
    if (!validate(value)) return null
    const { mtimeMs } = fs.statSync(candidatePath)
    return { filePath: candidatePath, value, mtimeMs }
  } catch {
    return null
  }
}

function serializeJson(value) {
  const serialized = JSON.stringify(value, null, 2)
  if (serialized === undefined) {
    throw new TypeError('JSON store values must be serializable.')
  }
  return serialized
}

function writeRawAtomic(filePath, contents) {
  ensureParentDirectory(filePath)
  const temporaryPath = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`
  let descriptor = null

  try {
    descriptor = fs.openSync(temporaryPath, 'wx', OWNER_READ_WRITE)
    fs.writeFileSync(descriptor, contents, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporaryPath, filePath)
    setOwnerOnly(filePath)
    syncDirectory(path.dirname(filePath))
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // Keep the original write error; a surviving owner-only temp remains a
      // valid recovery candidate on the next read.
    }
  }
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function setOwnerOnly(filePath) {
  try {
    fs.chmodSync(filePath, OWNER_READ_WRITE)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function syncDirectory(directory) {
  let descriptor = null
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch {
    // Some filesystems do not support fsync on directories. The file itself
    // has still been flushed and atomically renamed.
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}
