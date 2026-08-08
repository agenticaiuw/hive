/*
 * The live deleter, exercised against a fake store. Nothing here touches D1,
 * the live relay, or a real bucket — the sweep only ever calls three store
 * methods, so the fake is the whole surface it can reach.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAnnouncement } from './announce.js'
import {
  announcementIsSweepable,
  announcementRetentionPolicy,
  normalizeGraceMs,
  registerAnnouncementRetentionRoutes,
  sweepExpiredAnnouncements,
} from './announceRetention.js'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-08-07T12:00:00.000Z')
const GRACE = 24 * HOUR

function fakeStore(announcements = []) {
  const rows = new Map(
    announcements.map((announcement) => [announcement.announcementId, { ...announcement }]),
  )
  const deletes = []
  return {
    rows,
    deletes,
    async listExpiredAnnouncements({ before, limit = 200 }) {
      return [...rows.values()]
        .filter((row) => row.expiresAt && row.expiresAt <= before)
        .sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)))
        .slice(0, limit)
        .map((row) => ({ ...row }))
    },
    async announcementStats({ before }) {
      let expired = 0
      let expiredBytes = 0
      let totalBytes = 0
      let undated = 0
      for (const row of rows.values()) {
        const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
        totalBytes += bytes
        if (!row.expiresAt) {
          undated += 1
          continue
        }
        if (row.expiresAt <= before) {
          expired += 1
          expiredBytes += bytes
        }
      }
      return { total: rows.size, totalBytes, expired, expiredBytes, undated }
    },
    async deleteAnnouncement(announcementId) {
      deletes.push(announcementId)
      return rows.delete(announcementId)
    },
  }
}

function announcementAt(hoursAgo, overrides = {}) {
  const created = NOW - hoursAgo * HOUR
  return {
    ...createAnnouncement({
      deviceId: 'nrf9160-pendant',
      title: 'Morning briefing',
      speech: 'Scraped from a public page the owner never asked to keep.',
      now: created,
    }),
    ...overrides,
  }
}

test('the policy names the deadline it enforces and the grace it adds', () => {
  const policy = announcementRetentionPolicy({ graceMs: GRACE, now: NOW })
  assert.equal(policy.graceMs, GRACE)
  assert.equal(policy.graceHours, 24)
  assert.equal(policy.announcementTtlMs, 6 * HOUR, 'the TTL comes from announce.js')
  assert.equal(policy.deleteBefore, new Date(NOW - GRACE).toISOString())
})

test('a non-positive grace falls back to the default; it never means "now"', () => {
  assert.equal(normalizeGraceMs(0), 24 * HOUR)
  assert.equal(normalizeGraceMs(-1), 24 * HOUR)
  assert.equal(normalizeGraceMs('nonsense'), 24 * HOUR)
  assert.equal(normalizeGraceMs(90), 90)
})

test('only rows provably past expiry plus grace are sweepable', () => {
  /* Expires 6h after creation. Created 40h ago => expired 34h ago. */
  const old = announcementAt(40)
  /* Created 20h ago => expired 14h ago, still inside the 24h grace. */
  const recentlyExpired = announcementAt(20)
  /* Created an hour ago => still deliverable. */
  const live = announcementAt(1)

  assert.equal(announcementIsSweepable(old, { now: NOW, graceMs: GRACE }), true)
  assert.equal(
    announcementIsSweepable(recentlyExpired, { now: NOW, graceMs: GRACE }),
    false,
  )
  assert.equal(announcementIsSweepable(live, { now: NOW, graceMs: GRACE }), false)
})

test('a row with no expiry, or an unreadable one, is never sweepable', () => {
  assert.equal(
    announcementIsSweepable({ ...announcementAt(400), expiresAt: null }, {
      now: NOW,
      graceMs: GRACE,
    }),
    false,
  )
  assert.equal(
    announcementIsSweepable({ ...announcementAt(400), expiresAt: 'whenever' }, {
      now: NOW,
      graceMs: GRACE,
    }),
    false,
  )
  assert.equal(announcementIsSweepable(undefined, { now: NOW }), false)
})

test('dry run deletes nothing and reports exactly what a live run would remove', async () => {
  const store = fakeStore([announcementAt(40), announcementAt(1)])
  const report = await sweepExpiredAnnouncements(store, {
    now: NOW,
    graceMs: GRACE,
    dryRun: true,
  })

  assert.equal(report.dryRun, true)
  assert.equal(store.deletes.length, 0)
  assert.equal(store.rows.size, 2)
  assert.equal(report.eligible.length, 1)
  assert.equal(report.removed.count, 0)
  assert.equal(report.removed.bytes, 0)
})

