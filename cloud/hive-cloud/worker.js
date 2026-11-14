// Hive Cloud: one person's private Hive cloud, deployed into that person's own Cloudflare account.
//
// One Worker, no npm dependencies, so the Mac app can upload this exact file through the
// Cloudflare API. State lives in SQLite-backed Durable Objects, which the Workers Free plan
// includes, so the default setup needs no card, no D1 database and no R2 bucket:
//
//   Account    one object: the owner, devices, invites, the record index and the blob index
//   BlobShard  N objects: encrypted chunk bytes (each object holds up to 1 GB on Workers Free)
//   BLOBS      optional R2 bucket; when bound, chunk bytes go there instead of the shards
//
// The server never sees plaintext. Devices encrypt every chunk and every record's metadata with
// the account key, which only devices and the owner's recovery code can unwrap. What the server
// does see: record IDs (keyed hashes of paths), sizes, timestamps and which device wrote what.
//
// Identity: the deployer sets CLAIM_HASH (SHA-256 of a one-time claim secret) as a Worker secret.
// The first device proves the claim secret and becomes the owner's first device. Every later
// device joins with a one-use, expiring invite created by an enrolled device, or with the
// recovery code. Device IDs and tokens are made by the server; a caller can never pick or reuse
// another device's ID, and every credential maps to exactly one device row.

export const VERSION = '1.0.0';
const SHARDS = 4;
const SHARD_CAPACITY = 1_000_000_000; // a SQLite Durable Object's limit on Workers Free
const BLOB_MAX = 1_900_000; // under the 2 MB row limit of a SQLite Durable Object; devices send 1 MiB chunks
// Packs carry many chunks in one request. Workers Free allows 100,000 requests a day and 50
// subrequests per request, so one chunk per request would not get a real Hive folder up in a day.
const PACK_MAX = 8 * 1024 * 1024;
const PACK_COUNT_MAX = 5000;
const R2_PACK_COUNT = 40; // each R2 call is a subrequest
const META_MAX = 1_500_000;
const BLOBS_PER_RECORD_MAX = 16_384;
const CHANGES_PAGE_MAX = 500;
const CHANGES_PAGE_BYTES = 4_000_000;
const INVITE_TTL_MAX = 24 * 3600;
const INVITE_TTL_DEFAULT = 15 * 60;
const HISTORY_DAYS = 30;
const BLOB_GRACE_MS = 24 * 3600 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 20;
const DAY_MS = 24 * 3600 * 1000;

const HEX64 = /^[0-9a-f]{64}$/;
const RECORD_ID = /^[0-9a-f]{32,64}$/;
const B64 = /^[A-Za-z0-9+/_=-]*$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.protocol !== 'https:' && env.ALLOW_HTTP !== '1') {
      return json({ ok: false, error: 'https_required' }, 400);
    }
    if (url.pathname === '/') {
      return cors(new Response('Hive Cloud ' + VERSION + '. This is a private API for Hive devices.\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }));
    }
    if (!url.pathname.startsWith('/v1/')) return json({ ok: false, error: 'not_found' }, 404);
    const account = env.ACCOUNT.get(env.ACCOUNT.idFromName('account'));
    return account.fetch(request);
  },
};

