-- Cross-environment context migration (shared/contextHandoff.js).
--
-- A body that finishes work stores its reasoning thread here and gets back an
-- opaque handle. The handle travels on the job; the receiving body pulls the
-- context with it. Pull rather than push, so the context is not re-sent on
-- every hop and can be shaped for whichever body asks.
--
-- Apply:
--   npx wrangler d1 execute ai-pendant-relay-db --remote \
--     --file cloudflare-worker/context-handoff-migration.sql
--
-- Kept out of relay_jobs and relay_state on purpose. relay_jobs is a 24 h work
-- queue; a context expires in 2 h because it describes a machine state that
-- goes stale (see CONTEXT_TTL_MS). relay_state is an unexpiring telemetry
-- cache; this is the owner's actual words and must have a deadline.

CREATE TABLE IF NOT EXISTS relay_contexts (
  -- The lookup half of the handle. Safe to log. The other half is a 256-bit
  -- secret that is never stored — only its SHA-256 — so a dump of this table
  -- cannot fetch anything back.
  handle_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Denormalised so the size of the store can be asked about without parsing
  -- every row; the byte budget that produced it lives in contextHandoff.js.
  bytes INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);

-- The sweep deletes by deadline and every read filters on it, so expiry leads.
CREATE INDEX IF NOT EXISTS relay_contexts_expiry
  ON relay_contexts(expires_at);
