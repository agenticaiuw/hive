// @ts-nocheck
// Mobile-side mesh contract. `store` must atomically persist records; tokens
// are supplied by the caller and are never included in stored records.
const MESSAGE_ID = /^nmsg_[A-Za-z0-9_-]{8,64}$/;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/;

export class MobilePcMeshClient {
  constructor({ relayUrl, token, deviceId, pcDeviceId, store, fetchImpl = fetch, newId = () => crypto.randomUUID() }) {
    const url = new URL(relayUrl);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Invalid relay URL');
    if (!token || !ADDRESS.test(deviceId) || !ADDRESS.test(pcDeviceId) || deviceId === pcDeviceId || !store?.read || !store?.write) throw new Error('Invalid mobile mesh configuration');
    Object.assign(this, { url, token, deviceId, pcDeviceId, store, fetchImpl, newId });
    this.running = false;
  }
  async request(method, path, body) {
    const response = await this.fetchImpl(new URL(path, this.url), { method, headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Relay request failed');
    const value = await response.json();
    if (!value?.ok) throw new Error('Relay request failed');
    return value;
  }
  async exclusive(fn) {
    if (this.running) throw new Error('A mobile mesh operation is already in progress');
    this.running = true;
    try { return await fn(); } finally { this.running = false; }
  }
  async submit(text) {
    return this.exclusive(async () => {
      if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(JSON.stringify({ text }) + '\n').length > 16384) throw new Error('Invalid PC request');
      const records = await this.store.read();
      const record = { localId: this.newId(), pcDeviceId: this.pcDeviceId, status: 'unknown', reason: 'submission_interrupted', updatedAt: new Date().toISOString() };
      records.push(record);
      await this.store.write(records); // A crash or ambiguous response must never cause an automatic retry.
      let sent;
      try { sent = await this.request('POST', '/v1/node/messages', { to: this.pcDeviceId, kind: 'pc.request.submit', payload: { text } }); }
      catch { return record; }
      if (!MESSAGE_ID.test(sent.messageId) || sent.to !== this.pcDeviceId || sent.from !== this.deviceId) return record;
      record.messageId = sent.messageId; record.expiresAt = sent.expiresAt; record.status = 'pending'; delete record.reason; record.updatedAt = new Date().toISOString();
      await this.store.write(records);
      return record;
    });
  }
  async pollOnce() {
    return this.exclusive(async () => {
      const records = await this.store.read();
      const inbox = await this.request('GET', `/v1/node/inbox?deviceId=${encodeURIComponent(this.deviceId)}`);
      if (!Array.isArray(inbox.messages)) throw new Error('Invalid inbox response');
      let processed = 0;
      for (const message of inbox.messages) {
        if (message.kind !== 'pc.request.result' || message.from !== this.pcDeviceId || message.to !== this.deviceId || !MESSAGE_ID.test(message.id)) continue;
        const record = records.find(item => item.messageId === message.corr && item.pcDeviceId === this.pcDeviceId);
        if (!record || !['accepted', 'rejected', 'unknown'].includes(message.payload?.status)) continue;
        // First valid result wins, even when relay delivery is duplicated.
        if (record.status === 'pending') {
          record.status = message.payload.status;
          if (typeof message.payload.reason === 'string' && /^[a-z_]{1,64}$/.test(message.payload.reason)) record.reason = message.payload.reason;
          record.updatedAt = new Date().toISOString();
          await this.store.write(records);
        }
        await this.request('POST', '/v1/node/inbox/ack', { deviceId: this.deviceId, messageIds: [message.id] });
        processed++;
      }
      return { processed };
    });
  }
}
