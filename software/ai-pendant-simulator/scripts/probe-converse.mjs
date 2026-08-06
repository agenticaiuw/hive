/*
 * Full-duplex conversation probe: speaks the pendant's WebSocket protocol
 * against the deployed relay. Streams a spoken question as length-prefixed
 * Opus frames at real time, prints agent audio the moment it arrives
 * (mid-recording — the whole point), then barge-ins with a second question
 * to exercise interrupt + flush, and finally stops.
 *
 *   node scripts/probe-converse.mjs [tail-silence-seconds]
 */
import fs from 'node:fs'
import WebSocket from 'ws'
import OpusScript from 'opusscript'

const HOST = 'ai-pendant-relay.your-subdomain.workers.dev'
const RATE = 16000
const FRAME = 960 // 60 ms
const WAV =
  process.env.PROBE_WAV ||
  '/private/tmp/claude-501/-Users-you-agentic-gadget/4dacaad0-e5bd-4fd2-8ddb-1f37363e1450/scratchpad/question16k.wav'
const TAIL_SILENCE_SECONDS = Number(process.argv[2] || 20)

const key = fs
  .readFileSync('/Users/you/agentic-gadget/.env', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('RELAY_API_KEY='))
  ?.split('=', 2)[1]
  ?.trim()
if (!key) throw new Error('RELAY_API_KEY not found')

const speech = fs.readFileSync(WAV).subarray(44)
const silence = Buffer.alloc(TAIL_SILENCE_SECONDS * RATE * 2)
const pcm = Buffer.concat([speech, silence])

const REPLY_RATE = 16000 // agent voice: wideband Opus, anti-alias filtered
const encoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP, {
  wasm: false,
})
encoder.setBitrate(14000)
const decoder = new OpusScript(REPLY_RATE, 1, OpusScript.Application.VOIP, {
  wasm: false,
})

const t0 = Date.now()
const stamp = (m) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${m}`)

let replyBytes = 0
let replySamples = 0
let frames = 0
let maxFrame = 0
let firstAudioAt = null
let bargedIn = false

const ws = new WebSocket(`wss://${HOST}/v1/pendant/converse`, {
  headers: {
    Authorization: `Bearer ${key}`,
    'X-Device-Id': 'nrf9160-pendant',
  },
})

ws.on('open', async () => {
  stamp('WS open — sending start')
  ws.send(JSON.stringify({ type: 'start', deviceTime: '26/08/05,21:30:00-16' }))

  const total = Math.floor(pcm.length / 2 / FRAME)
  for (let f = 0; f < total; f++) {
    const slice = pcm.subarray(f * FRAME * 2, (f + 1) * FRAME * 2)
    const packet = Buffer.from(encoder.encode(slice, FRAME))
    const wire = Buffer.alloc(2 + packet.length)
    wire.writeUInt16BE(packet.length, 0)
    packet.copy(wire, 2)
    ws.send(wire)
    await new Promise((r) => setTimeout(r, 60))

    // Barge-in: once ~2 s of agent audio has arrived, talk over it.
    if (!bargedIn && replySamples > 2 * REPLY_RATE) {
      bargedIn = true
      stamp('BARGE-IN: speaking over the agent (expect flush)')
      for (let g = 0; g < Math.floor(speech.length / 2 / FRAME); g++) {
        const s = speech.subarray(g * FRAME * 2, (g + 1) * FRAME * 2)
        const p = Buffer.from(encoder.encode(s, FRAME))
        const w = Buffer.alloc(2 + p.length)
        w.writeUInt16BE(p.length, 0)
        p.copy(w, 2)
        ws.send(w)
        await new Promise((r) => setTimeout(r, 60))
      }
    }
  }
  stamp('upload done — sending stop in 3 s (agent may still be talking)')
  await new Promise((r) => setTimeout(r, 3000))
  ws.send(JSON.stringify({ type: 'stop' }))
})

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    const text = data.toString()
    stamp(`<< control: ${text}`)
    if (text.includes('"end"')) {
      setTimeout(() => {
        stamp(
          `TOTAL agent speech: ${(replySamples / REPLY_RATE).toFixed(2)}s over ${frames} frames (${replyBytes} wire B, max frame ${maxFrame} B)` +
            (firstAudioAt
              ? `; first audio at +${((firstAudioAt - t0) / 1000).toFixed(2)}s (mid-recording=${firstAudioAt - t0 < 22000})`
              : ''),
        )
        ws.close()
        process.exit(0)
      }, 300)
    }
    return
  }
  const buf = Buffer.from(data)
  frames += 1
  replyBytes += buf.length
  maxFrame = Math.max(maxFrame, buf.length)
  if (buf.length > 500) {
    stamp(`!! downlink frame ${buf.length} B exceeds the 500 B contract`)
  }
  let off = 0
  while (off + 2 <= buf.length) {
    const len = buf.readUInt16BE(off)
    if (!len || off + 2 + len > buf.length) {
      stamp(`!! frame not packet-aligned at offset ${off}`)
      break
    }
    try {
      replySamples += decoder.decode(buf.subarray(off + 2, off + 2 + len)).length / 2
    } catch {
      stamp('!! opus decode failed')
    }
    off += 2 + len
  }
  if (firstAudioAt === null) {
    firstAudioAt = Date.now()
    stamp(`FIRST AGENT AUDIO (mid-recording: upload still streaming)`)
  }
})

ws.on('error', (e) => {
  stamp(`WS error: ${e.message}`)
  process.exit(1)
})
ws.on('close', (code) => stamp(`WS closed (${code})`))

setTimeout(() => {
  stamp('probe timeout')
  process.exit(2)
}, 120000)
