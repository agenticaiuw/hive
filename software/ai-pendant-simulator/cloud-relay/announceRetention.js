/*
 * Retention for outbound announcements — the half of the policy that actually
 * removes bytes.
 *
 * WHAT WAS WRONG. An announcement is created with an expiry
 * (announce.js ANNOUNCEMENT_DEFAULT_TTL_MS, six hours) and every reader honours
 * it: announcementIsLive() rejects an expired row, selectDeliverable() filters
 * on it, so nothing can be spoken past its deadline. What no code did anywhere
 * was DELETE one. Grepped before this file existed, there was no
 * `DELETE FROM relay_announcements` in the repository. An expired announcement
 * was therefore invisible and permanent at the same time, which is the shape of
 * a promise the system is not keeping: the dashboard says six hours, the
 * database says forever.
 *
 * WHY IT MATTERS MORE THAN THE ROW COUNT SUGGESTS. Announcements do not only
 * carry text the relay wrote. routines.js composeOnRelay() reads the owner's
 * configured page sources with Cloudflare Browser Run and pushes up to 1500
 * characters of that page into the announcement's speech (ANNOUNCEMENT_MAX_CHARS).
 * So the thing being kept forever is scraped web content that the owner asked to
 * hear once, at 7am, and never asked to keep.
 *
 * WHAT THIS DELETES, AND WHAT IT REFUSES TO.
 *   - Deletes: rows whose own `expiresAt` — written at creation, from a TTL the
 *     code can be pointed at — passed more than the configured grace ago.
 *   - Never deletes: a row with no expiry at all. An announcement with a null
 *     `expires_at` is not "expired", it is unclassified, and unclassified means
 *     keep. Reported as `undated` so it is visible rather than silently skipped.
 *   - Never deletes: a row whose expiry is unparseable, for the same reason.
 *   - Never deletes: anything still deliverable, whatever its state. The cutoff
 *     is strictly older than announcementIsLive()'s.
 *
 * The sweep is dryRun by default at the function level, so a caller has to ask.
 * The scheduler asks (see ANNOUNCEMENT_RETENTION_SWEEP_ENABLED in config.js for
 * why this one runs and the audio one does not).
 */
import {
  ANNOUNCEMENT_RETENTION_DEFAULT_GRACE_MS,
  ANNOUNCEMENT_RETENTION_GRACE_MS,
  ANNOUNCEMENT_RETENTION_SWEEP_ENABLED,
} from './config.js'
import { ANNOUNCEMENT_DEFAULT_TTL_MS } from './announce.js'

export const ANNOUNCEMENT_SWEEP_MAX_BATCH = 200

export function normalizeGraceMs(value) {
  const parsed = Number(value)
  /* A blank or non-positive grace falls back to the default rather than to
   * zero, the same rule config.js applies to AUDIO_RETENTION_MAX_AGE_MS: an
   * accidental `=0` must never mean "delete the moment it expires". */
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : ANNOUNCEMENT_RETENTION_DEFAULT_GRACE_MS
}

export function announcementRetentionPolicy({
  graceMs = ANNOUNCEMENT_RETENTION_GRACE_MS,
  sweepEnabled = ANNOUNCEMENT_RETENTION_SWEEP_ENABLED,
  now = Date.now(),
} = {}) {
  const safeGraceMs = normalizeGraceMs(graceMs)
  return {
    /* Stated so a report explains itself: the deadline is the announcement's
     * own, this only says how long after it the row survives. */
    announcementTtlMs: ANNOUNCEMENT_DEFAULT_TTL_MS,
    graceMs: safeGraceMs,
    graceHours: Math.round((safeGraceMs / (1000 * 60 * 60)) * 100) / 100,
    defaultGraceMs: ANNOUNCEMENT_RETENTION_DEFAULT_GRACE_MS,
    sweepEnabled: Boolean(sweepEnabled),
    deleteBefore: new Date(now - safeGraceMs).toISOString(),
    keeps: 'Rows with no expiry, or an unreadable one, are never deleted.',
    sweepPath: '/v1/ops/announcement-retention/sweep',
    settings: {
      grace: 'ANNOUNCEMENT_RETENTION_GRACE_MS',
      disable: 'ANNOUNCEMENT_RETENTION_SWEEP_ENABLED=false',
    },
  }
}

