import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareModels } from '../scripts/prepare-hive-models.mjs';

test('model migration preserves bytes privately and refuses overwrite or symlinks', { skip: process.platform !== 'darwin' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-runtime-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'source'), destination = join(dir, 'dest'); mkdirSync(source);
  writeFileSync(join(source, 'kokoro-v1.0.onnx'), 'fixture-model'); writeFileSync(join(source, 'voiceprint.npz'), 'fixture-private');
  assert.deepEqual(prepareModels({ source, destination }), { applied: false, count: 2 });
  assert.deepEqual(prepareModels({ source, destination, apply: true }), { applied: true, count: 2 });
  assert.equal(readFileSync(join(destination, 'voiceprint.npz'), 'utf8'), 'fixture-private');
  assert.equal(statSync(join(destination, 'voiceprint.npz')).mode & 0o777, 0o600);
  assert.throws(() => prepareModels({ source, destination, apply: true }), /refusing to overwrite/);
  symlinkSync('/etc/passwd', join(source, 'silero_vad.onnx'));
  assert.throws(() => prepareModels({ source, destination: join(dir, 'other'), apply: true }), /Unexpected/);
});
