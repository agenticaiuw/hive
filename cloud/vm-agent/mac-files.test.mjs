import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transferFile } from './mac-files.mjs';
import { fetchFile } from './files.mjs';

const ok = { content: [{ type: 'text', text: '{"exit_code":0}' }] };
const failed = { content: [{ type: 'text', text: 'Could not copy' }], isError: true };
const expected = { size: 43 * 1024 * 1024, sha256: 'a'.repeat(64) };
const info = { content: [{ type: 'text', text: JSON.stringify({ exit_code: 0, stdout: JSON.stringify(expected) }) }] };
const timeout = { isError: true, content: [{ type: 'text', text: JSON.stringify({
  exit_code: 1, stderr: 'unexpected error timeout', timed_out: false,
}) }] };
const key = 'transfers/test-id/recording.mov';
const uuid = () => 'test-id';
const args = { direction: 'to_vm', mac_path: '/Desktop/recording.mov', step: 'Copying the recording.' };
const missing = async () => { throw new Error('Object not found [404]'); };

test('Mac to VM reads source metadata, uploads and fetches with integrity checks', async () => {
  const calls = [];
  const result = await transferFile(args,
    async a => { calls.push(a); return calls.length === 1 ? info : ok; },
    { uuid, fetch: async (k, meta) => { calls.push([k, meta]); return '/files/recording.mov'; } });
  assert.equal(calls[0].irreversible, false);
  assert.equal(calls[0].timeout_seconds, 240);
  assert.match(calls[0].command, /createHash/);
  assert.match(calls[1].command, /cf r2 objects put 'transfers\/test-id\/recording.mov'/);
  assert.match(calls[1].command, /--file '\/Desktop\/recording.mov'/);
  assert.deepEqual(calls[2], [key, expected]);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    key, mac_path: args.mac_path, vm_path: '/files/recording.mov', ...expected, recovered: false,
  });
  assert.ok(calls[1].command.length < 2000, 'video bytes travel outside the mailbox');
});

test('VM to Mac uploads first and creates a new file only after the download succeeds', async () => {
  const calls = [];
  await transferFile({ direction: 'to_mac', vm_path: '/files/recording.mov', mac_path: '/Desktop/new.mov', step: 'Copying it back.' },
    async a => { calls.push(a); return ok; }, { uuid, put: async (...a) => calls.push(a) });
  assert.deepEqual(calls[0], ['/files/recording.mov', key]);
  assert.match(calls[1].command, /Destination already exists/);
  assert.match(calls[1].command, /cf r2 objects get .* > "\$stage\/file"/);
  assert.match(calls[1].command, /linkSync.* "\$stage\/file" "\$target"/);
  assert.doesNotMatch(calls[1].command, /rm.*target/);
});

test('paths and shell metacharacters remain single quoted words', async () => {
  const calls = [];
  await transferFile({ ...args, mac_path: "/Desktop/it's $(touch nope); recording.mov" },
    async a => { calls.push(a.command); return calls.length === 1 ? info : ok; }, { uuid, fetch: async () => '/files/copy.mov' });
  const quoted = "'/Desktop/it'\\''s $(touch nope); recording.mov'";
  assert.ok(calls.every(command => command.includes(quoted)));
  for (const invalid of [
    { direction: 'other', mac_path: '/x' }, { direction: 'to_vm', mac_path: 'relative' },
    { direction: 'to_mac', mac_path: '/x' }, { direction: 'to_vm', mac_path: '/x\0' },
    { recovery_key: '../x' }, { recovery_key: 'unrelated/x' },
    { direction: 'to_mac', vm_path: '/files/x', recovery_key: key },
  ]) {
    await assert.rejects(transferFile({ ...args, ...invalid }, () => assert.fail('must not run'), { uuid }));
  }
});

test('an upload timeout or lost reply recovers a verified cloud copy without another upload', async () => {
  for (const upload of [() => timeout, () => { throw new Error('board offline'); }]) {
    let ran = 0;
    const result = await transferFile(args, async () => ++ran === 1 ? info : upload(),
      { uuid, fetch: async (k, meta) => { assert.equal(k, key); assert.deepEqual(meta, expected); return '/files/copy.mov'; } });
    assert.equal(ran, 2);
    assert.equal(JSON.parse(result.content[0].text).recovered, true);
    assert.ok(!result.isError);
  }
});

test('a confirmed upload timeout checks the cloud before one retry with the same key', async () => {
  const events = [];
  let ran = 0;
  let fetched = 0;
  const result = await transferFile(args, async a => {
    events.push(a.command);
    return ++ran === 1 ? info : ran === 2 ? timeout : ok;
  }, { uuid, fetch: async () => { events.push('fetch'); if (++fetched === 1) return missing(); return '/files/copy.mov'; } });
  assert.equal(ran, 3);
  assert.equal(fetched, 2);
  assert.equal(events[1], events[3], 'retry uses the same cloud key');
  assert.equal(events[2], 'fetch');
  assert.ok(!result.isError);
});

