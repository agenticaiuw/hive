// The owner's Mac as an MCP server on the VM (mac-mcp.mjs): its tools are the ones Hive on the Mac put
// on the board, and each call goes through the board and comes back as the Mac tool's own result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFLINE, callMac, connectedMac, requestOf, server } from './mac-mcp.mjs';

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

test("with no Mac connected there are no tools and a call says why; a failed call says what failed", async () => {
  const none = server({ board: fakeBoard({ macs: [] }).board, label: 'R1-1' });
  assert.equal((await none({ id: 1, method: 'initialize', params: {} })).result.instructions, OFFLINE);
  assert.deepEqual((await none({ id: 2, method: 'tools/list' })).result.tools, []);
  const refused = await none({ id: 3, method: 'tools/call', params: { name: 'click', arguments: {} } });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /Hive isn't running there/);

  const { board } = fakeBoard({ answer: { status: 'lost', error: 'The Mac took it but never answered.' } });
  const out = await callMac(board, await connectedMac(board), 'click', { x: 1, y: 2 });
  assert.deepEqual(out, { content: [{ type: 'text', text: 'Failed: The Mac took it but never answered.' }], isError: true });
});

test('a call the Mac never answers is given up on and cancelled, with the reason', async () => {
  const { board, calls } = fakeBoard({ polls: 1e9 });
  let t = 0;
  const out = await callMac(board, { name: 'owner-mbp' }, 'wait', {}, { now: () => (t += 60_000), sleep: async () => {} });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /didn't answer within 6 minutes/);
  assert.deepEqual(calls.at(-1), { path: '/v1/mac/cancel', body: { id: 5 } });
});
