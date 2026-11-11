-- The owner's knowledge base: one fact per row, learned by Hive agents while they work.
--
-- Each Hive owner has their own D1 database (default name "hive-knowledge") in their own
-- Cloudflare account, so there is no account column. Agents write to it through
-- desktop/app/python/knowledge.py, which checks for an existing row before adding one.

CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY,
  -- Whom or what the fact is about: "owner" for the owner, otherwise a person's or
  -- organization's name, an account, a place or a thing.
  subject TEXT NOT NULL,
  -- Which fact it is: "phone number", "school email", "role", "address".
  attribute TEXT NOT NULL,
  -- The fact itself.
  value TEXT NOT NULL,
  -- "fact" when seen directly; "inference" when the agent concluded it.
  kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact', 'inference')),
  -- Where the agent learned it: "Contacts, My Card", "WIN confirmation page".
  source TEXT NOT NULL,
  -- The task it was learned in, and the device or agent that saved it.
  task TEXT,
  device TEXT,
  learned_at TEXT NOT NULL,
  -- Last time an agent came across the same fact again.
  confirmed_at TEXT,
  -- Set when a newer value replaced this one; outdated rows are kept, not deleted.
  outdated_at TEXT,
  replaced_by INTEGER,
  -- Normalized forms used to tell whether a fact is already stored.
  subject_key TEXT NOT NULL,
  attribute_key TEXT NOT NULL,
  value_key TEXT NOT NULL,
  UNIQUE (subject_key, attribute_key, value_key)
);

CREATE INDEX IF NOT EXISTS knowledge_subject_value ON knowledge (subject_key, value_key);
CREATE INDEX IF NOT EXISTS knowledge_learned ON knowledge (learned_at DESC);
