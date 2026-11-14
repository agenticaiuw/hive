import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resample, SPEECH_RATE, toWav } from '../src/lib/wav.js';

test('a recording becomes a 16 kHz mono 16-bit WAV a speech model reads', () => {
  // Half a second at 48 kHz in two chunks, a quiet then a loud half.
  const quiet = new Float32Array(12_000).fill(0.25);
  const loud = new Float32Array(12_000).fill(2); // clipped to full scale
  const wav = toWav([quiet, loud], 48_000);
  const view = new DataView(wav.buffer);
  const tag = (at) => String.fromCharCode(...wav.slice(at, at + 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(36), 'data');
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), SPEECH_RATE);
  assert.equal(view.getUint16(34, true), 16);
  const frames = view.getUint32(40, true) / 2;
  assert.equal(frames, 8_000);
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(view.getInt16(44, true), Math.trunc(0.25 * 0x7fff)); // first sample
  assert.equal(view.getInt16(44 + (frames - 1) * 2, true), 0x7fff); // last, clipped
});

test('downsampling averages what each sample spans; the same rate is left alone', () => {
  assert.deepEqual([...resample(new Float32Array([0, 1, 0, 1, 0, 1]), 48_000, 16_000)], [1 / 3, 2 / 3].map(Math.fround));
  const same = new Float32Array([0.1, 0.2]);
  assert.equal(resample(same, 16_000, 16_000), same);
  assert.equal(toWav([], 48_000).length, 44);
});
