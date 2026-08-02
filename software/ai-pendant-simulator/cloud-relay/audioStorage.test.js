import assert from 'node:assert/strict'
import test from 'node:test'

import {
  audioContentType,
  createAudioObjectKey,
  deleteAudioCaptureObject,
  loadAudioCapture,
  persistAudioCapture,
} from './audioStorage.js'

function createFakeR2({ failPut = false } = {}) {
  const objects = new Map()

  return {
    objects,
    async put(key, body, options) {
      if (failPut) {
        throw new Error('simulated bucket outage')
      }
      const buffer = Buffer.from(body)
      objects.set(key, {
        buffer,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      })
      return { etag: 'test-etag' }
    },
    async get(key) {
      const object = objects.get(key)
      if (!object) return null
      return {
        httpMetadata: object.httpMetadata,
        async arrayBuffer() {
          return object.buffer.buffer.slice(
            object.buffer.byteOffset,
            object.buffer.byteOffset + object.buffer.byteLength,
          )
        },
      }
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

test('writes raw diagnostic audio to R2 and leaves only a durable reference', async () => {
  const bucket = createFakeR2()
  const audio = Buffer.from('RIFF test audio')
  const result = await persistAudioCapture({
    captureId: 'job_capture_1',
    audioBase64: audio.toString('base64'),
    audioBytes: audio.length,
    format: 'wav',
    createdAt: '2026-08-02T10:20:30.000Z',
    bindings: { AUDIO_BUCKET: bucket },
  })

  assert.equal(result.audioStorage, 'r2')
  assert.equal(result.audioBase64, undefined)
  assert.equal(
    result.audioRef.key,
    'audio-captures/2026/08/02/job_capture_1.wav',
  )
  assert.equal(result.audioRef.contentType, 'audio/wav')
  assert.equal(result.audioRef.audioBytes, audio.length)

  const stored = bucket.objects.get(result.audioRef.key)
  assert.deepEqual(stored.buffer, audio)
  assert.equal(stored.httpMetadata.contentType, 'audio/wav')
  assert.equal(stored.customMetadata.captureId, 'job_capture_1')
})

test('reads an R2-backed recording through its private metadata reference', async () => {
  const bucket = createFakeR2()
  const audio = Buffer.from([0x4f, 0x67, 0x67, 0x53])
  const persisted = await persistAudioCapture({
    captureId: 'job_capture_2',
    audioBase64: audio.toString('base64'),
    format: 'opus',
    bindings: { AUDIO_BUCKET: bucket },
  })
  const capture = {
    jobId: 'job_capture_2',
    type: 'audio_capture',
    format: 'opus',
    ...persisted,
  }

  const loaded = await loadAudioCapture(capture, {
    bindings: { AUDIO_BUCKET: bucket },
  })

  assert.deepEqual(loaded.audio, audio)
  assert.equal(loaded.contentType, 'audio/ogg')
  assert.equal(loaded.source, 'r2')
})

test('keeps legacy D1 Base64 storage when R2 is not configured', async () => {
  const audio = Buffer.from('legacy audio')
  const persisted = await persistAudioCapture({
    captureId: 'job_legacy',
    audioBase64: audio.toString('base64'),
    format: 'wav',
    bindings: {},
  })

  assert.equal(persisted.audioStorage, 'd1-base64')
  assert.equal(persisted.audioBase64, audio.toString('base64'))
  assert.equal(persisted.audioRef, null)

  const loaded = await loadAudioCapture(
    {
      jobId: 'job_legacy',
      type: 'audio_capture',
      format: 'wav',
      ...persisted,
    },
    { bindings: {} },
  )
  assert.deepEqual(loaded.audio, audio)
  assert.equal(loaded.source, 'd1-base64')
})

test('falls back to D1 Base64 if an R2 write fails', async () => {
  const audioBase64 = Buffer.from('do not lose me').toString('base64')
  const persisted = await persistAudioCapture({
    captureId: 'job_fallback',
    audioBase64,
    format: 'wav',
    bindings: { AUDIO_BUCKET: createFakeR2({ failPut: true }) },
  })

  assert.equal(persisted.audioStorage, 'd1-base64')
  assert.equal(persisted.audioBase64, audioBase64)
  assert.match(persisted.audioStorageWarning, /simulated bucket outage/)
})

test('does not force oversized audio into D1 when R2 is unavailable', async () => {
  const persisted = await persistAudioCapture({
    captureId: 'job_oversized',
    audioBase64: Buffer.from('oversized in production').toString('base64'),
    format: 'audio/ogg;codecs=opus',
    allowD1Fallback: false,
    bindings: { AUDIO_BUCKET: createFakeR2({ failPut: true }) },
  })

  assert.equal(persisted.audioStorage, 'unavailable')
  assert.equal(persisted.audioBase64, undefined)
  assert.equal(persisted.audioRef, null)
  assert.match(persisted.audioStorageWarning, /too large for D1/)
})

test('does not use an untrusted object key', async () => {
  const loaded = await loadAudioCapture(
    {
      jobId: 'job_capture',
      type: 'audio_capture',
      format: 'wav',
      audioRef: {
        provider: 'r2',
        key: '../another-users-audio.wav',
      },
    },
    { bindings: { AUDIO_BUCKET: createFakeR2() } },
  )

  assert.equal(loaded, null)
})

test('deletes an R2 object when its metadata transaction cannot be committed', async () => {
  const bucket = createFakeR2()
  const persisted = await persistAudioCapture({
    captureId: 'job_orphan',
    audioBase64: Buffer.from('temporary object').toString('base64'),
    format: 'wav',
    bindings: { AUDIO_BUCKET: bucket },
  })
  const capture = {
    jobId: 'job_orphan',
    type: 'audio_capture',
    ...persisted,
  }

  assert.equal(bucket.objects.size, 1)
  assert.equal(
    await deleteAudioCaptureObject(capture, {
      bindings: { AUDIO_BUCKET: bucket },
    }),
    true,
  )
  assert.equal(bucket.objects.size, 0)
})

test('normalizes content types and deterministic object keys', () => {
  assert.equal(audioContentType('ogg-opus'), 'audio/ogg')
  assert.equal(audioContentType('audio/ogg;codecs=opus'), 'audio/ogg')
  assert.equal(audioContentType('audio/mpeg'), 'audio/mpeg')
  assert.equal(audioContentType('s16le'), 'audio/pcm')
  assert.equal(audioContentType('unexpected'), 'application/octet-stream')
  assert.equal(
    createAudioObjectKey('job_safe', 'application/octet-stream', {
      createdAt: '2026-01-02T00:00:00.000Z',
      prefix: 'tenant/default/audio',
    }),
    'tenant/default/audio/2026/01/02/job_safe.bin',
  )
})
