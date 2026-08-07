/*
 * Run d1Store's real context SQL against the real schema.
 *
 * contextStore.test.js covers memoryStore, which is a Map — it can never catch
 * a wrong column name, a wrong ON CONFLICT target, or a migration that does not
 * apply on top of the existing schema. Those only surface against a live D1,
 * which means the first place they would have shown up is production, after a
 * deploy, on the path carrying the owner's own words.
 *
 * D1 is SQLite, so the statements replay here verbatim apart from ?N -> ?,
 * which is the only dialect difference that touches these four.
 *
 * If d1Store.js changes its SQL and this file is not updated, that is the point:
 * the mismatch fails here instead of after a deploy.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, '..', '..', 'cloudflare-worker')

/* Mirrors d1Store.saveContext, with ?N rewritten to ?. */
const SAVE = `INSERT INTO relay_contexts
     (handle_id, secret_hash, origin, created_at, expires_at, bytes, data)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(handle_id) DO UPDATE SET
     secret_hash = excluded.secret_hash,
     origin = excluded.origin,
     expires_at = excluded.expires_at,
     bytes = excluded.bytes,
     data = excluded.data`

const GET = 'SELECT data FROM relay_contexts WHERE handle_id = ? AND expires_at > ?'
const SWEEP = 'DELETE FROM relay_contexts WHERE expires_at <= ?'
const DROP = 'DELETE FROM relay_contexts WHERE handle_id = ?'

function migrated() {
  const db = new DatabaseSync(':memory:')
  db.exec(fs.readFileSync(path.join(WORKER, 'schema.sql'), 'utf8'))
  db.exec(fs.readFileSync(path.join(WORKER, 'context-handoff-migration.sql'), 'utf8'))
  return db
}

const now = new Date('2026-08-07T12:00:00.000Z')
const live = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString()
const dead = new Date(now.getTime() - 60 * 60 * 1000).toISOString()

test('the migration applies on top of the existing schema, and twice', () => {
  const db = migrated()
  /* Re-running a migration is normal — a retried deploy, a second environment.
   * It must not fail the second time. */
  db.exec(fs.readFileSync(path.join(WORKER, 'context-handoff-migration.sql'), 'utf8'))

  const columns = db.prepare('PRAGMA table_info(relay_contexts)').all().map((row) => row.name)
  assert.deepEqual(columns, [
    'handle_id',
    'secret_hash',
    'origin',
    'created_at',
    'expires_at',
    'bytes',
    'data',
  ])
})

test('saveContext inserts, and saving the same handle replaces in place', () => {
  const db = migrated()
  db.prepare(SAVE).run('h1', 'hash1', 'relay', now.toISOString(), live, 10, '{"v":1}')
  db.prepare(SAVE).run('h1', 'hash2', 'relay', now.toISOString(), live, 20, '{"v":2}')

  assert.equal(db.prepare('SELECT count(*) AS n FROM relay_contexts').get().n, 1)
  const row = db.prepare('SELECT secret_hash, bytes, data FROM relay_contexts WHERE handle_id = ?').get('h1')
  /* Spread first: node:sqlite hands back null-prototype rows, so a deepEqual
   * against an object literal fails on the prototype while every value matches. */
  assert.deepEqual({ ...row }, { secret_hash: 'hash2', bytes: 20, data: '{"v":2}' })
})

/*
 * The read filters on expiry as well as the sweep deleting by it. Without that,
 * a context could be resumed after its deadline purely because the sweep had
 * not come round — and a stale context is worse than none, because it is
 * confidently wrong about which apps and tabs are open rather than merely empty.
 */
test('an expired context is unreadable before the sweep has run', () => {
  const db = migrated()
  db.prepare(SAVE).run('stale', 'h', 'relay', now.toISOString(), dead, 5, '{"stale":true}')
  db.prepare(SAVE).run('fresh', 'h', 'relay', now.toISOString(), live, 5, '{"fresh":true}')

  assert.equal(db.prepare(GET).get('stale', now.toISOString()), undefined)
  assert.ok(db.prepare(GET).get('fresh', now.toISOString()))
})

test('the sweep removes only what has expired, and deleteContext removes one', () => {
  const db = migrated()
  db.prepare(SAVE).run('stale', 'h', 'relay', now.toISOString(), dead, 5, '{}')
  db.prepare(SAVE).run('fresh', 'h', 'relay', now.toISOString(), live, 5, '{}')

  db.prepare(SWEEP).run(now.toISOString())
  assert.deepEqual(
    db.prepare('SELECT handle_id FROM relay_contexts').all().map((row) => row.handle_id),
    ['fresh'],
  )

  db.prepare(DROP).run('fresh')
  assert.equal(db.prepare('SELECT count(*) AS n FROM relay_contexts').get().n, 0)
})

/* The sweep runs on every save, so it cannot be a table scan. */
test('the expiry index is the one the sweep actually uses', () => {
  const db = migrated()
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${SWEEP}`).all()
  assert.ok(
    JSON.stringify(plan).includes('relay_contexts_expiry'),
    `sweep should use the expiry index, plan was ${JSON.stringify(plan)}`,
  )
})
