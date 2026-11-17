-- A stuck task gets going again without the owner (2026-11-17: "why tf would it get stuck just for me
-- to click continue? what's the point?"). Every minute the tasks worker (scheduled, continueStuck)
-- sends the agent of each stuck (blocked) task a continue of its own, twice at most per task, and
-- only after both tries does the task go on the owner's Needs you list.
ALTER TABLE board_tasks ADD COLUMN auto_continues INTEGER NOT NULL DEFAULT 0;  -- tries so far
ALTER TABLE board_tasks ADD COLUMN auto_continued_at INTEGER;                  -- the latest try (or the owner's own continue or answer)
-- Hive in the cloud is continued by running the request again, with this note before the owner's words.
ALTER TABLE board_requests ADD COLUMN retry_note TEXT;
