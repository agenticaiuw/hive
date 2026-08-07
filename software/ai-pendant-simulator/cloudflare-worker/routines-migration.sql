-- Worker-side scheduling (cloud-relay/routines.js, cloud-relay/announce.js).
--
-- Routines used to live only on the Mac, which meant they only fired while
-- the Mac was awake — and the pendant is worn precisely when it is not. These
-- three tables move the CLOCK into the relay: what is scheduled, what each
-- occurrence did, and what is waiting to be said out loud.
--
-- Apply:
--   npx wrangler d1 execute ai-pendant-relay-db --remote \
--     --file cloudflare-worker/routines-migration.sql
--
-- Kept out of relay_jobs on purpose: that table is a 24 h work queue that
-- claimNextJob() hands to the Mac bridge and JOB_TTL_MS deletes. A routine is
-- durable configuration and must outlive both.

CREATE TABLE IF NOT EXISTS relay_routines (
  routine_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Epoch ms rather than ISO text: the due query runs every minute and an
  -- integer comparison needs no per-row parsing. NULL means "no next
  -- occurrence" (a spent one-shot, or a schedule that failed validation).
  next_run_at INTEGER,
  -- Claim token + expiry. Two overlapping ticks cannot take the same routine
  -- because the lease UPDATE is the claim.
  lease_owner TEXT,
  lease_until INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_routines_due
  ON relay_routines(enabled, next_run_at)
  WHERE next_run_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS relay_routines_lease
  ON relay_routines(lease_owner);

-- One row per occurrence: the receipt. A deferred occurrence writes nothing
-- (it has not run), so this table stays a record of work actually attempted.
CREATE TABLE IF NOT EXISTS relay_routine_runs (
  run_id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_routine_runs_routine
  ON relay_routine_runs(routine_id, started_at DESC);

-- reapDispatchedRuns() polls this every tick, so status leads the index.
CREATE INDEX IF NOT EXISTS relay_routine_runs_status
  ON relay_routine_runs(status, started_at DESC);

-- The outbound queue. Everything else in the relay is pulled by a device;
-- these are the things the relay wants to say first.
CREATE TABLE IF NOT EXISTS relay_announcements (
  announcement_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_announcements_pending
  ON relay_announcements(device_id, state, created_at ASC);
