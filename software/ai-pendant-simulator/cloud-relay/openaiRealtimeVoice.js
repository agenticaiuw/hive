/**
 * OpenAI Realtime voice front-door for the pendant.
 * Model: gpt-realtime-2.1 (or OPENAI_REALTIME_MODEL).
 *
 * Mid-press streaming: open a session as soon as the HTTP body starts, append
 * PCM while the pendant is still uploading, commit only when the body ends.
 * That is the latency win vs buffering the full clip then planning.
 *
 * Tools: web_search, mac_run_actions, mac_delegate; plain text for Q&A.
 * Docs: https://developers.openai.com/api/docs/guides/realtime-websocket
 */

import { OPENAI_API_BASE_URL } from './config.js'

export const REALTIME_PCM_RATE = 24000
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1'
const SESSION_TIMEOUT_MS = 60_000

function openaiApiKey() {
  return String(
    process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '',
  ).trim()
}

function realtimeModel() {
  return (
    String(process.env.OPENAI_REALTIME_MODEL || '').trim() ||
    DEFAULT_REALTIME_MODEL
  )
}

function realtimeWsUrl() {
  const httpBase = String(
    process.env.OPENAI_API_BASE_URL || OPENAI_API_BASE_URL || '',
  )
    .replace(/\/$/, '')
    .trim() || 'https://api.openai.com/v1'
  const wsBase = httpBase.replace(/^http/i, 'ws')
  return `${wsBase}/realtime?model=${encodeURIComponent(realtimeModel())}`
}

const VOICE_AGENT_INSTRUCTIONS = `You are the voice agent for a wearable AI pendant that controls a Mac and answers questions.

The user is speaking a short command or question (audio may still be arriving). Decide from the audio alone (no keyword tables on the client).

Use tools when needed:
- web_search: current facts, news, weather, sports, "look up X", anything needing the live web.
- mac_run_actions: simple, concrete Mac control you can express as 1–3 actions (open_app with params.appName, open_url with params.url, etc.). Never invent params.name — use appName.
- mac_delegate: multi-step or ambiguous Mac work the local Mac agent should plan (research+file, multi-app workflows, "set up my morning", etc.).

When the user only wants a spoken answer (definitions, translations, math, short facts you know confidently), do NOT call a tool — reply with a short plain-language answer (1–3 sentences).

After tools return results, give a brief final user-facing reply when helpful.
Prefer the correct tool over guessing. Do not claim you opened apps or searched if you did not call the tool.`

export const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'web_search',
    description:
      'Search the public web for up-to-date information (news, weather, facts, lookups).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query derived from the user speech.',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'mac_run_actions',
    description:
      'Run a small set of concrete Mac control actions (open apps/URLs, simple control).',
    parameters: {
      type: 'object',
      properties: {
        transcript: {
          type: 'string',
          description: 'Faithful short transcript of what the user said.',
        },
        spoken_reply: {
          type: 'string',
          description: 'Optional short confirmation the pendant can speak.',
        },
        actions: {
          type: 'array',
          description: 'Usually 1–3 Mac tool actions.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                description: 'Action type, e.g. open_app, open_url.',
              },
              label: { type: 'string' },
              params: {
                type: 'object',
                description:
                  'Action params. open_app requires appName; open_url requires url.',
              },
            },
            required: ['type'],
          },
        },
      },
      required: ['transcript', 'actions'],
    },
  },
  {
    type: 'function',
    name: 'mac_delegate',
    description:
      'Hand a complex multi-step Mac task to the local Mac agent for full planning.',
    parameters: {
      type: 'object',
      properties: {
        transcript: {
          type: 'string',
          description: 'Faithful transcript of the request.',
        },
        goal: {
          type: 'string',
          description: 'Clear goal statement for the Mac agent.',
        },
      },
      required: ['transcript', 'goal'],
    },
  },
]

/**
 * Extract s16le PCM from a WAV buffer (or return raw if already PCM).
 */
