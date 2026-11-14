// Runs the Hive Cloud Worker in Node: Durable Object storage is node:sqlite behind the same
// `ctx.storage.sql.exec()` cursor API Cloudflare provides, so the tests drive the real classes.
import { DatabaseSync } from 'node:sqlite';
import worker, { Account, BlobShard, sha256Hex } from '../worker.js';

class Cursor {
  constructor(rows, rowsWritten) {
    this.rows = rows;
    this.rowsWritten = rowsWritten;
  }
  toArray() { return this.rows; }
  one() {
    if (this.rows.length !== 1) throw new Error('Expected exactly one row, got ' + this.rows.length);
    return this.rows[0];
  }
}

function storage(db) {
  let alarm = null;
  const sql = {
    exec(query, ...bindings) {
      if (bindings.length === 0 && query.trim().split(';').filter((s) => s.trim()).length > 1) {
        db.exec(query);
        return new Cursor([], 0);
      }
      const stmt = db.prepare(query);
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      const rows = stmt.all(...bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)));
      const after = db.prepare('SELECT total_changes() AS n').get().n;
      return new Cursor(rows.map((r) => ({ ...r })), after - before);
    },
  };
  return {
    sql,
    transactionSync(fn) {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    async deleteAlarm() { alarm = null; },
  };
}

function namespace(Klass, env) {
  const instances = new Map();
  return {
    instances,
    idFromName: (name) => name,
    get(id) {
      if (!instances.has(id)) instances.set(id, new Klass({ storage: storage(new DatabaseSync(':memory:')) }, env));
      const instance = instances.get(id);
      return {
        instance,
        fetch: (input, init) => instance.fetch(input instanceof Request ? input : new Request(input, init)),
      };
    },
  };
}

export async function makeCloud({ claimSecret = 'claim-secret-for-tests-0123456789', r2 = false } = {}) {
  const env = { CLAIM_HASH: await sha256Hex(claimSecret) };
  env.ACCOUNT = namespace(Account, env);
  env.SHARD = namespace(BlobShard, env);
  if (r2) {
    const objects = new Map();
    env.BLOBS = {
      objects,
      async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
      async get(key) {
        const bytes = objects.get(key);
        return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null;
      },
      async delete(keys) { for (const key of [].concat(keys)) objects.delete(key); },
    };
  }
  const base = 'https://hive-cloud.example.workers.dev';
  async function call(method, path, { token, body, raw } = {}) {
    const headers = {};
    if (token) headers.authorization = 'Bearer ' + token;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await worker.fetch(new Request(base + path, { method, headers, body: payload }), env);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data };
  }
  const account = () => env.ACCOUNT.get('account').instance;
  return { env, call, account, claimSecret };
}

export function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
