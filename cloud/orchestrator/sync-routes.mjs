import { createD1SyncStore } from './d1-sync-store.mjs';
import { applySyncOperation, readSyncRecord, readSyncChanges } from './sync.mjs';

// Mounted behind the relay's admin-only scope check. No memory fallback: an
// unavailable cloud database must never appear to have accepted an operation.
export function registerSyncRoutes(app, { getDatabase, verifyEnvelope = null }) {
  async function storeForRequest(principal) {
    const db = getDatabase();
    if (!db) throw new Error('database unavailable');
    if (!['admin', 'device'].includes(principal?.kind)) throw new Error('principal unavailable');
    const store = createD1SyncStore(db, { nodeId: principal.kind === 'device' ? principal.deviceId : null }); await store.initialize(); return store;
  }
  const authorizeWith = store => async (principal, nodeId, namespace) => principal?.kind === 'admin' ||
    (principal?.kind === 'device' && principal.deviceId === nodeId && await store.hasGrant(namespace));
  app.post('/v1/sync/records', async (req, res) => {
    try {
      if (typeof verifyEnvelope !== 'function') throw new Error('Authenticated encryption unavailable');
      const store = await storeForRequest(req.relayPrincipal);
      const result = await applySyncOperation({ store, authorize: authorizeWith(store), principal: req.relayPrincipal, operation: req.body, verifyEnvelope });
      return res.status(result.status === 'conflict' ? 409 : 200).json({ ok: result.status !== 'conflict', ...result });
    } catch { return res.status(503).json({ ok: false, error: 'Sync unavailable or operation refused' }); }
  });
  app.get('/v1/sync/records', async (req, res) => {
    try {
      const store = await storeForRequest(req.relayPrincipal);
      const record = await readSyncRecord({ store, authorize: authorizeWith(store), principal: req.relayPrincipal, namespace: req.query.namespace, nodeId: req.query.nodeId, recordId: req.query.recordId });
      return res.json({ ok: true, record });
    } catch { return res.status(503).json({ ok: false, error: 'Sync unavailable or request refused' }); }
  });
  app.get('/v1/sync/changes', async (req, res) => {
    try {
      const store = await storeForRequest(req.relayPrincipal);
      const page = await readSyncChanges({ store, authorize: authorizeWith(store), principal: req.relayPrincipal, namespace: req.query.namespace, nodeId: req.query.nodeId, after: Number(req.query.after ?? 0), limit: Number(req.query.limit ?? 100) });
      return res.json({ ok: true, ...page });
    } catch { return res.status(503).json({ ok: false, error: 'Sync unavailable or request refused' }); }
  });
  app.post('/v1/sync/grants', async (req, res) => {
    try {
      const { namespace, nodeId, enabled } = req.body ?? {};
      if (req.relayPrincipal?.kind !== 'admin' || ![namespace, nodeId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) || typeof enabled !== 'boolean') throw new Error('Invalid grant');
      const store = await storeForRequest(req.relayPrincipal); await store.grant(namespace, nodeId, enabled);
      return res.json({ ok: true });
    } catch { return res.status(503).json({ ok: false, error: 'Sync grant unavailable or refused' }); }
  });
}
