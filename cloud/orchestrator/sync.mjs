// The store must atomically compare and replace one record. Payloads are
// encrypted by the node before submission; this layer never handles keys.
export async function applySyncOperation({ store, authorize, principal, operation, verifyEnvelope = null }) {
  if (typeof authorize !== 'function' || !await authorize(principal, operation?.nodeId, operation?.namespace)) throw new Error('Sync authorization denied');
  const { namespace, recordId, nodeId, operationId, baseRevision, ciphertext, deleted } = operation ?? {};
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (![namespace, recordId, nodeId, operationId].every(validId) || !Number.isSafeInteger(baseRevision) || baseRevision < 0 || typeof deleted !== 'boolean' || typeof ciphertext !== 'string' || ciphertext.length < 1 || ciphertext.length > 1048576) throw new Error('Invalid sync operation');
  if (verifyEnvelope && !await verifyEnvelope(operation)) throw new Error('Authenticated encryption refused');
  const result = await store.compareAndSet({ namespace, recordId, nodeId, operationId, baseRevision, ciphertext, deleted });
  if (!result || !['applied', 'duplicate', 'conflict'].includes(result.status)) throw new Error('Invalid sync store result');
  return result;
}

export async function readSyncRecord({ store, authorize, principal, namespace, nodeId, recordId }) {
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (![namespace, nodeId, recordId].every(validId)) throw new Error('Invalid sync record');
  if (typeof authorize !== 'function' || !await authorize(principal, nodeId, namespace)) throw new Error('Sync authorization denied');
  return store.read(namespace, recordId);
}

export async function readSyncChanges({ store, authorize, principal, namespace, nodeId, after = 0, limit = 100 }) {
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (![namespace, nodeId].every(validId) || !Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid sync cursor');
  if (typeof authorize !== 'function' || !await authorize(principal, nodeId, namespace)) throw new Error('Sync authorization denied');
  return store.changes(namespace, after, limit);
}

// Preserve order and retain the first conflict or unavailable operation. A
// retry must carry the same operationId and ciphertext; no silent last-writer wins.
export async function flushSyncOutbox({ operations, send, acknowledge }) {
  let acknowledged = 0;
  for (const operation of operations) {
    let result;
    try { result = await send(operation); } catch { return { acknowledged, blocked: 'unavailable' }; }
    if (!result || !['applied', 'duplicate'].includes(result.status)) return { acknowledged, blocked: 'conflict' };
    await acknowledge(operation.operationId, result);
    acknowledged++;
  }
  return { acknowledged, blocked: null };
}
