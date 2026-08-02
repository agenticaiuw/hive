-- Apply once to existing D1 databases before enabling per-device bearer auth.
-- The shared RELAY_API_KEY remains a compatible admin credential during rollout.
CREATE TABLE IF NOT EXISTS relay_device_credentials (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES relay_devices(device_id)
);

CREATE INDEX IF NOT EXISTS relay_device_credentials_device
  ON relay_device_credentials(device_id, revoked_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS relay_device_credentials_expiry
  ON relay_device_credentials(expires_at)
  WHERE expires_at IS NOT NULL;