test('a live sweep removes the bytes and reports counts and bytes both ways', async () => {
  const doomed = announcementAt(40)
  const keeper = announcementAt(1)
  const store = fakeStore([doomed, keeper])

  const report = await sweepExpiredAnnouncements(store, {
    now: NOW,
    graceMs: GRACE,
    dryRun: false,
  })

  assert.equal(report.dryRun, false)
  assert.deepEqual(store.deletes, [doomed.announcementId])
  assert.equal(store.rows.size, 1)
  assert.ok(store.rows.has(keeper.announcementId), 'the live one survived')

  assert.equal(report.removed.count, 1)
  assert.ok(report.removed.bytes > 0)
  assert.equal(report.kept.count, 1)
  assert.ok(report.kept.bytes > 0)
  assert.equal(report.failed.length, 0)
})

test('the receipt records the size of what was deleted, never the text', async () => {
  const secret = 'PRIVATE-PAGE-TEXT-THE-OWNER-NEVER-ASKED-TO-KEEP'
  const doomed = {
    ...announcementAt(40),
    speech: secret,
  }
  const store = fakeStore([doomed])

  const report = await sweepExpiredAnnouncements(store, {
    now: NOW,
    graceMs: GRACE,
    dryRun: false,
  })

  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, new RegExp(secret))
  assert.equal(report.deleted[0].speechChars, secret.length)
  assert.ok(report.deleted[0].bytes > 0)
})

test('a store that hands back a live row anyway is refused, not deleted', async () => {
  /* The SQL cutoff and the JS cutoff have to agree. If they ever do not — a
   * bad bind, a timestamp format that string-compares wrong — the second check
   * is what stops a deliverable announcement from being destroyed. */
  const live = announcementAt(1)
  const store = fakeStore([live])
  store.listExpiredAnnouncements = async () => [{ ...live }]

  const report = await sweepExpiredAnnouncements(store, {
    now: NOW,
    graceMs: GRACE,
    dryRun: false,
  })

  assert.equal(report.refusedByRecheck, 1)
  assert.equal(report.removed.count, 0)
  assert.equal(store.deletes.length, 0)
  assert.equal(store.rows.size, 1)
})

test('undated rows are counted and kept, never swept', async () => {
  const undated = { ...announcementAt(400), expiresAt: null }
  const store = fakeStore([undated, announcementAt(40)])

  const report = await sweepExpiredAnnouncements(store, {
    now: NOW,
    graceMs: GRACE,
    dryRun: false,
  })

  assert.equal(report.kept.undated, 1)
  assert.ok(store.rows.has(undated.announcementId))
  assert.equal(report.removed.count, 1)
})

test('a failed delete is reported, and does not stop the rest of the batch', async () => {
  const first = announcementAt(50)
  const second = announcementAt(40)
  const store = fakeStore([first, second])
  const realDelete = store.deleteAnnouncement.bind(store)
  store.deleteAnnouncement = async (id) => {
    if (id === first.announcementId) throw new Error('D1 unavailable')
    return realDelete(id)
  }

  const report = await sweepExpiredAnnouncements(store, {
    now: NOW,
    graceMs: GRACE,
    dryRun: false,
  })

  assert.equal(report.failed.length, 1)
  assert.match(report.failed[0].reason, /D1 unavailable/)
  assert.equal(report.removed.count, 1)
  assert.ok(store.rows.has(first.announcementId), 'the failure was not lost')
  assert.equal(store.rows.has(second.announcementId), false)
})

test('a store with no stats method still sweeps, and says the totals are unknown', async () => {
  const store = fakeStore([announcementAt(40)])
  delete store.announcementStats

  const report = await sweepExpiredAnnouncements(store, {
    now: NOW,
    graceMs: GRACE,
    dryRun: false,
  })

  assert.equal(report.removed.count, 1)
  assert.equal(report.kept.count, null)
  assert.equal(report.kept.bytes, null)
})

test('the routes register on an Express-shaped app and refuse anything else', () => {
  const routes = []
  const app = {
    get: (path) => routes.push(`GET ${path}`),
    post: (path) => routes.push(`POST ${path}`),
  }
  registerAnnouncementRetentionRoutes(app, { getStore: async () => fakeStore() })

  assert.deepEqual(routes, [
    'GET /v1/ops/announcement-retention',
    'POST /v1/ops/announcement-retention/sweep',
  ])
  assert.throws(() => registerAnnouncementRetentionRoutes({}, { getStore: () => {} }))
  assert.throws(() => registerAnnouncementRetentionRoutes(app))
})
