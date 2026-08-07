CREATE TABLE IF NOT EXISTS relay_devices (
  device_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_devices_updated_at
  ON relay_devices(updated_at DESC);

CREATE TABLE IF NOT EXISTS relay_device_credentials (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES relay_devices(device_id)
);

CREATE INDEX IF NOT EXISTS relay_device_credentials_device
  ON relay_device_credentials(device_id, revoked_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS relay_device_credentials_expiry
  ON relay_device_credentials(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS relay_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_jobs_queue
  ON relay_jobs(status, created_at ASC);

CREATE INDEX IF NOT EXISTS relay_jobs_updated_at
  ON relay_jobs(updated_at ASC);

-- Keyset pagination for /v1/ops/history and the audio retention sweep:
-- newest-first within a type, tie-broken by job_id so a shared millisecond
-- cannot hide a run across a page boundary.
CREATE INDEX IF NOT EXISTS relay_jobs_type_history
  ON relay_jobs(type, created_at DESC, job_id DESC);

CREATE TABLE IF NOT EXISTS relay_state (
  state_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_state_updated_at
  ON relay_state(updated_at DESC);

-- Canonical cross-device product records. relay_state remains a bounded
-- last-known telemetry cache and is intentionally not a conversation database.
CREATE TABLE IF NOT EXISTS product_accounts (
  account_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_sessions (
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT NOT NULL,
  version_key TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (account_id, session_id),
  FOREIGN KEY (account_id) REFERENCES product_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS product_sessions_account_updated
  ON product_sessions(account_id, updated_at DESC, session_id);

CREATE INDEX IF NOT EXISTS product_sessions_account_deleted
  ON product_sessions(account_id, deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS product_turns (
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT NOT NULL,
  version_key TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (account_id, session_id, turn_id),
  FOREIGN KEY (account_id, session_id)
    REFERENCES product_sessions(account_id, session_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS product_turns_session_created
  ON product_turns(account_id, session_id, created_at, turn_id);

CREATE INDEX IF NOT EXISTS product_turns_account_updated
  ON product_turns(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS product_memory_entities (
  account_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT NOT NULL,
  version_key TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (account_id, entity_id),
  FOREIGN KEY (account_id) REFERENCES product_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS product_memory_entities_account_updated
  ON product_memory_entities(account_id, updated_at DESC, entity_id);

CREATE TABLE IF NOT EXISTS product_memory_relations (
  account_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  from_entity_id TEXT NOT NULL,
  to_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  source_device_id TEXT NOT NULL,
  version_key TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (account_id, relation_id),
  FOREIGN KEY (account_id) REFERENCES product_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS product_memory_relations_account_updated
  ON product_memory_relations(account_id, updated_at DESC, relation_id);

CREATE TABLE IF NOT EXISTS product_sync_events (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  session_count INTEGER NOT NULL,
  turn_count INTEGER NOT NULL,
  memory_entity_count INTEGER NOT NULL,
  memory_relation_count INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES product_accounts(account_id)
);

CREATE INDEX IF NOT EXISTS product_sync_events_account_revision
  ON product_sync_events(account_id, revision DESC);

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

