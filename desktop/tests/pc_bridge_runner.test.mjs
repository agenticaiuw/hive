import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridge } from '../run-mesh-bridge.mjs';

test('runs one poll and releases its lock on graceful shutdown', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  let received;
  class Bridge { constructor(config) { received = config; } async pollOnce() { controller.abort(); } }
  const journalPath = join(dir, 'journal');
  await runBridge({ config: { journalPath, ledgerPath: join(dir, 'tasks') }, token: 'test', signal: controller.signal, Bridge });
  assert.equal(received.token, 'test');
  assert.equal(existsSync(`${journalPath}.lock`), false);
});

test('refuses a second runner and releases lock after an initialization error', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { journalPath: join(dir, 'journal'), ledgerPath: join(dir, 'tasks') };
  const controller = new AbortController();
  let unblock;
  class Blocking { async pollOnce() { await new Promise(resolve => { unblock = resolve; }); controller.abort(); } }
  const first = runBridge({ config, token: 'test', signal: controller.signal, Bridge: Blocking });
  await assert.rejects(runBridge({ config, token: 'test', Bridge: Blocking }), /EEXIST/);
  unblock(); await first;
  class Broken { constructor() { throw new Error('bad configuration'); } }
  await assert.rejects(runBridge({ config, token: 'test', Bridge: Broken }), /bad configuration/);
  assert.equal(existsSync(`${config.journalPath}.lock`), false);
});