test('repeated timeouts stop after two uploads and keep both Mac and VM diagnostics', async () => {
  let ran = 0;
  const result = await transferFile(args, async () => ++ran === 1 ? info : timeout, { uuid, fetch: missing });
  assert.equal(ran, 3);
  assert.equal(result.isError, true);
  assert.deepEqual(result.content[0], timeout.content[0]);
  assert.match(result.content[1].text, /2 upload attempt/);
  assert.match(result.content[1].text, /Object not found \[404\]/);
  assert.ok(result.content[1].text.includes(`recovery_key=${key}`));
  assert.ok(result.content[1].text.includes(String(expected.size)));
});

test('uncertain calls and non-transient failures are inspected but never uploaded twice', async () => {
  for (const upload of [() => failed, () => { throw new Error('board offline'); }, () => ({
    isError: true, content: [{ type: 'text', text: JSON.stringify({ exit_code: null, timed_out: true, stderr: 'timeout' }) }],
  })]) {
    let ran = 0;
    const result = await transferFile(args, async () => ++ran === 1 ? info : upload(), { uuid, fetch: missing });
    assert.equal(ran, 2);
    assert.equal(result.isError, true);
    assert.match(result.content.at(-1).text, /recovery_key=transfers\/test-id\/recording.mov/);
  }
});

test('recovery_key inspects and verifies the old copy without uploading or generating a new key', async () => {
  let ran = 0;
  const deps = { uuid: () => assert.fail('must retain the key'), fetch: async (k, meta) => {
    assert.equal(k, key); assert.deepEqual(meta, expected); return '/files/copy.mov';
  } };
  const command = async a => { ran++; assert.doesNotMatch(a.command, /cf r2 objects put/); return info; };
  const result = await transferFile({ ...args, recovery_key: key }, command, deps);
  assert.equal(ran, 1);
  assert.equal(JSON.parse(result.content[0].text).recovered, true);
  await assert.rejects(transferFile({ ...args, recovery_key: key }, command, { ...deps, fetch: missing }), /Retry without recovery_key/);
});

test('missing source metadata prevents uploads, and failed verification never reports success', async () => {
  for (const metadata of [failed, ok, { content: [{ type: 'text', text: '{"exit_code":0,"stdout":"{}"}' }] }]) {
    let ran = 0;
    try {
      const result = await transferFile(args, async () => { ran++; return metadata; }, { uuid, fetch: () => assert.fail('must not fetch') });
      assert.equal(result.isError, true);
    } catch (error) { assert.match(error.message, /no upload started/); }
    assert.equal(ran, 1);
  }
  let ran = 0;
  const result = await transferFile(args, async () => ++ran === 1 ? info : ok, {
    uuid, fetch: async () => { throw new Error('SHA-256 mismatch'); },
  });
  assert.equal(result.isError, true);
  assert.match(result.content.at(-1).text, /SHA-256 mismatch/);
  assert.equal(ran, 2);
});

test('a failed or lost Mac download keeps the uploaded key and original error for recovery', async () => {
  let uploaded;
  const back = { ...args, direction: 'to_mac', vm_path: '/files/recording.mov' };
  const deps = { uuid, put: async (...a) => { uploaded = a; } };
  const result = await transferFile(back, async () => failed, deps);
  assert.deepEqual(uploaded, ['/files/recording.mov', key]);
  assert.equal(result.isError, true);
  assert.deepEqual(result.content[0], failed.content[0]);
  assert.match(result.content[1].text, /was uploaded.*transfers\/test-id\/recording.mov/);
  await assert.rejects(transferFile(back, async () => { throw new Error('board offline'); }, deps), /board offline.*was uploaded.*before retrying/);
  await assert.rejects(transferFile(back, () => assert.fail('must not download'), {
    uuid, put: async () => { throw new Error('upload failed'); },
  }), /upload failed/);
});

