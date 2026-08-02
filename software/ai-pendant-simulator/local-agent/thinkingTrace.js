import fs from 'node:fs'
import path from 'node:path'
import { workspacePath } from './config.js'

const tracesPath = path.join(workspacePath, 'pendant-thinking.json')
const MAX_TRACES = 40
const MAX_CHUNKS_PER_STEP = 120
const listeners = new Set()

export function tracesLocation() {
  ensureStore()
  return tracesPath
}

export function readTraces() {
  ensureStore()
  try {
    return JSON.parse(fs.readFileSync(tracesPath, 'utf8'))
  } catch {
    return []
  }
}

export function getTrace(traceId) {
  return readTraces().find((trace) => trace.traceId === traceId) ?? null
}

export function onThinkingChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function startThinkingTrace({
  command,
  sessionId = null,
  source = 'local',
  kind = 'plan',
}) {
  const now = new Date().toISOString()
  const trace = {
    traceId: `think_${crypto.randomUUID()}`,
    kind,
    command: String(command ?? ''),
    sessionId,
    source,
    status: 'thinking',
    steps: [],
    createdAt: now,
    updatedAt: now,
  }
  writeTraces([trace, ...readTraces()].slice(0, MAX_TRACES))
  return trace
}

export function addThinkingStep(
  traceId,
  {
    id,
    label,
    detail = '',
    status = 'done',
    streamText = undefined,
    chunks = undefined,
    meta = undefined,
  },
) {
  const traces = readTraces()
  const trace = traces.find((item) => item.traceId === traceId)
  if (!trace) return null

  const now = new Date().toISOString()
  const existing = trace.steps.find((step) => step.id === id)
  if (existing) {
    existing.label = label
    existing.detail = detail
    existing.status = status
    existing.updatedAt = now
    if (streamText !== undefined) {
      existing.streamText = streamText
    }
    if (chunks !== undefined) {
      existing.chunks = chunks
    }
    if (meta !== undefined) {
      existing.meta = meta
    }
  } else {
    trace.steps.push({
      id,
      label,
      detail,
      status,
      streamText: streamText ?? '',
      chunks: Array.isArray(chunks) ? chunks : [],
      meta: meta ?? null,
      createdAt: now,
      updatedAt: now,
    })
  }

  trace.updatedAt = now
  if (status === 'active' || trace.status === 'thinking') {
    trace.status =
      status === 'done' && trace.steps.every((step) => step.status !== 'active')
        ? trace.status
        : 'thinking'
  }
  if (status === 'active') {
    trace.status = 'thinking'
  }
  writeTraces(traces)
  return trace
}

/**
 * Append a fine-grained streaming chunk under an existing (or new) step.
 * Used for live LLM draft tokens / discoveries on the ops dashboard.
 */
export function appendThinkingChunk(
  traceId,
  {
    stepId,
    label = 'Thinking through the steps',
    text = '',
    phase = 'stream',
    streamText = undefined,
    detail = undefined,
    status = 'active',
    meta = undefined,
  },
) {
  const traces = readTraces()
  const trace = traces.find((item) => item.traceId === traceId)
  if (!trace) return null

  const now = new Date().toISOString()
  let step = trace.steps.find((item) => item.id === stepId)
  if (!step) {
    step = {
      id: stepId,
      label,
      detail: detail ?? '',
      status,
      streamText: '',
      chunks: [],
      meta: null,
      createdAt: now,
      updatedAt: now,
    }
    trace.steps.push(step)
  }

  const chunkText = String(text || '').trim()
  if (chunkText) {
    const chunks = Array.isArray(step.chunks) ? step.chunks : []
    const last = chunks[chunks.length - 1]
    // Merge tiny back-to-back deltas into the same chunk line.
    if (
      last &&
      last.phase === phase &&
      Date.parse(now) - Date.parse(last.at) < 90 &&
      chunkText.length < 48
    ) {
      last.text = `${last.text}${chunkText}`.slice(-400)
      last.at = now
    } else {
      chunks.push({
        id: `chk_${crypto.randomUUID().slice(0, 8)}`,
        phase,
        text: chunkText.slice(0, 400),
        at: now,
      })
    }
    step.chunks = chunks.slice(-MAX_CHUNKS_PER_STEP)
  }

  if (streamText !== undefined) {
    step.streamText = String(streamText)
  }
  if (detail !== undefined) {
    step.detail = detail
  }
  if (label) {
    step.label = label
  }
  if (meta !== undefined) {
    step.meta = meta
  }
  step.status = status
  step.updatedAt = now
  trace.status = status === 'active' ? 'thinking' : trace.status
  trace.updatedAt = now
  writeTraces(traces)
  return trace
}

export function finishThinkingTrace(traceId, { status = 'done', summary = '' } = {}) {
  const traces = readTraces()
  const trace = traces.find((item) => item.traceId === traceId)
  if (!trace) return null

  trace.steps = trace.steps.map((step) =>
    step.status === 'active'
      ? { ...step, status: 'done', updatedAt: new Date().toISOString() }
      : step,
  )
  trace.status = status
  trace.summary = summary
  trace.updatedAt = new Date().toISOString()
  writeTraces(traces)
  return trace
}

function ensureStore() {
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true })
  }
  if (!fs.existsSync(tracesPath)) {
    fs.writeFileSync(tracesPath, '[]')
  }
}

function writeTraces(traces) {
  ensureStore()
  fs.writeFileSync(tracesPath, JSON.stringify(traces, null, 2))
  for (const listener of listeners) {
    try {
      listener(traces)
    } catch {
      // never break writers because a dashboard listener failed
    }
  }
}
