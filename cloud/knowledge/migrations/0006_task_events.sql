-- Each task's history (opened, active, done, …, with what was said), so nothing about the owner's
-- work stays only on one machine. id is the event's row on that machine.
CREATE TABLE IF NOT EXISTS board_task_events (
  machine TEXT NOT NULL,
  id INTEGER NOT NULL,
  task INTEGER NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (machine, id)
);
CREATE INDEX IF NOT EXISTS board_task_events_task ON board_task_events (machine, task);