test('the command workflow copies a 109 MB recording both ways without clobbering or keeping partial downloads', async () => {
  const { mkdtemp, mkdir, writeFile, open, stat, readFile, readdir, rm, copyFile, symlink } = await import('node:fs/promises');
  const { createReadStream } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createHash } = await import('node:crypto');
  const dir = await mkdtemp(join(tmpdir(), 'hive-transfer-'));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const cloud = join(dir, 'cloud');
    await writeFile(join(bin, 'cf'), `#!/bin/sh
if [ "$3" = put ]; then
  cp "$8" "$CLOUD_FILE"
  if [ "$UPLOAD_TIMEOUT" = 1 ]; then echo 'unexpected error timeout' >&2; exit 1; fi
else
  if [ "$FAIL_DOWNLOAD" = 1 ]; then printf partial; exit 1; fi
  if [ -n "$RACE_TARGET" ]; then mkdir "$RACE_TARGET"; fi
  cat "$CLOUD_FILE"
fi
`, { mode: 0o700 });
    const source = join(dir, "recording ' $(touch unwanted).mov");
    const file = await open(source, 'w');
    const size = 109 * 1024 * 1024;
    await file.truncate(size);
    await file.write(Buffer.from('start'), 0, 5, 0);
    await file.write(Buffer.from('end'), 0, 3, size - 3);
    await file.close();
    const vm = join(dir, 'vm.mov');
    const mac = join(dir, 'mac.mov');
    let fail = false;
    let raceTarget = '';
    let uploadTimeout = false;
    let uploads = 0;
    const output = join(dir, 'command.stdout');
    const run = async ({ command }) => {
      if (command.includes('cf r2 objects put')) uploads++;
      try {
        // A regular file also captures Node output in sandboxes that restrict child pipes.
        const { stderr } = await promisify(execFile)('/bin/sh', ['-c', `(\n${command}\n) > "$COMMAND_STDOUT"`], { cwd: dir,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLOUD_FILE: cloud, COMMAND_STDOUT: output,
            FAIL_DOWNLOAD: fail ? '1' : '0', RACE_TARGET: raceTarget, UPLOAD_TIMEOUT: uploadTimeout ? '1' : '0' } });
        const stdout = await readFile(output, 'utf8');
        return { content: [{ type: 'text', text: JSON.stringify({ exit_code: 0, stdout, stderr, timed_out: false }) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({
          exit_code: error.code, stdout: await readFile(output, 'utf8'), stderr: error.stderr, timed_out: false,
        }) }] };
      }
    };
    const deps = { uuid, fetch: (key, expected) => fetchFile('vm.mov', dir, {
      expected, run: async (_, args) => copyFile(cloud, args[2]),
    }), put: async path => copyFile(path, cloud) };
    const step = 'Copying the recording.';
    assert.ok(!(await transferFile({ direction: 'to_vm', mac_path: source, step }, run, deps)).isError);
    assert.equal((await stat(vm)).size, size);
    uploadTimeout = true;
    const recovered = await transferFile({ direction: 'to_vm', mac_path: source, step }, run, deps);
    assert.equal(JSON.parse(recovered.content[0].text).recovered, true);
    assert.equal(uploads, 2, 'a completed upload is recovered without repeating it');
    uploadTimeout = false;
    assert.ok(!(await transferFile({ direction: 'to_mac', vm_path: vm, mac_path: mac, step }, run, deps)).isError);
    const hash = async path => {
      const h = createHash('sha256');
      for await (const chunk of createReadStream(path)) h.update(chunk);
      return h.digest('hex');
    };
    assert.equal(await hash(mac), await hash(source));
    await writeFile(mac, 'keep this');
    assert.equal((await transferFile({ direction: 'to_mac', vm_path: vm, mac_path: mac, step }, run, deps)).isError, true);
    assert.equal(await readFile(mac, 'utf8'), 'keep this');
    await rm(mac);
    await symlink(join(dir, 'missing.mov'), mac);
    assert.equal((await transferFile({ direction: 'to_mac', vm_path: vm, mac_path: mac, step }, run, deps)).isError, true);
    await assert.rejects(stat(join(dir, 'missing.mov')), { code: 'ENOENT' }, 'a dangling symlink is not followed');
    await rm(mac);
    await mkdir(mac);
    assert.equal((await transferFile({ direction: 'to_mac', vm_path: vm, mac_path: mac, step }, run, deps)).isError, true);
    assert.deepEqual(await readdir(mac), [], 'an existing directory is not used as the destination');
    await rm(mac, { recursive: true });
    raceTarget = mac;
    assert.equal((await transferFile({ direction: 'to_mac', vm_path: vm, mac_path: mac, step }, run, deps)).isError, true,
      'a destination created during the download is refused');
    assert.deepEqual(await readdir(mac), [], 'a new directory is not used as the destination either');
    await rm(mac, { recursive: true });
    raceTarget = '';
    fail = true;
    assert.equal((await transferFile({ direction: 'to_mac', vm_path: vm, mac_path: mac, step }, run, deps)).isError, true);
    await assert.rejects(stat(mac), { code: 'ENOENT' });
    assert.ok(!(await readdir(dir)).some(name => name.startsWith('.hive-transfer.') || name === 'unwanted'));
    assert.equal((await stat(source)).size, size, 'the source survives every transfer');
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('a transfer probe requires a live harmless command reply without touching files', async () => {
  const unused = () => assert.fail('a probe has no file effects');
  const calls = [];
  const result = await transferFile({ ...args, check_only: true }, async call => { calls.push(call); return ok; }, { uuid: unused, fetch: unused, put: unused });
  assert.deepEqual(calls, [{ command: '/usr/bin/true', irreversible: false, step: args.step, timeout_seconds: 15 }]);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ready: true, copied: false, direction: 'to_vm', mac_path: args.mac_path,
  });
  for (const invalid of [{ mac_path: 'relative' }, { check_only: 'true' }, { direction: 'to_mac' }]) {
    await assert.rejects(transferFile({ ...args, check_only: true, ...invalid }, unused));
  }
});

test('a stale Mac heartbeat or malformed command reply cannot pass a live probe', async () => {
  for (const reply of [{}, { content: [{ type: 'text', text: '{"exit_code":1}' }] },
    { content: [{ type: 'text', text: '{"exit_code":0,"timed_out":true}' }] }]) {
    await assert.rejects(transferFile({ ...args, check_only: true }, async () => reply), /did not answer the transfer probe/);
  }
  assert.deepEqual(await transferFile({ ...args, check_only: true }, async () => failed), failed);
});
