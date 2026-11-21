// The owner's Mac as an MCP server on the VM (mac-mcp.mjs): its tools are the ones Hive on the Mac put
// on the board, and each call goes through the board and comes back as the Mac tool's own result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFLINE, callMac, connectedMac, requestOf, server } from './mac-mcp.mjs';

const sourceInfo = { content: [{ type: 'text', text: JSON.stringify({ exit_code: 0,
  stdout: JSON.stringify({ size: 1024, sha256: 'a'.repeat(64) }),
}) }] };

const TOOLS = [{ name: 'screenshot', description: 'See the screen.', inputSchema: { type: 'object' } }];

/** A board whose Mac answers each call after `polls` looks. */
function fakeBoard({ macs = [{ name: 'owner-mbp', about: "The user's Mac", tools: TOOLS }], answer, polls = 1 } = {}) {
  const calls = [];
  let looks = 0;
  const board = async (path, body) => {
    calls.push({ path, body });
    if (path === '/v1/mac/status?tools=1') return { macs };
    if (path === '/v1/mac/calls') return { call: { id: 5, status: 'queued' } };
    if (path.startsWith('/v1/mac/calls?id=5')) {
      looks += 1;
      return looks < polls ? { call: { id: 5, status: 'running' } } : { call: { id: 5, status: 'done', ...answer } };
    }
    if (path === '/v1/mac/cancel') return { ok: true };
    throw new Error(`unexpected ${path}`);
  };
  return { board, calls };
}

test("a task's label names its request, so the Mac checks a one-way step against those words", () => {
  assert.equal(requestOf('R12-1'), 12);
  assert.equal(requestOf('vm-task'), null);
  assert.equal(requestOf('a task started by hand'), null);
});

