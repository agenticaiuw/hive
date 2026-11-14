-- How much of each subscription's usage windows the owner's agents have used, as each machine last
-- read it from its harness (Codex writes rate_limits into every session; Claude Code doesn't, yet).
-- One row per machine and harness home; windows is a JSON list of {minutes, used, resets_at}.
CREATE TABLE IF NOT EXISTS board_limits (
  machine TEXT NOT NULL,
  id TEXT NOT NULL,          -- harness:home, e.g. codex:~/.codex
  harness TEXT NOT NULL,
  home TEXT,
  plan TEXT,
  windows TEXT,
  at INTEGER,                -- when the harness wrote it
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
);
