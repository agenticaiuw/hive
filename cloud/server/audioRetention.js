import {
  AUDIO_RETENTION_DEFAULT_MAX_AGE_MS,
  AUDIO_RETENTION_MAX_AGE_MS,
  AUDIO_RETENTION_SWEEP_ENABLED,
} from './config.js'
import { deleteAudioCaptureObject } from './audioStorage.js'

/*
 * Retention policy for stored voice recordings.
 *
 * Recordings are the one thing the relay keeps forever today: pruneExpiredJobs
 * deliberately skips `audio_capture` rows, and nothing ever calls into R2 to
 * remove an object. This module is that missing half.
 *
 * How deletion works, end to end:
 *  1. `GET  /v1/ops/audio-retention` reports the policy plus how many stored
 *     recordings are already past `maxAgeMs`. It reads only.
 *  2. `DELETE /v1/ops/history/:pipelineId/audio` (or
 *     `DELETE /v1/ops/audio-captures/:captureId/audio`) removes exactly one
 *     recording on demand, whatever its age.
 *  3. `POST /v1/ops/audio-retention/sweep` removes every expired recording.
 *     It is dry-run by default AND refuses to delete unless
 *     AUDIO_RETENTION_SWEEP_ENABLED=true, so enabling automatic expiry is a
 *     deliberate two-step act rather than a side effect of deploying.
 *
 * Default mode is 'audio': the R2 object is deleted and the inline D1 copy is
 * cleared, but the capture row survives with its transcript and byte counts so
 * history does not develop holes. Pass mode:'record' to drop the row as well.
 */

export const AUDIO_RETENTION_MODES = Object.freeze(['audio', 'record'])
export const AUDIO_RETENTION_SWEEP_MAX_BATCH = 200

export function audioRetentionPolicy({
  maxAgeMs = AUDIO_RETENTION_MAX_AGE_MS,
  sweepEnabled = AUDIO_RETENTION_SWEEP_ENABLED,
  now = Date.now(),
} = {}) {
  const safeMaxAgeMs = normalizeMaxAgeMs(maxAgeMs)
  return {
    maxAgeMs: safeMaxAgeMs,
    maxAgeDays: Math.round((safeMaxAgeMs / (1000 * 60 * 60 * 24)) * 100) / 100,
    defaultMaxAgeMs: AUDIO_RETENTION_DEFAULT_MAX_AGE_MS,
    sweepEnabled: Boolean(sweepEnabled),
    expiresBefore: new Date(now - safeMaxAgeMs).toISOString(),
    deletePath: '/v1/ops/history/:pipelineId/audio',
    sweepPath: '/v1/ops/audio-retention/sweep',
  }
}

export function normalizeMaxAgeMs(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : AUDIO_RETENTION_DEFAULT_MAX_AGE_MS
}

export function audioCaptureExpiresAt(
  capture,
  { maxAgeMs = AUDIO_RETENTION_MAX_AGE_MS } = {},
) {
  const createdAt = new Date(capture?.createdAt || 0).getTime()
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    return null
  }
  return new Date(createdAt + normalizeMaxAgeMs(maxAgeMs)).toISOString()
}

export function hasStoredAudio(capture) {
  if (!capture || capture.type !== 'audio_capture') {
    return false
  }
  return Boolean(capture.audioRef?.key || capture.audioBase64)
}

export function isAudioCaptureExpired(
  capture,
  { now = Date.now(), maxAgeMs = AUDIO_RETENTION_MAX_AGE_MS } = {},
) {
  if (!hasStoredAudio(capture)) {
    return false
  }
  const expiresAt = audioCaptureExpiresAt(capture, { maxAgeMs })
  // A capture with an unreadable timestamp is left alone on purpose: never
  // delete something just because its metadata is malformed.
  return Boolean(expiresAt) && new Date(expiresAt).getTime() <= now
}

export function selectExpiredAudioCaptures(
  captures = [],
  { now = Date.now(), maxAgeMs = AUDIO_RETENTION_MAX_AGE_MS, limit = AUDIO_RETENTION_SWEEP_MAX_BATCH } = {},
) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || AUDIO_RETENTION_SWEEP_MAX_BATCH, 1),
    AUDIO_RETENTION_SWEEP_MAX_BATCH,
  )
  return captures
    .filter((capture) => isAudioCaptureExpired(capture, { now, maxAgeMs }))
    .slice(0, safeLimit)
}

