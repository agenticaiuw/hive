-- The owner's Macs, driven by Hive's agent in the cloud (owner, 2026-11-18: "The Mac's agent still
-- thinks on the Mac... the design goal is a cloud brain driving the Mac"). The agent on the VM posts a
-- call to one of the Mac's tools (hive-mac's MacTools: screenshot, click, type_text, open_app...); Hive
-- on that Mac takes it, runs it with its own tools, under the same rules as its own tasks (the owner
-- taking the mouse and keyboard, one-way steps quoting the owner), and posts the result
-- (cloud/tasks/mac.js). Calls are gone an hour after they were sent.
CREATE TABLE IF NOT EXISTS board_mac_calls (
  id INTEGER PRIMARY KEY,
  mac TEXT NOT NULL DEFAULT '',      -- which Mac (its hive-tasks machine name), or '' for the one last seen
  request INTEGER,                   -- the board_requests.id it was sent for, whose words a one-way step must quote
  name TEXT NOT NULL,                -- the tool
  arguments TEXT NOT NULL,           -- JSON object
  status TEXT NOT NULL,              -- queued, running, done, failed, expired (no Mac took it), lost, cancelled
  result TEXT,                       -- JSON: the tool's MCP result {content, isError?}, or {error}
  taken_by TEXT,                     -- the Mac that took it
  created_at INTEGER NOT NULL,       -- unix milliseconds
  taken_at INTEGER,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS board_mac_calls_queue ON board_mac_calls (status, id);

-- When each Mac last asked for work, and the tools it offers (MacTools::tools(), MCP-style).
CREATE TABLE IF NOT EXISTS board_macs (
  name TEXT PRIMARY KEY,
  tools TEXT NOT NULL DEFAULT '[]',
  about TEXT NOT NULL DEFAULT '',
  seen_at INTEGER NOT NULL           -- unix milliseconds
);