export function extractPcmFromWavOrPcm(audioBuffer, format) {
  const buf = Buffer.isBuffer(audioBuffer)
    ? audioBuffer
    : Buffer.from(audioBuffer || [])
  const fmt = String(format || '').toLowerCase()
  if (
    fmt === 'pcm' ||
    fmt === 's16le' ||
    fmt === 'pcm-s16le' ||
    fmt === 'raw' ||
    fmt === 'l16'
  ) {
    return { pcm: buf, sampleRate: null }
  }
  if (buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const sampleRate = buf.readUInt32LE(24)
    let dataOffset = 44
    if (buf.toString('ascii', 36, 40) !== 'data') {
      let offset = 12
      while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4)
        const size = buf.readUInt32LE(offset + 4)
        if (id === 'data') {
          dataOffset = offset + 8
          break
        }
        offset += 8 + size
      }
    }
    return { pcm: buf.subarray(dataOffset), sampleRate }
  }
  return { pcm: buf, sampleRate: null }
}

/** Linear resample Int16 mono PCM between sample rates (batch). */
export function resamplePcmS16le(pcmBuffer, fromRate, toRate) {
  const from = Number(fromRate) || toRate
  const to = Number(toRate) || from
  if (!pcmBuffer?.length || from === to) {
    return Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || [])
  }
  const input = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.length / 2),
  )
  const outLen = Math.max(1, Math.floor((input.length * to) / from))
  const output = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = (i * from) / to
    const j = Math.floor(src)
    const frac = src - j
    const a = input[j] || 0
    const b = input[Math.min(j + 1, input.length - 1)] || 0
    output[i] = (a + (b - a) * frac) | 0
  }
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength)
}

/**
 * Online s16le mono resampler for mid-press streaming.
 * Accepts arbitrary byte chunks (handles odd leftover bytes).
 */
export class StreamingPcmResampler {
  constructor(fromRate, toRate = REALTIME_PCM_RATE) {
    this.fromRate = Number(fromRate) > 0 ? Number(fromRate) : toRate
    this.toRate = Number(toRate) > 0 ? Number(toRate) : REALTIME_PCM_RATE
    this.byteCarry = Buffer.alloc(0)
    this.samples = []
    this.readPos = 0 // fractional index into samples[]
  }

  push(chunk) {
    if (!chunk?.length) return Buffer.alloc(0)
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (this.byteCarry.length) {
      buf = Buffer.concat([this.byteCarry, buf])
      this.byteCarry = Buffer.alloc(0)
    }
    if (buf.length % 2 === 1) {
      this.byteCarry = buf.subarray(buf.length - 1)
      buf = buf.subarray(0, buf.length - 1)
    }
    if (!buf.length) return Buffer.alloc(0)

    for (let i = 0; i < buf.length; i += 2) {
      this.samples.push(buf.readInt16LE(i))
    }

    if (this.fromRate === this.toRate) {
      const out = Buffer.alloc(this.samples.length * 2)
      for (let i = 0; i < this.samples.length; i++) {
        out.writeInt16LE(this.samples[i], i * 2)
      }
      this.samples = []
      this.readPos = 0
      return out
    }

    const outSamples = []
    const step = this.fromRate / this.toRate
    while (this.readPos + 1 < this.samples.length) {
      const j = Math.floor(this.readPos)
      const frac = this.readPos - j
      const a = this.samples[j]
      const b = this.samples[j + 1]
      outSamples.push((a + (b - a) * frac) | 0)
      this.readPos += step
    }
    // Drop fully consumed input samples; keep one for interpolation.
    const drop = Math.max(0, Math.floor(this.readPos) - 1)
    if (drop > 0) {
      this.samples = this.samples.slice(drop)
      this.readPos -= drop
    }

    const out = Buffer.alloc(outSamples.length * 2)
    for (let i = 0; i < outSamples.length; i++) {
      out.writeInt16LE(outSamples[i], i * 2)
    }
    return out
  }

