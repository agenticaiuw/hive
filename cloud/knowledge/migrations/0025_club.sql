-- The club changes Hive through Hive (cloud/tasks/club.js; the owner, 2026-11-20: "anyone in our club
-- should be able to portal into that vm and then start editing the code through an agent").

-- A club member the owner let in. They sign in once with a one-use invite (invite_hash, until
-- invite_expires_at), which gives them their own key; only its SHA-256 is kept here (key_hash).
-- max_agents: how many of their changes to Hive run at once.
CREATE TABLE IF NOT EXISTS club_members (
  name TEXT PRIMARY KEY,
  max_agents INTEGER NOT NULL DEFAULT 3,
  key_hash TEXT,
  invite_hash TEXT,
  invite_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  seen_at INTEGER
);

-- The member who asked for a request (NULL: the owner). Hive runs a member's request only as changes to
-- Hive's own code (orchestrator.mjs), never on the owner's Mac, phone, browsers or accounts.
ALTER TABLE board_requests ADD COLUMN member TEXT;
CREATE INDEX IF NOT EXISTS board_requests_member ON board_requests (member, status);
