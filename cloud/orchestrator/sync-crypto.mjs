import { createDecipheriv } from 'node:crypto';

// Key lookup is provided by a separately configured secret manager. The
// verifier never persists or returns plaintext; it also authenticates deletes.
export function createSyncVerifier({ getNamespaceKey }) {
  if (typeof getNamespaceKey !== 'function') throw new Error('Key provider required');
  return async op => {
    if (!op || typeof op.ciphertext !== 'string') return false;
    const parts = op.ciphertext.split('.');
    if (parts.length !== 5 || parts[0] !== 'gcm1' || !/^[A-Za-z0-9_-]{1,64}$/.test(parts[1]) || !parts.slice(2).every(part => /^[A-Za-z0-9_-]*$/.test(part))) return false;
    const [, keyId, encodedNonce, encodedTag, encodedBody] = parts;
    const nonce = Buffer.from(encodedNonce, 'base64url'), tag = Buffer.from(encodedTag, 'base64url'), body = Buffer.from(encodedBody, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16 || nonce.toString('base64url') !== encodedNonce || tag.toString('base64url') !== encodedTag || body.toString('base64url') !== encodedBody) return false;
    const key = await getNamespaceKey(op.namespace, keyId, op.nodeId);
    if (!Buffer.isBuffer(key) || key.length !== 32) return false;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(JSON.stringify(['hive-sync-gcm-v1', op.namespace, op.recordId, op.nodeId, op.operationId, op.baseRevision, op.deleted, keyId])));
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
      const valid = !op.deleted || plaintext.length === 0;
      plaintext.fill(0);
      return valid;
    } catch { return false; }
  };
}
