import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, resolveDestination } from '../vm-post.mjs';

// A stand-in for the VM worker that records what the Mac asked it to do.
function fakeVm({ loginState = 'signed_in' } = {}) {
  const calls = [];
  const run = async (command, { input, argument } = {}) => {
    calls.push([command, Buffer.isBuffer(input) ? `<${input.length} bytes>` : input, argument].filter(value => value !== undefined));
    if (command === 'upload') return { uploadId: `${'a'.repeat(64)}.png`, bytes: input.length };
    if (command === 'draft') return { id: 'p1', status: 'drafted', digest: 'd'.repeat(64), label: '#general — Club', destination: input.destination, text: input.text.trim(), loginState };
    if (command === 'send') return { id: input.id, status: 'sent', detail: { messageId: '42' } };
    return { id: input?.id, status: command === 'cancel' ? 'cancelled' : 'approved' };
  };
  return { run, calls };
}

const post = { platform: 'discord', destination: 'https://discord.com/channels/123456789012345678/234567890123456789', text: 'hello club\n' };

test('nothing is approved or sent when the owner declines', async () => {
  const vm = fakeVm(); const shown = [];
  const result = await createClient({ run: vm.run, confirm: view => { shown.push(view); return false; } }).send(post);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(vm.calls.map(call => call[0]), ['draft', 'cancel']);
  assert.deepEqual(shown, [{ label: '#general — Club', destination: post.destination, text: 'hello club', attachments: [] }], 'the owner sees the text the VM stored');
});

test('an accepted post approves the drafted digest and sends once, with uploads first', async () => {
  const vm = fakeVm();
  const result = await createClient({ run: vm.run, confirm: () => true, read: () => Buffer.from('png') }).send({ ...post, files: ['/tmp/My Shot.png'] });
  assert.deepEqual(result, { status: 'sent', id: 'p1', detail: { messageId: '42' } });
  assert.deepEqual(vm.calls.map(call => call[0]), ['upload', 'draft', 'approve', 'send']);
  assert.deepEqual(vm.calls[0], ['upload', '<3 bytes>', 'My_Shot.png']);
  assert.deepEqual(vm.calls[1][1].attachments, [`${'a'.repeat(64)}.png`]);
  assert.deepEqual(vm.calls[2][1], { id: 'p1', digest: 'd'.repeat(64) });
});

test('a signed-out VM stops before asking the owner to approve anything', async () => {
  const vm = fakeVm({ loginState: 'needs_login' }); let asked = false;
  const result = await createClient({ run: vm.run, confirm: () => { asked = true; return true; } }).send(post);
  assert.equal(result.status, 'needs_login');
  assert.equal(asked, false);
  assert.deepEqual(vm.calls.map(call => call[0]), ['draft', 'cancel']);
});

test('destinations resolve from names, channel links and x', () => {
  const config = { destinations: { club: { platform: 'discord', destination: post.destination } } };
  assert.deepEqual(resolveDestination(config, 'club'), config.destinations.club);
  assert.deepEqual(resolveDestination(config, 'x'), { platform: 'x', destination: 'post' });
  assert.equal(resolveDestination(config, post.destination).platform, 'discord');
  assert.throws(() => resolveDestination(config, 'nowhere'), /unknown destination/);
});
