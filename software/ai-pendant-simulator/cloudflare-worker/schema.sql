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

-- Reasoning threads handed from one body to another (contextHandoff.js).
-- See context-handoff-migration.sql for why this is neither a job nor state.
CREATE TABLE IF NOT EXISTS relay_contexts (
  handle_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_contexts_expiry
  ON relay_contexts(expires_at);

-- Cross-surface memory log (shared/fleetMemory.js). Every body appends typed
-- events; each surface reads a projection of the fold.
--
-- See fleet-memory-migration.sql for why this is neither relay_state (one row
-- per key, overwritten in place — which needs a writer that can read the
-- current value first, and these bodies are never awake at the same time) nor
-- relay_contexts (one frozen reasoning thread with a two-hour deadline, where
-- these are per-fact statements with lifetimes from six hours to never).
--
-- This block and that migration must stay byte-identical from CREATE TABLE
-- down. The migration is what an existing database runs; this file is what a
-- new one is built from, and a schema that cannot rebuild the database it
-- describes is a backup that does not restore.
CREATE TABLE IF NOT EXISTS relay_memory_events (
  event_id TEXT PRIMARY KEY,
  -- preference | task | entity | event, in the order that decides who survives
  -- byte pressure. Stored as text rather than an integer rank so a row is
  -- readable in a d1 console without the JS constant next to it.
  type TEXT NOT NULL,
  -- Not "key": KEY is a keyword in enough SQL dialects that a future move off
  -- D1 would need quoting everywhere. The JS field is `key`; d1Store maps it.
  fact_key TEXT NOT NULL,
  -- Which body wrote it. Half of what makes a cross-node fact usable: a reader
  -- has to be able to weigh a page scrape against the owner's own words.
  node TEXT NOT NULL,
  -- JSON array. '[]' means every surface. Filtered in JS, not here, so the
  -- surface rule has exactly one implementation.
  surfaces TEXT NOT NULL DEFAULT '[]',
  at TEXT NOT NULL,
  -- NULL means never: a preference is a standing choice, not news.
  expires_at TEXT,
  -- Denormalised so the log's SIZE can be asked about, and enforced, without
  -- parsing every row. The budget is bytes and never a row count — a store on
  -- this project was once wedged by a cap that counted rows while the rows grew.
  bytes INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);

-- The sweep deletes by deadline and every read filters on it, so expiry leads.
-- Partial, because preferences never expire and would otherwise be the bulk of
-- a full-column index that no query can use.
CREATE INDEX IF NOT EXISTS relay_memory_events_expiry
  ON relay_memory_events(expires_at)
  WHERE expires_at IS NOT NULL;

-- The compaction delete is a correlated "is there a newer row for this key",
-- and it runs on every append. Without this index that is a table scan per row.
CREATE INDEX IF NOT EXISTS relay_memory_events_fold
  ON relay_memory_events(type, fact_key, at DESC, event_id DESC);

-- Reads and evictions both order by CASE(type), at DESC, event_id DESC. SQLite
-- cannot use an index for the CASE, but type is its leading column, so this
-- still turns the per-type recency sort into an index walk.
CREATE INDEX IF NOT EXISTS relay_memory_events_value
  ON relay_memory_events(type, at DESC, event_id DESC);

