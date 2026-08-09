/*
 * Run d1Store's real node-mesh SQL against the real schema.
 *
 * nodeMailbox.test.js covers memoryStore, which is a Map — it can never catch a
 * wrong column name, an index that does not exist, or a lease UPDATE whose
 * subquery SQLite refuses. Those only surface against a live D1, which means
 * the first place they would show up is production, after a deploy, on the path
 * that carries every message between the owner's nodes.
 *
 * D1 is SQLite, so the statements replay here verbatim apart from ?N -> ?,
 * which is the only dialect difference that touches these.
 *
 * If d1Store.js changes its SQL and this file is not updated, that is the
 * point: the mismatch fails here instead of after a deploy.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, '..', '..', 'cloudflare-worker')

/* Mirrors d1Store.enqueueNodeMessage, with ?N rewritten to ?. */
const ENQUEUE = `INSERT INTO relay_node_messages
     (message_id, to_node, from_node, created_at, expires_at,
      leased_until, lease_token, attempts, data)
   VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?)
   ON CONFLICT(message_id) DO NOTHING`

const COUNT = `SELECT COUNT(*) AS pending FROM relay_node_messages
    WHERE to_node = ? AND expires_at > ?`

/* The riskiest statement in the module: a lease claimed by an UPDATE whose
 * subquery carries the ORDER BY and the LIMIT. SQLite only supports
 * `UPDATE ... LIMIT` when built with SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which
 * is why the limit is inside the subquery instead. */
const LEASE = `UPDATE relay_node_messages
      SET leased_until = ?, lease_token = ?, attempts = attempts + 1
    WHERE message_id IN (
      SELECT message_id FROM relay_node_messages
       WHERE to_node = ?
         AND expires_at > ?
         AND (leased_until IS NULL OR leased_until <= ?)
       ORDER BY created_at ASC
       LIMIT ?)`

const LEASED = `SELECT data FROM relay_node_messages
    WHERE lease_token = ? ORDER BY created_at ASC`

const SWEEP = 'DELETE FROM relay_node_messages WHERE expires_at <= ?'

function migrated() {
  const db = new DatabaseSync(':memory:')
  db.exec(fs.readFileSync(path.join(WORKER, 'schema.sql'), 'utf8'))
  /* Applied on top, exactly as an existing database would: this is what
   * catches a migration that cannot run against the schema it belongs to. */
  db.exec(fs.readFileSync(path.join(WORKER, 'node-mesh-migration.sql'), 'utf8'))
  return db
}

function envelope(id, { to = 'node-b', from = 'node-a', createdAt, expiresAt }) {
  return {
    v: 1,
    id,
    from,
    to,
    kind: 'test.a',
    payload: {},
    corr: null,
    createdAt,
    expiresAt,
  }
}

function enqueue(db, message) {
  db.prepare(ENQUEUE).run(
    message.id,
    message.to,
    message.from,
    message.createdAt,
    message.expiresAt,
    JSON.stringify(message),
  )
}

const FAR = '2030-01-01T00:00:00.000Z'
const NOW = '2026-08-08T12:00:00.000Z'

test('the migration applies on top of the schema, and is idempotent', () => {
  const db = migrated()
  /* Both files are CREATE ... IF NOT EXISTS and must stay byte-identical, so
   * running either again is a no-op rather than an error. */
  db.exec(fs.readFileSync(path.join(WORKER, 'node-mesh-migration.sql'), 'utf8'))
  db.exec(fs.readFileSync(path.join(WORKER, 'schema.sql'), 'utf8'))

  const columns = db
    .prepare("SELECT name FROM pragma_table_info('relay_node_messages')")
    .all()
    .map((row) => row.name)
  assert.deepEqual(columns, [
    'message_id',
    'to_node',
    'from_node',
    'created_at',
    'expires_at',
    'leased_until',
    'lease_token',
    'attempts',
    'data',
  ])
  db.close()
})

test('the schema and the migration are byte-identical from CREATE TABLE down', () => {
  /*
   * schema.sql builds a new database; the migration is what an existing one
   * runs. A schema that cannot rebuild the database it describes is a backup
   * that does not restore, and the two drifting apart is silent until then.
   */
  const marker = 'CREATE TABLE IF NOT EXISTS relay_node_messages'
  const schema = fs.readFileSync(path.join(WORKER, 'schema.sql'), 'utf8')
  const migration = fs.readFileSync(
    path.join(WORKER, 'node-mesh-migration.sql'),
    'utf8',
  )
  assert.equal(
    schema.slice(schema.indexOf(marker)).trim(),
    migration.slice(migration.indexOf(marker)).trim(),
  )
})

