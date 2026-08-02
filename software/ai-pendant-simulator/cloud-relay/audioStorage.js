import { Buffer } from 'node:buffer'

import { getCloudflareBindings } from './cloudflareBindings.js'

const DEFAULT_OBJECT_PREFIX = 'audio-captures'

export function audioContentType(format) {
  const normalized = normalizeAudioFormat(format)
  if (['ogg', 'opus', 'ogg-opus'].includes(normalized)) {
    return 'audio/ogg'
  }
  if (normalized === 'wav') {
    return 'audio/wav'
  }
  if (normalized === 'mp3') {
    return 'audio/mpeg'
  }
  if (normalized === 'pcm' || normalized === 's16le') {
    return 'audio/pcm'
  }
  return 'application/octet-stream'
}

export function createAudioObjectKey(
  captureId,
  format,
  {
    createdAt = new Date().toISOString(),
    prefix = DEFAULT_OBJECT_PREFIX,
  } = {},
) {
  const safeCaptureId = String(captureId || '').trim()
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(safeCaptureId)) {
    throw new Error('A valid captureId is required for durable audio storage.')
  }

  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) {
    throw new Error('A valid createdAt timestamp is required for audio storage.')
  }

  const safePrefix = normalizeObjectPrefix(prefix)
  const day = date.toISOString().slice(0, 10).replaceAll('-', '/')
  return `${safePrefix}/${day}/${safeCaptureId}.${audioExtension(format)}`
}

/**
 * Store a diagnostic recording in R2 when the Worker binding is available.
 *
 * The Base64 value is returned unchanged when R2 is not configured or a write
 * fails. That keeps local development and already-deployed Workers compatible
 * while ensuring an R2 outage never blocks speech-to-text.
 */
export async function persistAudioCapture({
  captureId,
  audioBase64,
  audioBytes = null,
  format,
  createdAt = new Date().toISOString(),
  allowD1Fallback = true,
  bindings = getCloudflareBindings(),
  prefix = bindings?.AUDIO_BUCKET_PREFIX || DEFAULT_OBJECT_PREFIX,
}) {
  const cleanBase64 = String(audioBase64 || '')
    .replace(/^data:[^;]+;base64,/, '')
    .trim()
  const audio = Buffer.from(cleanBase64, 'base64')

  if (!audio.length) {
    throw new Error('Audio data is required for durable storage.')
  }

  const bucket = bindings?.AUDIO_BUCKET
  if (!bucket?.put) {
    return allowD1Fallback
      ? d1Fallback(cleanBase64)
      : unavailableStorage(
          'R2 is not configured and the recording is too large for D1.',
        )
  }

  const key = createAudioObjectKey(captureId, format, {
    createdAt,
    prefix,
  })
  const contentType = audioContentType(format)

  try {
    const object = await bucket.put(key, audio, {
      httpMetadata: {
        contentType,
      },
      customMetadata: {
        captureId: String(captureId),
        format: normalizeAudioFormat(format) || 'unknown',
        createdAt: new Date(createdAt).toISOString(),
      },
    })

    return {
      audioBase64: undefined,
      audioStorage: 'r2',
      audioRef: {
        provider: 'r2',
        key,
        contentType,
        audioBytes: Number(audioBytes) || audio.length,
        etag: object?.httpEtag || object?.etag || null,
        persistedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 240)
    return allowD1Fallback
      ? d1Fallback(
          cleanBase64,
          `R2 write failed; retained D1 Base64 fallback: ${detail}`,
        )
      : unavailableStorage(
          `R2 write failed and the recording is too large for D1: ${detail}`,
        )
  }
}

export async function deleteAudioCaptureObject(
  capture,
  { bindings = getCloudflareBindings() } = {},
) {
  const ref = capture?.audioRef
  if (
    ref?.provider !== 'r2' ||
    !isTrustedAudioKey(ref.key, capture?.jobId) ||
    !bindings?.AUDIO_BUCKET?.delete
  ) {
    return false
  }

  await bindings.AUDIO_BUCKET.delete(ref.key)
  return true
}

/**
 * Resolve a capture into bytes. New records use their private R2 key; records
 * created before R2 was enabled continue to read from D1 Base64.
 */
export async function loadAudioCapture(
  capture,
  { bindings = getCloudflareBindings() } = {},
) {
  if (!capture || capture.type !== 'audio_capture') {
    return null
  }

  const ref = capture.audioRef
  if (ref?.provider === 'r2' && isTrustedAudioKey(ref.key, capture.jobId)) {
    const bucket = bindings?.AUDIO_BUCKET
    if (bucket?.get) {
      const object = await bucket.get(ref.key)
      if (object) {
        const audio = Buffer.from(await object.arrayBuffer())
        return {
          audio,
          contentType:
            object.httpMetadata?.contentType ||
            ref.contentType ||
            audioContentType(capture.format),
          source: 'r2',
        }
      }
    }
  }

  const cleanBase64 = String(capture.audioBase64 || '').trim()
  if (!cleanBase64) {
    return null
  }

  const audio = Buffer.from(cleanBase64, 'base64')
  if (!audio.length) {
    return null
  }

  return {
    audio,
    contentType: audioContentType(capture.format),
    source: 'd1-base64',
  }
}

function d1Fallback(audioBase64, audioStorageWarning = null) {
  return {
    audioBase64,
    audioStorage: 'd1-base64',
    audioRef: null,
    ...(audioStorageWarning ? { audioStorageWarning } : {}),
  }
}

function unavailableStorage(audioStorageWarning) {
  return {
    audioBase64: undefined,
    audioStorage: 'unavailable',
    audioRef: null,
    audioStorageWarning,
  }
}

function normalizeAudioFormat(format) {
  const normalized = String(format || '')
    .trim()
    .toLowerCase()
    .replace(/^audio\//, '')
    .split(';', 1)[0]
  if (normalized === 'x-wav') return 'wav'
  if (normalized === 'mpeg') return 'mp3'
  return normalized
}

function audioExtension(format) {
  const normalized = normalizeAudioFormat(format)
  if (['ogg', 'opus', 'ogg-opus'].includes(normalized)) return 'ogg'
  if (normalized === 'wav') return 'wav'
  if (normalized === 'mp3' || normalized === 'mpeg') return 'mp3'
  if (normalized === 'pcm' || normalized === 's16le') return 'pcm'
  return 'bin'
}

function normalizeObjectPrefix(prefix) {
  const normalized = String(prefix || DEFAULT_OBJECT_PREFIX)
    .trim()
    .replace(/^\/+|\/+$/g, '')

  if (
    !normalized ||
    normalized.length > 160 ||
    normalized.split('/').some((part) => !/^[a-zA-Z0-9._-]+$/.test(part))
  ) {
    throw new Error('AUDIO_BUCKET_PREFIX contains an invalid path segment.')
  }

  return normalized
}

function isTrustedAudioKey(key, captureId) {
  const normalizedKey = String(key || '')
  const normalizedCaptureId = String(captureId || '')
  return (
    normalizedKey.length <= 512 &&
    !normalizedKey.startsWith('/') &&
    !normalizedKey.includes('..') &&
    normalizedKey
      .split('/')
      .every((part) => /^[a-zA-Z0-9._-]+$/.test(part)) &&
    normalizedKey
      .split('/')
      .at(-1)
      ?.startsWith(`${normalizedCaptureId}.`)
  )
}