test("the Mac's own tools are listed, and a call comes back as the Mac tool's result, for this request", async () => {
  const result = { content: [{ type: 'text', text: 'Finder is in front.' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] };
  const { board, calls } = fakeBoard({ answer: { result }, polls: 2 });
  const turns = [];
  const answer = server({ board, label: 'R12-1', turn: { use: async fn => { turns.push('take'); return fn(); } } });
  const init = await answer({ id: 1, method: 'initialize', params: {} });
  assert.match(init.result.instructions, /The user's Mac \(owner-mbp\), reached through the cloud/);
  assert.deepEqual((await answer({ id: 2, method: 'tools/list' })).result.tools, TOOLS);
  const out = await answer({ id: 3, method: 'tools/call', params: { name: 'screenshot', arguments: { step: 'Look at the Mac' } } });
  assert.deepEqual(out.result, result);
  assert.deepEqual(turns, ['take']);
  assert.deepEqual(calls.find(c => c.path === '/v1/mac/calls').body,
    { name: 'screenshot', arguments: { step: 'Look at the Mac' }, mac: 'owner-mbp', request: 12, wait: 25 });
  assert.equal(calls.filter(c => c.path === '/v1/mac/status?tools=1').length, 1, 'the Mac is found once a task');
});

test("a task can call only the tools the Mac listed, never Hive's own change jobs on the Mac", async () => {
  const { board, calls } = fakeBoard({ answer: { result: { content: [] } } });
  const answer = server({ board, label: 'R12-1' });
  const out = await answer({ id: 3, method: 'tools/call', params: { name: 'hive_self', arguments: { action: 'install', commit: 'f'.repeat(40) } } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /the Mac has no tool hive_self/);
  assert.ok(!calls.some(c => c.path === '/v1/mac/calls'), 'never sent to the Mac');
});

test("with no Mac connected transfer stays discoverable and a call says why; a failed call says what failed", async () => {
  const none = server({ board: fakeBoard({ macs: [] }).board, label: 'R1-1' });
  assert.equal((await none({ id: 1, method: 'initialize', params: {} })).result.instructions, OFFLINE);
  assert.deepEqual((await none({ id: 2, method: 'tools/list' })).result.tools.map(t => t.name), ['run_command', 'transfer_file']);
  const refused = await none({ id: 3, method: 'tools/call', params: { name: 'click', arguments: {} } });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /Hive isn't running there/);

  const { board } = fakeBoard({ answer: { status: 'lost', error: 'The Mac took it but never answered.' } });
  const out = await callMac(board, await connectedMac(board), 'click', { x: 1, y: 2 });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /The Mac took it but never answered/);
  assert.match(out.content[0].text, /call 5.*may still run or may already have run/);
  assert.match(out.content[0].text, /before retrying/);
});

test('a transfer listed while discovery is unavailable works in the same task once it recovers', { timeout: 1000 }, async () => {
  for (const unavailable of ['offline', 'board error', 'board timeout']) {
    let connected = false;
    const { board, calls } = fakeBoard({ macs: [{ name: 'test-mac', tools: [{ name: 'run_command' }] }], answer: { result: sourceInfo } });
    const turns = [];
    const answer = server({ board: async (path, body) => {
      if (path === '/v1/mac/status?tools=1' && !connected) {
        if (unavailable === 'board error') throw new Error('Board temporarily unavailable');
        if (unavailable === 'board timeout') return new Promise(() => {});
        return { macs: [] };
      }
      return board(path, body);
    }, label: 'R42-1', discoveryMs: 10, turn: { use: async fn => { turns.push('take'); return fn(); } },
    files: { uuid: () => 'copy-id', fetch: async key => `/files/${key}` } });
    await answer({ id: 1, method: 'initialize', params: {} });
    const listed = (await answer({ id: 2, method: 'tools/list' })).result.tools;
    assert.deepEqual(listed.map(t => t.name), ['run_command', 'transfer_file']);
    assert.deepEqual(listed[0].inputSchema.required, ['command', 'irreversible', 'step']);
    assert.equal(listed[1].inputSchema.properties.direction.enum[0], 'to_vm');
    const request = { id: 3, method: 'tools/call', params: { name: 'transfer_file', arguments: {
      direction: 'to_vm', mac_path: '/Desktop/clip.mov', step: 'Copying the clip.',
    } } };
    assert.equal((await answer(request)).result.isError, true);
    assert.deepEqual(turns, [], 'an offline transfer never takes the Mac lease');
    assert.deepEqual(calls, [], 'an offline transfer never submits a command');
    connected = true;
    const copied = await answer({ ...request, id: 4 });
    assert.equal(copied.result.isError, undefined);
    assert.equal(JSON.parse(copied.result.content[0].text).vm_path, '/files/transfers/copy-id/clip.mov');
    assert.deepEqual(turns, ['take']);
    assert.equal(calls.filter(c => c.path === '/v1/mac/calls').length, 2);
    assert.ok(calls.filter(c => c.path === '/v1/mac/calls').every(c => c.body.name === 'run_command' && c.body.request === 42));
    const command = await answer({ id: 5, method: 'tools/call', params: { name: 'run_command', arguments: {
      command: 'pwd', irreversible: false, step: 'Checking the Mac folder.',
    } } });
    assert.deepEqual(command.result, sourceInfo, 'the command learned at startup works after reconnection too');
  }
});

test('without board credentials no transfer is advertised or attempted', async () => {
  const answer = server({ board: null, turn: { use: () => assert.fail('must not take the Mac') } });
  const init = await answer({ id: 0, method: 'initialize', params: {} });
  assert.equal(init.error.code, -32603, 'configuration failure must fail the MCP handshake');
  assert.match(init.error.message, /board configuration/);
  assert.deepEqual((await answer({ id: 1, method: 'tools/list' })).result.tools, []);
  const out = await answer({ id: 2, method: 'tools/call', params: { name: 'transfer_file', arguments: {} } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /couldn't read the board configuration/);
});

test('a lost command reply keeps its call id when known and never submits the command again', async () => {
  for (const failure of ['submit', 'poll', 'missing']) {
    const calls = [];
    const board = async (path, body) => {
      calls.push({ path, body });
      if (path === '/v1/mac/calls') {
        if (failure === 'submit') throw new Error('reply lost');
        return { call: { id: 17, status: 'running' } };
      }
      if (failure === 'poll') throw new Error('reply lost');
      return { call: null };
    };
    const args = { command: 'send-message', irreversible: true, step: 'One-way: sending (you said: "send the message").' };
    const out = await callMac(board, { name: 'test-mac' }, 'run_command', args);
    assert.equal(out.isError, true);
    const message = out.content[0].text;
    assert.match(message, /may still run or may already have run/);
    assert.match(message, /Inspect.*before retrying/);
    assert.match(message, /Do not retry an uncertain send/);
    assert.match(message, failure === 'missing' ? /the board lost the call/ : /reply lost/);
    if (failure !== 'submit') assert.match(message, /call 17/);
    assert.equal(calls.filter(c => c.path === '/v1/mac/calls').length, 1);
    assert.ok(!message.includes(args.command), 'the recovery message need not repeat command contents');
  }
});

test('a command that expired or was cancelled before being taken is reported as not run', async () => {
  for (const status of ['expired', 'cancelled']) {
    const { board } = fakeBoard({ answer: { status, error: 'No Mac took it.' } });
    const out = await callMac(board, { name: 'test-mac' }, 'run_command', {});
    assert.deepEqual(out, { content: [{ type: 'text', text: 'Failed: No Mac took it.' }], isError: true });
  }
});

test('a call the Mac never answers is given up on and cancelled, with the reason', async () => {
  const { board, calls } = fakeBoard({ polls: 1e9 });
  let t = 0;
  const out = await callMac(board, { name: 'owner-mbp' }, 'wait', {}, { now: () => (t += 60_000), sleep: async () => {} });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /didn't answer within 6 minutes/);
  assert.match(out.content[0].text, /call 5.*may still run or may already have run/);
  assert.match(out.content[0].text, /before retrying/);
  assert.deepEqual(calls.at(-1), { path: '/v1/mac/cancel', body: { id: 5 } });
});

test('confirmed cancellation before the Mac takes a timed out call removes the uncertainty', async () => {
  const { board } = fakeBoard({ polls: 1e9 });
  let t = 0;
  const out = await callMac(async (path, body) => path === '/v1/mac/cancel' ? { cancelled: 1 } : board(path, body),
    { name: 'test-mac' }, 'run_command', {}, { now: () => (t += 60_000), sleep: async () => {} });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /didn't answer within 6 minutes/);
  assert.doesNotMatch(out.content[0].text, /may still run/);
});

test('a lost transfer reply returns both the Mac call id and the cloud key for recovery', async () => {
  const { board, calls } = fakeBoard({ macs: [{ name: 'test-mac', tools: [{ name: 'run_command' }] }], answer: { result: sourceInfo } });
  const answer = server({ board: async (path, body) => {
    if (path.startsWith('/v1/mac/calls?id=') && calls.filter(c => c.path === '/v1/mac/calls').length > 1) throw new Error('reply lost');
    return board(path, body);
  }, label: 'R42-1', files: { uuid: () => 'copy-id', fetch: async () => { throw new Error('Object not found'); } } });
  const out = await answer({ id: 1, method: 'tools/call', params: { name: 'transfer_file', arguments: {
    direction: 'to_vm', mac_path: '/Desktop/clip.mov', step: 'Copying the clip.',
  } } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /call 5.*may still run or may already have run/);
  assert.match(out.result.content[1].text, /transfers\/copy-id\/clip.mov/);
  assert.equal(calls.filter(c => c.path === '/v1/mac/calls').length, 2);
});

test('a task can recover a cloud copy before listing tools, and lists the recovery schema', async () => {
  const { board, calls } = fakeBoard({ macs: [{ name: 'test-mac', tools: [{ name: 'run_command' }] }], answer: { result: sourceInfo } });
  const key = 'transfers/earlier/clip.mov';
  const answer = server({ board, files: {
    uuid: () => assert.fail('recovery must keep the old key'),
    fetch: async (actual, expected) => {
      assert.equal(actual, key);
      assert.deepEqual(expected, { size: 1024, sha256: 'a'.repeat(64) });
      return '/files/clip.mov';
    },
  } });
  const out = await answer({ id: 1, method: 'tools/call', params: { name: 'transfer_file', arguments: {
    direction: 'to_vm', mac_path: '/Desktop/clip.mov', recovery_key: key, step: 'Recovering the clip.',
  } } });
  assert.equal(out.result.isError, undefined);
  assert.equal(JSON.parse(out.result.content[0].text).recovered, true);
  assert.equal(calls.filter(c => c.path === '/v1/mac/calls').length, 1, 'only source metadata, no upload');
  const list = (await answer({ id: 2, method: 'tools/list' })).result.tools;
  assert.equal(list.find(t => t.name === 'transfer_file').inputSchema.properties.recovery_key.type, 'string');
});

test('commands and transfers use the same Mac lease and board-supplied request words', async () => {
  const tools = [...TOOLS, { name: 'run_command', inputSchema: { type: 'object' } }];
  const { board, calls } = fakeBoard({ macs: [{ name: 'test-mac', tools }], answer: { result: sourceInfo } });
  const turns = [];
  const answer = server({ board, label: 'R42-1', turn: { use: async fn => { turns.push('take'); return fn(); } },
    files: { uuid: () => 'copy-id', fetch: async key => `/files/${key}` } });
  const list = (await answer({ id: 1, method: 'tools/list' })).result.tools;
  assert.deepEqual(list.map(t => t.name), ['screenshot', 'run_command', 'transfer_file']);
  const args = { command: 'echo hello', step: 'Checking.', irreversible: false };
  await answer({ id: 2, method: 'tools/call', params: { name: 'run_command', arguments: args } });
  assert.deepEqual(calls.find(c => c.path === '/v1/mac/calls').body.arguments, args);
  const copied = await answer({ id: 3, method: 'tools/call', params: {
    name: 'transfer_file', arguments: { direction: 'to_vm', mac_path: '/Desktop/clip.mov', step: 'Copying the clip.' },
  } });
  assert.equal(JSON.parse(copied.result.content[0].text).vm_path, '/files/transfers/copy-id/clip.mov');
  assert.deepEqual(turns, ['take', 'take']);
  assert.ok(calls.filter(c => c.path === '/v1/mac/calls').every(c => c.body.name === 'run_command' && c.body.request === 42));
});


test('a Mac without command support cannot offer or attempt a transfer', async () => {
  const { board, calls } = fakeBoard();
  const answer = server({ board, label: 'R42-1',
    turn: { use: () => assert.fail('must not take the Mac') },
    files: { put: () => assert.fail('must not upload'), fetch: () => assert.fail('must not fetch') } });
  assert.ok(!(await answer({ id: 1, method: 'tools/list' })).result.tools.some(t => t.name === 'transfer_file'));
  const out = await answer({ id: 2, method: 'tools/call', params: { name: 'transfer_file', arguments: {
    direction: 'to_mac', vm_path: '/files/clip.mov', mac_path: '/Desktop/clip.mov', step: 'Copying the clip.',
  } } });
  assert.equal(out.result.isError, true);
  assert.match(out.result.content[0].text, /the Mac has no tool transfer_file/);
  assert.ok(!calls.some(c => c.path === '/v1/mac/calls'));
});
