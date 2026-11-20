-- Hive's nodes and the code each runs, and the releases they update to (cloud/tasks/nodes.js).
-- board_nodes: the last each node said on a call (x-hive-node, x-hive-version, x-hive-protocol) and
-- the last its updater reported (note). board_releases: each kind of node's published code; the bytes
-- are in R2 (the RELEASES bucket) under <kind>/<version>. Times are milliseconds.
CREATE TABLE IF NOT EXISTS board_nodes (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  protocol INTEGER,
  seen_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  note_at INTEGER,
  PRIMARY KEY (kind, name)
);
CREATE TABLE IF NOT EXISTS board_releases (
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  protocol INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL,
  PRIMARY KEY (kind, version)
);
CREATE INDEX IF NOT EXISTS board_releases_newest ON board_releases (kind, published_at);
