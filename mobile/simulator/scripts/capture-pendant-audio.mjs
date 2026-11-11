import '../load-pendant-env.mjs'

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_RELAY_URL =
  'https://ai-pendant-relay.evan20050827.workers.dev'
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_OUTPUT_DIRECTORY = path.resolve(
  SCRIPT_DIRECTORY,
  '../../../diagnostics/audio-captures',
)
const DEFAULT_MODEL_PATH =
  '/Users/evanliu/AI-Pendant-Workspace/models/ggml-tiny.en-q5_1.bin'

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

export function inspectWave(wave) {
  if (
    !Buffer.isBuffer(wave) ||
    wave.length < 44 ||
    wave.toString('ascii', 0, 4) !== 'RIFF' ||
    wave.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Capture is not a RIFF/WAVE file.')
  }

  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let pcm = null

  for (let offset = 12; offset + 8 <= wave.length; ) {
    const chunkId = wave.toString('ascii', offset, offset + 4)
    const chunkBytes = wave.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    // ffmpeg uses an open-ended data size when WAVE is written to stdout.
    const chunkEnd =
      chunkId === 'data' && chunkBytes === 0xffffffff
        ? wave.length
        : chunkStart + chunkBytes
    if (chunkEnd > wave.length) {
      throw new Error(`Invalid ${chunkId} chunk length.`)
    }
    if (chunkId === 'fmt ' && chunkBytes >= 16) {
      channels = wave.readUInt16LE(chunkStart + 2)
      sampleRate = wave.readUInt32LE(chunkStart + 4)
      bitsPerSample = wave.readUInt16LE(chunkStart + 14)
    } else if (chunkId === 'data') {
      pcm = wave.subarray(chunkStart, chunkEnd)
    }
    offset = chunkEnd + (chunkBytes & 1)
  }

  if (!pcm || channels !== 1 || bitsPerSample !== 16 || !sampleRate) {
    throw new Error('Expected 16-bit mono PCM inside the WAVE capture.')
  }

  const samples = pcm.length / 2
  let sum = 0
  let squareSum = 0
  let peak = 0
  let minimum = 32767
  let maximum = -32768
  let clippedSamples = 0
  let zeroCrossings = 0
  let previous = 0

  for (let index = 0; index < samples; index += 1) {
    const value = pcm.readInt16LE(index * 2)
    sum += value
    squareSum += value * value
    peak = Math.max(peak, Math.abs(value))
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
    if (Math.abs(value) >= 32760) clippedSamples += 1
    if (
      index > 0 &&
      ((previous < 0 && value >= 0) || (previous >= 0 && value < 0))
    ) {
      zeroCrossings += 1
    }
    previous = value
  }

  const dcOffset = samples ? sum / samples : 0
  const rms = samples ? Math.sqrt(squareSum / samples) : 0
  const db = (value) =>
    value > 0 ? Number((20 * Math.log10(value / 32768)).toFixed(1)) : null

  return {
    sampleRate,
    channels,
    bitsPerSample,
    samples,
    durationMs: Math.round((samples * 1000) / sampleRate),
    dcOffset: Math.round(dcOffset),
    rms: Math.round(rms),
    rmsDbfs: db(rms),
    peak,
    peakDbfs: db(peak),
    minimum,
    maximum,
    zeroCrossings,
    clippedSamples,
  }
}

export function decodeOggOpusToWave(opus) {
  if (
    !Buffer.isBuffer(opus) ||
    opus.length < 64 ||
    opus.toString('ascii', 0, 4) !== 'OggS'
  ) {
    throw new Error('Capture is not an Ogg stream.')
  }

  const decoded = spawnSync(
    process.env.PENDANT_FFMPEG_PATH || 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      'pipe:1',
    ],
    {
      input: opus,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30000,
    },
  )
  if (decoded.error || decoded.status !== 0) {
    throw new Error(
      decoded.error?.message ||
        decoded.stderr?.toString().trim() ||
        `ffmpeg Opus decoder exited with status ${decoded.status}.`,
    )
  }
  return decoded.stdout
}

