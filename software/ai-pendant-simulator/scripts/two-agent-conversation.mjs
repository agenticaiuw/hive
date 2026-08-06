/*
 * Two Realtime agents in conversation, end to end, no microphone and no
 * speaker involved.
 *
 *   [Mac persona agent] --Opus/WS--> [relay /v1/pendant/converse]
 *                                          |
 *                                    [server agent + tools]
 *   [Mac persona agent] <--Opus/WS-- [relay reply stream]
 *
 * The persona agent HEARS the server agent's actual audio (decoded from
 * the same Opus frames the pendant would receive) and answers it, so this
 * exercises the real duplex protocol — barge-in included — deterministically.
 *
 * Both voices are written to WAV plus a transcript, so the exchange can be
 * listened back to afterwards.
 *
 *   node scripts/two-agent-conversation.mjs [seconds] [outdir]
 */
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import OpusScript from 'opusscript'

const HOST = 'ai-pendant-relay.your-subdomain.workers.dev'
const WIRE_RATE = 16000 // pendant wire rate
const MODEL_RATE = 24000 // OpenAI Realtime PCM rate
const FRAME = 960 // 60 ms at 16 kHz
const SECONDS = Number(process.argv[2] || 75)
const OUT_DIR =
  process.argv[3] ||
  path.join(
    '/Users/you/agentic-gadget/diagnostics/two-agent',
    new Date().toISOString().replace(/[:.]/g, '-'),
  )

for (const line of fs
  .readFileSync('/Users/you/agentic-gadget/.env', 'utf8')
  .split('\n')) {
  const eq = line.indexOf('=')
  if (eq > 0 && !process.env[line.slice(0, eq)]) {
    process.env[line.slice(0, eq)] = line.slice(eq + 1).trim()
  }
}
const RELAY_KEY = process.env.RELAY_API_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY
if (!RELAY_KEY) throw new Error('RELAY_API_KEY missing')
if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY missing')

fs.mkdirSync(OUT_DIR, { recursive: true })
const t0 = Date.now()
const stamp = (m) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${m}`)

/* ---- helpers ---- */
function resample(pcm, fromRate, toRate) {
  const inSamples = pcm.length / 2
  const outSamples = Math.floor((inSamples * toRate) / fromRate)
  const out = Buffer.alloc(outSamples * 2)
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * fromRate) / toRate
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = pcm.readInt16LE(Math.min(idx, inSamples - 1) * 2)
    const b = pcm.readInt16LE(Math.min(idx + 1, inSamples - 1) * 2)
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2)
  }
  return out
}

function writeWav(file, pcm, rate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, pcm]))
}

/* ---- recordings ---- */
const personaPcm = [] // what the "owner" said (24 kHz)
const agentPcm = [] // what the server agent said (16 kHz, as the pendant hears)
const transcript = []

/* ---- leg 1: the relay, spoken to exactly like the pendant does ---- */
const encoder = new OpusScript(WIRE_RATE, 1, OpusScript.Application.VOIP, {
  wasm: false,
})
encoder.setBitrate(14000)
const decoder = new OpusScript(WIRE_RATE, 1, OpusScript.Application.VOIP, {
  wasm: false,
})

let uplinkRemainder = Buffer.alloc(0)
let relayReady = false
let personaReady = false
let finished = false

const relay = new WebSocket(`wss://${HOST}/v1/pendant/converse`, {
  headers: {
    Authorization: `Bearer ${RELAY_KEY}`,
    'X-Device-Id': 'nrf9160-pendant',
  },
})

relay.on('open', () => {
  stamp('relay WS open -> start')
  relay.send(JSON.stringify({ type: 'start' }))
})

