/*
 * Local Realtime session probe: drives createStreamingRealtimeSession exactly
 * like the Worker does for an Opus upload (16 kHz PCM in, audioOut) and — with
 * OPENAI_RT_DEBUG=1 — prints every Realtime event, exposing what semantic VAD
 * actually does across speech, silence, and body end.
 */
import fs from 'node:fs'
import { createStreamingRealtimeSession } from '../cloud-relay/openaiRealtimeVoice.js'

const RATE = 16000
const WAV =
  process.env.PROBE_WAV ||
  '/private/tmp/claude-501/-Users-you-agentic-gadget/4dacaad0-e5bd-4fd2-8ddb-1f37363e1450/scratchpad/question16k.wav'
const TAIL_SILENCE_SECONDS = Number(process.argv[2] || 14)

for (const line of fs
  .readFileSync('/Users/you/agentic-gadget/.env', 'utf8')
  .split('\n')) {
  const eq = line.indexOf('=')
  if (eq > 0 && !process.env[line.slice(0, eq)]) {
    process.env[line.slice(0, eq)] = line.slice(eq + 1).trim()
  }
}

const speech = fs.readFileSync(WAV).subarray(44)
const silence = Buffer.alloc(TAIL_SILENCE_SECONDS * RATE * 2)
const pcm = Buffer.concat([speech, silence])

const t0 = Date.now()
const stamp = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${m}`)

let audioBytes = 0
let lastAudioLog = 0
const session = await createStreamingRealtimeSession({
  inputSampleRate: RATE,
  audioOut: true,
  onAudioDelta: (pcmDelta) => {
    audioBytes += pcmDelta.length
    if (Date.now() - lastAudioLog > 500) {
      lastAudioLog = Date.now()
      stamp(`  << agent audio total ${(audioBytes / 2 / 24000).toFixed(2)}s`)
    }
  },
  onEarlyPlan: async (plan) => {
    stamp(`  ** onEarlyPlan: status=${plan.status} actions=${plan.actions?.length || 0} response="${String(plan.response || '').slice(0, 80)}"`)
    return null
  },
})
stamp('session open; streaming at real time')

const CHUNK = Math.round(RATE * 0.2) * 2 // 200 ms
for (let off = 0; off < pcm.length; off += CHUNK) {
  session.appendRawPcm(pcm.subarray(off, off + CHUNK))
  await new Promise((r) => setTimeout(r, 200))
}
stamp('body ended (button stop) — calling finish()')

try {
  const plan = await session.finish()
  stamp(
    `finish OK: status=${plan.status} transcript="${plan.text || plan.transcript || ''}" response="${String(plan.response || '').slice(0, 120)}"`,
  )
} catch (error) {
  stamp(`finish REJECTED: ${error.message}`)
}
stamp(`total agent audio: ${(audioBytes / 2 / 24000).toFixed(2)}s`)
process.exit(0)
