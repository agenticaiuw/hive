// @ts-nocheck
// Request metadata only; credentials belong in the platform's secure storage.
// One client instance owns this database at a time.
export async function openPcMeshStore({ indexedDBImpl = globalThis.indexedDB, name = 'hivemind-pc-requests' } = {}) {
  if (!indexedDBImpl) throw new Error('Persistent storage is unavailable');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(new Error('Could not open request storage'));
    request.onsuccess = () => resolve(request.result);
  });
  return {
    async read() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readonly');
        const request = tx.objectStore('state').get('records');
        tx.oncomplete = () => { const records = request.result ?? []; if (Array.isArray(records)) resolve(records); else reject(new Error('Invalid request storage')); };
        tx.onabort = tx.onerror = () => reject(new Error('Could not read request storage'));
      });
    },
    async write(records) {
      if (!Array.isArray(records)) throw new Error('Invalid request records');
      return new Promise((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite');
        tx.objectStore('state').put(records, 'records');
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(new Error('Could not persist request storage'));
      });
    },
    close() { db.close(); },
  };
}
