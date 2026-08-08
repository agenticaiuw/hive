/*
 * Keep synthesized pendant reply audio out of the D1 job row.
 *
 * A bridge result carries `result.pendantSpeech` with the spoken reply as
 * base64: `audioBase64` (raw s16le PCM — megabytes for anything longer than a
 * sentence) and, alongside it, a small `compressedAudioBase64` (ogg-opus).
 * `store.updateJob` serializes the entire job — result included — into a single
 * D1 value, and Cloudflare D1 rejects a value/row past ~1 MB (the same ceiling
 * audio captures respect via DIAGNOSTIC_AUDIO_MAX_BYTES). A voice reply is one
 * short sentence and fits; a routine that AUTO-RUNS (since the venue-policy fix)
 * produces a full spoken briefing whose PCM is ~12 MB, so the write throws and
 * the bridge sees a bare 500.
 *
 * The fix is the one the voice/diagnostic capture path already uses: when the
 * audio is too big to inline, write it to R2 with persistAudioCapture() and
 * keep only a reference in D1. Small replies stay byte-identical inline, so the
 * hot voice download path is untouched. Nothing here throws: an R2 outage drops
 * the oversized field (the pendant then falls back to cloud TTS from the stored
 * text) rather than blocking the report.
 */
import { Buffer } from 'node:buffer'

import { getCloudflareBindings } from './cloudflareBindings.js'
import { loadAudioByRef, persistAudioCapture } from './audioStorage.js'

/*
 * D1 stores the whole job as ONE JSON value, and SQLite refuses a value past its
 * own ceiling with `string or blob too big: SQLITE_TOOBIG` -- a different, far
 * smaller limit than the 32 MiB binding-RPC one. Everything below is measured
 * against that ceiling rather than guessed per field: the row also carries the
 * command, actions, telemetry, and (for a research brief) markdown and source
 * text, so "the audio looks small" is not evidence the row will fit.
 */
export const D1_VALUE_MAX_BYTES = 1_000_000
/* Written rows are held well under the ceiling: the remaining fields, UTF-8
 * expansion of non-ASCII, and later patches (deviceEvents, downlink receipts)
 * all land in the same value after this write. */
export const STORED_ROW_TARGET_BYTES = 600_000

/* Per-field trigger for moving one audio field to R2. Kept small because an R2
 * object costs nothing to make and a reference is ~200 bytes. */
export const PENDANT_SPEECH_FIELD_INLINE_MAX_BYTES = 64 * 1024
/* Only a payload whose audio is genuinely tiny is worth leaving inline at all. */
export const PENDANT_SPEECH_INLINE_TOTAL_MAX_BYTES = 96 * 1024

