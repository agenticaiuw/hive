/*
 * Recordings for speech models: 16 kHz mono 16-bit PCM WAV, the rate Parakeet and Whisper read.
 * Pure, so the page, the tests and any host can share it.
 */

export const SPEECH_RATE = 16000;

/**
 * Float samples recorded at `from` Hz, at `to` Hz. Each output sample is the mean of the input it
 * spans (a box filter), so a 48 kHz microphone doesn't alias much on the way down.
 * @param {Float32Array} samples
 * @param {number} from
 * @param {number} to
 * @returns {Float32Array}
 */
export function resample(samples, from, to) {
  if (from === to) return samples;
  const length = Math.floor((samples.length * to) / from);
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * step)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / (end - start);
  }
  return out;
}

/**
 * A WAV file of the recorded chunks (float samples at `rate` Hz), at 16 kHz mono 16-bit.
 * @param {Float32Array[]} chunks
 * @param {number} rate
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function toWav(chunks, rate) {
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const joined = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  const samples = resample(joined, rate, SPEECH_RATE);
  const bytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const tag = (/** @type {number} */ offset, /** @type {string} */ text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true); // the format block's size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SPEECH_RATE, true);
  view.setUint32(28, SPEECH_RATE * 2, true); // bytes a second
  view.setUint16(32, 2, true); // bytes a frame
  view.setUint16(34, 16, true); // bits a sample
  tag(36, "data");
  view.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(view.buffer);
}
