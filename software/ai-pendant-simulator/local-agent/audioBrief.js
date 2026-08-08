import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { AUDIO_RETENTION_DEFAULT_MAX_AGE_MS } from './audioRetention.js'
import { workspacePath } from './config.js'
import {
  PENDANT_SPEECH_CHANNELS,
  PENDANT_SPEECH_SAMPLE_RATE,
  encodePendantSpeechOpus,
  extractWavePcm,
  pendantSpeechPayload,
} from './pendantSpeech.js'

/*
 * The audio half of a briefing.
 *
 * pendantSpeech.js renders REPLIES: one sentence, capped at ten seconds,
 * cached, thrown away after the pendant plays it. A briefing is the opposite
 * shape — a minute of speech, produced when nobody is listening, kept on disk
 * until the owner asks for it. Same encoder, same wire format, different
 * lifecycle, so it gets its own module rather than more flags in that one.
 *
 * The format is not a choice: cloud-relay's pendantSpeechForJob() rejects
 * anything that is not 24 kHz mono s16le, and only forwards the Ogg Opus
 * variant when the raw PCM is also present and well-formed. So both are
 * rendered, both are written next to the note, and the payload carries both.
 */
const BRIEFINGS_DIRECTORY = path.join(workspacePath, 'Briefings')
const STORE_PATH = path.join(workspacePath, '.pendant-briefings.json')

/* 210 wpm is the reply voice — brisk enough that a one-line confirmation does
 * not drag. A minute of unbroken briefing at that rate is exhausting. */
const BRIEF_SPEECH_RATE_WPM = Number(
  process.env.PENDANT_BRIEF_SPEECH_RATE || 185,
)

/*
 * The reply cap is 10 s. A briefing that stopped at 10 s would not be a
 * briefing. The real constraint is the link: Opus at 16 kbps is ~12 KB per
 * spoken minute, which the pendant's LTE-M radio pulls down in about a second,
 * while the same minute of raw PCM is 2.9 MB. So the ceiling here is set by
 * what the owner will sit through, not by the radio — two minutes.
 */
export const BRIEF_MAX_SECONDS = Math.max(
  10,
  Number(process.env.PENDANT_BRIEF_MAX_SECONDS || 120),
)
export const BRIEF_MAX_PCM_BYTES =
  BRIEF_MAX_SECONDS * PENDANT_SPEECH_SAMPLE_RATE * 2
const FADE_OUT_SAMPLES = Math.round(PENDANT_SPEECH_SAMPLE_RATE * 0.25)

/*
 * ============================================================================
 * THE BOUNDS ON THE SHELF, AND WHY EACH NUMBER IS THAT NUMBER
 * ============================================================================
 *
 * WHAT WAS HERE BEFORE. `store.briefings.slice(0, 50)`. Newest-first, sliced by
 * COUNT, with no regard for `played`. Measured on the owner's live shelf on
 * 2026-08-07: 50 rows, 50 of them unplayed, 0 played. The next briefing of any
 * kind — morning, mail, schedule, triage, research — dropped an unheard row off
 * the end, silently, and the audio file is the deliverable.
 *
 * WHAT ELSE THAT MEASUREMENT SAID, which changed the design: all 50 rows named
 * the SAME wavPath and the SAME opusPath. A looping routine had written fifty
 * rows about one 1.9 MB file. So two things follow that a naive fix gets wrong:
 *
 *   - Summing the rows' own pcmBytes reports 95.5 MB. The bytes actually on
 *     disk are 1.99 MB. A budget built on the recorded numbers would be a
 *     budget on a proxy, and the proxy is off by a factor of forty-eight.
 *   - Evicting one row must NOT delete the file forty-nine siblings still
 *     point at. Every removal here is reference-counted against the survivors.
 *
 * THREE BOUNDS, NOT ONE. A count reads identically whether a row is a kilobyte
 * or five megabytes, and this project has paid for that mistake repeatedly:
 * jobTracker capped a count and reached 129 MB; browserSpool ran 17% over its
 * stated cap and actionLedger 56%, both because they measured with a different
 * serializer than the writer used. browserProvenance.js is the corrected
 * pattern and storeBytesOf/nestedBytesOf below are taken from it.
 *
 *   MAX_STORED_BRIEFINGS   50      Unchanged. A list nobody can scroll is not a
 *                                  shelf. It is the weakest of the three.
 *
 *   MAX_SHELF_STORE_BYTES  256 KB  The JSON file, measured with the indent
 *                                  atomicJsonStore actually writes. The live
 *                                  file is 68.6 KB at 50 rows (~1.24 KB/row,
 *                                  almost all of it the `spoken` transcript),
 *                                  so this is ~3.7x the measured worst case and
 *                                  bites only when a row carries an unusually
 *                                  long script.
 *
 *   MAX_SHELF_AUDIO_BYTES  64 MiB  The real weight: the .wav/.opus files the
 *                                  surviving rows point at, statted on disk and
 *                                  DEDUPLICATED BY PATH. Set at a quarter of
 *                                  audioRetention.js's 256 MiB whole-disk audio
 *                                  ceiling, so the shelf can never on its own be
 *                                  what blows that budget — the remaining three
 *                                  quarters stay available for captured and
 *                                  spoken pipeline audio and for the orphans
 *                                  that module exists to reap. At the measured
 *                                  1.99 MB per distinct brief it holds ~32
 *                                  briefings; at the 120 s ceiling
 *                                  (BRIEF_MAX_SECONDS, ~5.9 MB) it holds 11.
 *                                  That is the bound that makes "50 unplayed
 *                                  rows" stop being an unbounded store.
 *
 *   SHELF_STALE_AFTER_MS   48 h    NOT invented here. It is
 *                                  audioRetention.js's retention window for
 *                                  generated briefing audio, imported rather
 *                                  than restated. Past it the .wav is gone or
 *                                  about to be, so the row can only fail — it
 *                                  is not a guess about what the owner still
 *                                  wants, it is the lifetime of the thing the
 *                                  row points at. It is a RANKING input, not a
 *                                  sweeper: nothing is dropped for age alone.
 *
 *   MAX_BRIEFING_ROW_BYTES 32 KB   One row may not eat an eighth of the store.
 *                                  A 120 s script is ~2.3 KB, so 32 KB is ~27
 *                                  minutes of speech and can only fire on
 *                                  something pathological; without it a single
 *                                  runaway `spoken` would evict the whole shelf
 *                                  on the way in. Only `spoken` is clipped, and
 *                                  the row says so.
 *
 * NOTHING IS DROPPED UNLESS A BOUND IS BREACHED. Age, played-ness and a missing
 * file decide the ORDER of eviction, never that an eviction happens.
 */
