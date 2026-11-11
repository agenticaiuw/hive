// Explicit, opt-in bridge between the authenticated Hivemind node mailbox and
// the PC agent's local request channel. This module does not start a service.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { submitLocalRequest } from './local-request.mjs';

export const REQUEST_KIND = 'pc.request.submit';
export const RESULT_KIND = 'pc.request.result';

export class PcMeshBridge {
  constructor({ relayUrl, token, deviceId, allowedSenders, socketPath, journalPath, ledger = null, fetchImpl = fetch, submit = submitLocalRequest }) {
    const url = new URL(relayUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Relay must use HTTPS or loopback HTTP');
    if (url.username || url.password || url.search || url.hash) throw new Error('Invalid relay URL');
    if (!token || !deviceId || !socketPath || !journalPath || !Array.isArray(allowedSenders) || !allowedSenders.length) throw new Error('Missing bridge configuration');
    this.url = url; this.token = token; this.deviceId = deviceId; this.allowed = new Set(allowedSenders);
    this.socketPath = socketPath; this.journalPath = journalPath; this.ledger = ledger; this.fetch = fetchImpl; this.submit = submit; this.running = false;
    try { this.journal = JSON.parse(readFileSync(journalPath, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.journal = {}; }
    if (!this.journal || Array.isArray(this.journal) || typeof this.journal !== 'object') throw new Error('Invalid bridge journal');
  }
  save() {
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const temp = `${this.journalPath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.journal), { mode: 0o600, flag: 'wx' });
    renameSync(temp, this.journalPath);
    chmodSync(this.journalPath, 0o600);
  }
  async request(method, path, body) {
    const response = await this.fetch(new URL(path, this.url), {
      method, headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(15000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Relay request failed (HTTP ${response.status})`);
    const json = await response.json();
    if (!json.ok) throw new Error('Relay rejected the request');
    return json;
  }
  async pollOnce() {
    if (this.running) throw new Error('A poll is already in progress');
    this.running = true;
    try {
      const inbox = await this.request('GET', `/v1/node/inbox?deviceId=${encodeURIComponent(this.deviceId)}`);
      if (!Array.isArray(inbox.messages)) throw new Error('Invalid inbox response');
      let processed = 0;
      for (const message of inbox.messages) {
        // Leave unrelated messages in the inbox for their own consumer.
        if (message.kind !== REQUEST_KIND) continue;
        if (!/^nmsg_[A-Za-z0-9_-]{8,64}$/.test(message.id) || !message.from || message.to !== this.deviceId) throw new Error('Invalid request envelope');
        if (!Object.hasOwn(this.journal, message.id)) {
          let result;
          if (!this.allowed.has(message.from)) result = { status: 'rejected', reason: 'sender_not_allowed' };
          else if (!message.expiresAt || !Number.isFinite(Date.parse(message.expiresAt)) || Date.parse(message.expiresAt) <= Date.now()) result = { status: 'rejected', reason: 'expired' };
          else if (typeof message.payload?.text !== 'string' || !message.payload.text.trim()) result = { status: 'rejected', reason: 'invalid_request' };
          else {
            if (this.ledger) {
              const task = this.ledger.recordInstruction({ id: message.id, sourceId: `mesh:${this.deviceId}:${message.id}`, text: message.payload.text });
              if (task.status === 'pending') this.ledger.startAttempt(message.id, message.id);
              else {
                // An interrupted dispatch may already have reached the agent.
                // Do not replay it even if its bridge journal was not saved.
                result = { status: 'unknown', reason: 'dispatch_interrupted' };
              }
            }
            // Record before dispatch. If interrupted, never replay a request
            // that may already have been accepted by the PC agent.
            this.journal[message.id] = { from: message.from, result: { status: 'unknown', reason: 'dispatch_interrupted' } };
            this.save();
            try { if (!result) {
              if (this.ledger?.snapshot().stopped) {
                result = { status: 'rejected', reason: 'execution_stopped_before_dispatch' };
              } else {
              const reply = await this.submit({ socketPath: this.socketPath, text: message.payload.text, sourceId: `mesh:${this.deviceId}:${message.id}` });
              // The local socket uses this same generic refusal after its own
              // timeout. The work may already have started, so it is not proof
              // of rejection and must not invite a retry.
              result = reply.accepted === true ? { status: 'accepted' }
                : reply.accepted === null || reply.error === 'Request not accepted; check agent availability.'
                  ? { status: 'unknown', reason: 'agent_response_ambiguous' }
                  : { status: 'rejected', reason: 'agent_rejected' };
              if (reply.receiptId) result.receiptId = reply.receiptId;
              }
            }
            } catch { result = { status: 'unknown', reason: 'dispatch_failed' }; }
          }
          this.journal[message.id] = { from: message.from, result };
          this.save();
        }
        const entry = this.journal[message.id];
        if (entry.from !== message.from) throw new Error('Conflicting request identity');
        if (this.ledger) {
          const task = this.ledger.snapshot().tasks.find(item => item.id === message.id);
          if (task?.status === 'dispatching') this.ledger.recordAdmission(message.id, message.id, entry.result.status, entry.result.reason ?? null);
          const receiptId = entry.result.receiptId;
          if (receiptId && !task?.observations?.some(observation => observation.reference === `receipt:${receiptId}`)) {
            this.ledger.addEvidence(message.id, { source: 'personal-agent local socket', reference: `receipt:${receiptId}`, summary: `Local admission status: ${entry.result.status}; this does not establish task completion.`, observedAt: new Date().toISOString() });
          }
        }
        // A lost response can create duplicate result envelopes. Receivers must
        // deduplicate by correlationId; the underlying task is never replayed.
        await this.request('POST', '/v1/node/messages', { to: entry.from, kind: RESULT_KIND, correlationId: message.id, payload: entry.result });
        await this.request('POST', '/v1/node/inbox/ack', { deviceId: this.deviceId, messageIds: [message.id] });
        processed++;
      }
      return { processed };
    } finally { this.running = false; }
  }
}
