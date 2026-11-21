import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSFER_TOOL } from './mac-files.mjs';
import { needsTransferProbe, readTaskCatalog, requestCatalog } from './task-catalog.mjs';
import { againBrief } from './improve.mjs';

const transfer = { type: 'function', name: 'transfer_file', parameters: TRANSFER_TOOL.inputSchema };
const tools = [{ type: 'namespace', name: 'mcp__hivefiles', tools: [transfer] }];
const exec = { type: 'custom', name: 'exec', description: `exec tool declaration:
\`\`\`ts
declare const tools: { mcp__hivefiles__transfer_file(args: {
  check_only?: boolean;
  direction: "to_vm" | "to_mac";
  mac_path: string;
  step: string;
}): Promise<CallToolResult>; };
\`\`\`` };
const codeTools = [{ type: 'namespace', name: 'functions', tools: [exec] }];

test('a thread-bound transfer is callable without any model-visible MCP namespace', () => {
  const direct = [{ type: 'namespace', name: 'hivefiles', tools: [transfer] }];
  const declaration = exec.description.replace('mcp__hivefiles__', 'hivefiles__');
  const code = [{ type: 'namespace', name: 'functions', tools: [{ ...exec, description: declaration }] }];
  for (const catalog of [direct, code, [{ ...transfer, name: 'hivefiles__transfer_file' }]]) {
    for (const request of [{ tools: catalog }, { input: [{ type: 'additional_tools', tools: catalog }] }]) {
      const verdict = requestCatalog(request, 'current');
      assert.equal(verdict.ok, true);
      assert.ok([...verdict.tools, ...verdict.code_tools].includes('hivefiles.transfer_file'));
    }
  }
  assert.equal(requestCatalog({ tools: [...direct, { type: 'namespace', name: 'functions',
    tools: [{ ...exec, description: '' }] }] }, 'current').ok, false);
  assert.equal(requestCatalog({ tools: [{ type: 'namespace', name: 'functions',
    tools: [{ ...exec, description: declaration.replace('check_only?: boolean;', '') }] }] }, 'current').ok, false);
});

test('only transfer repair continuations need a live probe before acting', () => {
  assert.equal(needsTransferProbe('Use the VM browser.'), false);
  assert.equal(needsTransferProbe(againBrief('Continue.', { what: 'Fix browser zoom' }, 'fixture')), false);
  for (const what of ['Expose a Mac-to-VM transfer tool', 'Restore Mac file tools']) {
    assert.equal(needsTransferProbe(againBrief('Continue.', { what }, 'fixture')), true);
  }
});

test('the desktop fallback verifies a callable transfer schema on the active surface', () => {
  const desktop = [{ ...tools[0], name: 'mcp__desktop' }];
  const desktopExec = [{ type: 'namespace', name: 'functions', tools: [
    { ...exec, description: exec.description.replace('mcp__hivefiles', 'mcp__desktop') },
  ] }];
  for (const catalog of [desktop, desktopExec]) {
    assert.equal(requestCatalog({ tools: catalog }, 'current').ok, true);
    assert.equal(requestCatalog({ input: [{ type: 'additional_tools', tools: catalog }] }, 'current').ok, true);
  }
  assert.equal(requestCatalog({ tools: [...desktop,
    { type: 'namespace', name: 'functions', tools: [{ ...exec, description: '' }] },
  ] }, 'current').ok, false, 'a direct fallback cannot prove code-mode exposure');
  assert.equal(requestCatalog({ tools: [{ type: 'function', name: 'mcp__desktop__transfer_file',
    parameters: { properties: {} } }] }, 'current').ok, false);
});