  flush() {
    if (this.fromRate === this.toRate) {
      if (!this.samples.length) return Buffer.alloc(0)
      const out = Buffer.alloc(this.samples.length * 2)
      for (let i = 0; i < this.samples.length; i++) {
        out.writeInt16LE(this.samples[i], i * 2)
      }
      this.samples = []
      return out
    }
    // Emit remaining by holding last sample.
    if (!this.samples.length) return Buffer.alloc(0)
    const last = this.samples[this.samples.length - 1]
    this.samples.push(last)
    const out = this.push(Buffer.alloc(0))
    this.samples = []
    this.readPos = 0
    this.byteCarry = Buffer.alloc(0)
    return out
  }
}

function normalizeActions(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((a) => a && typeof a === 'object')
    .map((action) => {
      const type = String(action.type || '').trim()
      const params =
        action.params && typeof action.params === 'object'
          ? { ...action.params }
          : {}
      if (type === 'open_app') {
        const appName = String(
          params.appName || params.name || params.app || '',
        ).trim()
        if (appName) params.appName = appName
        delete params.name
        delete params.app
      }
      return {
        type,
        label: String(action.label || type || '').trim() || undefined,
        params,
      }
    })
    .filter((a) => a.type)
}

async function runWebSearch(query) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'empty query' }

  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    })
    const payload = await response.json().catch(() => ({}))
    const abstract = String(payload.AbstractText || '').trim()
    const answer = String(payload.Answer || '').trim()
    const heading = String(payload.Heading || '').trim()
    const related = Array.isArray(payload.RelatedTopics)
      ? payload.RelatedTopics.map((t) => String(t?.Text || '').trim())
          .filter(Boolean)
          .slice(0, 5)
      : []
    const summary =
      abstract ||
      answer ||
      (related.length ? related.join(' · ') : '') ||
      'No concise instant answer found. Try rephrasing.'
    return {
      ok: true,
      query: q,
      heading: heading || undefined,
      summary,
      related,
      source: 'duckduckgo-instant',
    }
  } catch (error) {
    return {
      ok: false,
      query: q,
      error: error?.message || 'web search failed',
    }
  }
}

