import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import '../../load-pendant-env.mjs'

export const STAGES = [
  'recording',
  'microSD',
  'lte_upload',
  'transcription',
  'cloud_queue',
  'mac_agent',
  'tts',
  'reply_download',
  'i2s_playback',
]

const USE_COLOR = process.stdout.isTTY && process.env.NO_COLOR == null
const COLORS = {
  active: '\u001b[36m',
  done: '\u001b[32m',
  failed: '\u001b[31m',
  warning: '\u001b[33m',
  muted: '\u001b[90m',
  reset: '\u001b[0m',
}

export function parseSerialLine(line) {
  const value = stripTerminalNoise(line).trim()
  if (!value) return null

  let match
  if ((match = value.match(/PDM live: status=active sample_limit=(\d+)/))) {
    return event('recording', 'active', 'PDM recording started', {
      sampleLimit: Number(match[1]),
    }, value, true)
  }
  if ((match = value.match(/PDM live: samples=(\d+) mean=(\d+) peak=(\d+) rms=(\d+) min=(-?\d+) max=(-?\d+) zero_crossings=(\d+)/))) {
    const samples = Number(match[1])
    const meanAbs = Number(match[2])
    const peak = Number(match[3])
    return event('recording', 'active', 'PDM recording live signal', {
      samples,
      meanAbs,
      peak,
      rms: Number(match[4]),
      minimum: Number(match[5]),
      maximum: Number(match[6]),
      zeroCrossings: Number(match[7]),
      durationMs: Math.round((samples / 16000) * 1000),
      peakDbfs: dbfs(peak),
      meanDbfs: dbfs(meanAbs),
      signalAssessment: assessSignal({ meanAbs, peak }),
    }, value, true)
  }
  if ((match = value.match(/PDM capture totals: samples=(\d+) mean=(\d+) peak=(\d+)(?: rms=(\d+) min=(-?\d+) max=(-?\d+) zero_crossings=(\d+))?/))) {
    const samples = Number(match[1])
    const meanAbs = Number(match[2])
    const peak = Number(match[3])
    return event('recording', 'done', 'PDM recording captured', {
      samples,
      meanAbs,
      peak,
      rms: match[4] == null ? null : Number(match[4]),
      minimum: match[5] == null ? null : Number(match[5]),
      maximum: match[6] == null ? null : Number(match[6]),
      zeroCrossings: match[7] == null ? null : Number(match[7]),
      durationMs: Math.round((samples / 16000) * 1000),
      peakDbfs: dbfs(peak),
      meanDbfs: dbfs(meanAbs),
      signalAssessment: assessSignal({ meanAbs, peak }),
    }, value, true)
  }
  if ((match = value.match(/Microphone recording failed: (-?\d+)/))) {
    return event('recording', 'failed', 'PDM recording failed', {
      result: Number(match[1]),
    }, value, true, true)
  }
  if ((match = value.match(/Cloud upload found (\d+) PCM bytes on SD/))) {
    return event('microSD', 'done', 'PCM file verified on microSD', {
      pcmBytes: Number(match[1]),
    }, value)
  }
  if (
    (match = value.match(
      /Opus encoded (\d+) PCM bytes to (\d+) Ogg bytes \((\d+) packets/,
    ))
  ) {
    return event('microSD', 'done', 'Recording compressed with Opus', {
      pcmBytes: Number(match[1]),
      opusBytes: Number(match[2]),
      opusPackets: Number(match[3]),
    }, value)
  }
  if ((match = value.match(/Cloud upload found (\d+) Ogg Opus bytes on SD/))) {
    return event('microSD', 'done', 'Ogg Opus file verified on microSD', {
      opusBytes: Number(match[1]),
    }, value)
  }
  if ((match = value.match(/Uploaded (\d+) PCM bytes for transcription/))) {
    return event('lte_upload', 'done', 'Recording uploaded over LTE', {
      pcmBytes: Number(match[1]),
    }, value)
  }
  if (
    (match = value.match(
      /Uploaded (\d+) Ogg Opus bytes representing (\d+) PCM bytes/,
    ))
  ) {
    return event('lte_upload', 'done', 'Opus recording uploaded over LTE', {
      opusBytes: Number(match[1]),
      pcmBytes: Number(match[2]),
    }, value)
  }
  if ((match = value.match(/Remote transcript: "(.*)"/))) {
    const transcript = match[1]
    return event(
      'transcription',
      hasUsefulSpeech(transcript) ? 'done' : 'failed',
      hasUsefulSpeech(transcript)
        ? 'Cloud speech-to-text returned text'
        : 'Cloud speech-to-text did not recognize speech',
      { transcript },
      value,
    )
  }
  if ((match = value.match(/Transcript queued for Mac job (job_[A-Za-z0-9-]+)/))) {
    return event('cloud_queue', 'done', 'Transcript queued for the Mac bridge', {
      jobId: match[1],
    }, value)
  }
  if ((match = value.match(/Agent reply is not ready; polling again \((\d+)\/(\d+)\)/))) {
    return event('mac_agent', 'active', 'Waiting for Mac agent response', {
      attempt: Number(match[1]),
      maxAttempts: Number(match[2]),
    }, value)
  }
  if ((match = value.match(/(?:Decoded|Downloaded) (\d+) bytes of Mac agent speech PCM/))) {
    return event('reply_download', 'done', 'Reply PCM downloaded to microSD', {
      pcmBytes: Number(match[1]),
    }, value)
  }
  if (
    (match = value.match(
      /Opus decoded (\d+) Ogg bytes to (\d+) PCM bytes \((\d+) samples/,
    ))
  ) {
    return event('reply_download', 'done', 'Reply Opus decoded on the pendant', {
      opusBytes: Number(match[1]),
      pcmBytes: Number(match[2]),
      samples: Number(match[3]),
    }, value)
  }
  if ((match = value.match(/Agent reply download failed: (-?\d+) \(HTTP=(\d+)\)/))) {
    return event('reply_download', 'failed', 'Reply download or PCM decoding failed', {
      result: Number(match[1]),
      httpStatus: Number(match[2]),
    }, value, false, true)
  }
  if ((match = value.match(/Played (\d+) samples of agent speech at (\d+) Hz/))) {
    return event('i2s_playback', 'done', 'Agent reply played over I2S', {
      samples: Number(match[1]),
      sampleRate: Number(match[2]),
      durationMs: Math.round((Number(match[1]) / Number(match[2])) * 1000),
    }, value, false, true)
  }
  if ((match = value.match(/Agent reply I2S playback failed: (-?\d+)/))) {
    return event('i2s_playback', 'failed', 'I2S playback failed', {
      result: Number(match[1]),
    }, value, false, true)
  }
  if (value.includes('Pendant LTE connection ready')) {
    return event('lte_upload', 'active', 'Pendant LTE modem is online', {}, value)
  }
  if (value.includes('Booting nRF Connect SDK')) {
    return event('device', 'active', 'nRF firmware booted', {}, value)
  }
  if ((match = value.match(/Relay HTTP status: (\d+), response bytes: (\d+)/))) {
    return event('cloud_http', 'done', 'Cloud relay returned HTTP response', {
      httpStatus: Number(match[1]),
      responseBytes: Number(match[2]),
    }, value)
  }
  return null
}

export function hasUsefulSpeech(value) {
  return /[\p{L}\p{N}]/u.test(String(value || ''))
}

export function compareTranscript(expected, actual) {
  const expectedWords = words(expected)
  const actualWords = words(actual)
  if (!expectedWords.length) return { matches: true, score: 1 }
  if (!actualWords.length) return { matches: false, score: 0 }
  const actualSet = new Set(actualWords)
  const matched = expectedWords.filter((word) => actualSet.has(word)).length
  const score = matched / expectedWords.length
  return { matches: score >= 0.75, score }
}

export function assessSignal({ meanAbs = 0, peak = 0 }) {
  if (peak === 0) return 'silent'
  if (meanAbs < 120 || peak < 1200) return 'very_low'
  if (meanAbs < 240 || peak < 2400) return 'low'
  if (peak > 32000) return 'clipping'
  return 'usable'
}

export function diagnoseRun(run) {
  const failed = run.events.find((item) => item.status === 'failed')
  const recording = latestEvent(run, 'recording')
  const transcription = latestEvent(run, 'transcription')
  const comparison = compareTranscript(
    run.expectedTranscript,
    transcription?.meta?.transcript,
  )

  if (recording?.status === 'failed') {
    return verdict('recording', 'PDM recording failed before a usable file was captured.', recording)
  }
  if (transcription?.status === 'failed') {
    const quality = recording?.meta?.signalAssessment
    return verdict(
      'transcription',
      `The nRF uploaded audio, but STT returned ${JSON.stringify(transcription.meta.transcript)}. ` +
        `The raw PDM signal was ${quality || 'not measured'} ` +
        `(mean ${recording?.meta?.meanAbs ?? '?'}; peak ${recording?.meta?.peak ?? '?'}).`,
      transcription,
    )
  }
  if (transcription && !comparison.matches) {
    return verdict(
      'transcription',
      `Expected ${JSON.stringify(run.expectedTranscript)} but STT produced ` +
        `${JSON.stringify(transcription.meta.transcript)} (${Math.round(comparison.score * 100)}% word match).`,
      transcription,
    )
  }
  if (failed) {
    return verdict(failed.stage, failed.detail, failed)
  }
  const playback = latestEvent(run, 'i2s_playback')
  if (playback?.status === 'done') {
    return {
      ok: true,
      stage: 'complete',
      summary: 'Recording, cloud processing, Mac agent, reply download, and I2S playback all completed.',
    }
  }
  return {
    ok: null,
    stage: nextMissingStage(run),
    summary: 'Workflow is still in progress.',
  }
}

function event(stage, status, detail, meta, raw, startsRun = false, terminal = false) {
  return { stage, status, detail, meta, raw, startsRun, terminal }
}

function verdict(stage, summary, source) {
  return { ok: false, stage, summary, source }
}

function latestEvent(run, stage) {
  return [...run.events].reverse().find((item) => item.stage === stage)
}

function nextMissingStage(run) {
  const completed = new Set(
    run.events.filter((item) => item.status === 'done').map((item) => item.stage),
  )
  return STAGES.find((stage) => !completed.has(stage)) || 'complete'
}

function words(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []
}

function dbfs(value) {
  if (!value) return null
  return Math.round(20 * Math.log10(value / 32767) * 10) / 10
}

function stripTerminalNoise(value) {
  return String(value || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

function parseArgs(argv) {
  const options = {
    expect: '',
    follow: false,
    replay: '',
    screen: '',
    pollMs: 300,
    timeoutMs: 180000,
    outputDirectory: path.join(
      os.homedir(),
      'AI-Pendant-Workspace',
      'workflow-inspections',
    ),
  }

  for (let index = 0; index < argv.length; ++index) {
    const value = argv[index]
    if (value === '--expect') options.expect = argv[++index] || ''
    else if (value === '--follow') options.follow = true
    else if (value === '--replay') options.replay = argv[++index] || ''
    else if (value === '--screen') options.screen = argv[++index] || ''
    else if (value === '--poll-ms') options.pollMs = Number(argv[++index] || 300)
    else if (value === '--timeout') options.timeoutMs = Number(argv[++index] || 180) * 1000
    else if (value === '--output') options.outputDirectory = path.resolve(argv[++index] || '.')
    else if (value === '--help' || value === '-h') options.help = true
    else throw new Error(`Unknown option: ${value}`)
  }
  return options
}

class Inspector {
  constructor(options) {
    this.options = options
    this.runNumber = 0
    this.run = null
    this.previousHardcopy = ''
    this.lastJobState = ''
    this.finished = false
    this.startedAt = Date.now()
    this.outputPath = ''
    this.summaryPath = ''
    this.pollTimer = null
  }

  startRun() {
    if (this.run && !this.run.finishedAt) {
      this.finishRun('A new recording started before the previous run reached playback.')
    }
    this.runNumber += 1
    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    fs.mkdirSync(this.options.outputDirectory, { recursive: true })
    this.outputPath = path.join(
      this.options.outputDirectory,
      `${timestamp}-run-${this.runNumber}.jsonl`,
    )
    this.summaryPath = this.outputPath.replace(/\.jsonl$/, '.summary.json')
    this.run = {
      id: `observed-${Date.now()}-${this.runNumber}`,
      expectedTranscript: this.options.expect,
      events: [],
      startedAt: new Date().toISOString(),
      jobId: '',
      finishedAt: null,
    }
    this.lastJobState = ''
    this.print('active', 'RUN', `Recording run ${this.runNumber} detected`)
    this.write({ type: 'run_started', runId: this.run.id, expected: this.options.expect })
  }

  acceptSerial(parsed) {
    const hasActiveRecording = Boolean(
      this.run &&
      !this.run.finishedAt &&
      this.run.events.some(
        (item) => item.stage === 'recording' && item.status === 'active',
      ),
    )
    if (
      (parsed.startsRun && !hasActiveRecording) ||
      (!this.run && parsed.stage !== 'device' && parsed.stage !== 'lte_upload')
    ) {
      this.startRun()
    }
    if (!this.run) {
      this.print(parsed.status, 'nRF', parsed.detail, parsed.meta)
      return
    }

    const item = {
      at: new Date().toISOString(),
      source: 'nrf_serial',
      ...parsed,
    }
    this.run.events.push(item)
    if (parsed.meta?.jobId) this.run.jobId = parsed.meta.jobId
    this.print(parsed.status, stageLabel(parsed.stage), parsed.detail, parsed.meta)
    this.write(item)

    if (parsed.stage === 'transcription') {
      const comparison = compareTranscript(
        this.options.expect,
        parsed.meta?.transcript,
      )
      if (!comparison.matches) {
        this.print(
          'failed',
          'EXPECTED',
          `${JSON.stringify(this.options.expect)} != ${JSON.stringify(parsed.meta?.transcript)}`,
        )
      }
    }

    if (parsed.terminal) this.finishRun()
  }

  async pollJob() {
    if (
      !this.run?.jobId ||
      this.run.finishedAt ||
      !process.env.RELAY_URL ||
      !process.env.RELAY_API_KEY
    ) return
    try {
      const response = await fetch(
        `${process.env.RELAY_URL.replace(/\/$/, '')}/v1/mac/jobs/${encodeURIComponent(this.run.jobId)}`,
        {
          headers: { Authorization: `Bearer ${process.env.RELAY_API_KEY}` },
          signal: AbortSignal.timeout(10000),
        },
      )
      if (!response.ok) return
      const payload = await response.json()
      const job = payload.job
      if (!job) return
      const state = JSON.stringify({
        status: job.status,
        error: job.error,
        updatedAt: job.updatedAt,
        deviceEvents: job.deviceEvents?.length,
      })
      if (state === this.lastJobState) return
      this.lastJobState = state
      this.write({
        type: 'cloud_job',
        at: new Date().toISOString(),
        jobId: job.jobId,
        status: job.status,
        error: job.error || null,
        deviceEvents: job.deviceEvents || [],
      })
      this.print(job.error ? 'failed' : job.status === 'queued' ? 'active' : 'done', 'CLOUD JOB', job.status)

      const result = job.result
      if (result) {
        this.upsertObservedEvent('mac_agent', result.error ? 'failed' : 'done', 'Mac agent response ready', {
          response: result.response || result.summary || '',
          planner: result.planner || null,
          localJobId: result.jobId || null,
        })
        if (result.pendantSpeech) {
          this.upsertObservedEvent('tts', 'done', 'Mac TTS rendered reply PCM', {
            pcmBytes: result.pendantSpeech.pcmBytes,
            sampleRate: result.pendantSpeech.sampleRate,
            format: result.pendantSpeech.format,
          })
        }
      }
      for (const deviceEvent of job.deviceEvents || []) {
        this.upsertObservedEvent(
          deviceEvent.stage,
          deviceEvent.status,
          deviceEvent.label || deviceEvent.detail || deviceEvent.stage,
          deviceEvent.meta || {},
          `device-${deviceEvent.eventId || deviceEvent.at || deviceEvent.stage}`,
        )
      }
    } catch (error) {
      this.write({ type: 'poll_error', at: new Date().toISOString(), error: error.message })
    }
  }

  upsertObservedEvent(stage, status, detail, meta, stableId = `${stage}-${status}`) {
    if (!this.run || this.run.events.some((item) => item.stableId === stableId)) return
    const item = {
      stableId,
      at: new Date().toISOString(),
      source: 'cloud_job',
      stage,
      status,
      detail,
      meta,
    }
    this.run.events.push(item)
    this.print(status, stageLabel(stage), detail, meta)
    this.write(item)
  }

  finishRun(forcedSummary = '') {
    if (!this.run || this.run.finishedAt) return
    this.run.finishedAt = new Date().toISOString()
    const diagnosis = forcedSummary
      ? { ok: false, stage: nextMissingStage(this.run), summary: forcedSummary }
      : diagnoseRun(this.run)
    const status = diagnosis.ok === true ? 'done' : diagnosis.ok === false ? 'failed' : 'warning'
    this.print(status, 'VERDICT', `${diagnosis.stage}: ${diagnosis.summary}`)
    const summary = { ...this.run, diagnosis }
    fs.writeFileSync(this.summaryPath, JSON.stringify(summary, null, 2))
    this.write({ type: 'run_finished', diagnosis, summaryPath: this.summaryPath })
    this.print('muted', 'REPORT', this.summaryPath)
    if (!this.options.follow) this.finished = true
  }

  write(payload) {
    if (!this.outputPath) return
    fs.appendFileSync(
      this.outputPath,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), ...payload })}\n`,
    )
  }

  print(status, label, detail, meta = null) {
    const color = USE_COLOR ? COLORS[status] || '' : ''
    const reset = USE_COLOR ? COLORS.reset : ''
    const clock = new Date().toLocaleTimeString()
    const compactMeta = meta && Object.keys(meta).length ? ` ${formatMeta(meta)}` : ''
    console.log(`${color}${clock}  ${label.padEnd(14)} ${detail}${compactMeta}${reset}`)
  }
}

async function runReplay(options) {
  const inspector = new Inspector({ ...options, follow: true })
  const lines = fs.readFileSync(options.replay, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const parsed = parseSerialLine(line)
    if (parsed) inspector.acceptSerial(parsed)
  }
  if (inspector.run && !inspector.run.finishedAt) inspector.finishRun()
}

async function runLive(options) {
  const inspector = new Inspector(options)
  const screenSession = options.screen || findScreenSession()
  if (!screenSession) {
    throw new Error('No screen session is connected to the nRF serial console. Pass --screen <session>.')
  }
  const hardcopyPath = path.join(os.tmpdir(), `pendant-workflow-${process.pid}.log`)
  inspector.previousHardcopy = captureScreen(screenSession, hardcopyPath)

  console.log(`Inspecting nRF screen session ${screenSession}`)
  console.log(`Expected phrase: ${options.expect ? JSON.stringify(options.expect) : '(not specified)'}`)
  console.log(`Reports: ${options.outputDirectory}`)
  console.log('Ready for the next button-to-record cycle. Press Ctrl+C to stop.\n')

  while (!inspector.finished) {
    const current = captureScreen(screenSession, hardcopyPath)
    const appended = appendedText(inspector.previousHardcopy, current)
    inspector.previousHardcopy = current
    for (const line of appended.split(/\r?\n/)) {
      const parsed = parseSerialLine(line)
      if (parsed) inspector.acceptSerial(parsed)
    }
    await inspector.pollJob()

    if (
      inspector.run &&
      !inspector.run.finishedAt &&
      Date.now() - new Date(inspector.run.startedAt).getTime() > options.timeoutMs
    ) {
      inspector.finishRun(`Timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`)
    }
    await delay(options.pollMs)
  }
}

function findScreenSession() {
  let output = ''
  try {
    output = execFileSync('screen', ['-ls'], { encoding: 'utf8' })
  } catch (error) {
    // GNU screen returns status 1 even when it successfully lists sessions.
    output = String(error.stdout || '')
    if (!output) throw error
  }
  const sessions = [...output.matchAll(/^\s*(\d+\.[^\s]+)\s+\((?:Detached|Attached)\)/gm)]
  return sessions[0]?.[1] || ''
}

function captureScreen(session, outputPath) {
  fs.rmSync(outputPath, { force: true })
  execFileSync('screen', ['-S', session, '-X', 'hardcopy', '-h', outputPath])
  return fs.readFileSync(outputPath, 'utf8')
}

export function appendedText(previous, current) {
  if (!previous) return current
  if (current.startsWith(previous)) return current.slice(previous.length)

  const previousLines = previous.split(/\r?\n/)
  const currentLines = current.split(/\r?\n/)
  const maximum = Math.min(previousLines.length, currentLines.length, 300)
  for (let overlap = maximum; overlap > 0; --overlap) {
    const tail = previousLines.slice(-overlap).join('\n')
    const head = currentLines.slice(0, overlap).join('\n')
    if (tail === head) return currentLines.slice(overlap).join('\n')
  }
  return current
}

function formatMeta(meta) {
  const allowed = Object.entries(meta)
    .filter(([key, value]) => value != null && !/jobId|localJobId/.test(key))
    .slice(0, 8)
  return allowed.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')
}

function stageLabel(stage) {
  return String(stage || '').replaceAll('_', ' ').toUpperCase()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printHelp() {
  console.log(`Usage: npm run inspect:workflow -- [options]\n\nOptions:\n  --expect "open Outlook"  Compare the transcript with the spoken phrase\n  --follow                 Keep inspecting subsequent recordings\n  --screen <session>       Use a specific screen serial session\n  --timeout <seconds>      Per-run timeout (default: 180)\n  --replay <log>           Parse an existing nRF serial hardcopy\n  --output <directory>     Report directory\n`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) printHelp()
    else if (options.replay) await runReplay(options)
    else await runLive(options)
  } catch (error) {
    console.error(`[workflow-inspector] ${error.message}`)
    process.exitCode = 1
  }
}
