import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  backupPathFor,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { clearPendantSpeechCache, pendantSpeechCacheSize } from './pendantSpeech.js'

/*
 * Bounded retention and honest deletion for audio on this Mac.
 *
 * WHAT IS HERE AND WHY IT NEEDED SOMETHING
 * ----------------------------------------
 * Two directories under the workspace hold sound, and until this module
 * nothing expired either of them:
 *
 *   Briefings/*.wav|*.opus            audioBrief.js — a briefing spoken to the
 *                                     owner. GENERATED; regenerable from the
 *                                     .md note beside it.
 *   pipeline-audio/<sha256>-input.wav  the owner's own voice, as captured.
 *   pipeline-audio/<sha256>-output.wav what the agent said back.
 *
 * Measured on this machine on 2026-08-07, after one day of use:
 *
 *   Briefings   18 .wav (50.2 MB) + 18 .opus (2.1 MB)
 *   pipeline    61 .wav (8.2 MB)
 *   TOTAL       60.4 MB of audio across 97 files, none of it expiring.
 *
 * THE ORPHAN PROBLEM, WHICH IS WHY THIS SWEEPS THE FILESYSTEM AND NOT A STORE
 * --------------------------------------------------------------------------
 * audioBrief.js caps .pendant-briefings.json at MAX_STORED_BRIEFINGS = 50
 * ENTRIES. pipelineTrace.js caps pendant-pipeline.json at MAX_RUNS = 80 RUNS.
 * Both caps evict metadata. Neither deletes a file. At the moment of writing,
 * 17 of the 18 .wav files in Briefings — 48.2 MB, 80% of all audio bytes on
 * disk — were referenced by no store entry at all, because a routine had
 * pushed 50 identical entries in front of them.
 *
 * So a sweeper that walked the store would have found 50 entries pointing at
 * one file and reported the disk clean while 48 MB of the owner's briefings
 * sat there forever. The filesystem is the source of truth here; the stores
 * are consulted only to attribute a file to a job and to remove the matching
 * metadata afterwards.
 *
 * THE BUDGET IS IN BYTES. IT IS NEVER AN ITEM COUNT.
 * --------------------------------------------------
 * jobTracker.js carries the postmortem: a store that capped a COUNT reached
 * 129 MB and the agent stopped answering. The same mistake is what produced
 * the orphans above. A count reads identically whether the items are ten
 * kilobytes or ten megabytes, and audio is exactly the payload where that
 * difference is four orders of magnitude — a 10-second reply is 480 KB of PCM,
 * a two-minute briefing is 5.8 MB. Every bound in this file is bytes or
 * milliseconds.
 *
 * THE PENDANT'S SD CARD IS NOT A LIBRARY AND THIS MODULE DOES NOT TREAT IT AS
 * ONE
 * --------------------------------------------------------------------------
 * firmware/nrf9160/src/pendant_store.h states the owner's standing rule:
 * "Only save an audio copy to SD if the chunk upload cannot be uploaded. SD is
 * the failure path, never the default." A copy on the card exists only because
 * a delivery failed, and the device — not this process — decides when it goes
 * (renamed into the outbox on failure, truncated by the next press on
 * success). Nothing here writes to the card, asks for a copy from it, or
 * claims to have deleted one. When the pipeline telemetry says a recording
 * went to microSD, deletion reports that copy as OUT OF REACH by name rather
 * than reporting success it cannot support.
 *
 * DELETION NEVER GOES THROUGH undo.js
 * -----------------------------------
 * undo.js snapshots what it removes into .undo/ so a delete can be reversed.
 * That is right for a downloaded PDF and wrong for a recording of the owner's
 * voice: it would answer "delete this" by making a second copy. Removal here
 * is fs.rmSync, and the .undo directory was verified to hold no audio.
 */

/* Sound only. The Briefings directory is shared — briefing.js writes its
 * routine notes to `briefings/` and a case-insensitive volume makes that the
 * same directory — so latest.json and every .md in there belong to somebody
 * else and must survive a sweep untouched. */
const GENERATED_AUDIO_EXTENSIONS = Object.freeze(['.wav', '.opus'])

