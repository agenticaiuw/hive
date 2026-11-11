import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobilePcMeshClient } from '../pc-mesh-client.mjs';
import { PcMeshBridge } from '../../desktop/mesh-bridge.mjs';

test('mobile request crosses the mailbox and persists admission before ack', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-mobile-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mail = []; let counter = 0; let disk = []; let acked = false;
  const store = { read: async () => structuredClone(disk), write: async value => { disk = structuredClone(value); } };
  const fetchImpl = async (url, opts) => {
    const device = opts.headers.Authorization === 'Bearer phone' ? 'phone-1' : 'pc-1';
    const body = opts.body && JSON.parse(opts.body);
    let result = { ok: true };
    if (url.pathname === '/v1/node/messages') {
      const msg = { id: `nmsg_${String(++counter).padStart(8, '0')}`, from: device, to: body.to, kind: body.kind, payload: body.payload, corr: body.correlationId ?? null, expiresAt: '2099-01-01T00:00:00Z' };
      mail.push(msg); result = { ok: true, messageId: msg.id, from: device, to: msg.to, expiresAt: msg.expiresAt };
    } else if (url.pathname === '/v1/node/inbox') result.messages = mail.filter(x => x.to === device);
    else if (url.pathname === '/v1/node/inbox/ack') {
      if (device === 'phone-1') { assert.equal(disk[0].status, 'accepted'); acked = true; }
      for (const id of body.messageIds) { const i = mail.findIndex(x => x.id === id && x.to === device); if (i >= 0) mail.splice(i, 1); }
    }
    return { ok: true, json: async () => result };
  };
  const phone = new MobilePcMeshClient({ relayUrl: 'http://127.0.0.1:1234', token: 'phone', deviceId: 'phone-1', pcDeviceId: 'pc-1', store, fetchImpl, newId: () => 'local-1' });
  const pc = new PcMeshBridge({ relayUrl: 'http://127.0.0.1:1234', token: 'pc', deviceId: 'pc-1', allowedSenders: ['phone-1'], socketPath: '/unused', journalPath: join(dir, 'journal'), fetchImpl, submit: async ({ text }) => { assert.equal(text, 'check files'); return { accepted: true }; } });
  assert.equal((await phone.submit('check files')).status, 'pending');
  await pc.pollOnce(); await phone.pollOnce();
  assert.equal(disk[0].status, 'accepted'); assert.equal(acked, true);
  assert.equal(JSON.stringify(disk).includes('check files'), false);
});

test('ambiguous submission is durable and never automatically retried', async () => {
  let disk = []; let sends = 0;
  const client = new MobilePcMeshClient({ relayUrl: 'https://example.test', token: 'phone', deviceId: 'phone-1', pcDeviceId: 'pc-1', newId: () => 'local-1', store: { read: async () => structuredClone(disk), write: async x => { disk = structuredClone(x); } }, fetchImpl: async () => { sends++; throw new Error('lost response'); } });
  assert.equal((await client.submit('hello')).status, 'unknown');
  assert.equal(disk[0].reason, 'submission_interrupted'); assert.equal(sends, 1);
});

test('pairing uses the existing device endpoint and validates the returned identity', async () => {
  const { pairMeshDevice } = await import('../mesh-pairing.mjs');
  const pair = { relayUrl: 'https://example.test', deviceId: 'phone-1', deviceType: 'mobile', pairingCode: 'test-only' };
  let sent;
  const result = await pairMeshDevice({ ...pair, fetchImpl: async (url, options) => { sent = { path: url.pathname, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ ok: true, device: { deviceId: 'phone-1', deviceType: 'mobile' }, credential: { token: 'test-token' } }) }; } });
  assert.equal(sent.path, '/v1/devices/pair'); assert.equal(sent.body.deviceType, 'mobile'); assert.equal(result.token, 'test-token');
  await assert.rejects(pairMeshDevice({ ...pair, fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, device: { deviceId: 'other', deviceType: 'mobile' }, credential: { token: 'x' } }) }) }), /Invalid pairing response/);
});

test('ignores spoofed results and acknowledges duplicate valid results after persistence', async () => {
  let disk = [{ localId: 'one', messageId: 'nmsg_12345678', pcDeviceId: 'pc-1', status: 'pending' }];
  const messages = [
    { id: 'nmsg_00000001', kind: 'pc.request.result', from: 'other', to: 'phone-1', corr: 'nmsg_12345678', payload: { status: 'accepted' } },
    { id: 'nmsg_00000002', kind: 'pc.request.result', from: 'pc-1', to: 'phone-1', corr: 'nmsg_12345678', payload: { status: 'rejected', reason: 'agent_rejected' } },
    { id: 'nmsg_00000003', kind: 'pc.request.result', from: 'pc-1', to: 'phone-1', corr: 'nmsg_12345678', payload: { status: 'accepted' } },
  ];
  const ack = [];
  const client = new MobilePcMeshClient({ relayUrl: 'https://example.test', token: 'phone', deviceId: 'phone-1', pcDeviceId: 'pc-1', store: { read: async () => structuredClone(disk), write: async x => { disk = structuredClone(x); } }, fetchImpl: async (url, opts) => { if (url.pathname.endsWith('/ack')) { assert.equal(disk[0].status, 'rejected'); ack.push(...JSON.parse(opts.body).messageIds); } return { ok: true, json: async () => ({ ok: true, messages }) }; } });
  await client.pollOnce(); assert.deepEqual(ack, ['nmsg_00000002', 'nmsg_00000003']); assert.equal(disk[0].status, 'rejected');
});
