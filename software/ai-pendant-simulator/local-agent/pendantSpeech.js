import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { stripProtocolTerminators } from '../shared/protocolText.js'

export const PENDANT_SPEECH_SAMPLE_RATE = 24000
export const PENDANT_SPEECH_CHANNELS = 1
export const PENDANT_SPEECH_BITS = 16
export const PENDANT_SPEECH_MAX_PCM_BYTES = 480000
export const PENDANT_SPEECH_OPUS_BITRATE = 16000

const MAX_SPOKEN_CHARACTERS = 180
const SPEECH_RATE_WORDS_PER_MINUTE = 210
const FADE_OUT_SAMPLES = Math.round(PENDANT_SPEECH_SAMPLE_RATE * 0.1)
const CACHEABLE_SHORT_TEXT_MAX = 48
const CACHEABLE_SHORT_TEXT_PATTERN = /^[A-Za-z0-9 .,!?'"-]+$/
const ALWAYS_CACHE_PHRASES = new Set([
  'Done.',
  'Waiting for your approval on the dashboard.',
  "That didn't finish on the Mac.",
])

/** @type {Map<string, { pcm: Buffer, opus: Buffer, truncated: boolean }>} */
const pendantSpeechCache = new Map()

export function clearPendantSpeechCache() {
  pendantSpeechCache.clear()
}

export function pendantSpeechCacheSize() {
  return pendantSpeechCache.size
}

function shouldCacheSpokenText(text) {
  if (ALWAYS_CACHE_PHRASES.has(text)) return true
  return (
    text.length > 0 &&
    text.length <= CACHEABLE_SHORT_TEXT_MAX &&
    CACHEABLE_SHORT_TEXT_PATTERN.test(text)
  )
}

/*
 * The wire contract with cloud-relay's pendantSpeechForJob(), which drops any
 * payload whose format/rate/channels/bits are not exactly this. Exported so
 * long-form briefings (audioBrief.js) build it from the same place rather than
 * from a copy that can drift out of step with the relay.
 */
export function pendantSpeechPayload(pcm, opus, truncated) {
  return {
    format: 's16le',
    sampleRate: PENDANT_SPEECH_SAMPLE_RATE,
    channels: PENDANT_SPEECH_CHANNELS,
    bitsPerSample: PENDANT_SPEECH_BITS,
    pcmBytes: pcm.length,
    truncated: Boolean(truncated),
    audioBase64: pcm.toString('base64'),
    compressedFormat: 'ogg-opus',
    compressedBytes: opus.length,
    compressedAudioBase64: opus.toString('base64'),
  }
}

/*
 * Is this payload's opus track the one the relay will actually serve?
 *
 * Deliberately the SAME test cloud-relay's pendantSpeechForJob() applies before
 * it prefers opus over raw PCM: right container name, Ogg magic, and enough
 * bytes to be a real stream. Anything the relay would reject must keep its raw
 * PCM, or the reply would arrive with no playable audio at all.
 */
export function hasServableOpus(speech) {
  if (!speech || typeof speech !== 'object') return false
  if (String(speech.compressedFormat || '').toLowerCase() !== 'ogg-opus') {
    return false
  }
  const opus = Buffer.from(String(speech.compressedAudioBase64 || ''), 'base64')
  return opus.length >= 64 && opus.toString('ascii', 0, 4) === 'OggS'
}

/**
 * The payload as it should cross the wire to the relay.
 *
 * Raw `audioBase64` is 24 kHz s16le PCM: ~2.9 MB per spoken minute before
 * base64, ~3.8 MB after. A pre-rendered research briefing is minutes long, so a
 * single result reached ~25 MB and the relay refused the body outright (413) —
 * the reply never landed at all. The relay does not even serve those bytes: it
 * prefers the ~16x smaller opus track and only falls back to PCM when no usable
 * opus exists. So when the opus track is one the relay will serve, the raw PCM
 * is pure wire cost and is dropped here.
 *
 * FALLBACK, kept on purpose: when there is NO servable opus track — encoder
 * missing or failed, a truncated stream, a payload built before opus existed —
 * the raw PCM is left exactly as it was. It is then the only audio the pendant
 * can play, and shipping a large body beats shipping a mute reply.
 *
 * Metadata (format, rate, channels, bits, pcmBytes) is always preserved: the
 * relay validates against it, and the dashboard's TTS event reports from it.
 * Local callers must keep using the un-stripped object — the Mac dashboard's
 * output-side audio preview reads `audioBase64` (bridge.js
 * reportSynthesizedSpeech), so this is applied only when building the relay
 * body, never to the result the agent keeps for itself.
 */
export function pendantSpeechForWire(speech) {
  if (!hasServableOpus(speech)) {
    return speech
  }
  if (!String(speech.audioBase64 || '')) {
    return speech
  }

  const wire = { ...speech }
  delete wire.audioBase64
  /* Explicit so an operator reading a stored result can tell this apart from
   * a synthesis that produced no audio at all. */
  wire.rawPcmOmitted = true
  return wire
}

const WIRE_WALK_MAX_DEPTH = 8
const WIRE_WALK_MAX_NODES = 5000

/**
 * Apply the wire form to every pendantSpeech payload a result carries, at any
 * depth. Returns a new object; the caller's own copy (and its raw PCM) is left
 * untouched.
 *
 * Depth matters: an executed plan carries its runner's output verbatim
 * (bridge.js does `plan.execution = execution`), and a briefing action attaches
 * its own full-length payload to the result it returns
 * (computerControl.js). Stripping only the top level left that nested duplicate
 * on the wire — a ~29 MB body whose D1 write then failed on size.
 */
export function resultForWire(result) {
  return walkForWire(result, { nodes: 0 }, 0)
}

function walkForWire(value, state, depth) {
  if (depth > WIRE_WALK_MAX_DEPTH || state.nodes > WIRE_WALK_MAX_NODES) {
    return value
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      state.nodes += 1
      const mapped = walkForWire(entry, state, depth + 1)
      if (mapped !== entry) changed = true
      return mapped
    })
    return changed ? next : value
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  /* A speech payload is recognised by its own shape, so it is handled wherever
   * it sits rather than only under a key named `pendantSpeech`. */
  if (typeof value.audioBase64 === 'string' && hasServableOpus(value)) {
    return pendantSpeechForWire(value)
  }

  let changed = false
  const next = {}
  for (const [key, entry] of Object.entries(value)) {
    state.nodes += 1
    const mapped = walkForWire(entry, state, depth + 1)
    if (mapped !== entry) changed = true
    next[key] = mapped
  }
  return changed ? next : value
}

