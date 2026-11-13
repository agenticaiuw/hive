-- Hive's action memory: the steps its agent takes while it works, recorded by Hive itself (not by
-- the model), so the next task on the same site, app or codebase can start from what worked.
--
-- Written by desktop/app/crates/hive/hive-knowledge/src/actions.rs. Never holds typed text (only
-- a web address typed into an address bar), passwords, codes, keys or the sign-in tool's details.
-- Additive: two new tables next to `knowledge`.

-- One row per distinct step: the same step (same place, tool and normalized element or reason) is
-- stored once, then counted.
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  -- device|place|tool|what, normalized; place is the page's host, else the app, else the codebase.
  step_key TEXT NOT NULL UNIQUE,
  -- "mac", "phone" or "shell".
  device TEXT NOT NULL,
  -- "click", "type_text", "open_app", "batch", "command", "file_change", ...
  tool TEXT NOT NULL,
  -- The app in front and its front window's title (the latest seen).
  app TEXT,
  window_title TEXT,
  -- The page in front: its registrable domain, host and address without ?query or #fragment.
  site TEXT,
  host TEXT,
  page TEXT,
  -- The git toplevel of the files a command or edit touched, and the files (JSON array).
  codebase TEXT,
  paths TEXT,
  -- What it acted on, when known, and the step the agent gave for it.
  element TEXT,
  reason TEXT,
  ok_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  -- The normalized request of the latest task that took it.
  last_task_key TEXT
);

CREATE INDEX IF NOT EXISTS actions_site ON actions (site, last_seen DESC);
CREATE INDEX IF NOT EXISTS actions_host ON actions (host, last_seen DESC);
CREATE INDEX IF NOT EXISTS actions_app ON actions (app, last_seen DESC);
CREATE INDEX IF NOT EXISTS actions_codebase ON actions (codebase, last_seen DESC);
CREATE INDEX IF NOT EXISTS actions_task ON actions (last_task_key);

-- One row per task run: its steps in order. The same request with the same steps and outcome is
-- stored once, then counted.
CREATE TABLE IF NOT EXISTS action_runs (
  id INTEGER PRIMARY KEY,
  -- A hash of task_key, the steps' keys and the outcome.
  run_key TEXT NOT NULL UNIQUE,
  -- The request, normalized (lower case words), and as said (shortened).
  task_key TEXT NOT NULL,
  request TEXT NOT NULL,
  -- The ingress receipt the request came with, if any.
  receipt TEXT,
  device TEXT,
  -- "done", "failed", "stopped", "interrupted" or "unknown" (Hive quit during it).
  outcome TEXT NOT NULL,
  -- JSON arrays of what it went through: sites (registrable domains), hosts, apps, codebases.
  sites TEXT NOT NULL DEFAULT '[]',
  hosts TEXT NOT NULL DEFAULT '[]',
  apps TEXT NOT NULL DEFAULT '[]',
  codebases TEXT NOT NULL DEFAULT '[]',
  -- JSON: [{"k": step_key, "tool", "where", "what", "ok", "n"}], in the order taken.
  steps TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS action_runs_task ON action_runs (task_key, last_seen DESC);
CREATE INDEX IF NOT EXISTS action_runs_seen ON action_runs (last_seen DESC);