export const MAX_STORED_BRIEFINGS = 50
export const MAX_SHELF_STORE_BYTES = 256 * 1024
export const MAX_SHELF_AUDIO_BYTES = 64 * 1024 * 1024
export const MAX_BRIEFING_ROW_BYTES = MAX_SHELF_STORE_BYTES / 8
export const SHELF_STALE_AFTER_MS = AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.generated

/*
 * How many tombstones are kept, and what they may weigh.
 *
 * BOTH, because the first cut of this had only the count and the byte budget
 * did not hold: twenty-five ~450-byte tombstones are ~11 KB, and a store whose
 * whole budget was 8 KB shed every briefing it had and was still over. The
 * record of a loss must never be able to evict the things it is a record of.
 * So the eviction block gets a bounded share of the store — an eighth — and is
 * trimmed to fit before any briefing is considered.
 *
 * The counters underneath are fixed-size and are NEVER trimmed. The detail of
 * the twenty-sixth eviction rolls off; "this shelf has dropped N briefings, M
 * of them never played, through <date>" stays answerable forever. Same split,
 * and the same reason, as browserProvenance's `dropped` block.
 *
 * At the default 256 KB store the count cap binds first (25 tombstones ≈ 11 KB
 * against a 32 KB share), which is the intended relationship: the count is the
 * ordinary bound and the byte share is the guarantee.
 */
export const MAX_EVICTION_RECORDS = 25
export const MAX_EVICTION_RECORD_BYTES = MAX_SHELF_STORE_BYTES / 8

/* Exactly audioRetention.js's GENERATED_AUDIO_EXTENSIONS. Sound only: the .md
 * note beside a briefing is text the owner can still read, and losing a row
 * must not lose that too. */
const REAPABLE_AUDIO_EXTENSIONS = Object.freeze(['.wav', '.opus'])

const isValidStore = (value) => value && Array.isArray(value.briefings)

const emptyStore = () => ({ briefings: [], evicted: emptyEvicted() })

const emptyEvicted = () => ({
  total: 0,
  unheard: 0,
  bytesFreed: 0,
  through: null,
  recent: [],
})

function load() {
  ensureJsonStore(STORE_PATH, emptyStore(), { validate: isValidStore })
  return readJsonWithRecovery(STORE_PATH, {
    fallback: emptyStore(),
    validate: isValidStore,
  })
}

export function briefingsLocation() {
  return { store: STORE_PATH, directory: BRIEFINGS_DIRECTORY }
}

/** A filename the owner can find in Finder six weeks later. */
export function briefingSlug(topic, at = new Date()) {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-')
  const words = String(topic ?? 'briefing')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
  return `${stamp}-${words || 'briefing'}`
}

/**
 * Long-form macOS speech at the pendant's exact wire format.
 *
 * The script goes through a file, not argv: a two-hundred-word briefing passed
 * as an argument is fine until the day it isn't, and the failure mode is a
 * silently truncated brief rather than an error.
 */