function openRealtimeSocket(url, apiKey) {
  return import('ws').then(
    ({ default: WS }) =>
      new Promise((resolve, reject) => {
        const socket = new WS(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        const timer = setTimeout(() => {
          try {
            socket.terminate?.()
          } catch {
            /* ignore */
          }
          reject(new Error('Realtime WebSocket open timeout.'))
        }, 12_000)
        socket.once('open', () => {
          clearTimeout(timer)
          resolve(socket)
        })
        socket.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      }),
  )
}

function buildPlanResult(state, startedAt, language) {
  const text =
    String(state.transcript || '').trim() ||
    String(state.response || '').trim() ||
    'voice command'
  const spoken =
    String(state.response || '').trim() ||
    (state.actions.length
      ? undefined
      : String(state.textParts.join('')).trim() || undefined)

  let status = state.status
  if (state.delegate || state.actions.length) status = 'ready'
  else if (spoken) status = 'instant'

  return {
    text,
    model: realtimeModel(),
    language: language || null,
    status,
    response: spoken,
    actions: state.actions,
    durationMs: Date.now() - startedAt,
    source: 'audio-native-realtime',
    toolsUsed: state.toolsUsed,
    passes: 1,
    planner: 'audio-native',
    requireLocalPlanner: Boolean(state.delegate && !state.actions.length),
    midPressStreamed: Boolean(state.midPressStreamed),
  }
}

/**
 * Streaming Realtime session: open ASAP, append PCM while body arrives, finish on end.
 *
 * @param {object} opts
 * @param {number} [opts.inputSampleRate=15625]
 * @param {string|null} [opts.language]
 * @param {(plan: object) => void|Promise<void>} [opts.onEarlyPlan] - fire when Mac tools resolve
 */
export async function createStreamingRealtimeSession({
  inputSampleRate = 15625,
  language = null,
  onEarlyPlan = null,
} = {}) {
  const apiKey = openaiApiKey()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for Realtime voice agent.')
  }

  const startedAt = Date.now()
  const languageHint = language ? ` Spoken language hint: ${language}.` : ''
  const resampler = new StreamingPcmResampler(inputSampleRate, REALTIME_PCM_RATE)
  const socket = await openRealtimeSocket(realtimeWsUrl(), apiKey)

  const state = {
    transcript: '',
    textParts: [],
    actions: [],
    status: 'instant',
    response: undefined,
    toolsUsed: [],
    delegate: false,
    closed: false,
    finished: false,
    committed: false,
    midPressStreamed: false,
    bytesIn: 0,
    bytesToModel: 0,
  }

  let settle
  const resultPromise = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })

  const timeout = setTimeout(() => {
    if (state.finished) return
    state.finished = true
    cleanup()
    settle.reject(new Error('Realtime voice agent timed out.'))
  }, SESSION_TIMEOUT_MS)

  function cleanup() {
    clearTimeout(timeout)
    if (!state.closed) {
      state.closed = true
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    }
  }

  function finishOk() {
    if (state.finished) return
    state.finished = true
    const plan = buildPlanResult(state, startedAt, language)
    cleanup()
    settle.resolve(plan)
    if (typeof onEarlyPlan === 'function' && (plan.actions?.length || plan.requireLocalPlanner)) {
      // Already finished; onEarlyPlan may have run from tools. Safe no-op if used.
    }
  }

  function finishErr(error) {
    if (state.finished) return
    state.finished = true
    cleanup()
    settle.reject(error instanceof Error ? error : new Error(String(error)))
  }

  function send(event) {
    if (state.closed || socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(event))
  }

  async function handleFunctionCall(name, callId, argsJson) {
    let args = {}
    try {
      args = JSON.parse(argsJson || '{}')
    } catch {
      args = {}
    }
    state.toolsUsed.push(name)

    if (name === 'web_search') {
      const output = await runWebSearch(args.query)
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(output),
        },
      })
      send({
        type: 'response.create',
        response: { output_modalities: ['text'] },
      })
      return
    }

    if (name === 'mac_run_actions') {
      state.transcript =
        String(args.transcript || state.transcript || '').trim() ||
        state.transcript
      state.response =
        String(args.spoken_reply || args.response || '').trim() || undefined
      state.actions = normalizeActions(args.actions)
      state.status = state.actions.length ? 'ready' : 'instant'
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({
            ok: true,
            queued: true,
            actionCount: state.actions.length,
          }),
        },
      })
      const plan = buildPlanResult(state, startedAt, language)
      if (typeof onEarlyPlan === 'function') {
        try {
          await onEarlyPlan(plan)
        } catch (error) {
          console.warn(
            `[realtime] onEarlyPlan failed: ${error?.message || error}`,
          )
        }
      }
      finishOk()
      return
    }

    if (name === 'mac_delegate') {
      state.transcript =
        String(args.transcript || state.transcript || '').trim() ||
        state.transcript
      state.response =
        String(args.goal || '').trim() || 'Working on that on your Mac.'
      state.actions = []
      state.delegate = true
      state.status = 'ready'
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ ok: true, delegated: true }),
        },
      })
      const plan = buildPlanResult(state, startedAt, language)
      if (typeof onEarlyPlan === 'function') {
        try {
          await onEarlyPlan(plan)
        } catch (error) {
          console.warn(
            `[realtime] onEarlyPlan failed: ${error?.message || error}`,
          )
        }
      }
      finishOk()
      return
    }

    send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }),
      },
    })
    send({
      type: 'response.create',
      response: { output_modalities: ['text'] },
    })
  }

  socket.on('message', (raw) => {
    let event
    try {
      event = JSON.parse(String(raw))
    } catch {
      return
    }

    if (event.type === 'error') {
      finishErr(
        new Error(
          event.error?.message || event.message || 'Realtime API error',
        ),
      )
      return
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const t = String(event.transcript || '').trim()
      if (t) state.transcript = t
    }

    if (
      event.type === 'response.output_text.delta' ||
      event.type === 'response.text.delta'
    ) {
      const delta = event.delta || event.text || ''
      if (delta) state.textParts.push(delta)
    }

    if (
      event.type === 'response.output_text.done' ||
      event.type === 'response.text.done'
    ) {
      const text = String(event.text || state.textParts.join('')).trim()
      if (text) state.response = text
    }

    if (event.type === 'response.function_call_arguments.done') {
      const name = event.name
      const callId = event.call_id
      const args = event.arguments
      if (name && callId) {
        void handleFunctionCall(name, callId, args).catch((error) => {
          finishErr(error)
        })
      }
    }

    if (event.type === 'response.done') {
      const status = event.response?.status
      const output = event.response?.output || []
      const hasFunctionCall = output.some(
        (item) => item?.type === 'function_call',
      )
      if (!hasFunctionCall && status === 'completed') {
        if (!state.response) {
          state.response = String(state.textParts.join('')).trim() || undefined
        }
        if (!state.transcript && state.response) {
          state.transcript = state.response.slice(0, 120)
        }
        state.status =
          state.actions.length || state.delegate ? 'ready' : 'instant'
        finishOk()
      }
    }
  })

  socket.on('error', (error) => finishErr(error))
  socket.on('close', () => {
    if (state.finished) return
    state.closed = true
    clearTimeout(timeout)
    if (state.transcript || state.response || state.actions.length) {
      finishOk()
    } else {
      finishErr(new Error('Realtime WebSocket closed early.'))
    }
  })

  send({
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: `${VOICE_AGENT_INSTRUCTIONS}${languageHint}`,
      output_modalities: ['text'],
      tools: REALTIME_TOOLS,
      tool_choice: 'auto',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: REALTIME_PCM_RATE },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: null,
        },
      },
    },
  })

  return {
    /** Append raw source-rate s16le PCM from the pendant (mid-press). */
    appendRawPcm(chunk) {
      if (state.finished || state.committed) return
      if (!chunk?.length) return
      state.bytesIn += chunk.length
      const pcm24 = resampler.push(chunk)
      if (!pcm24.length) return
      state.bytesToModel += pcm24.length
      state.midPressStreamed = true
      // Send in ~200 ms frames at 24 kHz.
      const frame = 9600
      for (let i = 0; i < pcm24.length; i += frame) {
        const slice = pcm24.subarray(i, i + frame)
        send({
          type: 'input_audio_buffer.append',
          audio: slice.toString('base64'),
        })
      }
    },

    /** Body complete: commit buffer and ask the model to respond. */
    finish() {
      if (state.finished) return resultPromise
      if (!state.committed) {
        state.committed = true
        const tail = resampler.flush()
        if (tail.length) {
          state.bytesToModel += tail.length
          send({
            type: 'input_audio_buffer.append',
            audio: tail.toString('base64'),
          })
        }
        if (state.bytesToModel === 0) {
          finishErr(new Error('No audio received for Realtime session.'))
          return resultPromise
        }
        send({ type: 'input_audio_buffer.commit' })
        send({
          type: 'response.create',
          response: { output_modalities: ['text'] },
        })
      }
      return resultPromise
    },

    abort(error) {
      finishErr(error || new Error('Realtime session aborted.'))
    },

    get stats() {
      return {
        bytesIn: state.bytesIn,
        bytesToModel: state.bytesToModel,
        midPressStreamed: state.midPressStreamed,
      }
    },
  }
}

/**
 * Batch helper: full buffer → streaming session (still uses Realtime).
 */
export async function planUtteranceWithRealtime({
  audioBuffer,
  format = 'wav',
  sampleRate = 16000,
  language = null,
  onEarlyPlan = null,
} = {}) {
  const { pcm: rawPcm, sampleRate: wavRate } = extractPcmFromWavOrPcm(
    audioBuffer,
    format,
  )
  const sourceRate = wavRate || sampleRate || 16000
  if (!rawPcm.length) {
    throw new Error('Audio buffer is empty.')
  }

  const session = await createStreamingRealtimeSession({
    inputSampleRate: sourceRate,
    language,
    onEarlyPlan,
  })
  // Append in chunks so the path matches mid-press streaming.
  const step = 3200 // ~100 ms @ 16 kHz
  for (let i = 0; i < rawPcm.length; i += step) {
    session.appendRawPcm(rawPcm.subarray(i, i + step))
  }
  return session.finish()
}
