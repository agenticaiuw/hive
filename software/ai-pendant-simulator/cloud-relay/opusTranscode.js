/*
 * Opus transcode for the pendant's constrained LTE-M link.
 *
 * Wire format (both directions): raw Opus packets, each preceded by a 2-byte
 * big-endian length. Uplink (mic) is 60 ms wideband at ~14 kbps. Downlink
 * (the agent's voice) is 60 ms superwideband at 24 kHz / ~24 kbps, straight
 * from the model with no resampling. FEC stays off (both directions ride TCP,
 * which never drops packets).
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

/*
 * Downlink (the agent's voice): 24 kHz superwideband Opus, the model's own
 * rate, never resampled. No downsampler means nothing to alias — the
 * earlier 2-tap decimator folded 9 kHz sibilance onto 7 kHz with 3.2 dB of
 * rejection, which was the metallic distortion.
 *
 * This first failed on hardware and the rate got the blame; the real cause
 * was pairing it with 20 ms frames, i.e. 50 decodes/s against a chip that
 * can only start ~48.8/s. At 60 ms frames it is 16.7/s. Measured on device
 * with libopus finally built -O3: decode 8.8 ms per 60 ms packet at 16 kHz
 * (~15% CPU), against ~50% for the uplink encoder — leaving room for the
 * ~1.5x that superwideband costs.
 */
export const OPUS_REPLY_SAMPLE_RATE = 24000
export const OPUS_REPLY_FRAME_SAMPLES = 1440 // 60 ms at 24 kHz
export const OPUS_REPLY_BITRATE = 24000
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
    pcm: new Int16Array(memory.buffer, ow_pcm_buf(), 1920), // 1440 used
    pkt: new Uint8Array(memory.buffer, ow_pkt_buf(), 1400),
  }
}

/*
 * Streaming 24 kHz → 16 kHz downsampler with a real anti-aliasing filter.
 *
 * Decimating to 16 kHz means everything above 8 kHz MUST be removed first,
 * or it folds back into the voice band. Speech sibilance ("s", "sh", "t")
 * is loud at 8-12 kHz, so the old 2-tap average turned every one of them
 * into metallic noise on top of the words.
 *
 * Output sample n sits at input position n * 1.5, so positions alternate
 * integer / half-integer — exactly two polyphase branches, precomputed
 * once. Windowed-sinc, cutoff 7.2 kHz, Hamming, 32 taps per branch.
 */
const AA_TAPS = 32
const AA_CUTOFF_NORM = 7200 / 24000 // cutoff / input rate

function buildPolyphaseBranches() {
  const branches = []

  for (let phase = 0; phase < 2; phase++) {
    const shift = phase * 0.5
    const taps = new Float64Array(AA_TAPS)
    let sum = 0

    for (let i = 0; i < AA_TAPS; i++) {
      const x = i - (AA_TAPS / 2 - 1) - shift
      const arg = 2 * AA_CUTOFF_NORM * x
      const sinc =
        Math.abs(arg) < 1e-9 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg)
      const window =
        0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (AA_TAPS - 1))
      taps[i] = 2 * AA_CUTOFF_NORM * sinc * window
      sum += taps[i]
    }
    // Unity DC gain keeps loudness identical to the model's output.
    for (let i = 0; i < AA_TAPS; i++) taps[i] /= sum
    branches.push(taps)
  }
  return branches
}

const AA_BRANCHES = buildPolyphaseBranches()

export function createPcm24kTo16k() {
  // History carries the filter across chunk boundaries; without it every
  // push() would click at its seam.
  const history = new Float64Array(AA_TAPS)
  let historyLen = 0
  let inputIndex = 0 // absolute input sample counter
  let outputIndex = 0 // absolute output sample counter

  return {
    push(pcm24) {
      const inSamples = Math.floor(pcm24.length / 2)
      const out = []

      for (let i = 0; i < inSamples; i++) {
        // Shift the newest sample into the delay line.
        for (let t = 0; t < AA_TAPS - 1; t++) history[t] = history[t + 1]
        history[AA_TAPS - 1] = pcm24.readInt16LE(i * 2)
        if (historyLen < AA_TAPS) historyLen++
        inputIndex++

        // Emit every output whose position is now covered by the window.
        for (;;) {
          const position = outputIndex * 1.5
          const center = inputIndex - AA_TAPS / 2

          if (position >= center + 1 || historyLen < AA_TAPS) break

          const phase = outputIndex % 2 === 0 ? 0 : 1
          const taps = AA_BRANCHES[phase]
          let acc = 0

          for (let t = 0; t < AA_TAPS; t++) acc += taps[t] * history[t]
          const clamped = Math.max(-32768, Math.min(32767, Math.round(acc)))

          out.push(clamped)
          outputIndex++
        }
      }
      const buf = Buffer.alloc(out.length * 2)

      for (let i = 0; i < out.length; i++) buf.writeInt16LE(out[i], i * 2)
      return buf
    },
  }
}

/*
 * Reply path: model 24 kHz PCM in → length-prefixed Opus packets out.
 * push() returns whatever packets became ready (possibly empty); end()
 * flushes the final partial frame zero-padded.
 */
export async function createOpusReplyEncoder({
  bitrate = OPUS_REPLY_BITRATE,
} = {}) {
  const codec = await createCodecInstance()
  const initError = codec.exports.ow_enc_init(
    OPUS_REPLY_SAMPLE_RATE,
    bitrate,
    OPUS_COMPLEXITY,
  )

  if (initError !== 0) {
    throw new Error(`opus encoder init failed: ${initError}`)
  }
  let pending = Buffer.alloc(0)

  function encodeFrame(frame) {
    for (let i = 0; i < OPUS_REPLY_FRAME_SAMPLES; i++) {
      codec.pcm[i] = i * 2 + 1 < frame.length ? frame.readInt16LE(i * 2) : 0
    }
    const bytes = codec.exports.ow_encode(OPUS_REPLY_FRAME_SAMPLES)

    if (bytes < 0) {
      throw new Error(`opus encode failed: ${bytes}`)
    }
    const wire = Buffer.alloc(2 + bytes)

    wire.writeUInt16BE(bytes)
    Buffer.from(codec.pkt.buffer, codec.pkt.byteOffset, bytes).copy(wire, 2)
    return wire
  }

  function encodeReady(final) {
    const frameBytes = OPUS_REPLY_FRAME_SAMPLES * 2
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
    /* The model's own 24 kHz PCM is the wire format. No resampling. */
    push(pcm24) {
      if (pcm24.length) {
        pending = pending.length ? Buffer.concat([pending, pcm24]) : pcm24
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
/*
 * Uplink decoder (mic audio, 16 kHz). Pass OPUS_REPLY_SAMPLE_RATE to decode
 * the downlink instead — test harnesses need to hear what the pendant hears.
 */
export async function createOpusUploadDecoder(
  sampleRate = OPUS_WIRE_SAMPLE_RATE,
) {
  const codec = await createCodecInstance()
  const initError = codec.exports.ow_dec_init(sampleRate)

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
