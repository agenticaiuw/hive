// Turns at the VM's screen and phone (devices.mjs): in memory, and over a real Unix socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Devices, Lease, PHONE_IDLE_MS, serveDevices } from './devices.mjs';

const client = task => { const said = []; return { task, said, send: m => said.push(m) }; };
const ops = c => c.said.map(m => m.op);

test('one task at a time per device, first come first served, and a device frees when its task goes', () => {
  const clock = { t: 0 };
  const d = new Devices({ now: () => clock.t });
  const [a, b, c] = [client('A'), client('B'), client('C')];
  d.take('screen', a);
  clock.t = 1000;
  d.take('screen', b);
  d.take('screen', c);
  d.take('phone', b); // another device: no waiting
  assert.deepEqual(ops(a), ['granted']);
  assert.deepEqual(b.said.map(m => [m.op, m.device]), [['queued', 'screen'], ['granted', 'phone']]);
  assert.equal(b.said[0].holder, 'A');
  assert.equal(c.said[0].ahead, 1);
  clock.t = 5000;
  d.drop(a); // A's process ended
  assert.equal(b.said.at(-1).op, 'granted');
  assert.equal(b.said.at(-1).waited_ms, 4000);
  assert.deepEqual(d.state(), { screen: { holder: 'B', waiting: ['C'] }, phone: { holder: 'B', waiting: [] }, mac: { holder: null, waiting: [] } });
  d.drop(b);
  assert.equal(c.said.at(-1).op, 'granted');
  assert.deepEqual(d.state().phone, { holder: null, waiting: [] });
});

test('the screen stays with its task however long it thinks; an idle phone goes to the task waiting for it', () => {
  const clock = { t: 0 };
  const d = new Devices({ now: () => clock.t });
  const [a, b] = [client('screen task'), client('phone task')];
  d.take('screen', a);
  d.take('screen', b);
  clock.t = 10 * PHONE_IDLE_MS;
  d.tick();
  assert.deepEqual(ops(a), ['granted']);

  const [p, q] = [client('Siri task'), client('Duo approval')];
  d.take('phone', p);
  d.mark('phone', p, true); // in a long call: never taken away mid-call
  d.take('phone', q);
  clock.t += 2 * PHONE_IDLE_MS;
  d.tick();
  assert.deepEqual(ops(q), ['queued']);
  d.mark('phone', p, false);
  clock.t += PHONE_IDLE_MS - 1;
  d.tick();
  assert.deepEqual(ops(q), ['queued']);
  clock.t += 1;
  d.tick();
  assert.deepEqual(ops(p), ['granted', 'revoked']);
  assert.deepEqual(ops(q), ['queued', 'granted']);
  // Nobody waiting: an idle holder keeps it.
  clock.t += 10 * PHONE_IDLE_MS;
  d.tick();
  assert.deepEqual(ops(q), ['queued', 'granted']);
});

test('over the socket: a second task waits for the screen until the first one ends, and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-devices-'));
  const path = join(dir, 'devices.sock');
  const served = serveDevices(path, { tickMs: 50 });
  try {
    const waits = [];
    const first = new Lease(path, 'screen', 'R1 task 1');
    const second = new Lease(path, 'screen', 'R2 task 1', { onWait: m => waits.push(m) });
    await first.use(async () => {});
    let secondHas = false;
    const going = second.use(async () => { secondHas = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(secondHas, false);
    assert.equal(waits[0].holder, 'R1 task 1');
    await first.use(async () => {}); // still its turn: no waiting
    first.close(); // its tool server ended
    await going;
    assert.equal(secondHas, true);
    assert.equal(served.devices.state().screen.holder, 'R2 task 1');
    second.close();
  } finally {
    await served.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a task that waits too long gives up in words, and a turn granted after that goes straight back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-devices-'));
  const path = join(dir, 'devices.sock');
  const served = serveDevices(path, { tickMs: 50 });
  try {
    const first = new Lease(path, 'phone', 'long phone task');
    await first.use(async () => {});
    const impatient = new Lease(path, 'phone', 'impatient', { waitMs: 80 });
    await assert.rejects(impatient.use(async () => {}), /another of Hive's tasks has been using the phone/);
    first.close();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(served.devices.state().phone, { holder: null, waiting: [] });
    impatient.close();
  } finally {
    await served.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no orchestrator serving turns, a task started by hand goes ahead', async () => {
  const lease = new Lease('/nonexistent/devices.sock', 'screen', 'by hand');
  assert.equal(await lease.use(async () => 'did it'), 'did it');
});
