import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredReview } from './gmail-review.mjs';
import { server, TOOLS } from './gmail-review-mcp.mjs';

test('Gmail catalog stays discoverable without credentials, with no mail mutation or arbitrary model tools', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-mcp-'));
  const ledger = configuredReview(dir);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const answer = server(ledger);
  assert.equal(await answer({ method: 'notifications/initialized' }), null);
  assert.equal((await answer({ id: 1, method: 'initialize' })).result.serverInfo.name, 'gmail_review');
  const catalog = (await answer({ id: 2, method: 'tools/list' })).result.tools;
  assert.deepEqual(catalog, TOOLS);
  assert.deepEqual(catalog.map(t => t.name), ['status', 'snapshot_unread', 'list_messages', 'read_message', 'review_message', 'report']);
  const call = (name, args = {}) => answer({ id: 3, method: 'tools/call', params: { name, arguments: { step: 'Fixture', review_id: 'R20', ...args } } });
  const status = JSON.parse((await call('status')).result.content[0].text);
  assert.equal(status.gmail_configured, false);
  assert.equal(status.model.configured, false);
  assert.equal(status.model.additional_spending_limit, 0);
  assert.equal((await call('snapshot_unread')).result.isError, true);
  assert.match((await call('snapshot_unread')).result.content[0].text, /not API authorization/);
  assert.equal((await call('send')).result.isError, true);
  assert.equal((await call('status', { review_id: '../bad' })).result.isError, true);
  assert.equal(JSON.parse((await call('report')).result.content[0].text).complete, false);
});

test('Gmail MCP dispatch preserves pagination and individual IDs', async () => {
  const calls = [];
  const ledger = { snapshot: () => {},
    read: async (...args) => { calls.push(args); return { next_offset: 30 }; },
    review: async (...args) => { calls.push(args); return { reused: true }; },
    report: (...args) => { calls.push(args); return { complete: false, next_offset: null }; },
  };
  const answer = server(ledger);
  for (const name of ['read_message', 'review_message', 'report']) {
    const out = await answer({ id: 1, method: 'tools/call', params: { name,
      arguments: { review_id: 'R21', message_id: 'a1', offset: 10, max_chars: 20, limit: 5 } } });
    assert.equal(out.result.isError, undefined);
  }
  assert.deepEqual(calls, [['R21', 'a1', 10, 20], ['R21', 'a1'], ['R21', 10, 5]]);
});

test('the real stdio server starts without provisioning and advertises the review tools', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-mcp-process-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'input'), [
    { id: 1, method: 'initialize' }, { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'status', arguments: { review_id: 'R22', step: 'Check availability' } } },
  ].map(m => JSON.stringify(m)).join('\n') + '\n');
  const fds = ['input', 'output', 'errors'].map((name, i) => openSync(join(dir, name), i ? 'w' : 'r'));
  const child = spawn(process.execPath, [join(import.meta.dirname, 'gmail-review-mcp.mjs')], {
    env: { HIVE_VM_STATE: dir }, stdio: fds,
  });
  const code = await new Promise(resolve => child.on('close', resolve));
  fds.forEach(closeSync);
  assert.equal(code, 0, readFileSync(join(dir, 'errors'), 'utf8'));
  const replies = readFileSync(join(dir, 'output'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 3);
  assert.ok(replies[1].result.tools.some(t => t.name === 'review_message'));
  assert.equal(JSON.parse(replies[2].result.content[0].text).model.configured, false);
});