/* pipelineAudio.js names files sha256(pipelineId) + direction. The shape is
 * matched exactly so a stray file dropped in that directory by hand is
 * reported rather than deleted. */
const PIPELINE_AUDIO_NAME = /^([0-9a-f]{64})-(input|output)\.wav$/

export const AUDIO_KINDS = Object.freeze(['generated', 'captured', 'spoken'])

const HOUR_MS = 60 * 60 * 1000

/*
 * Defaults, and the arithmetic behind each one.
 *
 * captured (6 h)   The owner's own voice. Transcription has already succeeded
 *                  by the time the file exists, so the recording is a
 *                  debugging byproduct of a finished job. It is the most
 *                  sensitive thing the system holds and gets the shortest
 *                  life. Zero of these were on disk when measured, so the
 *                  choice costs nothing today and is the right default the
 *                  day the first one lands.
 * spoken   (24 h)  Playback diagnostics — "did the agent sound distorted
 *                  yesterday" is a real question; "last week" is not.
 * generated (48 h) A briefing the owner may not have listened to yet. Two
 *                  days covers "yesterday's briefing" and stops there; the
 *                  .md note beside it is text and is not touched, so nothing
 *                  the owner can read is lost when the audio expires.
 *
 * maxBytes (256 MiB) The hard ceiling. Measured generation rate was 52.3 MB of
 *                  briefing audio in the twelve hours from 01:55 to 13:52,
 *                  about 105 MB/day, so 48 h of generated audio is ~210 MB and
 *                  normally the age limits bite first. The byte budget exists
 *                  for the case age cannot cover: a burst — a routine that
 *                  fires in a loop, exactly what produced the 50 identical
 *                  entries measured above — where a day's worth arrives in an
 *                  hour and every file is young.
 */
export const AUDIO_RETENTION_DEFAULT_MAX_AGE_MS = Object.freeze({
  generated: 48 * HOUR_MS,
  captured: 6 * HOUR_MS,
  spoken: 24 * HOUR_MS,
})

export const AUDIO_RETENTION_DEFAULT_MAX_BYTES = 256 * 1024 * 1024

/* A zero or a typo in the environment must never widen deletion. Anything
 * that is not a positive finite number falls back to the default, so
 * PENDANT_AUDIO_MAX_AGE_HOURS=0 means "use 48 h", never "erase everything". */
function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function audioRetentionPolicy({
  maxBytes,
  maxAgeMs,
  now = Date.now(),
} = {}) {
  const configured = maxAgeMs && typeof maxAgeMs === 'object' ? maxAgeMs : {}
  const ages = {
    generated: positiveNumber(
      configured.generated ??
        positiveNumber(process.env.PENDANT_AUDIO_MAX_AGE_HOURS, 0) * HOUR_MS,
      AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.generated,
    ),
    captured: positiveNumber(
      configured.captured ??
        positiveNumber(process.env.PENDANT_AUDIO_CAPTURED_MAX_AGE_HOURS, 0) *
          HOUR_MS,
      AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.captured,
    ),
    spoken: positiveNumber(
      configured.spoken ??
        positiveNumber(process.env.PENDANT_AUDIO_SPOKEN_MAX_AGE_HOURS, 0) *
          HOUR_MS,
      AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.spoken,
    ),
  }

  return {
    maxBytes: positiveNumber(
      maxBytes ??
        positiveNumber(process.env.PENDANT_AUDIO_MAX_BYTES, 0),
      AUDIO_RETENTION_DEFAULT_MAX_BYTES,
    ),
    maxAgeMs: ages,
    /* Reported so a caller can see the effective policy without recomputing
     * it, and so "why did that disappear" has an answer in the response. */
    expiresBefore: Object.fromEntries(
      AUDIO_KINDS.map((kind) => [
        kind,
        new Date(now - ages[kind]).toISOString(),
      ]),
    ),
    enabled: String(process.env.PENDANT_AUDIO_RETENTION_DISABLED || '')
      .toLowerCase() !== 'true',
    unit: 'bytes',
  }
}

