import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudFailure, fetchFile } from './files.mjs';

test('cloud errors retain the cause before the Wrangler log notice, stdout and process status', () => {
  const error = cloudFailure({ code: 1, signal: null }, 'Request ID: test-request',
    '\u001b[31mERROR: Object not found [10007]\u001b[0m\nLogs were written to /tmp/wrangler.log');
  assert.match(error.message, /Object not found \[10007\]/);
  assert.match(error.message, /Logs were written to \/tmp\/wrangler.log/);
  assert.match(error.message, /Request ID: test-request/);
  assert.match(error.message, /code=1, signal=none, killed=false/);
  assert.doesNotMatch(error.message, /\u001b/);
  assert.match(cloudFailure({ code: 'ENOENT' }, '', '').message, /code=ENOENT/);
  assert.match(cloudFailure({ signal: 'SIGTERM', killed: true }, '', '').message, /signal=SIGTERM, killed=true/);
  const long = cloudFailure({ code: 1 }, '', `first error\n${'x'.repeat(20000)}\nlast notice`).message;
  assert.match(long, /first error/);
  assert.match(long, /output truncated/);
  assert.match(long, /last notice/);
  assert.ok(long.length < 8300);
});

test('downloads verify size and hash before replacing a file and remove failed staging files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-files-'));
  const bytes = Buffer.from('a video fixture');
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const key = 'clip.mov';
  const path = join(root, key);
  try {
    await writeFile(path, 'keep this');
    for (const body of [Buffer.from('short'), Buffer.from('b video fixture')]) {
      await assert.rejects(fetchFile(key, root, { expected, run: async (_, args) => writeFile(args[2], body) }), /mismatch/);
      assert.equal(await readFile(path, 'utf8'), 'keep this');
      assert.deepEqual(await readdir(root), [key]);
    }
    await assert.rejects(fetchFile(key, root, { expected, run: async (_, args) => {
      await writeFile(args[2], 'partial');
      throw cloudFailure({ code: 1 }, '', 'Authentication error\nLogs were written to /tmp/wrangler.log');
    } }), /Could not fetch cloud key clip.mov.*\nAuthentication error/);
    assert.equal(await readFile(path, 'utf8'), 'keep this');
    assert.deepEqual(await readdir(root), [key]);
    const local = await fetchFile(key, root, { expected, run: async (script, args) => {
      assert.doesNotMatch(script, />\/dev\/null/);
      assert.equal(args[1], key);
      await writeFile(args[2], bytes);
    } });
    assert.equal(local, path);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(await readdir(root), [key]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('simultaneous fetches of one key use separate staging files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-files-'));
  try {
    const stages = [];
    let release;
    const both = new Promise(resolve => { release = resolve; });
    const run = async (_, args) => {
      stages.push(args[2]);
      await writeFile(args[2], 'complete');
      if (stages.length === 2) release();
      await both;
    };
    const paths = await Promise.all([fetchFile('clip.mov', root, { run }), fetchFile('clip.mov', root, { run })]);
    assert.equal(new Set(stages).size, 2);
    assert.equal(paths[0], paths[1]);
    assert.equal(await readFile(paths[0], 'utf8'), 'complete');
    assert.deepEqual(await readdir(root), ['clip.mov']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
