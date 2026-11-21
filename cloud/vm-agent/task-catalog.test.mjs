import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSFER_TOOL } from './mac-files.mjs';
import { readTaskCatalog, requestCatalog } from './task-catalog.mjs';

const transfer = { type: 'function', name: 'transfer_file', parameters: TRANSFER_TOOL.inputSchema };
const tools = [{ type: 'namespace', name: 'mcp__desktop', tools: [transfer] }];

test('only a model-visible transfer schema verifies the catalog, including Responses Lite', () => {
  for (const request of [{ tools }, { input: [{ type: 'additional_tools', tools }] },
    { tools: [{ ...transfer, name: 'mcp__desktop__transfer_file' }] }]) {
    assert.equal(requestCatalog(request, 'current').ok, true);
    assert.deepEqual(requestCatalog(request, 'current').tools, ['mcp__desktop.transfer_file']);
  }
  for (const request of [{}, { input: [{ type: 'message', content: [{ text: 'desktop.transfer_file exists' }] }] },
    { tools: [{ ...transfer, name: 'mcp__mac__transfer_file' }] },
    { tools: [{ name: 'mcp__desktop__transfer_file', parameters: { properties: {} } }] }]) {
    assert.equal(requestCatalog(request, 'current').ok, false);
  }
});

test('the catalog comes from this exec thread, not earlier runs or another agent', t => {
  const root = mkdtempSync(join(tmpdir(), 'hive-catalog-read-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'trace-one');
  mkdirSync(join(dir, 'payloads'), { recursive: true });
  const event = thread => ({ thread_id: thread, payload: { type: 'inference_started', request_payload: { path: 'payloads/1.json' } } });
  writeFileSync(join(dir, 'payloads/1.json'), JSON.stringify({ model: 'fixture', tools, input: [{ text: 'Private task words.' }] }));
  writeFileSync(join(dir, 'trace.jsonl'), `${JSON.stringify(event('old'))}\n{`);
  assert.equal(readTaskCatalog(root, 'current'), null);
  assert.equal(readTaskCatalog(root, ''), null);
  writeFileSync(join(dir, 'trace.jsonl'), `${JSON.stringify(event('current'))}\n{`);
  const catalog = readTaskCatalog(root, 'current');
  assert.equal(catalog.ok, true);
  assert.equal(catalog.thread_id, 'current');
  assert.ok(!JSON.stringify(catalog).includes('Private task words'));
  writeFileSync(join(dir, 'payloads/1.json'), '{');
  assert.equal(readTaskCatalog(root, 'current'), null, 'wait for the complete payload');
});
