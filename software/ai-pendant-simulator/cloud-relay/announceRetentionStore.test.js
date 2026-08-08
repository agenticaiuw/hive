/*
 * The announcement deleter against the real in-memory store, and against the
 * real scheduler wiring.
 *
 * announceRetention.test.js proves the policy with a fake store; this proves
 * the store actually implements what the policy calls, and that the tick will
 * really invoke it. Nothing here touches D1 or the live relay — createMemoryStore
 * is a Map, and getStore() falls back to it whenever no Cloudflare bindings are
 * present, which is the case in a test process.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createAnnouncement } from './announce.js'
import { sweepExpiredAnnouncements } from './announceRetention.js'
import { createMemoryStore } from './store/memoryStore.js'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-08-07T12:00:00.000Z')
const GRACE = 24 * HOUR

async function seeded() {
  const store = createMemoryStore()
  /* memoryStore's Maps live at module scope, so every createMemoryStore() hands
   * back the same rows. Drain before seeding or one test reads another's. */
  for (const row of await store.listAnnouncements({ limit: 100 })) {
    await store.deleteAnnouncement(row.announcementId)
  }
  /* createAnnouncement stamps expiresAt 6h after `now`. */
  const old = createAnnouncement({
    deviceId: 'nrf9160-pendant',
    title: 'Yesterday',
    speech: 'From https://example.com: a wall of scraped page text.',
    now: NOW - 40 * HOUR,
  })
  const live = createAnnouncement({
    deviceId: 'nrf9160-pendant',
    title: 'Just now',
    speech: 'Something the owner has not heard yet.',
    now: NOW - HOUR,
  })
  const undated = {
    ...createAnnouncement({
      deviceId: 'nrf9160-pendant',
      title: 'No deadline',
      speech: 'A row with no expiry at all.',
      now: NOW - 400 * HOUR,
    }),
    expiresAt: null,
  }
  for (const announcement of [old, live, undated]) {
    await store.createAnnouncement(announcement)
  }
  return { store, old, live, undated }
}

test('the in-memory store implements the three calls the sweep makes', async () => {
  const { store, old } = await seeded()
  const before = new Date(NOW - GRACE).toISOString()

  const expired = await store.listExpiredAnnouncements({ before, limit: 200 })
  assert.deepEqual(
    expired.map((item) => item.announcementId),
    [old.announcementId],
  )

  const stats = await store.announcementStats({ before })
  assert.equal(stats.total, 3)
  assert.equal(stats.expired, 1)
  assert.equal(stats.undated, 1)
  assert.ok(stats.totalBytes > stats.expiredBytes)

  assert.equal(await store.deleteAnnouncement(old.announcementId), true)
  assert.equal(await store.deleteAnnouncement(old.announcementId), false)
})

test('a live sweep against the real store removes only the expired row', async () => {
  const { store, old, live, undated } = await seeded()

  const report = await sweepExpiredAnnouncements(store, {
    now: NOW,
    graceMs: GRACE,
    dryRun: false,
  })

  assert.equal(report.removed.count, 1)
  assert.ok(report.removed.bytes > 0)
  assert.equal(report.kept.count, 2)
  assert.equal(report.kept.undated, 1)

  const left = await store.listAnnouncements({ limit: 100 })
  const ids = left.map((item) => item.announcementId).sort()
  assert.deepEqual(ids, [live.announcementId, undated.announcementId].sort())
  assert.equal(
    left.some((item) => item.announcementId === old.announcementId),
    false,
  )
})

test('the delivery path still finds what it is supposed to after a sweep', async () => {
  const { store, live, undated, old } = await seeded()
  await sweepExpiredAnnouncements(store, { now: NOW, graceMs: GRACE, dryRun: false })

  const { selectDeliverable } = await import('./announce.js')
  const pending = await store.listAnnouncements({
    deviceId: 'nrf9160-pendant',
    state: 'pending',
    limit: 20,
  })
  const deliverable = selectDeliverable(pending, { now: NOW }).map(
    (item) => item.announcementId,
  )

  assert.ok(
    deliverable.includes(live.announcementId),
    'the announcement the owner has not heard is still deliverable',
  )
  assert.equal(
    deliverable.includes(old.announcementId),
    false,
    'the swept one is gone',
  )
  /* An undated row stays deliverable, which is announcementIsLive's existing
   * rule and the right partner to this policy: a row with no deadline is not
   * expired, so retention will not delete it and delivery will not skip it. */
  assert.ok(deliverable.includes(undated.announcementId))
})

test('the scheduler really runs the sweep, and records what it did', async () => {
  /*
   * The gap this closes: both relay retention policies existed as ops routes
   * nobody called, which is the same as no retention at all. This asserts the
   * tick path, not the policy.
   */
  const { runRetentionNow, RETENTION_STATE_KEY } = await import('./scheduler.js')
  const { getStore } = await import('./store/index.js')
  const store = await getStore()

  const old = createAnnouncement({
    deviceId: 'nrf9160-pendant',
    title: 'Yesterday',
    speech: 'Scraped page text with a deadline that passed two days ago.',
    now: NOW - 60 * HOUR,
  })
  await store.createAnnouncement(old)

  const summary = await runRetentionNow({ now: NOW })

  assert.equal(summary.announcements.dryRun, false, 'announcements sweep for real')
  assert.ok(summary.announcements.removed.count >= 1)
  assert.equal(
    await store
      .listAnnouncements({ limit: 100 })
      .then((rows) => rows.some((row) => row.announcementId === old.announcementId)),
    false,
    'the row is gone from the store',
  )

  /* Audio is the opposite call, deliberately: wiring it up did not switch it
   * on. AUDIO_RETENTION_SWEEP_ENABLED is false in wrangler.jsonc and unset
   * here, so the sweep runs and deletes nothing. */
  assert.equal(summary.audio.dryRun, true, 'audio stays dry-run until the owner opts in')

  const state = await store.getState(RETENTION_STATE_KEY)
  assert.equal(state.data.sweptAt, new Date(NOW).toISOString())
})

test('the hourly gate stops the tick paying for a sweep every minute', async () => {
  const { runScheduledTick } = await import('./scheduler.js')

  const first = await runScheduledTick({ trigger: 'test', now: NOW + HOUR, logger: {} })
  assert.ok(first.retention, 'the first tick past the interval sweeps')

  const second = await runScheduledTick({
    trigger: 'test',
    now: NOW + HOUR + 60_000,
    logger: {},
  })
  assert.equal(second.retention, null, 'a minute later it does not')
})
