-- Instructions the owner sends from the dashboard to Hive's orchestrator in the cloud. Each is also
-- a board message (machine "cloud", harness "hive", same id) so its tasks hang off it like any
-- agent's. The orchestrator (cloud/vm-agent/orchestrator.mjs) takes the oldest queued one, plans it
-- into tasks with a model each, runs them and reports back here.
CREATE TABLE IF NOT EXISTS board_requests (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,           -- who it's for: "hive-cloud"
  folder TEXT,                   -- the folder it was sent from, if any
  status TEXT NOT NULL,          -- queued, planning, working, done, failed
  taken_by TEXT,
  taken_at INTEGER,
  finished_at INTEGER,
  outcome TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_requests_status ON board_requests (status, id);