relay.on('message', (data, isBinary) => {
  if (!isBinary) {
    const text = data.toString()
    stamp(`relay control: ${text}`)
    if (text.includes('"started"')) {
      relayReady = true
      startUplinkClock()
    }
    if (text.includes('"end"')) finish('relay-end')
    return
  }
  // Agent speech: decode and let the persona agent HEAR it.
  const buf = Buffer.from(data)
  let off = 0
  const chunks = []
  while (off + 2 <= buf.length) {
    const len = buf.readUInt16BE(off)
    if (!len || off + 2 + len > buf.length) break
    try {
      chunks.push(Buffer.from(decoder.decode(buf.subarray(off + 2, off + 2 + len))))
    } catch {
      /* skip undecodable packet */
    }
    off += 2 + len
  }
  if (!chunks.length) return
  const pcm16k = Buffer.concat(chunks)
  agentPcm.push(pcm16k)
  // Queue for the persona's own real-time input clock (see below).
  personaInQueue = Buffer.concat([
    personaInQueue,
    resample(pcm16k, WIRE_RATE, MODEL_RATE),
  ])
})
relay.on('error', (e) => stamp(`relay WS error: ${e.message}`))

/*
 * Uplink clock. The pendant streams CONTINUOUSLY at real time — silence
 * included — and the server's semantic VAD depends on that: it needs the
 * trailing silence after speech to decide a turn ended. Bursting audio
 * only while the persona talks leaves VAD waiting forever and the agent
 * never replies. So: one 60 ms Opus packet every 60 ms, always, drawing
 * from the persona's queue and padding with silence.
 */
const SILENCE_FRAME = Buffer.alloc(FRAME * 2)
let uplinkTimer = null

function queueUplink(pcm16k) {
  uplinkRemainder = Buffer.concat([uplinkRemainder, pcm16k])
}

function startUplinkClock() {
  if (uplinkTimer) return
  uplinkTimer = setInterval(() => {
    if (relay.readyState !== WebSocket.OPEN || !relayReady) return
    let slice
    if (uplinkRemainder.length >= FRAME * 2) {
      slice = uplinkRemainder.subarray(0, FRAME * 2)
      uplinkRemainder = uplinkRemainder.subarray(FRAME * 2)
    } else if (uplinkRemainder.length > 0) {
      slice = Buffer.concat([
        uplinkRemainder,
        SILENCE_FRAME.subarray(0, FRAME * 2 - uplinkRemainder.length),
      ])
      uplinkRemainder = Buffer.alloc(0)
    } else {
      slice = SILENCE_FRAME
    }
    const packet = Buffer.from(encoder.encode(slice, FRAME))
    const wire = Buffer.alloc(2 + packet.length)
    wire.writeUInt16BE(packet.length, 0)
    packet.copy(wire, 2)
    relay.send(wire)
  }, 60)
}

/*
 * The persona's ears need the same treatment as the relay's: a continuous
 * real-time stream. Feeding it only the bursts of agent speech left ITS
 * semantic VAD waiting for trailing silence, so it took exactly one turn
 * and then went quiet. 60 ms of audio every 60 ms, silence when idle.
 */
const PERSONA_FRAME_BYTES = Math.round(MODEL_RATE * 0.06) * 2
const PERSONA_SILENCE = Buffer.alloc(PERSONA_FRAME_BYTES)
let personaInQueue = Buffer.alloc(0)
let personaInTimer = null

function startPersonaInputClock() {
  if (personaInTimer) return
  personaInTimer = setInterval(() => {
    if (persona.readyState !== WebSocket.OPEN || !personaReady) return
    let slice
    if (personaInQueue.length >= PERSONA_FRAME_BYTES) {
      slice = personaInQueue.subarray(0, PERSONA_FRAME_BYTES)
      personaInQueue = personaInQueue.subarray(PERSONA_FRAME_BYTES)
    } else if (personaInQueue.length > 0) {
      slice = Buffer.concat([
        personaInQueue,
        PERSONA_SILENCE.subarray(0, PERSONA_FRAME_BYTES - personaInQueue.length),
      ])
      personaInQueue = Buffer.alloc(0)
    } else {
      slice = PERSONA_SILENCE
    }
    persona.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: slice.toString('base64'),
      }),
    )
  }, 60)
}

