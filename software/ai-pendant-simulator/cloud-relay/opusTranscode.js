/*
 * Opus transcode for the pendant's constrained LTE-M link.
 *
 * Wire format (both directions): raw Opus packets, each preceded by a 2-byte
 * big-endian length, inside the HTTP chunked body. Downlink packets are
 * 60 ms SILK-wideband at ~14 kbps VBR — the research-backed sweet spot where
 * TLS+TCP overhead amortizes to ~9 kbps and speech quality beats G.711 at a
 * fifth of the bits. FEC stays off (TCP never drops packets).
 *
 * The codec is OUR OWN libopus.wasm, compiled from the same vendored Opus
 * tree the firmware uses, with plain C exports and zero runtime codegen —
 * the only shape Cloudflare Workers accept (opusscript and friends use
 * Emscripten embind, which builds invokers with `new Function` and dies with
 * "Code generation from strings disallowed"). One WebAssembly.Instance per
 * encoder/decoder keeps concurrent requests isolated.
 */

export const OPUS_WIRE_SAMPLE_RATE = 16000
export const OPUS_FRAME_SAMPLES = 960 // 60 ms at 16 kHz
export const OPUS_TARGET_BITRATE = 14000
export const OPUS_COMPLEXITY = 6
export const OPUS_MAX_PACKET_BYTES = 2000 // RFC 6716 caps one frame at 1275

const WASI_STUBS = {
  wasi_snapshot_preview1: {
    fd_close: () => 0,
    fd_write: () => 0,
    fd_seek: () => 0,
  },
}

let modulePromise = null

function loadOpusModule() {
  if (!modulePromise) {
    modulePromise = import('./wasm/libopusModule.js')
      .then((shim) => shim.default)
      .catch(async () => {
        // Node (tests/probes): compile from bytes — allowed outside Workers.
        const { readFile } = await import('node:fs/promises')
        const bytes = await readFile(
          new URL('./wasm/libopus.wasm', import.meta.url),
        )
        return WebAssembly.compile(bytes)
      })
  }
  return modulePromise
}

async function createCodecInstance() {
  const module = await loadOpusModule()
  const instance = await WebAssembly.instantiate(module, WASI_STUBS)
  const { memory, ow_pcm_buf, ow_pkt_buf } = instance.exports

  return {
    exports: instance.exports,
    pcm: new Int16Array(memory.buffer, ow_pcm_buf(), 1920),
    pkt: new Uint8Array(memory.buffer, ow_pkt_buf(), 1400),
  }
}

/*
 * Streaming 24 kHz → 16 kHz linear resampler (3:2). Adequate for speech; the
 * model's 24 kHz output has little energy near the new Nyquist.
 */
export function createPcm24kTo16k() {
  let tail = Buffer.alloc(0)

  return {
    push(pcm24) {
      const merged = tail.length ? Buffer.concat([tail, pcm24]) : pcm24
      const inSamples = Math.floor(merged.length / 2)
      const groups = Math.floor(inSamples / 3)
      const out = Buffer.alloc(groups * 2 * 2)

      for (let g = 0; g < groups; g++) {
        const s0 = merged.readInt16LE(g * 6)
        const s1 = merged.readInt16LE(g * 6 + 2)
        const s2 = merged.readInt16LE(g * 6 + 4)

        out.writeInt16LE(s0, g * 4)
        out.writeInt16LE(Math.round((s1 + s2) / 2), g * 4 + 2)
      }
      tail = Buffer.from(merged.subarray(groups * 6))
      return out
    },
  }
}

/*
 * Reply path: model 24 kHz PCM in → length-prefixed Opus packets out.
 * push() returns whatever packets became ready (possibly empty); end()
 * flushes the final partial frame zero-padded.
 */
export async function createOpusReplyEncoder({
  bitrate = OPUS_TARGET_BITRATE,
} = {}) {
  const codec = await createCodecInstance()
  const initError = codec.exports.ow_enc_init(
    OPUS_WIRE_SAMPLE_RATE,
    bitrate,
    OPUS_COMPLEXITY,
  )

  if (initError !== 0) {
    throw new Error(`opus encoder init failed: ${initError}`)
  }
  const resampler = createPcm24kTo16k()
  let pending = Buffer.alloc(0)

  function encodeFrame(frame) {
    for (let i = 0; i < OPUS_FRAME_SAMPLES; i++) {
      codec.pcm[i] = i * 2 + 1 < frame.length ? frame.readInt16LE(i * 2) : 0
    }
    const bytes = codec.exports.ow_encode(OPUS_FRAME_SAMPLES)

    if (bytes < 0) {
      throw new Error(`opus encode failed: ${bytes}`)
    }
    const wire = Buffer.alloc(2 + bytes)

    wire.writeUInt16BE(bytes)
    Buffer.from(codec.pkt.buffer, codec.pkt.byteOffset, bytes).copy(wire, 2)
    return wire
  }

  function encodeReady(final) {
    const frameBytes = OPUS_FRAME_SAMPLES * 2
    const packets = []

    while (pending.length >= frameBytes) {
      packets.push(encodeFrame(pending.subarray(0, frameBytes)))
      pending = Buffer.from(pending.subarray(frameBytes))
    }
    if (final && pending.length > 0) {
      packets.push(encodeFrame(pending))
      pending = Buffer.alloc(0)
    }
    return packets.length ? Buffer.concat(packets) : Buffer.alloc(0)
  }

  return {
    push(pcm24) {
      const pcm16k = resampler.push(pcm24)

      if (pcm16k.length) {
        pending = pending.length ? Buffer.concat([pending, pcm16k]) : pcm16k
      }
      return encodeReady(false)
    },
    end() {
      return encodeReady(true)
    },
    destroy() {
      /* instance is GC'd */
    },
  }
}

/*
 * Upload path: length-prefixed Opus packets in → 16 kHz s16le PCM out.
 * Tolerates arbitrary chunk boundaries (prefix parsing is stateful).
 */
export async function createOpusUploadDecoder() {
  const codec = await createCodecInstance()
  const initError = codec.exports.ow_dec_init(OPUS_WIRE_SAMPLE_RATE)

  if (initError !== 0) {
    throw new Error(`opus decoder init failed: ${initError}`)
  }
  let buffered = Buffer.alloc(0)

  return {
    push(bytes) {
      buffered = buffered.length
        ? Buffer.concat([buffered, bytes])
        : Buffer.from(bytes)
      const decoded = []

      for (;;) {
        if (buffered.length < 2) break
        const packetLength = buffered.readUInt16BE(0)

        if (packetLength === 0 || packetLength > OPUS_MAX_PACKET_BYTES) {
          throw new Error(`invalid opus packet length ${packetLength}`)
        }
        if (buffered.length < 2 + packetLength) break
        codec.pkt.set(buffered.subarray(2, 2 + packetLength))
        buffered = Buffer.from(buffered.subarray(2 + packetLength))

        const samples = codec.exports.ow_decode(packetLength)

        if (samples < 0) {
          throw new Error(`opus decode failed: ${samples}`)
        }
        const pcm = Buffer.alloc(samples * 2)

        Buffer.from(
          codec.pcm.buffer,
          codec.pcm.byteOffset,
          samples * 2,
        ).copy(pcm)
        decoded.push(pcm)
      }
      if (!decoded.length) return Buffer.alloc(0)
      return Buffer.concat(decoded)
    },
    destroy() {
      /* instance is GC'd */
    },
  }
}

export function isOpusFramesFormat(format) {
  const value = String(format || '')
    .trim()
    .toLowerCase()
  return value === 'opus-frames' || value === 'opus'
}
