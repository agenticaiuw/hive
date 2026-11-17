-- Talking to an agent: what the owner says to one of their agents from any dashboard, on its way to
-- that agent wherever it runs (the owner, 2026-11-16: "click into each agent and also directly talk
-- to each agent"). Every message goes through the cloud (R11): the node the agent is on takes the
-- messages for it (POST /v1/runs/messages/take) and hands each to its agent (a Claude Code or Codex
-- session on a Mac gets it at its next step, or is woken with it), then says how that went. A message
-- to Hive's cloud agent becomes a follow-up request at once (board_requests.follows).
CREATE TABLE IF NOT EXISTS board_run_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine TEXT NOT NULL,                  -- the node the agent is on (board_runs.machine)
  run TEXT NOT NULL,                      -- the conversation it is part of (board_runs.run)
  agent TEXT NOT NULL,                    -- that run's agent: claude, codex, mac, cloud, code, browser
  text TEXT NOT NULL,                     -- the owner's words, as they wrote them
  sender TEXT NOT NULL DEFAULT '',        -- the device it was sent from: web, mac, phone
  status TEXT NOT NULL DEFAULT 'queued',  -- queued, taken, delivered, failed
  detail TEXT NOT NULL DEFAULT '',        -- how the delivery went, in a line
  request INTEGER,                        -- for Hive's cloud agent: the follow-up request it became
  task INTEGER,                           -- the task it is about (a cancel, continue or answer on the dashboard)
  wake INTEGER NOT NULL DEFAULT 1,        -- 0: only for an agent that is running (a cancel never starts one)
  created_at INTEGER NOT NULL,            -- unix seconds
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_run_messages_waiting ON board_run_messages (machine, status, id);
CREATE INDEX IF NOT EXISTS board_run_messages_run ON board_run_messages (machine, run, id);

-- A request the owner sent as a reply to an earlier one, so it reads as one conversation.
ALTER TABLE board_requests ADD COLUMN follows INTEGER;
