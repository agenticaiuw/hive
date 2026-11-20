-- A club member's own devices take the club's releases with a key of their own (cloud/tasks/club.js
-- /v1/club/devices/code and /connect; the owner, 2026-11-20: "how would all the club members receive
-- all the updates like in ... mac and windows app"). The member's key lives in their browser's cookie,
-- so a Mac gets its own: the club page asks for a one-use code (code_hash, until expires_at), and Hive
-- on the Mac trades it for a key (key_hash) that works as the member's until the member is let go.
CREATE TABLE IF NOT EXISTS club_device_codes (
  code_hash TEXT PRIMARY KEY,
  member TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS club_device_keys (
  member TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  device TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (member, key_hash)
);