export function audioRetentionLocations({ workspace = workspacePath } = {}) {
  const root = path.resolve(workspace)
  return {
    workspace: root,
    /* audioBrief.js uses the capitalised name; briefing.js uses the lowercase
     * one. On this volume they are the same directory, which is precisely why
     * the extension filter above matters. */
    briefings: path.join(root, 'Briefings'),
    pipelineAudio: path.join(root, 'pipeline-audio'),
    briefingStore: path.join(root, '.pendant-briefings.json'),
    pipelineStore: path.join(root, 'pendant-pipeline.json'),
  }
}

function resolveLocations(options = {}) {
  return options.locations ?? audioRetentionLocations(options)
}

const digestOf = (value) =>
  crypto.createHash('sha256').update(String(value)).digest('hex')

/*
 * Attribution tables.
 *
 * Read directly from the store files rather than through audioBrief.js and
 * pipelineTrace.js: both hard-code the real workspace path with no way to
 * point them elsewhere, which would make every test here write to the owner's
 * actual briefing shelf. Reads are read-only and use the same recovery helper
 * those modules use, so a half-written store is handled identically.
 */
function readBriefingIndex(storePath) {
  const store = readJsonWithRecovery(storePath, {
    fallback: { briefings: [] },
    validate: (value) => value && Array.isArray(value.briefings),
  })
  const byFileName = new Map()
  for (const briefing of store.briefings) {
    for (const key of ['wavPath', 'opusPath']) {
      if (briefing?.[key]) byFileName.set(path.basename(briefing[key]), briefing)
    }
  }
  return { store, byFileName }
}

function readPipelineIndex(storePath) {
  const runs = readJsonWithRecovery(storePath, {
    fallback: [],
    validate: Array.isArray,
  })
  const byDigest = new Map()
  for (const run of runs) {
    if (!run?.pipelineId) continue
    byDigest.set(digestOf(run.pipelineId), run)
  }
  return byDigest
}

/*
 * Did the device journal this recording to its SD card?
 *
 * pipelineTrace.js keeps the transcription event's inputTelemetry, and
 * cloud-relay stamps `storage: 'microsd'` on it when the pendant delivered a
 * recording out of the offline outbox instead of over a live socket. That flag
 * is the only evidence this process ever gets that a second copy existed on
 * hardware it cannot touch — so it is the difference between reporting a
 * deletion complete and admitting it is not.
 */
function usedMicroSd(run) {
  const events = Array.isArray(run?.events) ? run.events : []
  return events.some(
    (event) =>
      event?.stage === 'transcription' &&
      String(event?.meta?.inputTelemetry?.storage || '').toLowerCase() ===
        'microsd',
  )
}

function listAudioFiles(directory, classify) {
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    /* A workspace that has never produced audio has no directory, which is a
     * clean scan and not an error. */
    return { files: [], skipped: [] }
  }

  const files = []
  const skipped = []
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (!entry.isFile()) {
      /* Symlinks and directories are left alone. Following one would let a
       * link planted in the audio directory aim deletion at anything the
       * agent can write. */
      if (!entry.isDirectory()) skipped.push({ path: filePath, reason: 'not-a-regular-file' })
      continue
    }
    const classified = classify(entry.name)
    if (!classified) {
      skipped.push({ path: filePath, reason: 'not-pendant-audio' })
      continue
    }
    let stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }
    files.push({
      path: filePath,
      name: entry.name,
      bytes: stats.size,
      modifiedAt: new Date(stats.mtimeMs).toISOString(),
      mtimeMs: stats.mtimeMs,
      ...classified,
    })
  }
  return { files, skipped }
}

/**
 * Every audio file this process can reach, with what it belongs to.
 *
 * `attributable: false` is the load-bearing field. A pipeline recording is
 * named by the sha256 of its pipelineId, and a hash does not invert — once
 * pendant-pipeline.json has rolled past MAX_RUNS the file is still deletable by
 * age or by budget, but "forget everything from that conversation" can never
 * find it again unless the caller still knows the id. Saying so is the point.
 */
