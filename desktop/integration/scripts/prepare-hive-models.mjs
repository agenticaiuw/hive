#!/usr/bin/env node
// Copy only the known local model files into a new private runtime directory.
// It never reads credentials, prints file contents, or modifies the source.
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const files = ['kokoro-v1.0.onnx', 'voices-v1.0.bin', 'silero_vad.onnx', 'voiceprint.npz'];
function hash(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); const h = createHash('sha256');
  try { const buf = Buffer.alloc(1024 * 1024); let n; while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); return h.digest('hex'); } finally { closeSync(fd); }
}
export function prepareModels({ source, destination, apply = false }) {
  source = resolve(source); destination = resolve(destination);
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) throw new Error('Model source must be a real directory');
  if (existsSync(destination)) throw new Error('Destination exists; refusing to overwrite');
  const present = [];
  for (const name of files) {
    let stat;
    try { stat = lstatSync(join(source, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected model source entry');
    present.push(name);
  }
  if (!apply) return { applied: false, count: present.length };
  mkdirSync(dirname(destination), { recursive: true });
  const staging = `${destination}.staging-${randomUUID()}`; mkdirSync(staging, { mode: 0o700 });
  try {
    for (const name of present) {
      const from = join(source, name), to = join(staging, name), before = hash(from);
      const input = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      const output = openSync(to, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { const buffer = Buffer.alloc(1024 * 1024); let n; while ((n = readSync(input, buffer, 0, buffer.length, null)) > 0) { let written = 0; while (written < n) written += writeSync(output, buffer, written, n - written); } fsyncSync(output); }
      finally { closeSync(input); closeSync(output); }
      if (before !== hash(to) || before !== hash(from)) throw new Error('Model changed or copy verification failed');
    }
    // Refuse a destination that appears during the copy. A conflict leaves the
    // private staging directory for review and never overwrites user data.
    if (existsSync(destination)) throw new Error('Destination appeared during copy');
    if (process.platform !== 'darwin') throw new Error('Exclusive directory installation requires macOS');
    execFileSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'rename-exclusive.py'), staging, destination]);
    const fd = openSync(dirname(destination), constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
    return { applied: true, count: present.length };
  } catch (error) { throw new Error(`Model preparation failed; private staging retained: ${staging}`, { cause: error }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3 || (args[2] && args[2] !== '--apply')) { console.error('Usage: node desktop/integration/scripts/prepare-hive-models.mjs SOURCE_MODELS DESTINATION_MODELS [--apply]'); process.exitCode = 1; }
  else try { console.log(JSON.stringify(prepareModels({ source: args[0], destination: args[1], apply: args[2] === '--apply' }))); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
