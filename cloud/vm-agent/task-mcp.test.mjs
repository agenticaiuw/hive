import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forward, waitForCatalog } from './task-mcp.mjs';

test('discovery passes, but calls wait for this task catalog and failed checks never dispatch', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-task-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'runtime-catalog.json');
  const sent = [], replies = [];
  const send = message => sent.push(message), reply = message => replies.push(message);
  await forward({ id: 1, method: 'tools/list' }, path, send, reply);
  assert.equal(sent.length, 1, 'catalog discovery cannot wait for a model request');
  const call = { id: 2, method: 'tools/call', params: { name: 'transfer_file' } };
  const pending = forward(call, path, send, reply);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(sent.length, 1, 'nothing runs before the audit');
  writeFileSync(path, JSON.stringify({ ok: true, thread_id: 'current' }));
  await pending;
  assert.deepEqual(sent, [{ id: 1, method: 'tools/list' }, call]);
  writeFileSync(path, JSON.stringify({ ok: false, why: 'Missing transfer schema.' }));
  await forward(call, path, send, reply);
  assert.equal(sent.length, 2);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /Missing transfer schema/);
});

test('absent, partial and unidentified verdicts time out without allowing a call', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-task-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'runtime-catalog.json');
  for (const value of [null, '{', '{"ok":true}']) {
    if (value !== null) writeFileSync(path, value);
    let now = 0;
    await assert.rejects(waitForCatalog(path, { now: () => now, timeoutMs: 100,
      sleep: async ms => { now += ms; } }), /No verified transfer catalog/);
  }
});

test('a transfer repair allows probes but cannot act on a schema check or another thread probe', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-probe-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'runtime-catalog.json');
  writeFileSync(path, JSON.stringify({ ok: true, thread_id: 'current', probe_required: true }));
  const sent = [], replies = [];
  const action = { id: 1, method: 'tools/call', params: { name: 'click' } };
  const probe = { id: 2, method: 'tools/call', params: { name: 'transfer_file', arguments: { check_only: true } } };
  const call = message => forward(message, path, v => sent.push(v), v => replies.push(v));
  await call(action);
  await call(probe);
  writeFileSync(`${path}.probe`, JSON.stringify({ ready: true, thread_id: 'old' }));
  await call(action);
  assert.deepEqual(sent, [probe]);
  assert.equal(replies.length, 2);
  assert.ok(replies.every(r => r.result.isError));
  writeFileSync(`${path}.probe`, JSON.stringify({ ready: true, thread_id: 'current' }));
  await call(action);
  assert.deepEqual(sent, [probe, action]);
});
