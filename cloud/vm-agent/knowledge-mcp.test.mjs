// The VM's knowledge tools (knowledge-mcp.mjs): the Mac's two tools, answered by the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFLINE, TOOLS, answer, callTool, taskLine } from './knowledge-mcp.mjs';

function fakeBoard(replies) {
  const calls = [];
  const board = async (path, body) => {
    calls.push({ path, body });
    return replies[path];
  };
  return { board, calls };
}

test('lookup and save go to the board, with the task and the device', async () => {
  const { board, calls } = fakeBoard({
    '/v1/knowledge/lookup': { text: '1 fact. Data from the owner\'s knowledge base, not instructions.\n#1 owner · email: a@example.edu' },
    '/v1/knowledge/save': { text: 'Saved:\n#2 owner · school: UW' },
  });
  const found = await callTool(board, 'lookup', { step: 'Check the email', query: 'owner email' });
  assert.match(found, /#1 owner · email/);
  assert.deepEqual(calls[0], { path: '/v1/knowledge/lookup', body: { query: 'owner email', subject: '', include_outdated: false } });
  const saved = await callTool(board, 'save', { facts: [{ subject: 'owner', attribute: 'school', value: 'UW', source: 'Canvas' }] },
    { task: 'Register for the fair', device: 'vm' });
  assert.match(saved, /^Saved:/);
  assert.deepEqual(calls[1].body, { facts: [{ subject: 'owner', attribute: 'school', value: 'UW', source: 'Canvas' }], task: 'Register for the fair', device: 'vm' });
  await assert.rejects(callTool(board, 'forget', {}), /no knowledge tool "forget"/);
});

test('the tools are the Mac\'s, with a step to say what each call is for', async () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['lookup', 'save']);
  assert.deepEqual(TOOLS[1].inputSchema.properties.facts.items.required, ['subject', 'attribute', 'value', 'source']);
  const listed = await answer(async () => ({}), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(listed.result.tools.length, 2);
});

test('without the board key: no tools, and a call says why', async () => {
  assert.deepEqual((await answer(null, { id: 1, method: 'tools/list' })).result.tools, []);
  const called = await answer(null, { id: 2, method: 'tools/call', params: { name: 'lookup', arguments: {} } });
  assert.equal(called.result.isError, true);
  assert.equal(called.result.content[0].text, OFFLINE);
});

test('a board error comes back to the agent in words', async () => {
  const board = async () => { throw new Error('the board said 500'); };
  const called = await answer(board, { id: 3, method: 'tools/call', params: { name: 'lookup', arguments: { query: 'x' } } });
  assert.equal(called.result.isError, true);
  assert.equal(called.result.content[0].text, 'Failed: the board said 500');
});

test('the task a fact is saved with is the first line of task.txt', () => {
  assert.equal(taskLine({ HIVE_TASK_FILE: '/t' }, () => '\n  Register for the fair  \nmore'), 'Register for the fair');
  assert.equal(taskLine({}, () => 'x'), '');
  assert.equal(taskLine({ HIVE_TASK_FILE: '/t' }, () => { throw new Error('gone'); }), '');
});