test('the real enqueue/count/lease/ack statements execute', () => {
  const db = migrated()
  enqueue(db, envelope('nmsg_aaaaaaaa', { createdAt: NOW, expiresAt: FAR }))
  enqueue(
    db,
    envelope('nmsg_bbbbbbbb', {
      createdAt: '2026-08-08T12:00:01.000Z',
      expiresAt: FAR,
    }),
  )

  assert.equal(db.prepare(COUNT).get('node-b', NOW).pending, 2)

  const leased = db.prepare(LEASE)
  leased.run(FAR, 'lease-1', 'node-b', NOW, NOW, 1)
  const page = db.prepare(LEASED).all('lease-1')
  assert.equal(page.length, 1, 'the LIMIT inside the subquery is honoured')
  assert.equal(JSON.parse(page[0].data).id, 'nmsg_aaaaaaaa', 'oldest first')

  /* A second drain must not re-lease what the first holds. */
  leased.run(FAR, 'lease-2', 'node-b', NOW, NOW, 10)
  const second = db.prepare(LEASED).all('lease-2')
  assert.equal(second.length, 1)
  assert.equal(JSON.parse(second[0].data).id, 'nmsg_bbbbbbbb')

  /* attempts is incremented by the UPDATE, not by the reader. */
  assert.equal(
    db
      .prepare('SELECT attempts FROM relay_node_messages WHERE message_id = ?')
      .get('nmsg_aaaaaaaa').attempts,
    1,
  )
  db.close()
})

test('acknowledging deletes only from the addressed inbox', () => {
  const db = migrated()
  enqueue(db, envelope('nmsg_aaaaaaaa', { createdAt: NOW, expiresAt: FAR }))

  /* d1Store builds the placeholders dynamically; this is the shape it emits
   * for a one-id ack. */
  const wrongOwner = db
    .prepare(
      'DELETE FROM relay_node_messages WHERE to_node = ? AND message_id IN (?)',
    )
    .run('node-a', 'nmsg_aaaaaaaa')
  assert.equal(wrongOwner.changes, 0, 'a guessed id must not reach another inbox')

  const rightOwner = db
    .prepare(
      'DELETE FROM relay_node_messages WHERE to_node = ? AND message_id IN (?)',
    )
    .run('node-b', 'nmsg_aaaaaaaa')
  assert.equal(rightOwner.changes, 1)
  db.close()
})

test('an expired row is never leased and is swept', () => {
  const db = migrated()
  enqueue(
    db,
    envelope('nmsg_aaaaaaaa', {
      createdAt: '2026-08-08T11:00:00.000Z',
      expiresAt: '2026-08-08T11:10:00.000Z',
    }),
  )
  db.prepare(LEASE).run(FAR, 'lease-1', 'node-b', NOW, NOW, 10)
  assert.equal(db.prepare(LEASED).all('lease-1').length, 0)
  assert.equal(db.prepare(SWEEP).run(NOW).changes, 1)
  db.close()
})

test('a retried send is one row, not two', () => {
  const db = migrated()
  const message = envelope('nmsg_aaaaaaaa', { createdAt: NOW, expiresAt: FAR })
  enqueue(db, message)
  enqueue(db, message)
  assert.equal(db.prepare(COUNT).get('node-b', NOW).pending, 1)
  db.close()
})

test('retiring a device clears credentials before the row the FK points at', () => {
  /*
   * relay_device_credentials has a FOREIGN KEY to relay_devices, so deleting
   * the device first is the ordering that can fail. This replays deleteDevice
   * in its real order with foreign keys ENFORCED — SQLite leaves them off by
   * default, which is exactly how an ordering bug hides in a test.
   */
  const db = migrated()
  db.exec('PRAGMA foreign_keys = ON')
  db.prepare(
    'INSERT INTO relay_devices (device_id, updated_at, data) VALUES (?, ?, ?)',
  ).run('node-b', NOW, '{"deviceId":"node-b"}')
  db.prepare(
    `INSERT INTO relay_device_credentials
       (token_id, token_hash, device_id, role, scopes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('tok-1', 'hash', 'node-b', 'mobile', '[]', NOW, NOW)
  enqueue(db, envelope('nmsg_aaaaaaaa', { createdAt: NOW, expiresAt: FAR }))

  db.prepare('DELETE FROM relay_device_credentials WHERE device_id = ?').run('node-b')
  db.prepare('DELETE FROM relay_node_messages WHERE to_node = ?').run('node-b')
  const removed = db
    .prepare('DELETE FROM relay_devices WHERE device_id = ?')
    .run('node-b')

  assert.equal(removed.changes, 1)
  assert.equal(db.prepare(COUNT).get('node-b', NOW).pending, 0)
  db.close()
})

test('the drain and sweep indexes exist for the queries that need them', () => {
  const db = migrated()
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT message_id FROM relay_node_messages
        WHERE to_node = ? AND expires_at > ?
          AND (leased_until IS NULL OR leased_until <= ?)
        ORDER BY created_at ASC LIMIT ?`,
    )
    .all()
    .map((row) => row.detail)
    .join(' ')
  /* A full scan here would be fine at ten messages and a problem at ten
   * thousand, which is precisely the point at which nobody is looking. */
  assert.match(plan, /relay_node_messages_inbox/)
  db.close()
})
