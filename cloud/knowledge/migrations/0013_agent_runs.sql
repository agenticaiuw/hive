-- Every node's agent, live. A run is one thing an agent on one of the owner's machines was asked to do:
-- a request to Hive on a Mac, a task Hive's cloud agent runs on the VM (and the phone through it), a
-- command the browser extension's own agent runs. Its steps are each thing the agent said or did
-- ("click(x=514, y=421)", "→ click: Open Compose", "💬 …", "Done."). Each node sends its own runs to the
-- board a few steps at a time while it works (POST /v1/runs), and every node's dashboard shows them as
-- they land. This replaces board_request_steps (0011): the cloud agent's steps are runs like any other.
CREATE TABLE IF NOT EXISTS board_runs (
  machine TEXT NOT NULL,                  -- the node: a Mac's name, "cloud" (the VM), "ext:chrome" (a browser)
  run TEXT NOT NULL,                      -- the node's own name for the run
  agent TEXT NOT NULL,                    -- which agent there: "mac", "cloud", "code", "browser"
  title TEXT NOT NULL DEFAULT '',         -- what it was asked to do
  status TEXT NOT NULL DEFAULT 'working', -- working, done, failed, stopped
  request INTEGER,                        -- the board request it is part of (board_requests.id), if any
  task INTEGER,                           -- and its task's key in that request
  started_at INTEGER NOT NULL,            -- unix seconds
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (machine, run)
);
CREATE INDEX IF NOT EXISTS board_runs_updated ON board_runs (updated_at);
CREATE INDEX IF NOT EXISTS board_runs_request ON board_runs (request);

CREATE TABLE IF NOT EXISTS board_run_steps (
  machine TEXT NOT NULL,
  run TEXT NOT NULL,
  n INTEGER NOT NULL,                     -- 1, 2, 3… numbered by the node, so a re-sent step lands once
  at INTEGER NOT NULL,                    -- unix seconds
  kind TEXT NOT NULL DEFAULT '',          -- what sort of step, when the node knows: action, think, say, done, failed
  text TEXT NOT NULL,
  PRIMARY KEY (machine, run, n)
);

-- The cloud agent's steps so far become its runs: one per task, named like its board task (request*100+key).
INSERT OR IGNORE INTO board_runs (machine, run, agent, title, status, request, task, started_at, updated_at)
SELECT 'cloud', CAST(s.request * 100 + s.task AS TEXT), 'cloud', COALESCE(m.text, ''),
       CASE WHEN r.status IN ('done', 'failed') THEN r.status ELSE 'stopped' END,
       s.request, s.task, MIN(s.at), MAX(s.at)
FROM board_request_steps s
LEFT JOIN board_requests r ON r.id = s.request
LEFT JOIN board_messages m ON m.machine = 'cloud' AND m.id = s.request
GROUP BY s.request, s.task;

INSERT OR IGNORE INTO board_run_steps (machine, run, n, at, kind, text)
SELECT 'cloud', CAST(request * 100 + task AS TEXT),
       ROW_NUMBER() OVER (PARTITION BY request, task ORDER BY n), at, '', text
FROM board_request_steps;

DROP TABLE board_request_steps;
