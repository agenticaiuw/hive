-- The owner's task board, every machine's copy in one place (cloud/tasks/worker.js). Each machine
-- keeps its own ledger (desktop/app/crates/hive/hive-tasks) and pushes what changed; rows keep
-- that machine's ids, so a row is (machine, id).
CREATE TABLE IF NOT EXISTS board_messages (
  machine TEXT NOT NULL,
  id INTEGER NOT NULL,
  harness TEXT NOT NULL,
  session TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  said_at INTEGER NOT NULL,
  times INTEGER NOT NULL DEFAULT 1,
  split_at INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
);
CREATE TABLE IF NOT EXISTS board_tasks (
  machine TEXT NOT NULL,
  id INTEGER NOT NULL,
  message INTEGER NOT NULL,
  quote TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  minutes INTEGER,
  value TEXT,
  outcome TEXT,
  evidence TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER,
  left_open_at INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
);
CREATE TABLE IF NOT EXISTS board_rules (
  machine TEXT NOT NULL,
  id INTEGER NOT NULL,
  project TEXT NOT NULL,
  paths TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL,
  quote TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  shown INTEGER NOT NULL DEFAULT 0,
  last_shown_at INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
);
-- One-use codes that sign a browser in to the board page (`hive-tasks web`).
CREATE TABLE IF NOT EXISTS board_login_codes (
  code TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_tasks_updated ON board_tasks (updated_at);
CREATE INDEX IF NOT EXISTS board_tasks_status ON board_tasks (status);
CREATE INDEX IF NOT EXISTS board_messages_said ON board_messages (said_at);
