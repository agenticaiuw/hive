// Turns at the VM's devices, so Hive's cloud agent can run several tasks at once (owner, 2026-11-18:
// the VM did "one request at a time, its tasks one after another, because it has one screen"). Only
// tasks that need the same device take turns: the VM's screen (one mouse, one browser), the owner's
// iPhone (one finger) and the owner's Mac (driven through the board, mac-mcp.mjs). Everything else (the knowledge base, the owner's own browser through the board,
// answers, code) runs side by side.
//
// The orchestrator keeps the turns in memory (Devices) and hands them out over a Unix socket in its
// state folder (serveDevices). A task's tool server asks for its device the first time it needs it
// (Lease) and holds it as long as its connection stays open: when the task ends, or its process dies
// in any way, the connection closes and the next task in line gets the device, so a turn can never be
// left held by nobody. Turns go first come, first served.
//
// The phone is given back on its own after PHONE_IDLE_MS without a phone call while another task waits
// for it (a screen task that needs a Duo approval, while a phone task is thinking, gets the phone
// for that), and its holder waits in line again for its next call. The screen and the Mac are only
// ever given back when their task ends: another task's clicks in the middle of a task would break it.
//
// The socket's protocol, one JSON object a line:
//   → {op: "take", device, task}   ← {op: "queued", device, holder, ahead}, later {op: "granted", device, waited_ms}
//   → {op: "busy" | "idle" | "free", device}
//   ← {op: "revoked", device}       (the phone, given to the next task in line)
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { createInterface } from 'node:readline';

export const DEVICES = ['screen', 'phone', 'mac'];
export const PHONE_IDLE_MS = 60_000;

export class Devices {
  constructor({ now = Date.now, idle = { phone: PHONE_IDLE_MS } } = {}) {
    this.now = now;
    this.idle = idle;
    this.turns = new Map(DEVICES.map(device => [device, { holder: null, line: [] }]));
  }

  /** Asks for a device for this client: {send(message), task}. Answers queued now, granted when it's theirs. */
  take(device, client) {
    const turn = this.turns.get(device);
    if (!turn) return client.send({ op: 'error', device, error: `there is no device called ${device}` });
    if (turn.holder?.client === client || turn.line.some(w => w.client === client)) return undefined;
    const asked = this.now();
    if (!turn.holder) return this.grant(device, { client, asked });
    turn.line.push({ client, asked });
    client.send({ op: 'queued', device, holder: turn.holder.client.task || 'another task', ahead: turn.line.length - 1 });
    this.check(device);
    return undefined;
  }

  grant(device, { client, asked }) {
    const turn = this.turns.get(device);
    turn.holder = { client, busy: false, last: this.now() };
    client.send({ op: 'granted', device, waited_ms: Math.max(0, this.now() - asked) });
  }

  /** The holder is using the device (busy) or done with this call (idle). */
  mark(device, client, busy) {
    const turn = this.turns.get(device);
    if (turn?.holder?.client !== client) return;
    turn.holder.busy = busy;
    turn.holder.last = this.now();
    if (!busy) this.check(device);
  }

  /** Gives the device back (or leaves the line for it). */
  free(device, client) {
    const turn = this.turns.get(device);
    if (!turn) return;
    turn.line = turn.line.filter(w => w.client !== client);
    if (turn.holder?.client !== client) return;
    turn.holder = null;
    const next = turn.line.shift();
    if (next) this.grant(device, next);
  }

  /** A client that went away gives back everything it held and leaves every line. */
  drop(client) {
    for (const device of this.turns.keys()) this.free(device, client);
  }

  /** The phone's holder has been idle too long while another task waits: the next one gets it. */
  check(device) {
    const turn = this.turns.get(device);
    const idle = this.idle[device];
    const holder = turn?.holder;
    if (!holder || !turn.line.length || !idle || holder.busy || this.now() - holder.last < idle) return;
    holder.client.send({ op: 'revoked', device });
    this.free(device, holder.client);
  }

  tick() {
    for (const device of this.turns.keys()) this.check(device);
  }

  /** Who holds what and who waits, for the log. */
  state() {
    return Object.fromEntries([...this.turns].map(([device, turn]) =>
      [device, { holder: turn.holder?.client.task ?? null, waiting: turn.line.map(w => w.client.task) }]));
  }
}

