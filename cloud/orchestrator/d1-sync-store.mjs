// D1 is the durable authority. A single conditional upsert is the conflict
// boundary; tombstones remain records so stale offline writes cannot revive data.
export function createD1SyncStore(db, { nodeId = null } = {}) {
  // The guard is embedded in each SQL statement, so a concurrent revocation
  // cannot race a prior authorization check and permit a later write.
  const guard = nodeId === null ? '1' : 'EXISTS (SELECT 1 FROM hive_sync_grants WHERE namespace = ? AND node_id = ?)';
  const guardArgs = namespace => nodeId === null ? [] : [namespace, nodeId];
  return {
    async initialize() {
      await db.prepare(`CREATE TABLE IF NOT EXISTS hive_sync_records (
        namespace TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
        node_id TEXT NOT NULL, operation_id TEXT NOT NULL, base_revision INTEGER NOT NULL,
        ciphertext TEXT, deleted INTEGER NOT NULL, PRIMARY KEY(namespace, record_id)
      )`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS hive_sync_changes (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL,
        record_id TEXT NOT NULL, revision INTEGER NOT NULL
      )`).run();
      await db.prepare('CREATE INDEX IF NOT EXISTS hive_sync_changes_namespace_sequence ON hive_sync_changes(namespace, sequence)').run();
      await db.prepare('CREATE TABLE IF NOT EXISTS hive_sync_grants (namespace TEXT NOT NULL, node_id TEXT NOT NULL, PRIMARY KEY(namespace, node_id))').run();
      await db.prepare(`CREATE TRIGGER IF NOT EXISTS hive_sync_insert AFTER INSERT ON hive_sync_records BEGIN
        INSERT INTO hive_sync_changes(namespace, record_id, revision) VALUES (NEW.namespace, NEW.record_id, NEW.revision);
      END`).run();
      await db.prepare(`CREATE TRIGGER IF NOT EXISTS hive_sync_update AFTER UPDATE ON hive_sync_records BEGIN
        INSERT INTO hive_sync_changes(namespace, record_id, revision) VALUES (NEW.namespace, NEW.record_id, NEW.revision);
      END`).run();
    },
    async grant(namespace, targetNodeId, enabled) {
      if (nodeId !== null) throw new Error('Grant requires owner');
      const sql = enabled ? 'INSERT OR IGNORE INTO hive_sync_grants(namespace, node_id) VALUES (?, ?)' : 'DELETE FROM hive_sync_grants WHERE namespace = ? AND node_id = ?';
      await db.prepare(sql).bind(namespace, targetNodeId).run();
    },
    async hasGrant(namespace) {
      if (nodeId === null) return true;
      return !!await db.prepare('SELECT 1 AS allowed FROM hive_sync_grants WHERE namespace = ? AND node_id = ?').bind(namespace, nodeId).first();
    },
    async read(namespace, recordId) {
      const row = await db.prepare(`SELECT revision, base_revision, node_id, operation_id, ciphertext, deleted FROM hive_sync_records WHERE namespace = ? AND record_id = ? AND ${guard}`).bind(namespace, recordId, ...guardArgs(namespace)).first();
      return row ? { revision: row.revision, baseRevision: row.base_revision, nodeId: row.node_id, operationId: row.operation_id, ciphertext: row.ciphertext, deleted: Boolean(row.deleted) } : null;
    },
    async changes(namespace, after, limit) {
      const result = await db.prepare(`SELECT sequence, record_id, revision FROM hive_sync_changes WHERE namespace = ? AND sequence > ? AND ${guard} ORDER BY sequence LIMIT ?`).bind(namespace, after, ...guardArgs(namespace), limit).all();
      const rows = result.results ?? [];
      return { changes: rows.map(row => ({ sequence: row.sequence, recordId: row.record_id, revision: row.revision })), nextCursor: rows.length ? rows[rows.length - 1].sequence : after };
    },
    async compareAndSet(op) {
      const result = await db.prepare(`INSERT INTO hive_sync_records
        (namespace, record_id, revision, node_id, operation_id, base_revision, ciphertext, deleted)
        SELECT ?, ?, 1, ?, ?, ?, ?, ? WHERE ? = 0 AND ${guard}
        ON CONFLICT(namespace, record_id) DO UPDATE SET revision = hive_sync_records.revision + 1,
          node_id = excluded.node_id, operation_id = excluded.operation_id,
          base_revision = excluded.base_revision, ciphertext = excluded.ciphertext, deleted = excluded.deleted
        WHERE hive_sync_records.revision = ? AND hive_sync_records.operation_id <> excluded.operation_id`)
        .bind(op.namespace, op.recordId, op.nodeId, op.operationId, op.baseRevision, op.ciphertext, Number(op.deleted), op.baseRevision, ...guardArgs(op.namespace), op.baseRevision).run();
      // For updates, the SELECT must also permit nonzero base revisions.
      // See the dedicated UPDATE below when the record already exists.
      if (result.meta?.changes) return { status: 'applied', revision: op.baseRevision + 1 };
      const update = await db.prepare(`UPDATE hive_sync_records SET revision = revision + 1, node_id = ?, operation_id = ?, base_revision = ?, ciphertext = ?, deleted = ?
        WHERE namespace = ? AND record_id = ? AND revision = ? AND operation_id <> ? AND ${guard}`)
        .bind(op.nodeId, op.operationId, op.baseRevision, op.ciphertext, Number(op.deleted), op.namespace, op.recordId, op.baseRevision, op.operationId, ...guardArgs(op.namespace)).run();
      if (update.meta?.changes) return { status: 'applied', revision: op.baseRevision + 1 };
      const current = await db.prepare(`SELECT revision, node_id, operation_id, base_revision, ciphertext, deleted FROM hive_sync_records WHERE namespace = ? AND record_id = ? AND ${guard}`).bind(op.namespace, op.recordId, ...guardArgs(op.namespace)).first();
      if (current && current.operation_id === op.operationId && current.node_id === op.nodeId && current.base_revision === op.baseRevision && current.ciphertext === op.ciphertext && Boolean(current.deleted) === op.deleted) return { status: 'duplicate', revision: current.revision };
      return { status: 'conflict', revision: current?.revision ?? null };
    },
  };
}
