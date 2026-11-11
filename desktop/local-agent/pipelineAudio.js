import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { workspacePath } from './config.js'

const audioDirectory = path.join(workspacePath, 'pipeline-audio')
const MAX_AUDIO_BYTES = 1024 * 1024

export function savePipelineAudio({
  pipelineId,
  direction = 'output',
  format,
  sampleRate,
  channels,
  bitsPerSample,
  audioBase64,
}) {
  const id = normalizeId(pipelineId)
  const normalizedDirection = normalizeDirection(direction)
  const normalizedFormat = String(format || '').toLowerCase()
  const rate = Number(sampleRate)
  const channelCount = Number(channels)
  const bits = Number(bitsPerSample)
  const pcm = Buffer.from(String(audioBase64 || ''), 'base64')

  if (normalizedFormat !== 's16le') {
    throw new Error(`Unsupported pipeline audio format: ${format || '(empty)'}.`)
  }
  if (
    !Number.isInteger(rate) ||
    rate < 8000 ||
    rate > 96000 ||
    channelCount !== 1 ||
    bits !== 16
  ) {
    throw new Error('Pipeline audio must be 8–96 kHz, mono, signed 16-bit PCM.')
  }
  if (!pcm.length || pcm.length > MAX_AUDIO_BYTES || pcm.length % 2 !== 0) {
    throw new Error('Pipeline PCM is empty, too large, or not 16-bit aligned.')
  }

  ensureDirectory()
  const wave = makeWave(pcm, {
    sampleRate: rate,
    channels: channelCount,
    bitsPerSample: bits,
  })
  const outputPath = audioPath(id, normalizedDirection)
  fs.writeFileSync(outputPath, wave)

  return {
    pipelineId: id,
    direction: normalizedDirection,
    mimeType: 'audio/wav',
    pcmBytes: pcm.length,
    waveBytes: wave.length,
    sampleRate: rate,
    channels: channelCount,
    bitsPerSample: bits,
    durationMs: Math.round(
      (pcm.length / (bits / 8) / channelCount / rate) * 1000,
    ),
    ...analyzePcm(pcm),
  }
}

export function readPipelineAudio(pipelineId, direction = 'output') {
  const id = normalizeId(pipelineId)
  const normalizedDirection = normalizeDirection(direction)
  const inputPath = audioPath(id, normalizedDirection)
  if (!fs.existsSync(inputPath)) return null
  return {
    buffer: fs.readFileSync(inputPath),
    mimeType: 'audio/wav',
  }
}

function normalizeId(value) {
  const id = String(value || '').trim()
  if (!id || id.length > 240) {
    throw new Error('A valid pipelineId is required for audio.')
  }
  return id
}

function normalizeDirection(value) {
  const direction = String(value || 'output').toLowerCase()
  if (direction !== 'input' && direction !== 'output') {
    throw new Error('Pipeline audio direction must be input or output.')
  }
  return direction
}

function ensureDirectory() {
  fs.mkdirSync(audioDirectory, { recursive: true })
}

function audioPath(pipelineId, direction) {
  const digest = crypto
    .createHash('sha256')
    .update(pipelineId)
    .digest('hex')
  return path.join(audioDirectory, `${digest}-${direction}.wav`)
}

function makeWave(pcm, { sampleRate, channels, bitsPerSample }) {
  const header = Buffer.alloc(44)
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

function analyzePcm(pcm) {
  const sampleCount = pcm.length / 2
  let peak = 0
  let squareSum = 0
  let clippedSamples = 0

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = pcm.readInt16LE(index * 2)
    const absolute = Math.abs(sample)
    peak = Math.max(peak, absolute)
    squareSum += sample * sample
    if (absolute >= 32760) clippedSamples += 1
  }

  return {
    peakPercent: Number(((peak / 32767) * 100).toFixed(1)),
    rmsPercent: Number(
      ((Math.sqrt(squareSum / sampleCount) / 32767) * 100).toFixed(1),
    ),
    clippedSamples,
  }
}
