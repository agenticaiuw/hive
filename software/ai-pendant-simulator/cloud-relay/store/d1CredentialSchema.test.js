/*
 * Run d1Store's real credential code against the real schema.
 *
 * deviceAuth.test.js proves the effective-scope model against memoryStore,
 * which is a Map: it cannot catch a missing column, a SELECT that forgot to ask
 * for one, or a migration that does not apply to the database that is actually
 * live. Those surface only against D1 — which is to say, in production, on the
 * path that decides what every device in the fleet may do.
 *
 * The stake is specific. `narrowed` is the difference between a stored scope
 * list that is a historical snapshot and one that is a permanent ceiling. If it
 * does not survive a write and a read, a credential minted as narrowed comes
 * back un-narrowed and silently re-widens to its full role — the exact failure
 * the flag exists to prevent, arriving quietly and on first use.
 *
 * So this drives createD1Store itself rather than a transcription of its SQL:
 * a statement that stops naming the column fails here instead of after a
 * deploy. D1 is SQLite, and the only dialect gap is ?N binding, which the
 * adapter below closes.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createD1Store } from './d1Store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, '..', '..', 'cloudflare-worker')

const sql = (file) => fs.readFileSync(path.join(WORKER, file), 'utf8')

/*
 * The D1 prepare/bind/first/all/run surface over node:sqlite. D1 uses ?N
 * placeholders, which node:sqlite will not bind positionally, so each ?N is
 * rewritten to ? and the arguments are replayed in order of appearance — which
 * also handles the statements that repeat a parameter (touch binds ?2 twice).
 */
function d1Over(db) {
  return {
    prepare(statement) {
      const order = []
      const rewritten = statement.replace(/\?(\d+)/g, (_match, index) => {
        order.push(Number(index) - 1)
        return '?'
      })
      const bound = (args) => order.map((index) => args[index])
      const runner = (args) => ({
        async run() {
          const result = db.prepare(rewritten).run(...bound(args))
          return { meta: { changes: result.changes } }
        },
        async first() {
          return db.prepare(rewritten).get(...bound(args)) ?? null
        },
        async all() {
          return { results: db.prepare(rewritten).all(...bound(args)) }
        },
      })
      return { bind: (...args) => runner(args), ...runner([]) }
    },
  }
}

const AT = '2026-08-09T12:00:00.000Z'

function credential(tokenId, overrides = {}) {
  return {
    tokenId,
    tokenHash: `hash-${tokenId}`,
    deviceId: 'phone-1',
    role: 'mobile',
    scopes: ['state:read'],
    createdAt: AT,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    updatedAt: AT,
    ...overrides,
  }
}

function columnsOf(db) {
  return db
    .prepare('PRAGMA table_info(relay_device_credentials)')
    .all()
    .map((row) => row.name)
}

function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec(sql('schema.sql'))
  db.prepare('INSERT INTO relay_devices (device_id, updated_at, data) VALUES (?, ?, ?)')
    .run('phone-1', AT, '{}')
  return db
}

/* A database as it exists TODAY on the live relay: built by the original
 * device-auth migration, with no `narrowed` column anywhere. */
function beforeMigration() {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE IF NOT EXISTS relay_devices (device_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, data TEXT NOT NULL);',
  )
  db.exec(sql('device-auth-migration.sql'))
  db.prepare('INSERT INTO relay_devices (device_id, updated_at, data) VALUES (?, ?, ?)')
    .run('phone-1', AT, '{}')
  return db
}

test('the migration brings a live database to exactly the shape schema.sql builds', () => {
  const existing = beforeMigration()
  assert.equal(
    columnsOf(existing).includes('narrowed'),
    false,
    'the pre-migration table must not already have the column, or this proves nothing',
  )

  existing.exec(sql('credential-narrowing-migration.sql'))

  /* Column for column, order included: schema.sql declares `narrowed` last
   * precisely because ALTER TABLE ADD COLUMN appends. A file that describes the
   * database but cannot rebuild it is worse than no file. */
  assert.deepEqual(columnsOf(existing), columnsOf(fresh()))
  assert.equal(columnsOf(existing).at(-1), 'narrowed')
})

test('rows written before the migration read back as un-narrowed, not as ceilings', async () => {
  /*
   * The no-backfill claim, checked rather than asserted in a comment. Both real
   * credentials in the fleet were written before this column existed; after the
   * ALTER they must come back un-narrowed, which is what makes them track live
   * role policy instead of freezing at whatever their row happens to say.
   */
  const db = beforeMigration()
  db.prepare(
    `INSERT INTO relay_device_credentials
       (token_id, token_hash, device_id, role, scopes, created_at,
        last_used_at, expires_at, revoked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('tok-old', 'hash', 'phone-1', 'mobile', '["state:read"]', AT, null, null, null, AT)

  db.exec(sql('credential-narrowing-migration.sql'))

  const store = createD1Store(d1Over(db))
  const read = await store.getDeviceCredential('tok-old')
  assert.equal(read.narrowed, false)
  assert.deepEqual(read.scopes, ['state:read'])
})

test('a narrowed credential survives d1Store write and read as narrowed', async () => {
  /* The whole point of the column. If this round trip loses the flag, a
   * deliberately capped credential comes back tracking its full role. */
  const store = createD1Store(d1Over(fresh()))
  await store.saveDeviceCredential(credential('tok-narrow', { narrowed: true }))
  await store.saveDeviceCredential(
    credential('tok-wide', { scopes: ['state:read', 'mac:execute'] }),
  )

  assert.equal((await store.getDeviceCredential('tok-narrow')).narrowed, true)
  assert.equal((await store.getDeviceCredential('tok-wide')).narrowed, false)

  /* The listing an operator reads must carry it too, or the dashboard cannot
   * tell a capped credential from an uncapped one. */
  const listed = await store.listDeviceCredentials()
  assert.deepEqual(
    Object.fromEntries(listed.map((row) => [row.tokenId, row.narrowed])),
    { 'tok-narrow': true, 'tok-wide': false },
  )
  assert.deepEqual(
    (await store.listDeviceCredentials({ deviceId: 'phone-1' })).map((row) => row.narrowed),
    [true, false],
  )
})

test('touching and revoking a credential never disturb its ceiling', async () => {
  /*
   * Both UPDATEs name their columns and neither names `narrowed`, so this holds
   * today. It is asserted because the failure mode is invisible: the credential
   * would quietly widen the first time it was used, which is the moment nobody
   * is looking.
   */
  const store = createD1Store(d1Over(fresh()))
  await store.saveDeviceCredential(credential('tok-narrow', { narrowed: true }))

  const touched = await store.touchDeviceCredential('tok-narrow', '2026-08-09T13:00:00.000Z')
  assert.equal(touched.narrowed, true)

  const revoked = await store.revokeDeviceCredential('tok-narrow', '2026-08-09T14:00:00.000Z')
  assert.equal(revoked.narrowed, true)
  assert.equal(revoked.revokedAt, '2026-08-09T14:00:00.000Z')
})
