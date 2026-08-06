/*
 * Reproduces the 01:00 UTC press: real speech early in a long hold, then
 * silence, streamed as length-prefixed Opus packets over chunked HTTP at
 * real time. Logs every reply byte with timestamps to expose the cutoff
 * and lets `wrangler tail` capture the relay's own failure logs.
 */
import fs from 'node:fs'
import tls from 'node:tls'
import OpusScript from 'opusscript'

const HOST = 'ai-pendant-relay.your-subdomain.workers.dev'
const RATE = 16000
const FRAME = 960 // 60 ms
const SPEECH_WAV = '/private/tmp/claude-501/-Users-you-agentic-gadget/4dacaad0-e5bd-4fd2-8ddb-1f37363e1450/scratchpad/question16k.wav'
const TAIL_SILENCE_SECONDS = Number(process.argv[2] || 14)

const key = fs
  .readFileSync('/Users/you/agentic-gadget/.env', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('RELAY_API_KEY='))
  ?.split('=', 2)[1]
  ?.trim()
if (!key) throw new Error('RELAY_API_KEY not found')

// 16 kHz mono s16le samples from the WAV (skip 44-byte header).
const wav = fs.readFileSync(SPEECH_WAV)
const speech = wav.subarray(44)
const silence = Buffer.alloc(
  TAIL_SILENCE_SECONDS * RATE * 2 + ((speech.length / 2) % FRAME) * 2,
)
const pcm = Buffer.concat([speech, silence])

const encoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP, {
  wasm: false,
})
encoder.setBitrate(14000)

const socket = tls.connect(443, HOST, { servername: HOST })
const t0 = Date.now()
const stamp = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${m}`)

socket.on('secureConnect', async () => {
  socket.write(
    `POST /v1/pendant/command?dispatch=1 HTTP/1.1\r\n` +
      `Host: ${HOST}\r\n` +
      `Authorization: Bearer ${key}\r\n` +
      `Content-Type: audio/opus\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      `X-Device-Id: nrf9160-pendant\r\n` +
      `X-Audio-Format: opus-frames\r\n` +
      `X-Sample-Rate: ${RATE}\r\n` +
      `X-Reply-Stream: opus\r\n` +
      `Connection: close\r\n\r\n`,
  )
  stamp('headers sent')
  const frames = Math.floor(pcm.length / 2 / FRAME)
  stamp(`streaming ${((frames * FRAME) / RATE).toFixed(1)}s: 2s speech then silence`)
  for (let f = 0; f < frames; f++) {
    const slice = pcm.subarray(f * FRAME * 2, (f + 1) * FRAME * 2)
    const packet = Buffer.from(encoder.encode(slice, FRAME))
    const prefix = Buffer.alloc(2)
    prefix.writeUInt16BE(packet.length)
    const body = Buffer.concat([prefix, packet])
    socket.write(`${body.length.toString(16)}\r\n`)
    socket.write(body)
    socket.write('\r\n')
    await new Promise((r) => setTimeout(r, 60))
  }
  socket.write('0\r\n\r\n')
  stamp('upload body ended (button stop)')
})

let raw = Buffer.alloc(0)
let headerDone = false
let lastLog = 0
socket.on('data', (chunk) => {
  raw = Buffer.concat([raw, chunk])
  if (!headerDone && raw.includes('\r\n\r\n')) {
    headerDone = true
    stamp(`response headers received (${raw.length} B so far)`)
    return
  }
  if (headerDone && Date.now() - lastLog > 400) {
    lastLog = Date.now()
    stamp(`reply bytes so far: ${raw.length}`)
  }
})
socket.on('end', () => {
  const headerEnd = raw.indexOf('\r\n\r\n')
  const head = raw.subarray(0, headerEnd).toString()
  console.log('--- headers ---')
  for (const line of head.split('\r\n')) {
    if (/^(HTTP|content-type|x-audio|x-job)/i.test(line)) console.log(line)
  }
  let body = Buffer.alloc(0)
  let cursor = headerEnd + 4
  for (;;) {
    const lineEnd = raw.indexOf('\r\n', cursor)
    if (lineEnd === -1) break
    const size = parseInt(raw.subarray(cursor, lineEnd).toString(), 16)
    if (!size) break
    body = Buffer.concat([body, raw.subarray(lineEnd + 2, lineEnd + 2 + size)])
    cursor = lineEnd + 2 + size + 2
  }
  if (!/HTTP\/1.1 200/.test(head)) {
    console.log('--- error body:', body.toString().slice(0, 400))
    process.exit(1)
  }
  const decoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP, {
    wasm: false,
  })
  let off = 0
  let packets = 0
  let pcmBytes = 0
  while (off + 2 <= body.length) {
    const len = body.readUInt16BE(off)
    if (!len || off + 2 + len > body.length) break
    pcmBytes += decoder.decode(body.subarray(off + 2, off + 2 + len)).length
    off += 2 + len
    packets++
  }
  stamp(
    `REPLY TOTAL: ${body.length} wire B, ${packets} packets, ${(pcmBytes / 2 / RATE).toFixed(2)}s of 16 kHz agent speech`,
  )
  process.exit(0)
})
socket.on('error', (e) => {
  console.error('socket error', e.message)
  process.exit(1)
})
