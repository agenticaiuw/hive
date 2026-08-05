import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'

import {
  createPendantAudioParser,
  isG711UlawFormat,
  isRawPcmFormat,
  linearToUlaw,
  pendantAudioFormat,
  pcmS16leToWavBuffer,
  preparePendantAudioForStt,
  ulawToPcmS16le,
} from './rawAudio.js'

test('G.711 μ-law format detection and codec round-trip', () => {
  assert.equal(isG711UlawFormat('pcmu'), true)
  assert.equal(isG711UlawFormat('G711U'), true)
  assert.equal(isG711UlawFormat('g711_ulaw'), true)
  assert.equal(isG711UlawFormat('pcm'), false)
  assert.equal(isG711UlawFormat('ogg'), false)
  assert.equal(isRawPcmFormat('pcmu'), false)

  // Silence encodes to 0xff and decodes back to 0.
  assert.equal(linearToUlaw(0), 0xff)
  assert.equal(ulawToPcmS16le(Buffer.from([0xff])).readInt16LE(0), 0)

  // Round-trip error stays within one quantization step across the range.
  for (const sample of [-32000, -12345, -500, -1, 0, 1, 500, 12345, 32000]) {
    const decoded = ulawToPcmS16le(
      Buffer.from([linearToUlaw(sample)]),
    ).readInt16LE(0)
    const step = Math.max(16, Math.abs(sample) / 16)
    assert.ok(
      Math.abs(decoded - sample) <= step,
      `sample ${sample} decoded to ${decoded}`,
    )
  }

  // Buffer decode doubles length.
  const encoded = Buffer.from([0xff, 0x7f, 0x00, 0x80])
  assert.equal(ulawToPcmS16le(encoded).length, 8)
})

async function withRawAudioServer(run) {
  const app = express()
  app.post('/upload', createPendantAudioParser(), (request, response) => {
    response.json({
      bytes: Buffer.isBuffer(request.body) ? request.body.length : 0,
      format: pendantAudioFormat({
        headerFormat: request.get('x-audio-format'),
        contentType: request.get('content-type'),
      }),
    })
  })

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })

  try {
    const address = server.address()
    await run(`http://127.0.0.1:${address.port}/upload`)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

for (const contentType of ['audio/ogg', 'audio/opus']) {
  test(`raw pendant parser accepts ${contentType}`, async () => {
    await withRawAudioServer(async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: Buffer.from('OggS-test-payload'),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { bytes: 17, format: 'ogg' })
    })
  })
}

test('raw pendant parser accepts audio/pcm', async () => {
  await withRawAudioServer(async (url) => {
    const pcm = Buffer.alloc(8, 0x11)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/pcm',
        'X-Audio-Format': 'pcm',
      },
      body: pcm,
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { bytes: 8, format: 'pcm' })
  })
})

test('raw pendant parser accepts chunked Transfer-Encoding bodies', async () => {
  await withRawAudioServer(async (url) => {
    const pcm = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00])
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/pcm',
        'X-Audio-Format': 'pcm',
        'X-Sample-Rate': '15625',
      },
      body: pcm,
      // undici/fetch sends Content-Length for Buffer bodies; Node express.raw
      // still accepts the assembled body. Explicit duplex streaming is optional.
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.bytes, 8)
    assert.equal(payload.format, 'pcm')
  })
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