function runLocalWhisper(wavePath, modelPath) {
  const outputPrefix = wavePath.replace(/\.wav$/i, '.local-whisper')
  const result = spawnSync(
    'whisper-cli',
    [
      '-m',
      modelPath,
      '-f',
      wavePath,
      '-l',
      'en',
      '-nt',
      '-np',
      '-otxt',
      '-of',
      outputPrefix,
    ],
    {
      encoding: 'utf8',
      timeout: 120000,
    },
  )

  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ||
        result.stderr?.trim() ||
        `whisper-cli exited with status ${result.status}.`,
    )
  }

  const transcriptPath = `${outputPrefix}.txt`
  const transcript = fs.existsSync(transcriptPath)
    ? fs.readFileSync(transcriptPath, 'utf8').trim()
    : result.stdout.trim()

  return {
    transcript,
    transcriptPath,
  }
}

export function savedCaptureIds(outputDirectory) {
  if (!fs.existsSync(outputDirectory)) return new Set()

  const captureIds = new Set()
  for (const entry of fs.readdirSync(outputDirectory)) {
    if (!entry.endsWith('.json') || entry === 'latest.json') continue

    try {
      const report = JSON.parse(
        fs.readFileSync(path.join(outputDirectory, entry), 'utf8'),
      )
      const captureId = report?.capture?.captureId
      if (captureId) captureIds.add(String(captureId))
    } catch {
      // A partial or manually created report must not stop future captures.
    }
  }
  return captureIds
}

async function relayJson(relayUrl, relayApiKey, route) {
  const response = await fetch(`${relayUrl}${route}`, {
    headers: {
      Authorization: `Bearer ${relayApiKey}`,
    },
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.error || `Relay request failed (${response.status}).`)
  }
  return payload
}

async function captureAudio(relayUrl, relayApiKey, capture, outputDirectory) {
  const response = await fetch(
    `${relayUrl}/v1/ops/audio-captures/${encodeURIComponent(capture.captureId)}/audio`,
    {
      headers: {
        Authorization: `Bearer ${relayApiKey}`,
      },
      cache: 'no-store',
    },
  )
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(
      payload.error || `Audio download failed (${response.status}).`,
    )
  }

  const timestamp = String(capture.createdAt || new Date().toISOString())
    .replace(/[:.]/g, '-')
  const stem = `${timestamp}-${capture.captureId}`
  const wavePath = path.join(outputDirectory, `${stem}.wav`)
  const reportPath = path.join(outputDirectory, `${stem}.json`)
  const downloaded = Buffer.from(await response.arrayBuffer())
  const captureFormat = String(capture.format || '').toLowerCase()
  const isOpus =
    response.headers.get('content-type')?.toLowerCase().includes('audio/ogg') ||
    ['ogg', 'opus', 'ogg-opus'].includes(captureFormat) ||
    downloaded.toString('ascii', 0, 4) === 'OggS'
  const compressedPath = isOpus
    ? path.join(outputDirectory, `${stem}.ogg`)
    : null
  if (compressedPath) {
    fs.writeFileSync(compressedPath, downloaded)
  }
  const wave = isOpus ? decodeOggOpusToWave(downloaded) : downloaded
  fs.writeFileSync(wavePath, wave)
  const signal = inspectWave(wave)

  return {
    compressedPath,
    wavePath,
    reportPath,
    signal,
  }
}