export class Account {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER,
        revoked_at INTEGER, enrolled_via TEXT NOT NULL, status TEXT);
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY, auth_hash TEXT NOT NULL UNIQUE, wrapped_key TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        used_at INTEGER, used_by TEXT);
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, seq INTEGER NOT NULL, meta TEXT NOT NULL,
        deleted INTEGER NOT NULL, blobs TEXT NOT NULL, size INTEGER NOT NULL,
        device_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
      CREATE TABLE IF NOT EXISTS history (
        id TEXT NOT NULL, version INTEGER NOT NULL, meta TEXT NOT NULL, deleted INTEGER NOT NULL,
        blobs TEXT NOT NULL, size INTEGER NOT NULL, device_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL, replaced_at INTEGER NOT NULL, PRIMARY KEY (id, version));
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY, size INTEGER NOT NULL, touched_at INTEGER NOT NULL, deleting INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS failures (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
    `);
  }

  async fetch(request) {
    try {
      return cors(await this.route(request));
    } catch (error) {
      if (error instanceof HttpError) return cors(json({ ok: false, error: error.code, message: error.message }, error.status));
      console.error('hive-cloud internal error', error && error.stack ? error.stack : String(error));
      return cors(json({ ok: false, error: 'internal' }, 500));
    }
  }

  async route(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/v1/health' && method === 'GET') {
      return json({
        ok: true, service: 'hive-cloud', version: VERSION, claimed: this.claimed(),
        storage: this.env.BLOBS ? 'r2' : 'durable-objects',
      });
    }
    if (path === '/v1/claim' && method === 'POST') return this.claim(await body(request));
    if (path === '/v1/enroll' && method === 'POST') return this.enroll(await body(request));
    if (path === '/v1/recover' && method === 'POST') return this.recover(await body(request));

    const device = await this.authenticate(request);

    if (path === '/v1/me' && method === 'GET') {
      return json({ ok: true, deviceId: device.id, name: device.name, keyCheck: this.getMeta('key_check') });
    }
    if (path === '/v1/invites' && method === 'POST') return this.createInvite(device, await body(request));
    if (path === '/v1/devices' && method === 'GET') return this.listDevices(device);
    if (path.startsWith('/v1/devices/') && method === 'DELETE') return this.revokeDevice(device, path.slice('/v1/devices/'.length));
    if (path === '/v1/blobs/missing' && method === 'POST') return this.missingBlobs(await body(request));
    if (path.startsWith('/v1/blobs/')) {
      const hash = path.slice('/v1/blobs/'.length);
      if (!HEX64.test(hash)) throw new HttpError(400, 'bad_hash', 'Blob names are SHA-256 hex digests.');
      if (method === 'PUT') return this.putBlob(hash, request);
      if (method === 'GET') return this.getBlob(hash);
    }
    if (path === '/v1/packs' && method === 'PUT') return this.putPack(request);
    if (path === '/v1/packs/get' && method === 'POST') return this.getPack(await body(request));
    if (path === '/v1/records' && method === 'POST') return this.writeRecords(device, await body(request));
    if (path === '/v1/records' && method === 'GET') return this.readRecords(url);
    if (path === '/v1/changes' && method === 'GET') return this.changes(url);
    if (path === '/v1/history' && method === 'GET') return this.history(url);
    if (path === '/v1/status' && method === 'POST') return this.reportStatus(device, await body(request));
    if (path === '/v1/status' && method === 'GET') return this.status(device);
    throw new HttpError(404, 'not_found', 'No such endpoint.');
  }

  // ---- identity ----------------------------------------------------------------------------

  claimed() {
    return this.getMeta('claimed_at') !== null;
  }

  async claim(input) {
    if (this.claimed()) throw new HttpError(409, 'already_claimed', 'This Hive Cloud already has an owner.');
    if (!this.env.CLAIM_HASH || !HEX64.test(this.env.CLAIM_HASH)) {
      throw new HttpError(503, 'not_configured', 'CLAIM_HASH is not set on this Worker.');
    }
    this.checkFailures('claim');
    const secret = str(input.claimSecret, 'claimSecret', 16, 256);
    if (!timingSafeEqual(await sha256Hex(secret), this.env.CLAIM_HASH)) {
      this.recordFailure('claim');
      throw new HttpError(403, 'bad_claim', 'The claim secret is wrong.');
    }
    const keyCheck = str(input.keyCheck, 'keyCheck', 16, 128);
    const recoveryAuth = str(input.recoveryAuth, 'recoveryAuth', 32, 256);
    const recoveryWrappedKey = b64(input.recoveryWrappedKey, 'recoveryWrappedKey', 4096);
    const dev = deviceInput(input.device);
    const recoveryHash = await sha256Hex(recoveryAuth);
    const issued = await newCredential();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      if (this.claimed()) throw new HttpError(409, 'already_claimed', 'This Hive Cloud already has an owner.');
      this.setMeta('claimed_at', String(now));
      this.setMeta('key_check', keyCheck);
      this.setMeta('recovery_auth_hash', recoveryHash);
      this.setMeta('recovery_wrapped_key', recoveryWrappedKey);
      this.setMeta('shards', String(SHARDS));
      this.setMeta('seq', '0');
      this.insertDevice(issued, dev, 'claim', now);
    });
    await this.scheduleGc();
    return json({ ok: true, deviceId: issued.deviceId, token: issued.token, keyCheck });
  }

  async enroll(input) {
    this.requireClaimed();
    this.checkFailures('enroll');
    const auth = str(input.inviteAuth, 'inviteAuth', 32, 256);
    const dev = deviceInput(input.device);
    const hash = await sha256Hex(auth);
    const issued = await newCredential();
    const now = Date.now();
    const wrappedKey = this.ctx.storage.transactionSync(() => {
      const invite = this.sql.exec('SELECT * FROM invites WHERE auth_hash = ?', hash).toArray()[0];
      if (!invite || invite.used_at !== null || invite.expires_at < now) return null;
      this.sql.exec('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL', now, issued.deviceId, invite.id);
      this.insertDevice(issued, dev, 'invite:' + invite.id, now);
      return invite.wrapped_key;
    });
    if (wrappedKey === null) {
      this.recordFailure('enroll');
      throw new HttpError(403, 'bad_invite', 'This invite is wrong, used or expired.');
    }
    return json({ ok: true, deviceId: issued.deviceId, token: issued.token, wrappedKey, keyCheck: this.getMeta('key_check') });
  }

  async recover(input) {
    this.requireClaimed();
    this.checkFailures('recover');
    const auth = str(input.recoveryAuth, 'recoveryAuth', 32, 256);
    const dev = deviceInput(input.device);
    if (!timingSafeEqual(await sha256Hex(auth), this.getMeta('recovery_auth_hash') || '')) {
      this.recordFailure('recover');
      throw new HttpError(403, 'bad_recovery', 'The recovery code is wrong.');
    }
    const issued = await newCredential();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => this.insertDevice(issued, dev, 'recovery', now));
    return json({
      ok: true, deviceId: issued.deviceId, token: issued.token,
      wrappedKey: this.getMeta('recovery_wrapped_key'), keyCheck: this.getMeta('key_check'),
    });
  }

  insertDevice(issued, dev, via, now) {
    this.sql.exec(
      'INSERT INTO devices (id, name, platform, token_hash, created_at, last_seen_at, revoked_at, enrolled_via, status) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)',
      issued.deviceId, dev.name, dev.platform, issued.tokenHash, now, now, via,
    );
  }

  async authenticate(request) {
    this.requireClaimed();
    const header = request.headers.get('authorization') || '';
    const match = /^Bearer (hc_[A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) throw new HttpError(401, 'unauthorized', 'A device token is required.');
    const tokenHash = await sha256Hex(match[1]);
    const row = this.sql.exec('SELECT * FROM devices WHERE token_hash = ?', tokenHash).toArray()[0];
    if (!row || row.revoked_at !== null) throw new HttpError(401, 'unauthorized', 'This device is not enrolled or was removed.');
    const now = Date.now();
    if (!row.last_seen_at || now - row.last_seen_at > 60_000) {
      this.sql.exec('UPDATE devices SET last_seen_at = ? WHERE id = ?', now, row.id);
    }
    return row;
  }

  requireClaimed() {
    if (!this.claimed()) throw new HttpError(409, 'not_claimed', 'This Hive Cloud has no owner yet.');
  }

  async createInvite(device, input) {
    const auth = str(input.inviteAuth, 'inviteAuth', 32, 256);
    const wrappedKey = b64(input.wrappedKey, 'wrappedKey', 4096);
    const ttl = input.ttlSeconds === undefined ? INVITE_TTL_DEFAULT : int(input.ttlSeconds, 'ttlSeconds', 60, INVITE_TTL_MAX);
    const now = Date.now();
    const id = 'i_' + randomHex(12);
    this.sql.exec('DELETE FROM invites WHERE expires_at < ?', now - DAY_MS);
    this.sql.exec(
      'INSERT INTO invites (id, auth_hash, wrapped_key, created_by, created_at, expires_at, used_at, used_by) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
      id, await sha256Hex(auth), wrappedKey, device.id, now, now + ttl * 1000,
    );
    return json({ ok: true, inviteId: id, expiresAt: now + ttl * 1000 });
  }

  listDevices(current) {
    const rows = this.sql.exec('SELECT id, name, platform, created_at, last_seen_at, revoked_at, enrolled_via, status FROM devices ORDER BY created_at').toArray();
    return json({ ok: true, devices: rows.map((r) => deviceView(r, current.id)) });
  }

  revokeDevice(current, id) {
    if (!/^d_[0-9a-f]{24}$/.test(id)) throw new HttpError(400, 'bad_device', 'Unknown device ID format.');
    const changed = this.sql.exec('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), id).rowsWritten;
    if (!changed) throw new HttpError(404, 'no_device', 'No active device has that ID.');
    return json({ ok: true, revoked: id, self: id === current.id });
  }

  // ---- blobs -------------------------------------------------------------------------------

  async putBlob(hash, request) {
    const declared = Number(request.headers.get('content-length') || '0');
    if (declared > BLOB_MAX) throw new HttpError(413, 'too_large', 'Chunks are at most 1.9 MB.');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > BLOB_MAX) throw new HttpError(413, 'too_large', 'Chunks are 1 byte to 1.9 MB.');
    if ((await sha256Hex(bytes)) !== hash) throw new HttpError(400, 'hash_mismatch', 'The body does not match its SHA-256 name.');
    const now = Date.now();
    const existing = this.sql.exec('SELECT deleting FROM blobs WHERE hash = ?', hash).toArray()[0];
    if (existing && existing.deleting) throw new HttpError(503, 'retry_later', 'This chunk is being cleaned up; send it again shortly.');
    if (existing) {
      this.sql.exec('UPDATE blobs SET touched_at = ? WHERE hash = ?', now, hash);
      return json({ ok: true, stored: false });
    }
    await this.blobBackend().put(hash, bytes);
    this.sql.exec('INSERT OR REPLACE INTO blobs (hash, size, touched_at) VALUES (?, ?, ?)', hash, bytes.byteLength, now);
    return json({ ok: true, stored: true });
  }

  async getBlob(hash) {
    const row = this.sql.exec('SELECT size FROM blobs WHERE hash = ? AND deleting = 0', hash).toArray()[0];
    if (!row) throw new HttpError(404, 'no_blob', 'No chunk has that hash.');
    const bytes = await this.blobBackend().get(hash);
    if (!bytes) throw new HttpError(500, 'blob_lost', 'The chunk index has this hash but its bytes are missing.');
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  }

  // A pack is chunks back to back: 32-byte SHA-256, 4-byte big-endian length, bytes. Chunks the
  // store already has are only touched; chunks being cleaned up come back in `retry`.
  async putPack(request) {
    const declared = Number(request.headers.get('content-length') || '0');
    if (declared > PACK_MAX) throw new HttpError(413, 'too_large', 'Packs are at most 8 MiB.');
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.byteLength > PACK_MAX) throw new HttpError(413, 'too_large', 'Packs are at most 8 MiB.');
    const items = parsePack(buf);
    if (items.length > PACK_COUNT_MAX) throw new HttpError(413, 'too_large', 'Packs hold at most 5000 chunks.');
    const unique = new Map();
    for (const item of items) {
      if ((await sha256Hex(item.bytes)) !== item.hash) throw new HttpError(400, 'hash_mismatch', 'A chunk does not match its SHA-256 name.');
      unique.set(item.hash, item);
    }
    const now = Date.now();
    const fresh = [];
    const retry = [];
    let existing = 0;
    for (const item of unique.values()) {
      const row = this.sql.exec('SELECT deleting FROM blobs WHERE hash = ?', item.hash).toArray()[0];
      if (row && row.deleting) retry.push(item.hash);
      else if (row) {
        this.sql.exec('UPDATE blobs SET touched_at = ? WHERE hash = ?', now, item.hash);
        existing += 1;
      } else fresh.push(item);
    }
    if (this.env.BLOBS && fresh.length > R2_PACK_COUNT) {
      for (const item of fresh.splice(R2_PACK_COUNT)) retry.push(item.hash);
    }
    if (fresh.length) await this.blobBackend().putMany(fresh);
    for (const item of fresh) {
      this.sql.exec('INSERT OR REPLACE INTO blobs (hash, size, touched_at) VALUES (?, ?, ?)', item.hash, item.bytes.byteLength, now);
    }
    return json({ ok: true, stored: fresh.length, existing, retry });
  }

  // Answers with a pack of the chunks asked for, in order, up to 8 MiB. The caller asks again
  // for any that did not fit. Unknown hashes are left out.
  async getPack(input) {
    const hashes = hashList(input.hashes, 'hashes', 2000);
    const sizes = new Map();
    for (const group of chunked(hashes, 90)) {
      const marks = group.map(() => '?').join(',');
      for (const r of this.sql.exec(`SELECT hash, size FROM blobs WHERE deleting = 0 AND hash IN (${marks})`, ...group).toArray()) sizes.set(r.hash, r.size);
    }
    const picked = [];
    let total = 0;
    const most = this.env.BLOBS ? R2_PACK_COUNT : PACK_COUNT_MAX;
    for (const hash of hashes) {
      if (!sizes.has(hash)) continue;
      if (picked.length && (total + sizes.get(hash) + 36 > PACK_MAX || picked.length >= most)) break;
      picked.push(hash);
      total += sizes.get(hash) + 36;
    }
    const found = picked.length ? await this.blobBackend().getMany(picked) : [];
    if (found.length !== picked.length) throw new HttpError(500, 'blob_lost', 'The chunk index has a hash whose bytes are missing.');
    return new Response(buildPack(found), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  }

  missingBlobs(input) {
    const hashes = hashList(input.hashes, 'hashes', 2000);
    if (hashes.length === 0) return json({ ok: true, missing: [] });
    const now = Date.now();
    const present = new Set();
    for (const group of chunked(hashes, 90)) {
      const marks = group.map(() => '?').join(',');
      for (const r of this.sql.exec(`SELECT hash FROM blobs WHERE deleting = 0 AND hash IN (${marks})`, ...group).toArray()) present.add(r.hash);
      this.sql.exec(`UPDATE blobs SET touched_at = ? WHERE deleting = 0 AND hash IN (${marks})`, now, ...group);
    }
    return json({ ok: true, missing: hashes.filter((h) => !present.has(h)) });
  }

  blobBackend() {
    const env = this.env;
    if (env.BLOBS) {
      const get = async (hash) => {
        const obj = await env.BLOBS.get('b/' + hash);
        return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
      };
      return {
        async put(hash, bytes) { await env.BLOBS.put('b/' + hash, bytes); },
        get,
        async putMany(items) { await Promise.all(items.map((i) => env.BLOBS.put('b/' + i.hash, i.bytes))); },
        async getMany(hashes) {
          const out = [];
          for (const hash of hashes) {
            const bytes = await get(hash);
            if (bytes) out.push({ hash, bytes });
          }
          return out;
        },
        async deleteMany(hashes) {
          for (const group of chunked(hashes, 1000)) await env.BLOBS.delete(group.map((h) => 'b/' + h));
        },
      };
    }
    const shards = Number(this.getMeta('shards') || SHARDS);
    const shardOf = (hash) => parseInt(hash.slice(0, 4), 16) % shards;
    const stub = (n) => env.SHARD.get(env.SHARD.idFromName('shard-' + n));
    const byShard = (list, key) => {
      const groups = new Map();
      for (const x of list) {
        const n = shardOf(key(x));
        if (!groups.has(n)) groups.set(n, []);
        groups.get(n).push(x);
      }
      return groups;
    };
    const full = async (res) => new HttpError(507, 'storage_full', 'The chunk store refused: ' + (await res.text()));
    return {
      async put(hash, bytes) {
        const res = await stub(shardOf(hash)).fetch('https://shard/blob/' + hash, { method: 'PUT', body: bytes });
        if (!res.ok) throw await full(res);
      },
      async get(hash) {
        const res = await stub(shardOf(hash)).fetch('https://shard/blob/' + hash);
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      },
      async putMany(items) {
        for (const [n, group] of byShard(items, (i) => i.hash)) {
          const res = await stub(n).fetch('https://shard/pack', { method: 'POST', body: buildPack(group) });
          if (!res.ok) throw await full(res);
        }
      },
      async getMany(hashes) {
        const found = new Map();
        for (const [n, group] of byShard(hashes, (h) => h)) {
          const res = await stub(n).fetch('https://shard/unpack', { method: 'POST', body: JSON.stringify(group) });
          if (!res.ok) continue;
          for (const item of parsePack(new Uint8Array(await res.arrayBuffer()))) found.set(item.hash, item);
        }
        return hashes.filter((h) => found.has(h)).map((h) => found.get(h));
      },
      async deleteMany(hashes) {
        for (const [n, group] of byShard(hashes, (h) => h)) {
          await stub(n).fetch('https://shard/delete', { method: 'POST', body: JSON.stringify(group) });
        }
      },
    };
  }


  // ---- records -----------------------------------------------------------------------------

  writeRecords(device, input) {
    if (!Array.isArray(input.changes) || input.changes.length === 0 || input.changes.length > 200) {
      throw new HttpError(400, 'bad_changes', 'Send 1 to 200 changes.');
    }
    const changes = input.changes.map(recordInput);
    const results = [];
    for (const change of changes) {
      if (change.blobs.length) {
        const known = new Set();
        for (const group of chunked(change.blobs, 90)) {
          const marks = group.map(() => '?').join(',');
          for (const r of this.sql.exec(`SELECT hash FROM blobs WHERE deleting = 0 AND hash IN (${marks})`, ...group).toArray()) known.add(r.hash);
        }
        const missing = change.blobs.filter((h) => !known.has(h));
        if (missing.length) {
          results.push({ id: change.id, ok: false, error: 'missing_blobs', missing: missing.slice(0, 50) });
          continue;
        }
      }
      results.push(this.ctx.storage.transactionSync(() => this.applyRecord(device, change)));
    }
    return json({ ok: true, results, head: Number(this.getMeta('seq')) });
  }

  applyRecord(device, change) {
    const now = Date.now();
    const current = this.sql.exec('SELECT * FROM records WHERE id = ?', change.id).toArray()[0];
    const currentVersion = current ? current.version : 0;
    if (currentVersion !== change.baseVersion) {
      return { id: change.id, ok: false, error: 'conflict', current: current ? recordView(current) : null };
    }
    const seq = Number(this.getMeta('seq')) + 1;
    this.setMeta('seq', String(seq));
    const blobs = JSON.stringify(change.blobs);
    if (current) {
      this.sql.exec(
        'INSERT OR REPLACE INTO history (id, version, meta, deleted, blobs, size, device_id, updated_at, replaced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        current.id, current.version, current.meta, current.deleted, current.blobs, current.size, current.device_id, current.updated_at, now,
      );
      this.sql.exec(
        'UPDATE records SET version = ?, seq = ?, meta = ?, deleted = ?, blobs = ?, size = ?, device_id = ?, updated_at = ? WHERE id = ?',
        currentVersion + 1, seq, change.meta, change.deleted, blobs, change.size, device.id, now, change.id,
      );
    } else {
      this.sql.exec(
        'INSERT INTO records (id, version, seq, meta, deleted, blobs, size, device_id, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)',
        change.id, seq, change.meta, change.deleted, blobs, change.size, device.id, now,
      );
    }
    return { id: change.id, ok: true, version: currentVersion + 1, seq };
  }

  readRecords(url) {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
    if (ids.length === 0 || ids.length > 200 || !ids.every((id) => RECORD_ID.test(id))) {
      throw new HttpError(400, 'bad_ids', 'Pass 1 to 200 record IDs.');
    }
    const rows = [];
    for (const group of chunked(ids, 90)) {
      rows.push(...this.sql.exec(`SELECT * FROM records WHERE id IN (${group.map(() => '?').join(',')})`, ...group).toArray());
    }
    return json({ ok: true, records: rows.map(recordView) });
  }

  changes(url) {
    const since = Number(url.searchParams.get('since') || '0');
    const limit = Math.min(Number(url.searchParams.get('limit') || CHANGES_PAGE_MAX), CHANGES_PAGE_MAX);
    if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new HttpError(400, 'bad_cursor', 'since and limit must be non-negative integers.');
    }
    const rows = this.sql.exec('SELECT * FROM records WHERE seq > ? ORDER BY seq LIMIT ?', since, limit).toArray();
    const out = [];
    let bytes = 0;
    for (const row of rows) {
      bytes += row.meta.length + row.blobs.length;
      if (out.length && bytes > CHANGES_PAGE_BYTES) break;
      out.push(recordView(row));
    }
    const head = Number(this.getMeta('seq'));
    const next = out.length ? out[out.length - 1].seq : since;
    return json({ ok: true, changes: out, next, head, hasMore: next < head });
  }

  history(url) {
    const id = url.searchParams.get('id') || '';
    if (!RECORD_ID.test(id)) throw new HttpError(400, 'bad_id', 'Pass a record ID.');
    const rows = this.sql.exec('SELECT * FROM history WHERE id = ? ORDER BY version DESC', id).toArray();
    return json({ ok: true, versions: rows.map((r) => ({ ...recordView(r), replacedAt: r.replaced_at })) });
  }

  // ---- status ------------------------------------------------------------------------------

  reportStatus(device, input) {
    const text = JSON.stringify(input.status ?? null);
    if (text.length > 8192) throw new HttpError(413, 'too_large', 'Status reports are at most 8 KB.');
    this.sql.exec('UPDATE devices SET status = ?, last_seen_at = ? WHERE id = ?', text, Date.now(), device.id);
    return json({ ok: true });
  }

  status(current) {
    const devices = this.sql.exec('SELECT id, name, platform, created_at, last_seen_at, revoked_at, enrolled_via, status FROM devices ORDER BY created_at').toArray();
    const live = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM records WHERE deleted = 0').one();
    const deleted = this.sql.exec('SELECT COUNT(*) AS n FROM records WHERE deleted = 1').one();
    const blobs = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM blobs').one();
    const r2 = Boolean(this.env.BLOBS);
    return json({
      ok: true,
      version: VERSION,
      head: Number(this.getMeta('seq')),
      claimedAt: Number(this.getMeta('claimed_at')),
      records: { live: live.n, liveBytes: live.bytes, deleted: deleted.n },
      storage: {
        backend: r2 ? 'r2' : 'durable-objects',
        usedBytes: blobs.bytes,
        chunks: blobs.n,
        capacityBytes: r2 ? null : Number(this.getMeta('shards') || SHARDS) * SHARD_CAPACITY,
      },
      devices: devices.map((r) => deviceView(r, current.id)),
    });
  }

  // ---- garbage collection ------------------------------------------------------------------

  async scheduleGc() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }

  async alarm() {
    await this.collectGarbage(Date.now());
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }

  // Old versions stay 30 days so a deleted or overwritten item can be brought back. A chunk is
  // removed only when no record or kept version names it and nobody touched it for a day. The
  // index row is marked first, so no write can start naming a chunk whose bytes are going away.
  async collectGarbage(now) {
    const doomed = this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM history WHERE replaced_at < ?', now - HISTORY_DAYS * DAY_MS);
      this.sql.exec('DELETE FROM invites WHERE expires_at < ?', now - DAY_MS);
      const hashes = this.sql.exec(`
        SELECT hash FROM blobs WHERE deleting = 1 OR (touched_at < ?
          AND hash NOT IN (SELECT value FROM records, json_each(records.blobs))
          AND hash NOT IN (SELECT value FROM history, json_each(history.blobs)))
        LIMIT 500`, now - BLOB_GRACE_MS).toArray().map((r) => r.hash);
      for (const hash of hashes) this.sql.exec('UPDATE blobs SET deleting = 1 WHERE hash = ?', hash);
      return hashes;
    });
    if (doomed.length) await this.blobBackend().deleteMany(doomed);
    for (const hash of doomed) this.sql.exec('DELETE FROM blobs WHERE hash = ? AND deleting = 1', hash);
    return doomed.length;
  }

  // ---- helpers -----------------------------------------------------------------------------

  getMeta(k) {
    const row = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return row ? row.v : null;
  }

  setMeta(k, v) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  checkFailures(kind) {
    const row = this.sql.exec('SELECT count, window_start FROM failures WHERE bucket = ?', kind).toArray()[0];
    if (row && Date.now() - row.window_start < FAIL_WINDOW_MS && row.count >= FAIL_LIMIT) {
      throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Wait 15 minutes.');
    }
  }

  recordFailure(kind) {
    const now = Date.now();
    const row = this.sql.exec('SELECT count, window_start FROM failures WHERE bucket = ?', kind).toArray()[0];
    if (!row || now - row.window_start >= FAIL_WINDOW_MS) {
      this.sql.exec('INSERT OR REPLACE INTO failures (bucket, count, window_start) VALUES (?, 1, ?)', kind, now);
    } else {
      this.sql.exec('UPDATE failures SET count = count + 1 WHERE bucket = ?', kind);
    }
  }
}

export class BlobShard {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, data BLOB NOT NULL)');
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/pack') {
      try {
        for (const item of parsePack(new Uint8Array(await request.arrayBuffer()))) {
          this.sql.exec('INSERT OR IGNORE INTO blobs (hash, data) VALUES (?, ?)', item.hash, item.bytes);
        }
      } catch (error) {
        return new Response(String(error && error.message ? error.message : error), { status: 507 });
      }
      return new Response('ok');
    }
    if (request.method === 'POST' && (path === '/unpack' || path === '/delete')) {
      const hashes = JSON.parse(await request.text());
      if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string' && HEX64.test(h))) return new Response('bad hashes', { status: 400 });
      const out = [];
      for (const group of chunked(hashes, 90)) {
        const marks = group.map(() => '?').join(',');
        if (path === '/delete') this.sql.exec(`DELETE FROM blobs WHERE hash IN (${marks})`, ...group);
        else for (const r of this.sql.exec(`SELECT hash, data FROM blobs WHERE hash IN (${marks})`, ...group).toArray()) out.push({ hash: r.hash, bytes: new Uint8Array(r.data) });
      }
      return path === '/delete' ? new Response('ok') : new Response(buildPack(out));
    }
    const hash = path.replace('/blob/', '');
    if (!HEX64.test(hash)) return new Response('bad hash', { status: 400 });
    if (request.method === 'PUT') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      try {
        this.sql.exec('INSERT OR IGNORE INTO blobs (hash, data) VALUES (?, ?)', hash, bytes);
      } catch (error) {
        return new Response(String(error && error.message ? error.message : error), { status: 507 });
      }
      return new Response('ok');
    }
    if (request.method === 'GET') {
      const row = this.sql.exec('SELECT data FROM blobs WHERE hash = ?', hash).toArray()[0];
      return row ? new Response(new Uint8Array(row.data)) : new Response('missing', { status: 404 });
    }
    if (request.method === 'DELETE') {
      this.sql.exec('DELETE FROM blobs WHERE hash = ?', hash);
      return new Response('ok');
    }
    return new Response('method', { status: 405 });
  }
}

// ---- pure helpers ------------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-headers', 'authorization, content-type');
  headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(response.body, { status: response.status, headers });
}

async function body(request) {
  const text = await request.text();
  if (text.length > 4_000_000) throw new HttpError(413, 'too_large', 'Request bodies are at most 4 MB.');
  try {
    const value = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'bad_json', 'The body must be a JSON object.');
  }
}

function str(value, name, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new HttpError(400, 'bad_' + name, `${name} must be a string of ${min} to ${max} characters.`);
  }
  return value;
}

function b64(value, name, max) {
  const text = str(value, name, 1, max);
  if (!B64.test(text)) throw new HttpError(400, 'bad_' + name, `${name} must be base64.`);
  return text;
}

function int(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'bad_' + name, `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function hashList(value, name, max) {
  if (!Array.isArray(value) || value.length > max || !value.every((h) => typeof h === 'string' && HEX64.test(h))) {
    throw new HttpError(400, 'bad_' + name, `${name} must be up to ${max} SHA-256 hex digests.`);
  }
  return [...new Set(value)];
}

function deviceInput(value) {
  const dev = value && typeof value === 'object' ? value : {};
  const name = str(dev.name, 'device.name', 1, 80).replace(/[\u0000-\u001f]/g, ' ');
  const platform = str(dev.platform, 'device.platform', 1, 24);
  if (!/^[a-z0-9-]+$/.test(platform)) throw new HttpError(400, 'bad_device.platform', 'platform is lowercase letters, digits and dashes.');
  return { name, platform };
}

function recordInput(value) {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'bad_change', 'Each change is an object.');
  if (typeof value.id !== 'string' || !RECORD_ID.test(value.id)) throw new HttpError(400, 'bad_id', 'Record IDs are 32 to 64 lowercase hex characters.');
  return {
    id: value.id,
    baseVersion: int(value.baseVersion, 'baseVersion', 0, Number.MAX_SAFE_INTEGER),
    meta: b64(value.meta, 'meta', META_MAX),
    deleted: value.deleted ? 1 : 0,
    blobs: value.deleted ? [] : hashList(value.blobs ?? [], 'blobs', BLOBS_PER_RECORD_MAX),
    size: int(value.size ?? 0, 'size', 0, Number.MAX_SAFE_INTEGER),
  };
}

