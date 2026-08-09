-- The node mesh mailbox (cloud-relay/nodeMailbox.js, shared/nodeMesh.js).
--
-- Before this table, every cross-node hop went through the Mac. The browser
-- extension knew exactly one URL — http://127.0.0.1:8000 — and the iOS shell
-- could only reach another node by queueing a mac:* job, which is dead the
-- moment the lid closes. So "the relay tells the extension something" was not
-- slow, it was impossible.
--
-- Apply:
--   npx wrangler d1 execute ai-pendant-relay-db --remote \
--     --file cloudflare-worker/node-mesh-migration.sql
--
-- Purely additive: no existing table is touched and no running client reads
-- these rows, so applying it to a live database changes nothing until a node
-- opens /v1/node/socket.
--
-- Everything below must stay byte-identical to the matching block in
-- schema.sql — that file is what a new database is built from, this one is
-- what an existing database runs, and a schema that cannot rebuild the
-- database it describes is a backup that does not restore.

CREATE TABLE IF NOT EXISTS relay_node_messages (
  message_id TEXT PRIMARY KEY,
  -- The addressee. A device_id, or a reserved '@name' address that no device
  -- can register under (deviceIds cannot contain '@') — see shared/nodeMesh.js.
  to_node TEXT NOT NULL,
  -- Stamped from the authenticated principal, never from the request body.
  from_node TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- NOT NULL, unlike relay_announcements.expires_at. Every message carries a
  -- deadline because the sweep is the only thing that empties an inbox nobody
  -- ever drains, and "unknown means keep" would make that inbox permanent.
  expires_at TEXT NOT NULL,
  -- Lease, not a delivered flag: a drain hides the row for lease_until so a
  -- second drain cannot double-deliver, and a node that crashes mid-batch
  -- gets the batch back when the lease lapses. At-least-once; message_id is
  -- the receiver's dedupe key.
  leased_until TEXT,
  -- Which drain holds the lease. The drain UPDATEs then SELECTs by this token,
  -- which is what makes the claim atomic without a RETURNING clause.
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);

-- The drain: unexpired, unleased, oldest first, for one addressee.
CREATE INDEX IF NOT EXISTS relay_node_messages_inbox
  ON relay_node_messages(to_node, leased_until, created_at ASC);

-- The sweep, and the SELECT that pairs with a lease UPDATE.
CREATE INDEX IF NOT EXISTS relay_node_messages_expiry
  ON relay_node_messages(expires_at);

CREATE INDEX IF NOT EXISTS relay_node_messages_lease
  ON relay_node_messages(lease_token);