test('code mode requires the transfer in exec itself, including Responses Lite', () => {
  for (const request of [{ tools: codeTools }, { input: [{ type: 'additional_tools', tools: codeTools }] }]) {
    const catalog = requestCatalog(request, 'current');
    assert.equal(catalog.ok, true);
    assert.deepEqual(catalog.code_tools, ['mcp__hivefiles.transfer_file']);
  }
  for (const description of ['', 'mcp__hivefiles__transfer_file is available',
    exec.description.replace('check_only?: boolean;', 'check_only?: string;'),
    exec.description.replace('"to_vm" | ', ''),
    exec.description.replace('mcp__hivefiles__transfer_file', 'mcp__mac__transfer_file')]) {
    assert.equal(requestCatalog({ tools: [...tools,
      { type: 'namespace', name: 'functions', tools: [{ ...exec, description }] }],
      input: [{ type: 'message', content: [{ text: exec.description }] }],
    }, 'current').ok, false, 'a direct schema or task words cannot prove code-mode exposure');
  }
});

test('code-mode evidence requires the callable declaration in exec, not a mention or prompt', () => {
  const declaration = `declare const tools: { mcp__hivefiles__transfer_file(args: {
  check_only?: boolean;
  direction: "to_vm" | "to_mac";
  mac_path: string;
  step: string;
}): Promise<CallToolResult>; };`;
  const request = description => ({ input: [{ type: 'additional_tools', tools: [
    { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description }] },
  ] }] });
  assert.equal(requestCatalog(request(declaration), 'current').ok, true);
  for (const description of ['tools.mcp__hivefiles__transfer_file exists',
    declaration.replace('check_only?: boolean;', 'check_only?: string;'),
    declaration.replace('"to_vm"', '"from_vm"'),
    declaration.replace('check_only?: boolean;', '// check_only?: boolean;')]) {
    assert.equal(requestCatalog(request(description), 'current').ok, false);
  }
  assert.equal(requestCatalog({ input: [{ type: 'message', content: declaration }] }, 'current').ok, false);
});

test('only a model-visible transfer schema verifies the catalog, including Responses Lite', () => {
  for (const request of [{ tools }, { input: [{ type: 'additional_tools', tools }] },
    { tools: [{ ...transfer, name: 'mcp__hivefiles__transfer_file' }] }]) {
    assert.equal(requestCatalog(request, 'current').ok, true);
    assert.deepEqual(requestCatalog(request, 'current').tools, ['mcp__hivefiles.transfer_file']);
  }
  for (const request of [{}, { input: [{ type: 'message', content: [{ text: 'desktop.transfer_file exists' }] }] },
    { tools: [{ ...transfer, name: 'mcp__mac__transfer_file' }] },
    { tools: [{ name: 'mcp__hivefiles__transfer_file', parameters: { properties: {} } }] }]) {
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

test("a request chained onto the last one (Codex's next step after a tool call) keeps that catalog", t => {
  // Live on the VM 2026-11-21: after the first screenshot Codex sent only the tool's output with
  // previous_response_id and no tools, and the check stopped every task there as "did not receive".
  const root = mkdtempSync(join(tmpdir(), 'hive-catalog-chain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'trace-one');
  mkdirSync(join(dir, 'payloads'), { recursive: true });
  const event = n => ({ thread_id: 'current', payload: { type: 'inference_started', request_payload: { path: `payloads/${n}.json` } } });
  writeFileSync(join(dir, 'payloads/1.json'), JSON.stringify({ model: 'fixture', input: [{ type: 'additional_tools', tools }, { type: 'message' }] }));
  writeFileSync(join(dir, 'payloads/2.json'), JSON.stringify({ model: 'fixture', previous_response_id: 'resp_1', input: [{ type: 'custom_tool_call_output' }] }));
  writeFileSync(join(dir, 'trace.jsonl'), `${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n`);
  const catalog = readTaskCatalog(root, 'current');
  assert.equal(catalog.ok, true);
  assert.equal(catalog.requests, 1);
  // A chained request that does declare tools is checked like any other.
  writeFileSync(join(dir, 'payloads/2.json'), JSON.stringify({ model: 'fixture', previous_response_id: 'resp_1', tools: [{ type: 'function', name: 'other' }] }));
  assert.equal(readTaskCatalog(root, 'current').ok, false);
  // An unchained request with no tools still fails.
  writeFileSync(join(dir, 'payloads/2.json'), JSON.stringify({ model: 'fixture', input: [{ type: 'message' }] }));
  assert.equal(readTaskCatalog(root, 'current').ok, false);
});
