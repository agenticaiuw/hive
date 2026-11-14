import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { makeCloud, b64 } from './harness.mjs';

const device = (name, platform = 'macos') => ({ name, platform });
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rid = (n) => createHash('sha256').update('record-' + n).digest('hex').slice(0, 32);

async function claimed(opts) {
  const cloud = await makeCloud(opts);
  const res = await cloud.call('POST', '/v1/claim', {
    body: {
      claimSecret: cloud.claimSecret, keyCheck: 'kc-0123456789abcdef', recoveryAuth: 'r'.repeat(43),
      recoveryWrappedKey: b64(randomBytes(60)), device: device('Test Mac'),
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return { cloud, owner: res.data };
}

async function putBlob(cloud, token, bytes) {
  const hash = hex(bytes);
  const res = await cloud.call('PUT', '/v1/blobs/' + hash, { token, raw: bytes });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return hash;
}

test('health works before and after the claim, and reports no secrets', async () => {
  const cloud = await makeCloud();
  let res = await cloud.call('GET', '/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.claimed, false);
  assert.equal(res.data.storage, 'durable-objects');
  const { cloud: c2 } = await claimed();
  res = await c2.call('GET', '/v1/health');
  assert.equal(res.data.claimed, true);
  assert.deepEqual(Object.keys(res.data).sort(), ['claimed', 'ok', 'service', 'storage', 'version']);
});

test('only the holder of the claim secret can claim, and only once', async () => {
  const cloud = await makeCloud();
  const body = (secret) => ({
    claimSecret: secret, keyCheck: 'kc-0123456789abcdef', recoveryAuth: 'r'.repeat(43),
    recoveryWrappedKey: b64(randomBytes(60)), device: device('Mac'),
  });
  let res = await cloud.call('POST', '/v1/claim', { body: body('wrong-secret-0123456789') });
  assert.equal(res.status, 403);
  res = await cloud.call('POST', '/v1/claim', { body: body(cloud.claimSecret) });
  assert.equal(res.status, 200);
  assert.match(res.data.deviceId, /^d_[0-9a-f]{24}$/);
  assert.match(res.data.token, /^hc_[A-Za-z0-9_-]{43}$/);
  res = await cloud.call('POST', '/v1/claim', { body: body(cloud.claimSecret) });
  assert.equal(res.status, 409);
});

test('unauthenticated and revoked callers are refused', async () => {
  const { cloud, owner } = await claimed();
  assert.equal((await cloud.call('GET', '/v1/status')).status, 401);
  assert.equal((await cloud.call('GET', '/v1/status', { token: 'hc_' + 'A'.repeat(43) })).status, 401);
  assert.equal((await cloud.call('GET', '/v1/me', { token: owner.token })).status, 200);
  const del = await cloud.call('DELETE', '/v1/devices/' + owner.deviceId, { token: owner.token });
  assert.equal(del.status, 200);
  assert.equal((await cloud.call('GET', '/v1/me', { token: owner.token })).status, 401);
});

test('an invite enrolls exactly one new device with a server-made ID, then is spent', async () => {
  const { cloud, owner } = await claimed();
  const wrapped = b64(randomBytes(60));
  const invite = await cloud.call('POST', '/v1/invites', {
    token: owner.token, body: { inviteAuth: 'i'.repeat(43), wrappedKey: wrapped, ttlSeconds: 600 },
  });
  assert.equal(invite.status, 200);
  // A caller cannot choose a device ID: any field it sends is ignored.
  const phone = await cloud.call('POST', '/v1/enroll', {
    body: { inviteAuth: 'i'.repeat(43), device: { ...device('Phone', 'ios'), id: owner.deviceId }, deviceId: owner.deviceId },
  });
  assert.equal(phone.status, 200);
  assert.notEqual(phone.data.deviceId, owner.deviceId);
  assert.equal(phone.data.wrappedKey, wrapped);
  assert.equal(phone.data.keyCheck, 'kc-0123456789abcdef');
  const again = await cloud.call('POST', '/v1/enroll', { body: { inviteAuth: 'i'.repeat(43), device: device('Thief') } });
  assert.equal(again.status, 403);
  const list = await cloud.call('GET', '/v1/devices', { token: phone.data.token });
  assert.equal(list.data.devices.length, 2);
  assert.equal(list.data.devices.find((d) => d.current).id, phone.data.deviceId);
  assert.equal(list.data.devices.find((d) => d.id === phone.data.deviceId).enrolledVia, 'invite:' + invite.data.inviteId);
});

test('expired invites and wrong codes fail, and repeated failures lock enrollment', async () => {
  const { cloud, owner } = await claimed();
  await cloud.call('POST', '/v1/invites', { token: owner.token, body: { inviteAuth: 'e'.repeat(43), wrappedKey: 'AAAA', ttlSeconds: 60 } });
  cloud.account().sql.exec('UPDATE invites SET expires_at = ?', Date.now() - 1);
  assert.equal((await cloud.call('POST', '/v1/enroll', { body: { inviteAuth: 'e'.repeat(43), device: device('Late') } })).status, 403);
  for (let i = 0; i < 19; i++) {
    assert.equal((await cloud.call('POST', '/v1/enroll', { body: { inviteAuth: 'x'.repeat(40) + String(i).padStart(3, '0'), device: device('Guess') } })).status, 403);
  }
  assert.equal((await cloud.call('POST', '/v1/enroll', { body: { inviteAuth: 'y'.repeat(43), device: device('Guess') } })).status, 429);
});

test('the recovery code enrolls a new device and returns the recovery-wrapped key', async () => {
  const cloud = await makeCloud();
  const wrapped = b64(randomBytes(60));
  await cloud.call('POST', '/v1/claim', {
    body: { claimSecret: cloud.claimSecret, keyCheck: 'kc-0123456789abcdef', recoveryAuth: 'R'.repeat(43), recoveryWrappedKey: wrapped, device: device('Lost Mac') },
  });
  assert.equal((await cloud.call('POST', '/v1/recover', { body: { recoveryAuth: 'Q'.repeat(43), device: device('New Mac') } })).status, 403);
  const res = await cloud.call('POST', '/v1/recover', { body: { recoveryAuth: 'R'.repeat(43), device: device('New Mac') } });
  assert.equal(res.status, 200);
  assert.equal(res.data.wrappedKey, wrapped);
  assert.equal((await cloud.call('GET', '/v1/me', { token: res.data.token })).data.deviceId, res.data.deviceId);
});

test('chunks are stored under their SHA-256 and come back byte for byte', async () => {
  for (const r2 of [false, true]) {
    const { cloud, owner } = await claimed({ r2 });
    const bytes = randomBytes(300_000);
    const hash = hex(bytes);
    const bad = await cloud.call('PUT', '/v1/blobs/' + hex(Buffer.from('other')), { token: owner.token, raw: bytes });
    assert.equal(bad.status, 400);
    let missing = await cloud.call('POST', '/v1/blobs/missing', { token: owner.token, body: { hashes: [hash] } });
    assert.deepEqual(missing.data.missing, [hash]);
    await putBlob(cloud, owner.token, bytes);
    const second = await cloud.call('PUT', '/v1/blobs/' + hash, { token: owner.token, raw: bytes });
    assert.equal(second.data.stored, false);
    missing = await cloud.call('POST', '/v1/blobs/missing', { token: owner.token, body: { hashes: [hash] } });
    assert.deepEqual(missing.data.missing, []);
    const got = await cloud.call('GET', '/v1/blobs/' + hash, { token: owner.token });
    assert.equal(got.status, 200);
    assert.equal(hex(got.data), hash);
    if (r2) assert.equal(cloud.env.BLOBS.objects.size, 1);
    else assert.equal([...cloud.env.SHARD.instances.keys()].length, 1);
  }
});

function pack(chunks) {
  const parts = [];
  for (const bytes of chunks) {
    const head = Buffer.alloc(36);
    Buffer.from(hex(bytes), 'hex').copy(head, 0);
    head.writeUInt32BE(bytes.length, 32);
    parts.push(head, bytes);
  }
  return new Uint8Array(Buffer.concat(parts));
}

function unpack(buf) {
  const out = new Map();
  const b = Buffer.from(buf);
  for (let i = 0; i < b.length;) {
    const hash = b.subarray(i, i + 32).toString('hex');
    const len = b.readUInt32BE(i + 32);
    out.set(hash, b.subarray(i + 36, i + 36 + len));
    i += 36 + len;
  }
  return out;
}

test('packs store many chunks in one request and read them back byte for byte', async () => {
  for (const r2 of [false, true]) {
    const { cloud, owner } = await claimed({ r2 });
    const before = randomBytes(500);
    await putBlob(cloud, owner.token, before);
    const chunks = [before, ...Array.from({ length: 30 }, (_, i) => randomBytes(100 + i * 997))];
    let res = await cloud.call('PUT', '/v1/packs', { token: owner.token, raw: pack(chunks) });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual([res.data.stored, res.data.existing, res.data.retry], [30, 1, []]);
    const hashes = chunks.map(hex);
    res = await cloud.call('POST', '/v1/blobs/missing', { token: owner.token, body: { hashes } });
    assert.deepEqual(res.data.missing, []);
    res = await cloud.call('POST', '/v1/packs/get', { token: owner.token, body: { hashes: [...hashes, 'f'.repeat(64)] } });
    assert.equal(res.status, 200);
    const back = unpack(res.data);
    assert.equal(back.size, 31);
    for (const bytes of chunks) assert.ok(Buffer.from(back.get(hex(bytes))).equals(bytes));
    if (!r2) assert.ok(cloud.env.SHARD.instances.size <= 4);
  }
});

test('R2 packs store at most 40 new chunks per request and ask for the rest again', async () => {
  const { cloud, owner } = await claimed({ r2: true });
  const chunks = Array.from({ length: 50 }, () => randomBytes(64));
  const res = await cloud.call('PUT', '/v1/packs', { token: owner.token, raw: pack(chunks) });
  assert.equal(res.data.stored, 40);
  assert.equal(res.data.retry.length, 10);
  assert.equal(cloud.env.BLOBS.objects.size, 40);
});

test('a pack with a chunk that does not match its name is refused whole', async () => {
  const { cloud, owner } = await claimed();
  const good = randomBytes(100);
  const bad = pack([good, randomBytes(100)]);
  bad[36 + 100 + 5] ^= 1; // corrupt the second chunk's name
  const res = await cloud.call('PUT', '/v1/packs', { token: owner.token, raw: bad });
  assert.equal(res.status, 400);
  const missing = await cloud.call('POST', '/v1/blobs/missing', { token: owner.token, body: { hashes: [hex(good)] } });
  assert.deepEqual(missing.data.missing, [hex(good)]);
});

test('oversized chunks are refused', async () => {
  const { cloud, owner } = await claimed();
  const bytes = randomBytes(2 * 1024 * 1024 + 1);
  const res = await cloud.call('PUT', '/v1/blobs/' + hex(bytes), { token: owner.token, raw: bytes });
  assert.equal(res.status, 413);
});

test('records use compare-and-set versions, refuse missing chunks, and keep history', async () => {
  const { cloud, owner } = await claimed();
  const hash = await putBlob(cloud, owner.token, randomBytes(1000));
  const id = rid(1);
  const missingHash = hex(Buffer.from('never uploaded'));
  let res = await cloud.call('POST', '/v1/records', {
    token: owner.token, body: { changes: [{ id, baseVersion: 0, meta: 'AAAA', blobs: [missingHash], size: 10 }] },
  });
  assert.equal(res.data.results[0].error, 'missing_blobs');
  res = await cloud.call('POST', '/v1/records', {
    token: owner.token, body: { changes: [{ id, baseVersion: 0, meta: 'AAAA', blobs: [hash], size: 1016 }] },
  });
  assert.deepEqual(res.data.results[0], { id, ok: true, version: 1, seq: 1 });
  // A second writer that still thinks the record is new loses and sees the current version.
  res = await cloud.call('POST', '/v1/records', {
    token: owner.token, body: { changes: [{ id, baseVersion: 0, meta: 'BBBB', blobs: [hash], size: 1016 }] },
  });
  assert.equal(res.data.results[0].error, 'conflict');
  assert.equal(res.data.results[0].current.version, 1);
  assert.equal(res.data.results[0].current.meta, 'AAAA');
  res = await cloud.call('POST', '/v1/records', {
    token: owner.token, body: { changes: [{ id, baseVersion: 1, meta: 'CCCC', deleted: true, size: 0 }] },
  });
  assert.equal(res.data.results[0].version, 2);
  const history = await cloud.call('GET', '/v1/history?id=' + id, { token: owner.token });
  assert.equal(history.data.versions.length, 1);
  assert.equal(history.data.versions[0].meta, 'AAAA');
  assert.deepEqual(history.data.versions[0].blobs, [hash]);
  const read = await cloud.call('GET', '/v1/records?ids=' + id, { token: owner.token });
  assert.equal(read.data.records[0].deleted, true);
});

test('changes page in order from a cursor, so a clean device can rebuild everything', async () => {
  const { cloud, owner } = await claimed();
  const hash = await putBlob(cloud, owner.token, randomBytes(64));
  const changes = [];
  for (let i = 0; i < 7; i++) changes.push({ id: rid(i), baseVersion: 0, meta: b64(Buffer.from('m' + i)), blobs: [hash], size: 80 });
  await cloud.call('POST', '/v1/records', { token: owner.token, body: { changes } });
  let since = 0;
  const seen = [];
  for (;;) {
    const page = await cloud.call('GET', `/v1/changes?since=${since}&limit=3`, { token: owner.token });
    seen.push(...page.data.changes.map((c) => c.id));
    since = page.data.next;
    if (!page.data.hasMore) break;
  }
  assert.deepEqual(seen, changes.map((c) => c.id));
  const status = await cloud.call('GET', '/v1/status', { token: owner.token });
  assert.equal(status.data.records.live, 7);
  assert.equal(status.data.head, 7);
  assert.equal(status.data.storage.chunks, 1);
});

test('garbage collection keeps referenced and recent chunks and frees the rest', async () => {
  const { cloud, owner } = await claimed();
  const keep = await putBlob(cloud, owner.token, randomBytes(100));
  const drop = await putBlob(cloud, owner.token, randomBytes(100));
  await cloud.call('POST', '/v1/records', { token: owner.token, body: { changes: [{ id: rid(9), baseVersion: 0, meta: 'AAAA', blobs: [keep], size: 1 }] } });
  const account = cloud.account();
  assert.equal(await account.collectGarbage(Date.now()), 0);
  const later = Date.now() + 2 * 24 * 3600 * 1000;
  assert.equal(await account.collectGarbage(later), 1);
  const missing = await cloud.call('POST', '/v1/blobs/missing', { token: owner.token, body: { hashes: [keep, drop] } });
  assert.deepEqual(missing.data.missing, [drop]);
});

test('devices report status that other devices can read', async () => {
  const { cloud, owner } = await claimed();
  await cloud.call('POST', '/v1/status', { token: owner.token, body: { status: { lastVerifiedSyncAt: 123, state: 'ok' } } });
  const res = await cloud.call('GET', '/v1/status', { token: owner.token });
  assert.equal(res.data.devices[0].status.lastVerifiedSyncAt, 123);
  assert.equal(res.data.storage.capacityBytes, 4_000_000_000);
});

test('plain HTTP is refused', async () => {
  const { default: worker } = await import('../worker.js');
  const res = await worker.fetch(new Request('http://x.workers.dev/v1/health'), {});
  assert.equal(res.status, 400);
});