/** Serves turns at the devices on a Unix socket (only its owner may connect); returns {devices, close()}. */
export function serveDevices(path, { devices = new Devices(), tickMs = 5000, log = () => {}, onEvent = () => {} } = {}) {
  rmSync(path, { force: true });
  const server = createServer(socket => {
    // onEvent(task, message) hears each answer a task gets (queued, granted, revoked), for its run's steps.
    const client = { task: '', send: message => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
      try { onEvent(client.task, message); } catch {}
    } };
    createInterface({ input: socket }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (typeof message.task === 'string' && message.task) client.task = message.task.slice(0, 200);
      if (message.op === 'take') devices.take(message.device, client);
      else if (message.op === 'busy' || message.op === 'idle') devices.mark(message.device, client, message.op === 'busy');
      else if (message.op === 'free') devices.free(message.device, client);
      if (message.op === 'take' || message.op === 'free') log(`devices: ${JSON.stringify(devices.state())}`);
    });
    let left = false;
    const gone = () => {
      if (left) return;
      left = true;
      const had = Object.values(devices.state()).some(d => d.holder === client.task || d.waiting.includes(client.task));
      devices.drop(client);
      if (had) log(`devices: ${JSON.stringify(devices.state())}`);
    };
    socket.on('close', gone);
    socket.on('error', gone);
  });
  server.listen(path, () => { try { chmodSync(path, 0o600); } catch {} });
  const timer = setInterval(() => devices.tick(), tickMs);
  timer.unref?.();
  return {
    devices,
    server,
    close: () => new Promise(resolve => { clearInterval(timer); server.close(() => resolve()); }),
  };
}

/**
 * A tool server's turn at one device. `ready()` before using it waits in line (up to waitMs) and
 * says so through onWait; `use(fn)` runs one call holding it. With no socket (a task started by hand
 * while the orchestrator isn't running) there is nobody to take turns with, so it goes ahead.
 */
export class Lease {
  constructor(path, device, task, { waitMs = 30 * 60_000, onWait = () => {}, connect = createConnection, exists = existsSync } = {}) {
    Object.assign(this, { path, device, task, waitMs, onWait, connect, exists });
    this.socket = null;
    this.held = false;
    this.pending = null;
  }

  open() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    return new Promise((resolve, reject) => {
      const socket = this.connect(this.path);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
      socket.on('close', () => { this.held = false; this.socket = null; this.settle?.(new Error('the orchestrator went away')); });
      createInterface({ input: socket }).on('line', line => {
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.device !== this.device) return;
        if (message.op === 'granted') {
          // One that comes after this task stopped waiting goes straight back.
          if (!this.settle) return this.send({ op: 'free' });
          this.held = true;
          this.settle(null, message);
        }
        else if (message.op === 'revoked') this.held = false;
        else if (message.op === 'queued') this.onWait(message);
        else if (message.op === 'error') this.settle?.(new Error(message.error));
      });
      this.socket = socket;
    });
  }

  send(message) {
    this.socket?.write(`${JSON.stringify({ ...message, device: this.device })}\n`);
  }

  /** Waits for this task's turn at the device; resolves at once while it already has it. */
  async ready() {
    if (this.held) return;
    if (!this.socket && !this.exists(this.path)) return; // nobody to take turns with
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        await this.open();
      } catch {
        return; // the orchestrator isn't serving turns: go ahead
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.send({ op: 'free' });
          this.settle = null;
          reject(new Error(`another of Hive's tasks has been using the ${this.device} for over ${Math.round(this.waitMs / 60_000)} minutes; try again later`));
        }, this.waitMs);
        this.settle = (error, message) => {
          clearTimeout(timer);
          this.settle = null;
          if (error) reject(error); else resolve(message);
        };
        this.send({ op: 'take', task: this.task });
      });
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  /** One call at the device, holding it: busy while it runs, idle after. */
  async use(fn) {
    await this.ready();
    if (this.held) this.send({ op: 'busy' });
    try {
      return await fn();
    } finally {
      if (this.held) this.send({ op: 'idle' });
    }
  }

  /** Gives the device back now (the server also takes it back when this process ends). */
  close() {
    this.socket?.end();
    this.socket = null;
    this.held = false;
  }
}
