import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const PENDANT_SPEECH_SAMPLE_RATE = 24000
export const PENDANT_SPEECH_CHANNELS = 1
export const PENDANT_SPEECH_BITS = 16
export const PENDANT_SPEECH_MAX_PCM_BYTES = 480000
export const PENDANT_SPEECH_OPUS_BITRATE = 16000

const MAX_SPOKEN_CHARACTERS = 180
const SPEECH_RATE_WORDS_PER_MINUTE = 210
const FADE_OUT_SAMPLES = Math.round(PENDANT_SPEECH_SAMPLE_RATE * 0.1)

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
    .map((candidate) => String(candidate || '').replace(/\s+/g, ' ').trim())
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

export function synthesizePendantSpeech(result) {
  // spokenTextForResult always returns text; keep a belt-and-braces fallback
  // so a future regression cannot ship silent results to the pendant.
  const text = spokenTextForResult(result) || 'Done.'
  const resultWithText =
    result && typeof result === 'object' && !String(result.response || '').trim()
      ? { ...result, response: text }
      : result

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

    return {
      ...resultWithText,
      response: String(resultWithText?.response || text),
      pendantSpeech: {
        format: 's16le',
        sampleRate: PENDANT_SPEECH_SAMPLE_RATE,
        channels: PENDANT_SPEECH_CHANNELS,
        bitsPerSample: PENDANT_SPEECH_BITS,
        pcmBytes: pcm.length,
        truncated: wasTruncated,
        audioBase64: pcm.toString('base64'),
        compressedFormat: 'ogg-opus',
        compressedBytes: opus.length,
        compressedAudioBase64: opus.toString('base64'),
      },
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
