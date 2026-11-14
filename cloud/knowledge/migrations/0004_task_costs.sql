-- What each task cost (the agent's busy time and the tokens it used, from its session's
-- transcript) and the part of the project it's about. desktop/app/crates/hive/hive-tasks.
ALTER TABLE board_tasks ADD COLUMN work_seconds INTEGER;
ALTER TABLE board_tasks ADD COLUMN tokens_in INTEGER;
ALTER TABLE board_tasks ADD COLUMN tokens_out INTEGER;
ALTER TABLE board_tasks ADD COLUMN part TEXT;
