-- The owner's browsers, reached through the cloud from any node (owner, 2026-11-16: "every node
-- should be able to reach every other node: through the cloud"). An agent on any node (Hive's agent on
-- the VM, Hive on a Mac) posts a command for the Hive extension in the owner's Safari or Chrome; the
-- extension takes it, runs it in that signed-in browser and posts the result (cloud/tasks/browser.js).
-- Commands are gone an hour after they were sent.
CREATE TABLE IF NOT EXISTS board_browser_commands (
  id INTEGER PRIMARY KEY,
  browser TEXT NOT NULL DEFAULT '',  -- which browser: 'safari', 'chrome', one browser's full name, or '' for any
  request INTEGER,                   -- the board_requests.id it was sent for, if any
  action TEXT NOT NULL,              -- JSON {type, params}, a type browser/chrome/src/bridge-core.js runs
  status TEXT NOT NULL,              -- queued, running, done, failed, expired (nobody took it), lost
  result TEXT,                       -- JSON {ok: true, result} or {ok: false, error}
  taken_by TEXT,                     -- the browser that took it: '<extension key name>/<safari|chrome>'
  created_at INTEGER NOT NULL,       -- unix milliseconds
  taken_at INTEGER,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS board_browser_commands_queue ON board_browser_commands (status, id);

-- When each browser last asked for work, so a sender can tell "not connected" from "slow".
CREATE TABLE IF NOT EXISTS board_browsers (
  name TEXT PRIMARY KEY,             -- '<extension key name>/<safari|chrome>'
  seen_at INTEGER NOT NULL           -- unix milliseconds
);