export function scanAudioOnDisk(options = {}) {
  const locations = resolveLocations(options)
  const now = options.now ?? Date.now()

  const briefings = listAudioFiles(locations.briefings, (name) =>
    GENERATED_AUDIO_EXTENSIONS.includes(path.extname(name).toLowerCase())
      ? { kind: 'generated', directory: 'Briefings', digest: null }
      : null,
  )
  const pipeline = listAudioFiles(locations.pipelineAudio, (name) => {
    const match = PIPELINE_AUDIO_NAME.exec(name)
    if (!match) return null
    return {
      kind: match[2] === 'input' ? 'captured' : 'spoken',
      directory: 'pipeline-audio',
      digest: match[1],
      direction: match[2],
    }
  })

  const briefingIndex = readBriefingIndex(locations.briefingStore)
  const pipelineIndex = readPipelineIndex(locations.pipelineStore)

  const files = [...briefings.files, ...pipeline.files].map((file) => {
    if (file.kind === 'generated') {
      const briefing = briefingIndex.byFileName.get(file.name) ?? null
      return {
        ...file,
        ageMs: Math.max(0, now - file.mtimeMs),
        jobId: null,
        briefingId: briefing?.id ?? null,
        topic: briefing?.topic ?? null,
        attributable: Boolean(briefing),
        microSdCopy: false,
      }
    }
    const run = pipelineIndex.get(file.digest) ?? null
    return {
      ...file,
      ageMs: Math.max(0, now - file.mtimeMs),
      jobId: run?.pipelineId ?? null,
      briefingId: null,
      topic: run?.command ? String(run.command).slice(0, 120) : null,
      attributable: Boolean(run),
      microSdCopy: run ? usedMicroSd(run) : false,
    }
  })

  files.sort((left, right) => left.mtimeMs - right.mtimeMs)

  const byKind = Object.fromEntries(
    AUDIO_KINDS.map((kind) => {
      const matching = files.filter((file) => file.kind === kind)
      return [
        kind,
        {
          files: matching.length,
          bytes: matching.reduce((total, file) => total + file.bytes, 0),
        },
      ]
    }),
  )

  const unattributable = files.filter((file) => !file.attributable)

  return {
    scannedAt: new Date(now).toISOString(),
    locations,
    files,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    count: files.length,
    byKind,
    /* The measured 48.2 MB. Reported as its own number because it is the
     * failure this module exists to make visible, not a footnote. */
    unattributable: {
      files: unattributable.length,
      bytes: unattributable.reduce((total, file) => total + file.bytes, 0),
    },
    skipped: [...briefings.skipped, ...pipeline.skipped],
  }
}

/**
 * What a sweep would remove, and why each file is on the list.
 *
 * Age first, then bytes. Anything still inside its retention window is
 * evicted oldest-first until the survivors fit the budget, which keeps the
 * newest audio — the briefing the owner has not played yet — last to go.
 */
export function planAudioSweep(options = {}) {
  const now = options.now ?? Date.now()
  const policy = audioRetentionPolicy({ ...options, now })
  const inventory = options.inventory ?? scanAudioOnDisk({ ...options, now })

  const remove = []
  const survivors = []
  for (const file of inventory.files) {
    if (file.ageMs > policy.maxAgeMs[file.kind]) {
      remove.push({ ...file, reason: 'expired' })
    } else {
      survivors.push(file)
    }
  }

  /* scanAudioOnDisk already sorted oldest-first; re-sorting here keeps the
   * guarantee if a caller hands in its own inventory. */
  survivors.sort((left, right) => left.mtimeMs - right.mtimeMs)
  let survivingBytes = survivors.reduce((total, file) => total + file.bytes, 0)
  const overBudgetBy = Math.max(0, survivingBytes - policy.maxBytes)
  while (survivingBytes > policy.maxBytes && survivors.length) {
    const evicted = survivors.shift()
    remove.push({ ...evicted, reason: 'over-budget' })
    survivingBytes -= evicted.bytes
  }

  return {
    policy,
    scanned: { files: inventory.count, bytes: inventory.bytes },
    byKind: inventory.byKind,
    unattributable: inventory.unattributable,
    remove,
    wouldFreeBytes: remove.reduce((total, file) => total + file.bytes, 0),
    keep: { files: survivors.length, bytes: survivingBytes },
    overBudgetBy,
  }
}