/**
 * Remove one recording. Returns a report instead of throwing on "nothing to
 * do" so callers can distinguish an already-empty capture from a failure.
 */
export async function deleteStoredAudio(
  store,
  capture,
  { mode = 'audio', reason = 'manual', now = new Date().toISOString(), bindings = undefined } = {},
) {
  if (!capture || capture.type !== 'audio_capture') {
    throw new TypeError('An audio capture record is required.')
  }
  const safeMode = AUDIO_RETENTION_MODES.includes(mode) ? mode : 'audio'

  let objectDeleted = false
  if (capture.audioRef?.provider === 'r2') {
    objectDeleted = await deleteAudioCaptureObject(
      capture,
      bindings ? { bindings } : {},
    )
  }

  if (safeMode === 'record') {
    const recordDeleted =
      typeof store?.deleteJob === 'function'
        ? Boolean(await store.deleteJob(capture.jobId))
        : false
    return {
      captureId: capture.jobId,
      mode: safeMode,
      objectDeleted,
      recordDeleted,
      inlineCleared: Boolean(capture.audioBase64),
      reason,
      deletedAt: now,
    }
  }

  const inlineCleared = Boolean(capture.audioBase64)
  await store.updateJob(capture.jobId, {
    audioBase64: undefined,
    audioRef: null,
    audioStorage: 'deleted',
    audioDeletedAt: now,
    audioDeletedReason: String(reason || 'manual').slice(0, 120),
  })

  return {
    captureId: capture.jobId,
    mode: safeMode,
    objectDeleted,
    recordDeleted: false,
    inlineCleared,
    reason,
    deletedAt: now,
  }
}

/**
 * Bytes on both sides of the line.
 *
 * A sweep that reports only row counts cannot tell four seconds of recording
 * from forty minutes of it, which makes "what did retention actually free"
 * unanswerable — and this sweep is the one that will run against the owner's
 * private audio if it is ever switched on. `audioBytes` is what the capture
 * recorded for itself; a capture that never recorded one contributes nothing
 * and is counted separately rather than guessed at.
 */
export function audioByteTotals(captures = []) {
  let bytes = 0
  let unknown = 0
  for (const capture of captures) {
    const value = Number(capture?.audioBytes)
    if (Number.isFinite(value) && value >= 0) bytes += value
    else unknown += 1
  }
  return { count: captures.length, bytes, unknownBytes: unknown }
}

export async function sweepExpiredAudio(
  store,
  {
    now = Date.now(),
    maxAgeMs = AUDIO_RETENTION_MAX_AGE_MS,
    limit = AUDIO_RETENTION_SWEEP_MAX_BATCH,
    mode = 'audio',
    dryRun = true,
    bindings = undefined,
  } = {},
) {
  const captures = await store.listJobs({
    type: 'audio_capture',
    limit: Math.min(Math.max(Number(limit) || 50, 1), 100),
  })
  const expired = selectExpiredAudioCaptures(captures, { now, maxAgeMs, limit })
  const policy = audioRetentionPolicy({ maxAgeMs, now })
  const expiredIds = new Set(expired.map((capture) => capture.jobId))
  const kept = captures.filter((capture) => !expiredIds.has(capture.jobId))

  const describe = (capture) => ({
    captureId: capture.jobId,
    createdAt: capture.createdAt,
    expiresAt: audioCaptureExpiresAt(capture, { maxAgeMs }),
    storage: capture.audioStorage || 'd1-base64',
    audioBytes: capture.audioBytes ?? null,
  })

  const totals = {
    scanned: audioByteTotals(captures),
    expired: audioByteTotals(expired),
    kept: audioByteTotals(kept),
    /* Only meaningful on a live run; stated as zero on a dry one so the field
     * is never absent and never has to be inferred. */
    removed: { count: 0, bytes: 0 },
  }

  if (dryRun) {
    return {
      dryRun: true,
      policy,
      scanned: captures.length,
      totals,
      expired: expired.map(describe),
      deleted: [],
    }
  }

  const deleted = []
  for (const capture of expired) {
    deleted.push(
      await deleteStoredAudio(store, capture, {
        mode,
        reason: 'retention',
        now: new Date(now).toISOString(),
        bindings,
      }),
    )
    totals.removed.count += 1
    const bytes = Number(capture?.audioBytes)
    if (Number.isFinite(bytes) && bytes >= 0) totals.removed.bytes += bytes
  }

  return {
    dryRun: false,
    policy,
    scanned: captures.length,
    totals,
    expired: expired.map(describe),
    deleted,
  }
}
