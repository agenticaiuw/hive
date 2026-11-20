-- A request goes on through a restart of Hive on the VM (2026-11-20, the owner: Hive on the VM keeps a
-- request going through its own restarts). The orchestrator's first take after it starts (takeRequest,
-- fresh) puts what it held back in the queue, with a note of where it was, instead of failing it; twice
-- at most a request, so one that brings the orchestrator down each time still ends.
ALTER TABLE board_requests ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0;