export function announcementBytes(announcement) {
  return Buffer.byteLength(JSON.stringify(announcement ?? null), 'utf8')
}

/**
 * Is this row provably past the policy?
 *
 * Provably: the expiry has to be present, parseable, and older than the cutoff.
 * Anything else returns false. Mirrors isAudioCaptureExpired() deliberately —
 * two retention rules that disagree about malformed metadata is how one of them
 * ends up deleting something it should not have.
 */
export function announcementIsSweepable(
  announcement,
  { now = Date.now(), graceMs = ANNOUNCEMENT_RETENTION_GRACE_MS } = {},
) {
  const expiresAt = Date.parse(announcement?.expiresAt || '')
  if (!Number.isFinite(expiresAt)) return false
  return expiresAt + normalizeGraceMs(graceMs) <= now
}

function receiptFor(announcement) {
  return {
    announcementId: announcement.announcementId,
    deviceId: announcement.deviceId ?? null,
    state: announcement.state ?? null,
    routineId: announcement.routineId ?? null,
    createdAt: announcement.createdAt ?? null,
    expiresAt: announcement.expiresAt ?? null,
    /* Length, never the text. A retention receipt that quoted the speech would
     * re-create the thing being deleted, in a log. */
    speechChars: String(announcement.speech || '').length,
    bytes: announcementBytes(announcement),
  }
}

/**
 * Remove every announcement provably past the policy.
 *
 * dryRun is the default. The report is the same shape either way, so what a
 * live sweep did and what a dry one would have done are directly comparable.
 */
export async function sweepExpiredAnnouncements(
  store,
  {
    now = Date.now(),
    graceMs = ANNOUNCEMENT_RETENTION_GRACE_MS,
    limit = ANNOUNCEMENT_SWEEP_MAX_BATCH,
    dryRun = true,
  } = {},
) {
  const safeGraceMs = normalizeGraceMs(graceMs)
  const policy = announcementRetentionPolicy({ graceMs: safeGraceMs, now })
  const before = new Date(now - safeGraceMs).toISOString()

  const stats = (await store.announcementStats?.({ before })) ?? {
    total: null,
    totalBytes: null,
    expired: null,
    expiredBytes: null,
    undated: null,
  }

  const candidates = (await store.listExpiredAnnouncements({ before, limit })) || []
  /* The store already applied the cutoff in SQL; re-checking in JS is the
   * belt on top of it. A bad bind or a string comparison against a
   * differently-formatted timestamp would otherwise delete a live row, and
   * that is not a bug you get to find afterwards. */
  const expired = candidates.filter((announcement) =>
    announcementIsSweepable(announcement, { now, graceMs: safeGraceMs }),
  )
  const refused = candidates.length - expired.length

  const report = {
    dryRun: Boolean(dryRun),
    policy,
    scanned: candidates.length,
    /* Counts AND bytes, for what went and for what stayed. */
    removed: { count: 0, bytes: 0 },
    kept: {
      count: stats.total === null ? null : stats.total - expired.length,
      bytes:
        stats.totalBytes === null
          ? null
          : stats.totalBytes - expired.reduce((sum, item) => sum + announcementBytes(item), 0),
      undated: stats.undated,
      note: 'Undated rows are kept on purpose: an announcement with no expiry has no policy to be past.',
    },
    eligible: expired.map(receiptFor),
    refusedByRecheck: refused,
    deleted: [],
    failed: [],
  }

  if (dryRun) return report

  for (const announcement of expired) {
    const receipt = receiptFor(announcement)
    try {
      const gone = await store.deleteAnnouncement(announcement.announcementId)
      if (gone) {
        report.deleted.push(receipt)
        report.removed.count += 1
        report.removed.bytes += receipt.bytes
      } else {
        report.failed.push({ ...receipt, reason: 'row was already gone' })
      }
    } catch (error) {
      report.failed.push({ ...receipt, reason: String(error?.message ?? error) })
    }
  }

  return report
}
