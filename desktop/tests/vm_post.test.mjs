import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardClient, createClient, follow, handOff, resolveDestination, runArgs } from '../vm-post.mjs';

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

// The Mac agent once ssh'ed to ~/.ssh/config's one entry (another machine) and timed out
// (2026-11-17); run goes to the VM in vm-agent.json.
test('run reaches the VM in vm-agent.json', () => {
  const config = { ssh: { host: 'vm.example', user: 'ubuntu', identityFile: '/k' }, remoteDir: '/home/ubuntu/hive-vm-agent/app', node: '/usr/local/bin/node' };
  const run = runArgs(config, 'ls ~/hive-files');
  assert.equal(run.at(-2), 'ubuntu@vm.example');
  assert.equal(run.at(-1), 'ls ~/hive-files');
  assert.deepEqual(run.slice(0, 2), ['-i', '/k']);
});

// A board in the cloud: requests, and how each one goes as the VM's orchestrator works on it.
function fakeBoard(states) {
  const posted = [];
  const board = async (path, body) => {
    if (path === '/v1/requests') { posted.push(body); return { ok: true, id: 9, ahead: 0 }; }
    if (path === '/v1/runs/message') { posted.push({ path, ...body }); return { ok: true, request: 9, ahead: 0 }; }
    if (path === '/v1/requests/state?id=9') return { request: { id: 9, ...(states.length > 1 ? states.shift() : states[0]) } };
    throw new Error(`unexpected ${path}`);
  };
  return { board, posted };
}
const quick = { every: 0, sleep: async () => {}, say: () => {} };

// The owner (2026-11-17): "why can't i see the virtual machine agent from this window?" A task run
// over SSH never reached the board; handed through the cloud, it's an agent on every dashboard.
test('task goes to the VM agent through the cloud, says an agent sent it, and waits for how it ended', async () => {
  const { board, posted } = fakeBoard([{ status: 'queued' }, { status: 'working' }, { status: 'done', outcome: 'Posted the thread.' }]);
  const said = [];
  const request = await handOff(board, 'For hive › cloud/vm-agent: post the thread on X\n', { ...quick, wait: 60_000, say: line => said.push(line) });
  assert.deepEqual(posted, [{ text: 'For hive › cloud/vm-agent: [Hive on the Mac, not the owner] post the thread on X', from: 'mac' }]);
  assert.equal(request.status, 'done');
  assert.deepEqual(said.slice(1), ['… queued', '… working', 'Done: Posted the thread.']);
  const plain = fakeBoard([{ status: 'done', outcome: '' }]);
  await handOff(plain.board, 'check the X composer', quick);
  assert.equal(plain.posted[0].text, '[Hive on the Mac, not the owner] check the X composer');
  await assert.rejects(handOff(plain.board, '  ', quick), /say what/);
});

// The owner (2026-11-20): "why can't i view all of the turns as you do that is clearly a bug". Each
// hand-off about one job was a request of its own, so a conversation of its own on the dashboard.
test('more about the same work follows its request, so it shows in that conversation', async () => {
  const { board, posted } = fakeBoard([{ status: 'done', outcome: 'Reposted.' }]);
  const said = [];
  const request = await handOff(board, 'For hive › cloud/vm-agent: post it again with the fixed video', { ...quick, follows: 7, say: line => said.push(line) });
  assert.deepEqual(posted, [{
    path: '/v1/runs/message', request: 7, from: 'mac',
    text: 'For hive › cloud/vm-agent: [Hive on the Mac, not the owner] post it again with the fixed video',
  }]);
  assert.equal(request.id, 9);
  assert.match(said[0], /request 9, following 7/);
});

test('task stops waiting when its time is up and says how to look again', async () => {
  const { board } = fakeBoard([{ status: 'working' }]);
  let t = 0;
  const said = [];
  const request = await follow(board, 9, { every: 1000, wait: 3000, sleep: async ms => { t += ms; }, clock: () => t, say: line => said.push(line) });
  assert.equal(request.status, 'working');
  assert.match(said.at(-1), /^Still working\. .*vm-post\.mjs state 9$/);
});

test('the board client signs each call with the machine token', async () => {
  const calls = [];
  const board = boardClient({ url: 'https://board.example/', token: 'tok' }, async (url, init) => {
    calls.push([url, init]);
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await board('/v1/requests', { text: 'x' });
  await board('/v1/requests/state?id=1');
  assert.equal(calls[0][0], 'https://board.example/v1/requests');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.authorization, 'Bearer tok');
  assert.equal(calls[1][1].method, undefined);
  const failing = boardClient({ url: 'https://b', token: 't' }, async () => ({ ok: false, status: 401, json: async () => ({ error: 'Not signed in.' }) }));
  await assert.rejects(failing('/v1/requests', {}), /Not signed in/);
});
