import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isG711UlawFormat,
  isRawPcmFormat,
  pendantAudioFormat,
  pcmS16leToWavBuffer,
  preparePendantAudioForStt,
  ulawToPcmS16le,
} from './rawAudio.js'

test('G.711 μ-law format detection and decode', () => {
  assert.equal(isG711UlawFormat('pcmu'), true)
  assert.equal(isG711UlawFormat('G711U'), true)
  assert.equal(isG711UlawFormat('g711_ulaw'), true)
  assert.equal(isG711UlawFormat('pcm'), false)
  assert.equal(isG711UlawFormat('ogg'), false)
  assert.equal(isRawPcmFormat('pcmu'), false)

  // μ-law silence (0xff) decodes to 0.
  assert.equal(ulawToPcmS16le(Buffer.from([0xff])).readInt16LE(0), 0)

  // Buffer decode doubles length.
  const encoded = Buffer.from([0xff, 0x7f, 0x00, 0x80])
  assert.equal(ulawToPcmS16le(encoded).length, 8)
})

test('an explicit audio-format header remains authoritative', () => {
  assert.equal(
    pendantAudioFormat({
      headerFormat: 'ogg-opus',
      contentType: 'application/octet-stream',
    }),
    'ogg-opus',
  )
  assert.equal(
    pendantAudioFormat({
      headerFormat: 's16le',
      contentType: 'application/octet-stream',
    }),
    'pcm',
  )
})

test('pcm s16le is wrapped into a valid WAV container for STT', () => {
  assert.equal(isRawPcmFormat('pcm'), true)
  assert.equal(isRawPcmFormat('ogg'), false)

  const pcm = Buffer.alloc(4)
  pcm.writeInt16LE(1000, 0)
  pcm.writeInt16LE(-1000, 2)

  const wav = pcmS16leToWavBuffer(pcm, {
    sampleRate: 15625,
    channels: 1,
    bitsPerSample: 16,
  })
  assert.equal(wav.length, 48)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt32LE(24), 15625)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.readUInt32LE(40), 4)
  assert.deepEqual(wav.subarray(44), pcm)

  const prepared = preparePendantAudioForStt({
    audio: pcm,
    format: 'pcm',
    sampleRate: 15625,
  })
  assert.equal(prepared.format, 'wav')
  assert.equal(prepared.wrapped, true)
  assert.equal(prepared.originalFormat, 'pcm')
  assert.equal(prepared.audio.length, 48)
})
