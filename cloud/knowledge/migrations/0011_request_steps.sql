-- What Hive's cloud agent is doing right now, step by step, for the dashboard. Each line is one thing
-- the agent said or did on the VM ("→ click: Open the Compose button", "💬 …", "✅ Done."), as
-- hive-task.mjs prints it; the orchestrator (cloud/vm-agent/orchestrator.mjs) sends them a few at a
-- time while the task runs (POST /v1/requests/steps), so the owner can follow along live.
CREATE TABLE IF NOT EXISTS board_request_steps (
  request INTEGER NOT NULL,      -- board_requests.id
  task INTEGER NOT NULL,         -- the task's key in the request (task id = request * 100 + task)
  n INTEGER NOT NULL,            -- 1, 2, 3… across the whole request
  at INTEGER NOT NULL,           -- unix seconds
  text TEXT NOT NULL,
  PRIMARY KEY (request, n)
);