export function renderBriefAudio({
  text,
  directory = BRIEFINGS_DIRECTORY,
  basename = briefingSlug('briefing'),
  rate = BRIEF_SPEECH_RATE_WPM,
  maxPcmBytes = BRIEF_MAX_PCM_BYTES,
} = {}) {
  const script = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!script) throw new Error('A briefing needs something to say.')

  fs.mkdirSync(directory, { recursive: true })
  const wavPath = path.join(directory, `${basename}.wav`)
  const opusPath = path.join(directory, `${basename}.opus`)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-pendant-brief-'))
  const scriptPath = path.join(scratch, 'script.txt')

  try {
    fs.writeFileSync(scriptPath, script, 'utf8')
    const synthesis = spawnSync(
      'say',
      [
        '-r',
        String(rate),
        '-f',
        scriptPath,
        '-o',
        wavPath,
        '--file-format=WAVE',
        `--data-format=LEI16@${PENDANT_SPEECH_SAMPLE_RATE}`,
        `--channels=${PENDANT_SPEECH_CHANNELS}`,
      ],
      { encoding: 'utf8', timeout: 180_000 },
    )
    if (synthesis.error || synthesis.status !== 0) {
      throw new Error(
        synthesis.error?.message ||
          synthesis.stderr?.trim() ||
          `macOS say exited with status ${synthesis.status}.`,
      )
    }

    const rendered = extractWavePcm(fs.readFileSync(wavPath))
    const truncated = rendered.length > maxPcmBytes
    const pcm = Buffer.from(
      rendered.subarray(0, Math.min(rendered.length, maxPcmBytes)),
    )
    /* A hard cut mid-word reads as a dropped connection, not as an ending. */
    if (truncated) {
      applyFadeOut(pcm)
      fs.writeFileSync(wavPath, waveFile(pcm))
    }

    const opus = encodePendantSpeechOpus(pcm)
    fs.writeFileSync(opusPath, opus)

    return {
      wavPath,
      opusPath,
      pcm,
      opus,
      truncated,
      pcmBytes: pcm.length,
      opusBytes: opus.length,
      seconds: Number(
        (pcm.length / 2 / PENDANT_SPEECH_SAMPLE_RATE).toFixed(1),
      ),
      words: script.split(/\s+/).length,
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/** Minimal RIFF/WAVE header for the trimmed PCM, so the .wav on disk matches. */
export function waveFile(pcm) {
  const header = Buffer.alloc(44)
  const byteRate = PENDANT_SPEECH_SAMPLE_RATE * PENDANT_SPEECH_CHANNELS * 2
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(PENDANT_SPEECH_CHANNELS, 22)
  header.writeUInt32LE(PENDANT_SPEECH_SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(PENDANT_SPEECH_CHANNELS * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function applyFadeOut(pcm) {
  const sampleCount = pcm.length / 2
  const fadeSamples = Math.min(FADE_OUT_SAMPLES, sampleCount)
  const fadeStart = sampleCount - fadeSamples
  for (let index = 0; index < fadeSamples; index += 1) {
    const offset = (fadeStart + index) * 2
    const sample = pcm.readInt16LE(offset)
    pcm.writeInt16LE(
      Math.round((sample * (fadeSamples - index - 1)) / fadeSamples),
      offset,
    )
  }
}

/* ------------------------------------------------------- measuring the shelf */

/**
 * The size of the store as the writer will actually write it.
 *
 * atomicJsonStore.writeJsonAtomic serialises with an indent of two. Measuring
 * without it understates the file by roughly half — the exact defect that put
 * browserSpool 17% and actionLedger 56% over their stated caps. Same function,
 * same reason, as browserProvenance.storeBytesOf.
 */
export function storeBytesOf(value) {
  try {
    const serialized = JSON.stringify(value ?? null, null, 2)
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8')
  } catch {
    /* Unserialisable is unstorable: price it as maximally expensive so it is
     * shed first. */
    return Number.MAX_SAFE_INTEGER
  }
}

/** One row's cost at indent zero — the per-row admission check, not the budget. */
function rowBytesOf(row) {
  return storeBytesOf(row)
}

const resolveAudioPath = (value) =>
  value ? path.resolve(String(value)) : null

/** Both audio paths of a row, resolved, with nulls dropped. */
function audioPathsOf(row) {
  return ['wavPath', 'opusPath']
    .map((key) => resolveAudioPath(row?.[key]))
    .filter(Boolean)
}

/**
 * What the shelf's audio actually weighs, measured on disk.
 *
 * DEDUPLICATED BY PATH, which is the whole point. The live shelf had fifty rows
 * naming one file pair: summing each row's recorded pcmBytes says 95.5 MB and
 * the disk says 1.99 MB. A row whose file is gone costs nothing, because it is
 * holding no bytes — and it is also the first thing evicted, since it can no
 * longer deliver anything.
 *
 * `sizes` is a memo shared across the fit loop so a shelf is not statted fifty
 * times over.
 */
export function shelfAudioBytes(rows, { sizes = new Map(), statSync = fs.statSync } = {}) {
  const seen = new Set()
  let total = 0
  for (const row of rows) {
    for (const filePath of audioPathsOf(row)) {
      if (seen.has(filePath)) continue
      seen.add(filePath)
      if (!sizes.has(filePath)) {
        try {
          sizes.set(filePath, statSync(filePath).size)
        } catch {
          /* Missing, unreadable, or a directory. Either way it is not bytes
           * this shelf is responsible for. */
          sizes.set(filePath, 0)
        }
      }
      total += sizes.get(filePath)
    }
  }
  return total
}

/* ------------------------------------------------------ what goes, and why */

/*
 * The eviction order. Lower rank leaves first.
 *
 *   0 played          The owner heard it. It has done the only job it had, and
 *                     it is the natural first candidate — which is precisely
 *                     what the old slice-by-count never asked.
 *   1 audio missing   The .wav is not on disk. playBriefingOnMac already throws
 *                     on this row and pendantSpeechForBriefing already returns
 *                     null; keeping it costs the shelf a slot to deliver an
 *                     error message.
 *   2 unheard, stale  Unplayed but older than audioRetention.js's 48 h window
 *                     for generated audio, so its file is at or past the point
 *                     that module deletes it.
 *   3 unheard, fresh  The reason the shelf exists. Last to go, always.
 *
 * Within a rank, oldest first — by playedAt for a played row, because "heard
 * longest ago" is the right order there, and by createdAt for everything else.
 */
export const EVICTION_RANKS = Object.freeze([
  'played',
  'audio-missing',
  'unheard-stale',
  'unheard',
])

export function evictionRankOf(
  row,
  { now = Date.now(), sizes = new Map(), statSync = fs.statSync } = {},
) {
  if (row?.played) return 0

  const paths = audioPathsOf(row)
  const present = paths.some((filePath) => {
    if (!sizes.has(filePath)) {
      try {
        sizes.set(filePath, statSync(filePath).size)
      } catch {
        sizes.set(filePath, 0)
      }
    }
    return sizes.get(filePath) > 0
  })
  if (!present) return 1

  const createdAt = Date.parse(row?.createdAt ?? '')
  if (Number.isFinite(createdAt) && now - createdAt > SHELF_STALE_AFTER_MS) return 2

  return 3
}

function evictionOrder(context) {
  return (left, right) => {
    const byRank =
      evictionRankOf(left, context) - evictionRankOf(right, context)
    if (byRank !== 0) return byRank
    const stamp = (row) =>
      Date.parse((row?.played ? row?.playedAt : null) ?? row?.createdAt ?? '') || 0
    return stamp(left) - stamp(right)
  }
}

const clip = (value, max) =>
  value === null || value === undefined ? null : String(value).slice(0, max)

/**
 * The record that a briefing existed and was removed.
 *
 * This is the answer to the only question the old code made unanswerable: the
 * owner could not find out. It carries no transcript — that is what made the
 * rows heavy in the first place — but it carries enough to know what was lost
 * and where the readable half of it still is: `notePath` survives on disk
 * untouched, because a note is text and this only ever removes sound.
 */
function tombstoneFor(row, { now, reason, forcedBy, audio, bytesFreed }) {
  return {
    id: row?.id ?? null,
    topic: clip(row?.topic, 120),
    mode: clip(row?.mode, 40),
    producer: clip(row?.producer, 40),
    createdAt: row?.createdAt ?? null,
    seconds: row?.seconds ?? null,
    /* Said twice, on purpose. `played` is the field; `heard` is the claim, and
     * heard:false is the thing a reader must not be able to miss. */
    played: Boolean(row?.played),
    heard: Boolean(row?.played),
    playedAt: row?.playedAt ?? null,
    notePath: row?.notePath ?? null,
    wavPath: row?.wavPath ?? null,
    opusPath: row?.opusPath ?? null,
    reason,
    forcedBy,
    audio,
    bytesFreed,
    evictedAt: new Date(now).toISOString(),
  }
}

/**
 * Trim the tombstone list to its byte share, oldest detail first.
 *
 * The counters are untouched by construction — they are not in `recent` — so
 * what is lost here is which briefing, never that briefings were lost.
 */
function trimEvicted(evicted, maxBytes) {
  let recent = evicted.recent
  while (recent.length && storeBytesOf({ ...evicted, recent }) > maxBytes) {
    recent = recent.slice(0, -1)
  }
  return { ...evicted, recent }
}

function mergeEvicted(prior, tombstones, { maxBytes = MAX_EVICTION_RECORD_BYTES } = {}) {
  const previous = prior && typeof prior === 'object' ? prior : emptyEvicted()
  const carried = Array.isArray(previous.recent) ? previous.recent : []

  if (!tombstones.length) {
    return trimEvicted(
      {
        total: previous.total ?? 0,
        unheard: previous.unheard ?? 0,
        bytesFreed: previous.bytesFreed ?? 0,
        through: previous.through ?? null,
        recent: carried,
      },
      maxBytes,
    )
  }

  return trimEvicted(
    {
      total: (previous.total ?? 0) + tombstones.length,
      unheard:
        (previous.unheard ?? 0) +
        tombstones.filter((stone) => !stone.heard).length,
      bytesFreed:
        (previous.bytesFreed ?? 0) +
        tombstones.reduce((sum, stone) => sum + (stone.bytesFreed || 0), 0),
      through: tombstones[0]?.evictedAt ?? previous.through ?? null,
      recent: [...tombstones, ...carried].slice(0, MAX_EVICTION_RECORDS),
    },
    maxBytes,
  )
}

/**
 * Which files an eviction may actually unlink.
 *
 * REFERENCE-COUNTED against the survivors, which on the measured shelf is the
 * difference between removing a duplicate row and destroying the one recording
 * forty-nine other rows still point at.
 *
 * SCOPED. A path is unlinked only when it sits directly in the Briefings
 * directory and ends in .wav or .opus. `wavPath` is a string in a JSON file;
 * without this, a store that had been edited or corrupted would turn shelf
 * eviction into deletion of anything this process can write.
 */
function reapPlanFor(
  evicted,
  survivors,
  { directory = BRIEFINGS_DIRECTORY, sizes = new Map(), statSync = fs.statSync } = {},
) {
  const kept = new Set()
  for (const row of survivors) {
    for (const filePath of audioPathsOf(row)) kept.add(filePath)
  }

  const root = path.resolve(directory)
  const plan = new Map()

  for (const row of evicted) {
    const files = []
    let shared = false
    for (const filePath of audioPathsOf(row)) {
      if (kept.has(filePath)) {
        shared = true
        continue
      }
      if (path.dirname(filePath) !== root) continue
      if (!REAPABLE_AUDIO_EXTENSIONS.includes(path.extname(filePath).toLowerCase())) {
        continue
      }
      if (!sizes.has(filePath)) {
        try {
          sizes.set(filePath, statSync(filePath).size)
        } catch {
          sizes.set(filePath, 0)
        }
      }
      if (sizes.get(filePath) > 0) files.push(filePath)
    }
    const bytesFreed = files.reduce((sum, file) => sum + sizes.get(file), 0)
    plan.set(row, {
      files,
      bytesFreed,
      audio: files.length ? 'removed' : shared ? 'shared' : 'missing',
    })
  }

  return plan
}

/**
 * Fit the shelf inside every bound, dropping the least-wanted rows first.
 *
 * Pure, and verified against the real serialization rather than against a sum
 * of estimates: each pass rebuilds the store exactly as it will be written —
 * rows, counters and tombstones together, at indent two — and measures that.
 * The greedy estimate is what put browserSpool 17% over its cap; the loop is
 * what turns the number into a guarantee.
 *
 * `protect` is the row that may never be dropped: the briefing being saved. A
 * shelf that answered "full" by discarding the thing it was just handed would
 * be a shelf that silently loses the newest brief instead of the oldest, which
 * is the same defect wearing different clothes.
 */
export function fitShelf(
  rows,
  {
    now = Date.now(),
    protect = null,
    maxRows = MAX_STORED_BRIEFINGS,
    maxStoreBytes = MAX_SHELF_STORE_BYTES,
    maxAudioBytes = MAX_SHELF_AUDIO_BYTES,
    maxEvictionBytes = null,
    maxRowBytes = MAX_BRIEFING_ROW_BYTES,
    priorEvicted = emptyEvicted(),
    directory = BRIEFINGS_DIRECTORY,
    statSync = fs.statSync,
  } = {},
) {
  /* Always an eighth of whatever the store budget is, so a caller that shrinks
   * the store for a test shrinks the tombstone share with it rather than
   * discovering that the record of evictions is now bigger than the store. */
  const evictionBytes = maxEvictionBytes ?? maxStoreBytes / 8
  const sizes = new Map()
  const context = { now, sizes, statSync }
  /*
   * Rows ALREADY on the shelf are held to the per-row cap too, not just the
   * incoming one. A store written before that cap existed can hold a row bigger
   * than the whole budget, and without this the loop below would evict every
   * other briefing — audio and all — trying to make room for it, and still
   * never fit. Clipping a transcript is strictly less destructive than deleting
   * a briefing, and admit() marks the row so nobody reads the short version as
   * the whole script. A row already inside the cap is returned unchanged, so
   * the object identity `protect` depends on survives the ordinary path.
   */
  const all = rows.map((row) => admit(row, { maxRowBytes }))
  const order = [...all].sort(evictionOrder(context))
  const doomed = new Set()
  /* Which bound was breached at the moment each row was chosen. Recorded when
   * the decision is made, not at the end — by the last pass nothing is over
   * budget any more, and a tombstone that named the state it left behind would
   * name the wrong reason for every eviction. */
  const forcedBy = new Map()

  for (;;) {
    const kept = all.filter((row) => !doomed.has(row))
    const evicted = order.filter((row) => doomed.has(row))
    const plan = reapPlanFor(evicted, kept, { directory, sizes, statSync })
    const audioBytes = shelfAudioBytes(kept, { sizes, statSync })

    const tombstones = evicted.map((row) =>
      tombstoneFor(row, {
        now,
        reason: EVICTION_RANKS[evictionRankOf(row, context)],
        forcedBy: forcedBy.get(row) ?? 'store-bytes',
        ...plan.get(row),
      }),
    )
    const nextEvicted = mergeEvicted(priorEvicted, tombstones, {
      maxBytes: evictionBytes,
    })
    const storeBytes = storeBytesOf({ briefings: kept, evicted: nextEvicted })

    const breach =
      kept.length > maxRows
        ? 'row-count'
        : audioBytes > maxAudioBytes
          ? 'audio-bytes'
          : storeBytes > maxStoreBytes
            ? 'store-bytes'
            : null

    const over = Boolean(breach)
    const candidate = order.find((row) => !doomed.has(row) && row !== protect)

    if (!over || kept.length <= 1 || !candidate) {
      return {
        keep: kept,
        evict: evicted,
        tombstones,
        evicted: nextEvicted,
        plan,
        bytes: { store: storeBytes, audio: audioBytes },
        /* An honest failure rather than an empty shelf: one row bigger than the
         * whole budget cannot be made to fit by dropping its neighbours. */
        overBudget: over,
      }
    }

    doomed.add(candidate)
    forcedBy.set(candidate, breach)
  }
}

/**
 * Unlink what the plan says may go. Runs AFTER the store write, deliberately.
 *
 * If this process dies between the two, the failure is an orphan file that
 * audioRetention.js reaps on its own schedule. The other order fails as a row
 * pointing at audio that is already gone — a briefing the owner can see and
 * cannot play. Orphaned bytes are recoverable; a broken promise is not.
 */
function reapAudio(plan) {
  const removed = []
  const failed = []
  for (const outcome of plan.values()) {
    for (const filePath of outcome.files) {
      try {
        fs.rmSync(filePath, { force: true })
        removed.push(filePath)
      } catch (error) {
        failed.push({ path: filePath, error: String(error?.message ?? error) })
      }
    }
  }
  return { removed, failed }
}

/*
 * A row that cannot be allowed in at full size.
 *
 * Only `spoken` is clipped, and never below the point where it is still the
 * transcript of a real briefing — the audio, which is the deliverable, is
 * untouched. The row records that it happened so nobody reads the short version
 * as the whole script.
 */
function admit(briefing, { maxRowBytes = MAX_BRIEFING_ROW_BYTES } = {}) {
  if (rowBytesOf(briefing) <= maxRowBytes) return briefing

  const spoken = String(briefing.spoken ?? '')
  if (!spoken) return briefing

  const overBy = rowBytesOf(briefing) - maxRowBytes
  const keepChars = Math.max(0, spoken.length - overBy - 64)
  return {
    ...briefing,
    spoken: spoken.slice(0, keepChars),
    spokenClipped: true,
    spokenChars: spoken.length,
  }
}

/*
 * Only metadata is stored. The audio stays in files: a two-minute brief is
 * ~5.8 MB of base64, and .pendant-briefings.json is rewritten atomically on
 * every save — keeping the bytes in there would turn "list my briefings" into
 * a multi-megabyte read.
 *
 * WHAT HAPPENS WHEN EVERY ROW IS UNPLAYED — the state the live shelf is in.
 *
 * The new briefing is stored, the oldest unheard row is evicted, and a
 * tombstone recording exactly that is written to the store in the same atomic
 * write. It is not silent and it is not deniable.
 *
 * The alternative was to refuse the new brief and say so, and it was rejected
 * for three reasons rather than one:
 *
 *   1. The refusal falls on the wrong brief. The one being saved is the
 *      freshest — this morning's schedule, the research the owner asked for a
 *      minute ago — and the rows it would be protecting are, on this Mac
 *      today, fifty copies of one file written by a routine in a loop.
 *      "Preserve the backlog, drop today's" is not the owner's interest.
 *   2. It hands the shelf permanently to whatever filled it first. A producer
 *      that loops once would lock every future briefing out until a human
 *      played fifty of them. A bug in one routine becoming a total outage of
 *      the feature is worse than the bug.
 *   3. Every caller dereferences what this returns — briefing.js and
 *      briefingTriage.js call playBriefingOnMac(stored) and read stored.id —
 *      and the audio has already been rendered and written by the time we get
 *      here. Refusing would strand a file on disk with nothing pointing at it,
 *      which is the orphan problem audioRetention.js was written to clean up.
 *
 * So: evict, but never quietly. See briefingShelfStatus() and
 * registerBriefingShelfRoutes().
 */
export function saveBriefing(entry, options = {}) {
  const store = load()
  const now = options.now ?? Date.now()
  const briefing = admit({
    id: `brf_${crypto.randomUUID()}`,
    createdAt: new Date(now).toISOString(),
    played: false,
    playedAt: null,
    ...entry,
  })

  const fitted = fitShelf([briefing, ...store.briefings], {
    ...options,
    now,
    protect: briefing,
    priorEvicted: store.evicted,
  })

  writeJsonAtomic(
    STORE_PATH,
    { ...store, briefings: fitted.keep, evicted: fitted.evicted },
    { validate: isValidStore },
  )

  const reaped = reapAudio(fitted.plan)

  /* Only when an unlink actually failed, so the ordinary path stays one write.
   * A tombstone that claims bytes it did not free is the same species of lie as
   * a budget measured with the wrong serializer. */
  if (reaped.failed.length) correctFailedReaps(reaped.failed)

  return briefing
}

function correctFailedReaps(failed) {
  const stuck = new Set(failed.map((entry) => entry.path))
  const store = load()
  const recent = (store.evicted?.recent ?? []).map((stone) => {
    const paths = audioPathsOf(stone)
    if (stone.audio !== 'removed' || !paths.some((file) => stuck.has(file))) {
      return stone
    }
    return { ...stone, audio: 'failed', bytesFreed: 0 }
  })
  writeJsonAtomic(
    STORE_PATH,
    {
      ...store,
      evicted: { ...(store.evicted ?? emptyEvicted()), recent },
    },
    { validate: isValidStore },
  )
}

export function listBriefings({ limit = 20 } = {}) {
  return load().briefings.slice(0, limit)
}

export function getBriefing(id) {
  const store = load()
  if (!id || id === 'latest') return store.briefings[0] ?? null
  return store.briefings.find((briefing) => briefing.id === id) ?? null
}

export function markBriefingPlayed(id) {
  const store = load()
  const briefing = store.briefings.find((entry) => entry.id === id)
  if (!briefing) return null
  briefing.played = true
  briefing.playedAt = new Date().toISOString()
  writeJsonAtomic(STORE_PATH, store)
  return briefing
}

/**
 * Remove one briefing by id, and its audio with it.
 *
 * The row and the two files are one object — deliverBriefing writes all three
 * with one basename so none is ever orphaned from the others — so removing the
 * row without the sound is not a deletion, it is hiding the bytes. That is what
 * this did before, and it is half of how 48.2 MB of unreferenced .wav
 * accumulated in Briefings/ for audioRetention.js to find.
 *
 * Reference-counted, for the reason the eviction path is: briefingTriage.js
 * calls this to supersede duplicates, and duplicates are exactly the rows most
 * likely to share a file.
 *
 * Returns a boolean, unchanged: briefingTriage ignores it and nothing else
 * calls it, and a store this small is not worth a contract change.
 */
export function deleteBriefing(id) {
  const store = load()
  const doomed = store.briefings.filter((entry) => entry.id === id)
  if (!doomed.length) return false

  const kept = store.briefings.filter((entry) => entry.id !== id)
  writeJsonAtomic(STORE_PATH, { ...store, briefings: kept }, { validate: isValidStore })
  reapAudio(reapPlanFor(doomed, kept))
  return true
}

/* ------------------------------------------------------------- the report */

/**
 * What the shelf holds, what it is allowed to hold, and what it has dropped.
 *
 * The last of those is the point. A bounded store that cannot say what fell out
 * of it reads to the owner exactly like a store that never held the thing —
 * which is the failure this whole module was rewritten for.
 */
export function briefingShelfStatus({ limit = MAX_EVICTION_RECORDS } = {}) {
  const store = load()
  const evicted = { ...emptyEvicted(), ...(store.evicted ?? {}) }
  const unplayed = store.briefings.filter((row) => !row.played)

  return {
    readOnly: true,
    store: STORE_PATH,
    directory: BRIEFINGS_DIRECTORY,
    rows: store.briefings.length,
    unplayed: unplayed.length,
    bytes: {
      store: storeBytesOf(store),
      audio: shelfAudioBytes(store.briefings),
      note: 'The store is measured with the indentation atomicJsonStore actually writes; the audio is statted on disk and deduplicated by path, because rows may share a file.',
    },
    bounds: {
      maxRows: MAX_STORED_BRIEFINGS,
      maxStoreBytes: MAX_SHELF_STORE_BYTES,
      maxAudioBytes: MAX_SHELF_AUDIO_BYTES,
      maxRowBytes: MAX_BRIEFING_ROW_BYTES,
      staleAfterMs: SHELF_STALE_AFTER_MS,
      unit: 'bytes',
    },
    evicted: {
      total: evicted.total,
      unheard: evicted.unheard,
      bytesFreed: evicted.bytesFreed,
      through: evicted.through,
      recent: (evicted.recent ?? []).slice(0, Math.max(1, Number(limit) || 1)),
    },
    /* Stated rather than implied: nothing here expires audio on a timer, and a
     * reader who assumes it does will misread an intact shelf as a swept one. */
    note: 'Eviction happens only on a write that would breach a bound. Audio expiry by age and the whole-disk byte ceiling belong to audioRetention.js.',
  }
}

/** Just the tombstones, newest first. */
export function briefingEvictions({ limit = MAX_EVICTION_RECORDS } = {}) {
  return briefingShelfStatus({ limit }).evicted
}

/**
 * Wire the shelf's own reporting onto an app.
 *
 * A registration function rather than routes in server.js, for the reason
 * registerAudioRetentionRoutes and registerBrowserProvenanceRoutes give: that
 * file is shared surface several people edit at once. Mount with
 *
 *     registerBriefingShelfRoutes(app)
 *
 * The base path is deliberately NOT under /research/briefings — server.js
 * already owns `GET /research/briefings/:id`, and a literal registered after it
 * would be swallowed by the parameter.
 *
 * Both routes are reads. Nothing here evicts, deletes or sweeps.
 */
export function registerBriefingShelfRoutes(app, { basePath = '/briefings/shelf' } = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new Error('registerBriefingShelfRoutes requires an Express-style app.')
  }

  app.get(basePath, (request, response) => {
    const limit = Number.parseInt(String(request.query?.limit ?? ''), 10)
    response.json({
      ok: true,
      ...briefingShelfStatus({
        limit: Number.isFinite(limit) && limit > 0 ? limit : MAX_EVICTION_RECORDS,
      }),
    })
  })

  app.get(`${basePath}/evictions`, (request, response) => {
    const limit = Number.parseInt(String(request.query?.limit ?? ''), 10)
    const evicted = briefingEvictions({
      limit: Number.isFinite(limit) && limit > 0 ? limit : MAX_EVICTION_RECORDS,
    })
    response.json({
      ok: true,
      readOnly: true,
      ...evicted,
      note: evicted.unheard
        ? `${evicted.unheard} briefing(s) were removed without ever having been played. The .md note beside each one, where there was one, is still on disk.`
        : 'No unplayed briefing has ever been evicted from this shelf.',
    })
  })

  return [`GET ${basePath}`, `GET ${basePath}/evictions`]
}

/**
 * Rebuild the pendant payload from the files on disk. Re-encoding the Opus on
 * demand would be a second encoder to keep in step with the first, so the
 * .opus written at render time is the one that ships.
 */
export function pendantSpeechForBriefing(briefing) {
  if (!briefing?.wavPath || !fs.existsSync(briefing.wavPath)) return null
  const pcm = extractWavePcm(fs.readFileSync(briefing.wavPath))
  const opus =
    briefing.opusPath && fs.existsSync(briefing.opusPath)
      ? fs.readFileSync(briefing.opusPath)
      : encodePendantSpeechOpus(pcm)
  return pendantSpeechPayload(pcm, opus, Boolean(briefing.truncated))
}

/**
 * Turn a finished research run into the two artifacts the owner asked for: a
 * source-linked note they can read, and audio they can play. Both land in the
 * same folder with the same basename so one is never orphaned from the other.
 */
export function deliverBriefing({ research, openNote = false } = {}) {
  if (!research?.topic) throw new Error('deliverBriefing needs a research run.')
  const basename = briefingSlug(research.topic, research.generatedAt)
  const audio = renderBriefAudio({ text: research.spoken, basename })

  fs.mkdirSync(BRIEFINGS_DIRECTORY, { recursive: true })
  const notePath = path.join(BRIEFINGS_DIRECTORY, `${basename}.md`)
  fs.writeFileSync(
    notePath,
    `${research.markdown}\n## Audio\n\n\`${audio.wavPath}\` — ${audio.seconds}s\n`,
    'utf8',
  )

  const briefing = saveBriefing({
    topic: research.topic,
    mode: research.mode,
    headline: research.brief?.headline || '',
    notePath,
    wavPath: audio.wavPath,
    opusPath: audio.opusPath,
    seconds: audio.seconds,
    pcmBytes: audio.pcmBytes,
    opusBytes: audio.opusBytes,
    truncated: audio.truncated,
    sourcesRead: research.sourcesRead,
    sourcesSeen: research.sourcesSeen,
    sources: (research.sources || []).map((source) => ({
      url: source.url,
      ok: source.ok,
      status: source.status,
      title: source.title,
      error: source.error ?? null,
    })),
    spoken: research.spoken,
  })

  /* Deferred work opening a window is how a 7am routine becomes an alarm
   * clock. Only pop the note when the owner explicitly asked to see it. */
  if (openNote) {
    spawnSync('open', ['-g', notePath], { timeout: 10_000 })
  }

  return { briefing, audio, notePath }
}

/** One spoken sentence that says what is waiting and where. */
export function briefingHeadline(briefing) {
  const read = Number(briefing?.sourcesRead || 0)
  return [
    `Your ${briefing?.mode === 'compare' ? 'comparison' : 'briefing'} on ${briefing?.topic} is ready.`,
    `I read ${read} source${read === 1 ? '' : 's'}.`,
    `${briefing?.seconds || 0} seconds of audio, saved with the note.`,
  ].join(' ')
}

/** Play it out of the Mac's own speakers — the "I'm at my desk" case. */
export function playBriefingOnMac(briefing) {
  if (!briefing?.wavPath || !fs.existsSync(briefing.wavPath)) {
    throw new Error('That briefing has no audio file on disk.')
  }
  const player = spawnSync('afplay', [briefing.wavPath], { timeout: 300_000 })
  if (player.error || player.status !== 0) {
    throw new Error(
      player.error?.message ||
        player.stderr?.toString().trim() ||
        `afplay exited with status ${player.status}.`,
    )
  }
  return true
}
