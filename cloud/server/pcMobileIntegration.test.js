// Local HTTP integration with real device authentication and mailbox routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMemoryStore } from './store/memoryStore.js';
import { createDeviceCredential, authenticateRelayRequest } from './deviceAuth.js';
import { registerNodeMeshRoutes } from './nodeMailbox.js';
import { PcMeshBridge } from '../../desktop/mesh-bridge.mjs';
import { MobilePcMeshClient } from '../shared/pc-mesh-client.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

test('authenticated phone and PC exchange a request through mailbox routes', async t => {
  const store = createMemoryStore();
  const credentials = {};
  for (const [deviceId, deviceType] of [['phone-1', 'mobile'], ['pc-1', 'mac_bridge']]) {
    const credential = createDeviceCredential({ deviceId, deviceType });
    await store.saveDevice({ deviceId, deviceType, name: deviceId });
    await store.saveDeviceCredential(credential.record);
    credentials[deviceId] = credential.token;
  }
  const app = express(); app.use(express.json());
  app.use(async (req, res, next) => {
    const auth = await authenticateRelayRequest({ authorization: req.get('authorization'), credentialStore: store });
    if (!auth.ok) return res.status(401).json({ ok: false });
    req.relayPrincipal = auth.principal; next();
  });
  registerNodeMeshRoutes(app, { getStore: async () => store });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const dir = mkdtempSync(join(tmpdir(), 'hive-pc-http-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let executions = 0;
  const socketPath = join(dir, 'request.sock');
  const socketServer = net.createServer(socket => socket.once('data', data => {
    executions++; assert.equal(JSON.parse(data.toString()).text, 'fixture task');
    socket.end('{"ok":true}\n');
  }));
  await new Promise(resolve => socketServer.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => socketServer.close(resolve)));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  let records = [];
  const phone = new MobilePcMeshClient({ relayUrl, token: credentials['phone-1'], deviceId: 'phone-1', pcDeviceId: 'pc-1', store: { read: async () => structuredClone(records), write: async value => { records = structuredClone(value); } } });
  const pc = new PcMeshBridge({ relayUrl, token: credentials['pc-1'], deviceId: 'pc-1', allowedSenders: ['phone-1'], socketPath, journalPath: join(dir, 'journal') });
  assert.equal((await phone.submit('fixture task')).status, 'pending');
  assert.deepEqual(await pc.pollOnce(), { processed: 1 });
  assert.deepEqual(await phone.pollOnce(), { processed: 1 });
  assert.equal(records[0].status, 'accepted'); assert.equal(executions, 1);
});
