/*
 * Run d1Store's real announcement-retention SQL against the real schema.
 *
 * Same reasoning as d1ContextSchema.test.js, and more urgent: these statements
 * DELETE, and the store they delete from is the owner's live relay. A Map-backed
 * fake can never catch a wrong column name, a NULL comparison that silently
 * matches nothing, or a string cutoff that orders wrong — and the first place
 * those would have shown up is production, permanently.
 *
 * D1 is SQLite, so the statements replay here verbatim apart from ?N -> ?.
 *
 * If d1Store.js changes this SQL and this file is not updated, that is the
 * point: the mismatch fails here rather than after a deploy.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, '..', '..', 'cloudflare-worker')

/* Mirrors d1Store.listExpiredAnnouncements, with ?N rewritten to ?. */
const LIST_EXPIRED = `SELECT data FROM relay_announcements
    WHERE expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY expires_at ASC LIMIT ?`

/* Mirrors d1Store.announcementStats. */
const STATS = `SELECT
     COUNT(*) AS total,
     COALESCE(SUM(LENGTH(data)), 0) AS total_bytes,
     SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
     COALESCE(SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN LENGTH(data) ELSE 0 END), 0) AS expired_bytes,
     SUM(CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END) AS undated
   FROM relay_announcements`

/* Mirrors d1Store.deleteAnnouncement. */
const DELETE_ONE = 'DELETE FROM relay_announcements WHERE announcement_id = ?'

/* Mirrors d1Store.createAnnouncement and listAnnouncements. */
const INSERT = `INSERT INTO relay_announcements
     (announcement_id, device_id, state, created_at, expires_at, data)
   VALUES (?, ?, ?, ?, ?, ?)`
const LIST_PENDING = `SELECT data FROM relay_announcements
    WHERE device_id = ? AND state = ?
    ORDER BY created_at ASC LIMIT ?`

const NOW = new Date('2026-08-07T12:00:00.000Z').getTime()
const HOUR = 60 * 60 * 1000
const iso = (ms) => new Date(ms).toISOString()

function migrated() {
  const db = new DatabaseSync(':memory:')
  db.exec(fs.readFileSync(path.join(WORKER, 'schema.sql'), 'utf8'))
  db.exec(fs.readFileSync(path.join(WORKER, 'routines-migration.sql'), 'utf8'))
  return db
}

function insert(db, { id, expiresAt, createdAt = iso(NOW - 40 * HOUR), speech = 'hello' }) {
  const record = {
    announcementId: id,
    deviceId: 'nrf9160-pendant',
    state: 'pending',
    createdAt,
    expiresAt,
    speech,
  }
  db.prepare(INSERT).run(
    id,
    record.deviceId,
    record.state,
    createdAt,
    expiresAt,
    JSON.stringify(record),
  )
  return record
}

test('the retention columns exist on the table the relay actually ships', () => {
  const db = migrated()
  const columns = db
    .prepare('PRAGMA table_info(relay_announcements)')
    .all()
    .map((row) => row.name)
  assert.deepEqual(columns, [
    'announcement_id',
    'device_id',
    'state',
    'created_at',
    'expires_at',
    'data',
  ])
})

test('the cutoff selects expired rows and nothing else', () => {
  const db = migrated()
  const cutoff = iso(NOW - 24 * HOUR)

  insert(db, { id: 'anc_old', expiresAt: iso(NOW - 34 * HOUR) })
  insert(db, { id: 'anc_recent', expiresAt: iso(NOW - 14 * HOUR) })
  insert(db, { id: 'anc_live', expiresAt: iso(NOW + 5 * HOUR) })

  const rows = db.prepare(LIST_EXPIRED).all(cutoff, 200)
  assert.deepEqual(
    rows.map((row) => JSON.parse(row.data).announcementId),
    ['anc_old'],
  )
})

test('a NULL expiry is never selected — unknown means keep', () => {
  const db = migrated()
  /* The schema allows expires_at to be NULL, and `NULL <= x` is NULL in SQL,
   * which is not true. The explicit IS NOT NULL is belt for that: a future
   * rewrite that drops it would still be correct today and wrong the moment
   * anyone flips the comparison around. */
  insert(db, { id: 'anc_undated', expiresAt: null })
  insert(db, { id: 'anc_old', expiresAt: iso(NOW - 34 * HOUR) })

  const rows = db.prepare(LIST_EXPIRED).all(iso(NOW - 24 * HOUR), 200)
  assert.deepEqual(
    rows.map((row) => JSON.parse(row.data).announcementId),
    ['anc_old'],
  )
})

