import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transferFile } from './mac-files.mjs';

const ok = { content: [{ type: 'text', text: '{"exit_code":0}' }] };
const failed = { content: [{ type: 'text', text: 'Could not copy' }], isError: true };
const key = 'transfers/test-id/recording.mov';
const uuid = () => 'test-id';

test('Mac to VM copies through the cloud before fetching, with no file bytes in the mailbox', async () => {
  const calls = [];
  const result = await transferFile({ direction: 'to_vm', mac_path: '/Desktop/recording.mov', step: 'Copying the recording.' },
    async args => { calls.push(args); return ok; }, { uuid, fetch: async k => { calls.push(k); return '/files/recording.mov'; } });
  assert.equal(calls[0].irreversible, false);
  assert.equal(calls[0].timeout_seconds, 240);
  assert.match(calls[0].command, /cf r2 objects put 'transfers\/test-id\/recording.mov'/);
  assert.match(calls[0].command, /--file '\/Desktop\/recording.mov'/);
  assert.equal(calls[1], key);
  assert.deepEqual(JSON.parse(result.content[0].text), { key, mac_path: '/Desktop/recording.mov', vm_path: '/files/recording.mov' });
  assert.ok(calls[0].command.length < 2000, 'even a 109 MB recording travels outside the mailbox');
});

test('VM to Mac uploads first and creates a new file only after the download succeeds', async () => {
  const calls = [];
  await transferFile({ direction: 'to_mac', vm_path: '/files/recording.mov', mac_path: '/Desktop/new.mov', step: 'Copying it back.' },
    async args => { calls.push(args); return ok; }, { uuid, put: async (...args) => calls.push(args) });
  assert.deepEqual(calls[0], ['/files/recording.mov', key]);
  assert.match(calls[1].command, /Destination already exists/);
  assert.match(calls[1].command, /cf r2 objects get .* > "\$stage\/file"/);
  assert.match(calls[1].command, /linkSync.* "\$stage\/file" "\$target"/);
  assert.doesNotMatch(calls[1].command, /rm.*target/);
});

test('paths and shell metacharacters remain single quoted words', async () => {
  let command;
  await transferFile({ direction: 'to_vm', mac_path: "/Desktop/it's $(touch nope); recording.mov", step: 'Copying.' },
    async a => { command = a.command; return ok; }, { uuid, fetch: async () => '/files/copy.mov' });
  assert.ok(command.includes("--file '/Desktop/it'\\''s $(touch nope); recording.mov'"));
  for (const args of [
    { direction: 'other', mac_path: '/x' }, { direction: 'to_vm', mac_path: 'relative' },
    { direction: 'to_mac', mac_path: '/x' }, { direction: 'to_vm', mac_path: '/x\0' },
  ]) {
    await assert.rejects(transferFile({ step: 'Copy.', ...args }, () => assert.fail('must not run'), { uuid }));
  }
});

test('failures stop the transfer, keep the cloud key for recovery, and never retry the Mac command', async () => {
  let ran = 0;
  const args = { direction: 'to_vm', mac_path: '/Desktop/recording.mov', step: 'Copying.' };
  const result = await transferFile(args, async () => { ran++; return failed; },
    { uuid, fetch: () => assert.fail('must not fetch') });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content[0], failed.content[0], 'keep the Mac failure details');
  assert.match(result.content[1].text, /may have uploaded.*transfers\/test-id\/recording.mov/);
  assert.match(result.content[1].text, /before retrying/);
  assert.equal(ran, 1);
  await assert.rejects(transferFile(args, async () => ok,
    { uuid, fetch: async () => { throw new Error('offline'); } }), /Copied to cloud key transfers\/test-id\/recording.mov.*offline/);
  await assert.rejects(transferFile({ ...args, direction: 'to_mac', vm_path: '/files/a' },
    () => assert.fail('must not download'), { uuid, put: async () => { throw new Error('upload failed'); } }), /upload failed/);
});

test('lost Mac replies report the cloud key without claiming the transfer finished or running it again', async () => {
  for (const direction of ['to_vm', 'to_mac']) {
    let ran = 0;
    let uploaded = false;
    const args = { direction, mac_path: '/Desktop/copy.mov', vm_path: '/files/recording.mov', step: 'Copying.' };
    const deps = { uuid, fetch: () => assert.fail('must not fetch'), put: async () => { uploaded = true; } };
    await assert.rejects(transferFile(args, async () => { ran++; throw new Error('board offline'); }, deps), error => {
      assert.match(error.message, /board offline/);
      assert.ok(error.message.includes(`transfers/test-id/${direction === 'to_vm' ? 'copy.mov' : 'recording.mov'}`));
      assert.match(error.message, direction === 'to_vm' ? /may have uploaded/ : /was uploaded/);
      assert.match(error.message, /before retrying/);
      if (direction === 'to_mac') assert.ok(error.message.includes(args.mac_path));
      return true;
    });
    assert.equal(ran, 1);
    assert.equal(uploaded, direction === 'to_mac');
  }
});

test('a failed Mac download keeps the uploaded key and the original error for recovery', async () => {
  let uploaded;
  const result = await transferFile({ direction: 'to_mac', mac_path: '/Desktop/copy.mov',
    vm_path: '/files/recording.mov', step: 'Copying.' }, async () => failed,
  { uuid, put: async (...args) => { uploaded = args; } });
  assert.deepEqual(uploaded, ['/files/recording.mov', key]);
  assert.equal(result.isError, true);
  assert.deepEqual(result.content[0], failed.content[0]);
  assert.match(result.content[1].text, /was uploaded.*transfers\/test-id\/recording.mov/);
  assert.match(result.content[1].text, /\/Desktop\/copy.mov.*before retrying/);
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
if [ "$3" = put ]; then cp "$8" "$CLOUD_FILE"; else
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
    const run = async ({ command }) => {
      try {
        await promisify(execFile)('/bin/sh', ['-c', command], { cwd: dir,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLOUD_FILE: cloud,
            FAIL_DOWNLOAD: fail ? '1' : '0', RACE_TARGET: raceTarget } });
        return ok;
      } catch { return failed; }
    };
    const deps = { uuid, fetch: async () => { await copyFile(cloud, vm); return vm; }, put: async path => copyFile(path, cloud) };
    const step = 'Copying the recording.';
    assert.ok(!(await transferFile({ direction: 'to_vm', mac_path: source, step }, run, deps)).isError);
    assert.equal((await stat(vm)).size, size);
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
