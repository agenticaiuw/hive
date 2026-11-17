-- The owner acting on a task from any dashboard (2026-11-16: "i need a way to cancel tasks", "a
-- button to continue each task", answer "need me" directly in the Hive app), and an agent taking a
-- task over from the session that registered it, so a task handed to another session shows under
-- the agent doing it, in progress, not as stuck under the one that handed it off.
ALTER TABLE board_tasks ADD COLUMN claimed_harness TEXT;   -- the session that took it over: its harness
ALTER TABLE board_tasks ADD COLUMN claimed_session TEXT;   -- and its id (else the registering message's)
ALTER TABLE board_tasks ADD COLUMN cancelled_at INTEGER;   -- the owner cancelled it: it stays dropped
