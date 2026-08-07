-- Cross-surface memory log (shared/fleetMemory.js).
--
-- Every body appends typed events here; each surface reads a projection of the
-- fold. Before this, exactly one body on the fleet could write memory — the Mac
-- — and the only thing that crossed was a block of already-rendered prompt text
-- it PUT into relay_state. The relay could not add to it and could not re-scope
-- it to what was actually asked.
--
-- Apply:
--   npx wrangler d1 execute ai-pendant-relay-db --remote \
--     --file cloudflare-worker/fleet-memory-migration.sql
--
-- Kept out of relay_state on purpose, and the reason is not tidiness. relay_state
-- is one row per key, overwritten in place, which requires a writer that can read
-- the current value first. The bodies here are never awake at the same time —
-- that is the premise of the product and the reason context-handoff-migration.sql
-- exists — so "read, merge, write" is the one thing they cannot do. An append can
-- be made by a body that knows nothing about the others.
--
-- Kept out of relay_contexts too: a context is one frozen reasoning thread with a
-- two-hour deadline, while these are per-fact statements with per-type lifetimes
-- ranging from six hours to never.

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
