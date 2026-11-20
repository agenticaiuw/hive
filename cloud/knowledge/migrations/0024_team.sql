-- How Hive's agents work together (cloud/tasks/team.js): messages between agents, and leases on files.

-- A message from one agent to another (its name: a task's label like R12-1, or what an agent calls
-- itself), to "all" agents, or to a person ("owner" or a member).
CREATE TABLE IF NOT EXISTS team_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  request INTEGER,                        -- the board request it's about, if any
  at INTEGER NOT NULL                     -- unix seconds
);
CREATE INDEX IF NOT EXISTS team_messages_recipient ON team_messages (recipient, id);

-- Who has read which message (a message to "all" is read by each agent on its own).
CREATE TABLE IF NOT EXISTS team_reads (
  agent TEXT NOT NULL,
  message INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (agent, message)
);

-- An agent's lease on a file or glob in a repository, until it lapses or the agent lets go.
CREATE TABLE IF NOT EXISTS team_leases (
  repo TEXT NOT NULL,                     -- "hive"
  path TEXT NOT NULL,                     -- relative to the repository: a file, a glob, or "dir/"
  agent TEXT NOT NULL,
  exclusive INTEGER NOT NULL DEFAULT 1,   -- 0: shared, others may hold it too
  note TEXT NOT NULL DEFAULT '',          -- what for
  at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (repo, path, agent)
);
CREATE INDEX IF NOT EXISTS team_leases_expires ON team_leases (repo, expires_at);