function unlinkQuietly(filePath) {
  try {
    fs.rmSync(filePath, { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/*
 * Drop briefing entries whose audio has just been removed.
 *
 * An entry left behind is not harmless bookkeeping: it carries `spoken`, the
 * full transcript of what was said — 32 700 characters of it across the 50
 * entries measured. Deleting the recording and keeping the words is not
 * deletion. Entries are removed rather than blanked because audioBrief.js
 * offers no way to edit one, and inventing a partial-write path into a store
 * another module owns is how two writers disagree about a schema.
 */
function pruneBriefingEntries(storePath, { ids = [], fileNames = [] } = {}) {
  const validate = (value) => value && Array.isArray(value.briefings)
  const store = readJsonWithRecovery(storePath, {
    fallback: { briefings: [] },
    validate,
  })
  const idSet = new Set(ids.filter(Boolean))
  const nameSet = new Set(fileNames.filter(Boolean))

  const kept = store.briefings.filter((briefing) => {
    if (idSet.has(briefing?.id)) return false
    for (const key of ['wavPath', 'opusPath']) {
      if (briefing?.[key] && nameSet.has(path.basename(briefing[key]))) {
        return false
      }
    }
    return true
  })

  const removed = store.briefings.length - kept.length
  if (!removed) return { removed: 0, remaining: store.briefings.length }
  writeJsonAtomic(storePath, { ...store, briefings: kept }, { validate })
  return { removed, remaining: kept.length }
}

/*
 * Look for the deleted id in the store's siblings.
 *
 * writeJsonAtomic advances the .bak to the new value once the primary rename
 * lands, so after a clean write nothing should remain — but a crash between
 * the two writes, or an abandoned .tmp from an interrupted process, leaves a
 * readable copy of the transcript sitting next to a store that no longer has
 * it. This is cheap to check and the whole promise of this module is that we
 * check instead of assuming.
 */
function residualStoreCopies(storePath, needles = []) {
  const terms = needles.filter(Boolean).map(String)
  if (!terms.length) return []

  const directory = path.dirname(storePath)
  const base = path.basename(storePath)
  let siblings
  try {
    siblings = fs.readdirSync(directory)
  } catch {
    return []
  }

  const found = []
  for (const name of siblings) {
    if (name === base) continue
    if (!name.startsWith(`${base}.`) && name !== path.basename(backupPathFor(storePath))) {
      continue
    }
    const siblingPath = path.join(directory, name)
    let contents
    try {
      contents = fs.readFileSync(siblingPath, 'utf8')
    } catch {
      continue
    }
    if (terms.some((term) => contents.includes(term))) {
      found.push(siblingPath)
    }
  }
  return found
}

/**
 * Remove the audio for one job or briefing and report exactly what went.
 *
 * The id may be a pipelineId, a local jobId, or a briefing id. Pipeline audio
 * is found by hashing the id the caller supplied rather than by looking it up,
 * which means this still works after pendant-pipeline.json has rolled past its
 * run cap and the file has become unattributable to everyone who does not
 * already know the id.
 */
export function deleteAudioForJob(jobId, options = {}) {
  const id = String(jobId ?? '').trim()
  if (!id) throw new Error('deleteAudioForJob needs a job or briefing id.')

  const locations = resolveLocations(options)
  const now = options.now ?? Date.now()
  const inventory = options.inventory ?? scanAudioOnDisk({ ...options, now })
  const digest = digestOf(id)

  const targets = inventory.files.filter(
    (file) =>
      file.digest === digest || file.jobId === id || file.briefingId === id,
  )

  const removed = []
  const failed = []
  for (const file of targets) {
    const outcome = unlinkQuietly(file.path)
    if (outcome.ok) {
      removed.push({
        path: file.path,
        kind: file.kind,
        bytes: file.bytes,
        directory: file.directory,
      })
    } else {
      failed.push({ path: file.path, kind: file.kind, error: outcome.error })
    }
  }

  const metadata = pruneBriefingEntries(locations.briefingStore, {
    ids: [id],
    fileNames: removed.map((file) => path.basename(file.path)),
  })

  const residual = residualStoreCopies(locations.briefingStore, [id])

  /* Wholesale, because the reply cache in pendantSpeech.js is keyed by spoken
   * TEXT, not by job — there is no way to evict one job's line from it. A
   * regenerated "Done." costs one `say` invocation; a retained recording of
   * something the owner asked to be forgotten costs more than that. */
  const speechCacheEntries = pendantSpeechCacheSize()
  const clearSpeechCache = options.clearSpeechCache !== false
  if (clearSpeechCache && speechCacheEntries) clearPendantSpeechCache()

  const usedSd = targets.some((file) => file.microSdCopy)
  const unreachable = reachabilityForJob(id, {
    usedMicroSd: usedSd,
    residual,
  })

  return {
    jobId: id,
    matched: targets.length,
    removed,
    failed,
    freedBytes: removed.reduce((total, file) => total + file.bytes, 0),
    metadata: {
      briefingEntriesRemoved: metadata.removed,
      briefingEntriesRemaining: metadata.remaining,
      speechCacheCleared: clearSpeechCache && speechCacheEntries > 0,
      speechCacheEntries,
    },
    unreachable,
    /* True only when nothing failed and no sink is known or suspected to hold
     * another copy. A per-job delete that cannot say this says so. */
    complete:
      failed.length === 0 &&
      !unreachable.some((sink) => sink.holdsCopy !== 'no'),
    deletedAt: new Date(now).toISOString(),
  }
}

/**
 * Enforce the policy across everything on disk.
 *
 * Dry-run by default. `apply: true` is the only thing that removes a file,
 * because a GET-shaped mistake against a route that erases the owner's voice
 * is not a mistake anyone gets to make twice.
 */
export function sweepAudio(options = {}) {
  const now = options.now ?? Date.now()
  const locations = resolveLocations(options)
  const plan = planAudioSweep({ ...options, locations, now })
  const apply = options.apply === true

  if (!apply || !plan.policy.enabled) {
    return {
      ...plan,
      dryRun: true,
      applied: false,
      blocked: plan.policy.enabled ? null : 'PENDANT_AUDIO_RETENTION_DISABLED',
      removed: [],
      failed: [],
      freedBytes: 0,
      unreachable: reachabilityForSweep(plan),
    }
  }

  const removed = []
  const failed = []
  for (const file of plan.remove) {
    const outcome = unlinkQuietly(file.path)
    if (outcome.ok) {
      removed.push({
        path: file.path,
        kind: file.kind,
        bytes: file.bytes,
        reason: file.reason,
      })
    } else {
      failed.push({ path: file.path, kind: file.kind, error: outcome.error })
    }
  }

  const metadata = pruneBriefingEntries(locations.briefingStore, {
    fileNames: removed.map((file) => path.basename(file.path)),
  })

  return {
    ...plan,
    dryRun: false,
    applied: true,
    blocked: null,
    removed,
    failed,
    freedBytes: removed.reduce((total, file) => total + file.bytes, 0),
    metadata: { briefingEntriesRemoved: metadata.removed },
    unreachable: reachabilityForSweep(plan),
  }
}

/*
 * Where a copy can be and whether this process can delete it.
 *
 * `holdsCopy` is deliberately three-valued. 'no' is a claim backed by
 * something checkable; 'unknown' means a copy may exist and this process
 * cannot tell; 'likely' means there is positive evidence one was made. Only
 * 'no' across the board lets a delete call itself complete.
 */
function reachabilityForJob(id, { usedMicroSd = false, residual = [] } = {}) {
  const sinks = []

  /* jobTracker.js mints local ids as `local_<uuid>`; anything that reached the
   * relay carries the relay's own `job_<uuid>`. A job that never left this Mac
   * cannot have left a recording in R2 or D1, and that is worth stating rather
   * than shrugging at. */
  const wentToRelay = !id.startsWith('local_')
  sinks.push({
    sink: 'cloud-relay audio captures (R2 object + D1 row)',
    reachable: false,
    holdsCopy: wentToRelay ? 'unknown' : 'no',
    detail: wentToRelay
      ? 'This id has the relay job shape, so a recording may be stored server-side.'
      : 'A local_ job never reached the relay, so no server-side copy was created.',
    reachItWith: wentToRelay
      ? `DELETE /v1/ops/history/${id}/audio on cloud-relay (see cloud-relay/audioRetention.js)`
      : null,
  })

  sinks.push({
    sink: 'pendant microSD store-and-forward journal',
    reachable: false,
    holdsCopy: usedMicroSd ? 'likely' : 'no',
    detail: usedMicroSd
      ? 'Pipeline telemetry reports this recording came off the card, so the device buffered a copy. The card is a failure buffer: the firmware truncates the journal on the next press and removes an outbox slot only after the relay confirms delivery. Nothing on this Mac can erase it.'
      : 'No microSD telemetry on this job. Per the standing rule in pendant_store.h the device writes audio to SD only when an upload fails, so no device copy was made.',
    reachItWith: usedMicroSd
      ? 'Only the device clears this, on its next successful delivery or its next press.'
      : null,
  })

  if (residual.length) {
    sinks.push({
      sink: 'briefing store backup/temp siblings',
      reachable: true,
      holdsCopy: 'likely',
      detail: `The deleted id still appears in ${residual.length} sibling file(s) of .pendant-briefings.json — an interrupted write left a readable copy of the transcript.`,
      paths: residual,
      reachItWith: 'Remove the listed .bak/.tmp siblings, then re-run the delete.',
    })
  }

  return sinks
}

function reachabilityForSweep(plan) {
  const sinks = [
    {
      sink: 'cloud-relay audio captures (R2 object + D1 row)',
      reachable: false,
      holdsCopy: 'unknown',
      detail:
        'Server-side recordings expire on the relay\'s own schedule; this sweeper has no network reach.',
      reachItWith: 'POST /v1/ops/audio-retention/sweep on cloud-relay',
    },
    {
      sink: 'pendant microSD store-and-forward journal',
      reachable: false,
      holdsCopy: plan.remove.some((file) => file.microSdCopy) ? 'likely' : 'no',
      detail:
        'SD is the failure path, never the default. Only the device clears it.',
      reachItWith: null,
    },
  ]

  if (plan.unattributable.files) {
    sinks.push({
      sink: 'unattributable audio on this disk',
      reachable: true,
      holdsCopy: 'likely',
      detail: `${plan.unattributable.files} file(s), ${plan.unattributable.bytes} bytes, belong to no surviving store entry. Age and the byte budget still reach them; "forget that conversation" cannot, because the store cap dropped the only handle on them.`,
      reachItWith:
        'They expire on the schedule above, or delete them by id if the caller still knows it.',
    })
  }

  return sinks
}

/** The full map, with nothing to delete — for a caller that wants to ask. */
export function audioReachability(options = {}) {
  const inventory = options.inventory ?? scanAudioOnDisk(options)
  return {
    readOnly: true,
    reachable: [
      {
        sink: 'Briefings/*.wav|*.opus',
        detail: 'Generated briefing audio. Swept by age and byte budget.',
        files: inventory.byKind.generated.files,
        bytes: inventory.byKind.generated.bytes,
      },
      {
        sink: 'pipeline-audio/*-input.wav',
        detail: "The owner's captured speech. Shortest retention of anything here.",
        files: inventory.byKind.captured.files,
        bytes: inventory.byKind.captured.bytes,
      },
      {
        sink: 'pipeline-audio/*-output.wav',
        detail: 'What the agent said back.',
        files: inventory.byKind.spoken.files,
        bytes: inventory.byKind.spoken.bytes,
      },
      {
        sink: 'pendantSpeech.js reply cache (memory)',
        detail:
          'Short spoken replies held as PCM and Opus. Keyed by text, so it can only be cleared wholesale.',
        files: pendantSpeechCacheSize(),
        bytes: null,
      },
    ],
    unreachable: reachabilityForSweep({
      remove: [],
      unattributable: inventory.unattributable,
    }),
  }
}

/*
 * The periodic sweep.
 *
 * A retention policy nothing calls is the state this module was written to
 * fix, so mounting the routes enables this by default. An hour is chosen
 * against the shortest retention window: captured speech lives 6 h, so hourly
 * bounds how far past its expiry the owner's voice can survive at about one
 * hour, and a byte-budget breach from a looping routine is caught inside the
 * same hour rather than at the next restart.
 *
 * The timer is unref'd. A background cleanup must never be the reason a
 * process refuses to exit — that turns "the agent won't shut down" into a
 * debugging session about audio files.
 */
export const AUDIO_RETENTION_SWEEP_INTERVAL_MS = positiveNumber(
  process.env.PENDANT_AUDIO_SWEEP_INTERVAL_MS,
  60 * 60 * 1000,
)

export function startAudioRetentionSweeper(options = {}) {
  const intervalMs = positiveNumber(
    options.intervalMs,
    AUDIO_RETENTION_SWEEP_INTERVAL_MS,
  )
  /* Startup is the worst moment to spend on housekeeping — the owner is
   * waiting on the first command, not on last night's briefings. */
  const firstRunDelayMs = positiveNumber(options.firstRunDelayMs, 30_000)

  const runOnce = () => {
    try {
      const report = sweepAudio({ ...options, apply: true, inventory: undefined })
      options.onReport?.(report)
      return report
    } catch (error) {
      /* A sweep that throws must not take the interval down with it: the next
       * hour is a free retry, and a crashed timer is a silently disabled
       * retention policy. */
      options.onError?.(error)
      return null
    }
  }

  const timers = [
    setTimeout(runOnce, firstRunDelayMs),
    setInterval(runOnce, intervalMs),
  ]
  for (const timer of timers) timer.unref?.()

  const stop = () => {
    clearTimeout(timers[0])
    clearInterval(timers[1])
  }
  stop.runOnce = runOnce
  stop.intervalMs = intervalMs
  return stop
}

/*
 * HTTP, as a registration function.
 *
 * Mounted with `registerAudioRetentionRoutes(app)` from server.js. It lives
 * here rather than in server.js because that file is 70 000 characters of
 * shared surface several people are editing at once.
 *
 * Reading is GET and changes nothing. The sweep is a POST that is a dry run
 * unless the body says `apply: true`. Per-job deletion is a DELETE and is the
 * only route here that acts on a single id.
 *
 * Mounting also starts the periodic sweep, because mounting the retention
 * surface is the act of enabling retention. Pass `{ sweep: false }` — or set
 * PENDANT_AUDIO_RETENTION_DISABLED=true — to mount the read and delete paths
 * without automatic expiry. The stop handle is left on the app so a caller
 * that owns shutdown can take it down.
 */
export function registerAudioRetentionRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerAudioRetentionRoutes requires an Express-style app.')
  }

  const base = options.basePath ?? '/audio-retention'
  const context = () => ({ locations: resolveLocations(options) })

  if (options.sweep !== false) {
    /* Left on the app rather than returned so the return value stays `app`,
     * the shape every other register*Routes in this project has. */
    app.stopAudioRetentionSweeper = startAudioRetentionSweeper(options)
  }

  app.get(base, (_request, response) => {
    const plan = planAudioSweep(context())
    response.json({
      ok: true,
      readOnly: true,
      ...plan,
      note: 'Nothing was removed. POST /audio-retention/sweep with {"apply":true} to enforce this.',
    })
  })

  /* Literal path, registered before nothing that could shadow it — the only
   * other GET here is the base. */
  app.get(`${base}/reachability`, (_request, response) => {
    response.json({ ok: true, ...audioReachability(context()) })
  })

  app.post(`${base}/sweep`, (request, response) => {
    try {
      const report = sweepAudio({
        ...context(),
        apply: request.body?.apply === true,
        maxBytes: request.body?.maxBytes,
        maxAgeMs: request.body?.maxAgeMs,
      })
      response.json({ ok: true, ...report })
    } catch (error) {
      response
        .status(400)
        .json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  app.delete(`${base}/jobs/:jobId`, (request, response) => {
    try {
      const report = deleteAudioForJob(String(request.params?.jobId ?? ''), {
        ...context(),
        clearSpeechCache: request.body?.clearSpeechCache !== false,
      })
      if (!report.matched && !report.metadata.briefingEntriesRemoved) {
        /* 404 is wrong here: "there was nothing to delete" is a successful
         * outcome for a delete, and the unreachable list still has something
         * to say about copies elsewhere. */
        response.json({
          ok: true,
          ...report,
          note: 'No audio for that id was on this disk.',
        })
        return
      }
      response.json({ ok: true, ...report })
    } catch (error) {
      response
        .status(400)
        .json({ ok: false, error: String(error?.message ?? error) })
    }
  })

  return app
}