async function main() {
  const relayUrl = String(process.env.RELAY_URL || DEFAULT_RELAY_URL).replace(
    /\/$/,
    '',
  )
  const relayApiKey = String(process.env.RELAY_API_KEY || '')
  const outputDirectory =
    argumentValue('--output') ||
    process.env.PENDANT_AUDIO_CAPTURE_DIR ||
    DEFAULT_OUTPUT_DIRECTORY
  const modelPath =
    argumentValue('--model') ||
    process.env.PENDANT_WHISPER_MODEL ||
    DEFAULT_MODEL_PATH
  const follow = process.argv.includes('--follow')
  const newOnly = process.argv.includes('--new-only')

  if (!relayApiKey) {
    throw new Error('RELAY_API_KEY is required.')
  }

  fs.mkdirSync(outputDirectory, { recursive: true })
  const seen = savedCaptureIds(outputDirectory)
  const initial = await relayJson(
    relayUrl,
    relayApiKey,
    '/v1/ops/audio-captures?limit=20',
  )
  if (newOnly) {
    for (const capture of initial.captures || []) {
      seen.add(capture.captureId)
    }
  }

  console.log(`Watching pendant audio at ${relayUrl}`)
  console.log(`Saving WAVE files to ${outputDirectory}`)
  if (fs.existsSync(modelPath)) {
    console.log(`Local model: ${modelPath}`)
  } else {
    console.warn(
      `Local Whisper model is missing; WAVE files will still be saved: ${modelPath}`,
    )
  }
  console.log('Ready for the next nRF recording.')

  do {
    const payload = await relayJson(
      relayUrl,
      relayApiKey,
      '/v1/ops/audio-captures?limit=20',
    )
    const captures = [...(payload.captures || [])].reverse()

    for (const capture of captures) {
      if (seen.has(capture.captureId)) continue

      try {
        const local = await captureAudio(
          relayUrl,
          relayApiKey,
          capture,
          outputDirectory,
        )
        const initialReport = {
          capture,
          localTranscript: '',
          localTranscriptionError: null,
          localAnalysisPending: true,
          signal: local.signal,
          compressedPath: local.compressedPath,
          wavePath: local.wavePath,
          transcriptPath: null,
          savedAt: new Date().toISOString(),
        }
        /*
         * Make both the timestamped file and latest.wav visible immediately.
         * Local Whisper runs afterward and only enriches the JSON report.
         */
        fs.writeFileSync(
          local.reportPath,
          `${JSON.stringify(initialReport, null, 2)}\n`,
        )
        fs.copyFileSync(local.wavePath, path.join(outputDirectory, 'latest.wav'))
        fs.copyFileSync(local.reportPath, path.join(outputDirectory, 'latest.json'))
        seen.add(capture.captureId)
        console.log(`\nCapture ${capture.captureId} saved immediately`)
        console.log(`WAVE: ${local.wavePath}`)

        let whisper = {
          transcript: '',
          transcriptPath: null,
          error: null,
        }
        if (fs.existsSync(modelPath)) {
          try {
            whisper = {
              ...runLocalWhisper(local.wavePath, modelPath),
              error: null,
            }
          } catch (error) {
            whisper.error =
              error instanceof Error ? error.message : String(error)
          }
        } else {
          whisper.error = `Local Whisper model is missing: ${modelPath}`
        }
        const report = {
          capture,
          localTranscript: whisper.transcript,
          localTranscriptionError: whisper.error,
          localAnalysisPending: false,
          signal: local.signal,
          compressedPath: local.compressedPath,
          wavePath: local.wavePath,
          transcriptPath: whisper.transcriptPath,
          inspectedAt: new Date().toISOString(),
        }
        fs.writeFileSync(local.reportPath, `${JSON.stringify(report, null, 2)}\n`)
        fs.copyFileSync(local.reportPath, path.join(outputDirectory, 'latest.json'))

        console.log(
          `Signal: peak ${local.signal.peakDbfs} dBFS, RMS ${local.signal.rmsDbfs} dBFS, DC ${local.signal.dcOffset}, zero crossings ${local.signal.zeroCrossings}`,
        )
        console.log(`Cloud: ${JSON.stringify(capture.cloudTranscript || '')}`)
        if (whisper.error) {
          console.log(`Local transcription unavailable: ${whisper.error}`)
        } else {
          console.log(`Local: ${JSON.stringify(whisper.transcript || '')}`)
        }
        console.log(`Report: ${local.reportPath}`)
      } catch (error) {
        console.error(
          `Capture ${capture.captureId} failed:`,
          error instanceof Error ? error.message : error,
        )
      }
    }

    if (follow) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  } while (follow)
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
