// Minimal Chrome DevTools Protocol client: one WebSocket, flat sessions, no dependencies.
// Uses the WebSocket client built into Node 22+.

export class CdpError extends Error {
  constructor(method, detail) {
    super(`${method}: ${detail?.message ?? 'failed'}`);
    this.name = 'CdpError';
    this.method = method;
    this.code = detail?.code;
  }
}

export class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closed = null;
  #detached = new Set(); // sessions of tabs that closed: requests to them fail at once

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', event => this.#onMessage(event));
    ws.addEventListener('close', () => this.#onClose(new Error('browser connection closed')));
    ws.addEventListener('error', () => this.#onClose(new Error('browser connection failed')));
  }

  static connect(url, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error('timed out connecting to browser')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cannot connect to browser')); }, { once: true });
    });
  }

  get closed() { return this.#closed !== null; }

  send(method, params = {}, sessionId, { timeoutMs = 30_000 } = {}) {
    if (this.#closed) return Promise.reject(this.#closed);
    if (sessionId && this.#detached.has(sessionId)) return Promise.reject(new CdpError(method, { message: 'the tab has closed', code: 'tab_closed' }));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(method, { message: `no reply within ${timeoutMs} ms` }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, method, timer, sessionId });
      this.#ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  // Listener receives (method, params, sessionId). Returns an unsubscribe function.
  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Resolve with the params of the next matching event, or reject on timeout.
  waitForEvent(method, sessionId, { timeoutMs = 30_000, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on((name, params, session) => {
        if (name !== method || (sessionId && session !== sessionId) || !predicate(params)) return;
        clearTimeout(timer); off(); resolve(params);
      });
      const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
    });
  }

  close() {
    try { this.#ws.close(); } catch { /* already closed */ }
    this.#onClose(new Error('browser connection closed'));
  }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')); } catch { return; }
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(entry.method, message.error));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId) {
      // The tab closed (or was let go): nothing it was asked will be answered.
      const gone = message.params.sessionId;
      this.#detached.add(gone);
      for (const [id, entry] of this.#pending) {
        if (entry.sessionId !== gone) continue;
        this.#pending.delete(id); clearTimeout(entry.timer);
        entry.reject(new CdpError(entry.method, { message: 'the tab has closed', code: 'tab_closed' }));
      }
    }
    for (const listener of [...this.#listeners]) {
      try { listener(message.method, message.params ?? {}, message.sessionId); } catch { /* a listener must not break the socket */ }
    }
  }

  #onClose(error) {
    if (this.#closed) return;
    this.#closed = error;
    for (const { reject, timer } of this.#pending.values()) { clearTimeout(timer); reject(error); }
    this.#pending.clear();
  }
}