function recordView(row) {
  return {
    id: row.id, version: row.version, seq: row.seq, meta: row.meta, deleted: Boolean(row.deleted),
    blobs: JSON.parse(row.blobs), size: row.size, deviceId: row.device_id, updatedAt: row.updated_at,
  };
}

function deviceView(row, currentId) {
  let status = null;
  try { status = row.status ? JSON.parse(row.status) : null; } catch { status = null; }
  return {
    id: row.id, name: row.name, platform: row.platform, createdAt: row.created_at,
    lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at, enrolledVia: row.enrolled_via,
    status, current: row.id === currentId,
  };
}

function parsePack(buf) {
  const out = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  while (i < buf.byteLength) {
    if (i + 36 > buf.byteLength) throw new HttpError(400, 'bad_pack', 'A pack ended inside a chunk header.');
    const hash = [...buf.subarray(i, i + 32)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const len = view.getUint32(i + 32);
    i += 36;
    if (len === 0 || len > BLOB_MAX || i + len > buf.byteLength) throw new HttpError(400, 'bad_pack', 'A chunk in the pack has a bad length.');
    out.push({ hash, bytes: buf.subarray(i, i + len) });
    i += len;
  }
  return out;
}

function buildPack(items) {
  const total = items.reduce((n, item) => n + 36 + item.bytes.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let i = 0;
  for (const item of items) {
    for (let k = 0; k < 32; k += 1) out[i + k] = parseInt(item.hash.slice(k * 2, k * 2 + 2), 16);
    view.setUint32(i + 32, item.bytes.byteLength);
    out.set(item.bytes, i + 36);
    i += 36 + item.bytes.byteLength;
  }
  return out;
}

function chunked(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function newCredential() {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = 'hc_' + base64url(raw);
  return { deviceId: 'd_' + randomHex(12), token, tokenHash: await sha256Hex(token) };
}

function randomHex(bytes) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
