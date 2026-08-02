import fs from 'node:fs'
import path from 'node:path'
import { workspacePath } from './config.js'

const pipelinePath = path.join(workspacePath, 'pendant-pipeline.json')
const MAX_RUNS = 80
const MAX_EVENTS_PER_RUN = 80
const listeners = new Set()

export function pipelineLocation() {
  ensureStore()
  return pipelinePath
}

export function readPipelineRuns() {
  ensureStore()
  try {
    const value = JSON.parse(fs.readFileSync(pipelinePath, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function onPipelineChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function recordPipelineEvent({
  pipelineId,
  stage,
  status = 'done',
  label = '',
  detail = '',
  text = '',
  source = 'mac',
  kind = 'voice_command',
  command = '',
  sessionId = null,
  meta = null,
  at = null,
}) {
  const id = String(pipelineId || '').trim()
  const eventStage = String(stage || '').trim()

  if (!id) {
    throw new Error('pipelineId is required.')
  }
  if (!eventStage) {
    throw new Error('pipeline stage is required.')
  }

  const timestamp = normalizeTimestamp(at)
  const runs = readPipelineRuns()
  let run = runs.find((item) => item.pipelineId === id)

  if (!run) {
    run = {
      pipelineId: id,
      kind: String(kind || 'voice_command'),
      command: cleanText(command, 4000),
      sessionId: sessionId ? cleanText(sessionId, 240) : null,
      source: cleanText(source, 80) || 'mac',
      status: 'processing',
      events: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    runs.unshift(run)
  }

  if (command && !run.command) {
    run.command = cleanText(command, 4000)
  }
  if (sessionId && !run.sessionId) {
    run.sessionId = cleanText(sessionId, 240)
  }

  const event = {
    eventId: `pipe_evt_${crypto.randomUUID()}`,
    stage: eventStage,
    status: normalizeEventStatus(status),
    label: cleanText(label || eventStage, 240),
    detail: cleanText(detail, 4000),
    text: cleanText(text, 12000),
    source: cleanText(source, 80) || 'mac',
    meta: sanitizeMeta(meta),
    at: timestamp,
  }

  run.events = [...(Array.isArray(run.events) ? run.events : []), event].slice(
    -MAX_EVENTS_PER_RUN,
  )
  run.updatedAt = timestamp
  run.status = deriveRunStatus(run.events)

  const nextRuns = [
    run,
    ...runs.filter((item) => item.pipelineId !== id),
  ].slice(0, MAX_RUNS)
  writeRuns(nextRuns)
  return run
}

export function clearPipelineRuns() {
  writeRuns([])
  return []
}

function normalizeTimestamp(value) {
  const parsed = value ? new Date(value) : new Date()
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString()
}

function normalizeEventStatus(value) {
  const status = String(value || '').toLowerCase()
  if (status === 'active' || status === 'processing') return 'active'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'waiting' || status === 'queued') return 'waiting'
  return 'done'
}

function deriveRunStatus(events) {
  const latest = events[events.length - 1]
  if (!latest) return 'processing'
  if (latest.status === 'failed') return 'failed'
  const devicePlayback = [...events]
    .reverse()
    .find((event) => event.stage === 'device_playback')
  if (devicePlayback?.status === 'failed') return 'failed'
  if (devicePlayback?.status === 'done') return 'completed'
  if (
    latest.stage === 'relay_result' &&
    latest.status === 'done' &&
    !expectsPendantTelemetry(events)
  ) {
    return 'completed'
  }
  return 'processing'
}

function expectsPendantTelemetry(events) {
  const transcription = events.find(
    (event) => event.stage === 'transcription',
  )
  const telemetry = transcription?.meta?.inputTelemetry
  return (
    telemetry &&
    typeof telemetry === 'object' &&
    String(telemetry.storage || '').toLowerCase() === 'microsd'
  )
}

function cleanText(value, maxLength) {
  return String(value ?? '').split('\u0000').join('').slice(0, maxLength)
}

function sanitizeMeta(value, depth = 0) {
  if (value == null || depth > 4) return null
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return cleanText(value, 1000)
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => sanitizeMeta(item, depth + 1))
  }
  if (typeof value !== 'object') return cleanText(value, 1000)

  const result = {}
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (/base64|authorization|api.?key|token|secret|password/i.test(key)) {
      continue
    }
    result[cleanText(key, 120)] = sanitizeMeta(item, depth + 1)
  }
  return result
}

function ensureStore() {
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true })
  }
  if (!fs.existsSync(pipelinePath)) {
    fs.writeFileSync(pipelinePath, '[]')
  }
}

function writeRuns(runs) {
  ensureStore()
  fs.writeFileSync(pipelinePath, JSON.stringify(runs, null, 2))
  for (const listener of listeners) {
    try {
      listener(runs)
    } catch {
      // A disconnected dashboard must never break the pipeline.
    }
  }
}
