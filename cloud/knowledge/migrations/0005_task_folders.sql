-- Folders: the parts of a project (memory retrieval, major requirements validation), each with its
-- tasks and its own memories (notes, specs, decisions, the reports of its done tasks), which every
-- agent put on the folder gets in full. A task's part is now its folder; a done task has a report.
ALTER TABLE board_tasks RENAME COLUMN part TO folder;
ALTER TABLE board_tasks ADD COLUMN report TEXT;
-- One row per folder, whichever machine (or the web) made or last changed it. project is the
-- project's short name in lower case ("hive"), key the folder's name in lower case.
CREATE TABLE IF NOT EXISTS board_folders (
  project TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  machine TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (project, key)
);
-- Memories keep the id of the machine that wrote them ('web' for the dashboard's).
CREATE TABLE IF NOT EXISTS board_memories (
  machine TEXT NOT NULL,
  id INTEGER NOT NULL,
  project TEXT NOT NULL,
  folder TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  task TEXT,
  created_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
);
CREATE INDEX IF NOT EXISTS board_memories_folder ON board_memories (project, folder);
CREATE INDEX IF NOT EXISTS board_memories_synced ON board_memories (synced_at);
CREATE INDEX IF NOT EXISTS board_folders_synced ON board_folders (synced_at);
