import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskLedger } from './task-ledger.mjs';
import { registerInstructionLedgerRoutes } from './local-agent-ledger.mjs';

test('handle-this admission is durable before work and duplicate work is refused', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-direct-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new TaskLedger(join(dir, 'tasks')); const routes = new Map();
  const app = { get() {}, post() {}, use(path, handler) { routes.set(path, handler); } };
  registerInstructionLedgerRoutes(app, { ledger });
  const call = () => {
    const req = { method: 'POST', path: '/', body: { ask: 'Inspect the fixture', instructionId: 'message-1' } };
    const res = Object.assign(new EventEmitter(), { statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
    let proceeded = false; routes.get('/handle-this/investigate')(req, res, () => { proceeded = true; });
    return { req, res, proceeded };
  };
  const first = call(); assert.equal(first.proceeded, true);
  assert.equal(new TaskLedger(join(dir, 'tasks')).snapshot().tasks[0].status, 'dispatching');
  first.res.emit('finish'); assert.equal(ledger.snapshot().tasks[0].status, 'accepted');
  const duplicate = call(); assert.equal(duplicate.proceeded, false); assert.equal(duplicate.res.statusCode, 409);
});
