CREATE TABLE IF NOT EXISTS relay_devices (
  device_id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_devices_updated_at
  ON relay_devices(updated_at DESC);

CREATE TABLE IF NOT EXISTS relay_jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS relay_jobs_queue
  ON relay_jobs(status, created_at ASC);

CREATE INDEX IF NOT EXISTS relay_jobs_updated_at
  ON relay_jobs(updated_at ASC);

