import express from 'express'

export const PENDANT_AUDIO_CONTENT_TYPES = Object.freeze([
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/opus',
  'audio/pcm',
  'audio/l16',
  'application/octet-stream',
])

export function createPendantAudioParser({ limit = '12mb' } = {}) {
  return express.raw({
    type: PENDANT_AUDIO_CONTENT_TYPES,
    limit,
  })
}

export function pendantAudioFormat({ headerFormat, contentType } = {}) {
  const explicit = String(headerFormat || '').trim().toLowerCase()
  if (explicit) {
    if (explicit === 's16le' || explicit === 'pcm-s16le' || explicit === 'raw') {
      return 'pcm'
    }
    return explicit
  }

  const mime = String(contentType || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (mime === 'audio/ogg' || mime === 'audio/opus') return 'ogg'
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav'
  if (mime === 'audio/pcm' || mime === 'audio/l16') return 'pcm'
  return 'wav'
}

export function isRawPcmFormat(format) {
  const value = String(format || '')
    .trim()
    .toLowerCase()
  return (
    value === 'pcm' ||
    value === 's16le' ||
    value === 'pcm-s16le' ||
    value === 'raw' ||
    value === 'l16'
  )
}

/**
 * Wrap interleaved little-endian PCM into a minimal RIFF/WAVE container so
 * Whisper / multimodal planners can ingest live pendant streams.
 */
export function pcmS16leToWavBuffer(
  pcmBuffer,
  { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {},
) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || [])
  const rate = Number(sampleRate) > 0 ? Math.floor(Number(sampleRate)) : 16000
  const ch = Number(channels) > 0 ? Math.floor(Number(channels)) : 1
  const bits = Number(bitsPerSample) > 0 ? Math.floor(Number(bitsPerSample)) : 16
  const blockAlign = (ch * bits) / 8
  const byteRate = rate * blockAlign
  const dataSize = pcm.length
  const header = Buffer.alloc(44)

  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // audio format = PCM
  header.writeUInt16LE(ch, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}

/**
 * Normalize pendant uploads for STT / multimodal APIs. Raw s16le becomes WAV.
 */
export function preparePendantAudioForStt({
  audio,
  format,
  sampleRate,
  channels = 1,
  bitsPerSample = 16,
} = {}) {
  const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || [])
  if (isRawPcmFormat(format)) {
    const wav = pcmS16leToWavBuffer(buffer, {
      sampleRate,
      channels,
      bitsPerSample,
    })
    return {
      audio: wav,
      format: 'wav',
      originalFormat: 'pcm',
      wrapped: true,
    }
  }
  return {
    audio: buffer,
    format: format || 'wav',
    originalFormat: format || 'wav',
    wrapped: false,
  }
}
