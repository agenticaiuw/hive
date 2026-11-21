// Probe evidence comes from matching MCP requests and replies, even when Codex only
// reports the surrounding functions.exec call. No model, network or Mac is needed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forward, transferProbeObserver } from './task-mcp.mjs';

const verdict = { ok: true, thread_id: 'current' };
const request = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'transfer_file',
  arguments: { direction: 'to_vm', check_only: true, mac_path: '/Desktop/clip.mov', step: 'Check the route.' } } };
const response = { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: JSON.stringify({
  ready: true, copied: false, direction: 'to_vm', mac_path: '/Desktop/clip.mov',
}) }] } };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-task-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalog = join(dir, 'runtime-catalog.json');
  writeFileSync(catalog, JSON.stringify(verdict));
  return { dir, catalog, receipt: join(dir, 'transfer-probe.json') };
}

test('only a matching successful server probe creates a receipt for the verified thread', t => {
  const { catalog, receipt } = fixture(t);
  const observer = transferProbeObserver(catalog, 'mac');
  observer.received(response);
  assert.equal(existsSync(receipt), false, 'unsolicited replies are not evidence');
  observer.sent(request, verdict);
  observer.received({ ...response, id: 4 });
  assert.equal(existsSync(receipt), false, 'another call cannot complete the probe');
  observer.received(response);
  assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { thread_id: 'current', probed: true });
  assert.doesNotMatch(readFileSync(receipt, 'utf8'), /clip|Desktop|step/, 'keep no file details');
});

test('errors, copies, wrong paths and unverified calls cannot become probe evidence', t => {
  const { catalog, receipt } = fixture(t);
  for (const [server, call, reply, checked] of [
    ['browser', request, response, verdict],
    ['mac', request, response, { ok: false, thread_id: 'current' }],
    ['mac', request, response, { ok: true }],
    ['mac', request, { ...response, error: { code: -32603, message: 'offline' } }, verdict],
    ['mac', request, { ...response, result: { ...response.result, isError: true } }, verdict],
    ['mac', { ...request, params: { ...request.params, arguments: { ...request.params.arguments, check_only: false } } }, response, verdict],
    ['mac', { ...request, params: { ...request.params, arguments: { ...request.params.arguments, mac_path: '/Desktop/other.mov' } } }, response, verdict],
  ]) {
    const observer = transferProbeObserver(catalog, server);
    observer.sent(call, checked);
    observer.received(reply);
    assert.equal(existsSync(receipt), false);
    observer.received(response);
    assert.equal(existsSync(receipt), false, 'a consumed error reply cannot later turn into success');
  }
});

for (const name of ['mac', 'desktop']) {
  test(`${name} probe is recorded only after catalog-gated dispatch and a server reply`, async t => {
    const { catalog, receipt } = fixture(t);
    const observer = transferProbeObserver(catalog, name);
    const sent = [], rejected = [];
    const send = (message, checked) => { observer.sent(message, checked); sent.push(message); };
    writeFileSync(catalog, JSON.stringify({ ok: false, why: 'Missing tool.' }));
    await forward(request, catalog, send, reply => rejected.push(reply));
    assert.equal(sent.length, 0);
    assert.equal(rejected[0].result.isError, true);
    observer.received(response);
    assert.equal(existsSync(receipt), false, 'a rejected call was never sent to the server');
    writeFileSync(catalog, JSON.stringify(verdict));
    await forward(request, catalog, send, reply => rejected.push(reply));
    assert.deepEqual(sent, [request]);
    assert.equal(existsSync(receipt), false, 'dispatch alone is not evidence');
    observer.received(response);
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { thread_id: 'current', probed: true });
  });
}
