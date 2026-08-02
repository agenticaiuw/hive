PRAGMA foreign_keys = ON;

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