/** Serialized size in UTF-8 bytes -- the unit SQLite's ceiling is counted in. */
export function serializedBytes(value) {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? 0 : Buffer.byteLength(json, 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Return a pendantSpeech object safe to store in D1: large base64 audio fields
 * are replaced by R2 references, small ones are left inline unchanged. Never
 * throws.
 */
export async function offloadLargePendantSpeech({
  jobId,
  speech,
  createdAt = new Date().toISOString(),
  bindings = getCloudflareBindings(),
} = {}) {
  if (!speech || typeof speech !== 'object') {
    return speech
  }

  const audioBase64 = String(speech.audioBase64 || '')
  const compressedAudioBase64 = String(speech.compressedAudioBase64 || '')
  const inlineTotal = audioBase64.length + compressedAudioBase64.length

  // Typical short voice reply: leave it exactly as-is (served inline, no R2).
  if (inlineTotal <= PENDANT_SPEECH_INLINE_TOTAL_MAX_BYTES) {
    return speech
  }

  const next = { ...speech }
  let offloaded = false

  if (audioBase64.length > PENDANT_SPEECH_FIELD_INLINE_MAX_BYTES) {
    offloaded = true
    const persisted = await persistAudioCapture({
      captureId: String(jobId),
      audioBase64,
      format: 's16le',
      createdAt,
      // It is already too big for D1; never let the fallback keep it inline.
      allowD1Fallback: false,
      bindings,
    }).catch((error) => ({
      audioStorage: 'unavailable',
      audioRef: null,
      audioStorageWarning: `raw PCM offload failed: ${String(
        error?.message || error,
      ).slice(0, 200)}`,
    }))

    delete next.audioBase64
    if (persisted.audioStorage === 'r2' && persisted.audioRef) {
      next.audioRef = persisted.audioRef
    } else {
      next.audioStorageWarning =
        persisted.audioStorageWarning ||
        'raw PCM dropped: too large for D1 and R2 unavailable'
    }
  }

  if (compressedAudioBase64.length > PENDANT_SPEECH_FIELD_INLINE_MAX_BYTES) {
    offloaded = true
    const persisted = await persistAudioCapture({
      captureId: `${jobId}-opus`,
      audioBase64: compressedAudioBase64,
      format: 'ogg-opus',
      createdAt,
      allowD1Fallback: false,
      bindings,
    }).catch((error) => ({
      audioStorage: 'unavailable',
      audioRef: null,
      audioStorageWarning: `opus offload failed: ${String(
        error?.message || error,
      ).slice(0, 200)}`,
    }))

    delete next.compressedAudioBase64
    if (persisted.audioStorage === 'r2' && persisted.audioRef) {
      next.compressedAudioRef = persisted.audioRef
    } else {
      next.audioStorageWarning =
        persisted.audioStorageWarning ||
        next.audioStorageWarning ||
        'opus dropped: too large for D1 and R2 unavailable'
    }
  }

  if (offloaded) {
    next.audioStorage = 'r2'
  }
  return next
}

/*
 * Audio is not only at result.pendantSpeech. An executed plan carries its
 * runner's output verbatim -- bridge.js does `plan.execution = execution` --
 * and a briefing action attaches its own full-length payload to the result it
 * returns (local-agent/computerControl.js). So the same minutes-long audio also
 * sits at result.execution.results[i].pendantSpeech, and THAT copy is what blew
 * the row after the top-level one was already offloaded.
 *
 * Only result.pendantSpeech is ever served (pendantSpeechForJob reads exactly
 * that path), so nested copies are diagnostic duplicates: their bulky base64 is
 * dropped rather than each getting an R2 object nothing would ever read. The
 * descriptive metadata stays so the dashboard can still report what was
 * rendered.
 */
const NESTED_AUDIO_FIELD_MAX_BYTES = 64 * 1024
const NESTED_WALK_MAX_DEPTH = 8
const NESTED_WALK_MAX_NODES = 5000

function stripNestedSpeechAudio(value, state, depth = 0) {
  if (depth > NESTED_WALK_MAX_DEPTH || state.nodes > NESTED_WALK_MAX_NODES) {
    return value
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      state.nodes += 1
      const mapped = stripNestedSpeechAudio(entry, state, depth + 1)
      if (mapped !== entry) changed = true
      return mapped
    })
    return changed ? next : value
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  let changed = false
  const next = {}
  for (const [key, entry] of Object.entries(value)) {
    state.nodes += 1
    if (
      (key === 'audioBase64' || key === 'compressedAudioBase64') &&
      typeof entry === 'string' &&
      entry.length > NESTED_AUDIO_FIELD_MAX_BYTES
    ) {
      changed = true
      next.audioOmitted = true
      continue
    }
    const mapped = stripNestedSpeechAudio(entry, state, depth + 1)
    if (mapped !== entry) changed = true
    next[key] = mapped
  }
  return changed ? next : value
}

/**
 * Offload any oversized pendantSpeech carried by a bridge result, returning a
 * result safe to persist: the served payload goes to R2, and bulky duplicates
 * nested deeper in the result are dropped. Text, actions and parked markers are
 * preserved untouched. Never throws.
 */
export async function offloadResultSpeechAudio({
  jobId,
  result,
  createdAt,
  bindings = getCloudflareBindings(),
} = {}) {
  if (!result || typeof result !== 'object') {
    return result
  }

  const speech = result.pendantSpeech
  const slim =
    speech && typeof speech === 'object'
      ? await offloadLargePendantSpeech({ jobId, speech, createdAt, bindings })
      : speech

  // Walk everything except the served payload, which was just handled above.
  const { pendantSpeech: _served, ...rest } = result
  const strippedRest = stripNestedSpeechAudio(rest, { nodes: 0 })

  if (slim === speech && strippedRest === rest) {
    return result
  }
  return {
    ...strippedRest,
    ...(speech === undefined ? {} : { pendantSpeech: slim }),
  }
}

/* Every inline audio field, anywhere, replaced by an explicit omission marker. */
function stripAllInlineAudio(value, reason, state, depth = 0) {
  if (depth > NESTED_WALK_MAX_DEPTH || state.nodes > NESTED_WALK_MAX_NODES) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      state.nodes += 1
      return stripAllInlineAudio(entry, reason, state, depth + 1)
    })
  }
  if (!value || typeof value !== 'object') return value

  const next = {}
  for (const [key, entry] of Object.entries(value)) {
    state.nodes += 1
    if (
      (key === 'audioBase64' || key === 'compressedAudioBase64') &&
      typeof entry === 'string'
    ) {
      next.audioOmitted = true
      next.audioOmittedReason = reason
      continue
    }
    next[key] = stripAllInlineAudio(entry, reason, state, depth + 1)
  }
  return next
}

/* Last resort before dropping detail wholesale: clip the long prose (a brief's
 * markdown, scraped source text) that is not the reason anyone reads this row. */
