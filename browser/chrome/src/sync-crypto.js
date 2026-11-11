// The caller must obtain this namespace key through an approved secure pairing
// flow. This module does not transmit or persist the raw key.
const encoder = new TextEncoder()
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
const aad = (op, keyId) => encoder.encode(JSON.stringify(['hive-sync-gcm-v1', op.namespace, op.recordId, op.nodeId, op.operationId, op.baseRevision, op.deleted, keyId]))

export async function importNamespaceKey(rawKey, cryptoImpl = globalThis.crypto) {
  if (!(rawKey instanceof Uint8Array) || rawKey.length !== 32) throw new Error('Invalid namespace key')
  return cryptoImpl.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function sealSyncRecord({ key, keyId, operation, plaintext, cryptoImpl = globalThis.crypto }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || !(plaintext instanceof Uint8Array) || (operation.deleted && plaintext.length !== 0)) throw new Error('Invalid encrypted record')
  const nonce = cryptoImpl.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(operation, keyId), tagLength: 128 }, key, plaintext))
  const body = sealed.subarray(0, sealed.length - 16), tag = sealed.subarray(sealed.length - 16)
  return `gcm1.${keyId}.${b64(nonce)}.${b64(tag)}.${b64(body)}`
}

export async function openSyncRecord({ key, operation, cryptoImpl = globalThis.crypto }) {
  const parts = String(operation.ciphertext ?? '').split('.')
  if (parts.length !== 5 || parts[0] !== 'gcm1' || !/^[A-Za-z0-9_-]{1,64}$/.test(parts[1]) || !parts.slice(2).every(part => /^[A-Za-z0-9_-]*$/.test(part))) throw new Error('Invalid encrypted record')
  const nonce = unb64(parts[2]), tag = unb64(parts[3]), body = unb64(parts[4])
  if (nonce.length !== 12 || tag.length !== 16 || b64(nonce) !== parts[2] || b64(tag) !== parts[3] || b64(body) !== parts[4]) throw new Error('Invalid encrypted record')
  const sealed = new Uint8Array(body.length + tag.length); sealed.set(body); sealed.set(tag, body.length)
  const plaintext = new Uint8Array(await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(operation, parts[1]), tagLength: 128 }, key, sealed))
  if (operation.deleted && plaintext.length) throw new Error('Invalid encrypted deletion')
  return plaintext
}