test('the cutoff is a string comparison, and ISO-8601 UTC orders correctly under it', () => {
  const db = migrated()
  /* Every writer stamps expiresAt with toISOString(), so every value is
   * fixed-width Zulu and lexical order is chronological order. This asserts
   * that rather than assuming it: a single offset-formatted timestamp
   * ("+02:00") would sort wrong and could be deleted early. */
  for (let hoursAgo = 25; hoursAgo <= 48; hoursAgo += 1) {
    insert(db, { id: `anc_${hoursAgo}`, expiresAt: iso(NOW - hoursAgo * HOUR) })
  }
  insert(db, { id: 'anc_inside_grace', expiresAt: iso(NOW - 23 * HOUR) })

  const rows = db.prepare(LIST_EXPIRED).all(iso(NOW - 24 * HOUR), 500)
  assert.equal(rows.length, 24)
  const ids = rows.map((row) => JSON.parse(row.data).announcementId)
  assert.equal(ids.includes('anc_inside_grace'), false)
  assert.equal(ids[0], 'anc_48', 'oldest expiry first')
})

test('LIMIT bounds one sweep, and the remainder is still there for the next', () => {
  const db = migrated()
  for (let index = 0; index < 10; index += 1) {
    insert(db, { id: `anc_${index}`, expiresAt: iso(NOW - (30 + index) * HOUR) })
  }

  const first = db.prepare(LIST_EXPIRED).all(iso(NOW - 24 * HOUR), 4)
  assert.equal(first.length, 4)
  for (const row of first) {
    db.prepare(DELETE_ONE).run(JSON.parse(row.data).announcementId)
  }
  assert.equal(db.prepare(LIST_EXPIRED).all(iso(NOW - 24 * HOUR), 200).length, 6)
})

test('the delete removes exactly one row', () => {
  const db = migrated()
  insert(db, { id: 'anc_a', expiresAt: iso(NOW - 34 * HOUR) })
  insert(db, { id: 'anc_b', expiresAt: iso(NOW - 34 * HOUR) })

  db.prepare(DELETE_ONE).run('anc_a')
  const left = db.prepare('SELECT announcement_id FROM relay_announcements').all()
  assert.deepEqual(
    left.map((row) => row.announcement_id),
    ['anc_b'],
  )
})

test('deleted text is gone from the database, not hidden from a query', () => {
  const db = migrated()
  const secret = 'PAGE-TEXT-THE-OWNER-NEVER-ASKED-TO-KEEP'
  insert(db, { id: 'anc_a', expiresAt: iso(NOW - 34 * HOUR), speech: secret })

  db.prepare(DELETE_ONE).run('anc_a')
  const everything = db.prepare('SELECT data FROM relay_announcements').all()
  assert.equal(everything.length, 0)
  assert.doesNotMatch(JSON.stringify(everything), new RegExp(secret))
})

test('the stats query counts and sizes both sides of the cutoff', () => {
  const db = migrated()
  insert(db, { id: 'anc_old', expiresAt: iso(NOW - 34 * HOUR) })
  insert(db, { id: 'anc_live', expiresAt: iso(NOW + 5 * HOUR) })
  insert(db, { id: 'anc_undated', expiresAt: null })

  const cutoff = iso(NOW - 24 * HOUR)
  const row = db.prepare(STATS).get(cutoff, cutoff)

  assert.equal(Number(row.total), 3)
  assert.equal(Number(row.expired), 1)
  assert.equal(Number(row.undated), 1)
  assert.ok(Number(row.total_bytes) > 0)
  assert.ok(Number(row.expired_bytes) > 0)
  assert.ok(Number(row.expired_bytes) < Number(row.total_bytes))
})

test('the stats query is safe on an empty table', () => {
  const db = migrated()
  const cutoff = iso(NOW - 24 * HOUR)
  const row = db.prepare(STATS).get(cutoff, cutoff)

  assert.equal(Number(row.total), 0)
  assert.equal(Number(row.total_bytes), 0)
  assert.equal(Number(row.expired_bytes), 0)
})

test('sweeping does not disturb the delivery query that has to keep working', () => {
  const db = migrated()
  insert(db, { id: 'anc_old', expiresAt: iso(NOW - 34 * HOUR) })
  const live = insert(db, {
    id: 'anc_live',
    createdAt: iso(NOW - HOUR),
    expiresAt: iso(NOW + 5 * HOUR),
  })

  db.prepare(DELETE_ONE).run('anc_old')
  const pending = db.prepare(LIST_PENDING).all('nrf9160-pendant', 'pending', 20)
  assert.deepEqual(
    pending.map((row) => JSON.parse(row.data).announcementId),
    [live.announcementId],
  )
})
