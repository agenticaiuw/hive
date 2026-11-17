-- The project a run is in, when the node knows it: each Claude Code and Codex session on the owner's
-- Macs is a run (hive-tasks live.rs, "claude:<session>"), and the dashboard names it by its project
-- ("Claude Code · hive") the way it names the agents at work from their tasks.
ALTER TABLE board_runs ADD COLUMN project TEXT NOT NULL DEFAULT '';