function truncateLargeStrings(value, maxChars, state, depth = 0) {
  if (depth > NESTED_WALK_MAX_DEPTH || state.nodes > NESTED_WALK_MAX_NODES) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      state.nodes += 1
      return truncateLargeStrings(entry, maxChars, state, depth + 1)
    })
  }
  if (typeof value === 'string') {
    return value.length > maxChars
      ? `${value.slice(0, maxChars)}…[truncated for storage]`
      : value
  }
  if (!value || typeof value !== 'object') return value

  const next = {}
  for (const [key, entry] of Object.entries(value)) {
    state.nodes += 1
    /* The spoken reply is the point of the row; never clip it. */
    next[key] =
      key === 'response' || key === 'summary'
        ? entry
        : truncateLargeStrings(entry, maxChars, state, depth + 1)
  }
  return next
}

/* What the reaper, the approval surfaces and the dashboard actually need. */
function essentialResult(result, notes) {
  const keep = {}
  for (const key of [
    'response',
    'summary',
    'executed',
    'phase',
    'parked',
    'approval',
    'awaitingApproval',
    'executionError',
    'planner',
    'status',
    'pendantSpeech',
  ]) {
    if (result[key] !== undefined) keep[key] = result[key]
  }
  if (Array.isArray(result.actions)) {
    keep.actions = result.actions.slice(0, 20)
  }
  keep.storageTrimmed = true
  keep.storageNotes = notes
  return keep
}

/**
 * Make a result safe to store, deciding from the MEASURED serialized size of the
 * row that is about to be written rather than from any per-field guess.
 *
 * The ladder degrades in the order that costs the owner least, and every rung is
 * recorded in the stored result so nothing downstream has to infer what happened:
 *
 *   1. move the served reply audio to R2, drop nested duplicates  (no loss)
 *   2. drop every remaining inline audio field                    (audio lost)
 *   3. clip long prose -- brief markdown, scraped source text     (detail lost)
 *   4. keep only what the reaper and approval surfaces read       (detail lost)
 *
 * A briefing whose text and status survive is worth far more than a run recorded
 * as failed, so this never throws and never gives up on storing something.
 */
export async function prepareResultForStorage({
  jobId,
  baseRow = {},
  result,
  createdAt,
  bindings = getCloudflareBindings(),
  targetBytes = STORED_ROW_TARGET_BYTES,
  logger = console,
} = {}) {
  const notes = []
  const rowBytes = (candidate) => serializedBytes({ ...baseRow, result: candidate })
  const startedBytes = rowBytes(result)

  let current = result
  try {
    current = await offloadResultSpeechAudio({
      jobId,
      result,
      createdAt,
      bindings,
    })
    if (current !== result) notes.push('audio-offloaded-to-r2')
  } catch (error) {
    notes.push('audio-offload-failed')
    logger?.warn?.(
      `[relay] pendantSpeech offload failed for ${jobId}: ${
        error?.message || error
      }`,
    )
    current = result
  }

  if (!current || typeof current !== 'object' || rowBytes(current) <= targetBytes) {
    return { result: current, bytes: rowBytes(current), startedBytes, notes }
  }

  current = stripAllInlineAudio(
    current,
    'stored row would exceed the D1 value limit',
    { nodes: 0 },
  )
  notes.push('inline-audio-dropped')
  if (rowBytes(current) <= targetBytes) {
    return { result: current, bytes: rowBytes(current), startedBytes, notes }
  }

  current = truncateLargeStrings(current, 8_000, { nodes: 0 })
  notes.push('long-text-truncated')
  if (rowBytes(current) <= targetBytes) {
    return { result: current, bytes: rowBytes(current), startedBytes, notes }
  }

  notes.push('reduced-to-essentials')
  current = essentialResult(current, notes.join(','))
  return { result: current, bytes: rowBytes(current), startedBytes, notes }
}

/**
 * Resolve reply audio bytes for a stored pendantSpeech, reading from the inline
 * base64 when present and otherwise from its R2 reference.
 */
export async function resolvePendantSpeechBuffers({
  speech,
  bindings = getCloudflareBindings(),
} = {}) {
  if (!speech || typeof speech !== 'object') {
    return { pcm: null, opus: null }
  }

  const opus = await resolveField({
    inline: speech.compressedAudioBase64,
    ref: speech.compressedAudioRef,
    bindings,
  })
  const pcm = await resolveField({
    inline: speech.audioBase64,
    ref: speech.audioRef,
    bindings,
  })
  return { pcm, opus }
}

async function resolveField({ inline, ref, bindings }) {
  const clean = String(inline || '').trim()
  if (clean) {
    const buffer = Buffer.from(clean, 'base64')
    return buffer.length ? buffer : null
  }
  if (ref) {
    const loaded = await loadAudioByRef(ref, { bindings }).catch(() => null)
    if (loaded?.audio?.length) {
      return loaded.audio
    }
  }
  return null
}