/* ---- leg 2: the Mac-side persona agent (plays the owner) ---- */
const persona = new WebSocket(
  'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
  { headers: { Authorization: `Bearer ${OPENAI_KEY}` } },
)

persona.on('open', () => {
  stamp('persona WS open')
  persona.send(
    JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions:
          'You are the owner of an AI voice pendant, talking to your assistant ' +
          'hands-free. Speak naturally and CONCISELY — one or two sentences per ' +
          'turn, like real speech. Start by asking something useful (weather, ' +
          'time, a quick fact). Listen to the assistant\'s answer and follow up ' +
          'naturally, sometimes changing the subject. Never mention that you are ' +
          'an AI or that this is a test.',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: MODEL_RATE },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: {
              type: 'semantic_vad',
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: MODEL_RATE },
            voice: 'verse',
          },
        },
      },
    }),
  )
  personaReady = true
  startPersonaInputClock()
  // Owner speaks first.
  setTimeout(() => {
    persona.send(
      JSON.stringify({
        type: 'response.create',
        response: { output_modalities: ['audio'] },
      }),
    )
  }, 800)
})

persona.on('message', (raw) => {
  let event
  try {
    event = JSON.parse(raw.toString())
  } catch {
    return
  }
  if (event.type === 'error') {
    stamp(`persona error: ${event.error?.message || 'unknown'}`)
    return
  }
  if (event.type === 'response.output_audio.delta' && event.delta) {
    const pcm24 = Buffer.from(event.delta, 'base64')
    personaPcm.push(pcm24)
    queueUplink(resample(pcm24, MODEL_RATE, WIRE_RATE))
    return
  }
  if (event.type === 'response.output_audio_transcript.done') {
    const line = String(event.transcript || '').trim()
    if (line) {
      transcript.push(`OWNER: ${line}`)
      stamp(`OWNER: ${line}`)
    }
    return
  }
  if (
    event.type === 'conversation.item.input_audio_transcription.completed'
  ) {
    const line = String(event.transcript || '').trim()
    if (line) {
      transcript.push(`AGENT: ${line}`)
      stamp(`AGENT: ${line}`)
    }
  }
})
persona.on('error', (e) => stamp(`persona WS error: ${e.message}`))

/* ---- wrap up ---- */
function finish(reason) {
  if (finished) return
  finished = true
  stamp(`finishing (${reason})`)
  if (uplinkTimer) clearInterval(uplinkTimer)
  if (personaInTimer) clearInterval(personaInTimer)
  try {
    if (relay.readyState === WebSocket.OPEN) {
      relay.send(JSON.stringify({ type: 'stop' }))
    }
  } catch {
    /* already closing */
  }
  setTimeout(() => {
    const ownerWav = path.join(OUT_DIR, 'owner.wav')
    const agentWav = path.join(OUT_DIR, 'agent.wav')
    writeWav(ownerWav, Buffer.concat(personaPcm), MODEL_RATE)
    writeWav(agentWav, Buffer.concat(agentPcm), WIRE_RATE)
    fs.writeFileSync(
      path.join(OUT_DIR, 'transcript.txt'),
      transcript.join('\n') + '\n',
    )
    const ownerSec = Buffer.concat(personaPcm).length / 2 / MODEL_RATE
    const agentSec = Buffer.concat(agentPcm).length / 2 / WIRE_RATE
    stamp(
      `saved: ${ownerWav} (${ownerSec.toFixed(1)}s owner), ${agentWav} (${agentSec.toFixed(1)}s agent), transcript.txt`,
    )
    try {
      relay.close()
      persona.close()
    } catch {
      /* ignore */
    }
    process.exit(0)
  }, 1500)
}

setTimeout(() => finish('duration reached'), SECONDS * 1000)
