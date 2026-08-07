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
const MAX_STORED_BRIEFINGS = 50

const isValidStore = (value) => value && Array.isArray(value.briefings)

function load() {
  ensureJsonStore(STORE_PATH, { briefings: [] }, { validate: isValidStore })
  return readJsonWithRecovery(STORE_PATH, {
    fallback: { briefings: [] },
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

/*
 * Only metadata is stored. The audio stays in files: a two-minute brief is
 * ~5.8 MB of base64, and .pendant-briefings.json is rewritten atomically on
 * every save — keeping the bytes in there would turn "list my briefings" into
 * a multi-megabyte read.
 */
export function saveBriefing(entry) {
  const store = load()
  const briefing = {
    id: `brf_${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    played: false,
    playedAt: null,
    ...entry,
  }
  store.briefings.unshift(briefing)
  store.briefings = store.briefings.slice(0, MAX_STORED_BRIEFINGS)
  writeJsonAtomic(STORE_PATH, store)
  return briefing
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

export function deleteBriefing(id) {
  const store = load()
  const before = store.briefings.length
  store.briefings = store.briefings.filter((entry) => entry.id !== id)
  if (store.briefings.length === before) return false
  writeJsonAtomic(STORE_PATH, store)
  return true
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
