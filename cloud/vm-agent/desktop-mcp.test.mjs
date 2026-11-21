// Check the fallback through the desktop's own dispatcher, without a screen or a Mac MCP process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answer, BATCHABLE, runBatch } from './desktop-mcp.mjs';

test('the static desktop transfer stays callable after offline discovery and keeps the request identity', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-desktop-transfer-'));
  const config = process.env.HIVE_TASKS_CONFIG;
  const label = process.env.HIVE_TASK_LABEL;
  t.after(() => {
    if (config === undefined) delete process.env.HIVE_TASKS_CONFIG;
    else process.env.HIVE_TASKS_CONFIG = config;
    if (label === undefined) delete process.env.HIVE_TASK_LABEL;
    else process.env.HIVE_TASK_LABEL = label;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.HIVE_TASKS_CONFIG = join(dir, 'board.json');
  process.env.HIVE_TASK_LABEL = 'R42-1';
  writeFileSync(process.env.HIVE_TASKS_CONFIG, JSON.stringify({ url: 'https://board.invalid', token: 'fixture-token' }));
  let connected = false;
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer fixture-token');
    sent.push({ url, body: options.body && JSON.parse(options.body) });
    if (url === 'https://board.invalid/v1/mac/status?tools=1') {
      return Response.json({ macs: connected ? [{ name: 'test-mac', tools: [{ name: 'run_command' }] }] : [] });
    }
    assert.equal(url, 'https://board.invalid/v1/mac/calls');
    // Stop at reading the source: a real Mac error must survive the desktop wrapper intact.
    return Response.json({ call: { id: 1, status: 'done', result: {
      isError: true, content: [{ type: 'text', text: 'Fixture source is missing.' }],
    } } });
  });
  assert.ok((await answer({ id: 1, method: 'initialize' })).result);
  const catalog = await answer({ id: 2, method: 'tools/list' });
  const transfer = catalog.result.tools.find(tool => tool.name === 'transfer_file');
  assert.ok(transfer);
  assert.equal(sent.length, 0, 'discovery cannot delay or remove the static tool');
  const message = { id: 3, method: 'tools/call', params: { name: transfer.name, arguments: {
    direction: 'to_vm', mac_path: '/Users/test/Desktop/clip.mov', step: 'Copying the fixture recording.',
  } } };
  const offline = await answer(message);
  assert.equal(offline.result.isError, true);
  assert.match(offline.result.content[0].text, /Mac isn't connected/);
  connected = true;
  const out = await answer(message);
  assert.equal(out.result.isError, true);
  assert.equal(out.result.content[0].text, 'Fixture source is missing.');
  const calls = sent.filter(call => call.body);
  assert.equal(calls.length, 1, 'no upload after a source error');
  assert.equal(calls[0].body.name, 'run_command');
  assert.equal(calls[0].body.request, 42);
  assert.equal(calls[0].body.arguments.irreversible, false);
  assert.equal(calls[0].body.arguments.step, message.params.arguments.step);
});

test('the callable batch schema includes each action argument', async () => {
  const { result: { tools } } = await answer({ id: 1, method: 'tools/list' });
  const item = tools.find(t => t.name === 'batch').inputSchema.properties.steps.items;
  for (const action of tools.filter(t => BATCHABLE.includes(t.name))) {
    for (const [name, schema] of Object.entries(action.inputSchema.properties)) {
      if (name !== 'step') assert.deepEqual(item.properties[name], schema, `${action.name}.${name}`);
    }
  }
  assert.equal(item.properties.text.type, 'string');
  assert.equal(item.properties.keys.type, 'string');
});

test('a malformed batch fails before an earlier valid action can change the screen', async () => {
  for (const bad of [
    { tool: 'type_text' }, { tool: 'type_text', text: null },
    { tool: 'press_key' }, { tool: 'press_key', keys: 'ctrl+unknown' },
    { tool: 'click', x: 1 }, { tool: 'click', x: NaN, y: 2 },
    { tool: 'click', x: 1, y: 2, button: 'unknown' },
    { tool: 'drag', x: 1, y: 2, to_x: 3 },
    { tool: 'scroll', x: 1, y: 2, amount: 'down' },
    { tool: 'wait', seconds: Infinity },
  ]) {
    await assert.rejects(runBatch([{ tool: 'press_key', keys: 'ctrl+l' }, bad],
      () => assert.fail('no action may run')), /step 2.*nothing was done/);
  }
  const actions = [
    { tool: 'press_key', keys: 'ctrl+l' },
    { tool: 'type_text', text: 'https://example.invalid/fixture' },
    { tool: 'press_key', keys: 'Return' },
    { tool: 'wait', seconds: 1 },
  ];
  const called = [];
  await runBatch(actions, async (tool, args) => { called.push({ tool, ...args }); return 'sent'; });
  assert.deepEqual(called, actions);
});
