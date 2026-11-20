-- What the board knows about itself (cloud/tasks/phone.js): the address it was last reached by
-- ('origin'), which goes into the pairing Hive Phone connects back with, since the dashboard reaches
-- the board through a service binding that doesn't carry it.
CREATE TABLE IF NOT EXISTS board_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
