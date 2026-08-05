/*
 * End-to-end Opus probe: replicates the pendant's chunked upload with
 * length-prefixed Opus packets and expects a length-prefixed Opus reply.
 * Verifies the full transcode loop (encode → relay decode → Realtime →
 * relay encode → decode) without touching firmware.
 */
import fs from 'node:fs'
import tls from 'node:tls'
import OpusScript from 'opusscript'

const HOST = 'ai-pendant-relay.your-subdomain.workers.dev'
const RATE = 16000
const FRAME = 960 // 60 ms

const key = fs
  .readFileSync('/Users/you/agentic-gadget/.env', 'utf8')
  .split('\n')
  .find((l) => l.startsWith('RELAY_API_KEY='))
  ?.split('=', 2)[1]
  ?.trim()
if (!key) throw new Error('RELAY_API_KEY not found')

const encoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP, { wasm: false })
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
  stamp('headers sent (prewarm)')
  await new Promise((r) => setTimeout(r, 4000))
  stamp('sending 2 s of Opus-encoded tone at real time')

  const pcm = Buffer.alloc(FRAME * 2)
  let sent = 0
  for (let f = 0; f < 33; f++) {
    for (let i = 0; i < FRAME; i++) {
      pcm.writeInt16LE(
        Math.round(6000 * Math.sin((2 * Math.PI * 330 * (f * FRAME + i)) / RATE)),
        i * 2,
      )
    }
    const packet = Buffer.from(encoder.encode(pcm, FRAME))
    const prefix = Buffer.alloc(2)
    prefix.writeUInt16BE(packet.length)
    const body = Buffer.concat([prefix, packet])
    socket.write(`${body.length.toString(16)}\r\n`)
    socket.write(body)
    socket.write('\r\n')
    sent += body.length
    await new Promise((r) => setTimeout(r, 60))
  }
  socket.write('0\r\n\r\n')
  stamp(`upload done: ${sent} wire bytes for 2.0 s audio (${Math.round((sent * 8) / 2 / 1000)} kbps)`)
})

let raw = Buffer.alloc(0)
let headerDone = false
let firstByteAt = null
socket.on('data', (chunk) => {
  if (firstByteAt === null && headerDone) {
    firstByteAt = Date.now()
    stamp('first reply bytes')
  }
  raw = Buffer.concat([raw, chunk])
  if (!headerDone && raw.includes('\r\n\r\n')) {
    headerDone = true
    firstByteAt = Date.now()
    stamp('response headers received')
  }
})
socket.on('end', () => {
  const headerEnd = raw.indexOf('\r\n\r\n')
  const head = raw.subarray(0, headerEnd).toString()
  console.log('--- headers of interest ---')
  for (const line of head.split('\r\n')) {
    if (/^(HTTP|content-type|x-audio|x-opus|x-job)/i.test(line)) console.log(line)
  }
  // Dechunk
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
    console.log('--- error body:', body.toString().slice(0, 300))
    process.exit(1)
  }
  // Parse + decode packets
  const decoder = new OpusScript(RATE, 1, OpusScript.Application.VOIP, { wasm: false })
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
  console.log(
    `--- reply: ${body.length} wire bytes, ${packets} packets, ${(pcmBytes / 2 / RATE).toFixed(2)} s of 16 kHz speech (${Math.round((body.length * 8) / (pcmBytes / 2 / RATE) / 1000)} kbps wire)`,
  )
  process.exit(0)
})
socket.on('error', (e) => {
  console.error('socket error', e.message)
  process.exit(1)
})