/**
 * What the pendant should say for a result. Always returns non-empty text —
 * a silent success is indistinguishable from a hang on a voice-first device.
 */
export function spokenTextForResult(result) {
  const value = result && typeof result === 'object' ? result : {}
  const direct = [
    value.response,
    value.summary,
    value.message,
    typeof value.result === 'string' ? value.result : '',
    value.executionError,
    value.error,
  ]
    .map((candidate) =>
      stripProtocolTerminators(candidate).replace(/\s+/g, ' ').trim(),
    )
    .find(Boolean)

  if (direct) {
    return direct.slice(0, MAX_SPOKEN_CHARACTERS)
  }

  if (
    value.awaitingApproval === true ||
    (Array.isArray(value.awaitingApproval) && value.awaitingApproval.length)
  ) {
    return 'Waiting for your approval on the dashboard.'
  }

  if (value.executed === false && !value.awaitingApproval) {
    return "That didn't finish on the Mac."
  }

  const labels = Array.isArray(value.actions)
    ? value.actions
        .map((action) =>
          String(action?.label || action?.description || action?.type || '')
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .filter(Boolean)
    : []

  if (!labels.length) {
    return 'Done.'
  }

  const prefix = value.actions.some((action) => action?.requiresConfirmation)
    ? 'Ready for confirmation: '
    : ''
  return `${prefix}${labels.join(', ')}.`.slice(0, MAX_SPOKEN_CHARACTERS)
}

export function extractWavePcm(wave) {
  if (
    !Buffer.isBuffer(wave) ||
    wave.length < 44 ||
    wave.toString('ascii', 0, 4) !== 'RIFF' ||
    wave.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('macOS speech output is not a valid RIFF/WAVE file.')
  }

  let format = null
  let pcm = null

  for (let offset = 12; offset + 8 <= wave.length; ) {
    const chunkId = wave.toString('ascii', offset, offset + 4)
    const chunkBytes = wave.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkBytes

    if (chunkEnd > wave.length) {
      throw new Error(`Invalid ${chunkId} chunk length in speech WAVE file.`)
    }

    if (chunkId === 'fmt ') {
      if (chunkBytes < 16) {
        throw new Error('Speech WAVE format chunk is too short.')
      }
      format = {
        encoding: wave.readUInt16LE(chunkStart),
        channels: wave.readUInt16LE(chunkStart + 2),
        sampleRate: wave.readUInt32LE(chunkStart + 4),
        bits: wave.readUInt16LE(chunkStart + 14),
      }
    } else if (chunkId === 'data') {
      pcm = Buffer.from(wave.subarray(chunkStart, chunkEnd))
    }

    offset = chunkEnd + (chunkBytes & 1)
  }

  if (!format || !pcm) {
    throw new Error('Speech WAVE file is missing its format or audio data.')
  }
  if (
    format.encoding !== 1 ||
    format.channels !== PENDANT_SPEECH_CHANNELS ||
    format.sampleRate !== PENDANT_SPEECH_SAMPLE_RATE ||
    format.bits !== PENDANT_SPEECH_BITS
  ) {
    throw new Error(
      `Unexpected speech format: encoding=${format.encoding}, channels=${format.channels}, sampleRate=${format.sampleRate}, bits=${format.bits}.`,
    )
  }
  if (!pcm.length || (pcm.length & 1) !== 0) {
    throw new Error('Speech PCM payload is empty or not aligned to 16-bit samples.')
  }

  return pcm
}

/*
 * Some results arrive with their audio already rendered — a research briefing
 * is a minute of speech produced hours before anyone asks for it. Re-rendering
 * here would replace it with `say` reading the 180-character summary of
 * itself, which is exactly the artifact the owner did NOT ask for.
 *
 * Only a payload that already satisfies the relay's format check is trusted;
 * anything else falls through to a normal render rather than being forwarded
 * and silently dropped downstream.
 */
export function prerenderedPendantSpeech(result) {
  const candidates = [
    result?.pendantSpeech,
    ...(Array.isArray(result?.results)
      ? result.results.map((entry) => entry?.pendantSpeech)
      : []),
  ]

  for (const speech of candidates) {
    if (
      speech &&
      typeof speech === 'object' &&
      String(speech.format || '').toLowerCase() === 's16le' &&
      Number(speech.sampleRate) === PENDANT_SPEECH_SAMPLE_RATE &&
      Number(speech.channels) === PENDANT_SPEECH_CHANNELS &&
      Number(speech.bitsPerSample) === PENDANT_SPEECH_BITS &&
      String(speech.audioBase64 || '').length > 0
    ) {
      return speech
    }
  }
  return null
}

export function synthesizePendantSpeech(result) {
  // spokenTextForResult always returns text; keep a belt-and-braces fallback
  // so a future regression cannot ship silent results to the pendant.
  const text = spokenTextForResult(result) || 'Done.'

  const prerendered = prerenderedPendantSpeech(result)
  if (prerendered) {
    return {
      ...result,
      response: String(result?.response || text),
      pendantSpeech: prerendered,
    }
  }

  const resultWithText =
    result && typeof result === 'object' && !String(result.response || '').trim()
      ? { ...result, response: text }
      : result

  const cached = pendantSpeechCache.get(text)
  if (cached) {
    const pcm = Buffer.from(cached.pcm)
    const opus = cached.opus
      ? Buffer.from(cached.opus)
      : encodePendantSpeechOpus(pcm)
    return {
      ...resultWithText,
      response: String(resultWithText?.response || text),
      pendantSpeech: pendantSpeechPayload(pcm, opus, cached.truncated),
    }
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-pendant-speech-'),
  )
  const wavePath = path.join(temporaryDirectory, 'agent-reply.wav')

  try {
    const synthesis = spawnSync(
      'say',
      [
        '-r',
        String(SPEECH_RATE_WORDS_PER_MINUTE),
        '-o',
        wavePath,
        '--file-format=WAVE',
        `--data-format=LEI16@${PENDANT_SPEECH_SAMPLE_RATE}`,
        `--channels=${PENDANT_SPEECH_CHANNELS}`,
        text,
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
      },
    )

    if (synthesis.error || synthesis.status !== 0) {
      throw new Error(
        synthesis.error?.message ||
          synthesis.stderr?.trim() ||
          `macOS say exited with status ${synthesis.status}.`,
      )
    }

    const renderedPcm = extractWavePcm(fs.readFileSync(wavePath))
    const wasTruncated = renderedPcm.length > PENDANT_SPEECH_MAX_PCM_BYTES
    const pcm = Buffer.from(
      renderedPcm.subarray(
        0,
        Math.min(renderedPcm.length, PENDANT_SPEECH_MAX_PCM_BYTES),
      ),
    )

    if (wasTruncated) {
      applyFadeOut(pcm)
    }
    const opus = encodePendantSpeechOpus(pcm)

    if (shouldCacheSpokenText(text)) {
      pendantSpeechCache.set(text, {
        pcm: Buffer.from(pcm),
        opus: Buffer.from(opus),
        truncated: wasTruncated,
      })
    }

    return {
      ...resultWithText,
      response: String(resultWithText?.response || text),
      pendantSpeech: pendantSpeechPayload(pcm, opus, wasTruncated),
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

export function encodePendantSpeechOpus(pcm) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || (pcm.length & 1) !== 0) {
    throw new Error('Opus input must be non-empty, 16-bit-aligned PCM.')
  }

  const encoder = spawnSync(
    process.env.PENDANT_FFMPEG_PATH || 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      's16le',
      '-ar',
      String(PENDANT_SPEECH_SAMPLE_RATE),
      '-ac',
      String(PENDANT_SPEECH_CHANNELS),
      '-i',
      'pipe:0',
      '-map_metadata',
      '-1',
      '-c:a',
      'libopus',
      '-application',
      'voip',
      '-frame_duration',
      '20',
      '-b:a',
      String(PENDANT_SPEECH_OPUS_BITRATE),
      '-vbr',
      'on',
      '-compression_level',
      '5',
      '-f',
      'ogg',
      'pipe:1',
    ],
    {
      input: pcm,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30000,
    },
  )

  if (encoder.error || encoder.status !== 0) {
    throw new Error(
      encoder.error?.message ||
        encoder.stderr?.toString().trim() ||
        `ffmpeg Opus encoder exited with status ${encoder.status}.`,
    )
  }
  if (
    !Buffer.isBuffer(encoder.stdout) ||
    encoder.stdout.length < 64 ||
    encoder.stdout.toString('ascii', 0, 4) !== 'OggS'
  ) {
    throw new Error('ffmpeg did not produce an Ogg Opus stream.')
  }

  return encoder.stdout
}

function applyFadeOut(pcm) {
  const sampleCount = pcm.length / 2
  const fadeSamples = Math.min(FADE_OUT_SAMPLES, sampleCount)
  const fadeStart = sampleCount - fadeSamples

  for (let index = 0; index < fadeSamples; index += 1) {
    const offset = (fadeStart + index) * 2
    const sample = pcm.readInt16LE(offset)
    const scaled = Math.round((sample * (fadeSamples - index - 1)) / fadeSamples)
    pcm.writeInt16LE(scaled, offset)
  }
}

// After actions run, the pendant should say what happened, not what was
// planned — and it must always say something, even for a silent action.
export function spokenConfirmation(plan, execution) {
  const results = Array.isArray(execution?.results) ? execution.results : []
  const failures = results.filter((entry) => entry?.ok === false)
  const spoken = []

  for (const entry of results) {
    const message = String(entry?.message || '').replace(/\s+/g, ' ').trim()
    if (message && entry?.ok !== false) spoken.push(message)
  }

  if (failures.length) {
    const reason = String(
      failures[0]?.reason || failures[0]?.message || 'it did not complete',
    )
      .replace(/\s+/g, ' ')
      .trim()
    return `That didn't work: ${reason}`.slice(0, MAX_SPOKEN_CHARACTERS)
  }

  const planned = String(plan?.response || '').replace(/\s+/g, ' ').trim()
  if (spoken.length) {
    return spoken.join('. ').slice(0, MAX_SPOKEN_CHARACTERS)
  }
  if (planned) return planned.slice(0, MAX_SPOKEN_CHARACTERS)

  const labels = Array.isArray(plan?.actions)
    ? plan.actions
        .map((action) => String(action?.label || action?.type || '').trim())
        .filter(Boolean)
    : []
  if (labels.length) {
    return `Done: ${labels.join(', ')}`.slice(0, MAX_SPOKEN_CHARACTERS)
  }
  return 'Done.'
}
