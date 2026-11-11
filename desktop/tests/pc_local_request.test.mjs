import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitLocalRequest } from '../local-request.mjs';

async function fixture(t, handler) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-pc-'));
  const path = join(dir, 'request.sock');
  const server = net.createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return path;
}

test('passes requests to the agent and reports admission, not completion', async t => {
  let received;
  const socketPath = await fixture(t, socket => socket.once('data', data => {
    received = JSON.parse(data.toString());
    socket.end('{"ok":true}\n');
  }));
  const response = await submitLocalRequest({ socketPath, text: 'Inspect the local project' });
  assert.deepEqual(received, { text: 'Inspect the local project' });
  assert.deepEqual(response, { accepted: true, error: undefined });
});

test('preserves explicit rejection and reports an uncertain malformed response', async t => {
  const rejectedPath = await fixture(t, socket => socket.once('data', () => socket.end('{"ok":false,"error":"busy"}\n')));
  assert.deepEqual(await submitLocalRequest({ socketPath: rejectedPath, text: 'Test' }), { accepted: false, error: 'busy' });
  const invalidPath = await fixture(t, socket => socket.once('data', () => socket.end('bad\n')));
  await assert.rejects(submitLocalRequest({ socketPath: invalidPath, text: 'Test' }), /acceptance is unknown/);
});

test('passes a stable source ID to the local ingress without retry', async t => {
  let received;
  const path = await fixture(t, socket => socket.once('data', data => { received = JSON.parse(data.toString()); socket.end('{"ok":true}\n'); }));
  await submitLocalRequest({ socketPath: path, text: 'Test', sourceId: 'mesh:node-pc:nmsg_12345678' });
  assert.equal(received.sourceId, 'mesh:node-pc:nmsg_12345678');
  await assert.rejects(submitLocalRequest({ socketPath: path, text: 'Test', sourceId: 'invalid id' }), /Invalid sourceId/);
});

test('preserves durable ingress duplicate admission and uncertain outcomes', async t => {
  const duplicate = await fixture(t, socket => socket.once('data', () => socket.end('{"ok":false,"status":"accepted","receiptId":"0123456789abcdef0123456789abcdef","error":"Request already received; no repeat was started."}\n')));
  assert.deepEqual(await submitLocalRequest({ socketPath: duplicate, text: 'test' }), { accepted: true, receiptId: '0123456789abcdef0123456789abcdef' });
  const unknown = await fixture(t, socket => socket.once('data', () => socket.end('{"ok":false,"status":"unknown","receiptId":"0123456789abcdef0123456789abcdef"}\n')));
  assert.deepEqual(await submitLocalRequest({ socketPath: unknown, text: 'test' }), { accepted: null, receiptId: '0123456789abcdef0123456789abcdef' });
});
