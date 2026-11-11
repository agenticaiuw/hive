# Synchronization prototype

`sync.mjs` and `d1-sync-store.mjs` define a D1-backed compare-and-set
record protocol. Each authorized namespace holds opaque, node-encrypted
records with monotonic per-record revisions. A tombstone is retained as a
revisioned record, so a stale offline write conflicts instead of silently
restoring deleted data. Duplicate retries are recognized only while that
operation remains the latest revision; an older retry safely conflicts.

The caller must authenticate and authorize the principal, node and namespace,
encrypt payloads before calling this module, and protect encryption keys. The
storage primitive does not verify that a string is ciphertext or screen it for
secrets. The HTTP write route refuses all writes until an authenticated
encryption verifier is explicitly configured; none is configured in the relay.
The supplied AES-256-GCM verifier uses a namespace key from an injected key
provider and binds record identity, base revision and deletion state as AAD.
Deletion is represented by an authenticated envelope over empty plaintext.
The outbox helper stops on conflicts or network failure and acknowledges only
successful operations; it does not itself persist the outbox.

The relay exposes `/v1/sync/records` read/write routes and a `/v1/sync/changes`
cursor backed only by D1; they fail closed when the binding is unavailable.
An administrator may grant or revoke a device's access to a namespace via
`/v1/sync/grants`. Device bearer credentials must also hold the existing mesh
send/receive scope, match the submitted node ID, and have the namespace grant.
Each SQL operation checks the grant again to fence concurrent revocation. The
feed contains identifiers and revisions; clients fetch current records separately.
Trigger-created changes start when the schema is initialized and do not backfill
pre-existing rows. This is source code, not a deployed synchronization service.
Node storage, key distribution, conflict resolution, and execution authority
are not wired. It does not yet synchronize tasks, memory, session history, tool
context or device data.
